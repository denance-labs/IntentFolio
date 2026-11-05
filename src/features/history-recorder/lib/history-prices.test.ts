import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetStockPriceCache } from "@/features/market/lib/stock-prices";
import { STOCK_TOKENS } from "@/features/market/lib/stock-tokens";
import { fetchPriceBook } from "./history-prices";

beforeEach(() => {
  __resetStockPriceCache();
});

const answer = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe("fetchPriceBook — 1Click prices, never a stand-in", () => {
  it("keeps every token with a positive price and integer decimals, as 1Click spelled the price", async () => {
    const book = await fetchPriceBook(
      answer([
        { assetId: "nep141:wrap.near", decimals: 24, price: 5.19 },
        { assetId: "nep141:tiny.near", decimals: 18, price: 1.3462e-8 },
        { assetId: "nep141:zero.near", decimals: 18, price: 0 },
        { assetId: "nep141:nodec.near", price: 1 },
        { assetId: "nep141:text.near", decimals: 6, price: "1" },
        { decimals: 6, price: 1 },
      ])
    );
    expect([...book.entries()]).toEqual([
      ["nep141:wrap.near", { priceText: "5.19", decimals: 24 }],
      ["nep141:tiny.near", { priceText: "1.3462e-8", decimals: 18 }],
    ]);
  });

  it("throws when 1Click does not answer a list — the pass then values nothing", async () => {
    await expect(fetchPriceBook(answer({ error: "x" }))).rejects.toThrow("not a list");
    await expect(fetchPriceBook(answer([], 502))).rejects.toThrow("502");
  });
});

describe("fetchPriceBook — the stocks, which 1Click does not list (plan 039)", () => {
  const STOCK = STOCK_TOKENS[0];
  const routed = (coingecko: () => Response) =>
    vi.fn(async (url: string) =>
      url.includes("coingecko")
        ? coingecko()
        : new Response(JSON.stringify([{ assetId: "nep141:wrap.near", decimals: 24, price: 5.19 }]), { status: 200 })
    );

  it("adds today's CoinGecko price, marked as such", async () => {
    const book = await fetchPriceBook(
      routed(() => new Response(JSON.stringify({ [STOCK.coingeckoId]: { usd: 350.5, last_updated_at: 1793800000 } }), { status: 200 }))
    );
    expect(book.get(STOCK.id)).toEqual({ priceText: "350.5", decimals: 18, source: "coingecko" });
    expect(book.get("nep141:wrap.near")).toEqual({ priceText: "5.19", decimals: 24 });
  });

  it("stores no kept price as that day's real one, and a CoinGecko failure costs the rest nothing", async () => {
    await fetchPriceBook(
      routed(() => new Response(JSON.stringify({ [STOCK.coingeckoId]: { usd: 350.5, last_updated_at: 1793800000 } }), { status: 200 }))
    );
    const book = await fetchPriceBook(routed(() => new Response("limited", { status: 429 })));
    expect(book.has(STOCK.id)).toBe(false);
    expect(book.has("nep141:wrap.near")).toBe(true);
  });
});
