import { describe, it, expect } from "vitest";
import type { Portfolio } from "../context/portfolio-context";
import {
  computeAccountTotals,
  computeTabValues,
  hasMovementsInProgress,
  sumBalanceUsd,
  sumPortfoliosUsd,
} from "./account-totals";
import type { DepositStatusEntry } from "@/features/bridge";
import type { PendingUnallocationRecord } from "@/features/intents-account/mock-contract/types";
import { getTokenById } from "@/features/market/lib/token-registry";

const NEAR = "near";
const USDC_ETH = "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near";

function portfolio(id: string, deposits: Record<string, number>, isReal = false): Portfolio {
  return { id, name: id, deposits, targets: [], createdAt: 0, defaultTolerancePct: 10, ...(isReal ? { isReal } : {}) };
}

const price = (usdPrice: number) => ({ symbol: "", usdPrice, updatedAt: "", source: "test" });

describe("sumPortfoliosUsd", () => {
  it("prices with the live price when there is one", () => {
    expect(sumPortfoliosUsd([portfolio("a", { [NEAR]: 10 })], { [NEAR]: price(2) })).toBe(20);
  });

  it("falls back to the registry price when the live one is missing", () => {
    const fallback = getTokenById(NEAR)!.fallbackUsdPrice;
    expect(sumPortfoliosUsd([portfolio("a", { [NEAR]: 10 })], {})).toBeCloseTo(10 * fallback);
  });

  it("adds every token of every portfolio, mock and real alike", () => {
    const prices = { [NEAR]: price(2), [USDC_ETH]: price(1) };
    const portfolios = [
      portfolio("mock", { [NEAR]: 1, [USDC_ETH]: 5 }),
      portfolio("real", { [NEAR]: 3 }, true),
    ];
    expect(sumPortfoliosUsd(portfolios, prices)).toBe(2 + 5 + 6);
  });

  it("ignores tokens the registry does not know and non-positive quantities", () => {
    const portfolios = [portfolio("a", { "nep141:unknown.near": 100, [NEAR]: 0, [USDC_ETH]: -1 })];
    expect(sumPortfoliosUsd(portfolios, { "nep141:unknown.near": price(1), [USDC_ETH]: price(1) })).toBe(0);
  });

  it("is zero with no portfolios", () => {
    expect(sumPortfoliosUsd([], {})).toBe(0);
  });
});

describe("computeAccountTotals", () => {
  it("adds the two parts into the total", () => {
    expect(computeAccountTotals(100, 350)).toEqual({ generalUsd: 100, portfoliosUsd: 350, totalUsd: 450 });
  });

  it("rounds each part before adding, so the parts on screen add up to the total", () => {
    // Rounding only the sum would show $0.01 + $0.01 = $0.03.
    const totals = computeAccountTotals(0.014, 0.014);
    expect(totals).toEqual({ generalUsd: 0.01, portfoliosUsd: 0.01, totalUsd: 0.02 });
  });

  it("keeps a zero General Balance next to funded portfolios", () => {
    expect(computeAccountTotals(0, 12.5)).toEqual({ generalUsd: 0, portfoliosUsd: 12.5, totalUsd: 12.5 });
  });
});

describe("hasMovementsInProgress", () => {
  const none = { pendingAllocates: 0, deposits: [], unallocations: [] };
  const deposit = (status: string) => ({ status }) as unknown as DepositStatusEntry;
  const unallocation = (status: PendingUnallocationRecord["status"]) =>
    ({ status }) as unknown as PendingUnallocationRecord;

  it("is false when nothing is moving", () => {
    expect(hasMovementsInProgress(none)).toBe(false);
  });

  it("is true with an Allocate in transit", () => {
    expect(hasMovementsInProgress({ ...none, pendingAllocates: 1 })).toBe(true);
  });

  it("counts only deposits not yet credited", () => {
    expect(hasMovementsInProgress({ ...none, deposits: [deposit("PENDING")] })).toBe(true);
    expect(hasMovementsInProgress({ ...none, deposits: [deposit("COMPLETED"), deposit("FAILED")] })).toBe(false);
  });

  it("counts only portfolio withdrawals still pending", () => {
    expect(hasMovementsInProgress({ ...none, unallocations: [unallocation("PENDING")] })).toBe(true);
    expect(hasMovementsInProgress({ ...none, unallocations: [unallocation("SETTLED"), unallocation("FAILED")] })).toBe(false);
  });
});

describe("sumBalanceUsd", () => {
  it("prices like the General Balance rows: live, else the registry fallback, else 0", () => {
    const fallback = getTokenById(USDC_ETH)!.fallbackUsdPrice;
    const balance = new Map([
      [NEAR, 10],
      [USDC_ETH, 4],
      ["nep141:unknown.near", 100],
      ["nep141:zero.near", 0],
    ]);
    expect(sumBalanceUsd(balance, { [NEAR]: price(2) })).toBeCloseTo(20 + 4 * fallback);
  });
});

// 021 R5: the figures under the tab strip's names.
describe("computeTabValues", () => {
  const prices = { [NEAR]: price(2.006), [USDC_ETH]: price(1) };
  const portfolios = [portfolio("a", { [NEAR]: 1 }), portfolio("b", { [USDC_ETH]: 3.333 })];

  // 029 B-16: not the total, which counted the portfolios' own figures a second time.
  it("My Account's figure is the funding account My Account shows, without the portfolios", () => {
    const general = new Map([[USDC_ETH, 1.004]]);
    const { fundingUsd } = computeTabValues(general, portfolios, prices);
    const totals = computeAccountTotals(sumBalanceUsd(general, prices), sumPortfoliosUsd(portfolios, prices));
    expect(fundingUsd).toBe(totals.generalUsd);
    expect(fundingUsd).toBe(1);
  });

  it("each portfolio gets its own value, in cents", () => {
    const { byPortfolio } = computeTabValues(new Map(), portfolios, prices);
    expect(byPortfolio.get("a")).toBe(2.01);
    expect(byPortfolio.get("b")).toBe(3.33);
  });
});
