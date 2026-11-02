// MOCK: fixture used only by the /mock-dashboard QA route (B-002).
// Covers: normal balances, zero balance (hidden), dust balance (B-001 fix),
// depositable vs non-depositable tokens, and unknown tokens not in the registry.
import type { WalletBalancesResult } from "../hooks/use-wallet-balances";

export const MOCK_WALLET_FIXTURE: WalletBalancesResult = {
  balances: {
    // Core
    "near":                                                                       15.5,
    "nep141:btc.omft.near":                                                       0.00082,
    "nep141:eth.omft.near":                                                       0.035,
    // Stablecoins
    "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1":   245.5,   // USDC(NEAR)
    "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near":           0,       // USDC(ETH) — zero, must NOT appear in picker
    "nep141:usdt.tether-token.near":                                              178.22,  // USDT(NEAR)
    "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near":           50.0,    // USDT(ETH)
    // Liquid staking — dust amount: triggers B-001 "<0.00001" display
    "nep141:meta-pool.near":                                                      0.00000000008,
    // Unknown tokens (balances keyed by the IDs we assign them below)
    "nep141:blackdragon.tkn.near":                                                1_500_000,
    "nep141:token.0xshitzu.near":                                                 250_000,
  },
  unknownTokens: [
    {
      id: "nep141:blackdragon.tkn.near",
      symbol: "BLACKDRAGON",
      name: "Black Dragon",
      contractId: "blackdragon.tkn.near",
      decimals: 24,
      category: "Other",
      fallbackUsdPrice: 0.000000123,
      depositable: false,
    },
    {
      id: "nep141:token.0xshitzu.near",
      symbol: "SHITZU",
      name: "Shitzu",
      contractId: "token.0xshitzu.near",
      decimals: 18,
      category: "Other",
      fallbackUsdPrice: 0.00000456,
      depositable: false,
    },
  ],
};
