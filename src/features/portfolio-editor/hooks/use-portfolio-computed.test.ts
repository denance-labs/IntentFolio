// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { usePortfolioComputed } from "./use-portfolio-computed";
import { promoteHeldToTarget } from "../lib/allocation";
import { tokenRegistry } from "@/features/market/lib/token-registry";
import type { TargetAllocation } from "../types";

const [A, B, C] = tokenRegistry.slice(0, 3);
const target = (tokenId: string, targetPct: number): TargetAllocation => ({
  id: `target-${tokenId}`,
  tokenId,
  targetPct,
  tolerancePct: 10,
  locked: false,
});

// A is the only target; B and C are held with no target, in registry order.
const QTY = { [A.id]: 1, [B.id]: 1, [C.id]: 1 };
const order = (targets: TargetAllocation[]) =>
  renderHook(() => usePortfolioComputed({ targets, effectiveCurrentPortfolioQty: QTY, priceMap: {} }))
    .result.current.chartRows.map((row) => row.tokenId);

describe("usePortfolioComputed — a held row keeps its place when given a % (D-513)", () => {
  it("lists the held rows after the targets, in registry order", () => {
    expect(order([target(A.id, 100)])).toEqual([A.id, B.id, C.id]);
  });

  it("leaves a promoted held token where it was until the draft is saved", () => {
    // C, the second held row, gets 20%: it stays after B instead of jumping above it.
    expect(order(promoteHeldToTarget([target(A.id, 100)], C.id, 20))).toEqual([A.id, B.id, C.id]);
  });
});

describe("usePortfolioComputed — a token keeps its color while the draft strikes another", () => {
  // Committed order A, B, C. The draft drops B: its row stays on screen, struck.
  const marks = {
    removed: [{ tokenId: B.id, symbol: B.symbol, fromPct: 0, fromBand: 0 }],
    committedOrder: { [A.id]: 0, [B.id]: 1, [C.id]: 2 },
  };
  const colors = (pendingMarks?: typeof marks) =>
    renderHook(() =>
      usePortfolioComputed({
        targets: [target(A.id, 100)],
        effectiveCurrentPortfolioQty: pendingMarks ? { [A.id]: 1, [C.id]: 1 } : QTY,
        priceMap: {},
        pendingMarks,
      })
    ).result.current.colorByToken;

  it("gives the surviving tokens the colors they had before the strike", () => {
    const before = colors();
    const during = colors(marks);
    expect(during.get(A.id)).toEqual(before.get(A.id));
    expect(during.get(C.id)).toEqual(before.get(C.id));
  });

  it("colors the struck row with the color it had", () => {
    expect(colors(marks).get(B.id)).toEqual(colors().get(B.id));
  });
});
