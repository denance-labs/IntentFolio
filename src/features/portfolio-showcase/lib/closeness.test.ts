import { describe, expect, it } from "vitest";
import { closeness, displayInPlacePct, type ClosenessRow } from "./closeness";

// Portfolio 1 of pablofork.near on 2026-10-22 (the D-518 mockups): 47% in place, 3 of 5 on target.
const portfolio1: ClosenessRow[] = [
  { tokenId: "stnear", currentPct: 9.2, targetPct: 5, bandState: "inside" },
  { tokenId: "usdt", currentPct: 25, targetPct: 10, bandState: "above" },
  { tokenId: "near", currentPct: 2.1, targetPct: 3.1, bandState: "inside" },
  { tokenId: "eth-eth", currentPct: 15.1, targetPct: 9.9, bandState: "inside" },
  { tokenId: "eth-near", currentPct: 20, targetPct: 72, bandState: "below" },
  { tokenId: "usdc-arb", currentPct: 11.6, targetPct: 0, bandState: "above" },
  { tokenId: "usdc-near", currentPct: 9.9, targetPct: 0, bandState: "inside" },
  { tokenId: "rhea", currentPct: 0, targetPct: 0, bandState: "inside" },
  { tokenId: "aurora", currentPct: 7.1, targetPct: 0, bandState: "inside" },
];

describe("closeness", () => {
  it("is the overlap of the two mixes, and counts only tokens with a target", () => {
    const result = closeness(portfolio1, 6.49);
    expect(result.state).toBe("ready");
    if (result.state !== "ready") return;
    expect(result.inPlacePct).toBeCloseTo(47, 6);
    expect(result.onTarget).toBe(3);
    expect(result.targeted).toBe(5);
    expect(result.overlap.map((o) => o.tokenId)).toEqual(["stnear", "usdt", "near", "eth-eth", "eth-near"]);
  });

  it("equals 100 − half the total distance between the mixes", () => {
    const result = closeness(portfolio1, 6.49);
    if (result.state !== "ready") throw new Error("expected ready");
    const distance = portfolio1.reduce((sum, r) => sum + Math.abs(r.currentPct - r.targetPct), 0);
    expect(result.inPlacePct).toBeCloseTo(100 - distance / 2, 6);
  });

  it("has nothing to measure with nothing held", () => {
    expect(closeness(portfolio1, 0)).toEqual({ state: "empty" });
  });

  it("is 0 when nothing held is in the target mix yet", () => {
    const result = closeness(
      [
        { tokenId: "usdc", currentPct: 100, targetPct: 0, bandState: "above" },
        { tokenId: "near", currentPct: 0, targetPct: 100, bandState: "below" },
      ],
      10
    );
    expect(result).toMatchObject({ state: "ready", inPlacePct: 0, onTarget: 0, targeted: 1, overlap: [] });
  });
});

describe("displayInPlacePct", () => {
  it("rounds down, so 100 means the exact mix", () => {
    expect(displayInPlacePct(47.0)).toBe(47);
    expect(displayInPlacePct(99.6)).toBe(99);
    expect(displayInPlacePct(99.9999999)).toBe(100);
    expect(displayInPlacePct(0.4)).toBe(0);
  });
});
