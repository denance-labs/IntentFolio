// Today's USD prices for the history recorder (plan 028-2, decision 5), from 1Click `/v0/tokens`, and
// from CoinGecko for the Ondo stocks, which 1Click does not list (plan 039). Without them every day
// holding a stock is left out of Evolution and Performance, and nothing backfills a missing day.
// Server only.
//
// Unlike `price-provider.ts`, there is no fallback of any kind: a hand-written or hour-old price
// stored in `token_price_daily`, or frozen into `portfolio_daily.spread_usd`, would read as that
// day's real price forever. No price ⇒ the spread is kept as unpriced (`spread_unpriced`).
//
// Attribution: see ATTRIBUTIONS.md #1 (1Click token catalog, `/v0/tokens`).

import { ONE_CLICK_BASE_URL } from "@/features/bridge/lib/oneclick-base-url";
import { fetchStockPrices } from "@/features/market/lib/stock-prices";
import { STOCK_TOKENS } from "@/features/market/lib/stock-tokens";

const REQUEST_TIMEOUT_MS = 10_000;

/** One token's price, keyed by 1Click's `assetId` — the same id the vault's events carry. */
export type TokenQuote = {
  /** The price as 1Click sent it, for a `numeric` column; never rounded through arithmetic here. */
  priceText: string;
  decimals: number;
  /** Where it came from, for `token_price_daily.source`. Absent: 1Click. */
  source?: string;
};

export type PriceBook = ReadonlyMap<string, TokenQuote>;

type OneClickToken = { assetId?: unknown; price?: unknown; decimals?: unknown };

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Every token 1Click prices above zero. Entries without a usable price or decimals are left
 * out — measured 2026-10-16: 6 of 205 come with a price of 0, and `token_price_daily` refuses 0.
 * Throws when 1Click does not answer with a list; the caller decides what that means.
 */
export async function fetchPriceBook(fetchImpl: FetchLike = fetch): Promise<PriceBook> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${ONE_CLICK_BASE_URL}/v0/tokens`, { signal: controller.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`1Click /v0/tokens answered ${res.status}`);
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) throw new Error("1Click /v0/tokens: not a list");
    const book = new Map<string, TokenQuote>();
    for (const token of body as OneClickToken[]) {
      const { assetId, price, decimals } = token ?? {};
      if (typeof assetId !== "string" || assetId.length < 1 || assetId.length > 256) continue;
      if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) continue;
      if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) continue;
      // `String` of a parsed number is its shortest exact spelling ("1.3462e-8"), which
      // Postgres `numeric` reads as is.
      book.set(assetId, { priceText: String(price), decimals });
    }
    // Only what CoinGecko answered now: a kept price would read as that day's real one forever.
    const stockPrices = await fetchStockPrices(fetchImpl as typeof fetch);
    for (const token of STOCK_TOKENS) {
      const stock = stockPrices.get(token.id);
      if (!stock || stock.servedFromCache) continue;
      book.set(token.id, { priceText: String(stock.usdPrice), decimals: token.decimals, source: "coingecko" });
    }
    return book;
  } finally {
    clearTimeout(timer);
  }
}
