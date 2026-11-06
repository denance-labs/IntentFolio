// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { RealAllocateUnconfirmedError } from "@/features/vault/lib/run-real-allocate";
import { AmountExceedsBalanceError } from "@/features/vault/lib/base-units";
import { RealChangeSetInvalidError } from "@/features/vault/lib/vault-errors";
import { shellTranslations } from "@/features/dashboard-shell/lib/translations";
import { translations } from "../lib/translations";

// D-298 / D-304(b), funding a real portfolio. Same contract as `preset-review-modal`:
// an unconfirmed Allocate ends the modal (a second click must never sign the same funds
// again); an amount above the balance signed nothing and keeps the retry open.

const state = vi.hoisted(() => ({
  lang: "en" as "en" | "es",
  allocateInto: vi.fn(),
  relaySends: false,
  vaultLive: false,
  stage: null as null | string,
  // D-356: the account's Allocates still in transit, as the My Account banner reads them.
  pending: undefined as undefined | Array<{ id: string; op: string; portfolioId: string | null }>,
}));

vi.mock("@/features/login-wallet", () => ({
  useLoginWallet: () => ({ intentsAccountId: "alice.near" }),
}));
vi.mock("@/features/vault/hooks/use-pending-allocates", () => ({
  usePendingAllocates: (signerId: string | null) => ({ pending: signerId ? state.pending : undefined, isFetching: false }),
}));

// The vault's pre-check (017-9b) is pinned per test; its reads are covered in vault-precheck.test.ts.
const precheck = vi.hoisted(() => ({ block: null as null | { reason: "unavailable" } | { reason: "token-frozen"; tokenId: string }, ops: [] as unknown[] }));
vi.mock("@/features/vault/hooks/use-vault-precheck", () => ({
  useVaultPrecheck: (op: unknown) => {
    precheck.ops.push(op);
    return op ? precheck.block : null;
  },
}));

vi.mock("@/features/dashboard-shell/context/language-context", () => ({
  useLanguage: () => ({ lang: state.lang, setLang: vi.fn() }),
}));
vi.mock("@/features/dashboard-shell/context/portfolio-context", () => ({
  usePortfolio: () => ({
    allocateIntoPortfolio: state.allocateInto,
    realAllocateStage: state.stage,
    relaySends: state.relaySends,
    vaultLive: state.vaultLive,
    activePortfolioId: "p-1",
    setupSigner: { accountId: "alice.near", loginAddress: "alice.near" },
  }),
}));
vi.mock("@/features/market/hooks/use-token-prices", async () => {
  // Every registry token priced LIVE at the registry's figure (the Storage Cost refuses a
  // fallback, D-528) — the same number the modal reads from its `prices` prop's fallback.
  const { tokenRegistry } = await vi.importActual<typeof import("@/features/market/lib/token-registry")>(
    "@/features/market/lib/token-registry"
  );
  const prices = Object.fromEntries(
    tokenRegistry.map((t) => [t.id, { symbol: t.symbol, usdPrice: t.fallbackUsdPrice, updatedAt: "", source: "chaindefuser" }])
  );
  return { useTokenPrices: () => ({ prices, isLoading: false }) };
});

import { AddFundsModal } from "./add-funds-modal";

async function clickPrimary(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}


// ── D-321: edit mode on a REAL portfolio signs the funds in right away (013.plan P5/P6/P3) ──

const USDC_ETH = "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near";

type EditOpts = {
  lang?: "en" | "es";
  real?: boolean;
  balanceLoading?: boolean;
  onRetryBalance?: () => void;
  withDeposit?: boolean;
  blockedByDraft?: boolean;
  existingBalances?: Record<string, number>;
  compositionTokenIds?: string[];
  available?: Map<string, number>;
  defaultTolerancePct?: number;
  onFunded?: (credited: Array<{ tokenId: string; qty: number }>) => void;
};

function renderEdit(opts: EditOpts = {}) {
  const lang = opts.lang ?? "en";
  const calls = {
    onClose: vi.fn(),
    onAllocate: vi.fn(),
    onDeposit: vi.fn(),
    onFunded: vi.fn(opts.onFunded),
  };
  const el = (available: Map<string, number>) => (
    <AddFundsModal
      t={translations[lang]}
      available={available}
      existingBalances={opts.existingBalances ?? {}}
      compositionTokenIds={opts.compositionTokenIds ?? []}
      prices={{}}
      onClose={calls.onClose}
      onAllocate={calls.onAllocate}
      balanceLoading={opts.balanceLoading}
      onRetryBalance={opts.onRetryBalance}
      onDeposit={opts.withDeposit ? calls.onDeposit : undefined}
      realFunding={
        opts.real === false
          ? undefined
          : {
              blockedByDraft: opts.blockedByDraft ?? false,
              defaultTolerancePct: opts.defaultTolerancePct ?? 5,
              onFunded: calls.onFunded,
            }
      }
    />
  );
  const { rerender } = render(el(opts.available ?? new Map([["near", 5]])));
  return { ...calls, rerenderWith: (available: Map<string, number>) => rerender(el(available)) };
}

function typeNear(lang: "en" | "es", value: string) {
  fireEvent.change(screen.getByLabelText(`NEAR ${translations[lang].withdrawAmount}`), {
    target: { value },
  });
}

function rowOf(symbol: string): HTMLElement {
  const row = screen
    .getAllByRole("listitem")
    .find((li) => li.querySelector("p")?.textContent === symbol);
  if (!row) throw new Error(`no row for ${symbol}`);
  return row;
}

describe.each(["en", "es"] as const)("AddFundsModal (edit, real portfolio) — %s", (lang) => {
  const t = translations[lang];
  const shellT = shellTranslations[lang];

  beforeEach(() => {
    state.lang = lang;
    state.allocateInto.mockReset();
  });
  afterEach(cleanup);

  it("signs the funds in right away, with a new token joining at 0%, and never touches the draft", async () => {
    state.allocateInto.mockResolvedValue({ recordId: "r", txHash: "T", credited: [{ tokenId: "near", qty: 2 }] });
    const calls = renderEdit({ lang });
    typeNear(lang, "2");

    await clickPrimary(t.addTokensSignAndAdd);

    expect(state.allocateInto).toHaveBeenCalledWith({
      allocations: [{ tokenId: "near", qty: 2 }],
      tokenAdditions: [{ tokenId: "near", tolerancePct: 5 }],
    });
    expect(calls.onFunded).toHaveBeenCalledWith([{ tokenId: "near", qty: 2 }]);
    expect(calls.onClose).toHaveBeenCalled();
    expect(calls.onAllocate).not.toHaveBeenCalled();
  });

  it("does not re-add a token that is already in the composition", async () => {
    state.allocateInto.mockResolvedValue({ recordId: "r", txHash: "T", credited: [] });
    renderEdit({ lang, compositionTokenIds: ["near"] });
    typeNear(lang, "2");
    await clickPrimary(t.addTokensSignAndAdd);
    expect(state.allocateInto.mock.calls[0][0].tokenAdditions).toEqual([]);
  });

  // D-529: only a funded token joins the composition here; new targets are "Add tokens"' job.
  it("signs exactly the funds, and adds to the composition only the funded tokens outside it", async () => {
    state.allocateInto.mockResolvedValue({ recordId: "r", txHash: "T", credited: [] });
    renderEdit({ lang, compositionTokenIds: ["near"], available: new Map([["near", 5], [USDC_ETH, 10]]) });
    typeNear(lang, "2");
    fireEvent.change(screen.getByLabelText(`USDC(ETH) ${t.withdrawAmount}`), { target: { value: "3" } });
    await clickPrimary(t.addTokensSignAndAdd);
    expect(state.allocateInto).toHaveBeenCalledWith({
      // In the list's order: by value, $10 of USDC(ETH) above $7.90 of NEAR.
      allocations: [
        { tokenId: USDC_ETH, qty: 3 },
        { tokenId: "near", qty: 2 },
      ],
      tokenAdditions: [{ tokenId: USDC_ETH, tolerancePct: 5 }],
    });
  });

  it("with no amount typed there is nothing to sign", () => {
    renderEdit({ lang });
    expect((screen.getByRole("button", { name: t.addTokensApply }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("an unsaved draft blocks signing, and says so (P6)", () => {
    renderEdit({ lang, blockedByDraft: true });
    expect(document.body.textContent).toContain(t.addTokensDraftBlocked);
    typeNear(lang, "2");
    const primary = screen.getByRole("button", { name: t.addTokensSignAndAdd }) as HTMLButtonElement;
    expect(primary.disabled).toBe(true);
  });

  it("warns that adding to a token already held restarts its withdrawal wait (P3)", () => {
    renderEdit({ lang, existingBalances: { near: 1 }, compositionTokenIds: ["near"] });
    expect(document.body.textContent).not.toContain(t.addTokensMaturityRestartNoTime.split("{")[0]);
    typeNear(lang, "2");
    const line = t.addTokensMaturityRestartNoTime.replace("{tokens}", "NEAR");
    expect(document.body.textContent).toContain(line);
  });

  it("no restart warning for a token the portfolio does not hold yet", () => {
    renderEdit({ lang });
    typeNear(lang, "2");
    expect(document.body.textContent).not.toContain(t.addTokensMaturityRestartNoTime.split("{")[0]);
  });

  it.each([
    ["vault_failed", t.realAddVaultFailedTitle, t.realAddVaultFailed],
    ["unconfirmed", shellT.realStagePendingUnconfirmedTitle, t.realAddPendingUnconfirmed],
    // D-302 h1: the portfolio was deleted before the credit; the funds go back to the General Balance.
    ["portfolio_gone", t.realAddPortfolioGoneTitle, t.realAddPortfolioGone],
  ] as const)("%s ends the modal with the top-up copy and only Close (D-298)", async (reason, title, body) => {
    state.allocateInto.mockRejectedValue(new RealAllocateUnconfirmedError("technical", "rec-1", reason));
    const calls = renderEdit({ lang });
    typeNear(lang, "2");
    await clickPrimary(t.addTokensSignAndAdd);

    const status = screen.getByRole("status");
    expect(status.textContent).toContain(title);
    expect(status.textContent).toContain(body);
    expect(status.textContent).toContain(t.realAddSeeMyAccount);
    expect(document.body.textContent).not.toContain(t.addTokensRetry);
    expect(screen.queryByRole("button", { name: t.cancel })).toBeNull();

    // The second click closes; it must not sign the same funds again.
    await clickPrimary(t.addTokensClose);
    expect(state.allocateInto).toHaveBeenCalledTimes(1);
    expect(calls.onClose).toHaveBeenCalled();
    expect(calls.onFunded).not.toHaveBeenCalled();
  });

  it("an amount above the balance: nothing signed, localized copy, retry open", async () => {
    state.allocateInto.mockRejectedValue(new AmountExceedsBalanceError(BigInt(3), BigInt(2)));
    renderEdit({ lang });
    typeNear(lang, "2");
    await clickPrimary(t.addTokensSignAndAdd);
    expect(document.body.textContent).toContain(shellT.amountExceedsBalanceTitle);
    expect(screen.getByRole("button", { name: t.addTokensRetry })).toBeDefined();
  });

  it("a pre-flight refusal shows why, and leaves retry open", async () => {
    state.allocateInto.mockRejectedValue(new RealChangeSetInvalidError("too-many-tokens", "32 held"));
    renderEdit({ lang });
    typeNear(lang, "2");
    await clickPrimary(t.addTokensSignAndAdd);
    expect(document.body.textContent).toContain(t.realChangeSetTooManyTokens);
    expect(screen.getByRole("button", { name: t.addTokensRetry })).toBeDefined();
    // D-309: not on <body>, where the disabled button left it.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: t.addTokensRetry }));
  });

  it("D-309: after a failed signature the focus lands on Retry", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    state.allocateInto.mockRejectedValue(new Error("User rejected the request"));
    renderEdit({ lang });
    typeNear(lang, "2");
    await clickPrimary(t.addTokensSignAndAdd);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: t.addTokensRetry }));
  });

  // ── Cross-review B5 / QA B4 ──

  it("while the signature is in flight, a second click signs nothing more", async () => {
    let settle!: (v: unknown) => void;
    state.allocateInto.mockReturnValue(new Promise((r) => (settle = r)));
    renderEdit({ lang });
    typeNear(lang, "2");

    await clickPrimary(t.addTokensSignAndAdd);
    const primary = screen.getByRole("button", { name: t.inFlightAwaitingSignature }) as HTMLButtonElement;
    expect(primary.disabled).toBe(true);
    await act(async () => {
      fireEvent.click(primary);
    });
    expect(state.allocateInto).toHaveBeenCalledTimes(1);

    await act(async () => settle({ recordId: "r", txHash: "T", credited: [] }));
  });

  it("while the signature is in flight, Escape and the backdrop do not close it (D-298)", async () => {
    let settle!: (v: unknown) => void;
    state.allocateInto.mockReturnValue(new Promise((r) => (settle = r)));
    const calls = renderEdit({ lang });
    typeNear(lang, "2");
    await clickPrimary(t.addTokensSignAndAdd);

    fireEvent.keyDown(document, { key: "Escape" });
    const backdrop = screen.getByRole("dialog").parentElement as HTMLElement;
    fireEvent.mouseDown(backdrop, { target: backdrop });
    expect(calls.onClose).not.toHaveBeenCalled();

    // Only the outcome ends it.
    await act(async () => settle({ recordId: "r", txHash: "T", credited: [{ tokenId: "near", qty: 2 }] }));
    expect(calls.onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape still closes it before signing", () => {
    const calls = renderEdit({ lang });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(calls.onClose).toHaveBeenCalledTimes(1);
  });

  it("a failure after the credit never offers Retry over funds already in", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    state.allocateInto.mockResolvedValue({ recordId: "r", txHash: "T", credited: [{ tokenId: "near", qty: 2 }] });
    const calls = renderEdit({
      lang,
      onFunded: () => {
        throw new Error("toast blew up");
      },
    });
    typeNear(lang, "2");
    await clickPrimary(t.addTokensSignAndAdd);
    expect(calls.onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: t.addTokensRetry })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Max on a 24-decimal balance signs the whole balance, not an 8-decimal rounding (D-315)", async () => {
    const avail = 0.7980717709871432; // fromBaseUnits(798071770987143215177784n, 24)
    state.allocateInto.mockResolvedValue({ recordId: "r", txHash: "T", credited: [] });
    renderEdit({ lang, available: new Map([["near", avail]]) });
    fireEvent.click(screen.getByRole("button", { name: t.withdrawMax }));
    await clickPrimary(t.addTokensSignAndAdd);
    expect(state.allocateInto.mock.calls[0][0].allocations).toEqual([{ tokenId: "near", qty: avail }]);
  });

  it("a token joining the composition takes the portfolio's own default tolerance", async () => {
    state.allocateInto.mockResolvedValue({ recordId: "r", txHash: "T", credited: [] });
    renderEdit({ lang, defaultTolerancePct: 7 });
    typeNear(lang, "2");
    await clickPrimary(t.addTokensSignAndAdd);
    expect(state.allocateInto.mock.calls[0][0].tokenAdditions).toEqual([{ tokenId: "near", tolerancePct: 7 }]);
  });

  it("after an unconfirmed top-up, Close still closes once the refetched balance empties the list", async () => {
    state.allocateInto.mockRejectedValue(new RealAllocateUnconfirmedError("x", "rec-1", "unconfirmed"));
    const calls = renderEdit({ lang });
    typeNear(lang, "2");
    await clickPrimary(t.addTokensSignAndAdd);
    calls.rerenderWith(new Map());
    await clickPrimary(t.addTokensClose);
    expect(calls.onClose).toHaveBeenCalledTimes(1);
    expect(state.allocateInto).toHaveBeenCalledTimes(1);
  });

  it("says a funded new token joins at a 0% target, and only for new tokens (P2)", () => {
    renderEdit({ lang });
    const note = t.addTokensZeroTargetNote.replace("{tokens}", "NEAR");
    expect(document.body.textContent).not.toContain(note);
    typeNear(lang, "2");
    expect(document.body.textContent).toContain(note);
    cleanup();

    renderEdit({ lang, compositionTokenIds: ["near"] });
    typeNear(lang, "2");
    expect(document.body.textContent).not.toContain(note);
  });

  it("names two restarted tokens as one list, not the placeholder twice (P3)", () => {
    renderEdit({
      lang,
      available: new Map([
        ["near", 5],
        [USDC_ETH, 5],
      ]),
      existingBalances: { near: 1, [USDC_ETH]: 1 },
      compositionTokenIds: ["near", USDC_ETH],
    });
    typeNear(lang, "2");
    fireEvent.change(screen.getByLabelText(`USDC(ETH) ${t.withdrawAmount}`), { target: { value: "2" } });
    const tokens = lang === "en" ? "NEAR and USDC(ETH)" : "NEAR y USDC(ETH)";
    const line = t.addTokensMaturityRestartNoTime.replace("{tokens}", tokens);
    expect(document.body.textContent).toContain(line);
  });
});

// D-529: "Add funds" only assigns what the funding account holds. New targets live in "Add tokens".
describe.each(["en", "es"] as const)("AddFundsModal (edit) — only funds (%s)", (lang) => {
  const t = translations[lang];

  beforeEach(() => {
    state.lang = lang;
    state.allocateInto.mockReset();
  });
  afterEach(cleanup);

  it("lists only the tokens the funding account holds, and none gets «Add»", () => {
    renderEdit({ lang, available: new Map([["near", 5], [USDC_ETH, 10]]), compositionTokenIds: ["near"] });
    const symbols = screen.getAllByRole("listitem").map((li) => li.querySelector("p")?.textContent);
    expect(symbols.sort()).toEqual(["NEAR", "USDC(ETH)"]);
    expect(screen.queryByRole("button", { name: t.addTokensAddAction })).toBeNull();
    expect(screen.queryByRole("button", { name: t.addTokensAdded })).toBeNull();
  });

  it("a token the portfolio holds but the funding account does not is left out", () => {
    renderEdit({ lang, existingBalances: { [USDC_ETH]: 4 }, compositionTokenIds: [USDC_ETH] });
    expect(() => rowOf("USDC(ETH)")).toThrow();
  });

  it("an empty funding account offers a Deposit, and nothing to sign", () => {
    const calls = renderEdit({ lang, available: new Map(), withDeposit: true });
    expect(document.body.textContent).toContain(t.addFundsEmpty);
    expect(document.body.textContent).not.toContain(t.noTokensFound);
    // No search over nothing: the Deposit is where the focus lands.
    expect(screen.queryByLabelText(t.searchToken)).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: t.addFundsDeposit }));
    fireEvent.click(screen.getByRole("button", { name: t.addFundsDeposit }));
    expect(calls.onDeposit).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: t.addTokensApply }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("while the funding account is still loading, it says so instead of empty", () => {
    renderEdit({ lang, available: new Map(), withDeposit: true, balanceLoading: true });
    expect(document.body.textContent).toContain(t.addFundsLoading);
    expect(document.body.textContent).not.toContain(t.addFundsEmpty);
    expect(screen.queryByRole("button", { name: t.addFundsDeposit })).toBeNull();
  });

  // D-541: an unread funding account is not an empty one — no Deposit offered for funds it may hold.
  it("when the funding account could not be read, it says so with a Retry, not empty", () => {
    const retry = vi.fn();
    renderEdit({ lang, available: new Map(), withDeposit: true, onRetryBalance: retry });
    expect(screen.getByRole("alert").textContent).toContain(t.addFundsUnreadable);
    expect(document.body.textContent).not.toContain(t.addFundsEmpty);
    expect(screen.queryByRole("button", { name: t.addFundsDeposit })).toBeNull();
    expect(screen.queryByLabelText(t.searchToken)).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: t.addFundsRetry }));
    fireEvent.click(screen.getByRole("button", { name: t.addFundsRetry }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("with funds, a link below the list deposits another token", () => {
    const calls = renderEdit({ lang, withDeposit: true });
    fireEvent.click(screen.getByRole("button", { name: t.addFundsDepositOther }));
    expect(calls.onDeposit).toHaveBeenCalledTimes(1);
  });

  it("outside the shell nothing offers a Deposit", () => {
    renderEdit({ lang, available: new Map() });
    expect(document.body.textContent).toContain(t.addFundsEmpty);
    expect(screen.queryByRole("button", { name: t.addFundsDeposit })).toBeNull();
    cleanup();
    renderEdit({ lang });
    expect(screen.queryByRole("button", { name: t.addFundsDepositOther })).toBeNull();
  });

  it("a search with no match says so, not that the account is empty", () => {
    renderEdit({ lang, withDeposit: true });
    fireEvent.change(screen.getByLabelText(t.searchToken), { target: { value: "zzz-none" } });
    expect(document.body.textContent).toContain(t.noTokensFound);
    expect(document.body.textContent).not.toContain(t.addFundsEmpty);
  });
});

describe("AddFundsModal (edit, mock portfolio) — unchanged: funds join the draft", () => {
  beforeEach(() => {
    state.lang = "en";
    state.allocateInto.mockReset();
  });
  afterEach(cleanup);

  it("applies the allocation to the draft and signs nothing", async () => {
    const calls = renderEdit({ real: false });
    typeNear("en", "2");
    await clickPrimary(translations.en.addTokensApply);
    expect(calls.onAllocate).toHaveBeenCalledWith("near", 2);
    expect(state.allocateInto).not.toHaveBeenCalled();
  });
});

// 027 A-2: the floor is one cent (it was $1, D-007). NEAR is priced at its $1.58 fallback here.
describe.each(["en", "es"] as const)("AddFundsModal (edit) — the one-cent floor (%s)", (lang) => {
  const t = translations[lang];
  const nearInput = () => screen.getByLabelText(`NEAR ${t.withdrawAmount}`);

  beforeEach(() => {
    state.lang = lang;
  });
  afterEach(cleanup);

  // D-395's "Min. $1" hint is gone: an empty field shows its USD value, as every other row does.
  it("announces no minimum on a token the portfolio does not hold", () => {
    renderEdit({ lang });
    expect(nearInput().getAttribute("aria-describedby")).toBeNull();
    expect(rowOf("NEAR").textContent).toContain("≈ $0.00");
  });

  // Operator's case 1 (s268): under $1 of a new token used to offer only "Add" as a target.
  it("lets under $1 of a new token in", () => {
    renderEdit({ lang, available: new Map([["near", 0.3]]) });
    const row = rowOf("NEAR");
    expect(within(row).getByRole("spinbutton")).toBeTruthy();
    expect(row.textContent).not.toContain(t.addTokensDustInPortfolio);
    typeNear(lang, "0.3");
    expect(within(row).queryByText(t.allocateErrorMinFunded)).toBeNull();
  });

  // Operator's case 2 (s268): $0.44 held + $0.51 available read "Less than $1 — not enough to add".
  it("lets a top-up in when the held token plus the balance stays under $1", () => {
    renderEdit({ lang, available: new Map([["near", 0.32]]), existingBalances: { near: 0.28 }, compositionTokenIds: ["near"] });
    const row = rowOf("NEAR");
    expect(within(row).getByRole("spinbutton")).toBeTruthy();
    expect(row.textContent).not.toContain(t.addTokensDustInPortfolio);
    typeNear(lang, "0.32");
    expect(within(row).queryByText(t.allocateErrorMinFunded)).toBeNull();
  });

  // D-415: 0.3 NEAR alone and the portfolio's 2 NEAR — never dust.
  it("lets a small top-up into a token the portfolio holds", () => {
    renderEdit({ lang, available: new Map([["near", 0.3]]), existingBalances: { near: 2 }, compositionTokenIds: ["near"] });
    const row = rowOf("NEAR");
    expect(within(row).getByRole("spinbutton")).toBeTruthy();
    expect(row.textContent).not.toContain(t.addTokensDustInPortfolio);
    typeNear(lang, "0.3");
    expect(within(row).queryByText(t.allocateErrorMinFunded)).toBeNull();
  });

  it("says under a cent when the held token plus the balance stays short", () => {
    renderEdit({ lang, available: new Map([["near", 0.001]]), existingBalances: { near: 0.001 }, compositionTokenIds: ["near"] });
    const row = rowOf("NEAR");
    expect(within(row).queryByRole("spinbutton")).toBeNull();
    expect(row.textContent).toContain(t.addTokensDustInPortfolio);
  });

  it("says a new token with under a cent is not enough, and offers no field (D-529: no «Add» here)", () => {
    renderEdit({ lang, available: new Map([["near", 0.003]]) }); // $0.0047
    const row = rowOf("NEAR");
    expect(within(row).queryByRole("spinbutton")).toBeNull();
    expect(within(row).queryByRole("button")).toBeNull();
    expect(row.textContent).toContain(t.addTokensDustInPortfolio);
  });

  it("errors when a typed amount leaves the line under a cent", () => {
    renderEdit({ lang });
    typeNear(lang, "0.000001");
    expect(within(rowOf("NEAR")).getByText(t.allocateErrorMinFunded)).toBeTruthy();
  });
});

// D-396: the assets with no NEAR version stay listed, marked, and cannot be chosen.
describe.each(["en", "es"] as const)("AddFundsModal (edit) — the curated catalog (%s)", (lang) => {
  const t = translations[lang];
  const DOGE = "nep141:doge.omft.near";

  beforeEach(() => {
    state.lang = lang;
  });
  afterEach(cleanup);

  it("leaves out a token outside the catalog that the funding account does not hold", () => {
    renderEdit({ lang, real: false });
    expect(() => rowOf("DOGE")).toThrow();
  });

  // D-389: in the catalog but not withdrawable yet — same label, and no field even with a
  // balance to allocate, because it cannot be added at all.
  it("marks ZEC as not available, with no field, even when held", () => {
    renderEdit({ lang, real: false, available: new Map([["near", 5], ["nep141:zec.omft.near", 10]]) });
    const zec = rowOf("ZEC");
    expect(zec.textContent).toContain(t.addTokensNotAvailableYet);
    expect(within(zec).queryByRole("button")).toBeNull();
    expect(within(zec).queryByRole("spinbutton")).toBeNull();
  });

  it("does not take a held balance of it into the portfolio, and lists it last", () => {
    renderEdit({ lang, real: false, available: new Map([["near", 5], [DOGE, 1000]]) });
    const doge = rowOf("DOGE");
    expect(within(doge).queryByRole("spinbutton")).toBeNull();
    expect(doge.textContent).toContain(t.addTokensNotAvailableYet);
    const rows = screen.getAllByRole("listitem");
    expect(rows.indexOf(doge)).toBeGreaterThan(rows.indexOf(rowOf("NEAR")));
    expect(rows.indexOf(rowOf("NEAR"))).toBe(0);
  });
});

describe("AddFundsModal — a paused relayer (017-2, D-365)", () => {
  const t = translations.en;
  const shellT = shellTranslations.en;

  beforeEach(() => {
    state.lang = "en";
    state.relaySends = true;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ paused: true })));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    state.relaySends = false;
  });

  it("blocks signing funds into a real portfolio, with the notice", async () => {
    renderEdit();
    typeNear("en", "2");

    expect(await screen.findByText(shellT.relayPausedTitle)).toBeTruthy();
    expect((screen.getByRole("button", { name: t.addTokensSignAndAdd }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("leaves a draft-only edit alone: nothing there is signed or relayed", async () => {
    const fetchMock = vi.fn(async () => Response.json({ paused: true }));
    vi.stubGlobal("fetch", fetchMock);
    renderEdit({ real: false });
    typeNear("en", "2");
    await act(async () => {});

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText(shellT.relayPausedTitle)).toBeNull();
    expect((screen.getByRole("button", { name: t.addTokensApply }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("says nothing of a pause before an amount is typed: nothing would be signed yet", async () => {
    renderEdit();
    await act(async () => {});
    expect(screen.queryByText(shellT.relayPausedTitle)).toBeNull();
  });

  it("the disabled Sign button is described by the notice", async () => {
    renderEdit();
    typeNear("en", "2");
    const notice = await screen.findByText(shellT.relayPausedTitle);
    const button = screen.getByRole("button", { name: t.addTokensSignAndAdd });
    expect(button.getAttribute("aria-describedby")).toBe(notice.parentElement?.id);
  });
});

describe("AddFundsModal — the vault would refuse (017-9b)", () => {
  const t = translations.en;
  const shellT = shellTranslations.en;

  beforeEach(() => {
    state.lang = "en";
    state.vaultLive = true;
  });
  afterEach(() => {
    cleanup();
    state.vaultLive = false;
    precheck.block = null;
    precheck.ops = [];
  });

  it("asks about the funded tokens only once funds would be signed into a real portfolio", async () => {
    renderEdit();
    expect(precheck.ops.at(-1)).toBeNull();
    typeNear("en", "2");
    expect(precheck.ops.at(-1)).toEqual({ kind: "allocate", tokenIds: ["near"] });
  });

  it("blocks the signature with the notice, and the button points at it", async () => {
    precheck.block = { reason: "unavailable" };
    renderEdit();
    typeNear("en", "2");
    const notice = screen.getByText(shellT.precheckUnavailableTitle);
    const button = screen.getByRole("button", { name: t.addTokensSignAndAdd }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-describedby")).toBe(notice.parentElement?.id);
  });

  it("a mock portfolio is never asked", async () => {
    state.vaultLive = false;
    precheck.block = { reason: "unavailable" };
    renderEdit({ real: false });
    typeNear("en", "2");
    expect(screen.queryByText(shellT.precheckUnavailableTitle)).toBeNull();
  });
});

// D-405: the same notice on a top-up of a real portfolio (D-321), except for one pending to this
// same portfolio, which the D-326 strip on the page already says.
describe.each(["en", "es"] as const)("AddFundsModal (edit, real portfolio) — an earlier transfer still unconfirmed (%s)", (lang) => {
  const t = translations[lang];
  const shellT = shellTranslations[lang];

  beforeEach(() => {
    state.lang = lang;
    state.allocateInto.mockReset();
  });
  afterEach(() => {
    state.pending = undefined;
    cleanup();
  });

  it("a pending top-up of another portfolio: said from the open, before any amount, and signing stays open", () => {
    state.pending = [{ id: "rec-1", op: "allocate_into", portfolioId: "p-2" }];
    renderEdit({ lang });
    // From the open, so it never pushes the amount chips down mid-tap (s283 QA).
    expect(screen.getByText(shellT.pendingAllocateFundingNotice)).toBeTruthy();
    typeNear(lang, "2");
    expect(screen.getByText(shellT.pendingAllocateFundingNotice)).toBeTruthy();
    expect((screen.getByRole("button", { name: t.addTokensSignAndAdd }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("a pending creation is said too", () => {
    state.pending = [{ id: "rec-1", op: "setup", portfolioId: null }];
    renderEdit({ lang });
    typeNear(lang, "2");
    expect(screen.getByText(shellT.pendingAllocateFundingNotice)).toBeTruthy();
  });

  it("a pending top-up of this same portfolio is said too: the D-326 strip sits behind the overlay", () => {
    state.pending = [{ id: "rec-1", op: "allocate_into", portfolioId: "p-1" }];
    renderEdit({ lang });
    expect(screen.getByText(shellT.pendingAllocateFundingNotice)).toBeTruthy();
  });

  it("says nothing with nothing in transit", () => {
    state.pending = [];
    renderEdit({ lang });
    typeNear(lang, "2");
    expect(screen.queryByText(shellT.pendingAllocateFundingNotice)).toBeNull();
  });

  it("hidden while its own signature is in flight", async () => {
    state.pending = [{ id: "rec-1", op: "allocate_into", portfolioId: "p-2" }];
    state.allocateInto.mockReturnValue(new Promise(() => {}));
    renderEdit({ lang });
    typeNear(lang, "2");
    await clickPrimary(t.addTokensSignAndAdd);
    expect(screen.queryByText(shellT.pendingAllocateFundingNotice)).toBeNull();
  });

  it("hidden after its own attempt ends unconfirmed", async () => {
    state.pending = [{ id: "rec-1", op: "allocate_into", portfolioId: "p-2" }];
    state.allocateInto.mockRejectedValue(new RealAllocateUnconfirmedError("x", "rec-9", "unconfirmed"));
    renderEdit({ lang });
    typeNear(lang, "2");
    await clickPrimary(t.addTokensSignAndAdd);
    expect(screen.getByRole("button", { name: t.addTokensClose })).toBeTruthy();
    expect(screen.queryByText(shellT.pendingAllocateFundingNotice)).toBeNull();
  });

  it("a mock portfolio signs nothing here, so says nothing", () => {
    state.pending = [{ id: "rec-1", op: "allocate_into", portfolioId: "p-2" }];
    renderEdit({ lang, real: false });
    typeNear(lang, "2");
    expect(screen.queryByText(shellT.pendingAllocateFundingNotice)).toBeNull();
  });
});
