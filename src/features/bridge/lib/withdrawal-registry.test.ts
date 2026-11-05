// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  withdrawalRegistry,
  getWithdrawalEntry,
  isWithdrawable,
  withdrawalDestinations,
  nearTokenArrival,
  NEAR_DESTINATION_CHAIN_ID,
  NEAR_REGISTRABLE_OMFT,
  _validateChainIds,
} from "./withdrawal-registry";
import { isStockToken } from "@/features/market/lib/stock-tokens";
import { tokenRegistry } from "@/features/market/lib/token-registry";
import { chainRegistry } from "./chain-registry";

describe("withdrawalRegistry", () => {
  it("all chainIds resolve to a known chainRegistry entry", () => {
    const invalid = _validateChainIds();
    expect(invalid).toHaveLength(0);
  });

  it("every entry has a non-empty nearTokenId", () => {
    for (const [id, entry] of Object.entries(withdrawalRegistry)) {
      expect(entry.nearTokenId, `${id} missing nearTokenId`).toBeTruthy();
    }
  });

  it("every entry has a non-negative withdrawalFeeRaw", () => {
    for (const [id, entry] of Object.entries(withdrawalRegistry)) {
      expect(Number(BigInt(entry.withdrawalFeeRaw)) >= 0, `${id} negative fee`).toBe(true);
    }
  });

  it("every entry has a positive minWithdrawalRaw", () => {
    for (const [id, entry] of Object.entries(withdrawalRegistry)) {
      expect(Number(BigInt(entry.minWithdrawalRaw)) > 0, `${id} zero/negative min`).toBe(true);
    }
  });

  // "near" is the deliberate exception: the key space here is the APP's token id, which
  // for 55 of 56 rows happens to equal the Defuse asset id. NEAR is the row where the two
  // differ (intents-token-id.ts), and the key has to be the one callers hold.
  it("every key is a Defuse asset id, except NEAR native", () => {
    for (const id of Object.keys(withdrawalRegistry)) {
      if (id === "near") continue;
      expect(id.startsWith("nep141:") || id.startsWith("nep245:"), `bad prefix: ${id}`).toBe(true);
    }
  });

  it("routes NEAR native out through native_withdraw, not the bridge", () => {
    const entry = withdrawalRegistry["near"];
    expect(entry.bridgeRoute).toBe("near-unwrap");
    expect(entry.chainId).toBe("near:mainnet");
    expect(entry.nearTokenId).toBe("wrap.near");
    expect(entry.withdrawalFeeRaw).toBe("0");
  });

  it("hot-omni entries all use v2_1.omni.hot.tg as nearTokenId", () => {
    for (const [id, entry] of Object.entries(withdrawalRegistry)) {
      if (entry.bridgeRoute === "hot-omni") {
        expect(entry.nearTokenId, `${id} should have hot-omni nearTokenId`).toBe("v2_1.omni.hot.tg");
      }
    }
  });

  it("hot-omni entries all have nep245: prefix", () => {
    for (const [id, entry] of Object.entries(withdrawalRegistry)) {
      if (entry.bridgeRoute === "hot-omni") {
        expect(id.startsWith("nep245:"), `${id} should be nep245`).toBe(true);
      }
    }
  });

  it("near-native entries all withdraw to near:mainnet", () => {
    for (const [id, entry] of Object.entries(withdrawalRegistry)) {
      if (entry.bridgeRoute === "near-native") {
        expect(entry.chainId, `${id} near-native should target near:mainnet`).toBe("near:mainnet");
      }
    }
  });
});

// Pinned from the LIVE PoA catalog (supported_tokens, chain-filtered to tron:mainnet) during
// the block 4.2 pre-flight, 2026-08-06. These two rows are what the Tron real-funds run is
// about to exercise, so they are asserted rather than trusted: a registry refresh that walks
// either number back re-opens the silent-loss window this pre-flight found.
//
// ⚠️ Chain-filter the query when re-measuring. `intents_token_id` is NOT unique across chains
// (nep141:sol.omft.near is SOL native on Solana AND wrapped SOL on Aptos), so an unfiltered
// catalog keyed by token id alone compares against another chain's row and invents drift.
describe("tron:mainnet withdrawal floors (measured against mainnet)", () => {
  const USDT_TRON = "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near";
  const TRX = "nep141:tron.omft.near";

  it("USDT-TRC20 carries the bridge's own floor, not a placeholder", () => {
    const entry = getWithdrawalEntry(USDT_TRON);
    expect(entry?.withdrawalFeeRaw).toBe("1000000");
    expect(entry?.minWithdrawalRaw).toBe("1000000");
  });

  it("TRX native matches the live fee and floor", () => {
    const entry = getWithdrawalEntry(TRX);
    expect(entry?.withdrawalFeeRaw).toBe("290000");
    expect(entry?.minWithdrawalRaw).toBe("1");
  });

  // The number the operator has to fund against. Stated as arithmetic so it cannot drift away
  // from the two rows above without this going red.
  it("the smallest USDT-TRC20 withdrawal that delivers the bridge floor is 2 USDT gross", () => {
    const entry = getWithdrawalEntry(USDT_TRON);
    const gross = BigInt(entry!.withdrawalFeeRaw) + BigInt(entry!.minWithdrawalRaw);
    expect(gross).toBe(BigInt(2_000_000));
  });
});

// Stellar (4.4). Measured 2026-08-07 against the live PoA catalog and cross-checked against
// 1Click; both report decimals 7 and both report exactly these two assets on stellar:mainnet.
describe("stellar:mainnet curated assets (measured against mainnet)", () => {
  const XLM = "nep245:v2_1.omni.hot.tg:1100_111bzQBB5v7AhLyPMDwS8uJgQV24KaAPXtwyVWu2KXbbfQU6NXRCz";
  const USDC_STELLAR =
    "nep245:v2_1.omni.hot.tg:1100_111bzQBB65GxAPAVoxqmMcgYo5oS3txhqs1Uh1cgahKQUeTUq1TJu";

  it("both route through HOT Omni, not omft", () => {
    for (const id of [XLM, USDC_STELLAR]) {
      const entry = getWithdrawalEntry(id);
      expect(entry?.chainId, id).toBe("stellar:mainnet");
      expect(entry?.bridgeRoute, id).toBe("hot-omni");
      expect(entry?.nearTokenId, id).toBe("v2_1.omni.hot.tg");
    }
  });

  it("both carry the live zero fee and floor of 1", () => {
    for (const id of [XLM, USDC_STELLAR]) {
      const entry = getWithdrawalEntry(id);
      expect(entry?.withdrawalFeeRaw, id).toBe("0");
      expect(entry?.minWithdrawalRaw, id).toBe("1");
    }
  });

  // The one that would fail silently and cost money. Stellar denominates in stroops (1e-7),
  // and base-unit conversion at withdraw time reads this number, so a copied neighbour is
  // off by 10x. Asserted as a hard 7 rather than "differs from its group": writing this test
  // proved the group is ALREADY mixed (USDC-BSC is 18), which is the real lesson — decimals
  // are per token, never per assetName, so there is no neighbour worth copying.
  it("both Stellar assets are 7 decimals", () => {
    for (const id of [XLM, USDC_STELLAR]) {
      expect(tokenRegistry.find((t) => t.id === id)?.decimals, id).toBe(7);
    }
  });

  it("the USDC group holds several distinct decimals, so grouping never implies precision", () => {
    const usdcDecimals = new Set(
      tokenRegistry.filter((t) => t.assetName === "USDC").map((t) => t.decimals)
    );
    expect(usdcDecimals.size).toBeGreaterThan(1);
    expect(usdcDecimals.has(7)).toBe(true);
  });

  it("stellar is the only curated chain that requires a deposit memo", () => {
    const memoChains = Object.values(withdrawalRegistry)
      .map((e) => e.chainId)
      .filter((c, i, a) => a.indexOf(c) === i)
      .filter((c) => chainRegistry[c]?.memoRequired);
    expect(memoChains).toEqual(["stellar:mainnet"]);
  });
});

describe("tokenRegistry coverage", () => {
  it("every depositable token except NEAR has a withdrawalRegistry entry", () => {
    const missing = tokenRegistry
      // A stock is the one exception: it leaves by being sold, not withdrawn (plan 039).
      .filter((t) => t.depositable && t.id !== "near" && !isStockToken(t.id))
      .filter((t) => !isWithdrawable(t.id))
      .map((t) => t.id);
    expect(missing, `missing withdrawable tokens: ${missing.join(", ")}`).toHaveLength(0);
  });

  // Was "NEAR (native) is NOT in withdrawalRegistry" until D-176: NEAR was depositable and
  // not withdrawable, the one asset that broke the rule this file exists to keep.
  it("NEAR (native) is withdrawable", () => {
    expect(isWithdrawable("near")).toBe(true);
  });
});

describe("nearTokenArrival (D-386 a)", () => {
  it("names the NEAR token an omft row lands as when sent to NEAR", () => {
    expect(nearTokenArrival("nep141:sol.omft.near", NEAR_DESTINATION_CHAIN_ID)).toBe("sol.omft.near");
  });

  it("is null on the token's own chain, for a native NEAR token and for a pair nobody offers", () => {
    expect(nearTokenArrival("nep141:sol.omft.near", "sol:mainnet")).toBeNull();
    expect(nearTokenArrival("nep141:usdt.tether-token.near", NEAR_DESTINATION_CHAIN_ID)).toBeNull();
    expect(nearTokenArrival("nep141:eth.omft.near", NEAR_DESTINATION_CHAIN_ID)).toBeNull();
  });
});

describe("getWithdrawalEntry", () => {
  it("returns an entry for a known token", () => {
    const entry = getWithdrawalEntry("nep141:btc.omft.near");
    expect(entry?.chainId).toBe("btc:mainnet");
    expect(entry?.bridgeRoute).toBe("omft");
    expect(entry?.withdrawalFeeRaw).toBe("1500");
    expect(entry?.minWithdrawalRaw).toBe("700");
  });

  it("returns an entry for a HOT Omni token", () => {
    const entry = getWithdrawalEntry("nep245:v2_1.omni.hot.tg:56_11111111111111111111");
    expect(entry?.chainId).toBe("eth:56");
    expect(entry?.bridgeRoute).toBe("hot-omni");
    expect(entry?.nearTokenId).toBe("v2_1.omni.hot.tg");
  });

  it("returns an entry for a near-native token", () => {
    const entry = getWithdrawalEntry("nep141:meta-pool.near");
    expect(entry?.chainId).toBe("near:mainnet");
    expect(entry?.bridgeRoute).toBe("near-native");
  });

  it("returns undefined for an unknown token", () => {
    expect(getWithdrawalEntry("nep141:unknown.near")).toBeUndefined();
  });

  it("returns the unwrap route for NEAR native", () => {
    expect(getWithdrawalEntry("near")?.bridgeRoute).toBe("near-unwrap");
  });
});

// D-384: an `omft` token can also leave to a NEAR account, as its own NEP-141.
describe("withdrawal destinations (D-384)", () => {
  const SOL = "nep141:sol.omft.near";
  const USDT_NEAR = "nep141:usdt.tether-token.near";
  const POL = "nep245:v2_1.omni.hot.tg:137_11111111111111111111";

  it("offers NEAR after the native chain only on the omft rows a NEAR account can register with", () => {
    for (const [id, entry] of Object.entries(withdrawalRegistry)) {
      const offersNear = entry.bridgeRoute === "omft" && NEAR_REGISTRABLE_OMFT.has(id);
      expect(withdrawalDestinations(id), id).toEqual(
        offersNear ? [entry.chainId, NEAR_DESTINATION_CHAIN_ID] : [entry.chainId]
      );
    }
    expect(withdrawalDestinations("nep141:not-a-token.near")).toEqual([]);
  });

  it("derives a near-native route for the same NEP-141, with no bridge fee or floor", () => {
    expect(getWithdrawalEntry(SOL, NEAR_DESTINATION_CHAIN_ID)).toEqual({
      chainId: "near:mainnet",
      nearTokenId: "sol.omft.near",
      withdrawalFeeRaw: "0",
      minWithdrawalRaw: "1",
      bridgeRoute: "near-native",
    });
  });

  it("returns the registry row itself for no chain or the row's own chain", () => {
    expect(getWithdrawalEntry(SOL)).toBe(withdrawalRegistry[SOL]);
    expect(getWithdrawalEntry(SOL, "sol:mainnet")).toBe(withdrawalRegistry[SOL]);
    expect(getWithdrawalEntry(USDT_NEAR, "near:mainnet")).toBe(withdrawalRegistry[USDT_NEAR]);
  });

  it("lists only omft rows as registrable", () => {
    for (const id of NEAR_REGISTRABLE_OMFT) {
      expect(withdrawalRegistry[id]?.bridgeRoute, id).toBe("omft");
    }
  });

  // `no-registration` PoA builds: only the bridge factory registers accounts, so a NEAR account
  // cannot receive them (measured on eth.omft.near, s202).
  it("does not offer NEAR on a token a NEAR account cannot register with", () => {
    expect(getWithdrawalEntry("nep141:eth.omft.near", NEAR_DESTINATION_CHAIN_ID)).toBeUndefined();
    expect(getWithdrawalEntry("nep141:btc.omft.near", NEAR_DESTINATION_CHAIN_ID)).toBeUndefined();
    expect(withdrawalDestinations("nep141:eth.omft.near")).toEqual(["eth:1"]);
  });

  it("refuses every pair nobody offered", () => {
    // hot-omni is NEP-245, which a NEAR wallet does not show.
    expect(getWithdrawalEntry(POL, NEAR_DESTINATION_CHAIN_ID)).toBeUndefined();
    expect(getWithdrawalEntry(SOL, "eth:1")).toBeUndefined();
    expect(getWithdrawalEntry(USDT_NEAR, "sol:mainnet")).toBeUndefined();
    expect(getWithdrawalEntry("nep141:not-a-token.near", NEAR_DESTINATION_CHAIN_ID)).toBeUndefined();
  });
});

describe("the derived NEAR entry (D-384)", () => {
  it("keeps one identity across calls, like a registry row", () => {
    // Hooks list the entry as a dependency; a fresh object per call looped the confirm screen.
    const a = getWithdrawalEntry("nep141:sol.omft.near", NEAR_DESTINATION_CHAIN_ID);
    expect(getWithdrawalEntry("nep141:sol.omft.near", NEAR_DESTINATION_CHAIN_ID)).toBe(a);
  });
});
