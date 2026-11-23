// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ConversionQuote } from "@/features/bridge/lib/oneclick-conversion-quote";
import type { WithdrawConfirmParams, WithdrawConversions } from "@/features/bridge/components/withdrawal-modal";
import { shellTranslations } from "../lib/translations";

// D-392, block 020-3 — the shell's half of a Converting Withdrawal: when the modal gets the
// conversion seams, what the quote seam prices (the EXACT balance, the signer as refund
// account), and the money door (a conversion quote never reaches the mock). The money path
// itself is `run-conversion-withdraw.test.ts`; here it is a stub that records its input.

const ACCOUNT = "alice.near";
const USDT_POL = "nep245:v2_1.omni.hot.tg:137_3hpYoaLtt8MP1Z2GH1U473DMRKgr";

const state = vi.hoisted(() => ({
  real: true,
  universal: true,
  gate: true,
  /** The direct live path (`isRealWithdrawalRoute`). Off: the suite is about conversions. */
  realRoute: false,
  signer: { chain: "near", signer: { signEnvelope: () => {} } } as unknown,
  withdrawProps: null as null | Record<string, unknown>,
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("../context/language-context", () => ({ useLanguage: () => ({ lang: "en", setLang: vi.fn() }) }));
vi.mock("../context/portfolio-context", () => ({
  usePortfolio: () => ({
    portfolios: [],
    portfoliosLoading: false,
    portfoliosError: null,
    portfoliosRefreshFailed: false,
    refetchPortfolios: () => {},
    draftState: null,
    activePortfolioId: null,
    setActivePortfolioId: vi.fn(),
    setDraftState: vi.fn(),
  }),
}));
vi.mock("@/features/login-wallet", () => ({
  useLoginWallet: () => ({
    status: "connected",
    intentsAccountId: "alice.near",
    keyVerification: null,
    verifyKey: vi.fn(),
  }),
  ensureCanOperate: vi.fn(async () => {}),
  NearKeyVerificationNotice: () => null,
  WalletPicker: () => null,
}));
vi.mock("@/features/bridge", () => ({
  ReceiveModal: () => null,
  WithdrawalModal: (props: Record<string, unknown>) => {
    state.withdrawProps = props;
    return null;
  },
  usePendingWithdrawals: () => [],
  dismissWithdrawal: () => false,
}));
vi.mock("@/features/bridge/lib/withdraw-flag", () => ({
  get REAL_WITHDRAWAL_ENABLED() {
    return state.real;
  },
  get UNIVERSAL_WITHDRAWAL_ENABLED() {
    return state.universal;
  },
  isRealWithdrawalRoute: () => state.realRoute,
  isConversionRoute: vi.fn(() => state.gate),
}));
vi.mock("@/features/bridge/lib/run-real-withdraw", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/bridge/lib/run-real-withdraw")>()),
  readHeldOnVerifier: vi.fn(),
  runRealWithdraw: vi.fn(),
}));
vi.mock("@/features/bridge/lib/run-conversion-withdraw", () => ({ runConversionWithdraw: vi.fn() }));
vi.mock("@/features/bridge/lib/oneclick-conversion-quote", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/bridge/lib/oneclick-conversion-quote")>()),
  quoteConversion: vi.fn(async () => ({ ok: false, reason: "unavailable", detail: "stub" })),
}));
vi.mock("@/features/wallet/hooks/use-intents-balances", () => ({
  intentsBalancesQueryKey: (id: string) => ["intents-balances", id],
  useIntentsBalances: () => ({ data: undefined }),
}));
vi.mock("@/features/vault/hooks/use-live-signer", () => ({ useLiveSigner: () => state.signer }));
// 029 B-23: the "funds to assign" prompt reads the history route only after an answer.
vi.mock("@/features/vault/hooks/use-real-portfolio-history", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/vault/hooks/use-real-portfolio-history")>()),
  useAccountHistory: () => ({ data: undefined, isLoading: false, outOfDate: false }),
}));
vi.mock("../hooks/use-pending-unallocations", () => ({ usePendingUnallocations: () => [] }));
vi.mock("@/features/vault/hooks/use-pending-allocates", () => ({
  usePendingAllocates: () => ({ pending: [], isFetching: false }),
}));
vi.mock("../hooks/use-new-portfolio-draft", () => ({
  useNewPortfolioDraft: () => ({ draft: null, discard: () => {} }),
}));
vi.mock("../hooks/use-fundable-general-balance", () => ({
  useFundableGeneralBalance: () => ({ status: "known", fundable: false, tokenIds: [], usd: 0 }),
}));
vi.mock("./dashboard-header", () => ({ DashboardHeader: () => null }));
vi.mock("./sub-nav", () => ({ SubNav: () => null }));
vi.mock("./unsaved-changes-modal", () => ({ UnsavedChangesModal: () => null }));
vi.mock("./portfolio-tabs", () => ({ PortfolioTabs: () => null }));
vi.mock("./new-portfolio-draft-view", () => ({ NewPortfolioDraftView: () => null }));
vi.mock("./intents-account-view", () => ({ IntentsAccountView: () => null }));
vi.mock("./create-portfolio-flow", () => ({ CreatePortfolioFlow: () => null }));

import { DashboardShell } from "./dashboard-shell";
import { mockContract } from "@/features/intents-account/mock-contract";
import { readHeldOnVerifier, runRealWithdraw } from "@/features/bridge/lib/run-real-withdraw";
import { runConversionWithdraw } from "@/features/bridge/lib/run-conversion-withdraw";
import { quoteConversion } from "@/features/bridge/lib/oneclick-conversion-quote";
import { ensureCanOperate } from "@/features/login-wallet";
import { RealWithdrawUnconfirmedError } from "@/features/bridge/lib/run-real-withdraw";
import { WithdrawRelayRejectedError } from "@/features/bridge/lib/withdraw-errors";
import { ConversionNotSignableError } from "@/features/bridge/lib/conversion-envelope";

const t = shellTranslations.en;
const mockHeld = readHeldOnVerifier as ReturnType<typeof vi.fn>;
const mockRun = runConversionWithdraw as ReturnType<typeof vi.fn>;
const mockQuote = quoteConversion as ReturnType<typeof vi.fn>;

const QUOTE: ConversionQuote = {
  originTokenId: USDT_POL,
  deliveryTokenId: "nep141:usdt.tether-token.near",
  chainId: "near:mainnet",
  destinationAsset: "nep141:usdt.tether-token.near",
  recipient: "bob.near",
  refundTo: ACCOUNT,
  depositAddress: "a".repeat(64),
  amountInRaw: "5000000",
  amountOutRaw: "4999000",
  minAmountOutRaw: "4974005",
  withdrawFeeRaw: "0",
  createsTokenAccount: false,
  refundFeeRaw: "0",
  slippageBps: 50,
  requestedDeadlineMs: 0,
  quoteDeadlineMs: 0,
  timeEstimateSecs: 10,
  signature: "ed25519:sig",
  quotedAtMs: 0,
};

const confirmParams = (over: Partial<WithdrawConfirmParams> = {}): WithdrawConfirmParams => ({
  tokenId: USDT_POL,
  qty: 5,
  chainId: "near:mainnet",
  address: "bob.near",
  destinationVerified: true,
  relayGas: null,
  conversionQuote: QUOTE,
  ...over,
});

function renderShell() {
  render(
    <DashboardShell>
      <div />
    </DashboardShell>
  );
  return state.withdrawProps as {
    conversions?: WithdrawConversions;
    onConfirmed: (p: WithdrawConfirmParams) => Promise<void>;
  };
}

beforeEach(() => {
  state.real = true;
  state.universal = true;
  state.gate = true;
  state.realRoute = false;
  state.signer = { chain: "near", signer: { signEnvelope: () => {} } };
  state.withdrawProps = null;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

describe("DashboardShell — when the modal gets the conversion seams", () => {
  it("both flags and a signer: it does", () => {
    expect(renderShell().conversions).toBeDefined();
  });

  it("either flag off, or no signer: it does not — the modal is today's screen", () => {
    for (const setup of [
      () => (state.universal = false),
      () => (state.real = false),
      () => (state.signer = null),
    ]) {
      setup();
      expect(renderShell().conversions).toBeUndefined();
      cleanup();
      state.real = true;
      state.universal = true;
      state.signer = { chain: "near", signer: { signEnvelope: () => {} } };
    }
  });
});

describe("DashboardShell — the conversion quote seam", () => {
  it("prices the EXACT balance for a float Max, with the signer as refund account", async () => {
    // USDT on BSC has 18 decimals: the float a "Max" puts in the field (1.2345678901234568)
    // lands a few base units off the raw balance, and C1 would refuse that at the click (D-303).
    const USDT_BSC = "nep245:v2_1.omni.hot.tg:56_2CMMyVTGZkeyNZTSvS5sarzfir6g";
    mockHeld.mockResolvedValue(BigInt("1234567890123456789"));
    const { conversions } = renderShell();
    await conversions!.quote({
      originTokenId: USDT_BSC,
      chainId: "near:mainnet",
      qty: 1.234567890123456789,
      recipient: "bob.near",
      relayGas: null,
    });
    expect(mockHeld).toHaveBeenCalledWith(ACCOUNT, USDT_BSC);
    expect(mockQuote).toHaveBeenCalledWith(
      expect.objectContaining({ amountRaw: "1234567890123456789", refundTo: ACCOUNT, recipient: "bob.near" })
    );
  });

  // D-589 block 5: what was typed leaves the balance — the conversion and the relay's gas — and the
  // quote is what gets signed, so 1Click is asked for the rest.
  it("asks 1Click for the amount typed minus the sending cost, capped to the balance first", async () => {
    mockHeld.mockResolvedValue(BigInt("5000000"));
    const { conversions } = renderShell();
    await conversions!.quote({
      originTokenId: USDT_POL,
      chainId: "near:mainnet",
      qty: 5,
      recipient: "bob.near",
      relayGas: { tokenId: USDT_POL, amount: BigInt(6000) },
    });
    expect(mockQuote).toHaveBeenCalledWith(expect.objectContaining({ amountRaw: "4994000" }));
  });

  it("an amount the sending cost eats whole is below the minimum, and 1Click is not asked", async () => {
    mockHeld.mockResolvedValue(BigInt("5000000"));
    const { conversions } = renderShell();
    const result = await conversions!.quote({
      originTokenId: USDT_POL,
      chainId: "near:mainnet",
      qty: 0.006,
      recipient: "bob.near",
      relayGas: { tokenId: USDT_POL, amount: BigInt(6000) },
    });
    expect(result).toEqual({ ok: false, reason: "below-minimum", minAmountRaw: "1" });
    expect(mockQuote).not.toHaveBeenCalled();
  });

  it("a sending cost priced in another token is refused before 1Click is asked", async () => {
    mockHeld.mockResolvedValue(BigInt("5000000"));
    const { conversions } = renderShell();
    const result = await conversions!.quote({
      originTokenId: USDT_POL,
      chainId: "near:mainnet",
      qty: 5,
      recipient: "bob.near",
      relayGas: { tokenId: "nep141:usdt.tether-token.near", amount: BigInt(6000) },
    });
    expect(result).toMatchObject({ ok: false, reason: "unavailable" });
    expect(mockQuote).not.toHaveBeenCalled();
  });

  it("an amount clearly above the balance is refused before 1Click is asked", async () => {
    mockHeld.mockResolvedValue(BigInt("1000000"));
    const { conversions } = renderShell();
    await expect(
      conversions!.quote({ originTokenId: USDT_POL, chainId: "near:mainnet", qty: 5, recipient: "bob.near", relayGas: null })
    ).rejects.toThrow(/more than the balance/);
    expect(mockQuote).not.toHaveBeenCalled();
  });
});

describe("DashboardShell — the conversion money door", () => {
  it("🔴 a conversion quote off the live route is refused, and never reaches the mock", async () => {
    state.gate = false;
    const mockWithdraw = vi.spyOn(mockContract, "withdraw");
    const { onConfirmed } = renderShell();
    await expect(onConfirmed(confirmParams())).rejects.toThrow(/Nothing was signed/);
    expect(mockRun).not.toHaveBeenCalled();
    expect(mockWithdraw).not.toHaveBeenCalled();
  });

  it("a quote for another withdrawal than the one confirmed is refused", async () => {
    const { onConfirmed } = renderShell();
    await expect(onConfirmed(confirmParams({ address: "mallory.near" }))).rejects.toThrow(/does not match/);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("checks the key, then runs exactly that quote; resolves once published", async () => {
    mockRun.mockImplementation(async (p: { onRecordId: (id: string) => void; onStage: (s: string) => void }) => {
      p.onRecordId("rec-1");
      p.onStage("publishing");
      return new Promise(() => {}); // still converting
    });
    const { onConfirmed } = renderShell();
    await act(async () => {
      await onConfirmed(confirmParams());
    });
    expect(ensureCanOperate).toHaveBeenCalled();
    expect(mockRun).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: ACCOUNT, quote: QUOTE, qty: 5, relayGas: null })
    );
    expect(screen.getByText(t.withdrawalConvertingToast.replace("{qty}", "5.00").replace("{symbol}", "USDT(POL)").replace("{chain}", "NEAR"))).toBeTruthy();
    const row = mockContract.getTrackedWithdrawals(ACCOUNT).find((w) => w.intentId === "rec-1");
    expect(row).toMatchObject({ deliveryTokenId: QUOTE.deliveryTokenId, depositAddress: QUOTE.depositAddress, isReal: true });
  });

  it("hands the runner the sending cost the screen confirmed with the quote", async () => {
    mockRun.mockImplementation(async (p: { onRecordId: (id: string) => void; onStage: (s: string) => void }) => {
      p.onRecordId("rec-g");
      p.onStage("publishing");
      return new Promise(() => {});
    });
    const relayGas = { tokenId: USDT_POL, amount: BigInt(6000) };
    const { onConfirmed } = renderShell();
    await act(async () => {
      await onConfirmed(confirmParams({ relayGas }));
    });
    expect(mockRun).toHaveBeenCalledWith(expect.objectContaining({ quote: QUOTE, relayGas }));
  });

  // The Converting row shows the NEAR settlement hash while 1Click converts (operator, 2026-11-19).
  it("a settled conversion keeps its NEAR hash on the Converting row", async () => {
    mockRun.mockImplementation(
      async (p: { onRecordId: (id: string) => void; onStage: (s: string) => void; onSettled: (h: string) => void }) => {
        p.onRecordId("rec-s");
        p.onStage("publishing");
        p.onSettled("NEARTX");
        p.onStage("converting");
        return new Promise(() => {}); // still converting
      }
    );
    const { onConfirmed } = renderShell();
    await act(async () => {
      await onConfirmed(confirmParams());
    });
    const row = mockContract.getTrackedWithdrawals(ACCOUNT).find((w) => w.intentId === "rec-s");
    expect(row).toMatchObject({ status: "SETTLED", txHash: "NEARTX" });
  });

  it("a refund closes the row as REFUNDED and says the money is back", async () => {
    mockRun.mockImplementation(async (p: { onRecordId: (id: string) => void; onStage: (s: string) => void }) => {
      p.onRecordId("rec-2");
      p.onStage("publishing");
      return { recordId: "rec-2", intentHash: "h", txHash: "tx", amount: "5000000", outcome: { kind: "refunded", refundedAmountRaw: "5000000" } };
    });
    const { onConfirmed } = renderShell();
    await act(async () => {
      await onConfirmed(confirmParams());
    });
    const row = mockContract.getTrackedWithdrawals(ACCOUNT).find((w) => w.intentId === "rec-2");
    expect(row?.status).toBe("REFUNDED");
    expect(screen.getByText(t.withdrawalRefundedToast.replace("{qty}", "5.00").replace("{symbol}", "USDT(POL)"))).toBeTruthy();
  });

  it("🔴 the key gate refusing stops the run before anything is signed", async () => {
    (ensureCanOperate as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Verify your key first."));
    const { onConfirmed } = renderShell();
    await expect(onConfirmed(confirmParams())).rejects.toThrow(/Verify your key/);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("🔴 a pair that only leaves by conversion, arriving without a quote, is refused — never the mock", async () => {
    const mockWithdraw = vi.spyOn(mockContract, "withdraw");
    const { onConfirmed } = renderShell();
    await expect(onConfirmed(confirmParams({ conversionQuote: undefined }))).rejects.toThrow(
      /needs a conversion quote/
    );
    expect(mockRun).not.toHaveBeenCalled();
    expect(mockWithdraw).not.toHaveBeenCalled();
  });
});

// Cross-review 020-4: which of the two the shell picks decides whether a retry is safe. Swapped,
// a published transfer would read "not sent, balance unchanged" and invite a second withdrawal.
describe("DashboardShell — a conversion that does not finish", () => {
  const notCompleted = t.withdrawalNotCompletedToast.replace("{qty}", "5.00").replace("{symbol}", "USDT(POL)");
  const unconfirmed = t.withdrawalUnconfirmedToast
    .replace("{qty}", "5.00")
    .replace("{symbol}", "USDT(POL)")
    .replace("{chain}", "NEAR");

  it("refused untouched (the relay said no): rejects, so the modal stays open, and the row is FAILED", async () => {
    mockRun.mockImplementation(async (p: { onRecordId: (id: string) => void }) => {
      p.onRecordId("rec-f");
      throw new WithdrawRelayRejectedError("NONCE_USED", "nonce used");
    });
    const { onConfirmed } = renderShell();
    let outcome: unknown = "resolved";
    await act(async () => {
      outcome = await onConfirmed(confirmParams()).catch((e: unknown) => e);
    });
    expect(outcome).toBeInstanceOf(WithdrawRelayRejectedError);
    const row = mockContract.getTrackedWithdrawals(ACCOUNT).find((w) => w.intentId === "rec-f");
    expect(row?.status).toBe("FAILED");
    expect(screen.getByText(notCompleted)).toBeTruthy();
    expect(screen.queryByText(unconfirmed)).toBeNull();
  });

  it.each([
    ["the publish never answered", "unknown", false],
    ["published, then no final answer", "left-balance", true],
  ] as const)("%s: resolves, the row is UNCONFIRMED — never FAILED, never 'not completed'", async (_l, fundsState, staged) => {
    mockRun.mockImplementation(async (p: { onRecordId: (id: string) => void; onStage: (s: string) => void }) => {
      p.onRecordId("rec-u");
      if (staged) p.onStage("publishing");
      throw new RealWithdrawUnconfirmedError("no answer", fundsState, "rec-u", null, null);
    });
    const { onConfirmed } = renderShell();
    await act(async () => {
      await expect(onConfirmed(confirmParams())).resolves.toBeUndefined();
    });
    const row = mockContract.getTrackedWithdrawals(ACCOUNT).find((w) => w.intentId === "rec-u");
    expect(row?.status).toBe("UNCONFIRMED");
    expect(screen.getByText(unconfirmed)).toBeTruthy();
    expect(screen.queryByText(notCompleted)).toBeNull();
  });

  it("a stale quote refused at the click rejects with no toast: step 4 is re-pricing, not failing", async () => {
    mockRun.mockRejectedValue(new ConversionNotSignableError("quote-expiring", "expiring"));
    const { onConfirmed } = renderShell();
    await act(async () => {
      await expect(onConfirmed(confirmParams())).rejects.toBeInstanceOf(ConversionNotSignableError);
    });
    expect(screen.queryByText(notCompleted)).toBeNull();
  });
});

// D-584: the direct path for an `omft` token. Settled and handed to a bridge nobody can watch: the
// row closes as SENT and the toast says it can take a few minutes — never "delivered".
describe("DashboardShell — an omft withdrawal handed to the bridge", () => {
  const BTC = "nep141:btc.omft.near";
  const mockDirect = runRealWithdraw as ReturnType<typeof vi.fn>;

  it("closes the row as SENT with the hand-off toast, and never says delivered", async () => {
    state.gate = false;
    state.realRoute = true;
    mockDirect.mockImplementation(async (p: { onRecordId: (id: string) => void; onStage: (s: string) => void }) => {
      p.onRecordId("rec-btc");
      p.onStage("publishing");
      return {
        recordId: "rec-btc",
        intentHash: "h",
        txHash: "NEARTX",
        route: "omft",
        amount: "10000",
        delivery: { kind: "bridge-handoff", chain: "btc:mainnet" },
      };
    });
    const { onConfirmed } = renderShell();
    await act(async () => {
      await onConfirmed(
        confirmParams({ tokenId: BTC, qty: 0.0001, chainId: "btc:mainnet", address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", conversionQuote: undefined })
      );
    });

    expect(mockDirect).toHaveBeenCalledOnce();
    const row = mockContract.getTrackedWithdrawals(ACCOUNT).find((w) => w.intentId === "rec-btc");
    expect(row).toMatchObject({ status: "SENT", txHash: "NEARTX" });
    expect(screen.getByText(/can take a few minutes to arrive/)).toBeTruthy();
    expect(screen.queryByText(/Withdrawal delivered/)).toBeNull();
  });
});
