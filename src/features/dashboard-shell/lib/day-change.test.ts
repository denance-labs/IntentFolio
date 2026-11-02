import { describe, expect, it } from "vitest";
import type { TokenPriceMap } from "@/features/market/types";
import type { DayPrices } from "@/features/vault/hooks/use-day-prices";
import { dayChange, type DayChangeInput } from "./day-change";

const USDT = "nep141:usdt.tether-token.near";
const NOW = Date.UTC(2026, 9, 23, 15, 0, 0);
const START = Date.UTC(2026, 9, 23, 0, 5, 0);

function live(entries: Record<string, number>, source = "1click"): TokenPriceMap {
  return Object.fromEntries(
    Object.entries(entries).map(([id, usdPrice]) => [id, { symbol: id, usdPrice, updatedAt: "", source }])
  );
}

const REF: DayPrices = {
  ok: true,
  day: "2026-10-23",
  prices: { near: { usd: 2, at: START }, [USDT]: { usd: 1, at: START } },
};

const base: DayChangeInput = {
  deposits: { near: 10, [USDT]: 20 },
  prices: live({ near: 2.2, [USDT]: 1 }),
  dayPrices: REF,
  createdAt: Date.UTC(2026, 9, 9),
  now: NOW,
};

describe("dayChange", () => {
  it("is the price move of today's holdings since the day's reference", () => {
    // 10 NEAR 2 → 2.2 = +2 on a reference of 20 + 20.
    const change = dayChange(base);
    expect(change?.usd).toBeCloseTo(2);
    expect(change?.pct).toBeCloseTo(5);
    expect(change?.since).toBe(START);
  });

  it("goes down as well as up", () => {
    const change = dayChange({ ...base, prices: live({ near: 1.8, [USDT]: 1 }) });
    expect(change?.usd).toBeCloseTo(-2);
    expect(change?.pct).toBeCloseTo(-5);
  });

  it("does not count a deposit as a gain: quantities are the same at both ends", () => {
    const flat = dayChange({ ...base, deposits: { near: 10, [USDT]: 500 }, prices: live({ near: 2, [USDT]: 1 }) });
    expect(flat?.usd).toBe(0);
  });

  it("runs from the latest reference when a token was first priced later in the day", () => {
    const later = Date.UTC(2026, 9, 23, 9, 5, 0);
    const change = dayChange({ ...base, dayPrices: { ...REF, prices: { ...REF.prices, near: { usd: 2, at: later } } } });
    expect(change?.since).toBe(later);
  });

  it("ignores tokens no longer held", () => {
    expect(dayChange({ ...base, deposits: { near: 10, [USDT]: 0, eth: 0 } })?.usd).toBeCloseTo(2);
  });

  it.each([
    ["no reference yet", { dayPrices: null }],
    ["a reference from another UTC day", { dayPrices: { ...REF, day: "2026-10-22" } }],
    ["live prices that failed", { prices: null }],
    ["a held token at a fallback price", { prices: live({ near: 2.2, [USDT]: 1 }, "fallback") }],
    ["a held token without a reference", { deposits: { near: 10, eth: 1 }, prices: live({ near: 2.2, eth: 3000 }) }],
    ["a portfolio created after the reference", { createdAt: START + 60_000 }],
    ["an empty portfolio", { deposits: {} }],
  ])("hides on %s", (_name, over) => {
    expect(dayChange({ ...base, ...(over as Partial<DayChangeInput>) })).toBeNull();
  });
});
