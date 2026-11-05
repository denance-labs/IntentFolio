// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getTokenPrices, MAX_STALE_MS, __resetPriceCache } from "./price-provider";
import { __resetStockPriceCache } from "./stock-prices";
import { STOCK_TOKENS } from "./stock-tokens";
import { tokenRegistry } from "./token-registry";

// A registry token that is quoted upstream, so the cache path is exercised on a real entry.
const PROBE = tokenRegistry.find((t) => t.id === "nep141:arb.omft.near")!;
const UPSTREAM_PRICE = 4321.5;

function okResponse() {
  return {
    ok: true,
    json: async () => [
      { assetId: PROBE.id, price: UPSTREAM_PRICE, priceUpdatedAt: "2026-07-29T18:00:00.000Z" },
    ],
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  __resetPriceCache();
  __resetStockPriceCache();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("getTokenPrices price cache", () => {
  it("serves the upstream price when the fetch succeeds", async () => {
    fetchMock.mockResolvedValue(okResponse());
    const prices = await getTokenPrices();
    expect(prices[PROBE.id].usdPrice).toBe(UPSTREAM_PRICE);
    expect(prices[PROBE.id].source).toBe("chaindefuser");
  });

  it("serves the last good price, not the hardcoded fallback, when upstream fails within the TTL", async () => {
    fetchMock.mockResolvedValue(okResponse());
    await getTokenPrices();

    fetchMock.mockRejectedValue(new Error("upstream down"));
    const prices = await getTokenPrices();

    expect(prices[PROBE.id].usdPrice).toBe(UPSTREAM_PRICE);
    expect(prices[PROBE.id].usdPrice).not.toBe(PROBE.fallbackUsdPrice);
    expect(prices[PROBE.id].source).toBe("cached");
  });

  it("stops trusting the cache once it is older than the TTL", async () => {
    const t0 = Date.UTC(2026, 6, 29, 18, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(t0);

    fetchMock.mockResolvedValue(okResponse());
    await getTokenPrices();

    vi.setSystemTime(t0 + MAX_STALE_MS + 1);
    fetchMock.mockRejectedValue(new Error("upstream down"));
    const prices = await getTokenPrices();

    expect(prices[PROBE.id].usdPrice).toBe(PROBE.fallbackUsdPrice);
    expect(prices[PROBE.id].source).toBe("fallback");
  });

  it("falls back when upstream fails and nothing was ever cached", async () => {
    fetchMock.mockRejectedValue(new Error("upstream down"));
    const prices = await getTokenPrices();
    expect(prices[PROBE.id].usdPrice).toBe(PROBE.fallbackUsdPrice);
    expect(prices[PROBE.id].source).toBe("fallback");
  });

  it("does not cache an empty upstream response", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => [] });
    await getTokenPrices();

    fetchMock.mockRejectedValue(new Error("upstream down"));
    const prices = await getTokenPrices();
    expect(prices[PROBE.id].source).toBe("fallback");
  });
});

describe("stock prices", () => {
  const STOCK = STOCK_TOKENS[0];
  const route = (coingecko: () => Promise<unknown>) =>
    fetchMock.mockImplementation((url: string) => (url.includes("coingecko") ? coingecko() : Promise.resolve(okResponse())));

  it("serves a stock from CoinGecko and the rest from 1Click", async () => {
    route(async () => ({ ok: true, json: async () => ({ [STOCK.coingeckoId]: { usd: 350, last_updated_at: 1793800000 } }) }));
    const prices = await getTokenPrices();
    expect(prices[STOCK.id]).toMatchObject({ usdPrice: 350, source: "coingecko" });
    expect(prices[PROBE.id]).toMatchObject({ usdPrice: UPSTREAM_PRICE, source: "chaindefuser" });
  });

  it("asks both at once, so a slow CoinGecko adds nothing to a slow 1Click", async () => {
    let release: (value: unknown) => void = () => {};
    const held = new Promise((resolve) => {
      release = resolve;
    });
    route(() => held);
    const reading = getTokenPrices();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    release({ ok: false });
    await reading;
  });

  it("does not break the other tokens when CoinGecko fails, and flags the stock's price", async () => {
    route(async () => {
      throw new Error("rate limited");
    });
    const prices = await getTokenPrices();
    expect(prices[PROBE.id]).toMatchObject({ usdPrice: UPSTREAM_PRICE, source: "chaindefuser" });
    expect(prices[STOCK.id]).toMatchObject({ usdPrice: STOCK.fallbackUsdPrice, source: "fallback" });
  });
});
