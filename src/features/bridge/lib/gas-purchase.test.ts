import { afterAll, describe, it, expect, vi } from "vitest";

const originalOneClickApiKey = vi.hoisted(() => {
  const original = process.env.NEXT_PUBLIC_ONECLICK_API_KEY;
  process.env.NEXT_PUBLIC_ONECLICK_API_KEY = "client-visible-secret";
  return original;
});
import {
  quoteGasPurchase,
  buildGasPurchaseSignRequest,
  gasPurchaseTargetRaw,
} from "./gas-purchase";
import { fetchHotGasRequirement, hotNativeAssetId, nativeGasBalanceRaw } from "./hot-fee";
import { getTokenById } from "@/features/market/lib/token-registry";

const USDT_TON = "nep245:v2_1.omni.hot.tg:1117_3tsdfyziyc7EJbP2aULWSKU4toBaAcN4FdTgfm5W1mC4ouR";
const GRAM = "nep245:v2_1.omni.hot.tg:1117_";
const USDC_STELLAR =
  "nep245:v2_1.omni.hot.tg:1100_111bzQBB65GxAPAVoxqmMcgYo5oS3txhqs1Uh1cgahKQUeTUq1TJu";
const STELLAR_ADDRESS = "GCLROWV43E4RIHPWUFOLFWGS2VJTRW46KXOPBQPGFKYJXQL47P6RTQDA";
const ACCOUNT = "8b58bb680f846d4ef55647155c4d325b318eaefd3ee385218b9e405aa2a6702e";
/** TON's flat relayer fee: 0.04 GRAM at 9 decimals. */
const FEE_RAW = "40000000";

afterAll(() => {
  if (originalOneClickApiKey === undefined) {
    delete process.env.NEXT_PUBLIC_ONECLICK_API_KEY;
  } else {
    process.env.NEXT_PUBLIC_ONECLICK_API_KEY = originalOneClickApiKey;
  }
});

/**
 * The shape 1Click really answers with, measured against the live API on 2026-08-09, plus the
 * `quoteRequest` echo every `/v0/quote` answer carries (measured since 2026-10-04, plan 020).
 */
function okBody(over: Record<string, unknown> = {}, echoOver: Record<string, unknown> = {}) {
  return {
    quote: {
      amountIn: "53459",
      amountInFormatted: "0.053459",
      amountOut: FEE_RAW,
      minAmountOut: FEE_RAW,
      depositAddress: "e2c908bfb4902ff78a71c2a4b1d3e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2",
      deadline: "2026-08-13T00:49:39.000Z",
      ...over,
    },
    quoteRequest: {
      dry: false,
      swapType: "EXACT_OUTPUT",
      slippageTolerance: 100,
      originAsset: USDT_TON,
      depositType: "INTENTS",
      destinationAsset: GRAM,
      amount: FEE_RAW,
      refundTo: ACCOUNT,
      refundType: "INTENTS",
      recipient: ACCOUNT,
      recipientType: "INTENTS",
      deadline: "2027-01-15T08:20:00.000Z",
      ...echoOver,
    },
  };
}

function fetchReturning(body: unknown, ok = true) {
  return vi.fn(async () => ({ ok, json: async () => body })) as unknown as typeof fetch;
}

function quote(over: Partial<Parameters<typeof quoteGasPurchase>[0]> = {}) {
  return quoteGasPurchase({
    tokenId: USDT_TON,
    nativeAssetId: GRAM,
    feeRaw: FEE_RAW,
    accountId: ACCOUNT,
    deps: { fetchImpl: fetchReturning(okBody()), now: () => 1_800_000_000_000 },
    ...over,
  });
}

describe("quoteGasPurchase — what it asks for", () => {
  it("asks EXACT_OUTPUT for precisely the relayer's fee, settled inside intents", async () => {
    const fetchImpl = fetchReturning(okBody());
    await quote({ deps: { fetchImpl, now: () => 1_800_000_000_000 } });

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.swapType).toBe("EXACT_OUTPUT");
    expect(sent.amount).toBe(FEE_RAW);
    expect(sent.originAsset).toBe(USDT_TON);
    expect(sent.destinationAsset).toBe(GRAM);
    // Both legs stay inside intents: nothing crosses a chain to buy five cents of gas.
    expect(sent.depositType).toBe("INTENTS");
    expect(sent.recipientType).toBe("INTENTS");
  });

  it("never sends a browser-readable 1Click key", async () => {
    const fetchImpl = fetchReturning(okBody());
    await quote({ deps: { fetchImpl, now: () => 1_800_000_000_000 } });

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(new Headers((init as RequestInit).headers).get("Authorization")).toBeNull();
  });

  // The only thing standing between a failed fill and funds with no owner.
  it("names the signer as both the recipient and the refund address", async () => {
    const fetchImpl = fetchReturning(okBody());
    await quote({ deps: { fetchImpl, now: () => 1_800_000_000_000 } });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.recipient).toBe(ACCOUNT);
    expect(sent.refundTo).toBe(ACCOUNT);
    expect(sent.refundType).toBe("INTENTS");
  });

  it("returns the deposit address and both legs of the swap", async () => {
    expect(await quote()).toEqual({
      depositAddress: "e2c908bfb4902ff78a71c2a4b1d3e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2",
      amountInRaw: "53459",
      amountOutRaw: FEE_RAW,
      tokenId: USDT_TON,
      nativeAssetId: GRAM,
    });
  });
});

describe("quoteGasPurchase — what it refuses", () => {
  // 🔴 The guard the whole module turns on. A fill that returns less gas than asked leaves
  // the withdrawal blocked anyway — but only AFTER the input has left the balance.
  it("refuses a quote that buys less gas than the fee needs", async () => {
    const short = okBody({ amountOut: String(Number(FEE_RAW) - 1) });
    expect(await quote({ deps: { fetchImpl: fetchReturning(short) } })).toBeNull();
  });

  it("accepts a quote that buys more than asked", async () => {
    const over = okBody({ amountOut: String(Number(FEE_RAW) + 1) });
    expect(await quote({ deps: { fetchImpl: fetchReturning(over) } })).not.toBeNull();
  });

  it.each([
    ["an HTTP error", okBody(), false],
    ["no deposit address", okBody({ depositAddress: "" }), true],
    ["a missing deposit address", okBody({ depositAddress: undefined }), true],
    ["a non-integer amountIn", okBody({ amountIn: "0.053459" }), true],
    ["a scientific-notation amountOut", okBody({ amountOut: "4e7" }), true],
    ["a zero input", okBody({ amountIn: "0" }), true],
    ["no quote at all", {}, true],
    ["a null body", null, true],
  ])("returns null for %s", async (_label, body, ok) => {
    expect(await quote({ deps: { fetchImpl: fetchReturning(body, ok) } })).toBeNull();
  });

  it("returns null when the request throws, rather than propagating", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await quote({ deps: { fetchImpl } })).toBeNull();
  });

  it("never asks for a fee of zero or a malformed one", async () => {
    const fetchImpl = fetchReturning(okBody());
    expect(await quote({ feeRaw: "0", deps: { fetchImpl } })).toBeNull();
    expect(await quote({ feeRaw: "0.04", deps: { fetchImpl } })).toBeNull();
    expect(await quote({ accountId: "", deps: { fetchImpl } })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("buildGasPurchaseSignRequest", () => {
  const q = {
    depositAddress: "e2c908bf",
    amountInRaw: "53459",
    amountOutRaw: FEE_RAW,
    tokenId: USDT_TON,
    nativeAssetId: GRAM,
  };

  it("signs ONE transfer to the deposit address, and nothing else", () => {
    const built = buildGasPurchaseSignRequest({
      signerId: ACCOUNT,
      quote: q,
      withdrawalAmountRaw: "5000000",
      deadlineSecs: 1_800_000_000,
      nonce: new Uint8Array(32).fill(7),
    });
    expect(built.intents).toHaveLength(1);
    expect(built.intents[0]).toEqual({
      intent: "transfer",
      receiver_id: "e2c908bf",
      tokens: { [USDT_TON]: "53459" },
    });
    // Addressed to the Verifier, like the withdrawal — never to the vault.
    expect(built.nep413.recipient).toBe("intents.near");
  });

  // 🔴 The ordering that costs real money: the token is sold FIRST and the withdrawal is
  // signed after. A purchase that consumes the whole amount leaves the user having paid for
  // gas they can no longer use, and the failure would only surface at the second signature.
  it("refuses a purchase that would consume the whole withdrawal", () => {
    expect(() =>
      buildGasPurchaseSignRequest({
        signerId: ACCOUNT,
        quote: { ...q, amountInRaw: "5000000" },
        withdrawalAmountRaw: "5000000",
      })
    ).toThrow(/consume the whole amount/);
  });

  it("refuses a purchase with no withdrawal to compare against", () => {
    expect(() =>
      buildGasPurchaseSignRequest({
        signerId: ACCOUNT,
        quote: q,
        withdrawalAmountRaw: "",
      })
    ).toThrow(/withdrawal amount/);
  });
});

// ── The margin: per chain, because the reason for one is per chain ──────────────
describe("gasPurchaseTargetRaw", () => {
  it("buys double on a chain whose fee is a live gas price", () => {
    // 🔴 On the four EVM chains the requirement is `floor(gasPrice * 1.3) * 200_000`, read at
    // quote time. Buying it exactly leaves the withdrawal one tick away from blocked again —
    // and a blocked screen offers to buy again, which is a second real payment.
    expect(gasPurchaseTargetRaw("40000000", "eth:137")).toBe("80000000");
    expect(gasPurchaseTargetRaw("1", "eth:56")).toBe("2");
    expect(gasPurchaseTargetRaw("73231801349800000", "eth:10")).toBe("146463602699600000");
  });

  it("buys EXACTLY the requirement where the fee is a constant", () => {
    // 🔴 TON is a flat constant and Stellar is two constants, so there is no drift for a margin
    // to absorb and the surplus would be charged for nothing. Notably 2x never protected
    // Stellar's real failure mode either: its jump is 0.1 → 1.1 XLM, and 0.2 is just as blocked
    // as 0.1. See the table in gas-purchase.ts.
    expect(gasPurchaseTargetRaw("40000000", "ton:mainnet")).toBe("40000000");
    expect(gasPurchaseTargetRaw("1000000", "stellar:mainnet")).toBe("1000000");
    expect(gasPurchaseTargetRaw("11000000", "stellar:mainnet")).toBe("11000000");
  });

  it("falls back to the safe 2x for a chain nobody has classified", () => {
    // Over-buying leaves recoverable change; under-buying blocks a withdrawal and bills a
    // second purchase. A new chain gets the direction that cannot strand anyone.
    expect(gasPurchaseTargetRaw("40000000", "sui:mainnet")).toBe("80000000");
    expect(gasPurchaseTargetRaw("40000000", "")).toBe("80000000");
  });

  it("refuses anything that is not a positive base-unit integer", () => {
    for (const bad of ["0", "", "1.5", "-3", "abc"]) {
      expect(gasPurchaseTargetRaw(bad, "ton:mainnet")).toBeNull();
    }
  });
});

// ── What makes buying EXACTLY safe, and the one thing that would break it ───────
//
// `nativeGasBalanceRaw` (withdrawal-modal.tsx) re-reads the gas balance in HUMAN units as a
// double and re-scales it with `Math.floor`, so its error points DOWNWARDS (D-206). Buy exactly
// the requirement, land exactly at it, lose one base unit to that floor, and the screen stays
// blocked on gas that is really there — and offers to buy again, which is the failure the
// margin removal must not introduce.
//
// It holds for the real fee constants, but as a property of THOSE NUMBERS, not as a general
// one: a sweep of plausible values at these decimals finds ~4.5% that do lose a unit. So this
// pins the actual constants, taken from the real code path, and it is what a decimals change in
// the token registry would break.
describe("the exact-purchase floor invariant (D-206)", () => {
  /**
   * Buy `target`, land exactly on it from a zero balance, and re-read it the way the screen
   * does. `nativeGasBalanceRaw` is CALLED, never reimplemented: the first version of this test
   * hand-copied its arithmetic and passed against a mutation that subtracted a base unit
   * inside the real function — which is the entire failure it exists to catch.
   */
  const stillCoversAfterRoundTrip = (chainId: string, target: string): boolean => {
    const nativeAssetId = hotNativeAssetId(chainId)!;
    const decimals = getTokenById(nativeAssetId)!.decimals;
    const human = Number(target) / Math.pow(10, decimals);
    const readBack = nativeGasBalanceRaw(chainId, new Map([[nativeAssetId, human]]));
    return readBack !== undefined && BigInt(readBack) >= BigInt(target);
  };

  it("survives the human-units round trip for TON's real requirement", async () => {
    const need = await fetchHotGasRequirement({ tokenId: USDT_TON });
    expect(need).not.toBeNull();
    expect(getTokenById(need!.nativeAssetId)?.decimals).toBe(9);
    const target = gasPurchaseTargetRaw(need!.relayerFeeRaw, "ton:mainnet");
    expect(target).toBe(need!.relayerFeeRaw); // exact, no margin
    expect(stillCoversAfterRoundTrip("ton:mainnet", target!)).toBe(true);
  });

  it("survives it for BOTH of Stellar's requirements", async () => {
    // Both branches, because which one applies is a property of the destination account and
    // the expensive one is what every uncertain Horizon answer resolves to.
    for (const exists of [true, false]) {
      const need = await fetchHotGasRequirement({
        tokenId: USDC_STELLAR,
        destinationAddress: STELLAR_ADDRESS,
        deps: { stellarAccountExists: async () => exists },
      });
      expect(need).not.toBeNull();
      expect(getTokenById(need!.nativeAssetId)?.decimals).toBe(7);
      const target = gasPurchaseTargetRaw(need!.relayerFeeRaw, "stellar:mainnet");
      expect(target).toBe(need!.relayerFeeRaw);
      expect(stillCoversAfterRoundTrip("stellar:mainnet", target!)).toBe(true);
    }
  });
});

describe("quoteGasPurchase — the delivery floor", () => {
  it("judges the fill by minAmountOut, not by the expected amountOut", async () => {
    // The request carries 1% of slippage tolerance. `amountOut` is what 1Click expects to
    // fill; `minAmountOut` is what it is contractually willing to deliver. Accepting on the
    // first would take a quote allowed to hand back less gas than the fee — discovered only
    // after the input had left the balance.
    const q = await quote({
      deps: {
        fetchImpl: fetchReturning(
          okBody({ amountOut: FEE_RAW, minAmountOut: String(BigInt(FEE_RAW) - BigInt(1)) })
        ),
        now: () => 1_800_000_000_000,
      },
    });
    expect(q).toBeNull();
  });

  it("accepts a fill whose guaranteed floor still covers the fee", async () => {
    const q = await quote({
      deps: {
        fetchImpl: fetchReturning(
          okBody({ amountOut: String(BigInt(FEE_RAW) + BigInt(5)), minAmountOut: FEE_RAW })
        ),
        now: () => 1_800_000_000_000,
      },
    });
    expect(q).not.toBeNull();
  });

  it("falls back to amountOut when the response carries no floor at all", async () => {
    const body = okBody();
    delete (body.quote as Record<string, unknown>).minAmountOut;
    const q = await quote({
      deps: { fetchImpl: fetchReturning(body), now: () => 1_800_000_000_000 },
    });
    expect(q?.amountOutRaw).toBe(FEE_RAW);
  });
});

describe("quoteGasPurchase — the request echo (D-447)", () => {
  // The request is the contract: 1Click delivers the asset and refunds to the account WRITTEN
  // IN THE REQUEST. A quote whose echo disagrees is a quote about somebody else's trade, so it
  // never reaches a signature — the same G1 rule Converting Withdrawals apply.
  it.each([
    ["originAsset", USDC_STELLAR],
    ["destinationAsset", USDT_TON],
    ["amount", String(BigInt(FEE_RAW) + BigInt(1))],
    ["refundTo", "attacker.near"],
    ["recipient", "attacker.near"],
    ["swapType", "EXACT_INPUT"],
    ["depositType", "ORIGIN_CHAIN"],
    ["refundType", "ORIGIN_CHAIN"],
    ["recipientType", "DESTINATION_CHAIN"],
  ])("refuses a quote whose echo disagrees on %s", async (field, value) => {
    const body = okBody({}, { [field]: value });
    expect(await quote({ deps: { fetchImpl: fetchReturning(body) } })).toBeNull();
  });

  it("refuses a quote that carries no echo at all", async () => {
    const body: Record<string, unknown> = okBody();
    delete body.quoteRequest;
    expect(await quote({ deps: { fetchImpl: fetchReturning(body) } })).toBeNull();
  });

  it("proceeds on an echo that matches what was sent", async () => {
    expect(await quote({ deps: { fetchImpl: fetchReturning(okBody()) } })).not.toBeNull();
  });
});
