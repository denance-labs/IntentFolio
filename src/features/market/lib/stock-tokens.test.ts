// @vitest-environment node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetStockPriceCache, fetchStockPrices } from "./stock-prices";
import { STOCK_TOKENS } from "./stock-tokens";

const APPLE = STOCK_TOKENS[0];

beforeEach(() => {
  __resetStockPriceCache();
});

afterEach(() => {
  vi.useRealTimers();
});

function answering(body: unknown, ok = true) {
  return vi.fn(async () => ({ ok, json: async () => body })) as unknown as typeof fetch;
}

describe("STOCK_TOKENS logos", () => {
  it("has a local logo for each stock", async () => {
    const { hasTokenIcon } = await import("./token-icons");
    for (const token of STOCK_TOKENS) {
      expect(hasTokenIcon(token.symbol)).toBe(true);
      expect(existsSync(join(process.cwd(), "public/token-icons", `${token.symbol}.png`))).toBe(true);
    }
  });
});

describe("STOCK_TOKENS in the portfolio pickers", () => {
  it("can be chosen as a portfolio target without being receivable", async () => {
    const { isPortfolioOfferable, isReceivable } = await import("@/features/bridge/lib/token-availability");
    expect(STOCK_TOKENS.every((token) => isPortfolioOfferable(token.id))).toBe(true);
    expect(STOCK_TOKENS.some((token) => isReceivable(token.id))).toBe(false);
  });
});

describe("STOCK_TOKENS in the registry", () => {
  it("is in the registry and the pickers with no flag", async () => {
    const { depositableTokens, getTokenById } = await import("./token-registry");
    expect(depositableTokens.filter((token) => token.category === "Stocks")).toHaveLength(8);
    expect(getTokenById(APPLE.id)?.decimals).toBe(18);
  });

  it("offers no Receive and no Withdraw for a stock", async () => {
    const { depositGroups } = await import("@/features/bridge/lib/deposit-registry");
    const { getWithdrawalEntry } = await import("@/features/bridge/lib/withdrawal-registry");
    for (const token of STOCK_TOKENS) {
      expect(depositGroups.some((group) => group.assetName === token.symbol)).toBe(false);
      expect(getWithdrawalEntry(token.id)).toBeFalsy();
    }
  });

  it("keeps every id inside the vault's length cap", () => {
    for (const token of STOCK_TOKENS) {
      expect(new TextEncoder().encode(token.id).length).toBeLessThanOrEqual(128);
      expect(token.id).toBe(`nep141:${token.contractId}`);
    }
  });
});

describe("fetchStockPrices", () => {
  it("keys the price by registry id and keeps its age", async () => {
    const prices = await fetchStockPrices(answering({ [APPLE.coingeckoId]: { usd: 340.15, last_updated_at: 1793800000 } }));
    expect(prices.get(APPLE.id)).toEqual({
      usdPrice: 340.15,
      updatedAt: new Date(1793800000 * 1000).toISOString(),
      servedFromCache: false,
    });
    expect(prices.size).toBe(1);
  });

  it("leaves out what is not a price", async () => {
    const prices = await fetchStockPrices(
      answering({
        [STOCK_TOKENS[0].coingeckoId]: { usd: 0, last_updated_at: 1 },
        [STOCK_TOKENS[1].coingeckoId]: { usd: "260", last_updated_at: 1 },
        [STOCK_TOKENS[2].coingeckoId]: { usd: 204 },
      })
    );
    expect(prices.size).toBe(0);
  });

  it("answers empty on a rate limit and on a network failure, never with an invented price", async () => {
    expect((await fetchStockPrices(answering({}, false))).size).toBe(0);
    const failing = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect((await fetchStockPrices(failing)).size).toBe(0);
  });

  it("serves the last good price through a rate limit, marked, and stops after an hour", async () => {
    vi.useFakeTimers();
    await fetchStockPrices(answering({ [APPLE.coingeckoId]: { usd: 340.15, last_updated_at: 1793800000 } }));

    const limited = await fetchStockPrices(answering({}, false));
    expect(limited.get(APPLE.id)).toMatchObject({ usdPrice: 340.15, servedFromCache: true });

    vi.advanceTimersByTime(60 * 60 * 1000 + 1);
    expect((await fetchStockPrices(answering({}, false))).size).toBe(0);
  });
});
