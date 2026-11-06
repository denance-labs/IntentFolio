// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { buildTokenColorMap } from "@/features/portfolio-editor/lib/format";
import { translations as editorTranslations } from "@/features/portfolio-editor/lib/translations";

// 019-5 (D-393 Q4). The confirmation shows the mix with the draft editor's look — colour bar,
// rows edged in each token's colour, Token · Target % · Tolerance — and nothing to edit.

const state = vi.hoisted(() => ({ lang: "en" as "en" | "es" }));
vi.mock("../context/language-context", () => ({ useLanguage: () => ({ lang: state.lang, setLang: vi.fn() }) }));

import { DraftCompositionTable } from "./draft-composition";

const BTC = "nep141:btc.omft.near";
const NEAR = "near";
const ROWS = [
  { tokenId: BTC, targetPct: 60, tolerancePct: 5 },
  { tokenId: NEAR, targetPct: 40, tolerancePct: 8 },
];

// jsdom normalises inline colours to rgb().
const rgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

afterEach(cleanup);

describe.each(["en", "es"] as const)("DraftCompositionTable (%s)", (lang) => {
  const te = editorTranslations[lang];
  const targetLabel = te.target.replace(/\s*%$/, "");

  // D-558: the last look before signing keeps the stocks marked.
  it("marks a stock row and leaves the others alone", () => {
    state.lang = lang;
    const NVDA = "nep141:bnb-0xa9ee28c80f960b889dfbd1902055218cba016f75.omdep.near";
    render(<DraftCompositionTable rows={[{ tokenId: NVDA, targetPct: 60, tolerancePct: 5 }, ROWS[1]]} />);
    const items = screen.getAllByRole("listitem");
    expect(items[0].textContent).toContain(te.stockChipStock);
    expect(items[1].textContent).not.toContain(te.stockChipStock);
  });

  it("one row per token, each value labelled, nothing editable", () => {
    state.lang = lang;
    const { container } = render(<DraftCompositionTable rows={ROWS} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("BTC");
    expect(items[0].textContent).toContain(`${targetLabel} 60%`);
    expect(items[0].textContent).not.toContain("% 60%");
    expect(items[0].textContent).toContain(`${te.band} ±5%`);
    expect(items[1].textContent).toContain("NEAR");
    expect(items[1].textContent).toContain(`${targetLabel} 40%`);
    expect(container.querySelectorAll("input, button, select")).toHaveLength(0);
  });

  it("the bar and each row's edge carry the editor's colour for that token", () => {
    state.lang = lang;
    const { container } = render(<DraftCompositionTable rows={ROWS} />);
    const colors = buildTokenColorMap([BTC, NEAR]);
    const segments = container.querySelectorAll<HTMLElement>("[aria-hidden='true'].flex.h-2 > span");
    expect([...segments].map((s) => s.style.width)).toEqual(["60%", "40%"]);
    expect(segments[0].style.backgroundColor).toBe(rgb(colors.get(BTC)!.hex));
    const items = screen.getAllByRole("listitem");
    expect(items[0].style.borderLeftColor).toBe(rgb(colors.get(BTC)!.hex));
    expect(items[1].style.borderLeftColor).toBe(rgb(colors.get(NEAR)!.hex));
  });

  it("names the columns", () => {
    state.lang = lang;
    const { container } = render(<DraftCompositionTable rows={ROWS} />);
    const header = container.querySelector<HTMLElement>(".rounded-2xl > [aria-hidden='true']")!;
    expect(within(header).getByText(te.token)).toBeTruthy();
    expect(within(header).getByText(te.target)).toBeTruthy();
    expect(within(header).getByText(te.band)).toBeTruthy();
  });
});
