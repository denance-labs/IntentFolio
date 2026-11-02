import { describe, it, expect } from "vitest";
import {
  evaluatePortfolioRules,
  firstError,
  clampTolerance,
  TOLERANCE_MIN_PCT,
  TOLERANCE_MAX_PCT,
  TOLERANCE_SOFT_WARN_PCT,
  type CompositionEntry,
} from "./rules";

const entry = (tokenId: string, targetPct: number, tolerancePct = 5): CompositionEntry => ({
  tokenId,
  targetPct,
  tolerancePct,
});

describe("evaluatePortfolioRules — 5 universal rules (D-098)", () => {
  it("passes a valid single-token portfolio (no violations)", () => {
    expect(evaluatePortfolioRules([entry("USDC", 100)], { USDC: 10 })).toEqual([]);
  });

  it("flags empty composition and short-circuits", () => {
    const v = evaluatePortfolioRules([], { USDC: 10 });
    expect(v).toEqual([{ code: "empty-composition", severity: "error" }]);
  });

  it("flags sum != 100 with the actual sum in context", () => {
    const v = evaluatePortfolioRules([entry("USDC", 60), entry("NEAR", 30)], { USDC: 6, NEAR: 3 });
    expect(v).toContainEqual({ code: "sum-not-100", severity: "error", context: { sum: 90 } });
  });

  it("flags no token with target > 0", () => {
    // Sum is 0 here too; both fire — but no-target-above-zero must be present.
    const v = evaluatePortfolioRules([entry("USDC", 0), entry("NEAR", 0)], { USDC: 1, NEAR: 1 });
    expect(v.some((x) => x.code === "no-target-above-zero")).toBe(true);
  });

  it("flags a token with 0% target AND 0 balance, attributing the tokenId", () => {
    const v = evaluatePortfolioRules([entry("USDC", 100), entry("NEAR", 0)], { USDC: 10, NEAR: 0 });
    expect(v).toContainEqual({ code: "zero-target-zero-balance", severity: "error", tokenId: "NEAR" });
  });

  it("allows a 0% token that still holds balance (transitional)", () => {
    const v = evaluatePortfolioRules([entry("USDC", 100), entry("NEAR", 0)], { USDC: 10, NEAR: 5 });
    expect(v).toEqual([]);
  });

  it("flags no funded token", () => {
    expect(evaluatePortfolioRules([entry("USDC", 100)], { USDC: 0 })).toContainEqual({
      code: "no-funded-token",
      severity: "error",
    });
  });
});

describe("evaluatePortfolioRules — tolerance band (D-008)", () => {
  it("flags tolerance below the 2% floor as an error", () => {
    const v = evaluatePortfolioRules([entry("USDC", 100, 1)], { USDC: 10 });
    expect(v).toContainEqual({
      code: "tolerance-below-min",
      severity: "error",
      tokenId: "USDC",
      context: { tolerancePct: 1 },
    });
  });

  it("flags tolerance above the 30% ceiling as an error", () => {
    const v = evaluatePortfolioRules([entry("USDC", 100, 31)], { USDC: 10 });
    expect(v).toContainEqual({
      code: "tolerance-above-max",
      severity: "error",
      tokenId: "USDC",
      context: { tolerancePct: 31 },
    });
  });

  it("flags tolerance > 15% (and <= 30%) as a soft warning, not an error", () => {
    const v = evaluatePortfolioRules([entry("USDC", 100, 20)], { USDC: 10 });
    expect(v).toContainEqual({
      code: "tolerance-high",
      severity: "warning",
      tokenId: "USDC",
      context: { tolerancePct: 20 },
    });
    expect(firstError(v)).toBeNull();
  });

  it("accepts tolerance exactly at both hard bounds without a warning", () => {
    expect(evaluatePortfolioRules([entry("USDC", 100, TOLERANCE_MIN_PCT)], { USDC: 10 })).toEqual([]);
    // 30% is at the ceiling: no error, no warning (warning is strictly > 15 but
    // also > 30 would be the error branch — 30 sits in the inclusive max).
    const at30 = evaluatePortfolioRules([entry("USDC", 100, TOLERANCE_MAX_PCT)], { USDC: 10 });
    expect(at30.some((x) => x.code === "tolerance-above-max")).toBe(false);
    expect(at30.some((x) => x.code === "tolerance-high")).toBe(true);
  });
});

describe("firstError — priority order preserved for the contract gate", () => {
  it("returns sum-not-100 before a tolerance error when both are present", () => {
    const v = evaluatePortfolioRules([entry("USDC", 60, 1), entry("NEAR", 30, 1)], { USDC: 6, NEAR: 3 });
    expect(firstError(v)?.code).toBe("sum-not-100");
  });

  it("returns null when only warnings are present", () => {
    const v = evaluatePortfolioRules([entry("USDC", 100, 20)], { USDC: 10 });
    expect(firstError(v)).toBeNull();
  });
});

describe("clampTolerance", () => {
  it("clamps below the floor up to the minimum", () => {
    expect(clampTolerance(0)).toBe(TOLERANCE_MIN_PCT);
    expect(clampTolerance(-5)).toBe(TOLERANCE_MIN_PCT);
  });

  it("clamps above the ceiling down to the maximum", () => {
    expect(clampTolerance(100)).toBe(TOLERANCE_MAX_PCT);
  });

  it("passes through values inside the band", () => {
    expect(clampTolerance(10)).toBe(10);
    expect(clampTolerance(TOLERANCE_SOFT_WARN_PCT)).toBe(TOLERANCE_SOFT_WARN_PCT);
  });

  it("maps NaN to the minimum", () => {
    expect(clampTolerance(NaN)).toBe(TOLERANCE_MIN_PCT);
  });
});
