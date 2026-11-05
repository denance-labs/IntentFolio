// USD prices of the stock tokens for the screens (plan 039). 1Click's `/v0/tokens` does not list them,
// and this is not the price the solver uses.
//
// CoinGecko's price matched 1Click's own valuation within ~0.1 % on 2026-11-04 (AAPLon 333.24 against
// 333.26), which also says it is per on-chain token, without Ondo's display multiplier. Its free tier
// rate-limits, so a failed read serves the last good price while it is recent (as `price-provider.ts`
// does, D-179) and otherwise leaves the token without a live price instead of inventing one.
//
// Attribution: see ATTRIBUTIONS.md #24.

import { STOCK_TOKENS } from "./stock-tokens";

const COINGECKO_PRICES_URL = "https://api.coingecko.com/api/v3/simple/price";

// Short on purpose: the price route waits for this, and every user reads that route.
const TIMEOUT_MS = 2_000;
const MAX_STALE_MS = 60 * 60 * 1000; // 1 h

export type StockPrice = { usdPrice: number; updatedAt: string; servedFromCache: boolean };

// Module memory, lost on restart. Enough to ride out a rate limit.
const lastGood = new Map<string, { usdPrice: number; updatedAt: string; receivedAt: number }>();

// Exported for tests: module state would otherwise leak between cases.
export function __resetStockPriceCache() {
  lastGood.clear();
}

/** By registry token id. A token whose answer is unusable is simply absent. Never throws. */
export async function fetchStockPrices(fetchImpl: typeof fetch = fetch): Promise<Map<string, StockPrice>> {
  const prices = new Map<string, StockPrice>();
  const ids = STOCK_TOKENS.map((token) => token.coingeckoId).join(",");
  try {
    const res = await fetchImpl(`${COINGECKO_PRICES_URL}?ids=${ids}&vs_currencies=usd&include_last_updated_at=true`, {
      next: { revalidate: 60 },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    } as RequestInit);
    const body = res.ok
      ? ((await res.json()) as Record<string, { usd?: unknown; last_updated_at?: unknown } | undefined>)
      : null;
    for (const token of STOCK_TOKENS) {
      const row = body?.[token.coingeckoId];
      const usd = row?.usd;
      const at = row?.last_updated_at;
      if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) continue;
      if (typeof at !== "number" || !Number.isFinite(at)) continue;
      const updatedAt = new Date(at * 1000).toISOString();
      prices.set(token.id, { usdPrice: usd, updatedAt, servedFromCache: false });
      lastGood.set(token.id, { usdPrice: usd, updatedAt, receivedAt: Date.now() });
    }
    if (!res.ok) console.warn(`[stock-prices] CoinGecko answered ${res.status}`);
  } catch (e) {
    // Upstream unavailable: the last good price below, or no live price.
    console.warn(`[stock-prices] CoinGecko failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  for (const token of STOCK_TOKENS) {
    const kept = lastGood.get(token.id);
    if (prices.has(token.id) || !kept || Date.now() - kept.receivedAt > MAX_STALE_MS) continue;
    prices.set(token.id, { usdPrice: kept.usdPrice, updatedAt: kept.updatedAt, servedFromCache: true });
  }
  return prices;
}
