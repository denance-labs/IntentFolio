// The Ondo tokenized stocks IntentFolio offers as portfolio targets (plan 039, D-576).
//
// Attribution: see ATTRIBUTIONS.md #24 (ids from near.com's public bundle; CoinGecko ids from its
// public search).
//
// The first six are the ones that answered 1Click in both directions on 2026-11-04 at 10, 25 and 100 USD
// (AAPL, AMZN, NVDA, QQQ), or at 10 and 100 (TSLA, GOOGL). MSFT and META joined on 2026-11-10 (D-576),
// after answering both ways at 10, 25 and 100 USD in two rounds. META shows as "METAon", Ondo's own
// ticker, because "META" already names Meta Pool's token in the catalog and its logo (operator, D-576). None has a withdrawal route, so Receive
// and Withdraw do not offer them: the way out is selling them inside the Funding Account.

import type { TokenDefinition } from "../types";

export type StockToken = TokenDefinition & { coingeckoId: string; kind: "stock" | "etf" };

function stock(
  symbol: string,
  name: string,
  address: string,
  coingeckoId: string,
  fallbackUsdPrice: number,
  kind: StockToken["kind"] = "stock"
): StockToken {
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
    kind,
  };
}

export const STOCK_TOKENS: readonly StockToken[] = [
  stock("AAPL", "Apple (Ondo)", "0x390a684ef9cade28a7ad0dfa61ab1eb3842618c4", "apple-ondo-tokenized-stock", 338),
  stock("AMZN", "Amazon (Ondo)", "0x4553cfe1c09f37f38b12dc509f676964e392f8fc", "amazon-ondo-tokenized-stock", 260),
  stock("NVDA", "NVIDIA (Ondo)", "0xa9ee28c80f960b889dfbd1902055218cba016f75", "nvidia-ondo-tokenized-stock", 204),
  stock("QQQ", "Invesco QQQ ETF (Ondo)", "0x0cde6936d305d5b34667fc46425e852efd73559a", "invesco-qqq-etf-ondo-tokenized-etf", 689, "etf"),
  stock("TSLA", "Tesla (Ondo)", "0x2494b603319d4d9f9715c9f4496d9e0364b59d93", "tesla-ondo-tokenized-stock", 377),
  stock("GOOGL", "Alphabet Class A (Ondo)", "0x091fc7778e6932d4009b087b191d1ee3bac5729a", "alphabet-class-a-ondo-tokenized-stock", 282),
  stock("MSFT", "Microsoft (Ondo)", "0x6bfe75d1ad432050ea973c3a3dcd88f02e2444c3", "microsoft-ondo-tokenized-stock", 546),
  stock("METAon", "Meta Platforms (Ondo)", "0xd7df5863a3e742f0c767768cdfcb63f09e0422f6", "meta-platforms-ondo-tokenized-stock", 644),
];

const STOCK_IDS: ReadonlySet<string> = new Set(STOCK_TOKENS.map((token) => token.id));

/** Whether this is one of the stocks in `STOCK_TOKENS`. */
export function isStockToken(tokenId: string): boolean {
  return STOCK_IDS.has(tokenId);
}

/** Stock or ETF, for the label beside it. Undefined when it isn't a stock. */
export function stockKind(tokenId: string): StockToken["kind"] | undefined {
  return STOCK_TOKENS.find((token) => token.id === tokenId)?.kind;
}
