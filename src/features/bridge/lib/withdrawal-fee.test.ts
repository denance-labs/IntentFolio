import { describe, it, expect, vi } from "vitest";
import {
  fetchWithdrawalFee,
  minimumWithdrawalRaw,
  staticWithdrawalFee,
  supportsLiveWithdrawalFee,
} from "./withdrawal-fee";
import type { HotFeeDeps } from "./hot-fee";
import { getWithdrawalEntry } from "./withdrawal-registry";
import { TRON_USDT_TOKEN_ID } from "./tron-usdt-fee";

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
const TRON_ADDRESS = "TMPUeGeNvHxThYZ9TLStGG369ZxqXNBSHd";

/** TronGrid's `triggerconstantcontract` answering `balanceOf` with this balance. */
function tronBalanceReturning(balance: bigint) {
  return vi.fn(async () =>
    Response.json({ result: { result: true }, constant_result: [balance.toString(16).padStart(64, "0")] })
  ) as unknown as typeof fetch;
}

function evmGasReturning(gasPriceWei: number, blockNumber: number) {
  return vi.fn(async () => ({ gasPriceWei: BigInt(gasPriceWei), blockNumber: BigInt(blockNumber) }));
}

describe("supportsLiveWithdrawalFee", () => {
  it("is true for the hot-omni chains hot-fee.ts can quote (4.3.5), and on omft only for USDT on Tron (D-584)", () => {
    expect(supportsLiveWithdrawalFee(USDT_ARB)).toBe(false);
    expect(supportsLiveWithdrawalFee(TRON_USDT_TOKEN_ID)).toBe(true);
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
  // D-584: the PoA bridge's estimate closed with its API. A flat `omft` fee is the registry's,
  // with no network call.
  it("returns the registry fee for a flat omft token, without asking anyone", async () => {
    const tronFetch = vi.fn() as unknown as typeof fetch;
    const { quote } = await fetchWithdrawalFee({ tokenId: USDT_ARB, destinationAddress: ADDRESS, tronFetch });
    expect(quote).toEqual({ feeRaw: getWithdrawalEntry(USDT_ARB)!.withdrawalFeeRaw, source: "registry" });
    expect(tronFetch).not.toHaveBeenCalled();
  });

  it("returns the registry fee for a near-native token", async () => {
    const { quote } = await fetchWithdrawalFee({ tokenId: USDC_NEAR, destinationAddress: "pablofork.near" });
    expect(quote).toEqual({ feeRaw: "0", source: "registry" });
  });

  // USDT on Tron: the fee is read off the destination (tron-usdt-fee.ts).
  it("USDT on Tron: 0.81 to an address that already holds USDT", async () => {
    const { quote } = await fetchWithdrawalFee({
      tokenId: TRON_USDT_TOKEN_ID,
      destinationAddress: TRON_ADDRESS,
      tronFetch: tronBalanceReturning(BigInt(453222670)),
    });
    expect(quote).toEqual({ feeRaw: "810000", source: "live" });
  });

  it("USDT on Tron: 1.53 to an address that holds none", async () => {
    const { quote } = await fetchWithdrawalFee({
      tokenId: TRON_USDT_TOKEN_ID,
      destinationAddress: TRON_ADDRESS,
      tronFetch: tronBalanceReturning(BigInt(0)),
    });
    expect(quote).toEqual({ feeRaw: "1530000", source: "live" });
  });

  // A failed read must never pass for a funded address: the screen would promise 0.72 too much.
  it("USDT on Tron: an unread balance keeps the registry's figure, the higher one", async () => {
    const tronFetch = vi.fn(async () => {
      throw new Error("TronGrid unreachable");
    }) as unknown as typeof fetch;
    const { quote } = await fetchWithdrawalFee({ tokenId: TRON_USDT_TOKEN_ID, destinationAddress: TRON_ADDRESS, tronFetch });
    expect(quote).toEqual({ feeRaw: "1530000", source: "registry" });
    expect(getWithdrawalEntry(TRON_USDT_TOKEN_ID)!.withdrawalFeeRaw).toBe("1530000");
  });

  it("returns null for a token with no withdrawal route", async () => {
    expect(
      (await fetchWithdrawalFee({ tokenId: "nep141:not-a-real-token", destinationAddress: ADDRESS })).quote
    ).toBeNull();
  });

  // hot-omni (4.3.5): the PoA bridge is never asked, and hot-fee.ts's live quote is returned
  // carrying the `HotFeeDetail` the envelope needs to sign — see run-real-withdraw.ts.
  it("asks hot-fee.ts for a hot-omni token", async () => {
    const evmGas = evmGasReturning(30_000_000_000, 12345);
    const { quote } = await fetchWithdrawalFee({
      tokenId: POL_NATIVE,
      destinationAddress: ADDRESS,
      hotFeeDeps: { evmGas } as HotFeeDeps,
    });
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
    const result = await fetchWithdrawalFee({
      tokenId: TRON_USDT_TOKEN_ID,
      destinationAddress: TRON_ADDRESS,
      tronFetch: tronBalanceReturning(BigInt(1)),
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

  it("prices it at zero, from the registry", async () => {
    const result = await fetchWithdrawalFee({
      tokenId: USDT_SOL,
      chainId: "near:mainnet",
      destinationAddress: "pablofork.near",
    });
    expect(result.quote).toEqual({ feeRaw: "0", source: "registry" });
  });
});
