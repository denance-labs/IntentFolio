import { describe, expect, it } from "vitest";
import {
  buildScratchTargets,
  buildTargetsFromCurrentPortfolio,
  currentUsdWeightPct,
  demotePromotedAtZero,
  distributeUnlockedTargetPct,
  getEffectiveCurrentPortfolio,
  lockedSpreadPct,
  makeTarget,
  promoteHeldToTarget,
  removeAndRedistributeTarget,
  removeTargetFromDraft,
  restoreRemovedTarget,
  setAllLockState
} from "./allocation";
import type { TokenDefinition, TokenPriceMap } from "@/features/market/types";

const T_BTC = "nep141:btc";
const T_USDC = "nep141:usdc";
const T_ETH = "nep141:eth";

const prices: TokenPriceMap = {
  [T_BTC]: { symbol: "BTC", usdPrice: 80000, updatedAt: "", source: "test" },
  [T_USDC]: { symbol: "USDC", usdPrice: 1, updatedAt: "", source: "test" },
  [T_ETH]: { symbol: "ETH", usdPrice: 2000, updatedAt: "", source: "test" }
};

// --- getEffectiveCurrentPortfolio ---

describe("getEffectiveCurrentPortfolio", () => {
  it("subtracts withdrawn qty from held qty", () => {
    const result = getEffectiveCurrentPortfolio(
      { [T_BTC]: 1, [T_USDC]: 500 },
      { [T_BTC]: 0.3 }
    );
    expect(result[T_BTC]).toBeCloseTo(0.7);
    expect(result[T_USDC]).toBe(500);
  });

  it("never returns negative qty — clamps to 0", () => {
    const result = getEffectiveCurrentPortfolio(
      { [T_BTC]: 0.1 },
      { [T_BTC]: 0.5 }
    );
    expect(result[T_BTC]).toBe(0);
  });

  it("leaves untouched token ids at their original qty", () => {
    const result = getEffectiveCurrentPortfolio(
      { [T_BTC]: 1, [T_ETH]: 2 },
      {}
    );
    expect(result[T_BTC]).toBe(1);
    expect(result[T_ETH]).toBe(2);
  });

  it("handles full withdrawal: result is exactly 0", () => {
    const result = getEffectiveCurrentPortfolio(
      { [T_USDC]: 1000 },
      { [T_USDC]: 1000 }
    );
    expect(result[T_USDC]).toBe(0);
  });
});

// --- buildTargetsFromCurrentPortfolio ---

const tokens: TokenDefinition[] = [
  { id: T_BTC, symbol: "BTC", name: "Bitcoin", contractId: "btc", decimals: 8, category: "Core", fallbackUsdPrice: 80000, depositable: true },
  { id: T_USDC, symbol: "USDC", name: "USD Coin", contractId: "usdc", decimals: 6, category: "Stable", fallbackUsdPrice: 1, depositable: true },
  { id: T_ETH, symbol: "ETH", name: "Ethereum", contractId: "eth", decimals: 18, category: "Core", fallbackUsdPrice: 2000, depositable: true }
];

describe("buildTargetsFromCurrentPortfolio", () => {
  it("builds targets only for tokens with qty > 0", () => {
    const targets = buildTargetsFromCurrentPortfolio(tokens, { [T_BTC]: 0.01, [T_USDC]: 0, [T_ETH]: 0 });
    expect(targets).toHaveLength(1);
    expect(targets[0].tokenId).toBe(T_BTC);
  });

  it("computes initial targetPct using fallback prices", () => {
    // BTC: 0.01 × 80000 = $800; USDC: 200 × 1 = $200 → total $1000
    const targets = buildTargetsFromCurrentPortfolio(tokens, { [T_BTC]: 0.01, [T_USDC]: 200 });
    const btc = targets.find((t) => t.tokenId === T_BTC);
    const usdc = targets.find((t) => t.tokenId === T_USDC);
    expect(btc?.targetPct).toBeCloseTo(80, 1);
    expect(usdc?.targetPct).toBeCloseTo(20, 1);
  });

  it("sets default tolerance to 10 for all targets", () => {
    const targets = buildTargetsFromCurrentPortfolio(tokens, { [T_BTC]: 1 });
    expect(targets[0].tolerancePct).toBe(10);
  });

  it("returns empty array when all qtys are zero", () => {
    const targets = buildTargetsFromCurrentPortfolio(tokens, { [T_BTC]: 0, [T_USDC]: 0 });
    expect(targets).toHaveLength(0);
  });
});

// --- distributeUnlockedTargetPct ---

function targets(...specs: Array<[string, number, boolean]>) {
  return specs.map(([tokenId, pct, locked]) => makeTarget(tokenId, pct, 10, locked));
}

describe("distributeUnlockedTargetPct", () => {
  it("redistributes unlocked targets proportionally on increase", () => {
    const initial = targets(["A", 40, false], ["B", 30, false], ["C", 30, false]);
    const { targets: result } = distributeUnlockedTargetPct(initial, initial[0].id, 60);
    const sum = result.reduce((s, t) => s + (Number(t.targetPct) || 0), 0);
    expect(sum).toBeCloseTo(100, 1);
    expect(Number(result[0].targetPct)).toBe(60);
  });

  it("does not modify a locked target", () => {
    const initial = targets(["A", 50, true], ["B", 30, false], ["C", 20, false]);
    const { targets: result } = distributeUnlockedTargetPct(initial, initial[0].id, 70);
    expect(Number(result[0].targetPct)).toBe(50); // unchanged
  });

  it("clamps change when locked targets consume available space", () => {
    // A locked at 80, B tries to set 30 — only 20 is available
    const initial = targets(["A", 80, true], ["B", 10, false], ["C", 10, false]);
    const { targets: result, clamped } = distributeUnlockedTargetPct(initial, initial[1].id, 30);
    expect(clamped).toBe(true);
    expect(Number(result[1].targetPct)).toBeLessThanOrEqual(20);
  });

  it("sum of all targets is exactly 100 after redistribution (drift correction)", () => {
    const initial = targets(["A", 33, false], ["B", 33, false], ["C", 34, false]);
    const { targets: result } = distributeUnlockedTargetPct(initial, initial[0].id, 50);
    const sum = result.reduce((s, t) => s + (Number(t.targetPct) || 0), 0);
    expect(sum).toBeCloseTo(100, 1);
  });

  it("returns clamped: false when no clamping occurs", () => {
    const initial = targets(["A", 40, false], ["B", 60, false]);
    const { clamped } = distributeUnlockedTargetPct(initial, initial[0].id, 50);
    expect(clamped).toBe(false);
  });

  it("does not apply change if target is locked", () => {
    const initial = targets(["A", 40, true], ["B", 60, false]);
    const { targets: result } = distributeUnlockedTargetPct(initial, initial[0].id, 80);
    expect(Number(result[0].targetPct)).toBe(40);
  });
});

// --- removeAndRedistributeTarget (C-002) ---

// D-491: a target with no buy route (BTC on Bitcoin here) can go down or out, never up.
describe("a target with no buy route", () => {
  const NO_BUY = "nep141:btc.omft.near";
  const pctOf = (rows: ReturnType<typeof targets>, tokenId: string) =>
    Number(rows.find((t) => t.tokenId === tokenId)!.targetPct);
  const sum = (rows: ReturnType<typeof targets>) => rows.reduce((s, t) => s + (Number(t.targetPct) || 0), 0);

  it("can't be raised by typing", () => {
    const initial = targets([NO_BUY, 20, false], ["A", 40, false], ["B", 40, false]);
    const { targets: result, clamped } = distributeUnlockedTargetPct(initial, initial[0].id, 50);
    expect(pctOf(result, NO_BUY)).toBe(20);
    expect(clamped).toBe(true);
    expect(sum(result)).toBeCloseTo(100, 2);
  });

  it("can be lowered, and the freed % goes to the other rows", () => {
    const initial = targets([NO_BUY, 20, false], ["A", 40, false], ["B", 40, false]);
    const { targets: result } = distributeUnlockedTargetPct(initial, initial[0].id, 10);
    expect(pctOf(result, NO_BUY)).toBe(10);
    expect(pctOf(result, "A")).toBe(45);
    expect(pctOf(result, "B")).toBe(45);
  });

  it("takes none of what another row gives up", () => {
    const initial = targets([NO_BUY, 20, false], ["A", 40, false], ["B", 40, false]);
    const { targets: result } = distributeUnlockedTargetPct(initial, initial[1].id, 20);
    expect(pctOf(result, NO_BUY)).toBe(20);
    expect(pctOf(result, "B")).toBe(60);
  });

  it("takes none of a removed row's % while another row can", () => {
    const initial = targets([NO_BUY, 20, false], ["A", 40, false], ["B", 40, false]);
    const result = removeAndRedistributeTarget(initial, initial[1].id);
    expect(pctOf(result, NO_BUY)).toBe(20);
    expect(pctOf(result, "B")).toBe(80);
  });

  it("does take it when it is the only row left, so the total stays 100", () => {
    const initial = targets([NO_BUY, 20, false], ["A", 80, false]);
    const result = removeAndRedistributeTarget(initial, initial[1].id);
    expect(pctOf(result, NO_BUY)).toBe(100);
  });
});

describe("removeAndRedistributeTarget", () => {
  it("removes the token and redistributes its pct among unlocked tokens proportionally", () => {
    const initial = [
      makeTarget(T_USDC, 50, 10, false),
      makeTarget(T_BTC, 30, 10, false),
      makeTarget(T_ETH, 20, 10, false),
    ];
    const result = removeAndRedistributeTarget(initial, initial[0].id); // remove USDC 50%
    expect(result).toHaveLength(2);
    const sum = result.reduce((s, t) => s + (Number(t.targetPct) || 0), 0);
    expect(sum).toBeCloseTo(100, 1);
    // BTC had 30 of the 50 unlocked total → gets 30/50 * 50 = 30 extra → 60
    expect(Number(result.find((t) => t.tokenId === T_BTC)?.targetPct)).toBeCloseTo(60, 1);
    // ETH had 20 of the 50 unlocked total → gets 20/50 * 50 = 20 extra → 40
    expect(Number(result.find((t) => t.tokenId === T_ETH)?.targetPct)).toBeCloseTo(40, 1);
  });

  it("two-token portfolio: surviving token becomes 100%", () => {
    const initial = [
      makeTarget(T_USDC, 50, 10, false),
      makeTarget(T_ETH, 50, 10, false),
    ];
    const result = removeAndRedistributeTarget(initial, initial[1].id); // remove ETH
    expect(result).toHaveLength(1);
    expect(Number(result[0].targetPct)).toBeCloseTo(100, 1);
  });

  it("locked tokens are not changed during redistribution", () => {
    const initial = [
      makeTarget(T_USDC, 60, 10, true),   // locked
      makeTarget(T_BTC, 20, 10, false),
      makeTarget(T_ETH, 20, 10, false),
    ];
    const result = removeAndRedistributeTarget(initial, initial[1].id); // remove BTC 20%
    const usdc = result.find((t) => t.tokenId === T_USDC);
    expect(Number(usdc?.targetPct)).toBe(60); // unchanged
    const eth = result.find((t) => t.tokenId === T_ETH);
    expect(Number(eth?.targetPct)).toBeCloseTo(40, 1); // gets the full 20%
  });

  it("sum is exactly 100 after partial withdraw removes no row (freedPct = 0 case)", () => {
    const initial = [
      makeTarget(T_USDC, 60, 10, false),
      makeTarget(T_BTC, 40, 10, false),
    ];
    const fakeId = "nonexistent-id";
    const result = removeAndRedistributeTarget(initial, fakeId);
    expect(result).toHaveLength(2); // nothing removed
    const sum = result.reduce((s, t) => s + (Number(t.targetPct) || 0), 0);
    expect(sum).toBe(100);
  });

  it("sum is exactly 100 after removal (drift correction)", () => {
    const initial = [
      makeTarget(T_USDC, 33.33, 10, false),
      makeTarget(T_BTC, 33.33, 10, false),
      makeTarget(T_ETH, 33.34, 10, false),
    ];
    const result = removeAndRedistributeTarget(initial, initial[0].id);
    const sum = result.reduce((s, t) => s + (Number(t.targetPct) || 0), 0);
    expect(sum).toBeCloseTo(100, 1);
  });

  // 027 A-11: with no unlocked row left, the freed % used to vanish and the total fell short.
  it("with every remaining row locked, spreads the freed % over all of them in proportion, locks kept", () => {
    const initial = [
      makeTarget(T_USDC, 50, 10, true),
      makeTarget(T_BTC, 30, 10, true),
      makeTarget(T_ETH, 20, 10, true),
    ];
    const result = removeAndRedistributeTarget(initial, initial[2].id); // remove ETH 20%
    expect(result.map((t) => Number(t.targetPct))).toEqual([62.5, 37.5]);
    expect(result.every((t) => t.locked)).toBe(true);
  });

  it("with every remaining row locked, the total is exactly 100 after the rounding fix", () => {
    const initial = [
      makeTarget(T_USDC, 33.33, 10, true),
      makeTarget(T_BTC, 33.33, 10, true),
      makeTarget(T_ETH, 33.34, 10, true),
    ];
    const result = removeAndRedistributeTarget(initial, initial[0].id);
    const sum = result.reduce((s, t) => s + (Number(t.targetPct) || 0), 0);
    expect(Number(sum.toFixed(2))).toBe(100);
  });

  it("two locked rows: removing one leaves the other at 100%", () => {
    const initial = [
      makeTarget(T_USDC, 70, 10, true),
      makeTarget(T_ETH, 30, 10, true),
    ];
    const result = removeAndRedistributeTarget(initial, initial[1].id);
    expect(result).toHaveLength(1);
    expect(Number(result[0].targetPct)).toBe(100);
  });

  it("the operator's chain: free rows removed one by one never break 100%", () => {
    const T_NEAR = "nep141:wrap.near";
    const initial = [
      makeTarget(T_USDC, 40, 10, true),
      makeTarget(T_NEAR, 20, 10, true),
      makeTarget(T_BTC, 22.6, 10, false),
      makeTarget(T_ETH, 17.4, 10, false),
    ];
    // Removing ETH gives its % to BTC, the only other free row, and then every row locks.
    const first = removeTargetFromDraft(initial, initial[3].id);
    expect(first.autoLocked).toBe(true);
    expect(Number(first.targets.find((t) => t.tokenId === T_BTC)?.targetPct)).toBe(40);
    // Removing BTC (40%) with nothing free spreads it over USDC and NEAR, 2:1.
    const second = removeTargetFromDraft(first.targets, initial[2].id).targets;
    expect(second.map((t) => Number(t.targetPct))).toEqual([66.67, 33.33]);
  });
});

describe("lockedSpreadPct (027 A-11)", () => {
  it("is the removed row's % when every other row is locked", () => {
    const rows = [makeTarget(T_USDC, 60, 10, true), makeTarget(T_BTC, 25.5, 10, true), makeTarget(T_ETH, 14.5, 10, false)];
    expect(lockedSpreadPct(rows, rows[2].id)).toBe(14.5);
  });

  it("is null when another row is unlocked, the row is at 0%, or it is the last row", () => {
    const rows = [makeTarget(T_USDC, 60, 10, true), makeTarget(T_BTC, 25.5, 10, false), makeTarget(T_ETH, 14.5, 10, false)];
    expect(lockedSpreadPct(rows, rows[2].id)).toBeNull();
    const zero = [makeTarget(T_USDC, 100, 10, true), makeTarget(T_ETH, 0, 10, false)];
    expect(lockedSpreadPct(zero, zero[1].id)).toBeNull();
    const single = [makeTarget(T_USDC, 100, 10, true)];
    expect(lockedSpreadPct(single, single[0].id)).toBeNull();
  });
});

// --- add-token invariant (C-001) ---
// C-001 (cross-review bug): adding a new token must NOT clobber existing targets.
// Since D-143(3) (5.2) a *deposit* only funds the portfolio (no auto-target — the
// token surfaces as a held-no-target row); the "enter at 0%, preserve existing" gesture
// now lives in "+ Add token" (addTarget), which appends `makeTarget(tokenId, 0, …)`.

describe("addTarget: new token appended at 0%, existing targets preserved (C-001)", () => {
  it("appending a new token preserves existing targets unchanged", () => {
    const existing = [
      makeTarget(T_USDC, 60, 10, false),
      makeTarget(T_BTC, 40, 10, false),
    ];
    const nextTargets = [...existing, makeTarget(T_ETH, 0, 10, false)];
    expect(nextTargets).toHaveLength(3);
    expect(nextTargets[0].tokenId).toBe(T_USDC);
    expect(Number(nextTargets[0].targetPct)).toBe(60);
    expect(nextTargets[1].tokenId).toBe(T_BTC);
    expect(Number(nextTargets[1].targetPct)).toBe(40);
    expect(nextTargets[2].tokenId).toBe(T_ETH);
    expect(Number(nextTargets[2].targetPct)).toBe(0);
  });

  it("sum of targets after appending 0% new token still equals 100", () => {
    const existing = [
      makeTarget(T_USDC, 60, 10, false),
      makeTarget(T_BTC, 40, 10, false),
    ];
    const nextTargets = [...existing, makeTarget(T_ETH, 0, 10, false)];
    const sum = nextTargets.reduce((s, t) => s + (Number(t.targetPct) || 0), 0);
    expect(sum).toBe(100);
  });
});

// --- demotePromotedAtZero (D-513) ---

describe("demotePromotedAtZero", () => {
  it("drops a held token promoted in the draft once it is back at 0%", () => {
    const promoted = promoteHeldToTarget([makeTarget(T_BTC, 100, 10, false)], T_USDC, 10);
    const backToZero = distributeUnlockedTargetPct(promoted, `held-${T_USDC}`, 0).targets;
    const result = demotePromotedAtZero(backToZero);
    expect(result.map((r) => r.tokenId)).toEqual([T_BTC]);
    expect(Number(result[0].targetPct)).toBe(100);
  });

  it("keeps a committed 0% target and a promoted one above 0", () => {
    const committedZero = { ...makeTarget(T_ETH, 0, 10, false), id: `target-${T_ETH}` };
    const promoted = promoteHeldToTarget([makeTarget(T_BTC, 100, 10, false), committedZero], T_USDC, 10);
    expect(demotePromotedAtZero(promoted)).toBe(promoted);
  });
});

// --- promoteHeldToTarget (D-143, 5.2: held rows editable) ---

describe("promoteHeldToTarget", () => {
  it("promotes a held token into a real target and redistributes to keep sum 100", () => {
    const existing = [
      makeTarget(T_BTC, 60, 10, false),
      makeTarget(T_ETH, 40, 10, false),
    ];
    const result = promoteHeldToTarget(existing, T_USDC, 10);

    const usdc = result.find((row) => row.tokenId === T_USDC);
    expect(usdc).toBeDefined();
    expect(Number(usdc!.targetPct)).toBe(10);
    // Existing rows scale down proportionally (60/40 → 54/36).
    expect(Number(result.find((r) => r.tokenId === T_BTC)!.targetPct)).toBeCloseTo(54, 1);
    expect(Number(result.find((r) => r.tokenId === T_ETH)!.targetPct)).toBeCloseTo(36, 1);
    const sum = result.reduce((s, r) => s + (Number(r.targetPct) || 0), 0);
    expect(sum).toBeCloseTo(100, 1);
  });

  it("gives the promoted target a stable id (`held-${tokenId}`) so the row keeps focus", () => {
    const result = promoteHeldToTarget([makeTarget(T_BTC, 100, 10, false)], T_USDC, 25);
    const usdc = result.find((row) => row.tokenId === T_USDC);
    expect(usdc!.id).toBe(`held-${T_USDC}`);
  });

  it("applies the default tolerance to the promoted target", () => {
    const result = promoteHeldToTarget([makeTarget(T_BTC, 100, 10, false)], T_USDC, 25, 7);
    const usdc = result.find((row) => row.tokenId === T_USDC);
    expect(Number(usdc!.tolerancePct)).toBe(7);
  });

  it("does not add a duplicate row when the token is already a target", () => {
    const existing = [
      makeTarget(T_BTC, 60, 10, false),
      makeTarget(T_USDC, 40, 10, false),
    ];
    const result = promoteHeldToTarget(existing, T_USDC, 50);
    expect(result.filter((r) => r.tokenId === T_USDC)).toHaveLength(1);
    const sum = result.reduce((s, r) => s + (Number(r.targetPct) || 0), 0);
    expect(sum).toBeCloseTo(100, 1);
  });
});

// --- currentUsdWeightPct (allocate seeds target = current USD weight) ---

describe("currentUsdWeightPct", () => {
  it("returns 100 for the only funded token", () => {
    expect(currentUsdWeightPct(T_USDC, {}, { [T_USDC]: 1 }, prices)).toBeCloseTo(100, 5);
  });

  it("USD-weights across tokens, not raw quantity", () => {
    // 1 USDC = $1, 0.0005 ETH = $1 → 50/50 by USD despite very different quantities.
    const deltas = { [T_USDC]: 1, [T_ETH]: 0.0005 };
    expect(currentUsdWeightPct(T_USDC, {}, deltas, prices)).toBeCloseTo(50, 5);
    expect(currentUsdWeightPct(T_ETH, {}, deltas, prices)).toBeCloseTo(50, 5);
  });

  it("sums committed balances and draft deltas", () => {
    // committed 0.5 ETH ($1000) + delta 0.5 ETH ($1000) = $2000 vs 1000 USDC ($1000).
    const weight = currentUsdWeightPct(T_ETH, { [T_ETH]: 0.5, [T_USDC]: 1000 }, { [T_ETH]: 0.5 }, prices);
    expect(weight).toBeCloseTo((2000 / 3000) * 100, 5);
  });

  it("returns 0 when the portfolio has no USD value", () => {
    expect(currentUsdWeightPct(T_USDC, {}, {}, prices)).toBe(0);
  });
});

// allocate-from-account flow: each new token is promoted to its current USD weight, so
// targets track current weights by induction (100/100 → 50/50). Mirrors how
// allocateToPortfolio composes currentUsdWeightPct + promoteHeldToTarget.
describe("allocate seeds target = current weight (100/100 → 50/50)", () => {
  it("first token lands at 100% target", () => {
    const deltas = { [T_USDC]: 1 };
    const weight = currentUsdWeightPct(T_USDC, {}, deltas, prices);
    const next = promoteHeldToTarget([], T_USDC, weight);
    expect(Number(next.find((r) => r.tokenId === T_USDC)!.targetPct)).toBeCloseTo(100, 1);
  });

  it("a second equal-value token rebalances both targets to 50/50", () => {
    const step1 = promoteHeldToTarget([], T_USDC, currentUsdWeightPct(T_USDC, {}, { [T_USDC]: 1 }, prices));
    const deltas2 = { [T_USDC]: 1, [T_ETH]: 0.0005 };
    const step2 = promoteHeldToTarget(step1, T_ETH, currentUsdWeightPct(T_ETH, {}, deltas2, prices));
    expect(Number(step2.find((r) => r.tokenId === T_USDC)!.targetPct)).toBeCloseTo(50, 1);
    expect(Number(step2.find((r) => r.tokenId === T_ETH)!.targetPct)).toBeCloseTo(50, 1);
  });
});

// --- setAllLockState ---

describe("setAllLockState", () => {
  it("locks all targets", () => {
    const initial = targets(["A", 40, false], ["B", 60, false]);
    const result = setAllLockState(initial, true);
    expect(result.every((target) => target.locked)).toBe(true);
  });

  it("unlocks all targets", () => {
    const initial = targets(["A", 40, true], ["B", 60, true]);
    const result = setAllLockState(initial, false);
    expect(result.every((target) => !target.locked)).toBe(true);
  });
});

// --- buildScratchTargets (7.5b-08 atomic create) ---

describe("buildScratchTargets", () => {
  it("weights funded targets by USD share (summing to 100)", () => {
    // BTC 1×80000 = 80000 (80%), ETH 10×2000 = 20000 (20%).
    const result = buildScratchTargets({ [T_BTC]: 1, [T_ETH]: 10 }, [], prices, 10);
    const btc = result.find((t) => t.tokenId === T_BTC)!;
    const eth = result.find((t) => t.tokenId === T_ETH)!;
    expect(Number(btc.targetPct)).toBeCloseTo(80, 2);
    expect(Number(eth.targetPct)).toBeCloseTo(20, 2);
    const sum = result.reduce((s, t) => s + (Number(t.targetPct) || 0), 0);
    expect(sum).toBeCloseTo(100, 2);
    expect(btc.tolerancePct).toBe(10);
  });

  it("folds rounding drift onto the largest funded target so the set sums to exactly 100", () => {
    // Three equal-value funded tokens: 33.33 each rounds to 99.99 → +0.01 onto one.
    const result = buildScratchTargets(
      { [T_BTC]: 1, [T_ETH]: 40, [T_USDC]: 80000 },
      [],
      prices,
      10
    );
    const sum = result.reduce((s, t) => s + (Number(t.targetPct) || 0), 0);
    expect(Number(sum.toFixed(2))).toBe(100);
  });

  it("adds target-only tokens at 0% and ignores ones already funded", () => {
    const result = buildScratchTargets({ [T_BTC]: 1 }, [T_ETH, T_BTC], prices, 10);
    const eth = result.find((t) => t.tokenId === T_ETH)!;
    expect(Number(eth.targetPct)).toBe(0);
    // T_BTC stays a single funded target — not duplicated as a 0% target-only row.
    expect(result.filter((t) => t.tokenId === T_BTC)).toHaveLength(1);
    expect(Number(result.find((t) => t.tokenId === T_BTC)!.targetPct)).toBeCloseTo(100, 2);
  });

  it("returns an empty set when there are no funds and no target-only tokens", () => {
    expect(buildScratchTargets({}, [], prices, 10)).toEqual([]);
  });
});

// 021 R2: "Undo" on a removed row.
describe("restoreRemovedTarget", () => {
  const r = (tokenId: string, targetPct: number, locked = false, tolerancePct = 10) => ({
    id: `row-${tokenId}`,
    tokenId,
    targetPct,
    tolerancePct,
    locked,
  });
  const COMMITTED = [r("a", 30), r("b", 25), r("c", 45)];
  const pcts = (rows: { tokenId: string; targetPct: number | "" }[]) => rows.map((x) => [x.tokenId, x.targetPct]);

  it("with nothing edited since, gives back the draft as it was before the removal", () => {
    const before = COMMITTED.map((x) => ({ ...x }));
    const after = removeTargetFromDraft(before, "row-b").targets;
    expect(restoreRemovedTarget(after, COMMITTED, "b", before)).toBe(before);
  });

  it("is exact through the auto-lock too, which the % split alone cannot undo", () => {
    const before = [r("a", 30, true), r("b", 40), r("c", 30)];
    const { targets: after, autoLocked } = removeTargetFromDraft(before, "row-c");
    expect(autoLocked).toBe(true);
    expect(after.every((x) => x.locked)).toBe(true);
    expect(restoreRemovedTarget(after, before, "c", before)).toEqual(before);
  });

  it("without a snapshot, puts the token back in its committed place and %", () => {
    const after = removeTargetFromDraft(COMMITTED, "row-b").targets;
    const restored = restoreRemovedTarget(after, COMMITTED, "b");
    expect(pcts(restored)).toEqual(pcts(COMMITTED));
  });

  it("leaves no rounding residue to sign (found by search: 7 in 20 000 random portfolios did)", () => {
    // Split there and back, 2-decimal rounding swaps 0.01% between the two largest rows.
    const committed = [16.69, 16.62, 6.36, 16.76, 12.19, 14.62, 16.76].map((p, i) => r(`t${i}`, p));
    const after = removeTargetFromDraft(committed, "row-t4").targets;
    expect(pcts(restoreRemovedTarget(after, committed, "t4"))).toEqual(pcts(committed));
  });

  it("after other edits, keeps them and takes the % back from the unlocked rows", () => {
    const before = COMMITTED.map((x) => ({ ...x }));
    const removed = removeTargetFromDraft(before, "row-b").targets;
    // The user then sets c to 60 (a absorbs the rest), so the snapshot no longer applies.
    const edited = distributeUnlockedTargetPct(removed, "row-c", 60).targets;
    const restored = restoreRemovedTarget(edited, COMMITTED, "b", before);
    expect(restored.map((x) => x.tokenId)).toEqual(["a", "b", "c"]);
    expect(restored.find((x) => x.tokenId === "b")?.targetPct).toBe(25);
    expect(restored.reduce((s, x) => s + Number(x.targetPct), 0)).toBeCloseTo(100, 6);
    // c keeps more than a, as the user left them.
    expect(Number(restored[2].targetPct)).toBeGreaterThan(Number(restored[0].targetPct));
  });

  it("does nothing for a token the draft still has, or one the portfolio never held", () => {
    expect(restoreRemovedTarget(COMMITTED, COMMITTED, "b")).toBe(COMMITTED);
    const draft = COMMITTED.slice(0, 2);
    expect(restoreRemovedTarget(draft, COMMITTED, "zzz")).toBe(draft);
  });
});
