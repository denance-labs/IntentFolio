// The delivery table for Converting Withdrawals (D-392, plan 020 §5.2; CONTEXT.md "Asset Family",
// "Delivery Token", "Withdrawal").
//
// Attribution: see ATTRIBUTIONS.md #13 (1Click API v0, and near.com's `oneClickAssetRouting.ts` for
// the nBTC → Bitcoin destination asset).
//
// A Converting Withdrawal sends a held Token out as ANOTHER member of its Asset Family: ETH
// received from Ethereum leaves to a NEAR wallet as `eth.bridge.near`, nBTC leaves to Bitcoin as
// native BTC. This file decides, offline and before any quote, which member arrives on which
// chain — 1Click is never asked to choose it (G6), only to price it.
//
// WHY AN EXPLICIT TABLE AND NOT A RULE OVER `assetName`
// `assetName` groups more than the four convertible families (SWEAT has two members, and the
// registry gains rows whenever 1Click lists a token). A rule over it would make a new row
// convertible — live money — by being typed into the registry, which is the failure
// `token-availability.ts` already refuses. So both halves are listed by id: the Delivery Token
// per (family, chain), and the extra origins that may convert without being delivered anywhere.
// Anything absent is not convertible. `conversion-routes.test.ts` pins the lists against the
// registry, so a new family member shows up as a failing test that asks for a decision.
//
// WHAT IS LEFT OUT, AND WHERE IT IS WRITTEN DOWN (plan 020 §4)
//   - USDC/USDT TO Polygon, BSC, Avalanche, Optimism, Stellar, TON, Sui or Aptos: 1Click does not
//     quote "Polygon → Polygon" and the direct route needs the gas purchase (D-257). Those tokens
//     are ORIGINS only.
//   - WBTC (not BTC's family), SWEAT (no liquidity, `018`), changing family (D-425).

import { getTokenById } from "@/features/market/lib/token-registry";
import { withdrawalDestinations, NEAR_DESTINATION_CHAIN_ID } from "./withdrawal-registry";

export type ConvertibleFamily = "ETH" | "BTC" | "USDC" | "USDT";

export const CONVERTIBLE_FAMILIES: readonly ConvertibleFamily[] = ["ETH", "BTC", "USDC", "USDT"];

const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

/**
 * The Delivery Token of each family on each chain it can be delivered to, NEAR first and then
 * the order the destination picker shows them in (plan 020 §5.3, step 3).
 *
 * Every chain here is one IntentFolio already withdraws to directly, and every token is in
 * `DAY_ONE_TOKEN_IDS` — the table adds no chain the product did not already serve.
 */
export const DELIVERY_TABLE: Readonly<
  Record<ConvertibleFamily, ReadonlyArray<{ chainId: string; tokenId: string }>>
> = {
  ETH: [
    { chainId: "near:mainnet", tokenId: "nep141:eth.bridge.near" },
    { chainId: "eth:1", tokenId: "nep141:eth.omft.near" },
    { chainId: "eth:42161", tokenId: "nep141:arb.omft.near" },
  ],
  BTC: [
    { chainId: "near:mainnet", tokenId: "nep141:nbtc.bridge.near" },
    { chainId: "btc:mainnet", tokenId: "nep141:btc.omft.near" },
  ],
  USDC: [
    { chainId: "near:mainnet", tokenId: USDC_NEAR },
    { chainId: "eth:1", tokenId: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near" },
    { chainId: "eth:42161", tokenId: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near" },
    { chainId: "eth:8453", tokenId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near" },
    { chainId: "sol:mainnet", tokenId: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near" },
  ],
  USDT: [
    { chainId: "near:mainnet", tokenId: "nep141:usdt.tether-token.near" },
    { chainId: "eth:1", tokenId: "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near" },
    { chainId: "eth:42161", tokenId: "nep141:arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near" },
    { chainId: "tron:mainnet", tokenId: "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near" },
    { chainId: "sol:mainnet", tokenId: "nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near" },
  ],
};

/**
 * Members that may be CONVERTED but are delivered nowhere: their own chain has no direct route
 * enabled (`token-availability.ts`, "Not available yet"), so today they have no exit at all.
 * Measured 2026-10-06 (s225, `scripts/measure-conversion-quotes.py --all`): 1Click quotes every
 * one of them to every chain of its family's row, at 0–5 bps of Conversion Cost, except the two
 * Aptos stables at ~21 bps.
 *
 * USDC(POL) is here although plan 020 §4 does not name it: it sits in the same place as
 * USDT(POL) (`hot-omni`, non-native, not day-1) and quotes like it. Listed so that every USDC and
 * USDT member of the registry is accounted for — see the coverage test.
 */
export const ORIGIN_ONLY_TOKEN_IDS: Readonly<Record<ConvertibleFamily, readonly string[]>> = {
  ETH: [],
  BTC: [],
  USDC: [
    "nep141:sui-c1b81ecaf27933252d31a963bc5e9458f13c18ce.omft.near",                 // USDC(SUI)
    "nep141:aptos-34ee497f210c5a511e8d5b53bc56d75b63612bb5.omft.near",               // USDC(APT)
    "nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L",                      // USDC(POL)
    "nep245:v2_1.omni.hot.tg:56_2w93GqMcEmQFDru84j3HZZWt557r",                      // USDC(BSC), 18 decimals
    "nep245:v2_1.omni.hot.tg:43114_3atVJH3r5c4GqiSYmg9fECvjc47o",                   // USDC(AVAX)
    "nep245:v2_1.omni.hot.tg:10_A2ewyUyDp6qsue1jqZsGypkCxRJ",                       // USDC(OP)
    "nep245:v2_1.omni.hot.tg:1100_111bzQBB65GxAPAVoxqmMcgYo5oS3txhqs1Uh1cgahKQUeTUq1TJu", // USDC(STELLAR), 7 decimals
  ],
  USDT: [
    "nep141:aptos-88cb7619440a914fe6400149a12b443c3ac21d59.omft.near",               // USDT(APT)
    "nep245:v2_1.omni.hot.tg:137_3hpYoaLtt8MP1Z2GH1U473DMRKgr",                     // USDT(POL)
    "nep245:v2_1.omni.hot.tg:56_2CMMyVTGZkeyNZTSvS5sarzfir6g",                      // USDT(BSC), 18 decimals
    "nep245:v2_1.omni.hot.tg:43114_372BeH7ENZieCaabwkbWkBiTTgXp",                   // USDT(AVAX)
    "nep245:v2_1.omni.hot.tg:10_359RPSJVdTxwTJT9TyGssr2rFoWo",                      // USDT(OP)
    "nep245:v2_1.omni.hot.tg:1117_3tsdfyziyc7EJbP2aULWSKU4toBaAcN4FdTgfm5W1mC4ouR", // USDT(TON)
  ],
};

/**
 * 1Click's destination asset for a pair where it is NOT the Delivery Token's own id.
 *
 * nBTC → Bitcoin is the one case: near.com asks for `1cs_v1:btc:native:coin` there
 * (`oneClickAssetRouting.ts`, defuse-frontend `752a783`), 1Click's native-BTC routing asset.
 * Measured 2026-10-06 against `nep141:btc.omft.near`: same `amountOut`, `minAmountOut`,
 * `withdrawFee` (1900 sats) and `timeEstimate` (455 s). Plan 020 §9.3 proposed near.com's,
 * because it is the one a production app has been delivering with.
 *
 * Keyed by PAIR, as near.com keys it by the held token: BTC(omft) → Bitcoin is a Direct
 * Withdrawal and never reaches 1Click, so a per-chain override would claim more than was
 * measured.
 */
const ONE_CLICK_DESTINATION_OVERRIDES: ReadonlyArray<{
  originTokenId: string;
  chainId: string;
  asset: string;
}> = [
  {
    originTokenId: "nep141:nbtc.bridge.near",
    chainId: "btc:mainnet",
    asset: "1cs_v1:btc:native:coin",
  },
];

const familyByToken: ReadonlyMap<string, ConvertibleFamily> = (() => {
  const map = new Map<string, ConvertibleFamily>();
  for (const family of CONVERTIBLE_FAMILIES) {
    for (const { tokenId } of DELIVERY_TABLE[family]) map.set(tokenId, family);
    for (const tokenId of ORIGIN_ONLY_TOKEN_IDS[family]) map.set(tokenId, family);
  }
  return map;
})();

/** The family a held token converts within, or `null` when it is not convertible at all. */
export function conversionFamily(tokenId: string): ConvertibleFamily | null {
  return familyByToken.get(tokenId) ?? null;
}

/** The member of `family` that arrives on `chainId`; `null` when the family is not delivered there. */
export function deliveryTokenFor(family: ConvertibleFamily, chainId: string): string | null {
  return DELIVERY_TABLE[family].find((row) => row.chainId === chainId)?.tokenId ?? null;
}

/** The asset id to put in the quote's `destinationAsset` for this pair (G6). */
export function oneClickDestinationAsset(
  originTokenId: string,
  chainId: string,
  deliveryTokenId: string
): string {
  const override = ONE_CLICK_DESTINATION_OVERRIDES.find(
    (o) => o.originTokenId === originTokenId && o.chainId === chainId
  );
  return override?.asset ?? deliveryTokenId;
}

export type WithdrawalPlan =
  /** The held token leaves as itself (CONTEXT.md "Direct Withdrawal"): `withdraw-envelope.ts`. */
  | { kind: "direct"; chainId: string }
  /** The held token becomes `deliveryTokenId` on the way (CONTEXT.md "Converting Withdrawal"). */
  | {
      kind: "conversion";
      chainId: string;
      family: ConvertibleFamily;
      deliveryTokenId: string;
      /** What the 1Click quote asks for: the Delivery Token, or the pair's override. */
      destinationAsset: string;
    }
  | { kind: "none" };

/**
 * How `heldTokenId` leaves to `chainId` (plan 020 §5.2), in this order:
 *
 *   1. it IS that chain's Delivery Token → direct;
 *   2. it is not convertible and its route reaches the chain today → direct (SOL and APT to
 *      NEAR stay D-384's plain `ft_withdraw`);
 *   3. it is convertible and the chain has another Delivery Token → conversion;
 *   4. anything else → none.
 *
 * Route SHAPE only. Whether a direct route is enabled is `token-availability.ts`'s answer and
 * whether the conversion path may run at all is the flag's (`withdraw-flag.ts`, 020-3). With the
 * flag off nothing calls this, so USDC(SOL)/USDT(SOL) to NEAR stay direct (D-384) exactly as today.
 */
export function withdrawalPlan(heldTokenId: string, chainId: string): WithdrawalPlan {
  const family = conversionFamily(heldTokenId);
  if (family === null) {
    return withdrawalDestinations(heldTokenId).includes(chainId)
      ? { kind: "direct", chainId }
      : { kind: "none" };
  }
  const deliveryTokenId = deliveryTokenFor(family, chainId);
  if (deliveryTokenId === null) return { kind: "none" };
  if (deliveryTokenId === heldTokenId) return { kind: "direct", chainId };
  return {
    kind: "conversion",
    chainId,
    family,
    deliveryTokenId,
    destinationAsset: oneClickDestinationAsset(heldTokenId, chainId, deliveryTokenId),
  };
}

/**
 * Every chain `heldTokenId` can leave to, in the order the destination picker lists them: its
 * own chain first when that is a Direct Withdrawal, then NEAR, then the rest of its family's row.
 * A token that is not convertible keeps today's list (`withdrawalDestinations`).
 */
export function deliveryDestinations(heldTokenId: string): string[] {
  const family = conversionFamily(heldTokenId);
  if (family === null) return withdrawalDestinations(heldTokenId);
  const chains = DELIVERY_TABLE[family].map((row) => row.chainId);
  const own = DELIVERY_TABLE[family].find((row) => row.tokenId === heldTokenId)?.chainId;
  const first = [own, NEAR_DESTINATION_CHAIN_ID].filter((c): c is string => c !== undefined);
  return [...new Set([...first, ...chains])];
}

/** Base-unit decimals of a convertible token — what the G5 ceiling normalizes across (6/7/8/18). */
export function conversionTokenDecimals(tokenId: string): number | null {
  if (conversionFamily(tokenId) === null) return null;
  return getTokenById(tokenId)?.decimals ?? null;
}
