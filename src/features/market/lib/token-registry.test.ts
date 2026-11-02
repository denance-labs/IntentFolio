import { describe, expect, it } from "vitest";
import { tokenRegistry, getTokenById, getTokenByNearTokenId, assetIdForNearTokenId, symbolForTokenId } from "./token-registry";

describe("tokenRegistry — sanity checks", () => {
  it("has no duplicate ids", () => {
    const ids = tokenRegistry.map((t) => t.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("has no duplicate contractIds (excluding null and NEP-245 shared contracts)", () => {
    // NEP-245 tokens share the same contractId (v2_1.omni.hot.tg) by design — they are
    // differentiated by their full id. All other non-null contractIds must be unique.
    const nep141ContractIds = tokenRegistry
      .filter((t) => t.id.startsWith("nep141:") && t.contractId !== null)
      .map((t) => t.contractId as string);
    const unique = new Set(nep141ContractIds);
    expect(unique.size).toBe(nep141ContractIds.length);
  });

  it("NEAR native entry has contractId null and decimals 24", () => {
    const near = tokenRegistry.find((t) => t.id === "near");
    expect(near).toBeDefined();
    expect(near?.contractId).toBeNull();
    expect(near?.decimals).toBe(24);
  });

  // The point of this guard is catching a 24 (NEAR's precision pasted onto a stablecoin),
  // not pinning the allowed set. 7 joined it in 4.4: Stellar denominates in stroops.
  it("stablecoins have decimals 6, 7 or 18 (no 24)", () => {
    const stables = tokenRegistry.filter((t) => t.category === "Stable");
    expect(stables.length).toBeGreaterThan(0);
    stables.forEach((t) => {
      expect([6, 7, 18], `${t.symbol}`).toContain(t.decimals);
    });
  });

  it("all tokens have a positive fallbackUsdPrice", () => {
    tokenRegistry.forEach((t) => {
      expect(t.fallbackUsdPrice).toBeGreaterThan(0);
    });
  });

  it("all tokens have non-empty symbol and name", () => {
    tokenRegistry.forEach((t) => {
      expect(t.symbol.length).toBeGreaterThan(0);
      expect(t.name.length).toBeGreaterThan(0);
    });
  });

  it("getTokenById returns the correct token", () => {
    const near = getTokenById("near");
    expect(near?.symbol).toBe("NEAR");
    const btc = getTokenById("nep141:btc.omft.near");
    expect(btc?.symbol).toBe("BTC");
  });

  // The solver copies `{id, decimals, depositable}` from this file (018 §"Respuesta del
  // solver"); a wrong decimals here would misprice every nBTC quote by powers of ten.
  it("carries nBTC with the solver's fields (D-396)", () => {
    const nbtc = getTokenById("nep141:nbtc.bridge.near");
    expect(nbtc).toMatchObject({ contractId: "nbtc.bridge.near", decimals: 8, depositable: true, assetName: "BTC" });
    expect(getTokenById("nep141:btc.omft.near")?.depositable).toBe(true);
  });

  it("getTokenById returns null for unknown id", () => {
    expect(getTokenById("nep141:does-not-exist.near")).toBeNull();
  });
});

// D-235: the PoA bridge reports NEP-245 (HOT Omni) deposits as `<contract>:<token_id>`,
// which never matched the registry's `contractId` (shared by every HOT Omni token). These
// guard the shared resolver that both the dashboard and the activity feed now use instead.
describe("assetIdForNearTokenId / getTokenByNearTokenId", () => {
  it("derives a nep245 asset id for a HOT Omni near_token_id (has a colon)", () => {
    expect(
      assetIdForNearTokenId("v2_1.omni.hot.tg:1100_111bzQBB65GxAPAVoxqmMcgYo5oS3txhqs1Uh1cgahKQUeTUq1TJu")
    ).toBe("nep245:v2_1.omni.hot.tg:1100_111bzQBB65GxAPAVoxqmMcgYo5oS3txhqs1Uh1cgahKQUeTUq1TJu");
  });

  it("derives a nep141 asset id for a bare contract near_token_id (no colon)", () => {
    expect(assetIdForNearTokenId("usdc.near")).toBe("nep141:usdc.near");
  });

  it("resolves a real HOT Omni Stellar near_token_id to its registry entry", () => {
    // This exact id is the registry's USDC(STELLAR) entry, not XLM's — the two Stellar
    // HOT Omni ids differ only in their trailing token-id segment.
    const token = getTokenByNearTokenId(
      "v2_1.omni.hot.tg:1100_111bzQBB65GxAPAVoxqmMcgYo5oS3txhqs1Uh1cgahKQUeTUq1TJu"
    );
    expect(token?.symbol).toBe("USDC(STELLAR)");
  });

  it("resolves the HOT Omni XLM near_token_id", () => {
    const token = getTokenByNearTokenId(
      "v2_1.omni.hot.tg:1100_111bzQBB5v7AhLyPMDwS8uJgQV24KaAPXtwyVWu2KXbbfQU6NXRCz"
    );
    expect(token?.symbol).toBe("XLM");
  });

  it("resolves a NEP-141 near_token_id", () => {
    const token = getTokenByNearTokenId("btc.omft.near");
    expect(token?.symbol).toBe("BTC");
  });

  it("resolves the bridge's wrap.near to the registry's NEAR (D-421)", () => {
    expect(getTokenByNearTokenId("wrap.near")?.id).toBe("near");
  });

  it("returns null for an unknown near_token_id", () => {
    expect(getTokenByNearTokenId("does-not-exist.near")).toBeNull();
  });
});

// D-235: no display surface may ever print a raw asset id. The registry resolves known
// tokens; this guards the fallback for the ones it doesn't know, which is what used to
// overflow the history table and read as a churro in the activity feed.
describe("symbolForTokenId — fallback for unknown ids", () => {
  const XLM_ID = "nep245:v2_1.omni.hot.tg:1100_111bzQBB5v7AhLyPMDwS8uJgQV24KaAPXtwyVWu2KXbbfQU6NXRCz";

  it("returns the registry symbol for a known token", () => {
    expect(symbolForTokenId(XLM_ID)).toBe("XLM");
  });

  it("keeps an unknown NEP-141 id readable — it is just an account", () => {
    expect(symbolForTokenId("nep141:does-not-exist.near")).toBe("does-not-exist.near");
  });

  it("truncates an unknown NEP-245 id instead of emitting the ~60-char token segment", () => {
    const unknown = "nep245:v2_1.omni.hot.tg:9999_zzzzQBB5v7AhLyPMDwS8uJgQV24KaAPXtwyVWu2KXbbfQU6NXRCz";
    const out = symbolForTokenId(unknown);
    expect(out).toBe("v2_1.omni.hot.tg:9999…XRCz");
    expect(out.length).toBeLessThan(30);
  });

  // The old dashboard bug persisted NEP-245 deposits under a `nep141:` prefix; those rows
  // are still in localStorage and must not blow out the layout either.
  it("truncates a malformed nep141-prefixed NEP-245 id", () => {
    const poisoned = "nep141:v2_1.omni.hot.tg:1100_111bzQBB5v7AhLyPMDwS8uJgQV24KaAPXtwyVWu2KXbbfQU6NXRCz";
    expect(symbolForTokenId(poisoned)).toBe("v2_1.omni.hot.tg:1100…XRCz");
  });
});
