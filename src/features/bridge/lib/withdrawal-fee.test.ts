import { describe, it, expect, vi } from "vitest";
import {
  fetchWithdrawalFee,
  minimumWithdrawalRaw,
  staticWithdrawalFee,
  supportsLiveWithdrawalFee,
} from "./withdrawal-fee";
import type { HotFeeDeps } from "./hot-fee";
import { getWithdrawalEntry } from "./withdrawal-registry";

// USDT on Arbitrum — the `omft` route the wet test (§8.5 P4 ②) actually runs, 6 decimals,
// registry fee 5300 base units.
const USDT_ARB = "nep141:arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near";
// USDC on NEAR — `near-native`, fee genuinely 0 and no bridge to ask.
const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
// POL native on Polygon — `hot-omni`, native so no solver swap is needed for its fee.
const POL_NATIVE = "nep245:v2_1.omni.hot.tg:137_11111111111111111111";
// USDC on Polygon — `hot-omni` and NOT the chain's gas, so its fee needs a solver swap and
// the screen blocks when nobody quotes one. That is the state D-274 lives in.
const USDC_POLYGON = "nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L";

const ADDRESS = "0x195d287fB6E1fbBaaC18cB6C7DB0050388Ed8B00";

function estimateReturning(withdrawalFee: string, withdrawalFeeDecimals: number) {
  return vi.fn(async () => ({
    withdrawalFee,
    withdrawalFeeDecimals,
  })) as unknown as Parameters<typeof fetchWithdrawalFee>[0]["estimate"];
}

function evmGasReturning(gasPriceWei: number, blockNumber: number) {
  return vi.fn(async () => ({ gasPriceWei: BigInt(gasPriceWei), blockNumber: BigInt(blockNumber) }));
}

describe("supportsLiveWithdrawalFee", () => {
  it("is true for omft and for the hot-omni chains hot-fee.ts can quote (4.3.5)", () => {
    expect(supportsLiveWithdrawalFee(USDT_ARB)).toBe(true);
    expect(supportsLiveWithdrawalFee(POL_NATIVE)).toBe(true);
    expect(supportsLiveWithdrawalFee(USDC_NEAR)).toBe(false);
    expect(supportsLiveWithdrawalFee("nep141:not-a-real-token")).toBe(false);
  });
});

describe("staticWithdrawalFee", () => {
  it("returns the registry snapshot, marked as such", () => {
    const entry = getWithdrawalEntry(USDT_ARB)!;
    expect(staticWithdrawalFee(USDT_ARB)).toEqual({
      feeRaw: entry.withdrawalFeeRaw,
      source: "registry",
    });
  });

  it("returns null for a token with no withdrawal route", () => {
    expect(staticWithdrawalFee("nep141:not-a-real-token")).toBeNull();
  });
});

describe("fetchWithdrawalFee", () => {
  it("returns the live quote for an omft token", async () => {
    const estimate = estimateReturning("7100", 6);
    const { quote } = await fetchWithdrawalFee({
      tokenId: USDT_ARB,
      destinationAddress: ADDRESS,
      estimate,
    });
    expect(quote).toEqual({ feeRaw: "7100", source: "live" });
  });

  it("asks the bridge with the registry's own near_token_id and chain", async () => {
    const estimate = estimateReturning("7100", 6);
    await fetchWithdrawalFee({ tokenId: USDT_ARB, destinationAddress: ADDRESS, estimate });
    const entry = getWithdrawalEntry(USDT_ARB)!;
    expect(estimate).toHaveBeenCalledWith(
      { token: entry.nearTokenId, address: ADDRESS, chain: entry.chainId },
      expect.anything()
    );
  });

  it("never calls the bridge for a near-native token, and returns its registry fee", async () => {
    const estimate = estimateReturning("999", 6);
    const { quote } = await fetchWithdrawalFee({
      tokenId: USDC_NEAR,
      destinationAddress: "pablofork.near",
      estimate,
    });
    expect(estimate).not.toHaveBeenCalled();
    expect(quote).toEqual({ feeRaw: "0", source: "registry" });
  });

  // The point of the whole module: a fee lookup is a nicety, and a withdrawal must not be
  // blocked by one. Every failure mode lands on the registry snapshot.
  it("falls back to the registry when the bridge throws", async () => {
    const estimate = vi.fn(async () => {
      throw new Error("bridge unreachable");
    }) as unknown as Parameters<typeof fetchWithdrawalFee>[0]["estimate"];
    const { quote } = await fetchWithdrawalFee({
      tokenId: USDT_ARB,
      destinationAddress: ADDRESS,
      estimate,
    });
    expect(quote).toEqual({ feeRaw: getWithdrawalEntry(USDT_ARB)!.withdrawalFeeRaw, source: "registry" });
  });

  it("falls back when the response is not a base-unit integer", async () => {
    const estimate = estimateReturning("0.0053", 6);
    const { quote } = await fetchWithdrawalFee({
      tokenId: USDT_ARB,
      destinationAddress: ADDRESS,
      estimate,
    });
    expect(quote?.source).toBe("registry");
  });

  // The dangerous one: 7100 at 18 decimals is not 7100 at 6 decimals, and rendering it as
  // though it were would understate the fee by a factor of 10^12.
  it("falls back when the response's precision is not the token's", async () => {
    const estimate = estimateReturning("7100", 18);
    const { quote } = await fetchWithdrawalFee({
      tokenId: USDT_ARB,
      destinationAddress: ADDRESS,
      estimate,
    });
    expect(quote?.source).toBe("registry");
  });

  it("returns null for a token with no withdrawal route", async () => {
    const estimate = estimateReturning("1", 6);
    expect(
      (
        await fetchWithdrawalFee({
          tokenId: "nep141:not-a-real-token",
          destinationAddress: ADDRESS,
          estimate,
        })
      ).quote
    ).toBeNull();
    expect(estimate).not.toHaveBeenCalled();
  });

  // hot-omni (4.3.5): the PoA bridge is never asked, and hot-fee.ts's live quote is returned
  // carrying the `HotFeeDetail` the envelope needs to sign — see run-real-withdraw.ts.
  it("asks hot-fee.ts, not the bridge, for a hot-omni token", async () => {
    const estimate = estimateReturning("999", 18);
    const evmGas = evmGasReturning(30_000_000_000, 12345);
    const { quote } = await fetchWithdrawalFee({
      tokenId: POL_NATIVE,
      destinationAddress: ADDRESS,
      estimate,
      hotFeeDeps: { evmGas } as HotFeeDeps,
    });
    expect(estimate).not.toHaveBeenCalled();
    expect(quote?.source).toBe("live");
    expect(quote?.hot).toBeDefined();
    expect(quote?.hot?.blockNumber).toBe("12345");
  });

  // The rule 4.3.5 exists to enforce: HOT has no registry snapshot to fall back to, because
  // that snapshot carries neither the blockNumber nor the solver quote the signed intent
  // needs — a stale number here is not "less fresh", it is a contract rejection.
  it("returns null — never the registry fee — when the live HOT quote cannot be built", async () => {
    const evmGas = vi.fn(async () => {
      throw new Error("RPC unreachable");
    });
    const { quote } = await fetchWithdrawalFee({
      tokenId: POL_NATIVE,
      destinationAddress: ADDRESS,
      hotFeeDeps: { evmGas } as HotFeeDeps,
    });
    expect(quote).toBeNull();
  });

  // 🔴 D-274. The blocked screen still has work to do — it has to offer the gas purchase that
  // unblocks it — and sizing that offer needs the requirement. Recovering it with a second,
  // independent lookup is the bug; carrying it out of the same pass is the fix.
  it("carries the gas requirement out even when there is no quote to show", async () => {
    const evmGas = evmGasReturning(30_000_000_000, 12345);
    // No solver quotes a `hot.tg` native (D-251), so the fee has no way to be paid.
    const quoteDep = vi.fn(async () => {
      throw new Error("no solver filled it");
    });
    const { quote, hotRequirement } = await fetchWithdrawalFee({
      tokenId: USDC_POLYGON,
      destinationAddress: ADDRESS,
      hotFeeDeps: { evmGas, quote: quoteDep } as unknown as HotFeeDeps,
    });
    expect(quote).toBeNull();
    // `floor(30e9 * 1.3) * 200_000`, the same arithmetic the sufficiency check just used.
    expect(hotRequirement?.relayerFeeRaw).toBe("7800000000000000");
    expect(hotRequirement?.nativeAssetId).toBe(POL_NATIVE);
  });

  // The other `null`, which must NOT be confused with the one above: no gas price means no
  // figure to buy against, so a caller has nothing to offer and must not pretend otherwise.
  it("reports no requirement when the chain itself is unreachable", async () => {
    const { quote, hotRequirement } = await fetchWithdrawalFee({
      tokenId: USDC_POLYGON,
      destinationAddress: ADDRESS,
      hotFeeDeps: {
        evmGas: vi.fn(async () => {
          throw new Error("RPC unreachable");
        }),
      } as HotFeeDeps,
    });
    expect(quote).toBeNull();
    expect(hotRequirement).toBeNull();
  });

  // `omft` has no gas purchase and no requirement to carry; the field must stay absent rather
  // than arrive as a plausible-looking `null` that a caller could act on.
  it("leaves the requirement off entirely on the routes that have none", async () => {
    const estimate = estimateReturning("5300", 6);
    const result = await fetchWithdrawalFee({
      tokenId: USDT_ARB,
      destinationAddress: ADDRESS,
      estimate,
    });
    expect(result.quote?.source).toBe("live");
    expect("hotRequirement" in result).toBe(false);
  });
});

// D-384: the same omft token sent to NEAR crosses no bridge, so nothing here may price one.
describe("an omft token sent to NEAR (D-384)", () => {
  const USDT_SOL = "nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near";
  it("has no bridge fee, no live quote and no bridge floor", async () => {
    expect(supportsLiveWithdrawalFee(USDT_SOL, "near:mainnet")).toBe(false);
    expect(staticWithdrawalFee(USDT_SOL, "near:mainnet")).toEqual({ feeRaw: "0", source: "registry" });
    expect(minimumWithdrawalRaw(USDT_SOL, undefined, "near:mainnet")).toBe("1");
    // The native route keeps its own figures.
    const own = getWithdrawalEntry(USDT_SOL)!;
    expect(minimumWithdrawalRaw(USDT_SOL)).toBe(
      (BigInt(own.withdrawalFeeRaw) + BigInt(own.minWithdrawalRaw)).toString()
    );
  });

  it("never asks the bridge for an estimate", async () => {
    const estimate = estimateReturning("5300", 6);
    const result = await fetchWithdrawalFee({
      tokenId: USDT_SOL,
      chainId: "near:mainnet",
      destinationAddress: "pablofork.near",
      estimate,
    });
    expect(result.quote).toEqual({ feeRaw: "0", source: "registry" });
    expect(estimate).not.toHaveBeenCalled();
  });
});
