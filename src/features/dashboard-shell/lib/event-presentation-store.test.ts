// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import {
  eventSnapshotStore,
  buildCompositionSnapshot,
} from "./event-presentation-store";
import type { TokenPriceMap } from "@/features/market/types";

const prices: TokenPriceMap = {
  near: { symbol: "NEAR", usdPrice: 2, updatedAt: "", source: "test" },
  USDC: { symbol: "USDC", usdPrice: 1, updatedAt: "", source: "test" },
};

describe("eventSnapshotStore", () => {
  beforeEach(() => eventSnapshotStore._reset());

  it("stores and reads a snapshot by key", () => {
    eventSnapshotStore.put("commit-1", { before: [{ symbol: "NEAR", pct: 40 }], after: [{ symbol: "NEAR", pct: 50 }] });
    expect(eventSnapshotStore.get("commit-1")?.after[0].pct).toBe(50);
  });

  it("returns undefined for an unknown key", () => {
    expect(eventSnapshotStore.get("nope")).toBeUndefined();
  });

  it("clears on reset", () => {
    eventSnapshotStore.put("k", { before: [], after: [] });
    eventSnapshotStore._reset();
    expect(eventSnapshotStore.get("k")).toBeUndefined();
  });
});

describe("buildCompositionSnapshot", () => {
  it("computes value-weighted allocation % and resolves symbols from the registry", () => {
    const snap = buildCompositionSnapshot(
      [
        { tokenId: "near", targetPct: 50, tolerancePct: 5 },
        { tokenId: "USDC", targetPct: 50, tolerancePct: 5 },
      ],
      { near: 10, USDC: 100 },
      prices
    );
    // values: near 10×2 = 20, USDC 100×1 = 100, total 120
    const near = snap.find((r) => r.symbol === "NEAR");
    const usdc = snap.find((r) => r.symbol === "USDC");
    expect(near?.pct).toBeCloseTo((20 / 120) * 100, 4);
    expect(usdc?.pct).toBeCloseTo((100 / 120) * 100, 4);
  });

  it("falls back to 0% when the portfolio has no value (no divide-by-zero)", () => {
    const snap = buildCompositionSnapshot(
      [{ tokenId: "near", targetPct: 100, tolerancePct: 5 }],
      { near: 0 },
      prices
    );
    expect(snap[0].pct).toBe(0);
  });
});
