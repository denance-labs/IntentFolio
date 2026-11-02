import { describe, expect, it } from "vitest";
import {
  CONVERTIBLE_FAMILIES,
  DELIVERY_TABLE,
  ORIGIN_ONLY_TOKEN_IDS,
  conversionFamily,
  deliveryDestinations,
  deliveryTokenFor,
  oneClickDestinationAsset,
  withdrawalPlan,
  type ConvertibleFamily,
} from "./conversion-routes";
import { DAY_ONE_TOKEN_IDS } from "./token-availability";
import { chainRegistry } from "./chain-registry";
import { withdrawalRegistry, withdrawalDestinations } from "./withdrawal-registry";
import { getTokenById, tokenRegistry } from "@/features/market/lib/token-registry";
import { toIntentsTokenId } from "@/features/market/lib/intents-token-id";

const ETH_OMFT = "nep141:eth.omft.near";
const ETH_NEAR = "nep141:eth.bridge.near";
const ETH_ARB = "nep141:arb.omft.near";
const BTC_OMFT = "nep141:btc.omft.near";
const NBTC = "nep141:nbtc.bridge.near";
const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const USDC_SOL = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";
const USDC_APT = "nep141:aptos-34ee497f210c5a511e8d5b53bc56d75b63612bb5.omft.near";
const USDT_NEAR = "nep141:usdt.tether-token.near";
const USDT_ETH = "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near";
const USDT_TRON = "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near";
const USDT_POL = "nep245:v2_1.omni.hot.tg:137_3hpYoaLtt8MP1Z2GH1U473DMRKgr";
const SOL = "nep141:sol.omft.near";
const APT = "nep141:aptos.omft.near";
const WBTC = "nep141:2260fac5e5542a773aa44fbcfedf7c193bc2c599.factory.bridge.near";

const allDelivery = CONVERTIBLE_FAMILIES.flatMap((f) =>
  DELIVERY_TABLE[f].map((row) => ({ family: f, ...row }))
);
const allOriginOnly = CONVERTIBLE_FAMILIES.flatMap((f) =>
  ORIGIN_ONLY_TOKEN_IDS[f].map((tokenId) => ({ family: f, tokenId }))
);

describe("delivery table — invariants (plan 020 §5.2)", () => {
  it("delivers only tokens that are already withdrawable on day 1", () => {
    for (const { tokenId } of allDelivery) expect(DAY_ONE_TOKEN_IDS.has(tokenId), tokenId).toBe(true);
  });

  // Each family can always reach a NEAR wallet and its home network: the two ends plan 020 §6
  // walks (ETH ↔ Ethereum, BTC ↔ Bitcoin, the stables to and from NEAR).
  it.each([
    ["ETH", "eth:1"],
    ["BTC", "btc:mainnet"],
    ["USDC", "eth:1"],
    ["USDT", "eth:1"],
  ] as const)("%s reaches NEAR and %s", (family, home) => {
    expect(deliveryTokenFor(family, "near:mainnet")).not.toBeNull();
    expect(deliveryTokenFor(family, home)).not.toBeNull();
  });

  it("lists NEAR first in every family, as the destination picker shows it", () => {
    for (const family of CONVERTIBLE_FAMILIES) {
      expect(DELIVERY_TABLE[family][0].chainId).toBe("near:mainnet");
    }
  });

  it("delivers each family as one of its own members, on the chain that member lives on", () => {
    for (const { family, chainId, tokenId } of allDelivery) {
      expect(getTokenById(tokenId)?.assetName, tokenId).toBe(family);
      expect(withdrawalRegistry[tokenId]?.chainId, tokenId).toBe(chainId);
    }
  });

  it("never needs a destination memo, so a conversion never carries one", () => {
    for (const { chainId } of allDelivery) {
      expect(chainRegistry[chainId], chainId).toBeDefined();
      expect(chainRegistry[chainId].memoRequired, chainId).toBe(false);
    }
  });

  it("names each chain at most once per family", () => {
    for (const family of CONVERTIBLE_FAMILIES) {
      const chains = DELIVERY_TABLE[family].map((row) => row.chainId);
      expect(new Set(chains).size).toBe(chains.length);
    }
  });

  it("lists origin-only tokens of the right family that have no enabled exit of their own", () => {
    for (const { family, tokenId } of allOriginOnly) {
      expect(getTokenById(tokenId)?.assetName, tokenId).toBe(family);
      expect(DAY_ONE_TOKEN_IDS.has(tokenId), tokenId).toBe(false);
      expect(allDelivery.some((d) => d.tokenId === tokenId), tokenId).toBe(false);
    }
  });

  it("puts no token in two families", () => {
    const ids = [...allDelivery.map((d) => d.tokenId), ...allOriginOnly.map((o) => o.tokenId)];
    expect(new Set(ids).size).toBe(ids.length);
  });

  // The `transfer` intent keys its token map by Defuse asset id. Every convertible token's registry
  // id already IS one (only native NEAR differs, and it is not convertible).
  it("uses registry ids that are Defuse asset ids, so the transfer names the token held", () => {
    for (const tokenId of [...allDelivery, ...allOriginOnly].map((t) => t.tokenId)) {
      expect(toIntentsTokenId(tokenId)).toBe(tokenId);
    }
  });

  // 🔴 The fail-closed tripwire. A new USDC/USDT/ETH/BTC row in the registry does NOT become
  // convertible by joining the family — it makes this test fail, and the fix is a decision: list
  // it in `conversion-routes.ts` (opting it into a money path) or update these counts on purpose.
  it("accounts for every member of the four families in the registry, and nothing else", () => {
    const counts: Record<string, number> = {};
    for (const token of tokenRegistry) {
      const family = token.assetName as ConvertibleFamily | undefined;
      if (!family || !CONVERTIBLE_FAMILIES.includes(family)) continue;
      counts[family] = (counts[family] ?? 0) + 1;
      expect(conversionFamily(token.id), token.id).toBe(family);
    }
    expect(counts).toEqual({ ETH: 3, BTC: 2, USDC: 12, USDT: 11 });
  });

  it.each([
    ["WBTC", WBTC],
    ["NEAR", "near"],
    ["SOL", SOL],
    ["SWEAT (NEAR)", "nep141:token.sweat"],
    ["SWEAT (ARB)", "nep141:arb-0xca7dec8550f43a5e46e3dfb95801f64280e75b27.omft.near"],
    ["an unknown id", "nep141:not-a-token.near"],
  ])("leaves %s out of every family", (_name, tokenId) => {
    expect(conversionFamily(tokenId)).toBeNull();
  });
});

describe("withdrawalPlan", () => {
  it("sends every Delivery Token directly on its own chain", () => {
    for (const { chainId, tokenId } of allDelivery) {
      expect(withdrawalPlan(tokenId, chainId), tokenId).toEqual({ kind: "direct", chainId });
    }
  });

  // The four journeys of plan 020 §6, one by one.
  it("journey 1: ETH received from Ethereum converts to eth.bridge.near on NEAR", () => {
    expect(withdrawalPlan(ETH_OMFT, "near:mainnet")).toEqual({
      kind: "conversion",
      chainId: "near:mainnet",
      family: "ETH",
      deliveryTokenId: ETH_NEAR,
      destinationAsset: ETH_NEAR,
    });
  });

  it("journey 2a: nBTC converts to Bitcoin through near.com's native-BTC asset", () => {
    expect(withdrawalPlan(NBTC, "btc:mainnet")).toEqual({
      kind: "conversion",
      chainId: "btc:mainnet",
      family: "BTC",
      deliveryTokenId: BTC_OMFT,
      destinationAsset: "1cs_v1:btc:native:coin",
    });
  });

  it("journey 2b: BTC received from Bitcoin converts to nBTC on NEAR, asked for by its own id", () => {
    expect(withdrawalPlan(BTC_OMFT, "near:mainnet")).toMatchObject({
      kind: "conversion",
      deliveryTokenId: NBTC,
      destinationAsset: NBTC,
    });
  });

  it("journey 3: USDT on Polygon and on Tron convert to USDT(NEAR)", () => {
    for (const held of [USDT_POL, USDT_TRON]) {
      expect(withdrawalPlan(held, "near:mainnet")).toMatchObject({
        kind: "conversion",
        family: "USDT",
        deliveryTokenId: USDT_NEAR,
      });
    }
  });

  it("journey 4: ETH on NEAR (presets) converts to native ETH on Ethereum", () => {
    expect(withdrawalPlan(ETH_NEAR, "eth:1")).toMatchObject({
      kind: "conversion",
      deliveryTokenId: ETH_OMFT,
      destinationAsset: ETH_OMFT,
    });
  });

  // Q3: what reaches a NEAR wallet is the NEAR version of the asset — including for the Solana
  // and Aptos stables that D-384 used to send as their own bridge token.
  it("converts the Solana and Aptos stables to NEAR instead of D-384's plain ft_withdraw", () => {
    expect(withdrawalPlan(USDC_SOL, "near:mainnet")).toMatchObject({ kind: "conversion", deliveryTokenId: USDC_NEAR });
    expect(withdrawalPlan(USDC_APT, "near:mainnet")).toMatchObject({ kind: "conversion", deliveryTokenId: USDC_NEAR });
  });

  it("keeps SOL and APT to NEAR as D-384's direct route: they are not convertible", () => {
    expect(withdrawalPlan(SOL, "near:mainnet")).toEqual({ kind: "direct", chainId: "near:mainnet" });
    expect(withdrawalPlan(APT, "near:mainnet")).toEqual({ kind: "direct", chainId: "near:mainnet" });
  });

  it("refuses a convertible token's own chain when the family is not delivered there", () => {
    // USDT on Polygon → Polygon: 1Click does not quote it and the direct route needs D-257.
    expect(withdrawalPlan(USDT_POL, "eth:137")).toEqual({ kind: "none" });
  });

  it.each([
    ["across families", ETH_OMFT, "btc:mainnet"],
    ["to a chain outside the family's row", "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near", "tron:mainnet"],
    ["for a non-convertible token off its routes", "nep141:doge.omft.near", "near:mainnet"],
    ["for an unknown token", "nep141:not-a-token.near", "near:mainnet"],
  ])("finds no route %s", (_name, held, chainId) => {
    expect(withdrawalPlan(held, chainId)).toEqual({ kind: "none" });
  });

  it("keeps a non-convertible token's own route direct", () => {
    expect(withdrawalPlan("nep141:doge.omft.near", "doge:mainnet")).toEqual({ kind: "direct", chainId: "doge:mainnet" });
    expect(withdrawalPlan(WBTC, "near:mainnet")).toEqual({ kind: "direct", chainId: "near:mainnet" });
  });
});

describe("deliveryDestinations — the order the destination picker lists", () => {
  it.each([
    ["ETH from Ethereum: its own chain, then NEAR, then the rest", ETH_OMFT, ["eth:1", "near:mainnet", "eth:42161"]],
    ["ETH on NEAR", ETH_NEAR, ["near:mainnet", "eth:1", "eth:42161"]],
    ["ETH on Arbitrum", ETH_ARB, ["eth:42161", "near:mainnet", "eth:1"]],
    ["nBTC", NBTC, ["near:mainnet", "btc:mainnet"]],
    ["USDT on Ethereum", USDT_ETH, ["eth:1", "near:mainnet", "eth:42161", "tron:mainnet", "sol:mainnet"]],
    // No direct route of its own, so it starts at NEAR.
    ["USDT on Polygon", USDT_POL, ["near:mainnet", "eth:1", "eth:42161", "tron:mainnet", "sol:mainnet"]],
  ])("%s", (_name, held, expected) => {
    expect(deliveryDestinations(held)).toEqual(expected);
  });

  it("keeps today's list for a token that does not convert", () => {
    expect(deliveryDestinations(SOL)).toEqual(withdrawalDestinations(SOL));
    expect(deliveryDestinations("near")).toEqual(["near:mainnet"]);
  });

  it("lists exactly the chains withdrawalPlan can route, for every convertible token", () => {
    const chains = [...new Set(allDelivery.map((d) => d.chainId)), "eth:137", "eth:56", "ton:mainnet"];
    for (const held of [...allDelivery, ...allOriginOnly].map((t) => t.tokenId)) {
      const routable = chains.filter((c) => withdrawalPlan(held, c).kind !== "none");
      expect(new Set(deliveryDestinations(held)), held).toEqual(new Set(routable));
    }
  });
});

describe("oneClickDestinationAsset", () => {
  it("overrides only nBTC → Bitcoin", () => {
    expect(oneClickDestinationAsset(NBTC, "btc:mainnet", BTC_OMFT)).toBe("1cs_v1:btc:native:coin");
    for (const { family, chainId, tokenId } of allDelivery) {
      for (const held of [...DELIVERY_TABLE[family].map((r) => r.tokenId), ...ORIGIN_ONLY_TOKEN_IDS[family]]) {
        if (held === NBTC && chainId === "btc:mainnet") continue;
        expect(oneClickDestinationAsset(held, chainId, tokenId)).toBe(tokenId);
      }
    }
  });
});
