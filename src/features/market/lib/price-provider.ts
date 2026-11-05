import { fetchStockPrices } from "./stock-prices";
import { tokenRegistry } from "./token-registry";
import type { TokenPriceMap } from "../types";

const DEFUSER_PRICES_URL = "https://1click.chaindefuser.com/v0/tokens";

// Native NEAR has no nep141 contract; its price is proxied via wNEAR.
const NATIVE_NEAR_DEFUSER_ID = "nep141:wrap.near";

type DefuserToken = {
  assetId: string;
  price: number;
  priceUpdatedAt: string;
};

// A `fallbackUsdPrice` is written by hand and never ages, so serving one during an outage shows
// an invented number as if it were real. Keep the last upstream response instead and prefer it
// while it is recent enough to still mean something (D-179).
export const MAX_STALE_MS = 60 * 60 * 1000; // 1 h

// Module memory: not shared between server instances and lost on restart, so a cold start
// during an outage still falls back. Enough to ride out a transient upstream failure.
let lastGood: { tokens: Map<string, DefuserToken>; receivedAt: number } | null = null;

// Exported for tests — module state would otherwise leak between cases.
export function __resetPriceCache() {
  lastGood = null;
}

export async function getTokenPrices(): Promise<TokenPriceMap> {
  let defuserMap = new Map<string, DefuserToken>();
  let updatedAt = new Date().toISOString();
  let servedFromCache = false;
  // Side by side, so a slow CoinGecko adds nothing to a slow 1Click. It never rejects.
  const stockPricesRead = fetchStockPrices();

  try {
    const res = await fetch(DEFUSER_PRICES_URL, {
      next: { revalidate: 60 },
    });
    if (res.ok) {
      const tokens = (await res.json()) as DefuserToken[];
      defuserMap = new Map(tokens.map((t) => [t.assetId, t]));
      updatedAt = tokens[0]?.priceUpdatedAt ?? updatedAt;
      if (defuserMap.size > 0) {
        lastGood = { tokens: defuserMap, receivedAt: Date.now() };
      }
    }
  } catch {
    // Upstream unavailable — the cache below is tried before the hardcoded fallbacks.
  }

  if (defuserMap.size === 0 && lastGood && Date.now() - lastGood.receivedAt <= MAX_STALE_MS) {
    defuserMap = lastGood.tokens;
    servedFromCache = true;
  }

  const stockPrices = await stockPricesRead;

  return Object.fromEntries(
    tokenRegistry.map((token) => {
      const stock = stockPrices.get(token.id);
      if (stock) {
        return [
          token.id,
          {
            symbol: token.symbol,
            usdPrice: stock.usdPrice,
            updatedAt: stock.updatedAt,
            source: stock.servedFromCache ? "cached" : "coingecko",
          },
        ];
      }
      const lookupId = token.id === "near" ? NATIVE_NEAR_DEFUSER_ID : token.id;
      const defuser = defuserMap.get(lookupId);
      return [
        token.id,
        {
          symbol: token.symbol,
          usdPrice: defuser ? defuser.price : token.fallbackUsdPrice,
          updatedAt: defuser ? defuser.priceUpdatedAt : updatedAt,
          source: defuser ? (servedFromCache ? "cached" : "chaindefuser") : "fallback",
        },
      ];
    })
  );
}
