// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { translations as editorTranslations } from "@/features/portfolio-editor/lib/translations";
import { assertValidComposition, pctToBps } from "@/features/vault/lib/change-set-preflight";
import { toIntentsTokenId } from "@/features/market/lib/intents-token-id";
import type { PresetId } from "@/content/portfolio-presets";
import { readNewPortfolioDraft, type NewPortfolioDraft } from "../lib/new-portfolio-draft";
import { COUNTRY_COOKIE } from "@/features/stocks/lib/stock-region";
import { shellTranslations } from "../lib/translations";
import { SIMULATION_DEFAULT_USD } from "../lib/new-portfolio-draft-simulation";

// D-569: the cookie the middleware writes from Vercel's country header.
const setCountry = (code: string | null) => {
  document.cookie = code ? `${COUNTRY_COOKIE}=${code}; path=/` : `${COUNTRY_COOKIE}=; path=/; max-age=0`;
};
afterEach(() => setCountry(null));

// 016 block 2.2. The editor's contract: a preset loads exactly, "from scratch" starts empty,
// nothing invalid is ever saved, and what is saved is a composition the vault accepts —
// row by row what the screen showed. D-397: what its footer offers follows the funds.

const state = vi.hoisted(() => ({
  lang: "en" as "en" | "es",
  fundable: { status: "known", fundable: false, tokenIds: [], usd: 0 } as Record<string, unknown>,
  review: null as null | Record<string, unknown>,
}));
vi.mock("../hooks/use-fundable-general-balance", () => ({ useFundableGeneralBalance: () => state.fundable }));
vi.mock("./preset-review-modal", () => ({
  PresetReviewModal: (props: { onBack: (name: string) => void; onClose: () => void; onCreated?: () => void }) => {
    state.review = props;
    return (
      <div role="dialog" aria-label="funds-screen">
        <button type="button" onClick={() => props.onBack("Renamed there")}>funds-back</button>
      </div>
    );
  },
}));
vi.mock("../context/language-context", () => ({
  useLanguage: () => ({ lang: state.lang, setLang: vi.fn() }),
}));
vi.mock("@/features/login-wallet", () => ({ useLoginWallet: () => ({ intentsAccountId: "alice.near" }) }));
// Real quotes, so the D-358 simulation shows units and never reaches for the network.
vi.mock("@/features/market/hooks/use-token-prices", () => {
  const q = (usdPrice: number) => ({ symbol: "X", usdPrice, updatedAt: "", source: "chaindefuser" });
  return {
    useTokenPrices: () => ({
      prices: { "nep141:nbtc.bridge.near": q(80_000), "nep141:eth.bridge.near": q(4_000), near: q(5) },
      isLoading: false,
    }),
  };
});

import { NewPortfolioDraftEditor } from "./new-portfolio-draft-editor";

const BTC = "nep141:nbtc.bridge.near";
const ETH = "nep141:eth.bridge.near";
const NEAR = "near";

function renderEditor({
  presetId = "satoshi" as PresetId | null,
  existingNames = [] as string[],
  withBack = true,
  draft = undefined as NewPortfolioDraft | undefined,
  funded = undefined as boolean | null | undefined,
  signedOut = false,
  savedDraftName = null as string | null,
  balanceUnreadable = false,
} = {}) {
  const onSaved = vi.fn();
  const onBack = vi.fn();
  const onClose = vi.fn();
  const onCreated = vi.fn();
  const view = (fundedNow: boolean | null | undefined, savedNow: string | null = savedDraftName, draftNow: NewPortfolioDraft | null | undefined = draft) => (
    <NewPortfolioDraftEditor
      presetId={presetId}
      existingNames={existingNames}
      onSaved={onSaved}
      onBack={withBack ? onBack : undefined}
      onClose={onClose}
      draft={draftNow}
      funded={fundedNow}
      signedOut={signedOut}
      savedDraftName={savedNow}
      balanceUnreadable={balanceUnreadable}
      onCreated={onCreated}
    />
  );
  const { rerender } = render(view(funded));
  return {
    onSaved,
    onBack,
    onClose,
    onCreated,
    setFunded: (next: boolean | null) => rerender(view(next)),
    setSavedDraft: (next: string | null) => rerender(view(funded, next)),
    discardResumed: () => rerender(view(funded, savedDraftName, null)),
  };
}

const stored = () => readNewPortfolioDraft("alice.near");

describe.each(["en", "es"] as const)("NewPortfolioDraftEditor (%s)", (lang) => {
  const t = shellTranslations[lang];
  const te = editorTranslations[lang];
  const pctInput = (symbol: string) => screen.getByLabelText(`${te.target} ${symbol}`) as HTMLInputElement;
  const tolInput = (symbol: string) => screen.getByLabelText(`${te.band} ${symbol}`) as HTMLInputElement;
  const saveButton = () => screen.getByRole("button", { name: t.draftSaveDraft });
  const createButton = () => screen.getByRole("button", { name: t.draftCreate });
  const blocker = () => document.getElementById("draft-editor-blocker")?.textContent ?? null;

  beforeEach(() => {
    state.lang = lang;
    state.review = null;
    state.fundable = { status: "known", fundable: false, tokenIds: [], usd: 0 };
    window.localStorage.clear();
  });
  afterEach(cleanup);

  // D-397 (plan 041, P1): the table of the plan, one row each.
  describe("the footer follows the funds", () => {
    const saved = () => screen.queryByRole("button", { name: t.draftSaveDraft });
    const created = () => screen.queryByRole("button", { name: t.draftCreate });

    it("signed out: 'Create portfolio' saves, as ever, and nothing else is offered", () => {
      const { onSaved } = renderEditor({ signedOut: true, funded: true });
      expect(saved()).toBeNull();
      fireEvent.click(createButton());
      expect(onSaved).toHaveBeenCalledTimes(1);
      expect(state.review).toBeNull();
    });

    it("with a wallet and no funds: only 'Save draft'", () => {
      const { onSaved } = renderEditor({ funded: false });
      expect(created()).toBeNull();
      fireEvent.click(saveButton());
      expect(onSaved).toHaveBeenCalledTimes(1);
      expect(stored()?.name).toBe(t.presetSatoshiName);
    });

    it("with funds: 'Create portfolio' opens the funds screen with the mix, and saves nothing", () => {
      const { onSaved } = renderEditor({ funded: true });
      fireEvent.click(createButton());
      expect(screen.getByRole("dialog", { name: "funds-screen" })).toBeTruthy();
      expect(onSaved).not.toHaveBeenCalled();
      expect(stored()).toBeNull();
      const source = state.review?.source as { kind: string; input: { name: string; rows: { tokenId: string }[] } };
      expect(source.kind).toBe("new");
      expect(source.input.name).toBe(t.presetSatoshiName);
      expect(source.input.rows.map((r) => r.tokenId)).toEqual([BTC, ETH, NEAR]);
    });

    it("with funds: 'Save draft' is the other action, and it saves", () => {
      const { onSaved } = renderEditor({ funded: true });
      fireEvent.click(saveButton());
      expect(onSaved).toHaveBeenCalledTimes(1);
      expect(state.review).toBeNull();
      expect(stored()?.rows).toHaveLength(3);
    });

    it("hands the funds screen the landing and the way to close the flow", () => {
      const { onClose, onCreated } = renderEditor({ funded: true });
      fireEvent.click(createButton());
      expect(state.review?.onClose).toBe(onClose);
      expect(state.review?.onCreated).toBe(onCreated);
    });

    it.each([
      ["still being read", false, () => t.draftCheckingBalance],
      ["unreadable", true, () => t.myAccountBalanceUnreadable],
    ])("with the balance %s: creating is blocked, with the reason, and saving is not", (_label, balanceUnreadable, reason) => {
      const { onSaved } = renderEditor({ funded: null, balanceUnreadable });
      expect(blocker()).toBe(reason());
      expect(createButton().getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(createButton());
      expect(state.review).toBeNull();
      fireEvent.click(saveButton());
      expect(onSaved).toHaveBeenCalledTimes(1);
    });

    it("an invalid mix blocks both, and 'Create portfolio' takes the user to the problem", () => {
      renderEditor({ presetId: null, funded: true });
      expect(createButton().getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(createButton());
      expect(state.review).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole("button", { name: t.draftAddToken }));
      fireEvent.click(saveButton());
      expect(stored()).toBeNull();
    });

    it("resuming a saved draft has one action, even with funds: it saves", () => {
      const draft = { v: 1 as const, name: "Mine", presetId: null, updatedAt: 1, rows: [{ tokenId: NEAR, targetPct: 100, tolerancePct: 10, locked: false }] };
      const { onSaved } = renderEditor({ draft, funded: true });
      expect(created()).toBeNull();
      fireEvent.click(saveButton());
      expect(onSaved).toHaveBeenCalledTimes(1);
    });

    // A discard from another tab leaves the form as it is, and saving writes it again.
    it("a resumed draft discarded elsewhere stays what it was: one action, saving", () => {
      const draft = { v: 1 as const, name: "Mine", presetId: null, updatedAt: 1, rows: [{ tokenId: NEAR, targetPct: 100, tolerancePct: 10, locked: false }] };
      const { discardResumed, onSaved } = renderEditor({ draft, funded: true });
      discardResumed();
      expect(created()).toBeNull();
      fireEvent.click(saveButton());
      expect(onSaved).toHaveBeenCalledTimes(1);
    });

    it("the actions follow the balance while the editor is open", () => {
      const { setFunded } = renderEditor({ funded: false });
      expect(created()).toBeNull();
      setFunded(true);
      expect(created()).toBeTruthy();
      expect(saved()).toBeTruthy();
      setFunded(false);
      expect(created()).toBeNull();
      expect(saved()).toBeTruthy();
    });
  });

  // D-397 (plan 041, P2): a mix built beside a saved draft never replaces it.
  describe("with a draft saved", () => {
    const savedLine = () => t.draftAlreadySaved.replace("{name}", "My mix");

    it("names it, and does not offer to save", () => {
      renderEditor({ funded: true, savedDraftName: "My mix" });
      expect(screen.getByText(savedLine())).toBeTruthy();
      expect(screen.queryByRole("button", { name: t.draftSaveDraft })).toBeNull();
      fireEvent.click(createButton());
      expect(state.review).not.toBeNull();
    });

    it("the balance falling to zero blocks creating, and still offers no way to replace it", () => {
      const { setFunded, onSaved } = renderEditor({ funded: true, savedDraftName: "My mix" });
      setFunded(false);
      expect(screen.queryByRole("button", { name: t.draftSaveDraft })).toBeNull();
      expect(blocker()).toBe(t.presetReviewNoFunds);
      fireEvent.click(createButton());
      expect(state.review).toBeNull();
      expect(onSaved).not.toHaveBeenCalled();
      expect(stored()).toBeNull();
    });

    it("a draft saved from another tab while the editor is open stops the offer to save", () => {
      const { setSavedDraft } = renderEditor({ funded: true });
      expect(screen.getByRole("button", { name: t.draftSaveDraft })).toBeTruthy();
      setSavedDraft("My mix");
      expect(screen.queryByRole("button", { name: t.draftSaveDraft })).toBeNull();
      expect(screen.getByText(savedLine())).toBeTruthy();
    });

    it("with the balance not read yet, creating is blocked and saving still is not offered", () => {
      renderEditor({ funded: null, savedDraftName: "My mix" });
      expect(blocker()).toBe(t.draftCheckingBalance);
      expect(screen.queryByRole("button", { name: t.draftSaveDraft })).toBeNull();
      expect(createButton().getAttribute("aria-disabled")).toBe("true");
    });

    it("a name with a replacement pattern reads as typed", () => {
      renderEditor({ funded: true, savedDraftName: "US$& mix" });
      expect(screen.getByText(t.draftAlreadySaved.replace("{name}", () => "US$& mix"))).toBeTruthy();
    });

    it("the name it suggests avoids the draft's", () => {
      renderEditor({ funded: true, savedDraftName: t.presetSatoshiName });
      expect((screen.getByLabelText(t.portfolioNameLabel) as HTMLInputElement).value).toBe(`${t.presetSatoshiName} 2`);
    });
  });

  // D-397 (plan 041): the funds screen is another view of this dialog.
  describe("coming back from the funds screen", () => {
    it("finds everything as it was, with the name changed there, and the focus on the main button", () => {
      renderEditor({ presetId: "satoshi", funded: true });
      fireEvent.change(pctInput("nBTC"), { target: { value: "60" } });
      const edited = [pctInput("nBTC").value, pctInput("ETH").value, pctInput("NEAR").value];
      fireEvent.click(createButton());
      expect(screen.queryByLabelText(`${te.target} nBTC`)).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "funds-back" }));

      expect((screen.getByLabelText(t.portfolioNameLabel) as HTMLInputElement).value).toBe("Renamed there");
      expect([pctInput("nBTC").value, pctInput("ETH").value, pctInput("NEAR").value]).toEqual(edited);
      expect(document.activeElement).toBe(createButton());
    });
  });

  // D-397 (plan 041, P4).
  describe("Add token marks what the funding account holds", () => {
    const openPicker = () => fireEvent.click(screen.getByRole("button", { name: t.draftAddToken }));
    const rowOf = (name: string) => screen.getByRole("button", { name: new RegExp(`${name}$`) }).closest("li")!;

    it("only the fundable tokens, and in the same words in both languages' table", () => {
      state.fundable = { status: "known", fundable: true, tokenIds: [NEAR], usd: 5 };
      renderEditor({ presetId: null, funded: true });
      openPicker();
      expect(within(rowOf("NEAR Protocol")).getByText(t.draftPickerInFundingAccount)).toBeTruthy();
      expect(screen.getAllByText(t.draftPickerInFundingAccount)).toHaveLength(1);
    });

    it.each([
      ["while it is read", { status: "loading" }],
      ["when it is unreadable", { status: "error", retry: () => {} }],
      ["with nothing fundable", { status: "known", fundable: false, tokenIds: [], usd: 0 }],
    ])("marks nothing %s", (_label, fundable) => {
      state.fundable = fundable;
      renderEditor({ presetId: null });
      openPicker();
      expect(screen.queryByText(t.draftPickerInFundingAccount)).toBeNull();
    });
  });

  it("loads a preset exactly: rows, %, its tolerance, its name, its origin", () => {
    renderEditor({ presetId: "satoshi" });
    expect(pctInput("nBTC").value).toBe("70");
    expect(pctInput("ETH").value).toBe("20");
    expect(pctInput("NEAR").value).toBe("10");
    for (const s of ["nBTC", "ETH", "NEAR"]) expect(tolInput(s).value).toBe("10");
    expect((screen.getByLabelText(t.portfolioNameLabel) as HTMLInputElement).value).toBe(t.presetSatoshiName);
    expect(screen.getByText(t.draftBasedOnPreset.replace("{preset}", t.presetSatoshiName))).toBeTruthy();
    expect(saveButton().getAttribute("aria-disabled")).toBe("false");
  });

  // D-400: the same editor is the way in with funds and without.
  it("says the draft waits on a deposit only when there are no funds for it", () => {
    renderEditor({ presetId: "satoshi" });
    expect(screen.getByText(t.draftEditorSubtitle)).toBeTruthy();
    expect(screen.queryByText(t.draftEditorSubtitleFunded)).toBeNull();

    cleanup();
    renderEditor({ presetId: "satoshi", funded: true });
    expect(screen.getByText(t.draftEditorSubtitleFunded)).toBeTruthy();
    expect(screen.queryByText(t.draftEditorSubtitle)).toBeNull();
  });

  it("from scratch: empty, 'Portfolio N', and save blocked until a token is added", () => {
    const { onSaved } = renderEditor({ presetId: null, existingNames: ["Mine"] });
    expect(screen.queryByRole("list")).toBeNull();
    expect((screen.getByLabelText(t.portfolioNameLabel) as HTMLInputElement).value).toBe("Portfolio 2");
    expect(blocker()).toBe(te.ruleEmptyComposition);
    expect(saveButton().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(saveButton());
    expect(onSaved).not.toHaveBeenCalled();
    expect(stored()).toBeNull();
    // The blocked button takes the user to what is missing.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: t.draftAddToken }));
  });

  it("typing a % re-spreads the others, as in Composition; ',' is a decimal separator", () => {
    renderEditor();
    fireEvent.focus(pctInput("nBTC"));
    fireEvent.change(pctInput("nBTC"), { target: { value: "60" } });
    fireEvent.blur(pctInput("nBTC"));
    expect([pctInput("nBTC").value, pctInput("ETH").value, pctInput("NEAR").value]).toEqual(["60", "26.67", "13.33"]);
    fireEvent.focus(pctInput("nBTC"));
    fireEvent.change(pctInput("nBTC"), { target: { value: "60,5" } });
    expect(pctInput("nBTC").value).toBe("60.5");
  });

  it("the simulation follows the mix as it is edited, and its amount is saved with the draft (D-358, D-457)", () => {
    renderEditor();
    const simulated = () =>
      within(screen.getByRole("list", { name: t.draftSimListLabel }))
        .getAllByRole("listitem")
        .map((li) => li.textContent);
    expect(simulated()).toEqual(["nBTC0.0875≈ $7,000.00", "ETH0.5≈ $2,000.00", "NEAR200≈ $1,000.00"]);
    // D-504: the Simulation's note replaces the "not financial advice" line in the editor.
    expect(screen.getByText(t.draftSimNote)).toBeTruthy();
    expect(screen.queryByText(t.presetReviewNotAdvice)).toBeNull();
    fireEvent.focus(pctInput("nBTC"));
    fireEvent.change(pctInput("nBTC"), { target: { value: "60" } });
    fireEvent.blur(pctInput("nBTC"));
    expect(simulated()).toEqual(["nBTC0.075≈ $6,000.00", "ETH0.66675≈ $2,667.00", "NEAR266.6≈ $1,333.00"]);
    fireEvent.change(screen.getByLabelText(t.draftSimAmountLabel), { target: { value: "10" } });
    fireEvent.click(saveButton());
    expect(stored()?.simulationUsd).toBe(10);
  });

  it("D-457: the amount alone is not an unsaved change, and leaving drops it", () => {
    const { onBack } = renderEditor();
    fireEvent.change(screen.getByLabelText(t.draftSimAmountLabel), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: t.presetReviewBack }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(stored()).toBeNull();
  });

  it("a row at 0% blocks the save and names the token", () => {
    const { onSaved } = renderEditor();
    fireEvent.focus(pctInput("nBTC"));
    fireEvent.change(pctInput("nBTC"), { target: { value: "100" } });
    fireEvent.blur(pctInput("nBTC"));
    expect(blocker()).toBe(`ETH: ${t.draftTargetNotPositive}`);
    expect(pctInput("ETH").getAttribute("aria-invalid")).toBe("true");
    fireEvent.click(saveButton());
    expect(onSaved).not.toHaveBeenCalled();
    expect(stored()).toBeNull();
    expect(document.activeElement).toBe(pctInput("ETH"));
  });

  it("a tolerance out of range blocks the save and takes focus to it", () => {
    const { onSaved } = renderEditor();
    fireEvent.change(tolInput("NEAR"), { target: { value: "1" } });
    expect(blocker()).toBe(`NEAR: ${te.ruleToleranceBelowMin}`);
    expect(tolInput("NEAR").getAttribute("aria-invalid")).toBe("true");
    fireEvent.click(saveButton());
    expect(onSaved).not.toHaveBeenCalled();
    expect(stored()).toBeNull();
    expect(document.activeElement).toBe(tolInput("NEAR"));
    fireEvent.change(tolInput("NEAR"), { target: { value: "31" } });
    expect(blocker()).toBe(`NEAR: ${te.ruleToleranceAboveMax}`);
  });

  it("an empty or duplicate name blocks the save", () => {
    const { onSaved } = renderEditor({ existingNames: ["Other"] });
    const name = screen.getByLabelText(t.portfolioNameLabel);
    fireEvent.change(name, { target: { value: "  " } });
    expect(blocker()).toBe(t.portfolioNameEmpty);
    fireEvent.change(name, { target: { value: "other" } });
    expect(blocker()).toBe(t.portfolioNameDuplicate);
    expect(name.getAttribute("aria-invalid")).toBe("true");
    fireEvent.click(saveButton());
    expect(onSaved).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(name);
  });

  it("saves exactly what the screen shows, and the vault's check accepts it", () => {
    const { onSaved } = renderEditor();
    fireEvent.focus(pctInput("nBTC"));
    fireEvent.change(pctInput("nBTC"), { target: { value: "60" } });
    fireEvent.blur(pctInput("nBTC"));
    fireEvent.change(tolInput("ETH"), { target: { value: "14" } });
    fireEvent.change(screen.getByLabelText(t.portfolioNameLabel), { target: { value: " Mine " } });
    fireEvent.click(saveButton());

    expect(onSaved).toHaveBeenCalledTimes(1);
    const draft = stored();
    expect(draft).toMatchObject({
      name: "Mine",
      presetId: "satoshi",
      rows: [
        { tokenId: BTC, targetPct: 60, tolerancePct: 10, locked: false },
        { tokenId: ETH, targetPct: 26.67, tolerancePct: 14, locked: false },
        { tokenId: NEAR, targetPct: 13.33, tolerancePct: 10, locked: false },
      ],
    });
    expect(() =>
      assertValidComposition(
        draft!.rows.map((r) => ({
          tokenId: toIntentsTokenId(r.tokenId),
          targetBps: pctToBps(r.targetPct),
          toleranceBps: pctToBps(r.tolerancePct),
        }))
      )
    ).not.toThrow();
  });

  it("adds a token from the picker with an equal share of the free part and the preset tolerance", () => {
    renderEditor({ presetId: "balanced" });
    fireEvent.click(screen.getByRole("button", { name: t.draftAddToken }));
    fireEvent.change(screen.getByLabelText(te.searchToken), { target: { value: "base" } });
    const toggle = screen.getByRole("button", { name: `${te.addTokensAddAction} USDC(BASE) — USDC (on Base)` });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: t.presetReviewBack }));

    // Balanced has 5 free rows: the sixth takes 100 / 6.
    expect(pctInput("USDC(BASE)").value).toBe("16.67");
    expect(tolInput("USDC(BASE)").value).toBe("8");
    // Back from the picker, focus returns to "+ Add token".
    expect(document.activeElement).toBe(screen.getByRole("button", { name: t.draftAddToken }));
  });

  it("shows a token outside the catalog (D-396) as not available, with nothing to add", () => {
    renderEditor({ presetId: "balanced" });
    fireEvent.click(screen.getByRole("button", { name: t.draftAddToken }));
    fireEvent.change(screen.getByLabelText(te.searchToken), { target: { value: "dai" } });
    expect(screen.getByText("Dai Stablecoin (on Ethereum)")).toBeTruthy();
    expect(screen.getByText(te.addTokensNotAvailableYet)).toBeTruthy();
    expect(screen.queryByRole("button", { name: new RegExp(`^${te.addTokensAddAction} DAI`) })).toBeNull();
  });

  // D-558: a stock stays marked once it is in the mix, and an ETF says so.
  it("marks the stocks in the composition, and only them", () => {
    renderEditor({ presetId: "nearStocks" });
    expect(screen.getAllByText(te.stockChipStock)).toHaveLength(2);
    expect(screen.getAllByText(te.stockChipEtf)).toHaveLength(1);
  });

  // D-558: the same list as a portfolio's "Add tokens": the stocks lead, with their note once.
  it("lists the stocks first in the token picker", () => {
    renderEditor({ presetId: "balanced" });
    fireEvent.click(screen.getByRole("button", { name: t.draftAddToken }));
    const stocks = within(screen.getByRole("list", { name: te.stockSectionTitle })).getAllByRole("listitem");
    expect(stocks.map((li) => li.querySelector("span.font-semibold")?.textContent)).toEqual([
      "AAPL",
      "AMZN",
      "GOOGL",
      "METAon",
      "MSFT",
      "NVDA",
      "QQQ",
      "TSLA",
    ]);
    expect(screen.getAllByText(te.stockSectionNote)).toHaveLength(1);
  });

  // D-569: where stocks can't be bought, the picker lists them last and offers none of them.
  it("where stocks can't be bought, lists the stocks last and offers none", () => {
    setCountry("US");
    renderEditor({ presetId: "balanced" });
    fireEvent.click(screen.getByRole("button", { name: t.draftAddToken }));
    const lists = screen.getAllByRole("list");
    expect(lists[lists.length - 1]).toBe(screen.getByRole("list", { name: te.stockSectionTitle }));
    expect(screen.getAllByText(te.stockRegionBlockedNote)).toHaveLength(1);
    expect(screen.queryByRole("button", { name: new RegExp(`^${te.addTokensAddAction} NVDA`) })).toBeNull();
    expect(screen.getByRole("button", { name: `${te.addTokensAddAction} USDC(BASE) — USDC (on Base)` })).toBeTruthy();
  });

  it("where stocks can't be bought, a stock already in the mix can still be taken out, not put back", () => {
    setCountry("US");
    renderEditor({ presetId: "nearStocks" });
    fireEvent.click(screen.getByRole("button", { name: t.draftAddToken }));
    const nvda = screen.getByRole("button", { name: `${te.addTokensAddAction} NVDA — NVIDIA (Ondo)` });
    expect(nvda.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(nvda);
    expect(screen.queryByRole("button", { name: `${te.addTokensAddAction} NVDA — NVIDIA (Ondo)` })).toBeNull();
  });

  // D-569: a mix that already holds stocks says so from the first screen, and goes nowhere until
  // they are taken out: neither saved, nor on to the funds.
  it("where stocks can't be bought, a mix with stocks says so at the top and can't be saved or created", () => {
    setCountry("US");
    const { onSaved } = renderEditor({ presetId: "techTitans", signedOut: true });
    const notes = screen.getAllByText(te.stockRegionBlockedCreate);
    expect(notes[0].getAttribute("role")).toBe("status");
    expect(notes[0].compareDocumentPosition(screen.getByLabelText(t.portfolioNameLabel)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const create = screen.getByRole("button", { name: t.draftCreate });
    expect(create.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(create);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("where stocks can't be bought, a mix with funds does not go on to them while it holds stocks", () => {
    setCountry("CA");
    renderEditor({ presetId: "nearStocks", funded: true });
    fireEvent.click(screen.getByRole("button", { name: t.draftCreate }));
    expect(screen.getByRole("button", { name: t.draftCreate })).toBeTruthy();
    expect(screen.getAllByText(te.stockRegionBlockedCreate).length).toBeGreaterThan(0);
  });

  it("a mix with stocks saves as always from anywhere else (control)", () => {
    setCountry("AR");
    const { onSaved } = renderEditor({ presetId: "techTitans", signedOut: true });
    expect(screen.queryByText(te.stockRegionBlockedCreate)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: t.draftCreate }));
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("shows ZEC, in the catalog but not withdrawable yet (D-389), as not available", () => {
    renderEditor({ presetId: "balanced" });
    fireEvent.click(screen.getByRole("button", { name: t.draftAddToken }));
    fireEvent.change(screen.getByLabelText(te.searchToken), { target: { value: "zec" } });
    const zec = screen.getByRole("listitem");
    expect(zec.textContent).toContain(te.addTokensNotAvailableYet);
    expect(within(zec).queryByRole("button")).toBeNull();
  });

  it("removing a row re-spreads its % and moves focus to a neighbour's remove", () => {
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: `${t.presetReviewRemoveToken} NEAR` }));
    expect(screen.queryByLabelText(`${te.target} NEAR`)).toBeNull();
    expect([pctInput("nBTC").value, pctInput("ETH").value]).toEqual(["77.78", "22.22"]);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: `${t.presetReviewRemoveToken} ETH` }));
  });

  it("one token left is 100% with no % field and no lock", () => {
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: `${t.presetReviewRemoveToken} NEAR` }));
    fireEvent.click(screen.getByRole("button", { name: `${t.presetReviewRemoveToken} ETH` }));
    expect(screen.queryByLabelText(`${te.target} nBTC`)).toBeNull();
    expect(screen.getByText("100%")).toBeTruthy();
    expect(screen.queryByRole("button", { name: new RegExp(`${te.unlocked} nBTC`) })).toBeNull();
  });

  it("the lock keeps two rows free: the third lock is refused with the reason", () => {
    renderEditor();
    const lockBtc = screen.getByRole("button", { name: `${te.unlocked} nBTC` });
    fireEvent.click(lockBtc);
    expect(lockBtc.getAttribute("aria-pressed")).toBe("true");
    expect(pctInput("nBTC").disabled).toBe(true);

    const lockEth = screen.getByRole("button", { name: `${te.unlocked} ETH` });
    expect(lockEth.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(lockEth);
    expect(lockEth.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getAllByText(t.draftMinTwoUnlocked).length).toBeGreaterThan(0);
  });

  it("a % above what the locks leave shows the cap at once, with the reason", () => {
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: `${te.unlocked} nBTC` }));
    fireEvent.focus(pctInput("ETH"));
    fireEvent.change(pctInput("ETH"), { target: { value: "50" } });
    expect(pctInput("ETH").value).toBe("30");
    expect(pctInput("NEAR").value).toBe("0");
    expect(screen.getByText(te.maxAtLockedCeiling)).toBeTruthy();
  });

  it("E2: a removal that leaves one free row releases the locks and says so", () => {
    renderEditor({ presetId: "balanced" });
    fireEvent.click(screen.getByRole("button", { name: `${te.unlocked} nBTC` }));
    fireEvent.click(screen.getByRole("button", { name: `${te.unlocked} ETH` }));
    fireEvent.click(screen.getByRole("button", { name: `${te.unlocked} USDC(NEAR)` }));
    // BTC, ETH, USDC locked; NEAR and SOL free. Removing SOL leaves one free row.
    fireEvent.click(screen.getByRole("button", { name: `${t.presetReviewRemoveToken} SOL` }));
    expect(screen.getAllByText(t.draftLocksReleased).length).toBeGreaterThan(0);
    // Announced too: the polite region is the only non-visual channel for it.
    expect(within(screen.getByRole("dialog")).getByRole("status").textContent).toBe(t.draftLocksReleased);
    for (const s of ["nBTC", "ETH", "USDC(NEAR)", "NEAR"]) {
      expect(screen.getByRole("button", { name: `${te.unlocked} ${s}` }).getAttribute("aria-pressed")).toBe("false");
    }
  });

  describe("E3: leaving with unsaved changes asks in the footer", () => {
    it("an untouched preset goes back at once", () => {
      const { onBack } = renderEditor();
      fireEvent.click(screen.getByRole("button", { name: t.presetReviewBack }));
      expect(onBack).toHaveBeenCalledTimes(1);
    });

    it("with changes: 'Keep editing' stays, 'Discard changes' goes back", () => {
      const { onBack } = renderEditor();
      fireEvent.change(tolInput("nBTC"), { target: { value: "12" } });
      fireEvent.click(screen.getByRole("button", { name: t.presetReviewBack }));
      expect(onBack).not.toHaveBeenCalled();
      const group = screen.getByRole("group", { name: t.unsavedChangesTitle });
      expect(document.activeElement).toBe(within(group).getByRole("button", { name: t.draftKeepEditing }));

      fireEvent.click(within(group).getByRole("button", { name: t.draftKeepEditing }));
      expect(screen.queryByRole("group", { name: t.unsavedChangesTitle })).toBeNull();
      expect(tolInput("nBTC").value).toBe("12");

      fireEvent.click(screen.getByRole("button", { name: t.presetReviewBack }));
      fireEvent.click(screen.getByRole("button", { name: t.unsavedChangesDiscard }));
      expect(onBack).toHaveBeenCalledTimes(1);
      expect(stored()).toBeNull();
    });

    it("Escape with changes asks too, and then closes", () => {
      const { onClose } = renderEditor();
      fireEvent.change(tolInput("nBTC"), { target: { value: "12" } });
      fireEvent.keyDown(document, { key: "Escape" });
      expect(onClose).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: t.unsavedChangesDiscard }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("Escape in the picker returns to the editor, not out", () => {
      const { onClose } = renderEditor();
      fireEvent.click(screen.getByRole("button", { name: t.draftAddToken }));
      fireEvent.keyDown(document, { key: "Escape" });
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByRole("heading", { name: t.draftEditorTitle })).toBeTruthy();
    });
  });

  describe("resuming a saved draft", () => {
    const saved: NewPortfolioDraft = {
      v: 1,
      name: "My mix",
      presetId: null,
      rows: [
        { tokenId: BTC, targetPct: 70, tolerancePct: 10, locked: false },
        { tokenId: ETH, targetPct: 20, tolerancePct: 10, locked: false },
        { tokenId: NEAR, targetPct: 10, tolerancePct: 10, locked: false },
      ],
      updatedAt: 1,
    };

    it("D-457: opens the simulation on the saved amount, and on the default without one", () => {
      const amount = () => (screen.getByLabelText(t.draftSimAmountLabel) as HTMLInputElement).value;
      renderEditor({ draft: { ...saved, simulationUsd: 10 } });
      expect(amount()).toBe("10");
      cleanup();
      renderEditor({ draft: saved });
      expect(amount()).toBe(SIMULATION_DEFAULT_USD.toLocaleString("en-US"));
    });
  });

  it("without onBack the secondary button cancels", () => {
    const { onClose } = renderEditor({ withBack: false });
    fireEvent.click(screen.getByRole("button", { name: t.cancel }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // 019-4: "Create portfolio" saves and nothing more — where it lands is the caller's (the
  // draft's tab), and the deposit is a button there, not the editor's promise.
  it("the main button is Create portfolio and it only saves", () => {
    const { onSaved, onClose } = renderEditor();
    fireEvent.click(saveButton());
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(stored()?.presetId).toBe("satoshi");
    expect(screen.queryByRole("button", { name: new RegExp(t.draftCardDeposit, "i") })).toBeNull();
  });
});
