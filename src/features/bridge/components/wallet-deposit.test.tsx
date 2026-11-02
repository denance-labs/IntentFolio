// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// 016 §5.3, block 2a, P3. The wallet tab is the only place in the Receive flow that moves money
// from the browser, so these tests pin WHEN it appears and that what it signs is exactly what the
// screen shows. The flag is inlined at build time: set before the modal module loads.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_WALLET_DEPOSIT = "true";
  process.env.NEXT_PUBLIC_VAULT_ROUNDTRIP = "true";
});

const login = vi.hoisted(() => ({
  value: {
    intentsAccountId: "pablofork.near",
    connection: { chainKind: "near", address: "pablofork.near" } as { chainKind: string; address: string } | null,
    liveConnection: { chainKind: "near", address: "pablofork.near" } as { chainKind: string; address: string } | null,
  },
}));
vi.mock("@/features/login-wallet", () => ({ useLoginWallet: vi.fn(() => login.value) }));

const sender = vi.hoisted(() => ({ value: null as null | ((p: unknown) => Promise<unknown>) }));
vi.mock("@/features/vault/context/real-allocate-context", () => ({
  useSendTransactionAs: vi.fn(() => sender.value),
}));

vi.mock("../lib/bridge-client", () => ({ getDepositAddress: vi.fn() }));

vi.mock("../lib/near-wallet-deposit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/near-wallet-deposit")>();
  return { ...actual, readWalletDepositBalance: vi.fn(), readWalletHoldings: vi.fn() };
});

vi.mock("../lib/evm-wallet-holdings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/evm-wallet-holdings")>();
  return { ...actual, readEvmWalletHoldings: vi.fn() };
});

import { ReceiveModal } from "./receive-modal";
import { getDepositAddress } from "../lib/bridge-client";
import {
  DECLINE_RECHECK_ATTEMPTS,
  DECLINE_RECHECK_INTERVAL_MS,
  LATE_DEPOSIT_WATCH_ATTEMPTS,
  LATE_DEPOSIT_WATCH_INTERVAL_MS,
  readWalletDepositBalance,
  readWalletHoldings,
  type WalletDepositBalance,
} from "../lib/near-wallet-deposit";
import { readEvmWalletHoldings } from "../lib/evm-wallet-holdings";
import { resetWalletDepositPhases } from "../hooks/use-wallet-deposit-phase";

const LOGIN = "pablofork.near";
const EVM_LOGIN = "0x7A11Ce0000000000000000000000000000000a53";
const HASH = "8oVqGo7aRkTGfC7KzKgmwzLr1jjsQXp1rNSqYbvkBrQy";
const big = (s: string) => BigInt(s);
const b64 = (json: unknown) => btoa(JSON.stringify(json));

// pablofork.near, measured s181: 0.660413484929335630399995 NEAR spendable, registered, no wNEAR.
const NEAR_BALANCE: WalletDepositBalance = {
  kind: "native",
  available: big("660413484929335630399995"),
  wrapped: big("0"),
  registrationCost: big("0"),
  generalBalance: big("0"),
};

/** A token balance; 1 NEAR free for gas unless said otherwise. */
function ftBalance(available: string, nearFree = "1000000000000000000000000"): WalletDepositBalance {
  return { kind: "ft", available: big(available), nearFree: big(nearFree), generalBalance: big("0") };
}

function creditedOutcome(amount: string) {
  return {
    status: { SuccessValue: b64(amount) },
    transaction: { signer_id: LOGIN, hash: HASH },
    transaction_outcome: { id: HASH },
    receipts_outcome: [],
  };
}

// An outcome with no hash to re-read: `unconfirmed` at once. A wallet THROW no longer is — it is
// re-read off the balances for ~10 s first (D-382).
const UNCONFIRMED_OUTCOME = { status: { SuccessReceiptId: "x" } };

function renderModal(onWalletDepositCredited = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const view = (open: boolean) => (
    <ReceiveModal open={open} lang="en" onClose={vi.fn()} onWalletDepositCredited={onWalletDepositCredited} />
  );
  const { rerender, unmount } = render(view(true), { wrapper });
  return { onWalletDepositCredited, setOpen: (open: boolean) => rerender(view(open)), unmount, client };
}

function row(label: string): HTMLButtonElement {
  for (const li of screen.getAllByRole("listitem")) {
    if (li.querySelector("p")?.textContent === label) return li.querySelector("button") as HTMLButtonElement;
  }
  throw new Error(`no row labelled "${label}"`);
}

/** An asset curated on one network: its row, then Continue on the network step 2 shows
 * preselected (D-488). */
function pickSingleNetwork(label: string) {
  fireEvent.click(row(label));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

const amountField = () => screen.getByLabelText("Amount to deposit") as HTMLInputElement;

beforeEach(() => {
  login.value = {
    intentsAccountId: LOGIN,
    connection: { chainKind: "near", address: LOGIN },
    liveConnection: { chainKind: "near", address: LOGIN },
  };
  sender.value = vi.fn(async () => creditedOutcome("300000000000000000000000"));
  vi.mocked(readWalletDepositBalance).mockResolvedValue(NEAR_BALANCE);
  vi.mocked(readWalletHoldings).mockResolvedValue([]);
  vi.mocked(readEvmWalletHoldings).mockResolvedValue([]);
  vi.mocked(getDepositAddress).mockResolvedValue({ address: "bridge.address.near", chain: "near:mainnet", memo: undefined });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => ({ minDeposit: {}, familyValidation: {} }) }));
});

afterEach(() => {
  // A D-348 test that fails before restoring its fake clock must not hang every test after it.
  vi.useRealTimers();
  cleanup();
  resetWalletDepositPhases();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("when the wallet tab appears", () => {
  it("with the whole gate: NEAR login, a sender, a NEAR-network token — and it is the default tab", async () => {
    renderModal();
    pickSingleNetwork("NEAR");
    expect(screen.getByRole("tab", { name: "From your wallet" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "With an address (QR)" }).getAttribute("aria-selected")).toBe("false");
    await screen.findByText("Available in your wallet: 0.660413 NEAR");
    // The step indicator names the step the user is actually on.
    expect(screen.getByText("Amount")).toBeTruthy();
  });

  it("not with an EVM login", () => {
    login.value = {
      intentsAccountId: "0xabc",
      connection: { chainKind: "evm", address: "0xabc" },
      liveConnection: { chainKind: "evm", address: "0xabc" },
    };
    renderModal();
    pickSingleNetwork("NEAR");
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("not without a sender (RealAllocateDisabled — /mock-dashboard)", () => {
    sender.value = null;
    renderModal();
    pickSingleNetwork("NEAR");
    expect(screen.queryByRole("tab")).toBeNull();
  });

  // A session restored from storage with no NEAR wallet plugged in: the send could only fail.
  it("not when no NEAR wallet is actually connected", () => {
    login.value = { ...login.value, liveConnection: null };
    renderModal();
    pickSingleNetwork("NEAR");
    expect(screen.queryByRole("tab")).toBeNull();
  });

  // Operator s181: a wallet may sign for several accounts. Presence is checked, the address is not.
  it("still offered when the wallet reports a different active account", async () => {
    login.value = { ...login.value, liveConnection: { chainKind: "near", address: "other.near" } };
    renderModal();
    pickSingleNetwork("NEAR");
    expect(screen.getByRole("tab", { name: "From your wallet" })).toBeTruthy();
  });

  it("not without a connection", () => {
    login.value = { intentsAccountId: LOGIN, connection: null, liveConnection: null };
    renderModal();
    pickSingleNetwork("NEAR");
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("not for a token on another network", async () => {
    renderModal();
    fireEvent.click(row("USDC"));
    fireEvent.click(row("Arbitrum"));
    await waitFor(() => expect(screen.getByRole("checkbox")).toBeTruthy());
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("for the same asset on NEAR", async () => {
    vi.mocked(readWalletDepositBalance).mockResolvedValue(ftBalance("2500000"));
    renderModal();
    fireEvent.click(row("USDC"));
    fireEvent.click(row("NEAR"));
    expect(screen.getByRole("tab", { name: "From your wallet" })).toBeTruthy();
    await screen.findByText("Available in your wallet: 2.5 USDC");
  });

  it("not when the modal has nowhere to record the deposit", () => {
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <ReceiveModal open={true} lang="en" onClose={vi.fn()} />
      </QueryClientProvider>
    );
    pickSingleNetwork("NEAR");
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("the QR tab is today's step 3, untouched", async () => {
    renderModal();
    pickSingleNetwork("NEAR");
    fireEvent.click(screen.getByRole("tab", { name: "With an address (QR)" }));
    await waitFor(() => expect(screen.getByRole("checkbox")).toBeTruthy());
    expect(getDepositAddress).toHaveBeenCalledWith(LOGIN, "near:mainnet", undefined);
    expect(screen.getByText("Address")).toBeTruthy();
  });
});

// D-445: step 1 lists what the NEAR wallet holds, above the full list; a row opens the network
// step with NEAR marked (operator, 2026-10-25 — it used to skip straight to the amount).
describe("From your connected wallet, on step 1", () => {
  const USDT_NEAR = "nep141:usdt.tether-token.near";
  const HOLDINGS = [
    { tokenId: "near", available: big("660413484929335630399995"), decimals: 24 },
    { tokenId: USDT_NEAR, available: big("1500000"), decimals: 6 },
  ];
  const section = () => screen.getByRole("region", { name: "From your connected wallet" });

  it("lists the wallet's tokens with their amounts, and the full list below as another wallet", async () => {
    vi.mocked(readWalletHoldings).mockResolvedValue(HOLDINGS);
    renderModal();
    await within(await screen.findByRole("region", { name: "From your connected wallet" })).findByText("0.6604 NEAR");
    expect(within(section()).getByText("1.5 USDT")).toBeTruthy();
    expect(within(section()).getByText(LOGIN)).toBeTruthy();
    expect(screen.getByText("From another wallet")).toBeTruthy();
    expect(screen.queryByText("Select an asset")).toBeNull();
    expect(readWalletHoldings).toHaveBeenCalledWith(LOGIN);
  });

  it("a row opens the network step with NEAR marked first; Continue goes to that token's amount", async () => {
    vi.mocked(readWalletHoldings).mockResolvedValue(HOLDINGS);
    vi.mocked(readWalletDepositBalance).mockResolvedValue(ftBalance("1500000"));
    renderModal();
    const usdt = await within(await screen.findByRole("region", { name: "From your connected wallet" })).findByText("USDT");
    fireEvent.click(usdt.closest("button")!);
    // USDT has eleven networks: the wallet's one leads the list, marked, and nothing is chosen yet.
    expect(screen.getByText("Select a network")).toBeTruthy();
    const networks = screen.getAllByRole("listitem").flatMap((li) => li.querySelector("p")?.textContent ?? []);
    expect(networks[0]).toBe("NEAR");
    expect(row("NEAR").className).toContain("ring-cyan-400/60");
    expect(screen.queryByRole("tab")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("tab", { name: "From your wallet" }).getAttribute("aria-selected")).toBe("true");
    await screen.findByText("Available in your wallet: 1.5 USDT");
    // The amount step re-reads that very token: the row's figure is never what gets signed.
    expect(vi.mocked(readWalletDepositBalance).mock.calls[0][0]).toMatchObject({ tokenId: USDT_NEAR });
    // Confirming the network the row marked is not a choice among several.
    expect(localStorage.getItem("last-used-receive-chain")).toBeNull();
    // Back walks the steps the user saw: the network, then the list.
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Select a network")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("region", { name: "From your connected wallet" })).toBeTruthy();
  });

  it("no section when the wallet holds none of them", async () => {
    renderModal();
    await waitFor(() => expect(readWalletHoldings).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("region", { name: "From your connected wallet" })).toBeNull());
    expect(screen.getByText("Select an asset")).toBeTruthy();
  });

  it("no section when the wallet cannot be read", async () => {
    vi.mocked(readWalletHoldings).mockRejectedValue(new Error("rpc down"));
    renderModal();
    await waitFor(() => expect(readWalletHoldings).toHaveBeenCalled());
    // The hook retries once after React Query's 1 s delay, the same as `waitFor`'s default
    // timeout: under a loaded full run the section was still loading when the wait gave up.
    await waitFor(
      () => expect(screen.queryByRole("region", { name: "From your connected wallet" })).toBeNull(),
      { timeout: 3_000 }
    );
    expect(screen.getByText("Select an asset")).toBeTruthy();
  });

  it("an EVM login reads its own wallet, not the NEAR one", async () => {
    login.value = {
      intentsAccountId: EVM_LOGIN.toLowerCase(),
      connection: { chainKind: "evm", address: EVM_LOGIN },
      liveConnection: { chainKind: "evm", address: EVM_LOGIN },
    };
    renderModal();
    await waitFor(() => expect(readEvmWalletHoldings).toHaveBeenCalledWith(EVM_LOGIN));
    expect(readWalletHoldings).not.toHaveBeenCalled();
  });

  it("nothing is read without a sender (RealAllocateDisabled — /mock-dashboard)", () => {
    sender.value = null;
    renderModal();
    expect(readWalletHoldings).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "From your connected wallet" })).toBeNull();
  });
});

// D-445 part 2A: an EVM login lists what its wallet holds on the EVM chains Receive takes. Display
// only: a row opens the network step with its network marked, and step 3 is the address.
describe("From your connected wallet, EVM login", () => {
  const USDC_BASE = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
  const USDC_ETH = "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near";
  const ETH_ARB = "nep141:arb.omft.near";
  const EVM_HOLDINGS = [
    { tokenId: USDC_BASE, chainId: "eth:8453", available: big("12500000"), decimals: 6 },
    { tokenId: USDC_ETH, chainId: "eth:1", available: big("3000000"), decimals: 6 },
    { tokenId: ETH_ARB, chainId: "eth:42161", available: big("50000000000000000"), decimals: 18 },
  ];
  const section = () => screen.getByRole("region", { name: "From your connected wallet" });

  beforeEach(() => {
    login.value = {
      intentsAccountId: EVM_LOGIN.toLowerCase(),
      connection: { chainKind: "evm", address: EVM_LOGIN },
      liveConnection: { chainKind: "evm", address: EVM_LOGIN },
    };
    vi.mocked(readEvmWalletHoldings).mockResolvedValue(EVM_HOLDINGS);
    vi.mocked(getDepositAddress).mockResolvedValue({
      address: "0x1111111111111111111111111111111111111111",
      chain: "eth:8453",
      memo: undefined,
    });
  });

  it("names each row's network, and the address cut in the middle", async () => {
    renderModal();
    await within(await screen.findByRole("region", { name: "From your connected wallet" })).findByText("12.5 USDC");
    expect(within(section()).getByText("Base")).toBeTruthy();
    expect(within(section()).getByText("Ethereum")).toBeTruthy();
    expect(within(section()).getByText("Arbitrum")).toBeTruthy();
    expect(within(section()).getByText("0x7A11…0a53")).toBeTruthy();
    expect(within(section()).getByTitle(EVM_LOGIN)).toBeTruthy();
  });

  it("a row opens the network step with its network marked first; Continue opens that address", async () => {
    renderModal();
    const base = await within(await screen.findByRole("region", { name: "From your connected wallet" })).findByText("12.5 USDC");
    fireEvent.click(base.closest("button")!);
    const networks = screen.getAllByRole("listitem").flatMap((li) => li.querySelector("p")?.textContent ?? []);
    expect(networks[0]).toBe("Base");
    expect(row("Base").className).toContain("ring-cyan-400/60");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    // No wallet tab for EVM yet (part 2B): the address step as always, for the session's account.
    await waitFor(() => expect(screen.getByRole("checkbox")).toBeTruthy());
    expect(screen.queryByRole("tab")).toBeNull();
    expect(getDepositAddress).toHaveBeenCalledWith(EVM_LOGIN.toLowerCase(), "eth:8453", undefined);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Select a network")).toBeTruthy();
  });

  it("another network picked on the marked step is a real choice: it counts as last used", async () => {
    renderModal();
    const base = await within(await screen.findByRole("region", { name: "From your connected wallet" })).findByText("12.5 USDC");
    fireEvent.click(base.closest("button")!);
    fireEvent.click(row("Arbitrum"));
    expect(localStorage.getItem("last-used-receive-chain")).toBe("eth:42161");
  });

  it("not when the wallet plugged in is another address than the session's", () => {
    login.value = { ...login.value, liveConnection: { chainKind: "evm", address: "0x0000000000000000000000000000000000000001" } };
    renderModal();
    expect(readEvmWalletHoldings).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "From your connected wallet" })).toBeNull();
  });

  it("not without a sender, nor with no wallet plugged in", () => {
    sender.value = null;
    renderModal().unmount();
    sender.value = vi.fn();
    login.value = { ...login.value, liveConnection: null };
    renderModal();
    expect(readEvmWalletHoldings).not.toHaveBeenCalled();
  });
});

describe("with the flag off", () => {
  it("no tabs at all, even with everything else in place", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_WALLET_DEPOSIT", "");
    const { ReceiveModal: FlagOffModal } = await import("./receive-modal");
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <FlagOffModal open={true} lang="en" onClose={vi.fn()} onWalletDepositCredited={vi.fn()} />
      </QueryClientProvider>
    );
    pickSingleNetwork("NEAR");
    expect(screen.queryByRole("tab")).toBeNull();
    vi.unstubAllEnvs();
  });
});

describe("the wallet deposit", () => {
  async function openNear() {
    const result = renderModal();
    pickSingleNetwork("NEAR");
    await screen.findByText("Available in your wallet: 0.660413 NEAR");
    return result;
  }

  // D-417: the field shows 6 decimals; the signature still carries all 24.
  it("Max shows the balance cut to 6 decimals and signs every one of the 24", async () => {
    await openNear();
    fireEvent.click(screen.getByRole("button", { name: "Max" }));
    expect(amountField().value).toBe("0.660413");
    fireEvent.click(screen.getByRole("button", { name: "Deposit 0.660413… NEAR" }));
    expect(JSON.stringify(vi.mocked(sender.value!).mock.calls[0][0])).toContain("660413484929335630399995");
  });

  it("signs exactly what was typed, as the login, and credits it once", async () => {
    const { onWalletDepositCredited } = await openNear();
    fireEvent.change(amountField(), { target: { value: "0,3" } });
    const button = screen.getByRole("button", { name: "Deposit 0.3 NEAR" });
    fireEvent.click(button);
    fireEvent.click(button); // a second click in the same frame must not send again

    await screen.findByText("0.3 NEAR arrived in your funding account.");
    expect(sender.value).toHaveBeenCalledTimes(1);
    expect(sender.value).toHaveBeenCalledWith({
      signerId: LOGIN,
      receiverId: "wrap.near",
      actions: [
        expect.objectContaining({ params: expect.objectContaining({ methodName: "near_deposit", deposit: "300000000000000000000000" }) }),
        expect.objectContaining({
          params: expect.objectContaining({
            methodName: "ft_transfer_call",
            args: { receiver_id: "intents.near", amount: "300000000000000000000000", msg: "" },
          }),
        }),
      ],
    });
    expect(onWalletDepositCredited).toHaveBeenCalledTimes(1);
    expect(onWalletDepositCredited).toHaveBeenCalledWith({ tokenId: "near", amount: big("300000000000000000000000"), txHash: HASH });
  });

  it("refuses more than available: an error and no button", async () => {
    await openNear();
    fireEvent.change(amountField(), { target: { value: "0.7" } });
    expect(screen.getByRole("alert").textContent).toBe("That's more than you have available.");
    expect((screen.getByRole("button", { name: "Deposit 0.7 NEAR" }) as HTMLButtonElement).disabled).toBe(true);
  });

  /** Runs the ~10 s of re-reads after a cancel (D-348) on a fake clock. */
  async function runDeclineRecheck() {
    await act(() => vi.advanceTimersByTimeAsync(DECLINE_RECHECK_ATTEMPTS * DECLINE_RECHECK_INTERVAL_MS));
    vi.useRealTimers();
  }

  it("a rejection in the wallet credits nothing and, once the chain shows nothing left, keeps the form", async () => {
    sender.value = vi.fn(async () => {
      throw new Error("User rejected the request");
    });
    const { onWalletDepositCredited } = await openNear();
    vi.useFakeTimers();
    fireEvent.change(amountField(), { target: { value: "0.3" } });
    fireEvent.click(screen.getByRole("button", { name: "Deposit 0.3 NEAR" }));
    // While the chain is re-read, the panel says so — not "approve in your wallet", not the form.
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText("Confirming…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Deposit/ })).toBeNull();
    await runDeclineRecheck();
    await screen.findByText("You cancelled in your wallet. Nothing moved.");
    expect(onWalletDepositCredited).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Deposit 0.3 NEAR" }) as HTMLButtonElement).disabled).toBe(false);
    // D-377: nothing moved, so nothing to wait for.
    expect(screen.queryByText("Updating balances…")).toBeNull();
  });

  // D-348, measured s191 with Meteor: approved, popup closed at once, "cancelled" — and it landed.
  it("a cancel whose deposit landed is shown and credited as one, with no hash", async () => {
    sender.value = vi.fn(async () => {
      throw new Error("User rejected the request");
    });
    const { onWalletDepositCredited } = await openNear();
    const landed: WalletDepositBalance = {
      ...NEAR_BALANCE,
      available: NEAR_BALANCE.available - big("300000000000000000000000") - big("1000000000000000000000"),
      generalBalance: big("300000000000000000000000"),
    };
    vi.mocked(readWalletDepositBalance).mockResolvedValue(landed);
    vi.useFakeTimers();
    fireEvent.change(amountField(), { target: { value: "0.3" } });
    fireEvent.click(screen.getByRole("button", { name: "Deposit 0.3 NEAR" }));
    await runDeclineRecheck();
    await screen.findByText("0.3 NEAR arrived in your funding account.");
    expect(screen.queryByText("You cancelled in your wallet. Nothing moved.")).toBeNull();
    expect(onWalletDepositCredited).toHaveBeenCalledTimes(1);
    expect(onWalletDepositCredited).toHaveBeenCalledWith({
      tokenId: "near",
      amount: big("300000000000000000000000"),
      txHash: null,
    });
  });

  it("another account in the wallet: names the account to switch to, credits nothing", async () => {
    sender.value = vi.fn(async () => {
      throw new Error('{"InvalidTxError":{"InvalidAccessKeyError":{"AccessKeyNotFound":{"account_id":"pablofork.near","public_key":"ed25519:x"}}}}');
    });
    const { onWalletDepositCredited } = await openNear();
    fireEvent.change(amountField(), { target: { value: "0.3" } });
    fireEvent.click(screen.getByRole("button", { name: "Deposit 0.3 NEAR" }));
    await screen.findByText(
      "Your wallet is using another account. Switch to pablofork.near in your wallet and try again. Nothing moved."
    );
    expect(onWalletDepositCredited).not.toHaveBeenCalled();
  });

  it("unconfirmed: says to check the balance; the only way on is to say you did", async () => {
    sender.value = vi.fn(async () => UNCONFIRMED_OUTCOME);
    const { onWalletDepositCredited } = await openNear();
    fireEvent.change(amountField(), { target: { value: "0.3" } });
    fireEvent.click(screen.getByRole("button", { name: "Deposit 0.3 NEAR" }));
    await screen.findByText(
      "We couldn't confirm the deposit yet. It can take a moment: check your funding account before depositing again."
    );
    expect(screen.queryByRole("button", { name: /^Deposit/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Make another deposit" })).toBeNull();
    expect(onWalletDepositCredited).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "I checked my funding account: make another deposit" }));
    expect(await screen.findByText("Select an asset")).toBeTruthy();
  });

  // Operator s181: after a deposit, closing the modal must not leave the old verdict stuck.
  it("a finished deposit does not stick: closing and reopening gives a fresh form", async () => {
    const { setOpen } = await openNear();
    fireEvent.change(amountField(), { target: { value: "0.3" } });
    fireEvent.click(screen.getByRole("button", { name: "Deposit 0.3 NEAR" }));
    await screen.findByText("0.3 NEAR arrived in your funding account.");
    setOpen(false);
    setOpen(true);
    pickSingleNetwork("NEAR");
    expect(await screen.findByLabelText("Amount to deposit")).toBeTruthy();
    expect(screen.queryByText("0.3 NEAR arrived in your funding account.")).toBeNull();
  });

  it("\"Make another deposit\" goes back to choosing the asset", async () => {
    await openNear();
    fireEvent.change(amountField(), { target: { value: "0.3" } });
    fireEvent.click(screen.getByRole("button", { name: "Deposit 0.3 NEAR" }));
    fireEvent.click(await screen.findByRole("button", { name: "Make another deposit" }));
    expect(screen.getByText("Select an asset")).toBeTruthy();
  });

  // …but one whose wallet popup is still open stays in flight across a close: that is what stops
  // a second send.
  it("closing the modal while the wallet is open keeps the deposit in flight", async () => {
    const send = vi.fn(() => new Promise<unknown>(() => {}));
    sender.value = send;
    const { setOpen } = await openNear();
    fireEvent.change(amountField(), { target: { value: "0.3" } });
    fireEvent.click(screen.getByRole("button", { name: "Deposit 0.3 NEAR" }));
    await screen.findByText("Approve the transaction in your wallet…");
    setOpen(false);
    setOpen(true);
    pickSingleNetwork("NEAR");
    expect(await screen.findByText("Approve the transaction in your wallet…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Deposit/ })).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a refund credits nothing", async () => {
    sender.value = vi.fn(async () => creditedOutcome("0"));
    const { onWalletDepositCredited } = await openNear();
    fireEvent.change(amountField(), { target: { value: "0.3" } });
    fireEvent.click(screen.getByRole("button", { name: "Deposit 0.3 NEAR" }));
    await screen.findByText("The deposit went back to your wallet. Nothing entered your funding account.");
    expect(onWalletDepositCredited).not.toHaveBeenCalled();
  });

  it("fails closed when the balance cannot be read: no field, no button, a way to the QR", async () => {
    vi.mocked(readWalletDepositBalance).mockRejectedValue(new Error("RPC HTTP 401"));
    renderModal();
    pickSingleNetwork("NEAR");
    // The hook retries once (about 1 s) before giving up.
    await screen.findByText("We couldn't read your wallet balance.", {}, { timeout: 4000 });
    expect(screen.queryByLabelText("Amount to deposit")).toBeNull();
    expect(screen.queryByRole("button", { name: "Max" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Deposit with an address (QR)" }));
    expect(screen.getByRole("tab", { name: "With an address (QR)" }).getAttribute("aria-selected")).toBe("true");
  });

  // After a deposit the balance is re-read. If that read fails, react-query keeps the OLD figure
  // — higher than what the wallet now holds. Showing it would offer a Max the wallet cannot pay.
  it("a failed re-read after a deposit hides the stale balance instead of offering it", async () => {
    await openNear();
    vi.mocked(readWalletDepositBalance).mockRejectedValue(new Error("RPC HTTP 503"));
    fireEvent.change(amountField(), { target: { value: "0.3" } });
    fireEvent.click(screen.getByRole("button", { name: "Deposit 0.3 NEAR" }));
    await screen.findByText("0.3 NEAR arrived in your funding account.");
    fireEvent.click(screen.getByRole("button", { name: "Make another deposit" }));
    pickSingleNetwork("NEAR");
    await screen.findByText("We couldn't read your wallet balance.", {}, { timeout: 4000 });
    expect(screen.queryByText("Available in your wallet: 0.660413 NEAR")).toBeNull();
    expect(screen.queryByRole("button", { name: "Max" })).toBeNull();
  });

  // NEAR's "empty" is what storage and the reserve leave, not an empty wallet.
  it("an empty NEAR balance explains the reserve and points to the QR", async () => {
    vi.mocked(readWalletDepositBalance).mockResolvedValue({ ...NEAR_BALANCE, available: big("0") });
    renderModal();
    pickSingleNetwork("NEAR");
    await screen.findByText("You don't have NEAR available to deposit: we leave 0.1 NEAR in your wallet to pay the network.");
    expect(screen.queryByLabelText("Amount to deposit")).toBeNull();
  });

  // D-349: a token deposit pays the network in NEAR; without it the wallet could never send it.
  it("a token with no NEAR for gas says so before, with no field and no deposit button", async () => {
    vi.mocked(readWalletDepositBalance).mockResolvedValue(ftBalance("2500000", "99999999999999999999999"));
    renderModal();
    fireEvent.click(row("USDC"));
    fireEvent.click(row("NEAR"));
    await screen.findByText(
      "To deposit USDC, your wallet needs 0.1 NEAR free to pay the network, and it doesn't have it. Add NEAR to pablofork.near, or deposit with an address (QR)."
    );
    expect(screen.queryByLabelText("Amount to deposit")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Deposit \d/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Deposit with an address (QR)" })).toBeTruthy();
  });

  it("a token with exactly the reserve free keeps the form", async () => {
    vi.mocked(readWalletDepositBalance).mockResolvedValue(ftBalance("2500000", "100000000000000000000000"));
    renderModal();
    fireEvent.click(row("USDC"));
    fireEvent.click(row("NEAR"));
    await screen.findByText("Available in your wallet: 2.5 USDC");
    expect(screen.getByLabelText("Amount to deposit")).toBeTruthy();
  });

  // D-348: the tokens left the wallet but the credit did not show within the window. Not
  // "nothing moved", and no fresh form: the way on is saying you checked your general balance.
  it("a cancel after which the wallet dropped but no credit showed is unconfirmed, with no form", async () => {
    sender.value = vi.fn(async () => {
      throw new Error("User rejected the request");
    });
    const { onWalletDepositCredited } = await openNear();
    vi.mocked(readWalletDepositBalance).mockResolvedValue({
      ...NEAR_BALANCE,
      available: NEAR_BALANCE.available - big("300000000000000000000000") - big("1000000000000000000000"),
    });
    vi.useFakeTimers();
    fireEvent.change(amountField(), { target: { value: "0.3" } });
    fireEvent.click(screen.getByRole("button", { name: "Deposit 0.3 NEAR" }));
    await runDeclineRecheck();
    await screen.findByText(
      "We couldn't confirm the deposit yet. It can take a moment: check your funding account before depositing again."
    );
    expect(screen.queryByRole("button", { name: /^Deposit/ })).toBeNull();
    expect(screen.getByRole("button", { name: "I checked my funding account: make another deposit" })).toBeTruthy();
    expect(onWalletDepositCredited).not.toHaveBeenCalled();
  });

  // D-378 / D-381: the recheck's verdict is not the last word. A deposit that lands minutes later
  // (a wallet broadcasting late, receipts running late) turns it into the credit it is.
  describe("a deposit that lands after the recheck (D-378 / D-381)", () => {
    const landed: WalletDepositBalance = {
      ...NEAR_BALANCE,
      available: NEAR_BALANCE.available - big("300000000000000000000000") - big("1000000000000000000000"),
      generalBalance: big("300000000000000000000000"),
    };

    async function depositThenRecheck(recheckReads: WalletDepositBalance) {
      sender.value = vi.fn(async () => {
        throw new Error("User rejected the request");
      });
      const opened = await openNear();
      vi.mocked(readWalletDepositBalance).mockResolvedValue(recheckReads);
      vi.useFakeTimers();
      fireEvent.change(amountField(), { target: { value: "0.3" } });
      fireEvent.click(screen.getByRole("button", { name: "Deposit 0.3 NEAR" }));
      await act(() => vi.advanceTimersByTimeAsync(DECLINE_RECHECK_ATTEMPTS * DECLINE_RECHECK_INTERVAL_MS));
      return opened;
    }

    it("'you cancelled' turns into the credit, once", async () => {
      const { onWalletDepositCredited } = await depositThenRecheck(NEAR_BALANCE);
      expect(screen.getByText("You cancelled in your wallet. Nothing moved.")).toBeTruthy();
      vi.mocked(readWalletDepositBalance).mockResolvedValue(landed);
      await act(() => vi.advanceTimersByTimeAsync(LATE_DEPOSIT_WATCH_INTERVAL_MS));
      vi.useRealTimers();
      await screen.findByText("0.3 NEAR arrived in your funding account.");
      expect(screen.queryByRole("button", { name: /^Deposit/ })).toBeNull();
      expect(onWalletDepositCredited).toHaveBeenCalledTimes(1);
      expect(onWalletDepositCredited).toHaveBeenCalledWith({ tokenId: "near", amount: big("300000000000000000000000"), txHash: null });
    });

    it("'couldn't confirm yet' turns into the credit when the General Balance catches up", async () => {
      const { onWalletDepositCredited } = await depositThenRecheck({ ...landed, generalBalance: big("0") });
      expect(screen.getByRole("button", { name: "I checked my funding account: make another deposit" })).toBeTruthy();
      vi.mocked(readWalletDepositBalance).mockResolvedValue(landed);
      await act(() => vi.advanceTimersByTimeAsync(3 * LATE_DEPOSIT_WATCH_INTERVAL_MS));
      vi.useRealTimers();
      await screen.findByText("0.3 NEAR arrived in your funding account.");
      expect(onWalletDepositCredited).toHaveBeenCalledTimes(1);
    });

    it("a newer deposit ends the first one's watch: its landing is not credited twice", async () => {
      const { onWalletDepositCredited } = await depositThenRecheck(NEAR_BALANCE);
      // The form is back after "nothing moved": the user deposits again, and that one lands. Its
      // own recheck credits it; the first deposit's watch, which sees the same movement, must not.
      fireEvent.click(screen.getByRole("button", { name: "Deposit 0.3 NEAR" }));
      expect(sender.value).toHaveBeenCalledTimes(2);
      vi.mocked(readWalletDepositBalance).mockResolvedValue(landed);
      await act(() => vi.advanceTimersByTimeAsync(LATE_DEPOSIT_WATCH_ATTEMPTS * LATE_DEPOSIT_WATCH_INTERVAL_MS));
      vi.useRealTimers();
      await screen.findByText("0.3 NEAR arrived in your funding account.");
      expect(onWalletDepositCredited).toHaveBeenCalledTimes(1);
    });
  });

  it("an empty token balance says so", async () => {
    vi.mocked(readWalletDepositBalance).mockResolvedValue(ftBalance("0"));
    renderModal();
    fireEvent.click(row("USDC"));
    fireEvent.click(row("NEAR"));
    await screen.findByText("You don't have USDC in your wallet.");
  });

  // M1 of the s181 review: the in-flight guard used to live in the panel and die with it.
  it("leaving the tab while the wallet is open does not offer a second deposit", async () => {
    const send = vi.fn(() => new Promise<unknown>(() => {}));
    sender.value = send;
    await openNear();
    fireEvent.change(amountField(), { target: { value: "0.3" } });
    fireEvent.click(screen.getByRole("button", { name: "Deposit 0.3 NEAR" }));
    await screen.findByText("Approve the transaction in your wallet…");
    fireEvent.click(screen.getByRole("tab", { name: "With an address (QR)" }));
    fireEvent.click(screen.getByRole("tab", { name: "From your wallet" }));
    expect(screen.getByText("Approve the transaction in your wallet…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Deposit/ })).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });

  // The popup can outlive the modal: an approval that lands after it closed still credits, once.
  it("an approval that arrives after the modal closed still credits, once", async () => {
    let approve!: (o: unknown) => void;
    sender.value = vi.fn(() => new Promise<unknown>((resolve) => { approve = resolve; }));
    const { onWalletDepositCredited, setOpen } = await openNear();
    fireEvent.change(amountField(), { target: { value: "0.3" } });
    fireEvent.click(screen.getByRole("button", { name: "Deposit 0.3 NEAR" }));
    await screen.findByText("Approve the transaction in your wallet…");
    setOpen(false);
    approve(creditedOutcome("300000000000000000000000"));
    await waitFor(() => expect(onWalletDepositCredited).toHaveBeenCalledTimes(1));
    setOpen(true);
    pickSingleNetwork("NEAR");
    expect(await screen.findByLabelText("Amount to deposit")).toBeTruthy();
    expect(onWalletDepositCredited).toHaveBeenCalledTimes(1);
  });

  // M2: after the deposit, a balance re-read that fails must not replace the verdict.
  it("a failed balance read after a deposit keeps the verdict on screen", async () => {
    sender.value = vi.fn(async () => UNCONFIRMED_OUTCOME);
    const { client } = await openNear();
    vi.mocked(readWalletDepositBalance).mockRejectedValue(new Error("RPC HTTP 503"));
    fireEvent.change(amountField(), { target: { value: "0.3" } });
    fireEvent.click(screen.getByRole("button", { name: "Deposit 0.3 NEAR" }));
    await screen.findByText(/We couldn't confirm the deposit yet/);
    await client.refetchQueries();
    // Nothing on screen changes when this works, so wait for the query itself to fail, then give
    // React a turn to render that failure before asserting it did not take over the panel.
    await waitFor(() =>
      expect(client.getQueryCache().findAll({ queryKey: ["wallet-deposit-balance", LOGIN, "near"] })[0]?.state.status).toBe("error")
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.getByText(/We couldn't confirm the deposit yet/)).toBeTruthy();
    expect(screen.queryByText("We couldn't read your wallet balance.")).toBeNull();
  });

  // m1: while the balance is being re-read, the figure on screen may predate the last deposit.
  it("offers no deposit and no Max while the balance is being re-read", async () => {
    const { client } = await openNear();
    let answer!: (b: WalletDepositBalance) => void;
    vi.mocked(readWalletDepositBalance).mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    fireEvent.change(amountField(), { target: { value: "0.3" } });
    void client.refetchQueries();
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Deposit 0.3 NEAR" }) as HTMLButtonElement).disabled).toBe(true)
    );
    expect((screen.getByRole("button", { name: "Max" }) as HTMLButtonElement).disabled).toBe(true);
    answer(NEAR_BALANCE);
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Deposit 0.3 NEAR" }) as HTMLButtonElement).disabled).toBe(false)
    );
  });

  // Past the 120 s wait the panel says "unconfirmed"; the wallet answering later must still credit.
  it("an approval after the 120 s wait turns unconfirmed into credited, once", async () => {
    let approve!: (o: unknown) => void;
    sender.value = vi.fn(() => new Promise<unknown>((resolve) => { approve = resolve; }));
    const { onWalletDepositCredited } = await openNear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fireEvent.change(amountField(), { target: { value: "0.3" } });
      fireEvent.click(screen.getByRole("button", { name: "Deposit 0.3 NEAR" }));
      await vi.advanceTimersByTimeAsync(120_000);
      await screen.findByText(/We couldn't confirm the deposit yet/);
      expect(onWalletDepositCredited).not.toHaveBeenCalled();
      approve(creditedOutcome("300000000000000000000000"));
      await screen.findByText("0.3 NEAR arrived in your funding account.");
      expect(onWalletDepositCredited).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // D-377: the next deposit's cancel is judged against the balance on screen. Until the last
  // scheduled re-read (POST_DEPOSIT_REFRESH_MS) has answered, that figure may predate the first
  // deposit, whose effect would then read as the second one landing. Every exit from a verdict
  // unmounts the panel, so this goes through the real modal: exit, pick the token again, remount.
  it.each([
    ["credited", () => creditedOutcome("300000000000000000000000"), "0.3 NEAR arrived in your funding account.", "Make another deposit"],
    ["partial", () => creditedOutcome("100000000000000000000000"), /The rest went back to your wallet/, "Make another deposit"],
    [
      "unconfirmed",
      () => UNCONFIRMED_OUTCOME,
      /We couldn't confirm the deposit yet/,
      "I checked my funding account: make another deposit",
    ],
  ] as const)("%s: the next deposit waits for the last re-read, across the remount (D-377)", async (_kind, outcome, verdict, exit) => {
    sender.value = vi.fn(async () => outcome());
    const { client } = await openNear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.change(amountField(), { target: { value: "0.3" } });
    fireEvent.click(screen.getByRole("button", { name: "Deposit 0.3 NEAR" }));
    await screen.findByText(verdict);

    fireEvent.click(screen.getByRole("button", { name: exit }));
    pickSingleNetwork("NEAR");
    fireEvent.change(await screen.findByLabelText("Amount to deposit"), { target: { value: "0.3" } });
    // The re-read on mount has answered: what holds the button is the schedule, not a fetch.
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect((screen.getByRole("button", { name: "Deposit 0.3 NEAR" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Max" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Updating balances…")).toBeTruthy();

    // The last scheduled re-read answers: the deposit opens with no action from the user.
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Deposit 0.3 NEAR" }) as HTMLButtonElement).disabled).toBe(false)
    );
    expect((screen.getByRole("button", { name: "Max" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText("Updating balances…")).toBeNull();
  });

  // D-377: the wait is per account — another token spends the same NEAR on gas.
  it("after a NEAR credit, a deposit of another token also waits for the last re-read (D-377)", async () => {
    vi.mocked(readWalletDepositBalance).mockImplementation(async (target) =>
      target.tokenId === "near" ? NEAR_BALANCE : ftBalance("2500000")
    );
    const { client } = await openNear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.change(amountField(), { target: { value: "0.3" } });
    fireEvent.click(screen.getByRole("button", { name: "Deposit 0.3 NEAR" }));
    await screen.findByText("0.3 NEAR arrived in your funding account.");

    fireEvent.click(screen.getByRole("button", { name: "Make another deposit" }));
    fireEvent.click(row("USDC"));
    fireEvent.click(row("NEAR"));
    await screen.findByText("Available in your wallet: 2.5 USDC");
    fireEvent.change(amountField(), { target: { value: "1" } });
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect((screen.getByRole("button", { name: "Deposit 1 USDC" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Updating balances…")).toBeTruthy();

    await act(() => vi.advanceTimersByTimeAsync(10_000));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Deposit 1 USDC" }) as HTMLButtonElement).disabled).toBe(false)
    );
    expect(screen.queryByText("Updating balances…")).toBeNull();
  });

  // D-377: "Done" and reopening the modal is as quick a way to a second deposit.
  it("after \"Done\" and reopening the modal, the next deposit still waits for the last re-read (D-377)", async () => {
    const { client, setOpen } = await openNear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.change(amountField(), { target: { value: "0.3" } });
    fireEvent.click(screen.getByRole("button", { name: "Deposit 0.3 NEAR" }));
    await screen.findByText("0.3 NEAR arrived in your funding account.");

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    setOpen(false);
    setOpen(true);
    pickSingleNetwork("NEAR");
    fireEvent.change(await screen.findByLabelText("Amount to deposit"), { target: { value: "0.3" } });
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect((screen.getByRole("button", { name: "Deposit 0.3 NEAR" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Updating balances…")).toBeTruthy();

    await act(() => vi.advanceTimersByTimeAsync(10_000));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Deposit 0.3 NEAR" }) as HTMLButtonElement).disabled).toBe(false)
    );
    expect(screen.queryByText("Updating balances…")).toBeNull();
  });

  // D-377: a cancelled deposit is judged by the balances read before it. If an earlier deposit's
  // late verdict lands meanwhile, that one's movement must not read as this one credited.
  describe("a later deposit while an earlier verdict lands", () => {
    const HASH_2 = "4pDzXqzT3xkUvFzN6tTn1uQ8xvTnGJxk1oTEZ6qFv9yW";
    const LANDED: WalletDepositBalance = {
      ...NEAR_BALANCE,
      available: NEAR_BALANCE.available - big("300000000000000000000000") - big("1000000000000000000000"),
      generalBalance: big("300000000000000000000000"),
    };

    /**
     * Deposit 1 runs out the 120 s wait (`unconfirmed`), the user acks, the gate opens, and deposit
     * 2 is sent with `secondSend`. Until deposit 1 is approved, the chain shows nothing moved.
     */
    async function secondDepositAfterUnconfirmed(secondSend: () => Promise<unknown>) {
      let approveFirst!: (o: unknown) => void;
      let landed = false;
      vi.mocked(readWalletDepositBalance).mockImplementation(async () => (landed ? LANDED : NEAR_BALANCE));
      sender.value = vi
        .fn()
        .mockImplementationOnce(() => new Promise<unknown>((resolve) => { approveFirst = resolve; }))
        .mockImplementationOnce(secondSend);
      const { onWalletDepositCredited } = await openNear();
      vi.useFakeTimers({ shouldAdvanceTime: true });
      fireEvent.change(amountField(), { target: { value: "0.3" } });
      fireEvent.click(screen.getByRole("button", { name: "Deposit 0.3 NEAR" }));
      await act(() => vi.advanceTimersByTimeAsync(120_000));
      await screen.findByText(/We couldn't confirm the deposit yet/);
      fireEvent.click(screen.getByRole("button", { name: "I checked my funding account: make another deposit" }));
      pickSingleNetwork("NEAR");
      fireEvent.change(await screen.findByLabelText("Amount to deposit"), { target: { value: "0.3" } });
      await act(() => vi.advanceTimersByTimeAsync(10_000));
      await waitFor(() =>
        expect((screen.getByRole("button", { name: "Deposit 0.3 NEAR" }) as HTMLButtonElement).disabled).toBe(false)
      );
      fireEvent.click(screen.getByRole("button", { name: "Deposit 0.3 NEAR" }));
      await act(() => vi.advanceTimersByTimeAsync(0));
      const landFirst = () => {
        landed = true;
        approveFirst(creditedOutcome("300000000000000000000000"));
      };
      return { onWalletDepositCredited, landFirst, approveFirst };
    }

    // D-376: deposit 1's late verdict is deposit 1's. It must not replace deposit 2's phase — a
    // `failed` would bring the form back with deposit 2's popup still open.
    it.each([
      [
        "failed",
        () => ({ ...creditedOutcome("300000000000000000000000"), status: { Failure: { InvalidTxError: { InvalidNonce: { tx_nonce: 1, ak_nonce: 2 } } } } }),
        0,
      ],
      ["credited", () => creditedOutcome("300000000000000000000000"), 1],
    ] as const)("a late %s of deposit 1 leaves deposit 2 waiting, and deposit 2's own verdict lands (D-376)", async (_kind, firstOutcome, firstCredits) => {
      let approveSecond!: (o: unknown) => void;
      const { onWalletDepositCredited, approveFirst } = await secondDepositAfterUnconfirmed(
        () => new Promise<unknown>((resolve) => { approveSecond = resolve; })
      );
      await screen.findByText("Approve the transaction in your wallet…");
      approveFirst(firstOutcome());
      await act(() => vi.advanceTimersByTimeAsync(0));
      // A late credit is still real money: it is credited, only not shown as deposit 2's verdict.
      await waitFor(() => expect(onWalletDepositCredited).toHaveBeenCalledTimes(firstCredits));
      expect(screen.getByText("Approve the transaction in your wallet…")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /^Deposit/ })).toBeNull();

      // Control: deposit 2's own verdict still replaces its phase.
      approveSecond({ ...creditedOutcome("300000000000000000000000"), transaction: { signer_id: LOGIN, hash: HASH_2 }, transaction_outcome: { id: HASH_2 } });
      await screen.findByText("0.3 NEAR arrived in your funding account.");
      expect(onWalletDepositCredited).toHaveBeenCalledTimes(firstCredits + 1);
      expect(onWalletDepositCredited).toHaveBeenLastCalledWith(expect.objectContaining({ txHash: HASH_2 }));
    });

    it("a cancel credited off the balances is downgraded to unconfirmed (D-377)", async () => {
      const { onWalletDepositCredited, landFirst } = await secondDepositAfterUnconfirmed(async () => {
        throw new Error("User rejected the request");
      });
      // Deposit 1's late verdict lands while deposit 2's cancel is being re-read.
      landFirst();
      await waitFor(() => expect(onWalletDepositCredited).toHaveBeenCalledTimes(1));
      await act(() => vi.advanceTimersByTimeAsync(DECLINE_RECHECK_ATTEMPTS * DECLINE_RECHECK_INTERVAL_MS));
      await screen.findByText(/We couldn't confirm the deposit yet/);
      // The only credit is deposit 1's, with its hash; deposit 2 credits nothing.
      expect(onWalletDepositCredited).toHaveBeenCalledTimes(1);
      expect(onWalletDepositCredited).toHaveBeenCalledWith(expect.objectContaining({ txHash: HASH }));
    });

    it("a credit with its hash is never downgraded (D-377)", async () => {
      let approveSecond!: (o: unknown) => void;
      const { onWalletDepositCredited, landFirst } = await secondDepositAfterUnconfirmed(
        () => new Promise<unknown>((resolve) => { approveSecond = resolve; })
      );
      landFirst();
      await waitFor(() => expect(onWalletDepositCredited).toHaveBeenCalledTimes(1));
      approveSecond({ ...creditedOutcome("300000000000000000000000"), transaction: { signer_id: LOGIN, hash: HASH_2 }, transaction_outcome: { id: HASH_2 } });
      await waitFor(() => expect(onWalletDepositCredited).toHaveBeenCalledTimes(2));
      expect(onWalletDepositCredited).toHaveBeenLastCalledWith(expect.objectContaining({ txHash: HASH_2 }));
      expect(screen.getByText("0.3 NEAR arrived in your funding account.")).toBeTruthy();
    });

    it("with no other verdict in between, a cancel credited off the balances stays credited (D-377)", async () => {
      const { onWalletDepositCredited } = await secondDepositAfterUnconfirmed(async () => {
        throw new Error("User rejected the request");
      });
      // Deposit 2 itself landed; deposit 1 never answers.
      vi.mocked(readWalletDepositBalance).mockResolvedValue(LANDED);
      await act(() => vi.advanceTimersByTimeAsync(DECLINE_RECHECK_ATTEMPTS * DECLINE_RECHECK_INTERVAL_MS));
      await screen.findByText("0.3 NEAR arrived in your funding account.");
      expect(onWalletDepositCredited).toHaveBeenCalledTimes(1);
      expect(onWalletDepositCredited).toHaveBeenCalledWith(expect.objectContaining({ txHash: null }));
    });
  });

  it("with no verdict before, the deposit is offered at once (D-377)", async () => {
    await openNear();
    fireEvent.change(amountField(), { target: { value: "0.3" } });
    expect((screen.getByRole("button", { name: "Deposit 0.3 NEAR" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText("Updating balances…")).toBeNull();
  });

  it("an amount with more decimals than shown is marked as cut in the button", async () => {
    await openNear();
    fireEvent.change(amountField(), { target: { value: "0.3000009" } });
    expect(screen.getByRole("button", { name: "Deposit 0.3… NEAR" })).toBeTruthy();
  });

  it("reads the balance of the login's account for the chosen token", async () => {
    await openNear();
    expect(readWalletDepositBalance).toHaveBeenCalledWith(
      expect.objectContaining({ tokenId: "near", contractId: "wrap.near" }),
      LOGIN
    );
  });
});
