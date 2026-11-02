export type TokenCategory = "Stable" | "Core" | "DeFi" | "Privacy" | "Web3" | "Liquid Staking" | "Other";

export type TokenDefinition = {
  id: string;          // primary key — full asset id, e.g. "nep141:wrap.near", "near"
  symbol: string;      // display only — NOT unique (two "ETH" tokens can coexist)
  name: string;        // display name — more descriptive than symbol
  contractId: string | null; // NEAR account of the FT contract; null for native NEAR
  decimals: number;    // from ft_metadata; hardcoded to avoid cold-start fetch
  category: TokenCategory;
  fallbackUsdPrice: number;
  // Whether this token is routable through the 1Click intent solver and thus
  // depositable into the portfolio. Non-depositable tokens still appear
  // in the wallet view so users can see what they hold.
  depositable: boolean;
  // Human-readable asset name used in pickers to group multi-chain representations.
  // e.g. "Tether USD" groups USDT(NEAR), USDT(ETH), USDT(TRON)…
  // Tokens without this field fall back to symbol for grouping (they have one representation).
  assetName?: string;
};

export type TokenWithPrice = TokenDefinition & {
  usdPrice: number;
};

export type TokenPrice = {
  symbol: string;
  usdPrice: number;
  updatedAt: string;
  source: string;
};

export type TokenPriceMap = Record<string, TokenPrice>;
