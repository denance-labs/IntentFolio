// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { decodeFunctionData, erc20Abi, UserRejectedRequestError, type Hex } from "viem";
import type { ReactNode } from "react";

// D-445 part 2B: depositing from the connected EVM wallet. These pin WHEN the tab appears for an
// EVM login and that what the wallet is asked to send is exactly what the screen shows.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_WALLET_DEPOSIT = "true";
  process.env.NEXT_PUBLIC_VAULT_ROUNDTRIP = "true";
});

const EVM_LOGIN = "0x7A11Ce0000000000000000000000000000000a53";
const DEPOSIT = "0x1111111111111111111111111111111111111111";
const HASH = "0xabc0000000000000000000000000000000000000000000000000000000000001" as Hex;

const login = vi.hoisted(() => ({
  value: {} as {
    intentsAccountId: string;
    connection: { chainKind: string; address: string } | null;
    liveConnection: { chainKind: string; address: string } | null;
    sendEvmTransaction: ((tx: unknown) => Promise<Hex>) | null;
  },
}));
vi.mock("@/features/login-wallet", () => ({ useLoginWallet: vi.fn(() => login.value) }));

const sender = vi.hoisted(() => ({ value: null as null | ((p: unknown) => Promise<unknown>) }));
vi.mock("@/features/vault/context/real-allocate-context", () => ({
  useSendTransactionAs: vi.fn(() => sender.value),
}));

vi.mock("../lib/bridge-client", () => ({ getDepositAddress: vi.fn(), getDepositStatus: vi.fn() }));

vi.mock("../lib/near-wallet-deposit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/near-wallet-deposit")>();
  return { ...actual, readWalletDepositBalance: vi.fn(), readWalletHoldings: vi.fn(async () => []) };
});

vi.mock("../lib/evm-wallet-holdings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/evm-wallet-holdings")>();
  return { ...actual, readEvmWalletHoldings: vi.fn() };
});

// The chain's part of the run is injected; everything else is the real module.
const chain = vi.hoisted(() => ({
  receipt: null as null | ((chainId: string, hash: Hex) => Promise<unknown>),
}));
vi.mock("../lib/evm-wallet-deposit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/evm-wallet-deposit")>();
  return {
    ...actual,
    readEvmDepositBalance: vi.fn(),
    estimateNativeDepositFee: vi.fn(),
    runEvmWalletDeposit: vi.fn((input: Parameters<typeof actual.runEvmWalletDeposit>[0]) =>
      actual.runEvmWalletDeposit({
        ...input,
        waitForReceipt: input.waitForReceipt ?? (chain.receipt as never),
        sleep: async () => {},
      })
    ),
  };
});

import { ReceiveModal } from "./receive-modal";
import { getDepositAddress, getDepositStatus } from "../lib/bridge-client";
import { readEvmWalletHoldings } from "../lib/evm-wallet-holdings";
import { estimateNativeDepositFee, readEvmDepositBalance } from "../lib/evm-wallet-deposit";
import { resetWalletDepositPhases } from "../hooks/use-wallet-deposit-phase";

const big = (v: string) => BigInt(v);
const USDC_BASE = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const ETH_ARB = "nep141:arb.omft.near";

function completed(txHash: string = HASH) {
  return {
    deposits: [
      {
        tx_hash: txHash,
        chain: "eth:8453",
        defuse_asset_identifier: "eth:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        near_token_id: "base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
        decimals: 6,
        amount: 5000000,
        account_id: EVM_LOGIN.toLowerCase(),
        address: DEPOSIT,
        status: "COMPLETED" as const,
      },
    ],
    total: 1,
    limit: 50,
    offset: 0,
  };
}

let minDeposit: Record<string, Record<string, string>>;

function renderModal(onConfirmDraft?: (credit: unknown) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(
    <ReceiveModal
      open={true}
      lang="en"
      onClose={vi.fn()}
      onWalletDepositCredited={vi.fn()}
      draftContext={onConfirmDraft ? { name: "Mix", tokenIds: [] } : undefined}
      onConfirmDraft={onConfirmDraft}
    />,
    { wrapper }
  );
}

/** From the section: the row, then Continue on the network it marked. */
async function openFromRow(ticker: string, network: string) {
  const section = await screen.findByRole("region", { name: "From your connected wallet" });
  // The section shows "Reading your wallet…" before its rows: wait for the row itself.
  const rowButton = await waitFor(() => {
    const found = within(section)
      .getAllByRole("button")
      .find((b) => b.textContent?.includes(ticker) && b.textContent?.includes(network));
    if (!found) throw new Error(`no ${ticker} · ${network} row yet`);
    return found;
  });
  fireEvent.click(rowButton);
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

const amountField = () => screen.getByLabelText("Amount to deposit") as HTMLInputElement;

beforeEach(() => {
  login.value = {
    intentsAccountId: EVM_LOGIN.toLowerCase(),
    connection: { chainKind: "evm", address: EVM_LOGIN },
    liveConnection: { chainKind: "evm", address: EVM_LOGIN },
    sendEvmTransaction: vi.fn(async () => HASH),
  };
  sender.value = vi.fn();
  minDeposit = { USDC: { "eth:8453": "1" }, ETH: { "eth:42161": "0.0001" } };
  vi.mocked(readEvmWalletHoldings).mockResolvedValue([
    { tokenId: USDC_BASE, chainId: "eth:8453", available: big("12500000"), decimals: 6 },
    { tokenId: ETH_ARB, chainId: "eth:42161", available: big("50000000000000000"), decimals: 18 },
  ]);
  vi.mocked(readEvmDepositBalance).mockImplementation(async (token) =>
    token.erc20
      ? { available: big("12500000"), native: big("1000000000000000") }
      : { available: big("50000000000000000"), native: big("50000000000000000") }
  );
  vi.mocked(estimateNativeDepositFee).mockResolvedValue({ fee: big("122000000000000"), gasLimit: null });
  vi.mocked(getDepositAddress).mockResolvedValue({ address: DEPOSIT, chain: "eth:8453" });
  vi.mocked(getDepositStatus).mockResolvedValue(completed());
  chain.receipt = async (_chainId, hash) => ({ kind: "success", txHash: hash });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async () => ({ json: async () => ({ minDeposit, familyValidation: {} }) }))
  );
});

afterEach(() => {
  cleanup();
  resetWalletDepositPhases();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("depositing USDC from Base", () => {
  it("sends exactly transfer(depositAddress, amount) on Base, then says it arrived", async () => {
    renderModal();
    await openFromRow("USDC", "Base");
    expect(screen.getByRole("tab", { name: "From your wallet" }).getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByText("From your Base wallet")).toBeTruthy();
    expect(screen.getByTitle(EVM_LOGIN).textContent).toBe("0x7A11…0a53");
    await screen.findByText("Available in your wallet: 12.5 USDC");
    fireEvent.change(amountField(), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Deposit 5 USDC" }));

    await screen.findByText("5 USDC arrived in your funding account.");
    const send = vi.mocked(login.value.sendEvmTransaction!);
    expect(send).toHaveBeenCalledTimes(1);
    const tx = send.mock.calls[0][0] as { chainId: number; to: string; value: bigint; data: Hex };
    expect(tx.chainId).toBe(8453);
    expect(tx.to).toBe("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
    expect(tx.value).toBe(big("0"));
    expect(decodeFunctionData({ abi: erc20Abi, data: tx.data }).args).toEqual([DEPOSIT, big("5000000")]);
    // The deposit address is the session account's, on the token's chain: the QR tab's.
    expect(getDepositAddress).toHaveBeenCalledWith(EVM_LOGIN.toLowerCase(), "eth:8453");
    expect(getDepositStatus).toHaveBeenCalledWith(EVM_LOGIN.toLowerCase());
  });

  it("under the bridge's minimum: says so, and no deposit", async () => {
    minDeposit = { USDC: { "eth:8453": "10" } };
    renderModal();
    await openFromRow("USDC", "Base");
    await screen.findByText("Available in your wallet: 12.5 USDC");
    fireEvent.change(amountField(), { target: { value: "5" } });
    expect(screen.getByRole("alert").textContent).toBe("The minimum deposit is 10 USDC.");
    expect((screen.getByRole("button", { name: "Deposit 5 USDC" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("without the minimum, no form: the QR tab instead", async () => {
    minDeposit = {};
    renderModal();
    await openFromRow("USDC", "Base");
    expect(await screen.findByText(/couldn't read the minimum deposit/)).toBeTruthy();
    expect(screen.queryByLabelText("Amount to deposit")).toBeNull();
    expect(screen.getByRole("button", { name: "Deposit with an address (QR)" })).toBeTruthy();
  });

  it("no ETH on Base for the gas: says so, and no form", async () => {
    vi.mocked(readEvmDepositBalance).mockResolvedValue({ available: big("12500000"), native: big("0") });
    renderModal();
    await openFromRow("USDC", "Base");
    expect(await screen.findByText(/needs ETH on Base to pay the network/)).toBeTruthy();
    expect(screen.queryByLabelText("Amount to deposit")).toBeNull();
  });

  it("a decline keeps the form: nothing moved", async () => {
    login.value.sendEvmTransaction = vi.fn(async () => {
      throw new UserRejectedRequestError(new Error("User rejected the request."));
    });
    renderModal();
    await openFromRow("USDC", "Base");
    await screen.findByText("Available in your wallet: 12.5 USDC");
    fireEvent.change(amountField(), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Deposit 5 USDC" }));
    await screen.findByText("You cancelled in your wallet. Nothing moved.");
    expect(amountField()).toBeTruthy();
  });

  it("an error that may have sent it is unconfirmed: no form until the user says they checked", async () => {
    login.value.sendEvmTransaction = vi.fn(async () => {
      throw new Error("Request timed out");
    });
    renderModal();
    await openFromRow("USDC", "Base");
    await screen.findByText("Available in your wallet: 12.5 USDC");
    fireEvent.change(amountField(), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Deposit 5 USDC" }));
    await screen.findByText(/couldn't confirm the deposit yet/);
    expect(screen.queryByLabelText("Amount to deposit")).toBeNull();
    expect(screen.getByRole("button", { name: "I checked my funding account: make another deposit" })).toBeTruthy();
    expect(getDepositStatus).not.toHaveBeenCalled();
  });

  it("a second click while the wallet is open sends nothing more", async () => {
    let answer: (hash: Hex) => void = () => {};
    login.value.sendEvmTransaction = vi.fn(() => new Promise<Hex>((resolve) => (answer = resolve)));
    renderModal();
    await openFromRow("USDC", "Base");
    await screen.findByText("Available in your wallet: 12.5 USDC");
    fireEvent.change(amountField(), { target: { value: "5" } });
    const button = screen.getByRole("button", { name: "Deposit 5 USDC" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(login.value.sendEvmTransaction).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/If it asks to switch to Base, accept/)).toBeTruthy();
    answer(HASH);
    await screen.findByText("5 USDC arrived in your funding account.");
  });

  it("a deposit for the draft offers to assign the funds, with what was credited", async () => {
    const onConfirmDraft = vi.fn();
    renderModal(onConfirmDraft);
    await openFromRow("USDC", "Base");
    await screen.findByText("Available in your wallet: 12.5 USDC");
    fireEvent.change(amountField(), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Deposit 5 USDC" }));
    fireEvent.click(await screen.findByRole("button", { name: "Assign funds to this portfolio" }));
    expect(onConfirmDraft).toHaveBeenCalledWith({ tokenId: USDC_BASE, amount: big("5000000"), txHash: HASH });
  });
});

describe("depositing ETH from Arbitrum", () => {
  it("Max leaves the gas behind, and the value sent is that exact figure", async () => {
    vi.mocked(getDepositAddress).mockResolvedValue({ address: DEPOSIT, chain: "eth:42161" });
    renderModal();
    await openFromRow("ETH", "Arbitrum");
    // 0.05 − 0.000122 = 0.049878
    await screen.findByText("Available in your wallet: 0.049878 ETH");
    expect(screen.getByText(/We leave about 0.000122 ETH in your wallet to pay the network/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Max" }));
    fireEvent.click(screen.getByRole("button", { name: "Deposit 0.049878 ETH" }));
    await waitFor(() => expect(login.value.sendEvmTransaction).toHaveBeenCalled());
    expect(vi.mocked(login.value.sendEvmTransaction!).mock.calls[0][0]).toEqual({
      chainId: 42161,
      to: DEPOSIT,
      value: big("49878000000000000"),
    });
  });

  it("a gas limit the fee names goes to the wallet with the deposit (Ethereum's case)", async () => {
    vi.mocked(getDepositAddress).mockResolvedValue({ address: DEPOSIT, chain: "eth:42161" });
    vi.mocked(estimateNativeDepositFee).mockResolvedValue({ fee: big("122000000000000"), gasLimit: big("22000") });
    renderModal();
    await openFromRow("ETH", "Arbitrum");
    await screen.findByText("Available in your wallet: 0.049878 ETH");
    fireEvent.click(screen.getByRole("button", { name: "Max" }));
    fireEvent.click(screen.getByRole("button", { name: "Deposit 0.049878 ETH" }));
    await waitFor(() => expect(login.value.sendEvmTransaction).toHaveBeenCalled());
    expect(vi.mocked(login.value.sendEvmTransaction!).mock.calls[0][0]).toMatchObject({ gas: big("22000") });
  });
});

describe("when the EVM wallet tab appears", () => {
  it("not when the wallet cannot send", async () => {
    login.value.sendEvmTransaction = null;
    renderModal();
    await openFromRow("USDC", "Base");
    await waitFor(() => expect(screen.getByRole("checkbox")).toBeTruthy());
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("not outside a real context (RealAllocateDisabled — /mock-dashboard)", async () => {
    sender.value = null;
    renderModal();
    fireEvent.click(screen.getAllByRole("button").find((b) => b.textContent?.startsWith("USDC"))!);
    fireEvent.click(screen.getAllByRole("button").find((b) => b.textContent === "Base")!);
    await waitFor(() => expect(screen.getByRole("checkbox")).toBeTruthy());
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("not for a token on a chain this path does not serve (USDC on NEAR, with an EVM login)", async () => {
    renderModal();
    await screen.findByRole("region", { name: "From your connected wallet" });
    const list = screen.getAllByRole("button").filter((b) => b.textContent?.startsWith("USDC"));
    fireEvent.click(list[list.length - 1]);
    fireEvent.click(screen.getAllByRole("button").find((b) => b.textContent === "NEAR")!);
    await waitFor(() => expect(screen.getByRole("checkbox")).toBeTruthy());
    expect(screen.queryByRole("tab")).toBeNull();
  });
});

describe("the connected wallet's list", () => {
  it("a balance below the list's precision reads as such, not as 0", async () => {
    vi.mocked(readEvmWalletHoldings).mockResolvedValue([
      { tokenId: ETH_ARB, chainId: "eth:42161", available: big("51255690768000"), decimals: 18 },
    ]);
    renderModal();
    const section = await screen.findByRole("region", { name: "From your connected wallet" });
    expect(await within(section).findByText("< 0.0001 ETH")).toBeTruthy();
  });
});
