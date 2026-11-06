// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { translations as editorTranslations } from "@/features/portfolio-editor/lib/translations";
import { shellTranslations } from "../lib/translations";

const state = vi.hoisted(() => ({ lang: "en" as "en" | "es" }));

vi.mock("../context/language-context", () => ({
  useLanguage: () => ({ lang: state.lang, setLang: vi.fn() }),
}));

import { PresetSelectionModal } from "./preset-selection-modal";

function cardFor(name: string): HTMLElement {
  // Escaped: "NEAR + Stocks" holds a "+".
  return screen.getByRole("button", { name: new RegExp(`^${name.replace(/[+]/g, "\\+")}`) });
}

// 016 1.4 / T6 + Q6: the badge and the descriptor chip each sit on exactly one card, and the
// "±N% tolerance" on every card has one explanation above the grid.
describe.each(["en", "es"] as const)("PresetSelectionModal (%s)", (lang) => {
  const t = shellTranslations[lang];

  beforeEach(() => {
    state.lang = lang;
    render(<PresetSelectionModal onClose={vi.fn()} onSelectPreset={vi.fn()} onSelectScratch={vi.fn()} />);
  });
  afterEach(cleanup);

  it("marks only the balanced preset as a good starting point", () => {
    expect(screen.getAllByText(t.presetStartingPointBadge)).toHaveLength(1);
    expect(cardFor(t.presetBalancedName).textContent).toContain(t.presetStartingPointBadge);
  });

  it("tags Pioneers as BTC and ETH, with no beginner badge", () => {
    expect(screen.getAllByText(t.presetPioneersTag)).toHaveLength(1);
    expect(cardFor(t.presetPioneersName).textContent).not.toContain(t.presetStartingPointBadge);
  });

  it("tags only Satoshi as BTC-heavy", () => {
    expect(screen.getAllByText(t.presetSatoshiTag)).toHaveLength(1);
    expect(cardFor(t.presetSatoshiName).textContent).toContain(t.presetSatoshiTag);
  });

  // The chooser opens on a card, not on the tolerance "?", whose tooltip would otherwise open
  // over the grid every time. D-558: the first stock card, which also keeps the stocks in view
  // at 390 px.
  it("opens with focus on the first stock card, so the tolerance tooltip stays closed", () => {
    expect(document.activeElement).toBe(cardFor(t.presetBigTechName));
  });

  // D-558: the presets holding stocks lead, marked, with their note once.
  it("shows the stock presets first, in their own block with the note", () => {
    const block = screen.getByRole("region", { name: t.presetStocksTitle });
    const cards = within(block).getAllByRole("button");
    expect(cards.map((card) => card.textContent)).toEqual([
      expect.stringContaining(t.presetBigTechName),
      expect.stringContaining(t.presetNearStocksName),
    ]);
    expect(block.textContent).toContain(editorTranslations[lang].stockSectionNote);
    const all = screen.getAllByRole("button").filter((b) => b.textContent?.includes(t.presetBandLabel));
    expect(all[0]).toBe(cards[0]);
    expect(all[1]).toBe(cards[1]);
    expect(all).toHaveLength(8);
    for (const card of cards) {
      expect(card.textContent).toContain(t.presetStocksChip);
      expect(card.className).toContain("border-fuchsia-300/60");
    }
  });

  it("leaves the other presets unmarked, and the starting point on Balanced", () => {
    const card = cardFor(t.presetBalancedName);
    expect(card.textContent).not.toContain(t.presetStocksChip);
    expect(card.className).toContain("border-slate-700");
    expect(card.className).not.toContain("fuchsia");
    expect(cardFor(t.presetBigTechName).textContent).not.toContain(t.presetStartingPointBadge);
  });

  it("lists the stocks first inside a card and names each one for screen readers", () => {
    const card = cardFor(t.presetNearStocksName);
    const text = card.textContent ?? "";
    expect(text.indexOf("NVDA")).toBeLessThan(text.indexOf("NEAR 40%"));
    expect(text).toContain(`${editorTranslations[lang].stockChipEtf}: QQQ 20%`);
    expect(text).toContain(`${editorTranslations[lang].stockChipStock}: NVDA 20%`);
  });

  // 021 R6: every preset card shows its risk as a colored bar, and says the level in words.
  it.each([
    ["presetStablesName", "presetRiskVeryLow", "bg-emerald-400"],
    ["presetConservativeName", "presetRiskLow", "bg-emerald-400"],
    ["presetBalancedName", "presetRiskMedium", "bg-amber-400"],
    ["presetSatoshiName", "presetRiskHigh", "bg-orange-400"],
    ["presetPioneersName", "presetRiskHigh", "bg-orange-400"],
    ["presetAggressiveName", "presetRiskVeryHigh", "bg-orange-400"],
  ] as const)("shows the risk of %s as %s", (nameKey, levelKey, color) => {
    const card = cardFor(t[nameKey]);
    expect(card.textContent).toContain(`${t.presetRiskLabel}: ${t[levelKey]}`);
    expect(card.querySelector("[data-risk] .block")?.className).toContain(color);
  });

  it("draws a longer bar the higher the risk", () => {
    const widths = (
      ["presetStablesName", "presetConservativeName", "presetBalancedName", "presetSatoshiName", "presetAggressiveName"] as const
    ).map((key) => parseFloat((cardFor(t[key]).querySelector("[data-risk] .block") as HTMLElement).style.width));
    expect(widths).toEqual([...widths].sort((a, b) => a - b));
    expect(new Set(widths).size).toBe(widths.length);
  });

  it("puts no risk bar on the start-from-scratch card", () => {
    expect(cardFor(t.presetScratchName).querySelector("[data-risk]")).toBeNull();
  });

  it("explains tolerance once, outside the card buttons", () => {
    const trigger = screen.getByRole("button", { name: t.presetToleranceQuestion });
    expect(trigger.closest("button")).toBe(trigger);
    expect(trigger.parentElement?.closest("button")).toBeNull();
    expect(screen.getByRole("tooltip").textContent).toBe(t.presetToleranceTooltip);
  });
});
