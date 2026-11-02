import { describe, it, expect } from "vitest";
import type { TokenPriceMap } from "@/features/market/types";
import type { NewPortfolioDraftRow } from "./new-portfolio-draft";
import {
  formatSimulationAmountInput,
  isRealPrice,
  parseSimulationAmountInput,
  simulateDraftHoldings,
  simulationAmountText,
} from "./new-portfolio-draft-simulation";

// D-358. The simulation divides the user's amount by the mix at today's prices, and never
// by a hand-written registry fallback: a token without a real quote keeps its USD share
// but gets no units.

const BTC = "nep141:btc.omft.near";
const ETH = "nep141:eth.omft.near";
const NEAR = "near";

const row = (tokenId: string, targetPct: number): NewPortfolioDraftRow => ({
  tokenId,
  targetPct,
  tolerancePct: 5,
  locked: false,
});
const quote = (usdPrice: number, source = "chaindefuser") => ({ symbol: "X", usdPrice, updatedAt: "", source });

describe("simulateDraftHoldings", () => {
  const prices: TokenPriceMap = { [BTC]: quote(80_000), [ETH]: quote(4_000), [NEAR]: quote(5) };

  it("splits the amount by target % and divides by today's price", () => {
    const out = simulateDraftHoldings([row(BTC, 70), row(ETH, 20), row(NEAR, 10)], 100, prices);
    expect(out).toEqual([
      { tokenId: BTC, usd: 70, amount: 70 / 80_000, price: 80_000 },
      { tokenId: ETH, usd: 20, amount: 20 / 4_000, price: 4_000 },
      { tokenId: NEAR, usd: 10, amount: 2, price: 5 },
    ]);
  });

  it("keeps the rows' order and the USD shares add up to the amount", () => {
    const out = simulateDraftHoldings([row(NEAR, 12.5), row(BTC, 87.5)], 1234.56, prices);
    expect(out.map((h) => h.tokenId)).toEqual([NEAR, BTC]);
    expect(out.reduce((s, h) => s + h.usd, 0)).toBeCloseTo(1234.56, 9);
  });

  it("gives no units to a token priced only by the registry fallback, but keeps its USD share", () => {
    const out = simulateDraftHoldings([row(BTC, 50), row(ETH, 50)], 100, {
      ...prices,
      [ETH]: quote(1.58, "fallback"),
    });
    expect(out[1]).toEqual({ tokenId: ETH, usd: 50, amount: null, price: null });
    expect(out[0].amount).toBe(50 / 80_000);
  });

  it("treats a recently cached quote as real (D-179)", () => {
    const out = simulateDraftHoldings([row(ETH, 100)], 100, { [ETH]: quote(4_000, "cached") });
    expect(out[0].amount).toBe(100 / 4_000);
  });

  it("gives no units when the price is missing, zero or not finite", () => {
    const rows = [row(BTC, 40), row(ETH, 30), row(NEAR, 30)];
    const out = simulateDraftHoldings(rows, 100, { [ETH]: quote(0), [NEAR]: quote(Number.NaN) });
    expect(out.map((h) => h.amount)).toEqual([null, null, null]);
    expect(out.map((h) => h.usd)).toEqual([40, 30, 30]);
  });

  it("never shows a negative share for a row mid-edit", () => {
    expect(simulateDraftHoldings([row(BTC, -5)], 100, prices)[0]).toMatchObject({ usd: 0, amount: 0 });
  });

  it("is all zeros for a zero amount", () => {
    const out = simulateDraftHoldings([row(BTC, 60), row(ETH, 40)], 0, prices);
    expect(out.map((h) => [h.usd, h.amount])).toEqual([[0, 0], [0, 0]]);
  });
});

describe("isRealPrice", () => {
  it("accepts live and cached quotes only", () => {
    expect(isRealPrice(quote(1))).toBe(true);
    expect(isRealPrice(quote(1, "cached"))).toBe(true);
    expect(isRealPrice(quote(1, "fallback"))).toBe(false);
    expect(isRealPrice(undefined)).toBe(false);
    expect(isRealPrice(quote(-1))).toBe(false);
  });
});

describe("formatSimulationAmountInput (D-503)", () => {
  it.each([
    ["10000", "10,000"],
    ["1234567", "1,234,567"],
    ["10,000", "10,000"],
    ["1,0000", "10,000"],
    ["007", "7"],
    ["0", "0"],
    ["10.50", "10"],
    ["10.", "10"],
    ["$12abc", "12"],
    ["", ""],
    [".", ""],
    ["99999999999", "1,000,000,000"],
  ])("%s → %s", (input, expected) => {
    expect(formatSimulationAmountInput(input)).toBe(expected);
  });
});

describe("parseSimulationAmountInput", () => {
  it.each([
    ["10,000", 10_000],
    ["7", 7],
    ["0", 0],
    ["", 0],
  ])("%s → %s", (input, expected) => {
    expect(parseSimulationAmountInput(input)).toBe(expected);
  });
});

describe("simulationAmountText", () => {
  it.each([
    [10_000, "10,000"],
    [10.5, "11"],
    [0.4, ""],
    [0, ""],
    [Number.NaN, ""],
  ])("%s → %s", (input, expected) => {
    expect(simulationAmountText(input)).toBe(expected);
  });
});
