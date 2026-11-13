// @vitest-environment jsdom
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WithdrawalModal } from "./withdrawal-modal";

vi.mock("@/features/dashboard-shell/hooks/use-available-general-balance", () => ({
  useAvailableGeneralBalance: vi.fn(() => new Map<string, number>()),
}));

// No session by default, so «Use my wallet» stays out of every test that predates it; the
// suite that covers the button sets a connection explicitly.
vi.mock("@/features/login-wallet", () => ({
  useLoginWallet: vi.fn(() => ({ connection: null })),
}));

vi.mock("@/features/market/hooks/use-token-prices", () => ({
  useTokenPrices: vi.fn(() => ({ prices: {} })),
}));

// The bridge is mocked at the feature module, not at the HTTP client: what step 4 has to get
// right is which quote it shows and when it blocks, not how the RPC is shaped (that is
// withdrawal-fee.test.ts).
vi.mock("../lib/withdrawal-fee", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/withdrawal-fee")>();
  return { ...actual, fetchWithdrawalFee: vi.fn(actual.fetchWithdrawalFee) };
});

// Call-through by default, so the TON purchase tests keep exercising the real flat constant
// (which touches no network). Only the EVM margin test overrides it — on Polygon the
// requirement comes from a live `eth_gasPrice`, and a unit test must not depend on one.
vi.mock("../lib/hot-fee", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/hot-fee")>();
  return { ...actual, fetchHotGasRequirement: vi.fn(actual.fetchHotGasRequirement) };
});

// The `near-native` destination pre-flight moved OUT of the confirm click and into step 3's
// Continue, so it is now this component's concern. Mocked at the module for the same reason
// as the fee: what matters here is when it runs and what it blocks, not the RPC shape.
vi.mock("../lib/withdraw-submit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/withdraw-submit")>();
  return {
    ...actual,
    assertNearDestinationUsable: vi.fn(async () => {}),
    nearDestinationIsContract: vi.fn(async () => false),
  };
});

// Block 4.2: the same treatment for Solana's, added for `omft` withdrawals landing there.
vi.mock("../lib/solana-destination", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/solana-destination")>();
  return {
    ...actual,
    assertSolanaDestinationUsable: vi.fn(async () => ({ warning: null })),
  };
});

// D-316: the wallet that signs the registration, and the registration itself. Null sender by
// default — the same as a tree without `RealAllocateProvider` — so no older test offers it.
vi.mock("@/features/vault/context/real-allocate-context", () => ({
  useSendTransactionAs: vi.fn(() => null),
}));
vi.mock("../lib/near-storage-registration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/near-storage-registration")>();
  return {
    ...actual,
    readRegistrationCost: vi.fn(async () => BigInt("1250000000000000000000")),
    registerNearDestination: vi.fn(async () => ({ kind: "registered" })),
  };
});

import { useAvailableGeneralBalance } from "@/features/dashboard-shell/hooks/use-available-general-balance";
import { useSendTransactionAs } from "@/features/vault/context/real-allocate-context";
import {
  readRegistrationCost,
  registerNearDestination,
} from "../lib/near-storage-registration";
import { AmountExceedsBalanceError } from "@/features/vault/lib/base-units";
import { HeldReadFailedError, HeldReadTimeoutError } from "../lib/run-real-withdraw";
import { useTokenPrices } from "@/features/market/hooks/use-token-prices";
import { useLoginWallet } from "@/features/login-wallet";
import { fetchWithdrawalFee } from "../lib/withdrawal-fee";
import { fetchHotGasRequirement } from "../lib/hot-fee";
import { assertNearDestinationUsable, nearDestinationIsContract } from "../lib/withdraw-submit";
import { WithdrawDestinationUnusableError, WithdrawError } from "../lib/withdraw-errors";
import {
  assertSolanaDestinationUsable,
  SolanaDestinationUnusableError,
} from "../lib/solana-destination";
import type { GasPurchaseQuote, GasQuoteRequest } from "../lib/gas-purchase";
import { tokenRegistry } from "@/features/market/lib/token-registry";
import { bridgeTranslations } from "../lib/translations";
import { isTokenAvailable } from "../lib/token-availability";

const mockFee = fetchWithdrawalFee as ReturnType<typeof vi.fn>;
const mockGasReq = fetchHotGasRequirement as ReturnType<typeof vi.fn>;

/**
 * The shape `fetchWithdrawalFee` answers with since D-274: the quote, plus the gas requirement
 * it was computed against. The requirement defaults to `null` because that is what every test
 * here that predates D-274 is really saying — "this screen has a quote, or it does not" — and
 * a default of `null` makes the gas offer unavailable, so no test can accidentally start
 * depending on a requirement it never stated. The purchase tests pass one explicitly.
 */
function feeResult(quote: unknown, hotRequirement: unknown = null) {
  return { quote, hotRequirement };
}
const mockPreflight = assertNearDestinationUsable as ReturnType<typeof vi.fn>;
const mockIsContract = nearDestinationIsContract as ReturnType<typeof vi.fn>;
const mockSolPreflight = assertSolanaDestinationUsable as ReturnType<typeof vi.fn>;

const mockBalance = useAvailableGeneralBalance as ReturnType<typeof vi.fn>;
const mockPrices = useTokenPrices as ReturnType<typeof vi.fn>;

// `isAvailable: () => true` appears in the gas-purchase suites below and nowhere else. Those
// tests drive the D-257 machinery, which exists for the 10 non-native `hot-omni` rows the
// day-1 allowlist defers (008.plan §Alcance) — deferred, not deleted, so the code still has
// to be covered. The override says "assume this row is in scope"; what the shipped picker
// actually offers is fixed by `token-availability.test.ts`, which uses no override at all.
function renderModal(props: Partial<React.ComponentProps<typeof WithdrawalModal>> = {}) {
  return render(
    <WithdrawalModal open={true} lang="en" onClose={vi.fn()} {...props} />,
  );
}

/** Step 1 → step 3 for a symbol held on one network: its row, then Continue on the network
 * step 2 shows preselected (D-488). */
function pickSingleNetworkToken(label: string) {
  fireEvent.click(screen.getAllByRole("button").find((b) => b.textContent?.includes(label))!);
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

describe("WithdrawalModal", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("does not render when closed", () => {
    mockBalance.mockReturnValue(new Map());
    mockPrices.mockReturnValue({ prices: {} });
    renderModal({ open: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows empty state when no withdrawable balance", () => {
    // No tokens in balance
    mockBalance.mockReturnValue(new Map());
    mockPrices.mockReturnValue({ prices: {} });
    renderModal();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("No withdrawable balance")).toBeTruthy();
    expect(screen.getByText("Deposit to your account first.")).toBeTruthy();
  });

  it("shows empty state when balance exists but no token is withdrawable", () => {
    // LINEAR is wallet-visible but not routable (`depositable: false`), so it has no
    // withdrawalRegistry row. It replaced "near" here when D-176 made NEAR withdrawable.
    mockBalance.mockReturnValue(new Map([["nep141:linear-protocol.near", 5]]));
    mockPrices.mockReturnValue({ prices: {} });
    renderModal();
    expect(screen.getByText("No withdrawable balance")).toBeTruthy();
  });

  // No `isAvailable` override here on purpose: this is the shipped allowlist deciding.
  // A deferred row can only reach this picker on a balance acquired outside IntentFolio,
  // so it is listed with its amount — hiding it would make the money disappear from the
  // screen — but it must not be clickable, because step 3 leads to a signature.
  it("lists a held-but-deferred token as Not available yet and refuses to open it", () => {
    const USDT_TON = "nep245:v2_1.omni.hot.tg:1117_3tsdfyziyc7EJbP2aULWSKU4toBaAcN4FdTgfm5W1mC4ouR";
    mockBalance.mockReturnValue(new Map([[USDT_TON, 5]]));
    mockPrices.mockReturnValue({ prices: { [USDT_TON]: { usdPrice: 1 } } });
    renderModal();

    const row = screen.getAllByRole("button").find((b) => b.textContent?.includes("USDT"))!;
    expect(row.textContent).toContain("Not available yet");
    expect((row as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(row);
    // Still on step 1: no destination field, so nothing can be signed.
    expect(screen.queryByLabelText("Destination address")).toBeNull();
  });

  // The other half of the same rule: a live row on a chain that also carries a deferred one
  // stays fully usable. This is what fails if the allowlist is ever collapsed into a chain
  // list — TON would lose GRAM along with its USDT. GRAM is also out of the curated catalog
  // (D-396): Receive and "Add to portfolio" stop offering it, the withdrawal must not.
  it("leaves a live native on the same chain selectable", () => {
    const GRAM = "nep245:v2_1.omni.hot.tg:1117_";
    mockBalance.mockReturnValue(new Map([[GRAM, 2]]));
    mockPrices.mockReturnValue({ prices: { [GRAM]: { usdPrice: 1.34 } } });
    renderModal();

    const row = screen.getAllByRole("button").find((b) => b.textContent?.includes("GRAM"))!;
    expect(row.textContent).not.toContain("Not available yet");
    expect((row as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(row);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByLabelText("Destination address")).toBeTruthy();
  });

  it("shows withdrawable token rows", () => {
    // USDC on NEAR (near-native route) is in the registry
    const tokenId = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
    mockBalance.mockReturnValue(new Map([[tokenId, 100]]));
    mockPrices.mockReturnValue({ prices: { [tokenId]: { usdPrice: 1 } } });
    renderModal();
    expect(screen.queryByText("No withdrawable balance")).toBeNull();
    // Token row is visible (NEAR-native USDC has symbol "USDC(NEAR)")
    expect(screen.getByRole("list")).toBeTruthy();
    expect(screen.getAllByRole("listitem").length).toBeGreaterThan(0);
  });

  it("shows step 2 with the only network preselected, and Continue goes on to step 3 (D-488)", () => {
    const tokenId = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
    mockBalance.mockReturnValue(new Map([[tokenId, 50]]));
    mockPrices.mockReturnValue({ prices: {} });
    renderModal();
    const buttons = screen.getAllByRole("button");
    const tokenButton = buttons.find((b) => b.textContent?.includes("USDC"));
    expect(tokenButton).toBeTruthy();
    fireEvent.click(tokenButton!);
    // Step 2 is shown even with a single network: the user sees it before the form
    expect(screen.getByRole("heading", { name: "Select destination network" })).toBeTruthy();
    expect(screen.queryByLabelText("Destination address")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByLabelText("Destination address")).toBeTruthy();
    expect(screen.getByLabelText("Amount")).toBeTruthy();
  });

  it("back from step 3 returns to step 2 for a single network, and back again to the token list (D-488)", () => {
    const tokenId = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
    mockBalance.mockReturnValue(new Map([[tokenId, 50]]));
    mockPrices.mockReturnValue({ prices: {} });
    renderModal();
    pickSingleNetworkToken("USDC");
    expect(screen.getByLabelText("Destination address")).toBeTruthy();
    // Back → step 2, the preselected network still there to confirm
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { name: "Select destination network" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
    expect(screen.queryByLabelText("Destination address")).toBeNull();
    // Back again → step 1 token list
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Select an asset to withdraw")).toBeTruthy();
  });

  it("step 3 Continue button is disabled until address and amount are valid", () => {
    const tokenId = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
    mockBalance.mockReturnValue(new Map([[tokenId, 50]]));
    mockPrices.mockReturnValue({ prices: {} });
    renderModal();
    pickSingleNetworkToken("USDC");
    const continueBtn = screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
    expect(continueBtn.disabled).toBe(true);

    // Enter a valid NEAR address
    fireEvent.change(screen.getByLabelText("Destination address"), {
      target: { value: "alice.near" },
    });
    expect(continueBtn.disabled).toBe(true); // still no amount

    // Enter a valid amount
    fireEvent.change(screen.getByLabelText("Amount"), {
      target: { value: "10" },
    });
    expect(continueBtn.disabled).toBe(false);
  });

  it("step 3 shows error for invalid address", () => {
    const tokenId = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
    mockBalance.mockReturnValue(new Map([[tokenId, 50]]));
    mockPrices.mockReturnValue({ prices: {} });
    renderModal();
    pickSingleNetworkToken("USDC");
    fireEvent.change(screen.getByLabelText("Destination address"), {
      target: { value: "not-valid" },
    });
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("Invalid address format")).toBeTruthy();
  });

  it("step 3 shows wrong-chain warning and back-to-start link for EVM address on NEAR chain", () => {
    const tokenId = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
    mockBalance.mockReturnValue(new Map([[tokenId, 50]]));
    mockPrices.mockReturnValue({ prices: {} });
    renderModal();
    pickSingleNetworkToken("USDC");
    // Enter an EVM address on NEAR chain
    fireEvent.change(screen.getByLabelText("Destination address"), {
      target: { value: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" },
    });
    expect(screen.getByText(/This looks like a EVM address/)).toBeTruthy();
    const backLink = screen.getByRole("button", { name: "Back to start" });
    fireEvent.click(backLink);
    // Should return to step 1
    expect(screen.getByRole("list")).toBeTruthy();
  });

  describe("«Use my wallet» (016 1.2)", () => {
    const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
    const USDC_ETH = "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near";

    // `clearAllMocks` keeps return values, so put the no-session default back for the rest.
    afterEach(() => {
      vi.mocked(useLoginWallet).mockReturnValue({ connection: null } as never);
    });

    function openStep3(tokenId: string, chainKind: string, address: string) {
      vi.mocked(useLoginWallet).mockReturnValue({ connection: { chainKind, address } } as never);
      mockBalance.mockReturnValue(new Map([[tokenId, 50]]));
      mockPrices.mockReturnValue({ prices: {} });
      renderModal();
      pickSingleNetworkToken("USDC");
    }

    it("fills the login account into the destination on a chain of its family", () => {
      openStep3(USDC_NEAR, "near", "alice.near");
      fireEvent.click(screen.getByRole("button", { name: "Use my wallet" }));
      expect((screen.getByLabelText("Destination address") as HTMLInputElement).value).toBe(
        "alice.near",
      );
      // Only a prefill: Continue still waits for the amount, as it would for a typed address.
      const continueBtn = screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
      expect(continueBtn.disabled).toBe(true);
      fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "10" } });
      expect(continueBtn.disabled).toBe(false);
    });

    it("offers an EVM login on an EVM chain", () => {
      const evm = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
      openStep3(USDC_ETH, "evm", evm);
      fireEvent.click(screen.getByRole("button", { name: "Use my wallet" }));
      expect((screen.getByLabelText("Destination address") as HTMLInputElement).value).toBe(evm);
    });

    it("is absent when the chain belongs to another family", () => {
      openStep3(USDC_NEAR, "evm", "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
      expect(screen.getByLabelText("Destination address")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Use my wallet" })).toBeNull();
    });
  });

  it("step 3 MAX button fills the available balance into the amount field", () => {
    const tokenId = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
    mockBalance.mockReturnValue(new Map([[tokenId, 42.5]]));
    mockPrices.mockReturnValue({ prices: {} });
    renderModal();
    pickSingleNetworkToken("USDC");
    fireEvent.click(screen.getByRole("button", { name: "MAX" }));
    const amountInput = screen.getByLabelText("Amount") as HTMLInputElement;
    expect(amountInput.value).toBe("42.5");
  });

  // D-315, the real case from the s163 smoke: stNEAR `161137493560894135434618`. MAX used to
  // round to 12 significant digits, which here rounds UP (0.161137493561) — the modal then
  // refused its own MAX as over the balance and Continue stayed disabled.
  it("step 3 MAX on a 24-decimal balance carries the whole balance through to the money path", () => {
    const tokenId = "nep141:meta-pool.near";
    const balance = 0.16113749356089413; // fromBaseUnits(161137493560894135434618n, 24)
    const onConfirmed = vi.fn();
    mockBalance.mockReturnValue(new Map([[tokenId, balance]]));
    mockPrices.mockReturnValue({ prices: {} });
    renderModal({ onConfirmed });
    pickSingleNetworkToken("stNEAR");
    fireEvent.change(screen.getByLabelText("Destination address"), {
      target: { value: "alice.near" },
    });
    fireEvent.click(screen.getByRole("button", { name: "MAX" }));

    expect(screen.queryByText("Exceeds available balance")).toBeNull();
    const continueBtn = screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
    expect(continueBtn.disabled).toBe(false);
    fireEvent.click(continueBtn);
    fireEvent.click(screen.getByRole("button", { name: "Confirm withdrawal" }));
    // Exactly the balance, so the envelope's `capToHeld` can settle it on the raw figure.
    expect(onConfirmed).toHaveBeenCalledWith(expect.objectContaining({ tokenId, qty: balance }));
  });

  it("step 3 shows error when amount exceeds balance", () => {
    const tokenId = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
    mockBalance.mockReturnValue(new Map([[tokenId, 10]]));
    mockPrices.mockReturnValue({ prices: {} });
    renderModal();
    pickSingleNetworkToken("USDC");
    fireEvent.change(screen.getByLabelText("Amount"), {
      target: { value: "9999" },
    });
    expect(screen.getByText("Exceeds available balance")).toBeTruthy();
  });

  it("step 3 Continue advances to step 4 with cost breakdown", () => {
    const tokenId = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
    mockBalance.mockReturnValue(new Map([[tokenId, 50]]));
    mockPrices.mockReturnValue({ prices: {} });
    renderModal();
    pickSingleNetworkToken("USDC");
    fireEvent.change(screen.getByLabelText("Destination address"), {
      target: { value: "alice.near" },
    });
    fireEvent.change(screen.getByLabelText("Amount"), {
      target: { value: "5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getAllByText("Confirm withdrawal").length).toBeGreaterThan(0);
    expect(screen.getByText("Withdrawal details")).toBeTruthy();
    expect(screen.getByText("Costs")).toBeTruthy();
    expect(screen.getByText(/irreversible/i)).toBeTruthy();
  });

  it("step 4 Confirm button calls onConfirmed with correct args", () => {
    const tokenId = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
    const onConfirmed = vi.fn();
    mockBalance.mockReturnValue(new Map([[tokenId, 50]]));
    mockPrices.mockReturnValue({ prices: {} });
    renderModal({ onConfirmed });
    pickSingleNetworkToken("USDC");
    fireEvent.change(screen.getByLabelText("Destination address"), {
      target: { value: "alice.near" },
    });
    fireEvent.change(screen.getByLabelText("Amount"), {
      target: { value: "5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm withdrawal" }));
    expect(onConfirmed).toHaveBeenCalledOnce();
    // `memo` is `undefined` for a chain that does not route on a tag — NOT "", which the
    // envelope would treat as a memo the caller meant to send.
    // `destinationVerified` is false on the mock path: no pre-flight ran, so the money path
    // must not be told one did.
    expect(onConfirmed).toHaveBeenCalledWith({
      tokenId,
      qty: 5,
      chainId: "near:mainnet",
      address: "alice.near",
      memo: undefined,
      destinationVerified: false,
    });
  });

  it("back button from step 4 returns to step 3 with state preserved", () => {
    const tokenId = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
    mockBalance.mockReturnValue(new Map([[tokenId, 50]]));
    mockPrices.mockReturnValue({ prices: {} });
    renderModal();
    pickSingleNetworkToken("USDC");
    fireEvent.change(screen.getByLabelText("Destination address"), {
      target: { value: "alice.near" },
    });
    fireEvent.change(screen.getByLabelText("Amount"), {
      target: { value: "7" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getAllByText("Confirm withdrawal").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    // Back to step 3 — address input still visible
    expect(screen.getByLabelText("Destination address")).toBeTruthy();
    expect((screen.getByLabelText("Amount") as HTMLInputElement).value).toBe("7");
  });

  // ── D-153 option B: symbol aggregation + network picker ──────────────────
  const USDT_ETH = "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near";
  const USDT_TRON = "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near";

  it("aggregates a symbol held on multiple networks into one step-1 row, then shows the network picker", () => {
    mockBalance.mockReturnValue(new Map([[USDT_ETH, 200], [USDT_TRON, 100]]));
    mockPrices.mockReturnValue({
      prices: { [USDT_ETH]: { usdPrice: 1 }, [USDT_TRON]: { usdPrice: 1 } },
    });
    renderModal();
    // Step 1: a single aggregated USDT row (not one row per network)
    expect(screen.getAllByRole("listitem").length).toBe(1);
    const usdtButton = screen.getAllByRole("button").find((b) => b.textContent?.includes("USDT"));
    expect(usdtButton).toBeTruthy();
    fireEvent.click(usdtButton!);
    // Step 2: chain picker appears (it is skipped for single-network symbols).
    // The label shows both in the modal header and the list heading.
    expect(screen.getAllByText("Select destination network").length).toBeGreaterThan(0);
    expect(screen.getByText("Ethereum")).toBeTruthy();
    expect(screen.getByText("Tron")).toBeTruthy();
    // Step 3 form is not reached yet
    expect(screen.queryByLabelText("Destination address")).toBeNull();
  });

  it("shows the network picker with the only network preselected when the symbol exists on one network (D-488)", () => {
    // Only the Ethereum USDT variant → group has a single variant → step 2 still shown
    mockBalance.mockReturnValue(new Map([[USDT_ETH, 75]]));
    mockPrices.mockReturnValue({ prices: { [USDT_ETH]: { usdPrice: 1 } } });
    renderModal();
    fireEvent.click(screen.getAllByRole("button").find((b) => b.textContent?.includes("USDT"))!);
    expect(screen.getByRole("heading", { name: "Select destination network" })).toBeTruthy();
    expect(screen.getByText("Ethereum")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByLabelText("Destination address")).toBeTruthy();
  });

  it("debits the variant for the network chosen in step 2 (MAX = that network's balance)", () => {
    const onConfirmed = vi.fn();
    mockBalance.mockReturnValue(new Map([[USDT_ETH, 200], [USDT_TRON, 100]]));
    mockPrices.mockReturnValue({
      prices: { [USDT_ETH]: { usdPrice: 1 }, [USDT_TRON]: { usdPrice: 1 } },
    });
    renderModal({ onConfirmed });
    fireEvent.click(screen.getAllByRole("button").find((b) => b.textContent?.includes("USDT"))!);
    // Pick Ethereum (200 USDT), not Tron (100 USDT)
    fireEvent.click(screen.getAllByRole("button").find((b) => b.textContent?.includes("Ethereum"))!);
    // MAX fills the Ethereum variant balance, proving the right tokenId was resolved
    fireEvent.click(screen.getByRole("button", { name: "MAX" }));
    expect((screen.getByLabelText("Amount") as HTMLInputElement).value).toBe("200");
    fireEvent.change(screen.getByLabelText("Destination address"), {
      target: { value: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" },
    });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm withdrawal" }));
    expect(onConfirmed).toHaveBeenCalledWith({
      tokenId: USDT_ETH,
      qty: 50,
      chainId: "eth:1",
      address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      memo: undefined,
      destinationVerified: false,
    });
  });

  it("back from step 3 returns to the network picker when it was shown", () => {
    mockBalance.mockReturnValue(new Map([[USDT_ETH, 200], [USDT_TRON, 100]]));
    mockPrices.mockReturnValue({
      prices: { [USDT_ETH]: { usdPrice: 1 }, [USDT_TRON]: { usdPrice: 1 } },
    });
    renderModal();
    fireEvent.click(screen.getAllByRole("button").find((b) => b.textContent?.includes("USDT"))!);
    fireEvent.click(screen.getAllByRole("button").find((b) => b.textContent?.includes("Ethereum"))!);
    expect(screen.getByLabelText("Destination address")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    // Back to step 2 (network picker), not step 1
    expect(screen.getAllByText("Select destination network").length).toBeGreaterThan(0);
    expect(screen.queryByLabelText("Destination address")).toBeNull();
  });

  it("calls onClose when ESC is pressed", () => {
    const onClose = vi.fn();
    mockBalance.mockReturnValue(new Map());
    mockPrices.mockReturnValue({ prices: {} });
    renderModal({ onClose });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when the × button is clicked", () => {
    const onClose = vi.fn();
    mockBalance.mockReturnValue(new Map());
    mockPrices.mockReturnValue({ prices: {} });
    renderModal({ onClose });
    const closeBtn = screen.getByRole("button", { name: "Close" });
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledOnce();
  });
});

// ── Block 5.4: the fee shown on step 4 ─────────────────────────────────────────
// USDT on Arbitrum — the `omft` route the wet test runs. 6 decimals, registry fee 5300
// base units (0.0053 USDT).
const USDT_ARB = "nep141:arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near";
const ARB_ADDRESS = "0x195d287fB6E1fbBaaC18cB6C7DB0050388Ed8B00";

async function reachStep4(props: Partial<React.ComponentProps<typeof WithdrawalModal>> = {}) {
  mockBalance.mockReturnValue(new Map([[USDT_ARB, 10]]));
  mockPrices.mockReturnValue({ prices: { [USDT_ARB]: { usdPrice: 1 } } });
  renderModal(props);
  pickSingleNetworkToken("USDT");
  fireEvent.change(screen.getByLabelText("Destination address"), {
    target: { value: ARB_ADDRESS },
  });
  fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  // Let the mount-time quote settle before anything is asserted.
  await act(async () => {});
}

describe("WithdrawalModal — step 4 fee (block 5.4)", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    localStorage.clear();
  });

  // The flag-off guarantee, at the level where it is easiest to break by accident: with no
  // live route the screen must not reach the network at all.
  it("does not ask the bridge for a fee when the token has no live route", async () => {
    await reachStep4({ isRealRoute: () => false });
    expect(mockFee).not.toHaveBeenCalled();
    expect(screen.getByText("0.0053 USDT")).toBeTruthy();
  });

  it("shows the live fee instead of the registry snapshot when the route is live", async () => {
    mockFee.mockResolvedValue(feeResult({ feeRaw: "12000", source: "live" }));
    await reachStep4({ isRealRoute: () => true });
    expect(mockFee).toHaveBeenCalled();
    expect(screen.getByText("0.012 USDT")).toBeTruthy();
  });

  it("keeps the registry snapshot when the live quote cannot be had", async () => {
    mockFee.mockResolvedValue(feeResult({ feeRaw: "5300", source: "registry" }));
    await reachStep4({ isRealRoute: () => true });
    expect(screen.getByText("0.0053 USDT")).toBeTruthy();
    // Labelled as an estimate, since that is what a snapshot is.
    expect(screen.getByText(/Estimated/)).toBeTruthy();
  });

  // P2, the operator's decision: a fee that went UP between the quote and the click blocks
  // the withdrawal and asks again, rather than quietly delivering less than promised.
  it("blocks the confirm and asks again when the fee went up", async () => {
    const onConfirmed = vi.fn();
    mockFee.mockResolvedValueOnce(feeResult({ feeRaw: "5300", source: "live" }));
    await reachStep4({ isRealRoute: () => true, onConfirmed });

    mockFee.mockResolvedValueOnce(feeResult({ feeRaw: "9000", source: "live" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm withdrawal" }));
    });

    expect(onConfirmed).not.toHaveBeenCalled();
    expect(screen.getByText(/network fee went up/)).toBeTruthy();
    expect(screen.getByText("0.009 USDT")).toBeTruthy();

    // The second click is the re-confirmation, against the number now on screen.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Review and confirm" }));
    });
    expect(onConfirmed).toHaveBeenCalledOnce();
  });

  // The double-signature hole. The confirm click awaits a fee re-check before anything
  // disables the button, so a user who clicks again because "nothing happened" used to get a
  // SECOND envelope, with its own nonce and its own wallet prompt — two real withdrawals.
  it("signs once when the confirm button is clicked twice during the fee re-check", async () => {
    const onConfirmed = vi.fn();
    mockFee.mockResolvedValueOnce(feeResult({ feeRaw: "5300", source: "live" }));
    await reachStep4({ isRealRoute: () => true, onConfirmed });

    // A re-check held open, so BOTH clicks get to suspend inside the window before either
    // resumes. Releasing it afterwards lets both handlers run to completion — which is what
    // makes this a real test: without the guard, both reach `onConfirmed`.
    let release: (r: { quote: { feeRaw: string; source: string } }) => void = () => {};
    mockFee.mockReturnValue(
      new Promise<{ quote: { feeRaw: string; source: string } }>((r) => {
        release = r;
      })
    );
    const button = screen.getByRole("button", { name: "Confirm withdrawal" });
    fireEvent.click(button);
    fireEvent.click(button);

    // The button also has to SAY it is busy — an inert-looking button is what invites the
    // second click in the first place.
    const busy = screen.getByRole("button", { name: "Checking current fee…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      release({ quote: { feeRaw: "5300", source: "live" } });
    });
    expect(onConfirmed).toHaveBeenCalledOnce();
  });

  // The fee is deducted on the far side, so an amount under it settles perfectly and delivers
  // nothing at all. The screen used to render "you will receive 0" with the button still live.
  it("refuses to confirm an amount the fee would swallow whole", async () => {
    const onConfirmed = vi.fn();
    mockFee.mockResolvedValue(feeResult({ feeRaw: "5300", source: "live" }));
    mockBalance.mockReturnValue(new Map([[USDT_ARB, 10]]));
    mockPrices.mockReturnValue({ prices: { [USDT_ARB]: { usdPrice: 1 } } });
    renderModal({ isRealRoute: () => true, onConfirmed });
    pickSingleNetworkToken("USDT");
    fireEvent.change(screen.getByLabelText("Destination address"), {
      target: { value: ARB_ADDRESS },
    });
    // 0.001 USDT against a 0.0053 fee: above the bridge's own 1-base-unit minimum, below what
    // it costs to send. The step-3 floor already accounts for the fee, so this cannot even
    // reach step 4 — which is the point.
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "0.001" } });
    await act(async () => {});

    expect(screen.getByText(/Minimum withdrawal/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(
      true
    );
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  // A cheaper withdrawal needs no permission: the user receives more than the screen said.
  it("does not block when the fee went down", async () => {
    const onConfirmed = vi.fn();
    mockFee.mockResolvedValueOnce(feeResult({ feeRaw: "5300", source: "live" }));
    await reachStep4({ isRealRoute: () => true, onConfirmed });

    mockFee.mockResolvedValueOnce(feeResult({ feeRaw: "2000", source: "live" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm withdrawal" }));
    });

    expect(onConfirmed).toHaveBeenCalledOnce();
    expect(screen.queryByText(/network fee went up/)).toBeNull();
  });

  // A withdrawal must never be blocked because a fee endpoint was slow — the envelope signs
  // the gross amount, so the quote is a display concern (FEE_RECHECK_BUDGET_MS).
  it("submits anyway when the re-check does not answer in time", async () => {
    vi.useFakeTimers();
    try {
      const onConfirmed = vi.fn();
      mockFee.mockResolvedValueOnce(feeResult({ feeRaw: "5300", source: "live" }));
      mockBalance.mockReturnValue(new Map([[USDT_ARB, 10]]));
      mockPrices.mockReturnValue({ prices: { [USDT_ARB]: { usdPrice: 1 } } });
      renderModal({ isRealRoute: () => true, onConfirmed });
      pickSingleNetworkToken("USDT");
      fireEvent.change(screen.getByLabelText("Destination address"), {
        target: { value: ARB_ADDRESS },
      });
      fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1" } });
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      await act(async () => {});

      // A quote that never resolves.
      mockFee.mockReturnValueOnce(new Promise(() => {}));
      fireEvent.click(screen.getByRole("button", { name: "Confirm withdrawal" }));
      await act(async () => {
        vi.advanceTimersByTime(2_000);
      });

      expect(onConfirmed).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  // Only an `untouched` outcome reaches this copy, so it is allowed to say the balance is
  // unchanged — and the modal must stay open with the inputs intact so a retry is one click.
  it("keeps the modal open and explains when the withdrawal never went out", async () => {
    const onConfirmed = vi.fn().mockRejectedValue(new Error("User rejected the request"));
    await reachStep4({ isRealRoute: () => false, onConfirmed });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm withdrawal" }));
    });

    expect(screen.getByText("The withdrawal was not sent. Your balance is unchanged.")).toBeTruthy();
    // A wallet refusal is named in the app's words, not the wallet library's (020-3 QA).
    expect(screen.getByText("You cancelled the signature in your wallet.")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
    // D-309: the focus is back on the button for the retry, not on <body>.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Confirm withdrawal" }));
  });
});

// The `near-native` destination pre-flight is two NEAR view calls. It used to run inside the
// confirm click, between the click and the wallet popup — and a browser only opens that popup
// inside the user-activation window the click created (~5s in Blink). On a slow endpoint the
// two calls alone exceed it and the prompt never appears, which is exactly how a signing flow
// broke once before. So the check keeps its teeth and moves to step 3, where it can take as
// long as it needs and gives a better error besides.
describe("WithdrawalModal — near-native destination pre-flight", () => {
  const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    localStorage.clear();
  });

  async function fillStep3(props: Partial<React.ComponentProps<typeof WithdrawalModal>> = {}) {
    mockBalance.mockReturnValue(new Map([[USDC_NEAR, 50]]));
    mockPrices.mockReturnValue({ prices: { [USDC_NEAR]: { usdPrice: 1 } } });
    renderModal(props);
    pickSingleNetworkToken("USDC");
    fireEvent.change(screen.getByLabelText("Destination address"), {
      target: { value: "alice.near" },
    });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "5" } });
  }

  it("runs on Continue and reports the result to the money path", async () => {
    const onConfirmed = vi.fn();
    mockPreflight.mockResolvedValue(undefined);
    await fillStep3({ isRealRoute: () => true, onConfirmed });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    });
    expect(mockPreflight).toHaveBeenCalledOnce();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm withdrawal" }));
    });
    // `destinationVerified: true` is what lets `submitWithdraw` skip the two view calls in the
    // click that has to reach the wallet.
    expect(onConfirmed).toHaveBeenCalledWith(
      expect.objectContaining({ destinationVerified: true }),
    );
  });

  it("stays on step 3 and explains when the destination cannot receive", async () => {
    const onConfirmed = vi.fn();
    mockPreflight.mockRejectedValue(
      new WithdrawDestinationUnusableError("not-registered", "alice.near", "usdc.near"),
    );
    await fillStep3({ isRealRoute: () => true, onConfirmed });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    });

    expect(screen.getByText(/cannot receive this token yet/)).toBeTruthy();
    // Still on step 3, with the user's inputs intact — nothing was signed.
    expect(screen.getByLabelText("Destination address")).toBeTruthy();
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  // Flag off: the screen must behave exactly as it always has, network calls included.
  it("does not run at all when the token is not on the live path", async () => {
    const onConfirmed = vi.fn();
    await fillStep3({ isRealRoute: () => false, onConfirmed });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    });

    expect(mockPreflight).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm withdrawal" }));
    });
    // False, not true: the money path must run the check itself when nobody else did.
    expect(onConfirmed).toHaveBeenCalledWith(
      expect.objectContaining({ destinationVerified: false }),
    );
  });
});

// D-386 (d): a contract destination (a DEX, say) takes a plain `ft_transfer` and may never give
// it back — but some wallets are contracts (a multisig), so it warns and lets the user go on.
describe("WithdrawalModal — a contract as the NEAR destination (D-386 d)", () => {
  const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    localStorage.clear();
  });

  async function continueTo(address: string) {
    const onConfirmed = vi.fn();
    mockPreflight.mockResolvedValue(undefined);
    mockBalance.mockReturnValue(new Map([[USDC_NEAR, 50]]));
    mockPrices.mockReturnValue({ prices: { [USDC_NEAR]: { usdPrice: 1 } } });
    renderModal({ isRealRoute: () => true, onConfirmed });
    pickSingleNetworkToken("USDC");
    fireEvent.change(screen.getByLabelText("Destination address"), { target: { value: address } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "5" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    });
    return onConfirmed;
  }

  it("warns on a contract, stays on step 3, and lets a second click go on", async () => {
    mockIsContract.mockResolvedValue(true);
    const onConfirmed = await continueTo("v2.ref-finance.near");

    expect(mockIsContract).toHaveBeenCalledWith("v2.ref-finance.near");
    expect(screen.getByRole("alert").textContent).toBe(
      "v2.ref-finance.near is a contract account. If it isn't a wallet of yours, the funds may not be recoverable.",
    );
    expect(screen.getByLabelText("Destination address")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue anyway" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm withdrawal" }));
    });
    expect(onConfirmed).toHaveBeenCalledWith(expect.objectContaining({ destinationVerified: true }));
  });

  it("has its Spanish copy", () => {
    expect(bridgeTranslations.es.destinationContract).toBe(
      "{address} es una cuenta de contrato. Si no es una wallet tuya, los fondos podrían no recuperarse.",
    );
  });

  it("says nothing about a plain account and goes straight on", async () => {
    mockIsContract.mockResolvedValue(false);
    await continueTo("alice.near");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Confirm withdrawal" })).toBeTruthy();
  });
});

// D-372: the modal's pre-flight asked `near-unwrap` for a wrap.near storage balance that native
// NEAR does not need, refusing accounts the money path's own check accepts.
describe("WithdrawalModal — which pre-flight asks for a storage registration (D-372)", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    localStorage.clear();
  });

  it.each([
    { tokenId: "near", label: "NEAR", requireStorageRegistration: false },
    {
      tokenId: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      label: "USDC",
      requireStorageRegistration: true,
    },
  ])("$label: requireStorageRegistration = $requireStorageRegistration", async ({ tokenId, label, requireStorageRegistration }) => {
    mockPreflight.mockResolvedValue(undefined);
    mockBalance.mockReturnValue(new Map([[tokenId, 50]]));
    mockPrices.mockReturnValue({ prices: { [tokenId]: { usdPrice: 1 } } });
    renderModal({ isRealRoute: () => true });
    pickSingleNetworkToken(label);
    fireEvent.change(screen.getByLabelText("Destination address"), { target: { value: "alice.near" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "5" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    });
    expect(mockPreflight).toHaveBeenCalledWith(
      expect.objectContaining({ requireStorageRegistration }),
    );
  });
});

// D-316: an unregistered destination used to be a dead end. The login's own NEAR account can
// now be registered from the modal; any other destination gets the way to do it outside.
describe("WithdrawalModal — registering the destination (D-316)", () => {
  const STNEAR = "nep141:meta-pool.near";
  const ME = "pablofork.near";
  const mockSend = vi.fn(async () => ({}));
  const mockCost = readRegistrationCost as ReturnType<typeof vi.fn>;
  const mockRegister = registerNearDestination as ReturnType<typeof vi.fn>;

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    localStorage.clear();
    vi.mocked(useLoginWallet).mockReturnValue({ connection: null } as never);
    vi.mocked(useSendTransactionAs).mockReturnValue(null);
    mockCost.mockResolvedValue(BigInt("1250000000000000000000"));
    mockRegister.mockResolvedValue({ kind: "registered" });
  });

  async function refusedOnStep3(
    login: { chainKind: string; address: string },
    destination: string,
    props: Partial<React.ComponentProps<typeof WithdrawalModal>> = {},
  ) {
    vi.mocked(useLoginWallet).mockReturnValue({ connection: login } as never);
    vi.mocked(useSendTransactionAs).mockReturnValue(mockSend);
    mockPreflight.mockRejectedValueOnce(
      new WithdrawDestinationUnusableError("not-registered", destination, "meta-pool.near"),
    );
    mockBalance.mockReturnValue(new Map([[STNEAR, 3]]));
    mockPrices.mockReturnValue({ prices: { [STNEAR]: { usdPrice: 4 } } });
    renderModal({ isRealRoute: () => true, ...props });
    pickSingleNetworkToken("stNEAR");
    fireEvent.change(screen.getByLabelText("Destination address"), { target: { value: destination } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    });
  }

  it("offers it for the NEAR login's own account, priced by the token", async () => {
    await refusedOnStep3({ chainKind: "near", address: ME }, ME);
    expect(mockCost).toHaveBeenCalledWith("meta-pool.near");
    expect(screen.getByText(/one-time step: 0\.00125 NEAR/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Register this account" }));
    });
    expect(mockRegister).toHaveBeenCalledWith(
      expect.objectContaining({
        send: mockSend,
        tokenAccountId: "meta-pool.near",
        accountId: ME,
        cost: BigInt("1250000000000000000000"),
      }),
    );
    // The refusal is gone and the withdrawal goes on through Continue, re-checked.
    expect(screen.queryByText(/cannot receive this token yet/)).toBeNull();
    expect(screen.getByText("Account registered. Continue with the withdrawal.")).toBeTruthy();

    mockPreflight.mockResolvedValueOnce(undefined);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    });
    expect(mockPreflight).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Confirm withdrawal" })).toBeTruthy();
  });

  it.each([
    { kind: "declined", text: "You cancelled the registration in your wallet. Nothing was withdrawn." },
    { kind: "not-confirmed", text: /couldn't confirm the registration yet/ },
  ])("stays on the refusal when the registration is $kind", async ({ kind, text }) => {
    mockRegister.mockResolvedValueOnce({ kind });
    await refusedOnStep3({ chainKind: "near", address: ME }, ME);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Register this account" }));
    });
    expect(screen.getByText(text)).toBeTruthy();
    expect(screen.getByText(/cannot receive this token yet/)).toBeTruthy();
  });

  // D-374: Continue would only be refused again, so Register leads — in weight and in focus.
  it("after the refusal, Register is the primary action and takes the focus", async () => {
    await refusedOnStep3({ chainKind: "near", address: ME }, ME);
    const register = screen.getByRole("button", { name: "Register this account" });
    const continueButton = screen.getByRole("button", { name: "Continue" });
    expect(register.className.split(/\s+/)).toContain("bg-accent");
    expect(continueButton.className.split(/\s+/)).not.toContain("bg-accent");
    expect(document.activeElement).toBe(register);
  });

  it("a registration that did not land keeps the focus on Register, for the retry", async () => {
    mockRegister.mockResolvedValueOnce({ kind: "declined" });
    await refusedOnStep3({ chainKind: "near", address: ME }, ME);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Register this account" }));
    });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Register this account" }));
  });

  it("with no wallet to ask, says so — not that it could not confirm", async () => {
    mockRegister.mockResolvedValueOnce({ kind: "wallet-not-connected" });
    await refusedOnStep3({ chainKind: "near", address: ME }, ME);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Register this account" }));
    });
    expect(screen.getByText("We couldn't reach your NEAR wallet. Reconnect it and try again. Nothing was withdrawn.")).toBeTruthy();
    expect(screen.queryByText(/couldn't confirm the registration yet/)).toBeNull();
  });

  it("with nothing to register from here, Continue stays the primary action", async () => {
    await refusedOnStep3({ chainKind: "near", address: ME }, "alice.near");
    expect(screen.getByRole("button", { name: "Continue" }).className.split(/\s+/)).toContain("bg-accent");
  });

  it("someone else's account gets the way to do it outside, not the button", async () => {
    await refusedOnStep3({ chainKind: "near", address: ME }, "alice.near");
    expect(screen.queryByRole("button", { name: "Register this account" })).toBeNull();
    expect(screen.getByText(/The owner of alice\.near can register it/)).toBeTruthy();
    expect(mockCost).not.toHaveBeenCalled();
  });

  it("a login of another family gets the text too", async () => {
    await refusedOnStep3({ chainKind: "evm", address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" }, ME);
    expect(screen.queryByRole("button", { name: "Register this account" })).toBeNull();
    expect(screen.getByText(/The owner of pablofork\.near can register it/)).toBeTruthy();
  });

  it("the modal cannot close, and the form cannot change, while the wallet is asked", async () => {
    let finish: (r: { kind: string }) => void = () => {};
    mockRegister.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const onClose = vi.fn();
    await refusedOnStep3({ chainKind: "near", address: ME }, ME, { onClose });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Register this account" }));
    });
    expect(screen.getByRole("button", { name: "Registering…" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Destination address") as HTMLInputElement).readOnly).toBe(true);
    expect((screen.getByLabelText("Amount") as HTMLInputElement).readOnly).toBe(true);
    // A second click while the first is pending opens no second prompt.
    fireEvent.click(screen.getByRole("button", { name: "Registering…" }));
    expect(mockRegister).toHaveBeenCalledOnce();

    await act(async () => finish({ kind: "registered" }));
    // Focus goes where the flow continues, not to the page behind the dialog.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Continue" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("a failed cost read is retried on the next Continue", async () => {
    mockCost.mockRejectedValueOnce(new Error("RPC 502"));
    await refusedOnStep3({ chainKind: "near", address: ME }, ME);
    expect(screen.queryByRole("button", { name: "Register this account" })).toBeNull();

    mockPreflight.mockRejectedValueOnce(
      new WithdrawDestinationUnusableError("not-registered", ME, "meta-pool.near"),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    });
    expect(mockCost).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Register this account" })).toBeTruthy();
  });

  it("a cost it cannot read shows no button", async () => {
    mockCost.mockRejectedValueOnce(new Error("RPC 502"));
    await refusedOnStep3({ chainKind: "near", address: ME }, ME);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Register this account" })).toBeNull();
    expect(screen.getByText(/The owner of pablofork\.near can register it/)).toBeTruthy();
  });
});

// D-304 (a): the refusals raised before signing reached the modal as raw English in base units.
describe("WithdrawalModal — refusals before signing, in the user's language (D-304 a)", () => {
  const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    localStorage.clear();
  });

  it.each([
    {
      name: "the amount above the balance",
      error: new AmountExceedsBalanceError(BigInt(2_000_000), BigInt(1_000_000)),
      text: "El monto es mayor que tu saldo actual. Lo estamos actualizando: revisa el monto y prueba de nuevo. No se firmó nada.",
    },
    {
      name: "a slow balance read",
      error: new HeldReadTimeoutError(),
      text: "Leer tu saldo tardó demasiado. No se firmó nada: prueba de nuevo.",
    },
    {
      name: "a failed balance read",
      error: new HeldReadFailedError(new Error("RPC HTTP 401")),
      text: "No pudimos leer tu saldo. No se firmó nada: prueba de nuevo en un momento.",
    },
  ])("$name", async ({ error, text }) => {
    const onConfirmed = vi.fn().mockRejectedValue(error);
    mockBalance.mockReturnValue(new Map([[USDC_NEAR, 50]]));
    mockPrices.mockReturnValue({ prices: { [USDC_NEAR]: { usdPrice: 1 } } });
    renderModal({ lang: "es", isRealRoute: () => false, onConfirmed });
    fireEvent.click(screen.getAllByRole("button").find((b) => b.textContent?.includes("USDC"))!);
    fireEvent.click(screen.getByRole("button", { name: "Continuar" }));
    fireEvent.change(screen.getByLabelText("Dirección de destino"), { target: { value: "alice.near" } });
    fireEvent.change(screen.getByLabelText("Monto"), { target: { value: "5" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continuar" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirmar retiro" }));
    });
    expect(screen.getByText(text)).toBeTruthy();
    expect(screen.queryByText(error.message)).toBeNull();
  });
});

// ── Block 4.2: the Solana destination pre-flight ────────────────────────────────
// Same placement and same reason as the near-native one above (D-R16), but it guards a
// different mistake: `validateAddress` cannot tell an SPL token account from a wallet, and a
// withdrawal to one is unrecoverable. An absent account is only a warning (D-213).
describe("WithdrawalModal — Solana destination pre-flight", () => {
  const USDC_SOL = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";
  const SOL_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    localStorage.clear();
  });

  async function fillStep3(props: Partial<React.ComponentProps<typeof WithdrawalModal>> = {}) {
    mockBalance.mockReturnValue(new Map([[USDC_SOL, 50]]));
    mockPrices.mockReturnValue({ prices: { [USDC_SOL]: { usdPrice: 1 } } });
    mockFee.mockResolvedValue(feeResult({ feeRaw: "30000", source: "live" }));
    renderModal(props);
    pickSingleNetworkToken("USDC");
    fireEvent.change(screen.getByLabelText("Destination address"), {
      target: { value: SOL_ADDRESS },
    });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "5" } });
  }

  it("runs on Continue and reports the result to the money path", async () => {
    const onConfirmed = vi.fn();
    mockSolPreflight.mockResolvedValue({ warning: null });
    await fillStep3({ isRealRoute: () => true, onConfirmed });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    });
    expect(mockSolPreflight).toHaveBeenCalledOnce();
    expect(mockSolPreflight.mock.calls[0][0]).toEqual(
      expect.objectContaining({ destinationAddress: SOL_ADDRESS }),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm withdrawal" }));
    });
    expect(onConfirmed).toHaveBeenCalledWith(
      expect.objectContaining({ destinationVerified: true }),
    );
  });

  it("stays on step 3 and refuses when the destination is a token account", async () => {
    const onConfirmed = vi.fn();
    mockSolPreflight.mockRejectedValue(
      new SolanaDestinationUnusableError("token-account", SOL_ADDRESS),
    );
    await fillStep3({ isRealRoute: () => true, onConfirmed });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    });

    expect(screen.getByText(/is a token account, not a wallet/)).toBeTruthy();
    expect(screen.getByLabelText("Destination address")).toBeTruthy();
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  // The warning is advisory, but it must be SEEN before the decision — so the first click
  // spends itself showing it, and only a second one goes through.
  it("warns without blocking when the destination account does not exist", async () => {
    const onConfirmed = vi.fn();
    mockSolPreflight.mockResolvedValue({ warning: "new-account" });
    await fillStep3({ isRealRoute: () => true, onConfirmed });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    });
    expect(screen.getByText(/no activity on Solana yet/)).toBeTruthy();
    expect(screen.getByLabelText("Destination address")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue anyway" }));
    });
    // Re-checking would be pointless: the address has not changed since it was checked.
    expect(mockSolPreflight).toHaveBeenCalledOnce();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm withdrawal" }));
    });
    expect(onConfirmed).toHaveBeenCalledWith(
      expect.objectContaining({ destinationVerified: true }),
    );
  });

  // The one way the warning path could become dangerous: a cleared address inheriting the
  // previous one's clearance and walking straight through on a single click.
  it("drops the warning when the address is edited", async () => {
    mockSolPreflight.mockResolvedValue({ warning: "new-account" });
    await fillStep3({ isRealRoute: () => true, onConfirmed: vi.fn() });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    });
    expect(screen.getByText(/no activity on Solana yet/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Destination address"), {
      target: { value: "So11111111111111111111111111111111111111112" },
    });
    expect(screen.queryByText(/no activity on Solana yet/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue anyway" })).toBeNull();

    // And the new address gets its own check, not the old one's verdict.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    });
    expect(mockSolPreflight).toHaveBeenCalledTimes(2);
    expect(mockSolPreflight.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        destinationAddress: "So11111111111111111111111111111111111111112",
      }),
    );
  });

  it("does not run at all when the token is not on the live path", async () => {
    const onConfirmed = vi.fn();
    await fillStep3({ isRealRoute: () => false, onConfirmed });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    });
    expect(mockSolPreflight).not.toHaveBeenCalled();
  });
});

// ── Block 4.3.6: a BLOCKED `hot-omni` quote must not state registry numbers ─────
// Found by the wet test, not by these tests: with the live quote unavailable the screen
// still printed "Network fee 0.0015 POL" and "You'll receive 4.9985 POL" — both derived
// from the registry snapshot `quote` is seeded with — while the alert below said it had no
// fee. The button was correctly disabled, so no money could move; the numbers were still a
// claim nobody had quoted. POL on Polygon, 18 decimals, snapshot 1500000000000000.
const POL = "nep245:v2_1.omni.hot.tg:137_11111111111111111111";

async function reachStep4Pol(props: Partial<React.ComponentProps<typeof WithdrawalModal>> = {}) {
  mockBalance.mockReturnValue(new Map([[POL, 8.5]]));
  mockPrices.mockReturnValue({ prices: { [POL]: { usdPrice: 0.076 } } });
  renderModal(props);
  pickSingleNetworkToken("POL");
  fireEvent.change(screen.getByLabelText("Destination address"), {
    target: { value: ARB_ADDRESS },
  });
  fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "5" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await act(async () => {});
}

describe("WithdrawalModal — blocked hot-omni quote (block 4.3.6)", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("states no fee and no net amount when the live quote cannot be had", async () => {
    mockFee.mockResolvedValue(feeResult(null));
    await reachStep4Pol({ isRealRoute: () => true });

    // The registry snapshot and anything derived from it must be off the screen.
    expect(screen.queryByText("0.0015 POL")).toBeNull();
    expect(screen.queryByText("4.9985 POL")).toBeNull();
    // …replaced by an em dash in both rows, with the reason spelled out once.
    expect(screen.getAllByText("—").length).toBe(2);
    expect(screen.getByText(/couldn't get the current network fee/)).toBeTruthy();
    // …and only that one. D-263 added a second red box for the case where nothing is being
    // quoted at all; the two describe different situations and must never both be on screen.
    expect(screen.queryByText(/can't price this withdrawal right now/)).toBeNull();
    // "Estimated" qualifies a number; with none on screen it must not appear either.
    expect(screen.queryByText(/Estimated/)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Confirm withdrawal" }).hasAttribute("disabled")
    ).toBe(true);
  });

  it("shows the live figures normally once the quote succeeds", async () => {
    // The same route with a quote must be unaffected by the guard above.
    //
    // `hot` is part of the fixture and not decoration (D-263): on `hot-omni` a live quote
    // ALWAYS carries it — `fetchWithdrawalFee` copies `live.hot` through — and the confirm
    // click has always refused a quote without it. A fixture that omitted it described a
    // response the bridge cannot produce, and pinned the screen to a state where the button
    // was live while its own handler would have refused the click. POL is Polygon's native,
    // so the relayer's gas is paid in the withdrawn token itself: `in-kind`, no swap.
    mockFee.mockResolvedValue(feeResult({
      feeRaw: "71201002690600000",
      source: "live",
      hot: {
        relayerFeeRaw: "71201002690600000",
        blockNumber: "76543210",
        nativeAssetId: POL,
        payment: "in-kind",
        swap: null,
      },
    }));
    await reachStep4Pol({ isRealRoute: () => true });
    expect(screen.getByText("0.071201 POL")).toBeTruthy();
    expect(screen.queryByText("—")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Confirm withdrawal" }).hasAttribute("disabled")
    ).toBe(false);
  });
});

// ── D-251: the fee is paid in a DIFFERENT token than the one being withdrawn ────
// The `native-balance` path reports `feeRaw: "0"` because nothing comes out of the withdrawn
// token — so every "is the fee zero" test on this screen would have called it FREE, while
// 0.04 GRAM really did leave the user's balance. These pin the two statements the screen
// must make instead: the fee in ITS OWN token, and a withdrawal that is NOT reduced by it.
const USDT_TON = "nep245:v2_1.omni.hot.tg:1117_3tsdfyziyc7EJbP2aULWSKU4toBaAcN4FdTgfm5W1mC4ouR";
const GRAM = "nep245:v2_1.omni.hot.tg:1117_";
const TON_ADDRESS = "UQCv4mTYxbLOKZBDL_b_jckLV3ev0SLA-demExEBdbkivm0W";

async function reachStep4Ton() {
  mockBalance.mockReturnValue(
    new Map([
      [USDT_TON, 5],
      [GRAM, 0.04],
    ])
  );
  mockPrices.mockReturnValue({
    prices: { [USDT_TON]: { usdPrice: 1 }, [GRAM]: { usdPrice: 1.34 } },
  });
  renderModal({ isAvailable: () => true, isRealRoute: () => true });
  pickSingleNetworkToken("USDT");
  fireEvent.change(screen.getByLabelText("Destination address"), {
    target: { value: TON_ADDRESS },
  });
  fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "5" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await act(async () => {});
}

describe("WithdrawalModal — gas paid from the signer's own balance (D-251)", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("states the fee in the gas token and does NOT call the withdrawal free", async () => {
    mockFee.mockResolvedValue(feeResult({
      feeRaw: "0",
      source: "live",
      hot: {
        relayerFeeRaw: "40000000",
        blockNumber: "0",
        nativeAssetId: GRAM,
        payment: "native-balance",
        swap: null,
      },
    }));
    await reachStep4Ton();

    // 🔴 The lie this test exists to prevent. `feeRaw: "0"` is true of the withdrawn token
    // and false of the user's wallet: 0.04 GRAM is really spent.
    expect(screen.queryByText("Free")).toBeNull();
    expect(screen.getByText("0.04 GRAM")).toBeTruthy();
    // And it is said once, in words, that this is not a second bite of the withdrawal.
    expect(screen.getByText(/Paid from your GRAM balance/)).toBeTruthy();
  });

  it("delivers the whole typed amount, undiminished by the gas fee", async () => {
    mockFee.mockResolvedValue(feeResult({
      feeRaw: "0",
      source: "live",
      hot: {
        relayerFeeRaw: "40000000",
        blockNumber: "0",
        nativeAssetId: GRAM,
        payment: "native-balance",
        swap: null,
      },
    }));
    await reachStep4Ton();

    // 5 USDT typed, 5 USDT received — the 0.04 came out of the GRAM balance. Had the old
    // `hotTokenFeeRaw` survived, this row would have read "you will receive 0" against a
    // 40 USDT "fee", and the floor check would have refused the withdrawal outright.
    // `formatCrypto` pads to two decimals: 5 typed, 5 received, nothing withheld.
    expect(screen.getAllByText("5.00 USDT").length).toBe(2);
    expect(screen.queryByText("40.00 USDT")).toBeNull();
    expect(screen.queryByText("4.96 USDT")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Confirm withdrawal" }).hasAttribute("disabled")
    ).toBe(false);
  });
});

// ── Block 4.3.6: the `hot-omni` quote is kept fresh OFF the click ───────────────
// The wet test measured this route's re-check at 2.1–3.3 s against mainnet (gas price plus a
// chained solver quote) versus a 1200 ms budget: it timed out 5 times out of 5 and left every
// non-native hot-omni token unconfirmable. The click must therefore touch no network at all.
describe("WithdrawalModal — hot-omni quote freshness (block 4.3.6)", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.useRealTimers();
    localStorage.clear();
  });

  const liveQuote = (feeRaw: string) => ({
    feeRaw,
    source: "live" as const,
    hot: { relayerFeeRaw: feeRaw, blockNumber: "1", nativeAssetId: POL, swap: null },
  });

  it("signs the quote on screen without going to the network", async () => {
    const onConfirmed = vi.fn();
    mockFee.mockResolvedValue(feeResult(liveQuote("73000000000000000")));
    await reachStep4Pol({ isRealRoute: () => true, onConfirmed });
    const callsAfterMount = mockFee.mock.calls.length;

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm withdrawal" }));
    });

    // The click added no fetch of its own — that is the whole point.
    expect(mockFee.mock.calls.length).toBe(callsAfterMount);
    expect(onConfirmed).toHaveBeenCalled();
  });

  it("re-quotes on a timer while step 4 stays open", async () => {
    vi.useFakeTimers();
    mockFee.mockResolvedValue(feeResult(liveQuote("73000000000000000")));
    await reachStep4Pol({ isRealRoute: () => true });
    expect(mockFee).toHaveBeenCalledTimes(1);

    // A refreshed, higher fee simply becomes what the screen says: the user confirms against
    // a number they can see, which is what makes the click-time re-check unnecessary.
    mockFee.mockResolvedValue(feeResult(liveQuote("81000000000000000")));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(mockFee).toHaveBeenCalledTimes(2);
    expect(screen.getByText("0.081 POL")).toBeTruthy();
  });

  it("refuses to sign a quote the timer failed to keep current", async () => {
    vi.useFakeTimers();
    const onConfirmed = vi.fn();
    mockFee.mockResolvedValue(feeResult(liveQuote("73000000000000000")));
    await reachStep4Pol({ isRealRoute: () => true, onConfirmed });

    // Every later refresh fails — a backgrounded tab, a flaky relay. The quote ages past
    // QUOTE_FRESH_MS and the click must block rather than sign a stale `block_number`.
    mockFee.mockResolvedValue(feeResult(null));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm withdrawal" }));
    });

    expect(onConfirmed).not.toHaveBeenCalled();
    expect(screen.getByText(/couldn't get the current network fee/)).toBeTruthy();
  });
});

// ── D-240: the memo seam between this modal and the envelope builder ────────────
// Found with real funds in 008.plan F4.5, at the last leg of the block. The modal read
// `memoRequired` off the DEPOSIT chain registry and refused to continue without a memo, while
// `withdraw-envelope` THROWS on any destination memo for the `hot-omni` route. Stellar is the
// only chain with the flag on and its whole withdrawal registry is `hot-omni`, so the two
// halves deadlocked: empty memo blocked the form, non-empty memo blew up the envelope, and no
// input could complete a Stellar withdrawal.
//
// Neither side was wrong on its own, and each side's tests passed — which is why this lives
// here, asserting the CROSSING: a token whose chain routes on memos but whose rail cannot
// carry one must be completable, and must send no memo.
describe("WithdrawalModal — memo requirement follows the route, not the chain (D-240)", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    localStorage.clear();
  });

  const XLM =
    "nep245:v2_1.omni.hot.tg:1100_111bzQBB5v7AhLyPMDwS8uJgQV24KaAPXtwyVWu2KXbbfQU6NXRCz";
  const STELLAR_ADDRESS = "GCLROWV43E4RIHPWUFOLFWGS2VJTRW46KXOPBQPGFKYJXQL47P6RTQDA";

  async function reachStep3Xlm(
    props: Partial<React.ComponentProps<typeof WithdrawalModal>> = {}
  ) {
    mockBalance.mockReturnValue(new Map([[XLM, 7.804]]));
    mockPrices.mockReturnValue({ prices: { [XLM]: { usdPrice: 0.164932 } } });
    renderModal(props);
    pickSingleNetworkToken("XLM");
    fireEvent.change(screen.getByLabelText("Destination address"), {
      target: { value: STELLAR_ADDRESS },
    });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "7.804" } });
    await act(async () => {});
  }

  it("does not ask for a memo on a rail that cannot carry one", async () => {
    await reachStep3Xlm();
    // The field itself is gone — not merely optional. Rendering it would invite an input that
    // the envelope builder rejects.
    expect(screen.queryByLabelText("Memo")).toBeNull();
  });

  it("lets the withdrawal proceed with no memo typed", async () => {
    await reachStep3Xlm();
    // This is the assertion the deadlock would have failed: before the fix, Continue stayed
    // disabled forever because `memoValid` demanded a non-empty memo.
    expect(
      screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")
    ).toBe(false);
  });

  it("sends no memo to the money path", async () => {
    const onConfirmed = vi.fn();
    // The live-route setup, because that is the one the wet test exercises: `hot-omni` refuses
    // to confirm on a registry fee (block 4.3.6), so the quote has to carry its `hot` leg.
    mockFee.mockResolvedValue(feeResult({
      feeRaw: "1000000",
      source: "live",
      hot: { relayerFeeRaw: "1000000", blockNumber: "1", nativeAssetId: XLM, swap: null },
    }));
    await reachStep3Xlm({ onConfirmed, isRealRoute: () => true });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Confirm withdrawal" }));
    // `undefined`, never "": the envelope treats an empty string as a memo the caller meant to
    // send, which is exactly the value that throws on `hot-omni`.
    expect(onConfirmed).toHaveBeenCalledWith(
      expect.objectContaining({ tokenId: XLM, memo: undefined })
    );
  });

  it("says out loud that this route drops the memo", async () => {
    await reachStep3Xlm();
    // Silence here is what sends funds to an exchange deposit address unattributed: the
    // transfer succeeds and the customer is never credited.
    expect(screen.getByText(/do not carry a memo/i)).toBeTruthy();
  });
});

// ── D-251: buying the gas out of a blocked screen ──────────────────────────────
// The state under test is the one measured on 2026-08-10 and reproduced above: no solver
// quotes any `hot.tg` native, so `fetchWithdrawalFee` answers null and the confirm button is
// dead. What these pin is the way OUT — and, just as much, the cases where no way out may be
// offered, because every one of them ends in a signature that spends real money.
//
// `fetchHotGasRequirement` is NOT mocked here: on TON it is a constant and touches no
// network, which is exactly the property that makes it safe to call from a blocked screen.
const ONECLICK_DEPOSIT = "e9f4c3a2b1d0.omni.1click.near";

function gasQuote(over: Record<string, unknown> = {}) {
  return {
    depositAddress: ONECLICK_DEPOSIT,
    amountInRaw: "53907", // 0.053907 USDT, the figure measured against the real API
    amountOutRaw: "40000000", // 0.04 GRAM — TON is a flat fee, so exactly the requirement
    tokenId: USDT_TON,
    nativeAssetId: GRAM,
    ...over,
  };
}

/**
 * TON's flat relayer fee, as `fetchHotGasRequirement` really reports it (0.04 GRAM at 9
 * decimals, no network call). Stated here rather than left to a call-through because since
 * D-274 the requirement reaches the screen THROUGH the fee result: it is the same resolution
 * the sufficiency check used, not a second lookup, and a test that let the modal fetch its own
 * would be exercising the shape the block removed.
 */
const TON_REQUIREMENT = {
  relayerFeeRaw: "40000000",
  blockNumber: "0",
  nativeAssetId: GRAM,
};

async function reachStep4TonBlocked(
  props: Partial<React.ComponentProps<typeof WithdrawalModal>> = {}
) {
  // No GRAM at all — the whole reason the purchase is on offer.
  mockBalance.mockReturnValue(new Map([[USDT_TON, 5]]));
  mockPrices.mockReturnValue({
    prices: { [USDT_TON]: { usdPrice: 1 }, [GRAM]: { usdPrice: 1.34 } },
  });
  // `quote: null` is the blocked screen; the requirement rides out with it (D-274).
  mockFee.mockResolvedValue(feeResult(null, TON_REQUIREMENT));
  renderModal({ isRealRoute: () => true, isAvailable: () => true, ...props });
  pickSingleNetworkToken("USDT");
  fireEvent.change(screen.getByLabelText("Destination address"), {
    target: { value: TON_ADDRESS },
  });
  fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "5" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await act(async () => {});
  await act(async () => {});
}

describe("WithdrawalModal — buying the gas (D-251)", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("offers the purchase, priced, instead of a dead end", async () => {
    const onQuoteGas = vi.fn(async () => gasQuote());
    await reachStep4TonBlocked({ onQuoteGas, onBuyGas: vi.fn() });

    // What the network wants, and what it costs in the token being withdrawn.
    expect(screen.getByText("0.04 GRAM")).toBeTruthy();
    // The cost in the token being sold AND in dollars — the only unit that says whether
    // five cents or five dollars is about to leave.
    expect(screen.getByText("0.053907 USDT · $0.05")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Buy 0.04 GRAM" })).toBeTruthy();
    // 🔴 "Try again in a moment" is false here: no solver quotes GRAM at any size, and
    // waiting fixes nothing. With a real obstacle to name, the screen names it.
    expect(screen.queryByText(/couldn't get the current network fee/)).toBeNull();
    expect(screen.getByText(/charges its fee in GRAM/)).toBeTruthy();
  });

  it("asks for exactly the gas the relayer needs, in the chain's own native", async () => {
    // Typed parameter, so the assertion below reads the argument the modal actually passed
    // rather than an empty tuple: what is under test IS the shape of that request.
    const onQuoteGas = vi.fn(async (_p: GasQuoteRequest) => gasQuote());
    await reachStep4TonBlocked({ onQuoteGas, onBuyGas: vi.fn() });

    expect(onQuoteGas).toHaveBeenCalledTimes(1);
    expect(onQuoteGas.mock.calls[0][0]).toMatchObject({
      tokenId: USDT_TON,
      nativeAssetId: GRAM,
      // 🔴 EXACTLY TON's flat 40000000 constant, and the exactness is the point: a margin
      // exists to absorb a requirement that MOVES between the purchase and the withdrawal, and
      // TON's cannot move. It used to buy double here; that surplus was charged for protection
      // this chain has no use for. The four EVM chains, whose fee is a live gas price, still
      // buy double. See the per-chain table in `gasPurchaseTargetRaw`.
      feeRaw: "40000000",
    });
  });

  // 🔴 D-274, and it is the CALL SITE that is under test here, not the library. The library
  // can compute one requirement per pass and still be wired to a screen that asks for its own
  // — which is the shape this block removed, and the shape a revert restores.
  it("sizes the purchase from the fee lookup's requirement, without a second lookup", async () => {
    const onQuoteGas = vi.fn(async (_p: GasQuoteRequest) => gasQuote());
    // A requirement that is deliberately NOT what a fresh lookup would produce: TON's real
    // constant is 40000000, so anything sized against a re-fetch lands on that instead of this.
    mockBalance.mockReturnValue(new Map([[USDT_TON, 5]]));
    mockPrices.mockReturnValue({
      prices: { [USDT_TON]: { usdPrice: 1 }, [GRAM]: { usdPrice: 1.34 } },
    });
    mockFee.mockResolvedValue(
      feeResult(null, { ...TON_REQUIREMENT, relayerFeeRaw: "44000000" })
    );
    renderModal({ isAvailable: () => true, isRealRoute: () => true, onQuoteGas, onBuyGas: vi.fn() });
    pickSingleNetworkToken("USDT");
    fireEvent.change(screen.getByLabelText("Destination address"), {
      target: { value: TON_ADDRESS },
    });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await act(async () => {});
    await act(async () => {});

    // The purchase is sized against the figure the sufficiency check used, not a second opinion.
    expect(onQuoteGas.mock.calls[0][0]).toMatchObject({ feeRaw: "44000000" });
    // And the second resolution never happens at all. On Stellar this call is a Horizon round
    // trip that can answer differently from the first, which is the whole failure.
    expect(mockGasReq).not.toHaveBeenCalled();
  });

  it("hands the buy the exact quote the screen displayed", async () => {
    const quote = gasQuote();
    const onBuyGas = vi.fn(
      async (_p: {
        quote: GasPurchaseQuote;
        maxAmountInRaw: string;
        withdrawalAmountRaw: string;
      }) => {}
    );
    await reachStep4TonBlocked({ onQuoteGas: vi.fn(async () => quote), onBuyGas });

    fireEvent.click(screen.getByRole("button", { name: "Buy 0.04 GRAM" }));
    await act(async () => {});

    // Same object, not a re-quote: `amountIn` is the price the user just agreed to and
    // `depositAddress` is where it goes.
    expect(onBuyGas).toHaveBeenCalledTimes(1);
    expect(onBuyGas.mock.calls[0][0].quote).toBe(quote);
    // 0.04 GRAM at $1.34 is $0.0536; three times that, in 6-decimal USDT, is 160800 base
    // units. The ceiling travels WITH the quote so the purchase enforces this exact number.
    expect(onBuyGas.mock.calls[0][0].maxAmountInRaw).toBe("160800");
    // The 5 USDT being withdrawn, so the purchase path can refuse to eat into it.
    expect(onBuyGas.mock.calls[0][0].withdrawalAmountRaw).toBe("5000000");
  });

  // 🔴 The bound that keeps this a five-cent trade. Under the withdrawal, so the "too large"
  // guard lets it through — and absurd against what the gas is actually worth.
  it("refuses to offer a quote priced far above what the gas is worth", async () => {
    const onBuyGas = vi.fn();
    await reachStep4TonBlocked({
      // 1 USDT for $0.0536 of gas: ~19x.
      onQuoteGas: vi.fn(async () => gasQuote({ amountInRaw: "1000000" })),
      onBuyGas,
    });

    expect(screen.getByText(/price we were quoted is too high/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Buy / })).toBeNull();
    expect(onBuyGas).not.toHaveBeenCalled();
  });

  it("refuses when the gas has no price to judge the quote against", async () => {
    const onBuyGas = vi.fn();
    // No price for GRAM and no fallback reachable: the ceiling cannot be computed, so there
    // is nothing to check the quote against and the purchase is not offered at all.
    mockBalance.mockReturnValue(new Map([[USDT_TON, 5]]));
    mockPrices.mockReturnValue({ prices: { [USDT_TON]: { usdPrice: 1 }, [GRAM]: { usdPrice: 0 } } });
    mockFee.mockResolvedValue(feeResult(null));
    renderModal({ isAvailable: () => true,
      isRealRoute: () => true,
      onQuoteGas: vi.fn(async () => gasQuote()),
      onBuyGas,
    });
    pickSingleNetworkToken("USDT");
    fireEvent.change(screen.getByLabelText("Destination address"), {
      target: { value: TON_ADDRESS },
    });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await act(async () => {});
    await act(async () => {});

    expect(screen.queryByRole("button", { name: /^Buy / })).toBeNull();
    expect(onBuyGas).not.toHaveBeenCalled();
  });

  // 🔴 A price with no way to act on it is worse than the plain block: it reads as an offer.
  it("never offers a purchase it cannot make", async () => {
    const onQuoteGas = vi.fn(async () => gasQuote());
    await reachStep4TonBlocked({ onQuoteGas });

    expect(onQuoteGas).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /^Buy / })).toBeNull();
    expect(screen.getByText(/couldn't get the current network fee/)).toBeTruthy();
  });

  it("prices nothing while the withdrawal is not blocked", async () => {
    const onQuoteGas = vi.fn(async () => gasQuote());
    // The `native-balance` path: the signer already holds the gas, so there is nothing to buy
    // and asking would price a purchase nobody needs.
    mockFee.mockResolvedValue(feeResult({
      feeRaw: "0",
      source: "live",
      hot: {
        relayerFeeRaw: "40000000",
        blockNumber: "0",
        nativeAssetId: GRAM,
        payment: "native-balance",
        swap: null,
      },
    }));
    mockBalance.mockReturnValue(new Map([[USDT_TON, 5], [GRAM, 0.04]]));
    mockPrices.mockReturnValue({
      prices: { [USDT_TON]: { usdPrice: 1 }, [GRAM]: { usdPrice: 1.34 } },
    });
    renderModal({ isAvailable: () => true, isRealRoute: () => true, onQuoteGas, onBuyGas: vi.fn() });
    pickSingleNetworkToken("USDT");
    fireEvent.change(screen.getByLabelText("Destination address"), {
      target: { value: TON_ADDRESS },
    });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await act(async () => {});
    await act(async () => {});

    expect(onQuoteGas).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /^Buy / })).toBeNull();
  });

  it("says so, and offers nothing, when the purchase cannot be priced", async () => {
    await reachStep4TonBlocked({ onQuoteGas: vi.fn(async () => null), onBuyGas: vi.fn() });

    expect(screen.queryByRole("button", { name: /^Buy / })).toBeNull();
    expect(screen.getByText(/couldn't get the current network fee/)).toBeTruthy();
  });

  // Mirrors `buildGasPurchaseSignRequest`'s guard on screen. Reaching a wallet prompt to be
  // told the purchase would eat the withdrawal is the wrong place to find out.
  it("refuses to offer a purchase that would cost more than the withdrawal", async () => {
    const onBuyGas = vi.fn();
    // 6 USDT of gas against a 5 USDT withdrawal.
    await reachStep4TonBlocked({
      onQuoteGas: vi.fn(async () => gasQuote({ amountInRaw: "6000000" })),
      onBuyGas,
    });

    expect(screen.getByText(/cost more than this withdrawal/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Buy / })).toBeNull();
    expect(onBuyGas).not.toHaveBeenCalled();
  });

  it("re-prices instead of signing once the quote has aged out", async () => {
    const onQuoteGas = vi.fn(async () => gasQuote());
    const onBuyGas = vi.fn(async () => {});
    const realNow = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(realNow);
    try {
      await reachStep4TonBlocked({ onQuoteGas, onBuyGas });
      expect(onQuoteGas).toHaveBeenCalledTimes(1);

      // Six minutes later — past GAS_QUOTE_FRESH_MS, still inside 1Click's own deadline.
      clock.mockReturnValue(realNow + 6 * 60_000);
      fireEvent.click(screen.getByRole("button", { name: "Buy 0.04 GRAM" }));
      await act(async () => {});

      // 🔴 Nothing is signed against a price nobody is looking at. The click re-asks, says
      // so, and waits for a second one — and it opens no wallet prompt, so no popup is lost.
      expect(onBuyGas).not.toHaveBeenCalled();
      expect(onQuoteGas).toHaveBeenCalledTimes(2);
      expect(screen.getByText(/price moved while you were reviewing/)).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Buy 0.04 GRAM" }));
      await act(async () => {});
      expect(onBuyGas).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  });

  it("reports a failed purchase without claiming where the money is", async () => {
    const onBuyGas = vi.fn(async () => {
      throw new Error("wallet rejected the transfer");
    });
    await reachStep4TonBlocked({ onQuoteGas: vi.fn(async () => gasQuote()), onBuyGas });

    fireEvent.click(screen.getByRole("button", { name: "Buy 0.04 GRAM" }));
    await act(async () => {});

    // The error's own words, verbatim. Only the purchase path knows whether the money moved,
    // so this screen adds no headline of its own — "we couldn't buy it" would be false of a
    // transfer that settled and is still waiting on delivery.
    expect(screen.getByText("wallet rejected the transfer")).toBeTruthy();
    expect(screen.queryByText(/couldn't buy/)).toBeNull();
    expect(screen.queryByText(/balance is unchanged/)).toBeNull();
    // Still offered: a rejected prompt is a retry, not a dead end.
    expect(screen.getByRole("button", { name: "Buy 0.04 GRAM" })).toBeTruthy();
  });
});

// ── D-251, second pass: what happens WHILE the purchase is in flight ────────────
// The first pass covered which numbers the screen states. These cover the window between the
// click and the answer — the one where a second click is a second payment. Every test here
// holds `onBuyGas` pending on purpose; before they existed, both defences (the `disabled`
// attribute and the re-entrancy guard) could be deleted with the suite staying green.
describe("WithdrawalModal — a purchase in flight (D-251)", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    localStorage.clear();
  });

  /** A promise the test decides when to settle. */
  function deferred<T = void>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("disables the button and says what it is doing until the purchase answers", async () => {
    const gate = deferred();
    const onBuyGas = vi.fn(() => gate.promise);
    await reachStep4TonBlocked({ onQuoteGas: vi.fn(async () => gasQuote()), onBuyGas });

    fireEvent.click(screen.getByRole("button", { name: "Buy 0.04 GRAM" }));
    await act(async () => {});

    // The only visible sign the operation is alive during a wait that can reach two minutes.
    const busy = screen.getByRole("button", { name: "Buying GRAM…" });
    expect(busy.hasAttribute("disabled")).toBe(true);
    expect(busy.getAttribute("aria-busy")).toBe("true");

    await act(async () => {
      gate.resolve();
    });
    expect(onBuyGas).toHaveBeenCalledTimes(1);
  });

  it("does not buy twice when the button is clicked again mid-purchase", async () => {
    const gate = deferred();
    const onBuyGas = vi.fn(() => gate.promise);
    await reachStep4TonBlocked({ onQuoteGas: vi.fn(async () => gasQuote()), onBuyGas });

    const button = screen.getByRole("button", { name: "Buy 0.04 GRAM" });
    fireEvent.click(button);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Buying GRAM…" }));
    fireEvent.click(screen.getByRole("button", { name: "Buying GRAM…" }));
    await act(async () => {});

    expect(onBuyGas).toHaveBeenCalledTimes(1);
    await act(async () => {
      gate.resolve();
    });
  });

  // 🔴 The double-purchase generator this guard exists for. The arrival budget expiring is
  // NOT a failure — the transfer settled — so the message says the token was paid for. Under
  // a live button, that message is an invitation to pay for it again, and the quote is still
  // young enough to skip the staleness re-quote.
  it("offers no second purchase after one that may have moved money", async () => {
    const onBuyGas = vi.fn(async () => {
      // Exactly what the shell throws when the arrival budget expires: `left-balance`,
      // because `runGasPurchase` only resolves after the transfer settled.
      throw new WithdrawError(
        "The GRAM was paid for but hasn't arrived yet. It should land shortly.",
        "left-balance"
      );
    });
    await reachStep4TonBlocked({ onQuoteGas: vi.fn(async () => gasQuote()), onBuyGas });

    fireEvent.click(screen.getByRole("button", { name: "Buy 0.04 GRAM" }));
    await act(async () => {});

    expect(screen.getByText(/was paid for but hasn't arrived yet/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Buy / })).toBeNull();
    expect(screen.queryByRole("button", { name: "Buying GRAM…" })).toBeNull();
  });

  it("gives the offer back when the wallet was simply dismissed", async () => {
    const onBuyGas = vi.fn(async () => {
      // What `runGasPurchase` re-throws untouched: a wallet error, carrying no `fundsState`,
      // which by construction never reached the published path.
      throw new Error("User rejected the request");
    });
    await reachStep4TonBlocked({ onQuoteGas: vi.fn(async () => gasQuote()), onBuyGas });

    fireEvent.click(screen.getByRole("button", { name: "Buy 0.04 GRAM" }));
    await act(async () => {});

    expect(screen.getByText("User rejected the request")).toBeTruthy();
    // Nothing moved, so buying again is exactly what the user should be able to do.
    expect(screen.getByRole("button", { name: "Buy 0.04 GRAM" })).toBeTruthy();
  });

  it("gives the offer back when the relay refused the intent outright", async () => {
    const onBuyGas = vi.fn(async () => {
      throw new WithdrawError("The relay refused the gas purchase", "untouched");
    });
    await reachStep4TonBlocked({ onQuoteGas: vi.fn(async () => gasQuote()), onBuyGas });

    fireEvent.click(screen.getByRole("button", { name: "Buy 0.04 GRAM" }));
    await act(async () => {});

    // `fundsState` decides, not the wording: a refused intent never executed.
    expect(screen.getByRole("button", { name: "Buy 0.04 GRAM" })).toBeTruthy();
  });

  it("keeps the offer withdrawn when the outcome is merely unknown", async () => {
    const onBuyGas = vi.fn(async () => {
      throw new WithdrawError("Could not confirm whether it was published", "unknown");
    });
    await reachStep4TonBlocked({ onQuoteGas: vi.fn(async () => gasQuote()), onBuyGas });

    fireEvent.click(screen.getByRole("button", { name: "Buy 0.04 GRAM" }));
    await act(async () => {});

    expect(screen.queryByRole("button", { name: /^Buy / })).toBeNull();
  });
});

// ── D-251: the ceiling's inputs ────────────────────────────────────────────────
describe("WithdrawalModal — pricing the ceiling (D-251)", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    localStorage.clear();
  });

  async function reachWithPrices(prices: Record<string, { usdPrice: number }>, onBuyGas = vi.fn()) {
    mockBalance.mockReturnValue(new Map([[USDT_TON, 5]]));
    mockPrices.mockReturnValue({ prices });
    mockFee.mockResolvedValue(feeResult(null, TON_REQUIREMENT));
    const onQuoteGas = vi.fn(async () => gasQuote());
    renderModal({ isAvailable: () => true, isRealRoute: () => true, onQuoteGas, onBuyGas });
    pickSingleNetworkToken("USDT");
    fireEvent.change(screen.getByLabelText("Destination address"), {
      target: { value: TON_ADDRESS },
    });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await act(async () => {});
    await act(async () => {});
    return onBuyGas;
  }

  // 🔴 The live feed not carrying GRAM is the realistic gap, and it does NOT block the
  // purchase — the registry's `fallbackUsdPrice` (1.98) stands in. That is 48% above the
  // $1.34 measured on 2026-08-10, so the ceiling it produces is 48% more permissive, on the
  // one path that sends money to a third party. Pinned so the number is a decision, not a
  // surprise: 0.04 GRAM × 1.98 × 3 = $0.2376 → 237600 base units of USDT.
  it("falls back to the registry price when the feed does not carry the gas token", async () => {
    const onBuyGas = await reachWithPrices({ [USDT_TON]: { usdPrice: 1 } });

    fireEvent.click(screen.getByRole("button", { name: "Buy 0.04 GRAM" }));
    await act(async () => {});
    expect(onBuyGas.mock.calls[0][0].maxAmountInRaw).toBe("237600");
  });

  it("offers nothing when the token being sold has no price either", async () => {
    const onBuyGas = await reachWithPrices({});
    // Both sides unpriced still leaves the registry fallbacks, which both tokens carry — so
    // what this pins is that the ceiling is computed from SOMETHING, never skipped.
    expect(screen.getByRole("button", { name: "Buy 0.04 GRAM" })).toBeTruthy();
    expect(onBuyGas).not.toHaveBeenCalled();
  });
});

// ── D-263: a fee the screen does not have must render as absent, never as "Free" ─
// Found on 2026-08-10 (session 121) during the Stellar real-money run, by dismissing a wallet
// prompt. `feeRaw` on this screen is `quote?.feeRaw ?? "0"` and FOUR of the six `hot-omni`
// chains carry a registry snapshot that is literally "0" (Avalanche, Optimism, TON, Stellar),
// so "nobody quoted this" and "it costs nothing" arrive at the render as the same zero.
//
// What makes it reachable rather than theoretical: `liveFee` is `isRealWithdrawalRoute(...)`,
// which answers false the moment the signer goes away. The fee effect's `!wantsLive` branch
// then swaps the live quote for the registry snapshot AND clears `hotFeeBlocked` — the flag
// these screens were gated on — so the screen goes from a correct em dash with a dead button
// to "Free · You'll receive 5.00 USDT" with a live one, over real money.
describe("WithdrawalModal — a fee we do not have (D-263)", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    localStorage.clear();
  });

  const liveTonQuote = {
    feeRaw: "0",
    source: "live" as const,
    hot: {
      relayerFeeRaw: "40000000",
      blockNumber: "0",
      nativeAssetId: GRAM,
      payment: "native-balance" as const,
      swap: null,
    },
  };

  async function reachStep4Ton(props: Partial<React.ComponentProps<typeof WithdrawalModal>>) {
    mockBalance.mockReturnValue(new Map([[USDT_TON, 5]]));
    mockPrices.mockReturnValue({
      prices: { [USDT_TON]: { usdPrice: 1 }, [GRAM]: { usdPrice: 1.34 } },
    });
    const view = renderModal({ isAvailable: () => true, ...props });
    pickSingleNetworkToken("USDT");
    fireEvent.change(screen.getByLabelText("Destination address"), {
      target: { value: TON_ADDRESS },
    });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await act(async () => {});
    await act(async () => {});
    return view;
  }

  const confirmBtn = () =>
    screen.getByRole("button", { name: /Confirm withdrawal/ });

  // 🔴 The measured incident, end to end: a live quote on screen, then the signer goes away.
  it("stops stating a fee when the route stops being live under the user", async () => {
    mockFee.mockResolvedValue(feeResult(liveTonQuote));
    const view = await reachStep4Ton({ isRealRoute: () => true });
    // Before: the real figure, in the token that actually pays it, button live.
    expect(screen.getByText("0.04 GRAM")).toBeTruthy();
    expect(confirmBtn().hasAttribute("disabled")).toBe(false);

    // The wallet prompt was dismissed, so `liveSigner` is null and the route is no longer live.
    view.rerender(
      <WithdrawalModal open={true} lang="en" onClose={vi.fn()} isRealRoute={() => false} />
    );
    await act(async () => {});

    // "Free" is not a hedge — it is a claim that nothing is charged. It must be gone, and
    // with it the net amount derived from a fee nobody quoted.
    // "5.00 USDT" stays on screen in the details above — it is the amount the user typed.
    // What must vanish is the fee and the net derived from it, which is what the two em
    // dashes below pin.
    expect(screen.queryByText("Free")).toBeNull();
    expect(screen.getAllByText("—").length).toBe(2);
    // A screen that cannot price the withdrawal must not offer to sign it.
    expect(confirmBtn().hasAttribute("disabled")).toBe(true);
    // …and must say why, rather than leaving a bare em dash under a dead button. Not the
    // "try again in a moment" line: nothing is being retried here.
    expect(screen.getByText(/can't price this withdrawal right now/)).toBeTruthy();
    expect(screen.queryByText(/couldn't get the current network fee/)).toBeNull();
  });

  // The same statement, from the other direction: no live quote was ever pursued. This is
  // every `hot-omni` token on the mock route today, and it said "Free" on all four of the
  // zero-snapshot chains.
  it("never states a fee from the registry snapshot on hot-omni", async () => {
    await reachStep4Ton({ isRealRoute: () => false });

    expect(mockFee).not.toHaveBeenCalled(); // nothing is quoting it, by construction
    expect(screen.queryByText("Free")).toBeNull();
    expect(screen.getAllByText("—").length).toBe(2);
    expect(confirmBtn().hasAttribute("disabled")).toBe(true);
    // Asserted HERE and not only in the transition test above, because this is the state
    // every `hot-omni` token is in on the mock route — the common case, not the exotic one.
    expect(screen.getByText(/can't price this withdrawal right now/)).toBeTruthy();
  });

  // 🔴 The clause this block introduced, and the one the cross-review found unguarded: a
  // quote can be `source: "live"` and still carry no `hot` detail. `fetchWithdrawalFee`
  // cannot produce that today (withdrawal-fee.ts:130 copies `live.hot` through, and
  // `HotWithdrawalFee.hot` is required), which is exactly why it needs a test rather than a
  // reader's trust: the guarantee lives in another module and nothing pins it from here.
  // Such a quote is a price the confirm click already refuses, so stating it would put a
  // number on screen that cannot be signed.
  it("states no fee for a live quote that carries no signable detail", async () => {
    mockFee.mockResolvedValue(feeResult({ feeRaw: "40000000", source: "live" }));
    await reachStep4Ton({ isRealRoute: () => true });

    expect(screen.queryByText("Free")).toBeNull();
    expect(screen.queryByText("40 GRAM")).toBeNull();
    expect(screen.getAllByText("—").length).toBe(2);
    expect(confirmBtn().hasAttribute("disabled")).toBe(true);
  });

  // The first quote is still in flight. Pinned because this block CHANGED it: `hot-omni`
  // used to offer a live button over a net amount derived from the registry snapshot while
  // "Checking current fee…" was on screen, and clicking it produced the wrong message —
  // "try again in a moment" about a lookup that had not finished. Now the button waits.
  it("does not offer to sign while the first hot-omni quote is still in flight", async () => {
    mockFee.mockReturnValue(new Promise(() => {})); // never resolves
    await reachStep4Ton({ isRealRoute: () => true });

    expect(screen.getByText("Checking current fee…")).toBeTruthy();
    expect(confirmBtn().hasAttribute("disabled")).toBe(true);
    // No alert while a lookup is genuinely running: neither message would be true yet.
    expect(screen.queryByText(/can't price this withdrawal right now/)).toBeNull();
    expect(screen.queryByText(/couldn't get the current network fee/)).toBeNull();
  });

  // 🔴 The over-correction this must not become. A zero fee that IS known stays "Free":
  // `near-native` has no live lookup by design and its registry snapshot is the real figure,
  // so an em dash there would be the same lie in the opposite direction.
  it("still says Free when the zero is a number we have", async () => {
    const usdcNear = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
    // Stated rather than assumed: `vi.clearAllMocks()` clears calls, not implementations, so
    // an earlier test's rejected pre-flight would otherwise still be in force here and step 4
    // would never be reached — a green assertion about a screen nobody rendered.
    mockPreflight.mockResolvedValue(undefined);
    mockBalance.mockReturnValue(new Map([[usdcNear, 100]]));
    mockPrices.mockReturnValue({ prices: { [usdcNear]: { usdPrice: 1 } } });
    renderModal({ isAvailable: () => true, isRealRoute: () => true });
    pickSingleNetworkToken("USDC");
    fireEvent.change(screen.getByLabelText("Destination address"), {
      target: { value: "alice.near" },
    });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await act(async () => {});
    await act(async () => {});

    expect(screen.getByText("Free")).toBeTruthy();
    // Twice: the amount typed, and the same amount in "You'll receive" — which is what a
    // genuinely free withdrawal means and what the em dash would have destroyed.
    expect(screen.getAllByText("10.00 USDC").length).toBe(2);
    expect(confirmBtn().hasAttribute("disabled")).toBe(false);
  });
});

// ── D-273: the margin is per chain, and the WIRING is what decides which one applies ─────
//
// `gas-purchase.test.ts` pins the library, but it passes `chainId` in directly, so it can only
// ever constrain the lookup — never that the modal hands over the right chain. A cross-review
// mutation proved the gap: hardcoding "ton:mainnet" at the call site deletes the EVM 2x margin
// outright and every other test in the repo stayed green. This is the test that goes red.
//
// Polygon rather than TON because it is the opposite side of the table: its fee is a live
// `eth_gasPrice`, so the requirement genuinely drifts and the margin has to survive.
describe("WithdrawalModal — the per-chain margin reaches the quote (D-273)", () => {
  const USDT_POL = "nep245:v2_1.omni.hot.tg:137_3hpYoaLtt8MP1Z2GH1U473DMRKgr";
  const POL_NATIVE = "nep245:v2_1.omni.hot.tg:137_11111111111111111111";
  const EVM_ADDRESS = "0x1111111111111111111111111111111111111111";
  /** A real measured Polygon requirement: floor(gasPrice * 1.3) * 200_000, 18 decimals. */
  const POL_FEE_RAW = "73231801349800000";

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("buys DOUBLE on Polygon, whose fee is a live gas price", async () => {
    mockBalance.mockReturnValue(new Map([[USDT_POL, 50]]));
    mockPrices.mockReturnValue({
      prices: { [USDT_POL]: { usdPrice: 1 }, [POL_NATIVE]: { usdPrice: 0.076 } },
    });
    // Blocked: no signable quote, which is what puts the purchase on offer — and the gas
    // requirement rides out with the block instead of being fetched again (D-274).
    mockFee.mockResolvedValue(
      feeResult(null, {
        relayerFeeRaw: POL_FEE_RAW,
        blockNumber: "1",
        nativeAssetId: POL_NATIVE,
      })
    );

    // Typed parameter for the same reason the TON test gives: an untyped mock reads back as an
    // empty tuple and the assertion below would have nothing to inspect.
    const onQuoteGas = vi.fn(async (_p: GasQuoteRequest) => null);
    renderModal({ isAvailable: () => true, isRealRoute: () => true, onQuoteGas, onBuyGas: vi.fn() });
    pickSingleNetworkToken("USDT");
    fireEvent.change(screen.getByLabelText("Destination address"), {
      target: { value: EVM_ADDRESS },
    });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await act(async () => {});
    await act(async () => {});

    expect(onQuoteGas).toHaveBeenCalled();
    expect(onQuoteGas.mock.calls[0][0]).toMatchObject({
      nativeAssetId: POL_NATIVE,
      // 🔴 2x the requirement. TON and Stellar buy theirs exactly; this chain must not, and a
      // call site that passed a constant chain id would fail right here.
      feeRaw: "146463602699600000",
    });
  });
});

// D-384: an omft token (SOL, …) can also leave to a NEAR account, as its NEAR token.
describe("WithdrawalModal — destination network for an omft token (D-384)", () => {
  const SOL = "nep141:sol.omft.near";
  const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
  const ME = "pablofork.near";

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    localStorage.clear();
    vi.mocked(useLoginWallet).mockReturnValue({ connection: null } as never);
  });

  function openSol(props: Partial<React.ComponentProps<typeof WithdrawalModal>> = {}) {
    mockBalance.mockReturnValue(new Map([[SOL, 2]]));
    mockPrices.mockReturnValue({ prices: { [SOL]: { usdPrice: 150 } } });
    mockFee.mockResolvedValue(feeResult({ feeRaw: "14000", source: "live" }));
    renderModal(props);
    pickSingleNetworkToken("SOL");
  }

  it("offers the native chain and NEAR, starting on the native chain", () => {
    openSol();
    expect(screen.getByText("Destination network")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Solana" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "NEAR" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("Withdraw SOL to Solana")).toBeTruthy();
    expect(screen.queryByText(/arrives in the NEAR account/i)).toBeNull();
  });

  it("does not show the choice for a token that lives on NEAR", () => {
    mockBalance.mockReturnValue(new Map([[USDC_NEAR, 5]]));
    mockPrices.mockReturnValue({ prices: {} });
    renderModal();
    pickSingleNetworkToken("USDC");
    expect(screen.queryByText("Destination network")).toBeNull();
  });

  it("switches to NEAR, says what arrives, and offers the NEAR login's own account", () => {
    vi.mocked(useLoginWallet).mockReturnValue({
      connection: { chainKind: "near", address: ME },
    } as never);
    openSol();
    fireEvent.click(screen.getByRole("button", { name: "NEAR" }));

    expect(screen.getByText("Withdraw SOL to NEAR")).toBeTruthy();
    expect(
      screen.getByText(
        "It arrives in the NEAR account as the token sol.omft.near, not as native SOL. To receive native SOL, choose Solana."
      )
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use my wallet" }));
    expect((screen.getByLabelText("Destination address") as HTMLInputElement).value).toBe(ME);
  });

  it("runs the NEAR pre-flight on the omft contract and confirms to near:mainnet, with no bridge fee", async () => {
    const onConfirmed = vi.fn();
    mockPreflight.mockResolvedValue(undefined);
    openSol({ isRealRoute: () => true, onConfirmed });
    fireEvent.click(screen.getByRole("button", { name: "NEAR" }));
    fireEvent.change(screen.getByLabelText("Destination address"), { target: { value: ME } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "0.5" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    });
    expect(mockPreflight).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenAccountId: "sol.omft.near",
        destinationAddress: ME,
        requireStorageRegistration: true,
      })
    );
    expect(mockSolPreflight).not.toHaveBeenCalled();
    // No bridge in the loop, so nobody is asked for a fee and nothing is deducted.
    expect(mockFee).not.toHaveBeenCalled();
    expect(screen.getByText("Free")).toBeTruthy();
    expect(screen.getByText(/as the token sol\.omft\.near/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm withdrawal" }));
    });
    expect(onConfirmed).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenId: SOL,
        chainId: "near:mainnet",
        address: ME,
        destinationVerified: true,
      })
    );
  });

  it("offers to switch when the address belongs to the other destination", () => {
    openSol();
    fireEvent.change(screen.getByLabelText("Destination address"), { target: { value: ME } });
    expect(screen.getByText(/looks like a NEAR address/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send to NEAR instead" }));
    expect(screen.getByRole("button", { name: "NEAR" }).getAttribute("aria-pressed")).toBe("true");
    // The address survives the switch — it was the reason for it.
    expect((screen.getByLabelText("Destination address") as HTMLInputElement).value).toBe(ME);
    expect(screen.queryByText(/looks like a NEAR address/)).toBeNull();
  });

  it("drops every verdict when the destination is switched, and checks again on Continue", async () => {
    vi.mocked(useLoginWallet).mockReturnValue({
      connection: { chainKind: "near", address: ME },
    } as never);
    vi.mocked(useSendTransactionAs).mockReturnValue(vi.fn(async () => ({})));
    mockPreflight.mockRejectedValueOnce(
      new WithdrawDestinationUnusableError("not-registered", ME, "sol.omft.near"),
    );
    openSol({ isRealRoute: () => true });
    fireEvent.click(screen.getByRole("button", { name: "NEAR" }));
    fireEvent.change(screen.getByLabelText("Destination address"), { target: { value: ME } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "0.5" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    });
    expect(screen.getByText(/cannot receive this token yet/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Register this account" })).toBeTruthy();

    // A verdict about the NEAR route says nothing about the Solana one, or about NEAR again.
    fireEvent.click(screen.getByRole("button", { name: "Solana" }));
    expect(screen.queryByText(/cannot receive this token yet/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Register this account" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "NEAR" }));
    expect(screen.queryByText(/cannot receive this token yet/)).toBeNull();

    mockPreflight.mockResolvedValueOnce(undefined);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    });
    expect(mockPreflight).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Confirm withdrawal" })).toBeTruthy();
    vi.mocked(useSendTransactionAs).mockReturnValue(null);
  });

  it("a Solana warning does not wave the NEAR route through", async () => {
    const onConfirmed = vi.fn();
    mockSolPreflight.mockResolvedValueOnce({ warning: "new-account" });
    openSol({ isRealRoute: () => true, onConfirmed });
    fireEvent.change(screen.getByLabelText("Destination address"), {
      target: { value: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" },
    });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "0.5" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    });
    expect(screen.getByRole("button", { name: "Continue anyway" })).toBeTruthy();

    // Switch and fix the address: Continue must run the NEAR check, not reuse the warning.
    fireEvent.click(screen.getByRole("button", { name: "NEAR" }));
    fireEvent.change(screen.getByLabelText("Destination address"), { target: { value: ME } });
    mockPreflight.mockResolvedValueOnce(undefined);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    });
    expect(mockPreflight).toHaveBeenCalledOnce();
    expect(mockPreflight.mock.calls[0][0]).toEqual(
      expect.objectContaining({ tokenAccountId: "sol.omft.near", destinationAddress: ME }),
    );
  });

  it("registers the NEAR account with the omft contract (D-316)", async () => {
    const send = vi.fn(async () => ({}));
    vi.mocked(useLoginWallet).mockReturnValue({
      connection: { chainKind: "near", address: ME },
    } as never);
    vi.mocked(useSendTransactionAs).mockReturnValue(send);
    mockPreflight.mockRejectedValueOnce(
      new WithdrawDestinationUnusableError("not-registered", ME, "sol.omft.near"),
    );
    openSol({ isRealRoute: () => true });
    fireEvent.click(screen.getByRole("button", { name: "NEAR" }));
    fireEvent.click(screen.getByRole("button", { name: "Use my wallet" }));
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "0.5" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    });
    expect(readRegistrationCost).toHaveBeenCalledWith("sol.omft.near");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Register this account" }));
    });
    expect(registerNearDestination).toHaveBeenCalledWith(
      expect.objectContaining({ send, tokenAccountId: "sol.omft.near", accountId: ME }),
    );
    vi.mocked(useSendTransactionAs).mockReturnValue(null);
  });

  it("holds an amount under the bridge floor only on the bridge route", () => {
    openSol();
    // 0.001 SOL: under Solana's 0.001264 floor (fee + minimum), nothing to clear on NEAR.
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "0.001" } });
    expect(screen.getByText(/Minimum withdrawal/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "NEAR" }));
    expect(screen.queryByText(/Minimum withdrawal/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Solana" }));
    expect(screen.getByText(/Minimum withdrawal/)).toBeTruthy();
  });

  it("locks Back and Close while the destination is being checked", async () => {
    // A check that outlives its screen lands on whatever was picked next: a NEAR account cleared
    // for a withdrawal the user has since routed to the bridge.
    let release: () => void = () => {};
    mockPreflight.mockReturnValueOnce(new Promise<void>((r) => { release = r; }));
    openSol({ isRealRoute: () => true });
    fireEvent.click(screen.getByRole("button", { name: "NEAR" }));
    fireEvent.change(screen.getByLabelText("Destination address"), { target: { value: ME } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "0.5" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    });
    expect((screen.getByRole("button", { name: "Back" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => release());
    expect((screen.getByRole("button", { name: "Back" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("refuses intents.near as the NEAR destination", () => {
    openSol();
    fireEvent.click(screen.getByRole("button", { name: "NEAR" }));
    fireEvent.change(screen.getByLabelText("Destination address"), {
      target: { value: "intents.near" },
    });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "0.5" } });
    expect(screen.getByText(/is a contract that can't receive this withdrawal/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it("refuses the token contract itself as the NEAR destination", () => {
    openSol();
    fireEvent.click(screen.getByRole("button", { name: "NEAR" }));
    fireEvent.change(screen.getByLabelText("Destination address"), {
      target: { value: "sol.omft.near" },
    });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "0.5" } });
    expect(screen.getByText(/That is the token's contract, not an account/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled
    ).toBe(true);
  });
});

// D-483: Withdraw lists only what is held; the search shows up past 6 assets.
describe("WithdrawalModal — asset search", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    localStorage.clear();
  });

  // One available token per asset group, so `n` ids make `n` rows.
  const heldIds = (n: number) => {
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const tk of tokenRegistry) {
      const key = tk.assetName ?? tk.symbol;
      if (!isTokenAvailable(tk.id) || seen.has(key)) continue;
      seen.add(key);
      ids.push(tk.id);
      if (ids.length === n) break;
    }
    return ids;
  };
  const hold = (ids: string[]) => {
    mockBalance.mockReturnValue(new Map(ids.map((id) => [id, 10])));
    mockPrices.mockReturnValue({ prices: Object.fromEntries(ids.map((id) => [id, { usdPrice: 1 }])) });
  };

  it("with 6 assets there is no search", () => {
    hold(heldIds(6));
    renderModal();
    expect(screen.getAllByRole("listitem")).toHaveLength(6);
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  it("with 7 it searches by symbol or name, and says when nothing matches", () => {
    const ids = heldIds(7);
    hold(ids);
    renderModal();
    expect(screen.getAllByRole("listitem")).toHaveLength(7);
    const first = tokenRegistry.find((tk) => tk.id === ids[0])!;
    const ticker = first.symbol.split("(")[0].trim();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search asset…" }), { target: { value: ticker } });
    expect(screen.getAllByRole("listitem").length).toBeLessThan(7);
    expect(screen.getAllByRole("listitem").some((li) => li.querySelector("p")?.textContent === ticker)).toBe(true);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzz" } });
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.getByText("No assets found")).toBeTruthy();
  });

  // D-487: jsdom has no layout, so the sheet's measured height is stubbed.
  it("keeps the sheet's full-list height while filtering, and lets go past step 1", () => {
    const spy = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("role") === "dialog" ? 520 : 0;
    });
    onTestFinished(() => spy.mockRestore());
    const ids = heldIds(7);
    hold(ids);
    renderModal();
    const sheet = screen.getByRole("dialog");
    expect(sheet.style.minHeight).toBe("min(520px, 85dvh)");

    const ticker = tokenRegistry.find((tk) => tk.id === ids[0])!.symbol.split("(")[0].trim();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: ticker } });
    expect(sheet.style.minHeight).toBe("min(520px, 85dvh)");

    fireEvent.click(screen.getAllByRole("listitem")[0].querySelector("button")!);
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(sheet.style.minHeight).toBe("");
  });
});

// D-387 (b): a Bitcoin address read off a QR code is all uppercase. The step lowercases it once,
// and that lowercase form is what the field, the fee, the review step and the confirm carry.
describe("WithdrawalModal — uppercase bech32 from a QR code (D-387 b)", () => {
  const BTC = "nep141:btc.omft.near";
  const BTC_P2WPKH = "bc1q7sp49suxx62yeqa0lq0vx8ngwvhkc0v7wm7sd8";

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    localStorage.clear();
  });

  function openBtc(props: Partial<React.ComponentProps<typeof WithdrawalModal>> = {}) {
    mockBalance.mockReturnValue(new Map([[BTC, 1]]));
    mockPrices.mockReturnValue({ prices: { [BTC]: { usdPrice: 60000 } } });
    mockFee.mockResolvedValue(feeResult({ feeRaw: "1000", source: "live" }));
    renderModal(props);
    pickSingleNetworkToken("BTC");
  }

  it("signs, quotes and shows the lowercase form of an all-uppercase address", async () => {
    const onConfirmed = vi.fn();
    openBtc({ isRealRoute: () => true, onConfirmed });
    fireEvent.change(screen.getByLabelText("Destination address"), {
      target: { value: BTC_P2WPKH.toUpperCase() },
    });
    expect((screen.getByLabelText("Destination address") as HTMLInputElement).value).toBe(BTC_P2WPKH);
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "0.01" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    });

    expect(mockFee).toHaveBeenCalledWith(expect.objectContaining({ destinationAddress: BTC_P2WPKH }));
    expect(screen.getByText(`${BTC_P2WPKH.slice(0, 8)}…${BTC_P2WPKH.slice(-6)}`)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm withdrawal" }));
    });
    expect(onConfirmed).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: "btc:mainnet", address: BTC_P2WPKH })
    );
  });

  it("keeps a mixed-case address as typed and refuses it", () => {
    openBtc();
    const mixed = "B" + BTC_P2WPKH.slice(1);
    fireEvent.change(screen.getByLabelText("Destination address"), { target: { value: mixed } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "0.01" } });
    expect((screen.getByLabelText("Destination address") as HTMLInputElement).value).toBe(mixed);
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("warns that a Bitcoin Cash address can pass for a Bitcoin one (D-387 c)", () => {
    openBtc();
    expect(screen.getByText(/^Bitcoin Cash addresses can look the same as Bitcoin ones/)).toBeTruthy();
  });
});

// D-579: Zcash, transparent addresses only. Open since D-580 (`omni` route); the address tests
// below still pass `isAvailable` from when the withdrawal was pending, which changes nothing now.
describe("WithdrawalModal — Zcash (D-579)", () => {
  const ZEC = "nep141:zec.omft.near";

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    localStorage.clear();
  });
  // A real mainnet t1 (Blockchair `zcash/outputs`, 2026-11-11), as in address-validation.test.ts.
  const ZEC_T1 = "t1KbKkQ7WisJF52sSepMjYokQJbkJCJ1i3C";

  function openZec() {
    mockBalance.mockReturnValue(new Map([[ZEC, 0.05]]));
    mockPrices.mockReturnValue({ prices: { [ZEC]: { usdPrice: 1000 } } });
    mockFee.mockResolvedValue(feeResult({ feeRaw: "47000", source: "live" }));
    renderModal({ isAvailable: () => true });
    pickSingleNetworkToken("ZEC");
  }

  // Opened by D-580: the row is selectable with the shipped allowlist (no `isAvailable` override).
  it("offers ZEC to withdraw", () => {
    mockBalance.mockReturnValue(new Map([[ZEC, 0.05]]));
    mockPrices.mockReturnValue({ prices: { [ZEC]: { usdPrice: 1000 } } });
    renderModal();
    const row = screen.getAllByRole("button").find((b) => b.textContent?.includes("ZEC"));
    expect(row?.textContent).not.toContain("Not available yet");
  });

  function typeAddress(value: string) {
    fireEvent.change(screen.getByLabelText("Destination address"), { target: { value } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "0.02" } });
  }

  const continueDisabled = () =>
    (screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled;

  it("hints the transparent form and warns about Zclassic look-alikes", () => {
    openZec();
    expect(screen.getByLabelText("Destination address").getAttribute("placeholder")).toBe("t1… / t3…");
    expect(screen.getByText(/^Zclassic addresses can look the same as Zcash ones/)).toBeTruthy();
  });

  it("lets a transparent address through", () => {
    openZec();
    typeAddress(ZEC_T1);
    expect(continueDisabled()).toBe(false);
  });

  it("refuses a unified address with the transparent-only message", () => {
    openZec();
    typeAddress("u1qpatys4zruk99pg59gcscrt7y6akvl9vrhcfyhm9yxvxz7h87q6n8cgrzzpe9zru68uq39uhmlpp5uefxu0su5uqyqfe5zp3tycn0ecl");
    expect(screen.getByText(/^Only transparent Zcash addresses/)).toBeTruthy();
    expect(continueDisabled()).toBe(true);
  });

  it("refuses a one-character typo as a checksum error", () => {
    openZec();
    typeAddress(ZEC_T1.slice(0, -1) + "D");
    expect(screen.getByText(/^Invalid checksum/)).toBeTruthy();
    expect(continueDisabled()).toBe(true);
  });
});

// ── D-580: ZEC leaves straight through the Omni Bridge (`omni` route) ───────────
// Its fee is SIGNED (the Zcash gas ceiling rides in the intent), so it follows `hot-omni`'s
// rules: no registry fallback, a block without a live quote, and the quote on screen is the one
// signed. What it adds: the quote depends on the amount, the fee is a ceiling ("Up to"), what
// arrives is a floor ("at least"), and the bridge can answer "not this amount right now".
const ZEC = "nep141:zec.omft.near";
const T1 = "t1TinQZKCGaNk6ujaaaqjJUkgKKRqE8Bj8K";
const omniQuote = {
  feeRaw: "32000",
  source: "live" as const,
  omni: { gasFeeRaw: "22000", protocolFeeRaw: "10000", minAmountRaw: "100000", quotedForRaw: "500000" },
};

async function reachStep4Zec(props: Partial<React.ComponentProps<typeof WithdrawalModal>> = {}) {
  mockBalance.mockReturnValue(new Map([[ZEC, 1]]));
  mockPrices.mockReturnValue({ prices: { [ZEC]: { usdPrice: 500 } } });
  renderModal({ isAvailable: () => true, isRealRoute: () => true, ...props });
  pickSingleNetworkToken("ZEC");
  fireEvent.change(screen.getByLabelText("Destination address"), { target: { value: T1 } });
  fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "0.005" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await act(async () => {});
}

describe("WithdrawalModal — ZEC through the Omni Bridge (D-580)", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.useRealTimers();
    localStorage.clear();
  });

  it("asks the fee for the gross amount, states it as a ceiling and the net as a floor", async () => {
    mockFee.mockResolvedValue(feeResult(omniQuote));
    await reachStep4Zec();
    expect(mockFee.mock.calls[0][0]).toMatchObject({ tokenId: ZEC, amountRaw: "500000" });
    expect(screen.getByText(/^Up to 0\.00032 ZEC$/)).toBeTruthy();
    expect(screen.getByText("You'll receive at least")).toBeTruthy();
    expect(screen.getByText("0.00468 ZEC")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Confirm withdrawal" }).hasAttribute("disabled")
    ).toBe(false);
  });

  it("signs the quote on screen, handing over the Omni detail and no HOT one", async () => {
    const onConfirmed = vi.fn();
    mockFee.mockResolvedValue(feeResult(omniQuote));
    await reachStep4Zec({ onConfirmed });
    const callsAfterMount = mockFee.mock.calls.length;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm withdrawal" }));
    });
    expect(mockFee.mock.calls.length).toBe(callsAfterMount);
    expect(onConfirmed).toHaveBeenCalledWith(
      expect.objectContaining({ tokenId: ZEC, omniFee: omniQuote.omni, hotFee: undefined })
    );
  });

  it("blocks with no figures when the live quote cannot be had", async () => {
    mockFee.mockResolvedValue({ quote: null, omniInsufficientUtxo: false });
    await reachStep4Zec();
    expect(screen.queryByText(/0\.00032/)).toBeNull();
    expect(screen.getAllByText("—").length).toBe(2);
    expect(screen.getByText(/couldn't get the current network fee/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Confirm withdrawal" }).hasAttribute("disabled")
    ).toBe(true);
  });

  it("says the amount cannot be sent right now when the bridge is short of coins", async () => {
    mockFee.mockResolvedValue({ quote: null, omniInsufficientUtxo: true });
    await reachStep4Zec();
    expect(screen.getByText(/can't be sent to Zcash right now/)).toBeTruthy();
    expect(screen.queryByText(/couldn't get the current network fee/)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Confirm withdrawal" }).hasAttribute("disabled")
    ).toBe(true);
  });

  it("keeps the quote young on a timer, and refuses one that aged out", async () => {
    vi.useFakeTimers();
    const onConfirmed = vi.fn();
    mockFee.mockResolvedValue(feeResult(omniQuote));
    await reachStep4Zec({ onConfirmed });
    expect(mockFee).toHaveBeenCalledTimes(1);
    mockFee.mockResolvedValue({ quote: null, omniInsufficientUtxo: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mockFee.mock.calls.length).toBeGreaterThan(1);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm withdrawal" }));
    });
    expect(onConfirmed).not.toHaveBeenCalled();
    expect(screen.getByText(/couldn't get the current network fee/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Confirm withdrawal" }).hasAttribute("disabled")
    ).toBe(true);
  });

  // The main safety rule: a "no" from the bridge on ANY tick must stop the quote in hand from
  // being signed — not only on the first one.
  it("blocks a quote already on screen when a refresh says the bridge cannot pay out", async () => {
    vi.useFakeTimers();
    const onConfirmed = vi.fn();
    mockFee.mockResolvedValue(feeResult(omniQuote));
    await reachStep4Zec({ onConfirmed });
    mockFee.mockResolvedValue({ quote: null, omniInsufficientUtxo: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(screen.getByText(/can't be sent to Zcash right now/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Confirm withdrawal" }).hasAttribute("disabled")
    ).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm withdrawal" }));
    });
    expect(onConfirmed).not.toHaveBeenCalled();

    // …and a later good quote lifts it.
    mockFee.mockResolvedValue(feeResult(omniQuote));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(screen.queryByText(/can't be sent to Zcash right now/)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Confirm withdrawal" }).hasAttribute("disabled")
    ).toBe(false);
  });

  it("states no registry fee when the route is not live (D-263's rule, on omni)", async () => {
    mockFee.mockResolvedValue(feeResult(omniQuote));
    await reachStep4Zec({ isRealRoute: () => false });
    expect(mockFee).not.toHaveBeenCalled();
    expect(screen.queryByText(/Up to 0\.00032/)).toBeNull();
    expect(screen.getByText(/can't price this withdrawal right now/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Confirm withdrawal" }).hasAttribute("disabled")
    ).toBe(true);
  });

  it("refuses an amount under the bridge's live minimum, not only the registry's", async () => {
    mockFee.mockResolvedValue(
      feeResult({ ...omniQuote, omni: { ...omniQuote.omni, minAmountRaw: "600000" } })
    );
    await reachStep4Zec();
    expect(screen.getByText(/Withdraw at least 0\.00600000 ZEC/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Confirm withdrawal" }).hasAttribute("disabled")
    ).toBe(true);
  });
});
