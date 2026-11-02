// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PortfolioSummaryPanel } from "./portfolio-summary-panel";
import { buildHeldNoTargetRows, computeTargets } from "../lib/calculations";
import { colorForSymbol, type RingColor } from "../lib/format";
import { tokenRegistry } from "@/features/market/lib/token-registry";

afterEach(cleanup);

const [A, B, C] = tokenRegistry.slice(0, 3);

// The swatch in front of the chip that names `symbol`.
function swatch(symbol: string): HTMLElement {
  const chip = screen.getByText(symbol).parentElement as HTMLElement;
  return chip.querySelector('[aria-hidden="true"]') as HTMLElement;
}

// jsdom normalizes `background-color` to rgb(); compare through the same normalization.
function asRgb(hex: string): string {
  const probe = document.createElement("span");
  probe.style.backgroundColor = hex;
  return probe.style.backgroundColor;
}

describe("PortfolioSummaryPanel — chips carry the token colour (027 A-7)", () => {
  const qty = { [A.id]: 1, [B.id]: 1, [C.id]: 1 };
  const computed = computeTargets(
    [
      { id: "a", tokenId: A.id, targetPct: 50, tolerancePct: 10, locked: false },
      { id: "b", tokenId: B.id, targetPct: 50, tolerancePct: 10, locked: false },
    ],
    tokenRegistry,
    {},
    qty,
    300
  );
  // C is held without a target (D-143): it gets a chip like the others.
  const rows = [...computed, ...buildHeldNoTargetRows(computed, tokenRegistry, {}, qty, 300)];

  it("uses the colour the donut and the table get, held-without-target included", () => {
    const colorByToken = new Map<string, RingColor>([
      [A.id, { hex: "#d97706", bg: "bg-amber-600" }],
      [B.id, { hex: "#818cf8", bg: "bg-indigo-400" }],
      [C.id, { hex: "#14b8a6", bg: "bg-teal-500" }],
    ]);
    render(<PortfolioSummaryPanel rows={rows} colorByToken={colorByToken} />);
    expect(swatch(A.symbol).style.backgroundColor).toBe(asRgb("#d97706"));
    expect(swatch(B.symbol).style.backgroundColor).toBe(asRgb("#818cf8"));
    expect(swatch(C.symbol).style.backgroundColor).toBe(asRgb("#14b8a6"));
  });

  it("falls back to the symbol hash, as the donut does", () => {
    render(<PortfolioSummaryPanel rows={rows} />);
    expect(swatch(A.symbol).style.backgroundColor).toBe(asRgb(colorForSymbol(A.symbol).hex));
  });
});

// 027 A-9a: with the delete offer gone from here, an empty portfolio says so.
describe("PortfolioSummaryPanel — nothing with a balance", () => {
  it("shows the empty label when given one, and nothing otherwise", () => {
    const { container, rerender } = render(<PortfolioSummaryPanel rows={[]} />);
    expect(container.textContent).toBe("");
    rerender(<PortfolioSummaryPanel rows={[]} emptyLabel="No funds" />);
    expect(container.textContent).toBe("No funds");
  });
});
