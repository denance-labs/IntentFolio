import { describe, expect, it } from "vitest";
import { getBandState, computeTargets, buildHeldNoTargetRows } from "./calculations";
import type { TargetAllocation } from "../types";
import type { TokenDefinition, TokenPriceMap } from "@/features/market/types";

const T_BTC = "nep141:btc";
const T_USDC = "nep141:usdc";

// --- getBandState ---

describe("getBandState", () => {
  it("returns 'empty' when token is not held", () => {
    expect(getBandState(0, 25, 35, false)).toBe("empty");
  });

  it("returns 'inside' when current is within band", () => {
    expect(getBandState(30, 25, 35, true)).toBe("inside");
    expect(getBandState(25, 25, 35, true)).toBe("inside");
    expect(getBandState(35, 25, 35, true)).toBe("inside");
  });

  it("returns 'below' when current is under the band", () => {
    expect(getBandState(20, 25, 35, true)).toBe("below");
  });

  it("returns 'above' when current is over the band", () => {
    expect(getBandState(40, 25, 35, true)).toBe("above");
  });
});

// --- computeTargets ---

const tokens: TokenDefinition[] = [
  { id: T_BTC, symbol: "BTC", name: "Bitcoin", contractId: "btc", decimals: 8, category: "Core", fallbackUsdPrice: 80000, depositable: true },
  { id: T_USDC, symbol: "USDC", name: "USD Coin", contractId: "usdc", decimals: 6, category: "Stable", fallbackUsdPrice: 1, depositable: true }
];

function makeTarget(tokenId: string, targetPct: number, tolerancePct: number): TargetAllocation {
  return { id: tokenId, tokenId, targetPct, tolerancePct, locked: false };
}

describe("computeTargets — a 0% target is sold whole (D-514)", () => {
  const prices: TokenPriceMap = {
    [T_BTC]: { symbol: "BTC", usdPrice: 80000, updatedAt: "", source: "" },
    [T_USDC]: { symbol: "USDC", usdPrice: 1, updatedAt: "", source: "" }
  };

  it("has the band [0, 0] whatever tolerance it keeps, so anything held is above it", () => {
    const [btc] = computeTargets(
      [makeTarget(T_BTC, 0, 10), makeTarget(T_USDC, 100, 10)],
      tokens,
      prices,
      { [T_BTC]: 0.0001, [T_USDC]: 92 },
      100
    );
    // 8% held: inside the old [0, 10] band, which is why the solver never sold it.
    expect(btc.currentPct).toBeCloseTo(8);
    expect(btc.minPct).toBe(0);
    expect(btc.maxPct).toBe(0);
    expect(btc.bandState).toBe("above");
    // The tolerance is kept: it is what gets signed, and what comes back with a target.
    expect(btc.tolerancePct).toBe(10);
  });

  it("is on target once nothing of it is held", () => {
    const [btc] = computeTargets(
      [makeTarget(T_BTC, 0, 10), makeTarget(T_USDC, 100, 10)],
      tokens,
      prices,
      { [T_USDC]: 100 },
      100
    );
    expect(btc.bandState).toBe("inside");
  });
});

describe("computeTargets — additive band (post 0.1)", () => {
  it("computes additive min/max: target 30 ± 5 → [25, 35]", () => {
    const prices: TokenPriceMap = {
      [T_BTC]: { symbol: "BTC", usdPrice: 80000, updatedAt: "", source: "" }
    };
    const [result] = computeTargets(
      [makeTarget(T_BTC, 30, 5)],
      tokens,
      prices,
      { [T_BTC]: 0.01 },
      800
    );
    expect(result.minPct).toBe(25);
    expect(result.maxPct).toBe(35);
  });

  it("clamps minPct to 0 when target is smaller than tolerance", () => {
    const [result] = computeTargets(
      [makeTarget(T_BTC, 3, 5)],
      tokens,
      {},
      { [T_BTC]: 0 },
      0
    );
    expect(result.minPct).toBe(0);
    expect(result.maxPct).toBe(8);
  });

  it("clamps maxPct to 100 when target + tolerance exceeds 100", () => {
    const [result] = computeTargets(
      [makeTarget(T_BTC, 98, 5)],
      tokens,
      {},
      { [T_BTC]: 0 },
      0
    );
    expect(result.minPct).toBe(93);
    expect(result.maxPct).toBe(100);
  });

  it("collapses the band to the target when tolerance is 0", () => {
    const [result] = computeTargets(
      [makeTarget(T_BTC, 30, 0)],
      tokens,
      {},
      { [T_BTC]: 0 },
      0
    );
    expect(result.minPct).toBe(30);
    expect(result.maxPct).toBe(30);
  });
});

describe("computeTargets — currentUsd derived from qty × price", () => {
  it("computes currentUsd as qty × live price", () => {
    const prices: TokenPriceMap = {
      [T_BTC]: { symbol: "BTC", usdPrice: 100000, updatedAt: "", source: "" }
    };
    const [result] = computeTargets(
      [makeTarget(T_BTC, 100, 10)],
      tokens,
      prices,
      { [T_BTC]: 0.005 },
      500
    );
    expect(result.currentUsd).toBeCloseTo(500);
  });

  it("returns currentUsd 0 when tokenId is not in the token registry", () => {
    const [result] = computeTargets(
      [makeTarget("nep141:unknown", 100, 10)],
      tokens,
      {},
      { "nep141:unknown": 1 },
      1
    );
    expect(result.currentUsd).toBe(0);
  });

  it("uses fallbackUsdPrice when live price is absent", () => {
    // BTC fallbackUsdPrice = 80000, qty = 0.01
    const [result] = computeTargets(
      [makeTarget(T_BTC, 100, 10)],
      tokens,
      {},
      { [T_BTC]: 0.01 },
      800
    );
    expect(result.currentUsd).toBeCloseTo(800);
  });

  it("returns currentUsd and cryptoAmount 0 when live price is explicitly 0", () => {
    const prices: TokenPriceMap = {
      [T_BTC]: { symbol: "BTC", usdPrice: 0, updatedAt: "", source: "" }
    };
    const [result] = computeTargets(
      [makeTarget(T_BTC, 100, 10)],
      tokens,
      prices,
      { [T_BTC]: 0.01 },
      800
    );
    expect(result.currentUsd).toBe(0);
    expect(result.cryptoAmount).toBe(0);
  });
});

describe("computeTargets — targetUsd and currentPct", () => {
  it("targetUsd is 0 when currentTotalUsd is 0", () => {
    const [result] = computeTargets(
      [makeTarget(T_BTC, 50, 10)],
      tokens,
      {},
      { [T_BTC]: 0 },
      0
    );
    expect(result.targetUsd).toBe(0);
    expect(result.currentPct).toBe(0);
  });

  it("currentPct reflects proportion of currentUsd / currentTotalUsd", () => {
    const prices: TokenPriceMap = {
      [T_BTC]: { symbol: "BTC", usdPrice: 80000, updatedAt: "", source: "" },
      [T_USDC]: { symbol: "USDC", usdPrice: 1, updatedAt: "", source: "" }
    };
    const [btc, usdc] = computeTargets(
      [makeTarget(T_BTC, 50, 5), makeTarget(T_USDC, 50, 5)],
      tokens,
      prices,
      { [T_BTC]: 0.005, [T_USDC]: 400 },
      800
    );
    expect(btc.currentPct).toBeCloseTo(50, 1);
    expect(usdc.currentPct).toBeCloseTo(50, 1);
  });

  it("price changes move currentPct/currentUsd without recalculating targetPct", () => {
    const targetRows = [makeTarget(T_BTC, 50, 5), makeTarget(T_USDC, 50, 5)];
    const qty = { [T_BTC]: 0.01, [T_USDC]: 200 };
    const initialPrices: TokenPriceMap = {
      [T_BTC]: { symbol: "BTC", usdPrice: 80000, updatedAt: "", source: "" },
      [T_USDC]: { symbol: "USDC", usdPrice: 1, updatedAt: "", source: "" }
    };
    const nextPrices: TokenPriceMap = {
      [T_BTC]: { symbol: "BTC", usdPrice: 100000, updatedAt: "", source: "" },
      [T_USDC]: { symbol: "USDC", usdPrice: 1, updatedAt: "", source: "" }
    };

    const [initialBtc] = computeTargets(targetRows, tokens, initialPrices, qty, 1000);
    const [nextBtc] = computeTargets(targetRows, tokens, nextPrices, qty, 1200);

    expect(initialBtc.currentUsd).toBe(800);
    expect(nextBtc.currentUsd).toBe(1000);
    expect(initialBtc.currentPct).toBeCloseTo(80);
    expect(nextBtc.currentPct).toBeCloseTo(83.333, 3);
    expect(initialBtc.targetPct).toBe(50);
    expect(nextBtc.targetPct).toBe(50);
  });
});

describe("computeTargets — band state", () => {
  it("detects 'inside' when current is within the additive band", () => {
    const prices: TokenPriceMap = {
      [T_BTC]: { symbol: "BTC", usdPrice: 80000, updatedAt: "", source: "" }
    };
    const [result] = computeTargets(
      [makeTarget(T_BTC, 30, 10)],
      tokens,
      prices,
      { [T_BTC]: 0.003 },   // $240 of $800 total = 30%
      800
    );
    expect(result.bandState).toBe("inside");
  });

  it("detects 'below' when current is under the band", () => {
    const prices: TokenPriceMap = {
      [T_BTC]: { symbol: "BTC", usdPrice: 80000, updatedAt: "", source: "" }
    };
    const [result] = computeTargets(
      [makeTarget(T_BTC, 50, 5)],
      tokens,
      prices,
      { [T_BTC]: 0.001 },   // $80 of $800 = 10% — below [45, 55]
      800
    );
    expect(result.bandState).toBe("below");
  });

  it("detects 'above' when current exceeds the band", () => {
    const prices: TokenPriceMap = {
      [T_BTC]: { symbol: "BTC", usdPrice: 80000, updatedAt: "", source: "" }
    };
    const [result] = computeTargets(
      [makeTarget(T_BTC, 10, 5)],
      tokens,
      prices,
      { [T_BTC]: 0.009 },   // $720 of $800 = 90% — above [5, 15]
      800
    );
    expect(result.bandState).toBe("above");
  });

  it("detects 'empty' when tokenId is not in the token registry", () => {
    // 'empty' means the token definition is not found — qty being 0 is not enough
    const [result] = computeTargets(
      [makeTarget("nep141:unknown", 30, 5)],
      tokens,
      {},
      { "nep141:unknown": 0 },
      0
    );
    expect(result.bandState).toBe("empty");
  });

  it("derives display symbol from token.symbol", () => {
    const [result] = computeTargets(
      [makeTarget(T_BTC, 100, 10)],
      tokens,
      {},
      { [T_BTC]: 0.01 },
      800
    );
    expect(result.symbol).toBe("BTC");
  });
});

// --- buildHeldNoTargetRows (D-143(1)) ---

describe("buildHeldNoTargetRows — table/donut superset", () => {
  const prices: TokenPriceMap = {
    [T_BTC]: { symbol: "BTC", usdPrice: 80000, updatedAt: "", source: "" },
    [T_USDC]: { symbol: "USDC", usdPrice: 1, updatedAt: "", source: "" }
  };

  it("emits a 0% row for a held token with no target, sold whole like one (D-513)", () => {
    // BTC is the only target; USDC is held ($200 of $800) but untargeted.
    const qty = { [T_BTC]: 0.0075, [T_USDC]: 200 };
    const computed = computeTargets([makeTarget(T_BTC, 100, 10)], tokens, prices, qty, 800);
    const held = buildHeldNoTargetRows(computed, tokens, prices, qty, 800);

    expect(held).toHaveLength(1);
    expect(held[0].tokenId).toBe(T_USDC);
    expect(held[0].heldNoTarget).toBe(true);
    expect(held[0].hasToken).toBe(true);
    expect(held[0].targetPct).toBe(0);
    expect(held[0].targetUsd).toBe(0);
    expect(held[0].currentUsd).toBeCloseTo(200);
    expect(held[0].currentPct).toBeCloseTo(25, 1);
    expect([held[0].minPct, held[0].maxPct]).toEqual([0, 0]);
    expect(held[0].bandState).toBe("above");
  });

  it("does not duplicate a token that is already a target", () => {
    const qty = { [T_BTC]: 0.005, [T_USDC]: 400 };
    const computed = computeTargets(
      [makeTarget(T_BTC, 50, 10), makeTarget(T_USDC, 50, 10)],
      tokens,
      prices,
      qty,
      800
    );
    expect(buildHeldNoTargetRows(computed, tokens, prices, qty, 800)).toHaveLength(0);
  });

  it("ignores tokens with zero balance and no target", () => {
    const qty = { [T_BTC]: 0.01, [T_USDC]: 0 };
    const computed = computeTargets([makeTarget(T_BTC, 100, 10)], tokens, prices, qty, 800);
    expect(buildHeldNoTargetRows(computed, tokens, prices, qty, 800)).toHaveLength(0);
  });

  it("hides sub-cent dust (held token worth < $0.01)", () => {
    // USDC dust: 0.005 × $1 = $0.005 < MIN_HELD_USD → filtered out.
    const qty = { [T_BTC]: 0.0075, [T_USDC]: 0.005 };
    const computed = computeTargets([makeTarget(T_BTC, 100, 10)], tokens, prices, qty, 600);
    expect(buildHeldNoTargetRows(computed, tokens, prices, qty, 600)).toHaveLength(0);
  });

  it("keeps a held token worth at least $0.01", () => {
    // USDC: 0.01 × $1 = $0.01 → at the threshold, stays visible.
    const qty = { [T_BTC]: 0.0075, [T_USDC]: 0.01 };
    const computed = computeTargets([makeTarget(T_BTC, 100, 10)], tokens, prices, qty, 600);
    const held = buildHeldNoTargetRows(computed, tokens, prices, qty, 600);
    expect(held).toHaveLength(1);
    expect(held[0].tokenId).toBe(T_USDC);
  });

  it("superset covers the same tokens as the donut (regression: 2 in table / 4 in donut)", () => {
    // Targets cover only BTC; USDC is held → table superset must equal the donut set.
    const qty = { [T_BTC]: 0.0075, [T_USDC]: 200 };
    const computed = computeTargets([makeTarget(T_BTC, 100, 10)], tokens, prices, qty, 800);
    const superset = [...computed, ...buildHeldNoTargetRows(computed, tokens, prices, qty, 800)];
    expect(superset.map((r) => r.symbol).sort()).toEqual(["BTC", "USDC"]);
  });
});

// T14: the withdraw button decides "Remove" vs "Withdraw" on quantity, not USD.
describe("computeTargets — currentQty", () => {
  it("keeps the held quantity when the price is 0 (D-322)", () => {
    const prices: TokenPriceMap = {
      [T_BTC]: { symbol: "BTC", usdPrice: 0, updatedAt: "", source: "" }
    };
    const [result] = computeTargets([makeTarget(T_BTC, 50, 5)], tokens, prices, { [T_BTC]: 0.5 }, 0);
    expect(result.currentUsd).toBe(0);
    expect(result.currentQty).toBe(0.5);
  });

  it("is 0 when nothing is held", () => {
    const [result] = computeTargets([makeTarget(T_USDC, 50, 5)], tokens, {}, {}, 0);
    expect(result.currentQty).toBe(0);
  });
});
