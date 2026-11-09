// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RealAllocateUnconfirmedError } from "@/features/vault/lib/run-real-allocate";
import { AmountExceedsBalanceError } from "@/features/vault/lib/base-units";
import { RelayError } from "@/features/vault/lib/relay-client";
import { formatUsd } from "@/features/portfolio-editor/lib/format";
import { translations as editorTranslations } from "@/features/portfolio-editor/lib/translations";
import type { NewPortfolioDraft } from "../lib/new-portfolio-draft";
import { shellTranslations } from "../lib/translations";

// D-298 / D-304(b). What the create modal does after a live Allocate that did not come back
// clean. The funds of an unconfirmed Allocate are already in transit, so the modal must end
// there — a second click signing them again is how a second stranded Allocate happens. An
// amount above the balance signed nothing, so there the retry must stay open.

const state = vi.hoisted(() => ({
  lang: "en" as "en" | "es",
  create: vi.fn(),
  available: new Map([["near", 5]]),
  prices: {} as Record<string, { usdPrice: number }>,
  pricesLoading: false,
  discard: vi.fn(),
  retire: vi.fn(),
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
  usePendingAllocates: () => ({ pending: state.pending, isFetching: false }),
}));

// The vault's pre-check (017-9b) is pinned per test; its reads are covered in vault-precheck.test.ts.
const precheck = vi.hoisted(() => ({ block: null as null | { reason: "unavailable" } | { reason: "token-frozen"; tokenId: string }, ops: [] as unknown[] }));
vi.mock("@/features/vault/hooks/use-vault-precheck", () => ({
  useVaultPrecheck: (op: unknown) => {
    precheck.ops.push(op);
    return op ? precheck.block : null;
  },
}));

vi.mock("../context/language-context", () => ({
  useLanguage: () => ({ lang: state.lang, setLang: vi.fn() }),
}));
vi.mock("../context/portfolio-context", () => ({
  usePortfolio: () => ({
    createPortfolioWithChangeSet: state.create,
    realAllocateStage: state.stage,
    relaySends: state.relaySends,
    vaultLive: state.vaultLive,
    setupSigner: { accountId: "alice.near", loginAddress: "alice.near" },
  }),
}));
vi.mock("../hooks/use-available-general-balance", () => ({
  useAvailableGeneralBalance: () => state.available,
}));
vi.mock("@/features/market/hooks/use-token-prices", async () => {
  // Every registry token priced LIVE (the Storage Cost refuses a fallback, D-528): the test's
  // own quote where it sets one, the registry's figure otherwise — the same number the modal
  // used before prices had a source.
  const { tokenRegistry } = await vi.importActual<typeof import("@/features/market/lib/token-registry")>(
    "@/features/market/lib/token-registry"
  );
  return {
    useTokenPrices: () => ({
      prices: Object.fromEntries(
        tokenRegistry.map((t) => [
          t.id,
          { symbol: t.symbol, usdPrice: state.prices[t.id]?.usdPrice ?? t.fallbackUsdPrice, updatedAt: "", source: "chaindefuser" },
        ])
      ),
      isLoading: state.pricesLoading,
    }),
  };
});
vi.mock("../hooks/use-new-portfolio-draft", () => ({
  useNewPortfolioDraft: () => ({
    draft: null,
    save: vi.fn(),
    discard: state.discard,
    discardIfUnchanged: state.retire,
  }),
}));

import { tokenRegistry } from "@/features/market/lib/token-registry";
import { isPortfolioOfferable } from "@/features/bridge/lib/token-availability";
import { presetDraftRows } from "../lib/new-portfolio-draft-editing";
import { PresetReviewModal, type ReviewSource } from "./preset-review-modal";
import { COUNTRY_COOKIE } from "@/features/stocks/lib/stock-region";

// D-569: the cookie the middleware writes from Vercel's country header.
const setCountry = (code: string | null) => {
  document.cookie = code ? `${COUNTRY_COOKIE}=${code}; path=/` : `${COUNTRY_COOKIE}=; path=/; max-age=0`;
};
afterEach(() => setCountry(null));

const maxLabel = () => shellTranslations[state.lang as "en" | "es"].depositAmountMax;

// D-397: a mix just built in the editor, never saved.
const newSource: ReviewSource = {
  kind: "new",
  input: { name: "Balanced", presetId: "balanced", rows: presetDraftRows("balanced") },
};

function renderModal(
  source: ReviewSource = newSource,
  { existingNames = [] as string[], withBack = true, filled = true } = {}
) {
  const onClose = vi.fn();
  const onBack = vi.fn();
  const onCreated = vi.fn();
  // A fresh element per render: re-rendering the same one lets React skip it, and the point of
  // `rerender` is to read the mocked hooks again.
  const el = () => (
    <PresetReviewModal
      source={source}
      existingNames={existingNames}
      onClose={onClose}
      onBack={withBack ? onBack : undefined}
      onCreated={onCreated}
    />
  );
  const { rerender } = render(el());
  // D-553: the fields start empty. Most tests are about what happens with funds chosen, so they
  // start where the user would: Max on every row. `filled: false` is the modal as it opens.
  if (filled) for (const max of screen.queryAllByRole("button", { name: maxLabel() })) fireEvent.click(max);
  return { onClose, onBack, onCreated, rerender: () => rerender(el()) };
}

async function clickPrimary(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

describe.each(["en", "es"] as const)("PresetReviewModal — a live Allocate that was not confirmed (%s)", (lang) => {
  const t = shellTranslations[lang];

  beforeEach(() => {
    state.lang = lang;
    state.create.mockReset();
    state.available = new Map([["near", 5]]);
  });
  afterEach(cleanup);

  it.each([
    ["vault_failed", t.realStageVaultFailedTitle, t.realStageVaultFailed],
    ["unconfirmed", t.realStagePendingUnconfirmedTitle, t.realStagePendingUnconfirmed],
  ] as const)("%s ends the modal: its copy, only Close, the form disabled", async (reason, title, body) => {
    state.create.mockRejectedValue(new RealAllocateUnconfirmedError("technical detail", "rec-1", reason));
    const { onClose, onBack } = renderModal();

    await clickPrimary(t.presetReviewCreate);

    const status = screen.getByRole("status");
    expect(status.textContent).toContain(title);
    expect(status.textContent).toContain(body);
    expect(status.textContent).toContain(t.realStageSeeMyAccount);
    expect(document.body.textContent).not.toContain("technical detail");
    // Never the old "check back before retrying" invitation.
    expect(document.body.textContent).not.toContain(t.presetReviewRetry);

    // Only Close remains, and it is where focus went, described by the notice.
    const close = screen.getByRole("button", { name: t.realAllocateClose }) as HTMLButtonElement;
    expect(close.disabled).toBe(false);
    expect(screen.queryByRole("button", { name: t.presetReviewBack })).toBeNull();
    expect(document.activeElement).toBe(close);
    const describedBy = close.getAttribute("aria-describedby");
    expect(describedBy && document.getElementById(describedBy)?.textContent).toContain(title);

    // The form is inert: name, amounts, chips.
    expect(screen.getByRole("group").hasAttribute("disabled")).toBe(true);
    expect(screen.getByLabelText(t.portfolioNameLabel).matches(":disabled")).toBe(true);
    expect(screen.getByRole("spinbutton").matches(":disabled")).toBe(true);

    // 🔴 The second click closes. It must never sign again.
    await clickPrimary(t.realAllocateClose);
    expect(state.create).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onBack).not.toHaveBeenCalled();
  });

  it("Close stays usable after the refetched balance leaves nothing to create with", async () => {
    state.create.mockRejectedValue(new RealAllocateUnconfirmedError("x", "rec-1", "unconfirmed"));
    const { onClose, rerender } = renderModal();
    await clickPrimary(t.presetReviewCreate);

    // The context refetches the balance on failure; the funds already left.
    state.available = new Map();
    rerender();

    const close = screen.getByRole("button", { name: t.realAllocateClose }) as HTMLButtonElement;
    expect(close.disabled).toBe(false);
    await clickPrimary(t.realAllocateClose);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("an amount above the balance: localized copy, no base units, retry open", async () => {
    const error = new AmountExceedsBalanceError(BigInt("5000000000000000000000001"), BigInt("4"));
    state.create.mockRejectedValueOnce(error).mockResolvedValueOnce(undefined);
    const { onClose } = renderModal();

    await clickPrimary(t.presetReviewCreate);

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(t.amountExceedsBalanceTitle);
    expect(alert.textContent).toContain(t.amountExceedsBalanceBody);
    expect(alert.textContent).not.toContain(t.signErrorGeneric);
    expect(document.body.textContent).not.toContain(error.message);
    expect(document.body.textContent).not.toContain("base units");
    expect(document.body.textContent).not.toContain("5000000000000000000000001");

    // Nothing was signed: the form stays editable and focus is on the amount to fix.
    const amount = screen.getByRole("spinbutton");
    expect(amount.matches(":disabled")).toBe(false);
    expect(document.activeElement).toBe(amount);
    expect(screen.getByRole("button", { name: t.presetReviewBack })).toBeTruthy();

    await clickPrimary(t.presetReviewRetry);
    expect(state.create).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// D-315, the create side. NEAR `798071770987143215177784` (the smoke's «Portfolio 6» figure):
// MAX used to write `toFixed(8)` of it, 0.79807177 — below the balance by more than
// `capToHeld` treats as noise, so it would have signed 798071770000000000000000 and left the
// rest behind. MAX must hand over the float itself; the money path settles it on the raw figure.
describe("PresetReviewModal — MAX on a 24-decimal balance", () => {
  const t = shellTranslations.en;
  const avail = 0.7980717709871432; // fromBaseUnits(798071770987143215177784n, 24)

  beforeEach(() => {
    state.lang = "en";
    state.create.mockReset().mockResolvedValue(undefined);
    state.available = new Map([["near", avail]]);
    // Explicit, so the $1 filter (≈ $2.39 here) does not hinge on the registry's fallback price.
    state.prices = { near: { usdPrice: 3 } };
  });
  afterEach(cleanup);

  it("signs the whole balance after the amount was edited and MAX restores it", async () => {
    renderModal();
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "0.5" } });
    fireEvent.click(screen.getByRole("button", { name: t.depositAmountMax }));

    await clickPrimary(t.presetReviewCreate);

    const changeset = state.create.mock.calls[0][1];
    expect(changeset.allocations).toEqual([{ tokenId: "near", qty: avail }]);
  });

  // D-319: the field cuts the long figure with an ellipsis, so it says when it is all of it.
  it("says 'whole balance' after MAX, and what is available otherwise", () => {
    renderModal(undefined, { filled: false });
    expect(screen.queryByText(t.amountWholeBalance)).toBeNull();
    expect(screen.getByText(new RegExp(`^${t.presetReviewAvailable}: `))).toBeTruthy();
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "0.5" } });
    expect(screen.queryByText(t.amountWholeBalance)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: t.depositAmountMax }));
    expect(screen.getByText(t.amountWholeBalance)).toBeTruthy();
  });

  // 027-13: a chip reads as chosen only while the field holds its amount.
  it("marks the chip whose amount the field holds, and clears it when another is typed", () => {
    renderModal();
    const pressed = (name: string) => screen.getByRole("button", { name }).getAttribute("aria-pressed");
    expect(pressed(t.depositAmountMax)).toBe("true");
    expect(pressed("50%")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "50%" }));
    expect(pressed("50%")).toBe("true");
    expect(pressed(t.depositAmountMax)).toBe("false");
    expect(pressed("25%")).toBe("false");

    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "0.5" } });
    expect(pressed("50%")).toBe("false");
    expect(pressed(t.depositAmountMax)).toBe("false");
  });
});


// 016 1.4 / T7. The prefilled name is editable, and the cap is the same in the input, the
// counter and the error (it used to be 50 in the input and 40 in validation).
describe.each(["en", "es"] as const)("PresetReviewModal — name field (%s)", (lang) => {
  const t = shellTranslations[lang];

  beforeEach(() => {
    state.lang = lang;
  });
  afterEach(cleanup);

  it("says the name can be changed and counts against 25", () => {
    renderModal();
    const input = screen.getByLabelText(t.portfolioNameLabel) as HTMLInputElement;
    expect(input.value).toBe("Balanced");
    expect(input.maxLength).toBe(25);

    const hint = screen.getByText(t.portfolioNameHint);
    expect(input.getAttribute("aria-describedby")).toBe(hint.id);
    expect(screen.getByText("8/25")).toBeTruthy();
  });

  it("an over-long name shows the cap in the error, in place of the hint", () => {
    renderModal();
    const input = screen.getByLabelText(t.portfolioNameLabel);
    fireEvent.change(input, { target: { value: "a".repeat(26) } });

    expect(screen.getByRole("alert").textContent).toBe(
      t.portfolioNameTooLong.replace("{max}", "25")
    );
    expect(screen.queryByText(t.portfolioNameHint)).toBeNull();
    expect(input.hasAttribute("aria-describedby")).toBe(false);
  });
});


// ── 016 block 2.4 — the confirmation of a New Portfolio Draft ─────────────────

const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const MPDAO = "nep141:mpdao-token.near";

// A hand-built mix: percentages and tolerances no preset has, so a preset leaking into the
// signed composition cannot pass for the draft.
const DRAFT: NewPortfolioDraft = {
  v: 1,
  name: "My mix",
  presetId: null,
  rows: [
    { tokenId: "near", targetPct: 62.5, tolerancePct: 7.25, locked: true },
    { tokenId: USDC, targetPct: 37.5, tolerancePct: 12, locked: false },
  ],
  updatedAt: 1,
};
const draftSource: ReviewSource = { kind: "draft", draft: DRAFT };

function resetFunds() {
  state.lang = "en";
  state.create.mockReset().mockResolvedValue(undefined);
  state.discard.mockReset();
  state.retire.mockReset();
  state.pricesLoading = false;
  state.prices = { near: { usdPrice: 3 }, [USDC]: { usdPrice: 1 }, [MPDAO]: { usdPrice: 0.01 } };
  // NEAR $15, USDC $20, mpDAO $0.004 — dust (under a cent, 027 A-2).
  state.available = new Map([["near", 5], [USDC, 20], [MPDAO, 0.4]]);
}

describe("PresetReviewModal — confirming a New Portfolio Draft (016 block 2.4)", () => {
  const t = shellTranslations.en;
  beforeEach(resetFunds);
  afterEach(cleanup);

  it("prefills the draft's name and cancels without a chooser to go back to", () => {
    const { onClose } = renderModal(draftSource, { withBack: false });
    expect(screen.getByRole("heading", { name: t.presetReviewTitle })).toBeTruthy();
    expect((screen.getByLabelText(t.portfolioNameLabel) as HTMLInputElement).value).toBe("My mix");
    expect(screen.queryByRole("button", { name: t.presetReviewBack })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: t.cancel }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // 🔴 The mix that is signed is the draft, row by row — not a preset, not rounded.
  it("signs the draft's composition row by row, with the funds on screen", async () => {
    const { onClose, onCreated } = renderModal(draftSource, { withBack: false });
    await clickPrimary(t.presetReviewCreate);

    expect(state.create).toHaveBeenCalledTimes(1);
    const [name, changeset] = state.create.mock.calls[0];
    expect(name).toBe("My mix");
    expect(changeset.tokenAdditions).toEqual(
      DRAFT.rows.map((r) => ({ tokenId: r.tokenId, initialTargetPct: r.targetPct, initialTolerancePct: r.tolerancePct }))
    );
    expect(changeset.allocations).toEqual(
      expect.arrayContaining([{ tokenId: "near", qty: 5 }, { tokenId: USDC, qty: 20 }])
    );
    expect(changeset.allocations).toHaveLength(2);

    // The draft became the portfolio: gone — that draft, by the version signed — and the
    // shell lands on it.
    expect(state.retire).toHaveBeenCalledWith(DRAFT.updatedAt);
    expect(state.discard).not.toHaveBeenCalled();
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("an Allocate in transit also ends the draft: no second invitation to sign (D-298)", async () => {
    state.create.mockRejectedValue(new RealAllocateUnconfirmedError("x", "rec-1", "unconfirmed"));
    const { onCreated } = renderModal(draftSource, { withBack: false });
    await clickPrimary(t.presetReviewCreate);

    expect(state.discard).toHaveBeenCalledTimes(1);
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: t.realAllocateClose })).toBeTruthy();
  });

  it.each([
    ["a cancelled signature", new Error("User rejected the request")],
    ["a failure before signing", new Error("RPC unavailable")],
    ["an amount above the balance", new AmountExceedsBalanceError(BigInt(6), BigInt(5))],
  ])("%s keeps the draft to retry", async (_label, error) => {
    state.create.mockRejectedValue(error);
    const { onClose, onCreated } = renderModal(draftSource, { withBack: false });
    await clickPrimary(t.presetReviewCreate);

    expect(state.discard).not.toHaveBeenCalled();
    expect(state.retire).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: t.presetReviewRetry })).toBeTruthy();
  });

  it("a name taken since the draft was saved blocks the signature until changed", async () => {
    renderModal(draftSource, { withBack: false, existingNames: ["My mix"] });
    const create = screen.getByRole("button", { name: t.presetReviewCreate }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toBe(t.portfolioNameDuplicate);

    fireEvent.change(screen.getByLabelText(t.portfolioNameLabel), { target: { value: "My mix 2" } });
    expect(create.disabled).toBe(false);
  });

  it("the preset's 'starting point' disclaimer is not said of a mix built from scratch", () => {
    renderModal(draftSource, { withBack: false });
    expect(screen.queryByText(t.presetReviewNotAdvice)).toBeNull();
    cleanup();
    renderModal({ kind: "draft", draft: { ...DRAFT, presetId: "balanced" } }, { withBack: false });
    expect(screen.getByText(t.presetReviewNotAdvice)).toBeTruthy();
  });
});

// C2 / D-007, for both sources: nothing under $1 is offered, and no line is funded under $1.
describe.each([
  ["draft", draftSource],
  ["new", newSource],
])("PresetReviewModal — the one-cent minimum (%s)", (_label, source) => {
  const t = shellTranslations.en;
  const et = editorTranslations.en;
  beforeEach(resetFunds);
  afterEach(cleanup);

  it("does not offer dust, and never signs it", async () => {
    renderModal(source);
    expect(screen.queryByRole("spinbutton", { name: /mpDAO/i })).toBeNull();
    expect(screen.getAllByRole("spinbutton")).toHaveLength(2);

    await clickPrimary(t.presetReviewCreate);
    const changeset = state.create.mock.calls[0][1];
    expect(changeset.allocations.map((a: { tokenId: string }) => a.tokenId).sort()).toEqual(["near", USDC].sort());
  });

  it("with nothing worth a cent, says what it takes and cannot sign", () => {
    state.available = new Map([[MPDAO, 0.4]]);
    renderModal(source);
    expect(screen.getByText(t.presetReviewNoFunds)).toBeTruthy();
    expect((screen.getByRole("button", { name: t.presetReviewCreate }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("an amount lowered under a cent is flagged on its row and blocks the signature", () => {
    renderModal(source);
    const near = screen.getByRole("spinbutton", { name: /^NEAR/ });
    // 027 A-2: what was the $1 floor's case is fine now.
    fireEvent.change(near, { target: { value: "0.3" } }); // $0.90
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.change(near, { target: { value: "0.001" } }); // $0.003

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe(et.allocateErrorMinFunded);
    expect(near.getAttribute("aria-invalid")).toBe("true");
    expect(near.getAttribute("aria-describedby")).toBe(alert.id);
    // Only the row at fault.
    expect(screen.getByRole("spinbutton", { name: /^USDC/ }).hasAttribute("aria-invalid")).toBe(false);
    expect((screen.getByRole("button", { name: t.presetReviewCreate }) as HTMLButtonElement).disabled).toBe(true);

    // $0.01 in rounded cents is enough, like everywhere else the minimum is checked.
    fireEvent.change(near, { target: { value: "0.0034" } }); // $0.0102
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("button", { name: t.presetReviewCreate }) as HTMLButtonElement).disabled).toBe(false);
  });

  // The cut trims what is offered, never what is already on screen.
  it("a token already offered stays when its price dips under a cent", () => {
    const { rerender } = renderModal(source);
    state.prices = { ...state.prices, near: { usdPrice: 0.0005 } }; // 5 NEAR → $0.0025
    rerender();
    const near = screen.getByRole("spinbutton", { name: /^NEAR/ });
    expect(near).toBeTruthy();
    // …and the per-row minimum says why it cannot be signed as is.
    expect(screen.getByRole("alert").textContent).toBe(et.allocateErrorMinFunded);
  });

  // G2: says what stays behind once there is an amount to compare it with.
  it("says what stays in the funding account only once an amount is chosen", () => {
    renderModal(source, { filled: false });
    expect(screen.queryByText(/stays in your funding account/)).toBeNull();

    fireEvent.change(screen.getByRole("spinbutton", { name: /^NEAR/ }), { target: { value: "2" } });
    // 3 NEAR ($9) + 20 USDC + the mpDAO dust ($0.004): the whole remainder, as My Account will show it.
    expect(screen.getByText(t.presetReviewRemaining.replace("{amount}", formatUsd(29.004)))).toBeTruthy();
  });

  it("a token left empty counts as staying behind", () => {
    renderModal(source, { filled: false });
    fireEvent.change(screen.getByRole("spinbutton", { name: /^NEAR/ }), { target: { value: "5" } });
    // 20 USDC + the dust.
    expect(screen.getByText(t.presetReviewRemaining.replace("{amount}", formatUsd(20.004)))).toBeTruthy();
  });

  // Rounded cents, like `fundableTokenIds`: a token offered at "$0.01" signs its whole amount.
  it("$0.005 counts as $0.01", () => {
    renderModal(source);
    fireEvent.change(screen.getByRole("spinbutton", { name: /^NEAR/ }), { target: { value: "0.00167" } }); // $0.00501
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("button", { name: t.presetReviewCreate }) as HTMLButtonElement).disabled).toBe(false);
  });

  // The B1 slow path: the confirmation opened before the deposit showed; when it does, it is offered.
  it("a token that becomes worth a cent while open is offered", () => {
    state.available = new Map([[MPDAO, 0.4]]);
    const { rerender } = renderModal(source);
    expect(screen.getByText(t.presetReviewNoFunds)).toBeTruthy();

    state.available = new Map([[MPDAO, 0.4], ["near", 5]]);
    rerender();
    const near = screen.getByRole("spinbutton", { name: /^NEAR/ }) as HTMLInputElement;
    // Offered, not chosen: a late arrival starts empty like every other row (D-553).
    expect(near.value).toBe("");
    expect((screen.getByRole("button", { name: t.presetReviewCreate }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(near, { target: { value: "5" } });
    expect((screen.getByRole("button", { name: t.presetReviewCreate }) as HTMLButtonElement).disabled).toBe(false);
  });

  // s186: before the first price answer every price is a fallback; an offer made on it would stick.
  it("offers nothing until prices have their first answer, then what is worth a cent", () => {
    state.pricesLoading = true;
    const { rerender } = renderModal(source);
    expect(screen.queryAllByRole("spinbutton")).toHaveLength(0);

    state.pricesLoading = false;
    rerender();
    expect(screen.getAllByRole("spinbutton")).toHaveLength(2);
    expect(screen.queryByRole("spinbutton", { name: /mpDAO/i })).toBeNull();
  });

  // An offered line whose live price reads 0 cannot be shown to hold a cent: blocked, never dust.
  it("an offered token whose price turns unknown blocks the signature", () => {
    const { rerender } = renderModal(source);
    state.prices = { ...state.prices, near: { usdPrice: 0 } };
    rerender();
    expect(screen.getByRole("alert").textContent).toBe(et.allocateErrorMinFunded);
    expect((screen.getByRole("button", { name: t.presetReviewCreate }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("PresetReviewModal — a preset also lands on the new portfolio", () => {
  const t = shellTranslations.en;
  beforeEach(resetFunds);
  afterEach(cleanup);

  it("calls onCreated after the signature, and never touches the draft", async () => {
    const { onCreated, onClose } = renderModal();
    await clickPrimary(t.presetReviewCreate);
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(state.discard).not.toHaveBeenCalled();
    expect(state.retire).not.toHaveBeenCalled();
  });

  it("shows the same title, the disclaimer of a preset's mix, and Back", () => {
    const { onBack, onClose } = renderModal();
    expect(screen.getByRole("heading", { name: t.presetReviewTitle })).toBeTruthy();
    expect(screen.getByText(t.presetReviewNotAdvice)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t.presetReviewBack }));
    expect(onBack).toHaveBeenCalledWith("Balanced");
    expect(onClose).not.toHaveBeenCalled();
  });
});

// F1 (cross-review s186) / D-298: while a signature is in flight nothing can dismiss the modal.
// Closed mid-Allocate, the draft would still be saved and "ready" — an invitation to sign the
// same funds again — and the late success would close whatever flow is open by then.
describe.each([
  ["draft", draftSource],
  ["new", newSource],
])("PresetReviewModal — no way out mid-signature (%s)", (_label, source) => {
  const t = shellTranslations.en;
  beforeEach(resetFunds);
  afterEach(cleanup);

  it("Escape and the backdrop do nothing until the signature settles", async () => {
    let settle: () => void = () => {};
    state.create.mockImplementation(() => new Promise<void>((resolve) => (settle = resolve)));
    const { onClose } = renderModal(source);
    await clickPrimary(t.presetReviewCreate);
    expect(screen.getByRole("button", { name: editorTranslations.en.inFlightAwaitingSignature })).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => settle());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("before signing, with nowhere to go back to, Escape closes as usual", () => {
    const { onClose } = renderModal(source, { withBack: false });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // D-309: an edit mid-signature changes nothing already signed; it only confuses.
  it("the amounts and 25/50/75/Max are frozen while signing, and free again after", async () => {
    let fail: (e: Error) => void = () => {};
    state.create.mockImplementation(() => new Promise<void>((_resolve, reject) => (fail = reject)));
    renderModal(source);
    const controls = () => [
      ...screen.getAllByRole("spinbutton"),
      ...["25%", "50%", "75%", t.depositAmountMax].flatMap((name) => screen.getAllByRole("button", { name })),
    ];
    expect(controls().every((el) => !el.matches(":disabled"))).toBe(true);

    await clickPrimary(t.presetReviewCreate);
    expect(controls().every((el) => el.matches(":disabled"))).toBe(true);

    vi.spyOn(console, "warn").mockImplementation(() => {});
    await act(async () => fail(new Error("User rejected the request")));
    expect(controls().every((el) => !el.matches(":disabled"))).toBe(true);
  });

  // D-309: the attempt disabled the focused button; the answer brings the focus back.
  it("after a failed signature the focus lands on Retry", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    state.create.mockRejectedValue(new Error("User rejected the request"));
    renderModal(source);
    await clickPrimary(t.presetReviewCreate);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: t.presetReviewRetry }));
  });
});

// D-553: a token enters only with an amount the user set. The funds used to open at the whole
// balance of every token, in the mix or not, and a signature could take them all unnoticed.
describe.each(["en", "es"] as const)("PresetReviewModal — nothing starts filled (D-553) (%s)", (lang) => {
  const t = shellTranslations[lang];
  const NBTC = "nep141:nbtc.bridge.near";
  // In the mix: NEAR, nBTC. In the account: NEAR and USDC, which is not in the mix.
  const mixedSource: ReviewSource = {
    kind: "draft",
    draft: {
      v: 1,
      name: "Mix",
      presetId: null,
      updatedAt: 1,
      rows: [
        { tokenId: "near", targetPct: 50, tolerancePct: 5, locked: false },
        { tokenId: NBTC, targetPct: 50, tolerancePct: 5, locked: false },
      ],
    },
  };
  // Holds none of the mix: the first portfolio of someone who only deposited USDC.
  const noneHeldSource: ReviewSource = {
    kind: "draft",
    draft: {
      v: 1,
      name: "Mix",
      presetId: null,
      updatedAt: 1,
      rows: [
        { tokenId: NBTC, targetPct: 50, tolerancePct: 5, locked: false },
        { tokenId: "nep141:eth.omft.near", targetPct: 50, tolerancePct: 5, locked: false },
      ],
    },
  };
  const createButton = () => screen.getByRole("button", { name: t.presetReviewCreate }) as HTMLButtonElement;
  const fieldOf = (symbol: RegExp) => screen.getByRole("spinbutton", { name: symbol }) as HTMLInputElement;

  beforeEach(() => {
    state.lang = lang;
    state.create.mockReset().mockResolvedValue(undefined);
    state.available = new Map([["near", 5], [USDC, 20]]);
    state.prices = { near: { usdPrice: 3 }, [USDC]: { usdPrice: 1 } };
    state.pricesLoading = false;
  });
  afterEach(cleanup);

  it("opens with every field empty, the button off and the reason next to it", async () => {
    renderModal(mixedSource, { filled: false });
    expect(screen.getAllByRole("spinbutton").map((el) => (el as HTMLInputElement).value)).toEqual(["", ""]);
    expect(createButton().disabled).toBe(true);
    const warning = screen.getByText(t.presetReviewEnterAmount);
    expect(createButton().getAttribute("aria-describedby")).toBe(warning.id);

    await clickPrimary(t.presetReviewCreate);
    expect(state.create).not.toHaveBeenCalled();
  });

  it("signs only the token given an amount, never the one left empty", async () => {
    renderModal(mixedSource, { filled: false });
    fireEvent.change(fieldOf(/^NEAR/), { target: { value: "2" } });
    expect(screen.queryByText(t.presetReviewEnterAmount)).toBeNull();

    await clickPrimary(t.presetReviewCreate);
    const changeset = state.create.mock.calls[0][1];
    expect(changeset.allocations).toEqual([{ tokenId: "near", qty: 2 }]);
  });

  it("a token outside the mix enters only when given an amount, and then is signed", async () => {
    renderModal(mixedSource, { filled: false });
    fireEvent.change(fieldOf(/^USDC\(NEAR\)/), { target: { value: "7" } });

    await clickPrimary(t.presetReviewCreate);
    const changeset = state.create.mock.calls[0][1];
    expect(changeset.allocations).toEqual([{ tokenId: USDC, qty: 7 }]);
  });

  it("clearing the amount, or typing 0, brings the warning back", () => {
    renderModal(mixedSource, { filled: false });
    fireEvent.change(fieldOf(/^NEAR/), { target: { value: "2" } });
    fireEvent.change(fieldOf(/^NEAR/), { target: { value: "" } });
    expect(screen.getByText(t.presetReviewEnterAmount)).toBeTruthy();
    fireEvent.change(fieldOf(/^NEAR/), { target: { value: "0" } });
    expect(screen.getByText(t.presetReviewEnterAmount)).toBeTruthy();
    expect(createButton().disabled).toBe(true);
  });

  it("lists the mix's tokens first and the others under their own title", () => {
    renderModal(mixedSource, { filled: false });
    const title = screen.getByText(t.presetReviewOtherTokens);
    expect(screen.getByText(t.presetReviewOtherTokensNote)).toBeTruthy();
    const before = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(before(fieldOf(/^NEAR/), title)).toBe(true);
    expect(before(title, fieldOf(/^USDC\(NEAR\)/))).toBe(true);
  });

  it("has no such title when every token offered is in the mix", () => {
    state.available = new Map([["near", 5]]);
    renderModal(mixedSource, { filled: false });
    expect(screen.queryByText(t.presetReviewOtherTokens)).toBeNull();
  });

  it("holding none of the mix: says what the others do, and they can fund it", async () => {
    renderModal(noneHeldSource, { filled: false });
    expect(screen.getByText(t.presetReviewOtherTokensNote)).toBeTruthy();
    expect(screen.getByText(t.presetReviewEnterAmount)).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: t.depositAmountMax })[0]);
    expect(createButton().disabled).toBe(false);
  });

  it("offers no ✕: leaving a field empty is how a token stays out", () => {
    renderModal(mixedSource, { filled: false });
    expect(screen.queryByRole("button", { name: new RegExp(`^${t.presetReviewRemoveToken} `) })).toBeNull();
  });

  it("does not ask for an amount once an Allocate is in transit", async () => {
    const { rerender } = renderModal(mixedSource, { filled: false });
    fireEvent.change(fieldOf(/^NEAR/), { target: { value: "5" } });
    state.create.mockRejectedValue(new RealAllocateUnconfirmedError("technical detail", "rec-1", "unconfirmed"));
    await clickPrimary(t.presetReviewCreate);
    // The NEAR left; USDC is still offered and empty, so no amount is chosen any more.
    state.available = new Map([[USDC, 20]]);
    rerender();
    expect(screen.queryByText(t.presetReviewEnterAmount)).toBeNull();
  });

  it("with nothing to offer it keeps its own message, not this one", () => {
    state.available = new Map();
    renderModal(mixedSource, { filled: false });
    expect(screen.getByText(t.presetReviewNoFunds)).toBeTruthy();
    expect(screen.queryByText(t.presetReviewEnterAmount)).toBeNull();
  });
});

describe.each(["en", "es"] as const)("PresetReviewModal — the relayer (017-2, D-365) (%s)", (lang) => {
  const t = shellTranslations[lang];

  beforeEach(() => {
    state.lang = lang;
    state.create.mockReset();
    state.available = new Map([["near", 5]]);
    state.relaySends = false;
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    state.relaySends = false;
  });

  it("a paused relay: the notice replaces the signature request", async () => {
    state.relaySends = true;
    const fetchMock = vi.fn(async () => Response.json({ paused: true }));
    vi.stubGlobal("fetch", fetchMock);
    renderModal();

    expect(await screen.findByText(t.relayPausedTitle)).toBeTruthy();
    expect(screen.getByText(t.relayPausedBody)).toBeTruthy();
    const create = screen.getByRole("button", { name: t.presetReviewCreate }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/relay", { method: "GET", cache: "no-store" });
  });

  it("asks nothing when this login does not send through the relayer", async () => {
    const fetchMock = vi.fn(async () => Response.json({ paused: true }));
    vi.stubGlobal("fetch", fetchMock);
    renderModal();
    await act(async () => {});

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText(t.relayPausedTitle)).toBeNull();
  });

  it.each([
    ["paused", "signErrorRelayPaused", true],
    ["blocked", "signErrorRelayPaused", true],
    ["cap-exceeded", "signErrorRelayPaused", true],
    ["rate-limited", "signErrorRelayBusy", false],
    ["check-failed", "signErrorRelayCheckFailed", false],
    ["would-fail", "signErrorRelayWouldFail", false],
  ] as const)("a %s refusal reads as its own copy, never the relay's raw text", async (code, key, retryBlocked) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    state.create.mockRejectedValue(new RelayError("only an Allocate into x.near is relayed to intents.near", code, 422));
    renderModal();

    await clickPrimary(t.presetReviewCreate);

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(t[key]);
    expect(alert.textContent).not.toContain("intents.near");
    // A pause the click ran into blocks the retry: it would be another signature for the same refusal.
    expect((screen.getByRole("button", { name: t.presetReviewRetry }) as HTMLButtonElement).disabled).toBe(retryBlocked);
  });

  it("the disabled Create button is described by the pause notice", async () => {
    state.relaySends = true;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ paused: true })));
    renderModal();
    await screen.findByText(t.relayPausedTitle);
    const create = screen.getByRole("button", { name: t.presetReviewCreate }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect(create.getAttribute("aria-describedby")).toBe("preset-review-relay-paused");
  });

  it("the unconfirmed state wins over a pause that answers late", async () => {
    state.relaySends = true;
    // The pause answer lands AFTER the Allocate went out and came back unconfirmed.
    let answer: (r: Response) => void = () => {};
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => (answer = resolve))));
    state.create.mockRejectedValue(new RealAllocateUnconfirmedError("x", "rec-1", "unconfirmed"));
    renderModal();

    await clickPrimary(t.presetReviewCreate);
    await act(async () => answer(Response.json({ paused: true })));

    expect(screen.queryByText(t.relayPausedTitle)).toBeNull();
    const close = screen.getByRole("button", { name: t.realAllocateClose }) as HTMLButtonElement;
    expect(close.disabled).toBe(false);
    expect(close.getAttribute("aria-describedby")).toBe("preset-review-unconfirmed");
  });
});

describe("PresetReviewModal — the vault would refuse (017-9b)", () => {
  const t = shellTranslations.en;

  beforeEach(() => {
    state.lang = "en";
    state.create.mockReset();
    state.available = new Map([["near", 5]]);
    state.vaultLive = true;
  });
  afterEach(() => {
    cleanup();
    state.vaultLive = false;
    precheck.block = null;
    precheck.ops = [];
  });

  it("asks about the tokens the new portfolio would be funded with", () => {
    renderModal();
    expect(precheck.ops.at(-1)).toEqual({ kind: "allocate", tokenIds: ["near"] });
  });

  it("a frozen token: the notice names it, and Create is disabled and points at it", () => {
    precheck.block = { reason: "token-frozen", tokenId: "near" };
    renderModal();
    const notice = screen.getByText(t.precheckFrozenTitle.replace("{token}", "NEAR"));
    const create = screen.getByRole("button", { name: t.presetReviewCreate }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect(create.getAttribute("aria-describedby")).toBe(notice.parentElement?.id);
  });

  it("a mock login is never asked", () => {
    state.vaultLive = false;
    renderModal();
    expect(precheck.ops.every((op) => op === null)).toBe(true);
  });
});

// D-308 / D-356, on the preset and draft confirmation.
describe("PresetReviewModal — what is pending is shown", () => {
  const t = shellTranslations.en;
  const et = editorTranslations.en;
  beforeEach(resetFunds);
  afterEach(() => {
    state.stage = null;
    state.pending = undefined;
    cleanup();
  });

  it("the button says it is processing once the signature is in", async () => {
    state.create.mockReturnValue(new Promise(() => {}));
    const { rerender } = renderModal();
    await clickPrimary(t.presetReviewCreate);
    expect(screen.getByRole("button", { name: et.inFlightAwaitingSignature })).toBeTruthy();
    state.stage = "submitting";
    rerender();
    expect(screen.getByRole("button", { name: et.inFlightProcessing })).toBeTruthy();
  });

  it("says part of the balance may be on its way while an earlier transfer is unconfirmed, without blocking", () => {
    state.pending = [{ id: "rec-1", op: "allocate_into", portfolioId: "7" }];
    renderModal();
    expect(screen.getByText(t.pendingAllocateFundingNotice)).toBeTruthy();
    expect((screen.getByRole("button", { name: t.presetReviewCreate }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("hides that notice during its own attempt, whose record would be the one counted", async () => {
    state.pending = [{ id: "rec-1", op: "setup", portfolioId: null }];
    state.create.mockReturnValue(new Promise(() => {}));
    renderModal();
    await clickPrimary(t.presetReviewCreate);
    expect(screen.queryByText(t.pendingAllocateFundingNotice)).toBeNull();
  });
});

// D-528: the Setup's Storage Cost — its own line, the net on the token it is charged in, and the
// quote handed to the signature. The changeset stays GROSS: the cost is deducted downstream, once.
describe.each(["en", "es"] as const)("PresetReviewModal — the Storage Cost (D-528) (%s)", (lang) => {
  const t = shellTranslations[lang];
  const netPrefix = t.storageCostNet.split("{amount}")[0];
  const createButton = () => screen.getByRole("button", { name: t.presetReviewCreate }) as HTMLButtonElement;

  beforeEach(() => {
    state.lang = lang;
    state.create.mockReset();
    state.available = new Map([["near", 5]]);
    state.prices = { near: { usdPrice: 3 } };
  });
  afterEach(cleanup);

  it("shows its own line and what reaches the portfolio, and hands the quote to the signature", async () => {
    renderModal();
    expect(screen.getByText(t.storageCostLabel)).toBeTruthy();
    expect(screen.getByText((text) => text.startsWith(netPrefix))).toBeTruthy();
    expect(createButton().disabled).toBe(false);

    await clickPrimary(t.presetReviewCreate);

    const [, changeset, , storage] = state.create.mock.calls[0];
    expect(changeset.allocations).toEqual([{ tokenId: "near", qty: 5 }]); // gross
    expect(storage).toMatchObject({ ok: true, tokenId: "near" });
    expect(storage.amount).toBe(storage.costYocto); // charged in NEAR: exactly the cost
  });

  it("blocks the signature, and says why, when the charged token cannot cover it", () => {
    state.available = new Map([["near", 0.004]]); // $0.012, under the cost
    renderModal();
    expect(screen.queryByText(t.storageCostLabel)).toBeNull();
    expect(screen.getByText((text) => text.startsWith(t.storageCostExceedsAmount.split("{token}")[0]))).toBeTruthy();
    expect(createButton().disabled).toBe(true);
  });

  it("waits for a live NEAR price instead of pricing the cost on a guess", () => {
    state.prices = { near: { usdPrice: 0 } };
    state.available = new Map([["near", 5], ["nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", 20]]);
    renderModal();
    expect(screen.getByText(t.storageCostPricesNotLive)).toBeTruthy();
    expect(createButton().disabled).toBe(true);
  });
});

// D-397 (plan 041): a mix created straight from the editor signs through this same screen.
describe("PresetReviewModal — a new mix from the editor (D-397)", () => {
  const t = shellTranslations.en;
  const sourceFor = (rows: NewPortfolioDraft["rows"]): ReviewSource => ({
    kind: "new",
    input: { name: DRAFT.name, presetId: DRAFT.presetId, rows },
  });
  beforeEach(resetFunds);
  afterEach(cleanup);

  // 🔴 What is signed does not depend on the way in.
  it("signs exactly what a saved draft with the same rows signs", async () => {
    renderModal(draftSource, { withBack: false });
    await clickPrimary(t.presetReviewCreate);
    cleanup();
    renderModal(sourceFor(DRAFT.rows));
    await clickPrimary(t.presetReviewCreate);

    expect(state.create).toHaveBeenCalledTimes(2);
    const [fromDraft, fromEditor] = state.create.mock.calls;
    expect(fromEditor[0]).toBe(fromDraft[0]);
    expect(fromEditor[1]).toEqual(fromDraft[1]);
    expect(fromEditor[2]).toBe(fromDraft[2]);
    expect(fromEditor[3]).toEqual(fromDraft[3]);
  });

  it("signed, it lands on the portfolio and closes, and leaves a saved draft alone", async () => {
    const { onBack, onClose, onCreated } = renderModal(sourceFor(DRAFT.rows));
    await clickPrimary(t.presetReviewCreate);
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onBack).not.toHaveBeenCalled();
    expect(state.retire).not.toHaveBeenCalled();
    expect(state.discard).not.toHaveBeenCalled();
  });

  it("with the funds in transit, only Close remains, which closes everything, and a saved draft stays", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    state.create.mockRejectedValue(new RealAllocateUnconfirmedError("x", "rec-1", "unconfirmed"));
    const { onBack, onClose } = renderModal(sourceFor(DRAFT.rows));
    await clickPrimary(t.presetReviewCreate);

    expect(state.discard).not.toHaveBeenCalled();
    expect(state.retire).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: t.presetReviewBack })).toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onBack).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: t.realAllocateClose }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(state.create).toHaveBeenCalledTimes(1);
  });

  it("Escape and a click outside go back, with the name as it stands here, so nothing built is lost", () => {
    const { onBack, onClose } = renderModal(sourceFor(DRAFT.rows));
    fireEvent.change(screen.getByLabelText(t.portfolioNameLabel), { target: { value: "Renamed" } });

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onBack).toHaveBeenLastCalledWith("Renamed");
    fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
    expect(onBack).toHaveBeenCalledTimes(2);
    expect(onBack).toHaveBeenLastCalledWith("Renamed");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("mid-signature nothing goes back either", async () => {
    state.create.mockImplementation(() => new Promise<void>(() => {}));
    const { onBack } = renderModal(sourceFor(DRAFT.rows));
    await clickPrimary(t.presetReviewCreate);
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
    expect(onBack).not.toHaveBeenCalled();
  });

  it("a mix from scratch is the user's own: no line about a starting point", () => {
    renderModal({ kind: "new", input: { name: "Mine", presetId: null, rows: DRAFT.rows } });
    expect(screen.queryByText(t.presetReviewNotAdvice)).toBeNull();
  });

  // Covered until now through the retired "create" mode of `AddFundsModal`.
  it("names each leg of the signature, as creating a portfolio", async () => {
    state.create.mockImplementation(() => new Promise<void>(() => {}));
    const { rerender } = renderModal(sourceFor(DRAFT.rows));
    await clickPrimary(t.presetReviewCreate);
    state.stage = "preparing";
    rerender();
    expect(screen.getByText(t.realStagePreparing)).toBeTruthy();
    state.stage = "awaiting-credit";
    rerender();
    expect(screen.getByText(t.realStageAwaitingCredit)).toBeTruthy();
    state.stage = null;
  });

  it("a draft saved before the 10-token cap is held back, and says why", () => {
    const ids = tokenRegistry.filter((token) => isPortfolioOfferable(token.id)).map((token) => token.id).slice(0, 11);
    const rows = ids.map((tokenId, i) => ({ tokenId, targetPct: i === 0 ? 50 : 5, tolerancePct: 10, locked: false }));
    renderModal(sourceFor(rows));
    expect(screen.getByText(editorTranslations.en.appTooManyTokens.replace("{max}", "10"))).toBeTruthy();
    expect((screen.getByRole("button", { name: t.presetReviewCreate }) as HTMLButtonElement).disabled).toBe(true);
  });

  it.each([
    ["an earlier transfer unconfirmed: it says so, and still lets the user create", [{ id: "rec-1", op: "setup", portfolioId: null }], true],
    ["nothing in transit: it says nothing", [], false],
  ])("%s", (_label, pending, shown) => {
    state.pending = pending;
    renderModal(sourceFor(DRAFT.rows));
    expect(screen.queryByText(t.pendingAllocateFundingNotice) !== null).toBe(shown);
    expect((screen.getByRole("button", { name: t.presetReviewCreate }) as HTMLButtonElement).disabled).toBe(false);
    state.pending = undefined;
  });

  // Covered until now, for this path, only by the retired "create" mode's own test.
  describe("a token outside the catalog (D-396, D-389)", () => {
    const DOGE = "nep141:doge.omft.near";

    it("is shown with no field, and never signed", async () => {
      state.available = new Map([["near", 5], [DOGE, 1000]]);
      renderModal(sourceFor(DRAFT.rows));
      expect(screen.getAllByRole("spinbutton")).toHaveLength(1);
      expect(screen.getByText("DOGE")).toBeTruthy();
      expect(screen.getByText(editorTranslations.en.addTokensNotAvailableYet)).toBeTruthy();

      await clickPrimary(t.presetReviewCreate);
      const changeset = state.create.mock.calls[0][1];
      expect(changeset.allocations.map((a: { tokenId: string }) => a.tokenId)).toEqual(["near"]);
    });

    it("alone in the account, there is nothing to sign, and it says so", () => {
      state.available = new Map([[DOGE, 1000]]);
      renderModal(sourceFor(DRAFT.rows));
      expect(screen.getByText(t.presetReviewNoFunds)).toBeTruthy();
      expect(screen.queryByText(t.presetReviewEnterAmount)).toBeNull();
      expect((screen.getByRole("button", { name: t.presetReviewCreate }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("a token with no buy route still comes in, to be converted (D-491)", () => {
      state.available = new Map([[MPDAO, 1000]]);
      renderModal(sourceFor(DRAFT.rows));
      expect(screen.getByRole("spinbutton", { name: /mpDAO/ })).toBeTruthy();
    });
  });
});

// D-569: the one door every new portfolio goes through. A mix with a stock that reached it another
// way (a draft saved before the block, the landing's preset) is not signed where stocks can't be bought.
describe("PresetReviewModal — where stocks can't be bought (D-569)", () => {
  const t = shellTranslations.en;
  const NVDA = "nep141:bnb-0xa9ee28c80f960b889dfbd1902055218cba016f75.omdep.near";
  const withStock: NewPortfolioDraft["rows"] = DRAFT.rows.map((row) => (row.tokenId === USDC ? { ...row, tokenId: NVDA } : row));
  const sourceFor = (rows: NewPortfolioDraft["rows"]): ReviewSource => ({
    kind: "new",
    input: { name: DRAFT.name, presetId: null, rows },
  });
  const createButton = () => screen.getByRole("button", { name: t.presetReviewCreate }) as HTMLButtonElement;
  beforeEach(resetFunds);
  afterEach(cleanup);

  it("holds back a mix with a stock, and says why", async () => {
    setCountry("US");
    renderModal(sourceFor(withStock));
    expect(screen.getByText(editorTranslations.en.stockRegionBlockedCreate)).toBeTruthy();
    expect(createButton().disabled).toBe(true);
    await clickPrimary(t.presetReviewCreate);
    expect(state.create).not.toHaveBeenCalled();
  });

  it("lets the same mix through from anywhere else (control)", () => {
    setCountry("AR");
    renderModal(sourceFor(withStock));
    expect(screen.queryByText(editorTranslations.en.stockRegionBlockedCreate)).toBeNull();
    expect(createButton().disabled).toBe(false);
  });

  it("does not hold back a mix without stocks", () => {
    setCountry("US");
    renderModal(sourceFor(DRAFT.rows));
    expect(screen.queryByText(editorTranslations.en.stockRegionBlockedCreate)).toBeNull();
    expect(createButton().disabled).toBe(false);
  });
});
