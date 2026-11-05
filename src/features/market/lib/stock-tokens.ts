// The six Ondo tokenized stocks IntentFolio offers as portfolio targets (plan 039).
//
// Attribution: see ATTRIBUTIONS.md #24 (ids from near.com's public bundle; CoinGecko ids from its
// public search).
//
// The six are the ones that answered 1Click in both directions on 2026-11-04 at 10, 25 and 100 USD
// (AAPL, AMZN, NVDA, QQQ), or at 10 and 100 (TSLA, GOOGL). None has a withdrawal route, so Receive
// and Withdraw do not offer them: the way out is selling them inside the Funding Account.

import type { TokenDefinition } from "../types";

export type StockToken = TokenDefinition & { coingeckoId: string };

function stock(symbol: string, name: string, address: string, coingeckoId: string, fallbackUsdPrice: number): StockToken {
  const contractId = `bnb-${address}.omdep.near`;
  return {
    id: `nep141:${contractId}`,
    symbol,
    name,
    contractId,
    // Every Ondo token on NEAR reports 18 decimals (`ft_metadata`, read on-chain 2026-11-04).
    decimals: 18,
    category: "Stocks",
    fallbackUsdPrice,
    depositable: true,
    coingeckoId,
  };
}

export const STOCK_TOKENS: readonly StockToken[] = [
  stock("AAPL", "Apple (Ondo)", "0x390a684ef9cade28a7ad0dfa61ab1eb3842618c4", "apple-ondo-tokenized-stock", 338),
  stock("AMZN", "Amazon (Ondo)", "0x4553cfe1c09f37f38b12dc509f676964e392f8fc", "amazon-ondo-tokenized-stock", 260),
  stock("NVDA", "NVIDIA (Ondo)", "0xa9ee28c80f960b889dfbd1902055218cba016f75", "nvidia-ondo-tokenized-stock", 204),
  stock("QQQ", "Invesco QQQ ETF (Ondo)", "0x0cde6936d305d5b34667fc46425e852efd73559a", "invesco-qqq-etf-ondo-tokenized-etf", 689),
  stock("TSLA", "Tesla (Ondo)", "0x2494b603319d4d9f9715c9f4496d9e0364b59d93", "tesla-ondo-tokenized-stock", 377),
  stock("GOOGL", "Alphabet Class A (Ondo)", "0x091fc7778e6932d4009b087b191d1ee3bac5729a", "alphabet-class-a-ondo-tokenized-stock", 282),
];

const STOCK_IDS: ReadonlySet<string> = new Set(STOCK_TOKENS.map((token) => token.id));

/** Whether this is one of the six stocks. */
export function isStockToken(tokenId: string): boolean {
  return STOCK_IDS.has(tokenId);
}
