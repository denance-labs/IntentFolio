import { describe, it, expect } from "vitest";
import {
  buildChangeSet,
  buildPendingMarks,
  placeRemovedRows,
  isEmptyChangeSet,
  summarizeChangeSet,
  changeSummaryToSignatureText,
} from "./changeset";
import type { TargetAllocation } from "../types";

// Row factory — id is UI-only and must NOT influence the diff (keyed by tokenId).
const row = (
  tokenId: string,
  targetPct: number | "",
  tolerancePct: number | "" = 10,
  id = `row-${tokenId}`
): TargetAllocation => ({ id, tokenId, targetPct, tolerancePct, locked: false });

const symbolFor = (tokenId: string) => tokenId.toUpperCase();

describe("buildChangeSet", () => {
  it("returns an empty changeset when committed equals draft", () => {
    const committed = [row("btc", 60), row("eth", 40)];
    const draft = [row("btc", 60), row("eth", 40)];
    expect(buildChangeSet(committed, draft)).toEqual({});
  });

  it("is stable against row id changes (keyed by tokenId, not row id)", () => {
    const committed = [row("btc", 60, 10, "a"), row("eth", 40, 10, "b")];
    const draft = [row("btc", 60, 10, "x"), row("eth", 40, 10, "y")];
    expect(buildChangeSet(committed, draft)).toEqual({});
  });

  it("detects a token addition with its initial target/band", () => {
    const committed = [row("btc", 100)];
    const draft = [row("btc", 60), row("eth", 40, 8)];
    expect(buildChangeSet(committed, draft)).toEqual({
      tokenAdditions: [{ tokenId: "eth", initialTargetPct: 40, initialTolerancePct: 8 }],
      targetChanges: [{ tokenId: "btc", newTargetPct: 60, newTolerancePct: 10 }],
    });
  });

  it("detects a token removal", () => {
    const committed = [row("btc", 60), row("eth", 40)];
    const draft = [row("btc", 100)];
    expect(buildChangeSet(committed, draft)).toEqual({
      tokenRemovals: [{ tokenId: "eth" }],
      targetChanges: [{ tokenId: "btc", newTargetPct: 100, newTolerancePct: 10 }],
    });
  });

  it("detects a target % change", () => {
    const committed = [row("btc", 60), row("eth", 40)];
    const draft = [row("btc", 70), row("eth", 30)];
    expect(buildChangeSet(committed, draft)).toEqual({
      targetChanges: [
        { tokenId: "btc", newTargetPct: 70, newTolerancePct: 10 },
        { tokenId: "eth", newTargetPct: 30, newTolerancePct: 10 },
      ],
    });
  });

  it("detects a tolerance-only change (same target %)", () => {
    const committed = [row("btc", 100, 10)];
    const draft = [row("btc", 100, 5)];
    expect(buildChangeSet(committed, draft)).toEqual({
      targetChanges: [{ tokenId: "btc", newTargetPct: 100, newTolerancePct: 5 }],
    });
  });

  it("combines removal + addition + target change in one diff", () => {
    const committed = [row("btc", 50), row("eth", 50)];
    const draft = [row("btc", 60), row("sol", 40, 12)];
    expect(buildChangeSet(committed, draft)).toEqual({
      tokenRemovals: [{ tokenId: "eth" }],
      tokenAdditions: [{ tokenId: "sol", initialTargetPct: 40, initialTolerancePct: 12 }],
      targetChanges: [{ tokenId: "btc", newTargetPct: 60, newTolerancePct: 10 }],
    });
  });

  it("coerces an empty-string input to 0", () => {
    const committed = [row("btc", 100)];
    const draft = [row("btc", 100), row("eth", "")];
    expect(buildChangeSet(committed, draft)).toEqual({
      tokenAdditions: [{ tokenId: "eth", initialTargetPct: 0, initialTolerancePct: 10 }],
    });
  });

  it("ignores rows with an empty tokenId on both sides", () => {
    const committed = [row("btc", 100), row("", 0)];
    const draft = [row("btc", 100), row("", 0)];
    expect(buildChangeSet(committed, draft)).toEqual({});
  });

  it("emits allocations for positive deltas and unallocations for negative", () => {
    const committed = [row("btc", 60), row("eth", 40)];
    expect(buildChangeSet(committed, committed, { btc: 0.5, eth: -0.25 })).toEqual({
      allocations: [{ tokenId: "btc", qty: 0.5 }],
      unallocations: [{ tokenId: "eth", qty: 0.25 }],
    });
  });

  it("ignores balance deltas at or below the float-noise epsilon", () => {
    const committed = [row("btc", 100)];
    expect(buildChangeSet(committed, committed, { btc: 1e-12, eth: -1e-12 })).toEqual({});
  });

  it("ignores a balance delta with an empty tokenId", () => {
    const committed = [row("btc", 100)];
    expect(buildChangeSet(committed, committed, { "": 5 })).toEqual({});
  });

  it("combines a composition diff with balance deltas in one changeset", () => {
    const committed = [row("btc", 60), row("eth", 40)];
    const draft = [row("btc", 70), row("eth", 30)];
    expect(buildChangeSet(committed, draft, { btc: 0.1 })).toEqual({
      targetChanges: [
        { tokenId: "btc", newTargetPct: 70, newTolerancePct: 10 },
        { tokenId: "eth", newTargetPct: 30, newTolerancePct: 10 },
      ],
      allocations: [{ tokenId: "btc", qty: 0.1 }],
    });
  });
});

describe("isEmptyChangeSet", () => {
  it("is true for {}", () => {
    expect(isEmptyChangeSet({})).toBe(true);
  });
  it("is false when any bucket is non-empty", () => {
    expect(isEmptyChangeSet({ tokenRemovals: [{ tokenId: "eth" }] })).toBe(false);
    expect(isEmptyChangeSet({ targetChanges: [{ tokenId: "btc", newTargetPct: 60, newTolerancePct: 10 }] })).toBe(false);
    expect(isEmptyChangeSet({ allocations: [{ tokenId: "btc", qty: 1 }] })).toBe(false);
  });
  it("is false when an unallocation is present", () => {
    expect(isEmptyChangeSet({ unallocations: [{ tokenId: "eth", qty: 0.25 }] })).toBe(false);
  });
  it("is true for explicitly empty arrays", () => {
    expect(isEmptyChangeSet({ tokenRemovals: [], targetChanges: [], allocations: [], unallocations: [] })).toBe(true);
  });
});

describe("summarizeChangeSet", () => {
  it("enriches removals and target changes with committed before-values, in D-093 order", () => {
    const committed = [row("btc", 50, 10), row("eth", 50, 6)];
    const draft = [row("btc", 60, 10), row("sol", 40, 12)];
    const changeset = buildChangeSet(committed, draft);
    const summary = summarizeChangeSet(changeset, committed, symbolFor);

    expect(summary.removals).toEqual([{ tokenId: "eth", symbol: "ETH", fromPct: 50, fromBand: 6 }]);
    expect(summary.additions).toEqual([{ tokenId: "sol", symbol: "SOL", toPct: 40, toBand: 12 }]);
    expect(summary.targetChanges).toEqual([
      { tokenId: "btc", symbol: "BTC", fromPct: 50, toPct: 60, fromBand: 10, toBand: 10 },
    ]);
  });

  it("maps allocations and unallocations with their symbol and qty", () => {
    const committed = [row("btc", 60), row("eth", 40)];
    const changeset = buildChangeSet(committed, committed, { btc: 0.5, eth: -0.25 });
    const summary = summarizeChangeSet(changeset, committed, symbolFor);

    expect(summary.allocations).toEqual([{ tokenId: "btc", symbol: "BTC", qty: 0.5 }]);
    expect(summary.unallocations).toEqual([{ tokenId: "eth", symbol: "ETH", qty: 0.25 }]);
  });
});

describe("changeSummaryToSignatureText", () => {
  it("renders a deterministic, sectioned, English message", () => {
    const committed = [row("btc", 50, 10), row("eth", 50, 6)];
    const draft = [row("btc", 60, 8), row("sol", 40, 12)];
    const summary = summarizeChangeSet(buildChangeSet(committed, draft), committed, symbolFor);
    const text = changeSummaryToSignatureText(summary, "Balanceado");

    expect(text).toBe(
      [
        "IntentFolio — Confirm portfolio changes",
        "Portfolio: Balanceado",
        "",
        "Remove:",
        "- ETH",
        "",
        "Add:",
        "- SOL: target 40%, band 12%",
        "",
        "Update targets:",
        "- BTC: target 50% → 60%, band 10% → 8%",
      ].join("\n")
    );
  });

  it("shows a single band value when the band did not change", () => {
    const committed = [row("btc", 60, 10), row("eth", 40, 10)];
    const draft = [row("btc", 70, 10), row("eth", 30, 10)];
    const summary = summarizeChangeSet(buildChangeSet(committed, draft), committed, symbolFor);
    const text = changeSummaryToSignatureText(summary, "P");
    expect(text).toContain("- BTC: target 60% → 70%, band 10%");
    expect(text).not.toContain("→ 10%, band 10% → 10%");
  });

  it("renders Allocate / Unallocate sections with float-trimmed quantities", () => {
    const committed = [row("btc", 60), row("eth", 40)];
    // 0.1 + 0.2 = 0.30000000000000004 — must serialize as "0.3".
    const summary = summarizeChangeSet(
      buildChangeSet(committed, committed, { btc: 0.1 + 0.2, eth: -0.25 }),
      committed,
      symbolFor
    );
    const text = changeSummaryToSignatureText(summary, "Balanceado");

    expect(text).toBe(
      [
        "IntentFolio — Confirm portfolio changes",
        "Portfolio: Balanceado",
        "",
        "Allocate:",
        "- BTC: 0.3",
        "",
        "Unallocate:",
        "- ETH: 0.25",
      ].join("\n")
    );
  });
});

// 021 R2: the table marks exactly what the signature would carry.
describe("buildPendingMarks", () => {
  const committed = [row("a", 40), row("b", 30), row("c", 30)];
  const marksFor = (draft: TargetAllocation[], deltas = {}) =>
    buildPendingMarks(summarizeChangeSet(buildChangeSet(committed, draft, deltas), committed, symbolFor), committed);

  it("marks a new token, and a changed target or band with only the value that moves", () => {
    const marks = marksFor([row("a", 50), row("b", 30, 15), row("c", 20), row("d", 0)]);
    expect(marks.byTokenId).toEqual({
      a: { kind: "changed", fromPct: 40, fromBand: null },
      b: { kind: "changed", fromPct: null, fromBand: 10 },
      c: { kind: "changed", fromPct: 30, fromBand: null },
      d: { kind: "added" },
    });
  });

  it("an untouched draft marks nothing", () => {
    const marks = marksFor(committed.map((x) => ({ ...x })));
    expect(marks.byTokenId).toEqual({});
    expect(marks.removed).toEqual([]);
    expect(marks.balanceMoves).toEqual({});
  });

  it("signs funds in as + and out as −, and lists removals in committed order", () => {
    const marks = marksFor([row("b", 100)], { a: -2, b: 1.5 });
    expect(marks.balanceMoves).toEqual({ a: -2, b: 1.5 });
    expect(marks.removed.map((r) => [r.tokenId, r.fromPct, r.fromBand])).toEqual([
      ["a", 40, 10],
      ["c", 30, 10],
    ]);
  });
});

// D-536: a funds-only token (held outside the composition) the draft withdraws whole.
describe("buildPendingMarks — funds-only tokens (D-536)", () => {
  const committed = [row("a", 60), row("b", 40)];
  const heldOutside = { x: 2, y: 5 };
  const marksFor = (deltas: Record<string, number>) =>
    buildPendingMarks(summarizeChangeSet(buildChangeSet(committed, committed, deltas), committed, symbolFor), committed, heldOutside);

  it("strikes one withdrawn whole, at 0% with no band, and moves its funds out", () => {
    const marks = marksFor({ x: -2 });
    expect(marks.removed).toEqual([{ tokenId: "x", symbol: "X", fromPct: 0, fromBand: 0 }]);
    expect(marks.balanceMoves).toEqual({ x: -2 });
  });

  it("does not strike one withdrawn in part", () => {
    expect(marksFor({ x: -1 }).removed).toEqual([]);
  });

  it("keeps the struck row among the held rows, in their order", () => {
    const placed = placeRemovedRows([{ tokenId: "a" }, { tokenId: "b" }, { tokenId: "y" }], marksFor({ x: -2 }));
    expect(placed.map((p) => (p.kind === "row" ? p.row.tokenId : `-${p.removed.tokenId}`))).toEqual(["a", "b", "-x", "y"]);
  });
});

describe("placeRemovedRows", () => {
  const marks = (removed: string[], order: string[]) => ({
    removed: removed.map((tokenId) => ({ tokenId, symbol: tokenId, fromPct: 0, fromBand: 0 })),
    committedOrder: Object.fromEntries(order.map((id, i) => [id, i])),
  });
  const layout = (rows: { tokenId: string }[], m: ReturnType<typeof marks>) =>
    placeRemovedRows(rows, m).map((p) => (p.kind === "row" ? p.row.tokenId : `-${p.removed.tokenId}`));

  it("keeps each removed row where it was, ahead of additions and held tokens", () => {
    const rows = [{ tokenId: "b" }, { tokenId: "new" }, { tokenId: "held" }];
    expect(layout(rows, marks(["a", "c"], ["a", "b", "c"]))).toEqual(["-a", "b", "-c", "new", "held"]);
  });

  it("puts a removed last row at the end, and shows everything removed when no row is left", () => {
    expect(layout([{ tokenId: "a" }], marks(["b"], ["a", "b"]))).toEqual(["a", "-b"]);
    expect(layout([], marks(["a", "b"], ["a", "b"]))).toEqual(["-a", "-b"]);
  });

  it("never doubles a token that is still on screen as a row", () => {
    expect(layout([{ tokenId: "a" }], marks(["a"], ["a"]))).toEqual(["a"]);
  });
});
