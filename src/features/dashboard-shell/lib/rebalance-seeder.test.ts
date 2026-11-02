// @vitest-environment node
import { describe, it, expect } from "vitest";
import { generateRebalanceEvents } from "./rebalance-seeder";
import type { TokenPriceMap } from "@/features/market/types";

const BASE_COMPOSITION = [
  { tokenId: "near", targetPct: 48, tolerancePct: 5 },
  { tokenId: "nep141:btc.omft.near", targetPct: 28, tolerancePct: 5 },
  { tokenId: "nep141:eth.omft.near", targetPct: 24, tolerancePct: 5 },
];

const BASE_PRICES: TokenPriceMap = {
  "near":                 { symbol: "NEAR", usdPrice: 1.58,   updatedAt: "", source: "fallback" },
  "nep141:btc.omft.near": { symbol: "BTC",  usdPrice: 80000,  updatedAt: "", source: "fallback" },
  "nep141:eth.omft.near": { symbol: "ETH",  usdPrice: 2370,   updatedAt: "", source: "fallback" },
};

const BASE_PARAMS = {
  accountId: "test.near",
  portfolioId: "portfolio-1",
  composition: BASE_COMPOSITION,
  totalValueUsd: 10_000,
  fallbackPrices: BASE_PRICES,
  now: 1_700_000_000_000,
  seed: 42,
};

describe("generateRebalanceEvents", () => {
  it("returns exactly count events (explicit 22)", () => {
    const { events } = generateRebalanceEvents({ ...BASE_PARAMS, count: 22 });
    expect(events).toHaveLength(22);
  });

  it("accepts explicit count", () => {
    const { events } = generateRebalanceEvents({ ...BASE_PARAMS, count: 10 });
    expect(events).toHaveLength(10);
  });

  it("all events are external_rebalance or forced_internal_rebalance", () => {
    const { events } = generateRebalanceEvents(BASE_PARAMS);
    const valid = new Set(["external_rebalance", "forced_internal_rebalance"]);
    expect(events.every((e) => valid.has(e.kind))).toBe(true);
  });

  it("forced_internal_rebalance proportion is between 0% and 30%", () => {
    const { events } = generateRebalanceEvents({ ...BASE_PARAMS, count: 100 });
    const forced = events.filter((e) => e.kind === "forced_internal_rebalance").length;
    expect(forced / events.length).toBeGreaterThanOrEqual(0);
    expect(forced / events.length).toBeLessThanOrEqual(0.30);
  });

  it("only external_rebalance events have attributed_spread > 0", () => {
    const { events } = generateRebalanceEvents(BASE_PARAMS);
    for (const e of events) {
      if (e.kind === "external_rebalance") {
        expect(e.attributed_spread).toBeGreaterThan(0);
      }
      if (e.kind === "forced_internal_rebalance") {
        // forced events must not have attributed_spread
        expect("attributed_spread" in e).toBe(false);
      }
    }
  });

  it("snapshots.size equals events.length", () => {
    const { events, snapshots } = generateRebalanceEvents(BASE_PARAMS);
    expect(snapshots.size).toBe(events.length);
  });

  it("every snapshot has before and after arrays each summing to ~100", () => {
    const { snapshots } = generateRebalanceEvents(BASE_PARAMS);
    for (const snap of snapshots.values()) {
      const beforeSum = snap.before.reduce((s, p) => s + p.pct, 0);
      const afterSum = snap.after.reduce((s, p) => s + p.pct, 0);
      expect(Math.abs(beforeSum - 100)).toBeLessThan(0.5);
      expect(Math.abs(afterSum - 100)).toBeLessThan(0.5);
    }
  });

  it("every snapshot before and after use the same token symbols", () => {
    const { events, snapshots } = generateRebalanceEvents(BASE_PARAMS);
    expect(events.length).toBeGreaterThan(0);
    for (const snap of snapshots.values()) {
      const beforeSymbols = snap.before.map((p) => p.symbol).sort();
      const afterSymbols = snap.after.map((p) => p.symbol).sort();
      expect(beforeSymbols).toEqual(afterSymbols);
    }
  });

  it("all qty_in > 0 and qty_out > 0", () => {
    const { events } = generateRebalanceEvents(BASE_PARAMS);
    for (const e of events) {
      if (
        e.kind === "external_rebalance" ||
        e.kind === "forced_internal_rebalance"
      ) {
        expect(e.qty_in).toBeGreaterThan(0);
        expect(e.qty_out).toBeGreaterThan(0);
      }
    }
  });

  it("timestamps are within the window before now", () => {
    const windowMs = 60 * 24 * 60 * 60 * 1000;
    const { events } = generateRebalanceEvents({ ...BASE_PARAMS, windowMs });
    for (const e of events) {
      expect(e.ts).toBeLessThanOrEqual(BASE_PARAMS.now);
      expect(e.ts).toBeGreaterThan(BASE_PARAMS.now - windowMs * 1.1); // small extra margin for jitter
    }
  });

  it("with same seed, output is deterministic (same event_ids)", () => {
    const run1 = generateRebalanceEvents({ ...BASE_PARAMS, seed: 99 });
    const run2 = generateRebalanceEvents({ ...BASE_PARAMS, seed: 99 });
    const ids1 = run1.snapshots.keys();
    const ids2 = run2.snapshots.keys();
    // snapshot keys are event_ids
    expect([...ids1]).toEqual([...ids2]);
  });

  it("skips if fewer than 2 tokens in composition", () => {
    const { events, snapshots } = generateRebalanceEvents({
      ...BASE_PARAMS,
      composition: [{ tokenId: "near", targetPct: 100, tolerancePct: 5 }],
    });
    expect(events).toHaveLength(0);
    expect(snapshots.size).toBe(0);
  });
});
