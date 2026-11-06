// Portfolio presets — starting points offered at first-time creation (5.6).
//
// Locked by D-017 / D-031: only the PERCENTAGES and the symmetric tolerance band
// per preset are fixed (conservative 30/25/15/20/10 ±5% — updated by operator
// decision 2026-06-18 for cross-preset coherence, was 60/30/10 ±5%; balanced
// 30/20/20/15/15 ±8%; aggressive 35/30/25/5/5 ±12%, plus a "start from scratch"
// option). The token assignment per slot is product content
// (operator-confirmed 2026-06-06) and may change in a future FE release without
// migrating existing portfolios (D-045): presets are render-time templates, not
// linked to the portfolios they seed.
//
// They are starting points only, NOT financial advice — the user-facing copy says so
// (see shellTranslations.presetSelectNotAdvice / presetReviewNotAdvice). Display names
// and descriptors are i18n (shellTranslations), keyed off `id`; this module holds no
// user-facing copy. Internal ids are English (code is English); the localized labels,
// including the Spanish names, live in the locale data.
//
// Token ids are registry asset ids (Defuse asset ids) (the native/OMFT representation used by the
// existing seed). The bands sit inside the hard [2%, 30%] range (D-008), so a preset
// always passes the validation gate once at least one slot is funded.

import type { TokenId } from "@/features/intents-account/mock-contract/types";

// Registry asset ids (Defuse asset ids) for the assets used across the presets.
// BTC is nBTC, not `btc.omft.near` (what a Bitcoin deposit lands as): 1Click has no buy-side
// liquidity for the omft one, and nBTC leaves both to a NEAR wallet and to Bitcoin (D-396,
// 018.plan). The stable that was DAI is USDC on Base: DAI has no NEAR version, so it is
// outside the catalog.
// ETH is `eth.bridge.near` (Rainbow), not `eth.omft.near` (what an Ethereum deposit lands
// as): the omft one cannot reach a NEAR wallet (its token cannot register a NEAR account,
// D-384), so an ETH a NEAR-only user bought would be stuck (D-390). 1Click quotes both at
// the same price. The cost: in IntentFolio `eth.bridge.near` only withdraws to NEAR; out to
// Ethereum waits for the universal withdrawal (D-392). SOL stays omft: `sol.omft.near`
// already reaches NEAR (D-384).
const BTC: TokenId = "nep141:nbtc.bridge.near";
const ETH: TokenId = "nep141:eth.bridge.near";
const SOL: TokenId = "nep141:sol.omft.near";
const NEAR: TokenId = "near";
const USDC: TokenId =
  "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const USDT: TokenId = "nep141:usdt.tether-token.near";
const USDC_BASE: TokenId =
  "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const USDC_ETH: TokenId =
  "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near";
const USDT_ETH: TokenId =
  "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near";
const USDT_SOL: TokenId =
  "nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near";
// D-558: the four stocks with a route both ways at every size measured (plan 039). TSLA and
// GOOGL stay out while D1 has them in doubt. Ids as in `stock-tokens.ts`.
// Attribution: see ATTRIBUTIONS.md #24
const NVDA: TokenId = "nep141:bnb-0xa9ee28c80f960b889dfbd1902055218cba016f75.omdep.near";
const AAPL: TokenId = "nep141:bnb-0x390a684ef9cade28a7ad0dfa61ab1eb3842618c4.omdep.near";
const AMZN: TokenId = "nep141:bnb-0x4553cfe1c09f37f38b12dc509f676964e392f8fc.omdep.near";
const QQQ: TokenId = "nep141:bnb-0x0cde6936d305d5b34667fc46425e852efd73559a.omdep.near";

export type PresetId =
  | "conservative"
  | "balanced"
  | "aggressive"
  | "stables"
  | "satoshi"
  | "pioneers"
  | "bigTech"
  | "nearStocks";

export type PresetSlot = { tokenId: TokenId; targetPct: number };

// How much the mix tends to swing, in order (operator decision, 021 R6). Product content
// like the token slots, not a computed metric; the chooser draws it as a colored bar.
export type PresetRisk = "veryLow" | "low" | "medium" | "high" | "veryHigh";

export type PortfolioPreset = {
  id: PresetId;
  risk: PresetRisk;
  // Symmetric tolerance band (±) applied to every slot, in percentage points.
  tolerancePct: number;
  slots: PresetSlot[];
};

export const portfolioPresets: PortfolioPreset[] = [
  {
    id: "conservative",
    risk: "low",
    tolerancePct: 5,
    slots: [
      { tokenId: USDC, targetPct: 30 },
      { tokenId: USDT, targetPct: 25 },
      { tokenId: USDC_BASE, targetPct: 15 },
      { tokenId: BTC, targetPct: 20 },
      { tokenId: ETH, targetPct: 10 },
    ],
  },
  {
    id: "balanced",
    risk: "medium",
    tolerancePct: 8,
    slots: [
      { tokenId: BTC, targetPct: 30 },
      { tokenId: ETH, targetPct: 20 },
      { tokenId: USDC, targetPct: 20 },
      { tokenId: NEAR, targetPct: 15 },
      { tokenId: SOL, targetPct: 15 },
    ],
  },
  {
    id: "aggressive",
    risk: "veryHigh",
    tolerancePct: 12,
    slots: [
      { tokenId: BTC, targetPct: 35 },
      { tokenId: ETH, targetPct: 30 },
      { tokenId: SOL, targetPct: 25 },
      { tokenId: NEAR, targetPct: 5 },
      { tokenId: USDC, targetPct: 5 },
    ],
  },
  {
    id: "stables",
    risk: "veryLow",
    tolerancePct: 5,
    slots: [
      { tokenId: USDC,     targetPct: 20 },
      { tokenId: USDT_ETH, targetPct: 20 },
      { tokenId: USDC_ETH, targetPct: 20 },
      { tokenId: USDT_SOL, targetPct: 20 },
      { tokenId: USDC_BASE, targetPct: 20 },
    ],
  },
  {
    id: "satoshi",
    risk: "high",
    tolerancePct: 10,
    slots: [
      { tokenId: BTC,  targetPct: 70 },
      { tokenId: ETH,  targetPct: 20 },
      { tokenId: NEAR, targetPct: 10 },
    ],
  },
  {
    id: "pioneers",
    risk: "high",
    tolerancePct: 10,
    slots: [
      { tokenId: BTC, targetPct: 60 },
      { tokenId: ETH, targetPct: 40 },
    ],
  },
  // D-558: last in this list on purpose. /learn and the landing derive each token's color from
  // this order, and the chooser moves any preset holding a stock to the top on its own.
  {
    id: "bigTech",
    risk: "veryHigh",
    tolerancePct: 10,
    slots: [
      { tokenId: NVDA, targetPct: 30 },
      { tokenId: AAPL, targetPct: 25 },
      { tokenId: AMZN, targetPct: 25 },
      { tokenId: QQQ, targetPct: 20 },
    ],
  },
  {
    id: "nearStocks",
    risk: "high",
    tolerancePct: 10,
    slots: [
      { tokenId: NEAR, targetPct: 40 },
      { tokenId: NVDA, targetPct: 20 },
      { tokenId: AAPL, targetPct: 20 },
      { tokenId: QQQ, targetPct: 20 },
    ],
  },
];

// The preset the chooser marks as a good starting point (Q6, 016 plan). Descriptive, not a
// popularity claim: there is no usage data behind it. The guided first portfolio (016
// block 2) preselects it.
export const STARTING_POINT_PRESET_ID: PresetId = "balanced";

export function getPreset(id: PresetId): PortfolioPreset | undefined {
  return portfolioPresets.find((p) => p.id === id);
}
