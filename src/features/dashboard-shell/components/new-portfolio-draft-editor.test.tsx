// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { translations as editorTranslations } from "@/features/portfolio-editor/lib/translations";
import { assertValidComposition, pctToBps } from "@/features/vault/lib/change-set-preflight";
import { toIntentsTokenId } from "@/features/market/lib/intents-token-id";
import type { PresetId } from "@/content/portfolio-presets";
import { readNewPortfolioDraft, type NewPortfolioDraft } from "../lib/new-portfolio-draft";
import { shellTranslations } from "../lib/translations";
import { SIMULATION_DEFAULT_USD } from "../lib/new-portfolio-draft-simulation";

// 016 block 2.2. The editor's contract: a preset loads exactly, "from scratch" starts empty,
// nothing invalid is ever saved, and what is saved is a composition the vault accepts —
// row by row what the screen showed.

const state = vi.hoisted(() => ({ lang: "en" as "en" | "es" }));
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
  funded = undefined as boolean | undefined,
} = {}) {
  const onSaved = vi.fn();
  const onBack = vi.fn();
  const onClose = vi.fn();
  render(
    <NewPortfolioDraftEditor
      presetId={presetId}
      existingNames={existingNames}
      onSaved={onSaved}
      onBack={withBack ? onBack : undefined}
      onClose={onClose}
      draft={draft}
      funded={funded}
    />
  );
  return { onSaved, onBack, onClose };
}

const stored = () => readNewPortfolioDraft("alice.near");

describe.each(["en", "es"] as const)("NewPortfolioDraftEditor (%s)", (lang) => {
  const t = shellTranslations[lang];
  const te = editorTranslations[lang];
  const pctInput = (symbol: string) => screen.getByLabelText(`${te.target} ${symbol}`) as HTMLInputElement;
  const tolInput = (symbol: string) => screen.getByLabelText(`${te.band} ${symbol}`) as HTMLInputElement;
  const saveButton = () => screen.getByRole("button", { name: t.draftCreate });
  const blocker = () => document.getElementById("draft-editor-blocker")?.textContent ?? null;

  beforeEach(() => {
    state.lang = lang;
    window.localStorage.clear();
  });
  afterEach(cleanup);

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
