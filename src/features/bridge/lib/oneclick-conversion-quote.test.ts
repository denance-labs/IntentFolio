import { describe, expect, it, vi } from "vitest";
import {
  CONVERSION_LOSS_CEILING_BPS,
  CONVERSION_QUOTE_DEADLINE_SECS,
  CONVERSION_SLIPPAGE_BPS,
  NEAR_DELIVERY_FEE_CEILING_RAW,
  tokenAccountFeeCeiling,
  conversionCostBps,
  normalizedLoss,
  quoteConversion,
  type ConversionQuoteResult,
  type QuoteConversionParams,
} from "./oneclick-conversion-quote";

// ── Recorded 2026-10-06 (s225) from the live API with `scripts/measure-conversion-quotes.py`.
// Verbatim responses: the guards are tested against what 1Click really says, not a paraphrase.
// `appFees` is 1Click's own fee line (not sent by us) — kept as recorded.
const APP_FEE_1BP = [
  { recipient: "5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd", fee: 1, limitOrderId: null },
];
const ECHO_EXTRAS = { depositMode: "SIMPLE", confidentiality: "public", quoteWaitingTimeMs: 0, insured: false };

/** Journey 1: ETH received from Ethereum → a NEAR wallet (registered). 18 → 18 decimals. */
const ETH_TO_NEAR = {
  quote: {
    amountIn: "5000000000000000", amountInFormatted: "0.005", amountInUsd: "13.569750000000",
    minAmountIn: "5000000000000000", amountOut: "4998990052004899",
    amountOutFormatted: "0.004998990052004899", amountOutUsd: "13.567009051639",
    minAmountOut: "4973995101744874", timeEstimate: 10, refundFee: "0", withdrawFee: "0",
    deadline: "2026-10-09T10:27:22.000Z", timeWhenInactive: "2026-10-09T10:27:22.000Z",
    depositAddress: "5863efabda6c40d89b37aa899add569e32cb7a670e6b56a7f2cbb8d62c5333a0",
  },
  quoteRequest: {
    dry: false, ...ECHO_EXTRAS, swapType: "EXACT_INPUT", slippageTolerance: 50,
    originAsset: "nep141:eth.omft.near", depositType: "INTENTS",
    destinationAsset: "nep141:eth.bridge.near", amount: "5000000000000000",
    refundTo: "pablofork.near", refundType: "INTENTS", recipient: "pablofork.near",
    recipientType: "DESTINATION_CHAIN", deadline: "2026-10-06T10:27:22.000Z", appFees: APP_FEE_1BP,
  },
  signature: "ed25519:3pqqpV5Xz3UboL1wq7TjCeJ9AD6xQUzSSZ2FAawWc7MPLqn4vsW4U3vfZHUeBrVGFM2kbdkvpq69F7gZUHUeybHr",
  timestamp: "2026-10-06T10:17:23.945Z",
  correlationId: "e0303e99-cd26-46da-8b3b-f30941df88e9",
};

/** Journey 2a: nBTC → Bitcoin through `1cs_v1:btc:native:coin`. 8 → 8, Network Fee 1900 sats. */
const NBTC_TO_BITCOIN = {
  quote: {
    amountIn: "20000", amountInFormatted: "0.0002", amountInUsd: "17.225400000000",
    minAmountIn: "20000", amountOut: "18100", amountOutFormatted: "0.000181",
    amountOutUsd: "15.588987000000", minAmountOut: "18009", timeEstimate: 455, refundFee: "0",
    withdrawFee: "1900", deadline: "2026-10-09T10:27:41.000Z", timeWhenInactive: "2026-10-09T10:27:41.000Z",
    depositAddress: "0a6d62b48afbcd40ec1f44812d6781afca8abe4f0b60d078f7808c18a3763bb7",
  },
  quoteRequest: {
    dry: false, ...ECHO_EXTRAS, swapType: "EXACT_INPUT", slippageTolerance: 50,
    originAsset: "nep141:nbtc.bridge.near", depositType: "INTENTS",
    destinationAsset: "1cs_v1:btc:native:coin", amount: "20000", refundTo: "pablofork.near",
    refundType: "INTENTS", recipient: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
    recipientType: "DESTINATION_CHAIN", deadline: "2026-10-06T10:27:41.000Z", appFees: [],
  },
  signature: "ed25519:44A6EZSjRvKJk8sJFhkkQqmT4dtAXcjbwauTyRU5awovuELrWkcpQWyvdx6aSHR6dn31L2y82UC3HK34ha2uEnRX",
  timestamp: "2026-10-06T10:17:42.495Z",
  correlationId: "a40bd184-4518-4165-8903-1298e4f1092c",
};

/** BTC from Bitcoin → nBTC at a NEAR account NOT registered on nBTC: 1Click charges 8 sats. */
const BTC_TO_UNREGISTERED_NEAR = {
  quote: {
    amountIn: "20000", amountInFormatted: "0.0002", amountInUsd: "17.208200000000",
    minAmountIn: "20000", amountOut: "19986", amountOutFormatted: "0.00019986",
    amountOutUsd: "17.196154260000", minAmountOut: "19886", timeEstimate: 10, refundFee: "0",
    withdrawFee: "8", deadline: "2026-10-09T10:47:43.000Z", timeWhenInactive: "2026-10-09T10:47:43.000Z",
    depositAddress: "62592aff775e2c8869921d43d71aa2aeae6110d054edc01db24fd6a642a30795",
  },
  quoteRequest: {
    dry: false, ...ECHO_EXTRAS, swapType: "EXACT_INPUT", slippageTolerance: 50,
    originAsset: "nep141:btc.omft.near", depositType: "INTENTS",
    destinationAsset: "nep141:nbtc.bridge.near", amount: "20000", refundTo: "pablofork.near",
    refundType: "INTENTS", recipient: "app.near", recipientType: "DESTINATION_CHAIN",
    deadline: "2026-10-06T10:47:43.000Z", appFees: APP_FEE_1BP,
  },
  signature: "ed25519:4HvwrgKzh6dxfbegr85QtBxH6p8Me4GoZde9fgzxz47yZqygUV7Qh7zeJUVfKN4W2yX4y72v7diVPjDzFb9Lj3RJ",
  timestamp: "2026-10-06T10:37:43.759Z",
  correlationId: "c38ca225-f29e-43cb-a51a-c3a340665da2",
};

/** USDT on BSC (18 decimals) → USDT(NEAR) (6). The decimals case of plan 020-1's risks. */
const USDT_BSC_TO_NEAR = {
  quote: {
    amountIn: "20000000000000000000", amountInFormatted: "20.0", amountInUsd: "19.996880000000",
    minAmountIn: "20000000000000000000", amountOut: "19995960", amountOutFormatted: "19.99596",
    amountOutUsd: "19.992840630240", minAmountOut: "19895980", timeEstimate: 10, refundFee: "0",
    withdrawFee: "0", deadline: "2026-10-09T10:34:12.000Z", timeWhenInactive: "2026-10-09T10:34:12.000Z",
    depositAddress: "78876fc3d0a2e2a7f52a933c229f1a5f3e6c9699dee2be6dc8fc1dd84667d08b",
  },
  quoteRequest: {
    dry: false, ...ECHO_EXTRAS, swapType: "EXACT_INPUT", slippageTolerance: 50,
    originAsset: "nep245:v2_1.omni.hot.tg:56_2CMMyVTGZkeyNZTSvS5sarzfir6g", depositType: "INTENTS",
    destinationAsset: "nep141:usdt.tether-token.near", amount: "20000000000000000000",
    refundTo: "pablofork.near", refundType: "INTENTS", recipient: "pablofork.near",
    recipientType: "DESTINATION_CHAIN", deadline: "2026-10-06T10:34:12.000Z", appFees: APP_FEE_1BP,
  },
  signature: "ed25519:41e8PmUYopziBJZicDn75pNXet66MvtgvyXdPMzYVn2KhR6v1RaVs9Ut5YDUtZrL3L52dUTgBXjumqAxhvAxAN76",
  timestamp: "2026-10-06T10:24:14.704Z",
  correlationId: "97c04b75-b301-46cf-89d5-09234b8fe99c",
};

/** USDC on Stellar (7 decimals) → USDC on Ethereum (6), Network Fee 0.30 USDC. */
const USDC_STELLAR_TO_ETHEREUM = {
  quote: {
    amountIn: "200000000", amountInFormatted: "20.0", amountInUsd: "19.999340000000",
    minAmountIn: "200000000", amountOut: "19695960", amountOutFormatted: "19.69596",
    amountOutUsd: "19.695310033320", minAmountOut: "19597480", timeEstimate: 17, refundFee: "0",
    withdrawFee: "300000", deadline: "2026-10-09T10:31:47.000Z", timeWhenInactive: "2026-10-09T10:31:47.000Z",
    depositAddress: "18799d9436eedecbc146ff247168cb51cd3d9967cc66df5e1adddb1c74274e4c",
  },
  quoteRequest: {
    dry: false, ...ECHO_EXTRAS, swapType: "EXACT_INPUT", slippageTolerance: 50,
    originAsset: "nep245:v2_1.omni.hot.tg:1100_111bzQBB65GxAPAVoxqmMcgYo5oS3txhqs1Uh1cgahKQUeTUq1TJu",
    depositType: "INTENTS", destinationAsset: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
    amount: "200000000", refundTo: "pablofork.near", refundType: "INTENTS",
    recipient: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045", recipientType: "DESTINATION_CHAIN",
    deadline: "2026-10-06T10:31:47.000Z", appFees: APP_FEE_1BP,
  },
  signature: "ed25519:5cXTwnmCd81vzTTCpj8mjbR6YGwX82DjrQbUWzdHuytLaUusxxzqjUTwjn4HJn7CjMGpaheVBRrHCKSPTcgR6mLZ",
  timestamp: "2026-10-06T10:21:48.856Z",
  correlationId: "9fcb3445-e851-4a18-b652-3116affee5d5",
};

/** USDT(NEAR) → Tron, Network Fee 0.917954 USDT (registry: 1 USDT). */
const USDT_NEAR_TO_TRON = {
  quote: {
    amountIn: "20000000", amountInFormatted: "20.0", amountInUsd: "19.996800000000",
    minAmountIn: "20000000", amountOut: "19077279", amountOutFormatted: "19.077279",
    amountOutUsd: "19.074226635360", minAmountOut: "18981892", timeEstimate: 65, refundFee: "0",
    withdrawFee: "917954", deadline: "2026-10-09T10:32:15.000Z", timeWhenInactive: "2026-10-09T10:32:15.000Z",
    depositAddress: "10197c80fbf0195e9e32e88ae71acff3a36e9904869122f3782867cfd7a37646",
  },
  quoteRequest: {
    dry: false, ...ECHO_EXTRAS, swapType: "EXACT_INPUT", slippageTolerance: 50,
    originAsset: "nep141:usdt.tether-token.near", depositType: "INTENTS",
    destinationAsset: "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near",
    amount: "20000000", refundTo: "pablofork.near", refundType: "INTENTS",
    recipient: "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7", recipientType: "DESTINATION_CHAIN",
    deadline: "2026-10-06T10:32:15.000Z", appFees: APP_FEE_1BP,
  },
  signature: "ed25519:2q5LsvE8qbNASnEenn1nceoyFNfvXFDinxQAap7AfrwRQsQmn5CFdDEXX31EeVLb2HLocUBcqoXm9i7h4NN7vAw4",
  timestamp: "2026-10-06T10:22:16.042Z",
  correlationId: "3d86ee47-2d89-4895-8490-5fde79245f1a",
};

/**
 * USDC(NEAR) → Solana, 2 USDC, recorded 2026-10-07 (s231, D-441). The same request twice: to a
 * wallet that already holds USDC (Network Fee 10156) and to a fresh one, whose USDC account the
 * delivery has to open (314337 — the rent deposit, ≈ US$0.30).
 */
const USDC_NEAR_TO_SOLANA_WITH_ACCOUNT = {
  quote: {
    amountIn: "2000000", amountInFormatted: "2.0", amountInUsd: "1.999720000000",
    minAmountIn: "2000000", amountOut: "1989440", amountOutFormatted: "1.98944",
    amountOutUsd: "1.989161478400", minAmountOut: "1979492", timeEstimate: 7, refundFee: "0",
    withdrawFee: "10156", deadline: "2026-10-10T12:39:57.000Z", timeWhenInactive: "2026-10-10T12:39:57.000Z",
    depositAddress: "8a1d7c18230a8bc2301638d43edff915e269a1ea98397447dbb90abe78427836",
  },
  quoteRequest: {
    dry: false, ...ECHO_EXTRAS, swapType: "EXACT_INPUT", slippageTolerance: 50,
    originAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    depositType: "INTENTS", destinationAsset: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
    amount: "2000000", refundTo: "pablofork.near", refundType: "INTENTS",
    recipient: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", recipientType: "DESTINATION_CHAIN",
    deadline: "2026-10-07T12:39:57.000Z", appFees: APP_FEE_1BP,
  },
  signature: "ed25519:29FTQxsns5sz9YnWTag3C87RLQKoAsrwiXWebcN2bAe4dLiVUcv9A8fnvPJTBNS5Xbi4rmNuz5i9peRrZJdE3zPh",
  timestamp: "2026-10-07T12:30:00.914Z",
  correlationId: "973ce182-d98f-4c4b-9c06-36e3cd420427",
};

const USDC_NEAR_TO_SOLANA_NO_ACCOUNT = {
  quote: {
    amountIn: "2000000", amountInFormatted: "2.0", amountInUsd: "1.999720000000",
    minAmountIn: "2000000", amountOut: "1685259", amountOutFormatted: "1.685259",
    amountOutUsd: "1.685023063740", minAmountOut: "1676832", timeEstimate: 7, refundFee: "0",
    withdrawFee: "314337", deadline: "2026-10-10T12:39:59.000Z", timeWhenInactive: "2026-10-10T12:39:59.000Z",
    depositAddress: "94588adbf5c1a3a9af214ee0138c3063dcfb85d1bb74392bfcef1f5669ce58bb",
  },
  quoteRequest: {
    dry: false, ...ECHO_EXTRAS, swapType: "EXACT_INPUT", slippageTolerance: 50,
    originAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    depositType: "INTENTS", destinationAsset: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
    amount: "2000000", refundTo: "pablofork.near", refundType: "INTENTS",
    recipient: "BdkG96BeReYDiAXd3E3q4ZcPDVgDntzHgaNJawnNB3K", recipientType: "DESTINATION_CHAIN",
    deadline: "2026-10-07T12:39:59.000Z", appFees: APP_FEE_1BP,
  },
  signature: "ed25519:4QA9krT31xuYWQbB5hptBAa58oifx74iNTsNNf3w21pbg5x9b9QpSUTQgLXwTTQBFN2qPVrNFVgdy1DV34QikQQi",
  timestamp: "2026-10-07T12:30:01.973Z",
  correlationId: "c98ef6a0-0041-4244-89c1-7dcd1a1768f0",
};

/** The 400 1Click answers below a bridge floor, origin at 18 decimals — N is in ORIGIN units. */
const BELOW_TRON_FLOOR = {
  message: "Amount is too low for bridge, try at least 1928333454953453638",
  correlationId: "ee873f71-536f-46b7-b8b5-be3117c6e048",
  timestamp: "2026-10-06T10:25:52.207Z",
  path: "/v0/quote",
};

type Recorded = typeof ETH_TO_NEAR;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** The clock that makes our request's deadline land exactly on the recorded one. */
function nowFor(recorded: Recorded): number {
  return Date.parse(recorded.quoteRequest.deadline) - CONVERSION_QUOTE_DEADLINE_SECS * 1000;
}

/** The request that reproduces a recorded response, field for field. */
function paramsFor(recorded: Recorded, chainId: string): QuoteConversionParams {
  return {
    originTokenId: recorded.quoteRequest.originAsset,
    chainId,
    amountRaw: recorded.quoteRequest.amount,
    recipient: recorded.quoteRequest.recipient,
    refundTo: recorded.quoteRequest.refundTo,
  };
}

function respond(body: unknown, status = 200) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

async function run(
  recorded: Recorded,
  chainId: string,
  mutate: (r: Recorded) => void = () => {},
  over: Partial<QuoteConversionParams> = {}
): Promise<ConversionQuoteResult> {
  const body = clone(recorded);
  mutate(body);
  return quoteConversion({
    ...paramsFor(recorded, chainId),
    deps: { fetchImpl: respond(body), now: () => nowFor(recorded) },
    ...over,
  });
}

function expectUnavailable(result: ConversionQuoteResult, detail: RegExp) {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toBe("unavailable");
  if (result.reason === "unavailable") expect(result.detail).toMatch(detail);
}

describe("quoteConversion — what it asks for", () => {
  it("asks EXACT_INPUT for the held token, delivered on the destination chain, refunded inside intents", async () => {
    const fetchImpl = respond(clone(ETH_TO_NEAR));
    await quoteConversion({ ...paramsFor(ETH_TO_NEAR, "near:mainnet"), deps: { fetchImpl, now: () => nowFor(ETH_TO_NEAR) } });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://1click.chaindefuser.com/v0/quote");
    expect(JSON.parse(init.body as string)).toEqual({
      dry: false,
      swapType: "EXACT_INPUT",
      slippageTolerance: CONVERSION_SLIPPAGE_BPS,
      originAsset: "nep141:eth.omft.near",
      depositType: "INTENTS",
      destinationAsset: "nep141:eth.bridge.near",
      amount: "5000000000000000",
      refundTo: "pablofork.near",
      refundType: "INTENTS",
      recipient: "pablofork.near",
      recipientType: "DESTINATION_CHAIN",
      deadline: "2026-10-06T10:27:22.000Z",
    });
  });

  it("asks for near.com's native-BTC asset on nBTC → Bitcoin (G6: the table chooses, not 1Click)", async () => {
    const fetchImpl = respond(clone(NBTC_TO_BITCOIN));
    await quoteConversion({ ...paramsFor(NBTC_TO_BITCOIN, "btc:mainnet"), deps: { fetchImpl, now: () => nowFor(NBTC_TO_BITCOIN) } });
    const sent = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(sent.destinationAsset).toBe("1cs_v1:btc:native:coin");
  });

  it("asks for a deadline 10 minutes out, in whole seconds (the form measured to echo verbatim)", async () => {
    const fetchImpl = respond(clone(ETH_TO_NEAR));
    await quoteConversion({ ...paramsFor(ETH_TO_NEAR, "near:mainnet"), deps: { fetchImpl, now: () => 1_800_000_000_789 } });
    const sent = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(sent.deadline).toBe(new Date(1_800_000_600_000).toISOString());
  });

  it("never sends a key or any header beyond the content type", async () => {
    const fetchImpl = respond(clone(ETH_TO_NEAR));
    await quoteConversion({ ...paramsFor(ETH_TO_NEAR, "near:mainnet"), deps: { fetchImpl, now: () => nowFor(ETH_TO_NEAR) } });
    expect((fetchImpl.mock.calls[0] as [string, RequestInit])[1].headers).toEqual({ "Content-Type": "application/json" });
  });
});

describe("quoteConversion — refuses before asking", () => {
  it.each([
    ["a direct pair (the Delivery Token on its own chain)", { originTokenId: "nep141:eth.omft.near", chainId: "eth:1", recipient: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045" }, /no conversion route/],
    ["a pair outside the table", { chainId: "btc:mainnet", recipient: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq" }, /no conversion route/],
    ["a zero amount", { amountRaw: "0" }, /positive base-unit/],
    ["a fractional amount", { amountRaw: "1.5" }, /positive base-unit/],
    ["no refund account", { refundTo: "" }, /no refund account/],
    ["an address for another chain", { recipient: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045" }, /not a valid near:mainnet/],
    ["the Delivery Token's own contract", { recipient: "eth.bridge.near" }, /contract, not an account/],
    ["the Verifier", { recipient: "intents.near" }, /contract, not an account/],
  ])("%s", async (_name, over, detail) => {
    const fetchImpl = respond(clone(ETH_TO_NEAR));
    const result = await quoteConversion({
      ...paramsFor(ETH_TO_NEAR, "near:mainnet"),
      ...over,
      deps: { fetchImpl, now: () => nowFor(ETH_TO_NEAR) },
    });
    expectUnavailable(result, detail);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("quoteConversion — accepts what 1Click really answers", () => {
  it.each([
    ["ETH from Ethereum → NEAR", ETH_TO_NEAR, "near:mainnet"],
    ["nBTC → Bitcoin", NBTC_TO_BITCOIN, "btc:mainnet"],
    ["BTC → an unregistered NEAR account (8 sats of registration)", BTC_TO_UNREGISTERED_NEAR, "near:mainnet"],
    ["USDT on BSC (18) → USDT(NEAR) (6)", USDT_BSC_TO_NEAR, "near:mainnet"],
    ["USDC on Stellar (7) → USDC on Ethereum (6)", USDC_STELLAR_TO_ETHEREUM, "eth:1"],
    ["USDT(NEAR) → Tron", USDT_NEAR_TO_TRON, "tron:mainnet"],
  ] as const)("%s", async (_name, recorded, chainId) => {
    const result = await run(recorded as Recorded, chainId);
    expect(result.ok).toBe(true);
  });

  it("returns the quote's numbers untouched, with the request's deadline and 1Click's", async () => {
    const result = await run(NBTC_TO_BITCOIN, "btc:mainnet");
    expect(result).toEqual({
      ok: true,
      quote: {
        originTokenId: "nep141:nbtc.bridge.near",
        deliveryTokenId: "nep141:btc.omft.near",
        chainId: "btc:mainnet",
        destinationAsset: "1cs_v1:btc:native:coin",
        recipient: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
        refundTo: "pablofork.near",
        depositAddress: "0a6d62b48afbcd40ec1f44812d6781afca8abe4f0b60d078f7808c18a3763bb7",
        amountInRaw: "20000",
        amountOutRaw: "18100",
        minAmountOutRaw: "18009",
        withdrawFeeRaw: "1900",
        createsTokenAccount: false,
        refundFeeRaw: "0",
        slippageBps: 50,
        requestedDeadlineMs: Date.parse("2026-10-06T10:27:41.000Z"),
        quoteDeadlineMs: Date.parse("2026-10-09T10:27:41.000Z"),
        timeEstimateSecs: 455,
        signature: NBTC_TO_BITCOIN.signature,
        quotedAtMs: nowFor(NBTC_TO_BITCOIN),
      },
    });
  });

  it("does not depend on 1Click's own fee line: none, 1 bp or 20 bps all pass when the amounts do", async () => {
    for (const appFees of [[], APP_FEE_1BP, [{ ...APP_FEE_1BP[0], fee: 20 }]]) {
      const result = await run(ETH_TO_NEAR, "near:mainnet", (r) => {
        r.quoteRequest.appFees = appFees;
      });
      expect(result.ok).toBe(true);
    }
  });

  it("treats a missing time estimate as unknown, not as a refusal", async () => {
    const result = await run(ETH_TO_NEAR, "near:mainnet", (r) => {
      delete (r.quote as Partial<Recorded["quote"]>).timeEstimate;
    });
    expect(result.ok && result.quote.timeEstimateSecs).toBeNull();
  });
});

describe("quoteConversion — G1: the echo", () => {
  // One test per field sent. A quote that repeats any of them differently is a quote about
  // another trade: another asset, amount, recipient, refund account, or another kind of deposit.
  it.each([
    ["dry", true],
    ["swapType", "EXACT_OUTPUT"],
    ["slippageTolerance", 100],
    ["originAsset", "nep141:arb.omft.near"],
    ["depositType", "ORIGIN_CHAIN"],
    ["destinationAsset", "nep141:eth.omft.near"],
    ["amount", "5000000000000001"],
    ["refundTo", "someone-else.near"],
    ["refundType", "ORIGIN_CHAIN"],
    ["recipient", "someone-else.near"],
    ["recipientType", "INTENTS"],
    ["deadline", "2026-10-09T10:27:22.000Z"],
  ])("refuses a different %s", async (field, value) => {
    const result = await run(ETH_TO_NEAR, "near:mainnet", (r) => {
      (r.quoteRequest as Record<string, unknown>)[field] = value;
    });
    expectUnavailable(result, new RegExp(`echo mismatch on ${field}`));
  });

  it.each(["recipient", "refundTo", "amount"])("refuses an echo that drops %s", async (field) => {
    const result = await run(ETH_TO_NEAR, "near:mainnet", (r) => {
      delete (r.quoteRequest as Record<string, unknown>)[field];
    });
    expectUnavailable(result, new RegExp(`echo mismatch on ${field}`));
  });

  it("refuses a recipient echoed in another case, even where the chain ignores case", async () => {
    // Measured: 1Click keeps the case it was sent. A change is therefore not 1Click's doing.
    const result = await run(USDC_STELLAR_TO_ETHEREUM, "eth:1", (r) => {
      r.quoteRequest.recipient = "0xD8DA6BF26964AF9D7EED9E03E53415D37AA96045";
    });
    expectUnavailable(result, /echo mismatch on recipient/);
  });

  it("refuses a response without the echo at all", async () => {
    const result = await run(ETH_TO_NEAR, "near:mainnet", (r) => {
      delete (r as Partial<Recorded>).quoteRequest;
    });
    expectUnavailable(result, /no quoteRequest echo/);
  });

  // Cross-review 020-4: equality on what we sent cannot see a field we never sent.
  it.each([
    ["customRecipientMsg", "smart-contract-recipient.near"],
    ["virtualChainRecipient", "0xd8da6bf26964af9d7eed9e03e53415d37aa96045"],
    ["virtualChainRefundRecipient", "0xd8da6bf26964af9d7eed9e03e53415d37aa96045"],
  ])("refuses an echo that adds %s, which changes the delivery", async (field, value) => {
    const result = await run(ETH_TO_NEAR, "near:mainnet", (r) => {
      (r.quoteRequest as Record<string, unknown>)[field] = value;
    });
    expectUnavailable(result, new RegExp(`echo carries ${field}`));
  });

  it("accepts those fields echoed unset, as 1Click really does", async () => {
    for (const unset of [null, "", undefined]) {
      const result = await run(ETH_TO_NEAR, "near:mainnet", (r) => {
        const echo = r.quoteRequest as Record<string, unknown>;
        echo.customRecipientMsg = unset;
        echo.virtualChainRecipient = unset;
        echo.virtualChainRefundRecipient = unset;
      });
      expect(result.ok).toBe(true);
    }
  });

  it("refuses an echo that asks for confidential handling", async () => {
    const result = await run(ETH_TO_NEAR, "near:mainnet", (r) => {
      (r.quoteRequest as Record<string, unknown>).confidentiality = "basic";
    });
    expectUnavailable(result, /confidential handling/);
  });

  it("refuses a deposit 1Click would only recognise by memo — our transfer carries none", async () => {
    expectUnavailable(
      await run(ETH_TO_NEAR, "near:mainnet", (r) => {
        r.quoteRequest.depositMode = "MEMO";
      }),
      /deposit mode/
    );
    expectUnavailable(
      await run(ETH_TO_NEAR, "near:mainnet", (r) => {
        (r.quote as Record<string, unknown>).depositMemo = "12345";
      }),
      /deposit memo/
    );
  });
});

describe("quoteConversion — G2: the deposit address", () => {
  it.each([
    ["upper-case hex", (a: string) => a.toUpperCase()],
    ["63 characters", (a: string) => a.slice(1)],
    ["a named account", () => "1click-deposit.near"],
    ["empty", () => ""],
  ])("refuses %s", async (_name, change) => {
    const result = await run(ETH_TO_NEAR, "near:mainnet", (r) => {
      r.quote.depositAddress = change(r.quote.depositAddress);
    });
    expectUnavailable(result, /64 lowercase hex/);
  });

  // An implicit-account login signs as 64 hex, so "is it the signer" is a real question.
  it("refuses the signer's own account, which would turn the conversion into a no-op", async () => {
    const signer = "8b58bb680f846d4ef55647155c4d325b318eaefd3ee385218b9e405aa2a6702e";
    const result = await run(
      ETH_TO_NEAR,
      "near:mainnet",
      (r) => {
        r.quote.depositAddress = signer;
        r.quoteRequest.refundTo = signer;
      },
      { refundTo: signer }
    );
    expectUnavailable(result, /known account/);
  });

  it("refuses the recipient's own account", async () => {
    const recipient = "0a6d62b48afbcd40ec1f44812d6781afca8abe4f0b60d078f7808c18a3763bb7";
    const result = await run(
      ETH_TO_NEAR,
      "near:mainnet",
      (r) => {
        r.quote.depositAddress = recipient;
        r.quoteRequest.recipient = recipient;
      },
      { recipient }
    );
    expectUnavailable(result, /known account/);
  });
});

describe("quoteConversion — G3/G4: what leaves and what arrives", () => {
  it.each([
    ["amountIn differs from the amount asked", (q: Recorded["quote"]) => { q.amountIn = "4999999999999999"; }, /amountIn is not the amount asked/],
    ["amountIn is not an integer", (q: Recorded["quote"]) => { q.amountIn = "5e15"; }, /amountIn is not the amount asked/],
    ["minAmountIn above amountIn", (q: Recorded["quote"]) => { q.minAmountIn = "5000000000000001"; }, /minAmountIn above/],
    ["minAmountIn missing", (q: Recorded["quote"]) => { delete (q as Partial<Recorded["quote"]>).minAmountIn; }, /minAmountIn above/],
    ["amountOut fractional", (q: Recorded["quote"]) => { q.amountOut = "4998990052004899.5"; }, /not base units/],
    ["minAmountOut zero", (q: Recorded["quote"]) => { q.minAmountOut = "0"; }, /minAmountOut not in/],
    ["minAmountOut above amountOut", (q: Recorded["quote"]) => { q.minAmountOut = "4998990052004900"; }, /minAmountOut not in/],
    ["withdrawFee missing", (q: Recorded["quote"]) => { delete (q as Partial<Recorded["quote"]>).withdrawFee; }, /withdrawFee\/refundFee/],
    ["refundFee negative", (q: Recorded["quote"]) => { q.refundFee = "-1"; }, /withdrawFee\/refundFee/],
  ])("refuses %s", async (_name, change, detail) => {
    const result = await run(ETH_TO_NEAR, "near:mainnet", (r) => change(r.quote));
    expectUnavailable(result, detail);
  });
});

describe("quoteConversion — G5: the ceiling without prices", () => {
  /**
   * The largest `minAmountOut` loss the ceiling allows, as the `minAmountOut` that sits exactly on
   * it. Computed here independently of `normalizedLoss`, from the decimals named in each case.
   */
  function minOutAtCeiling(amountIn: string, inDec: number, fee: string, outDec: number): bigint {
    const top = Math.max(inDec, outDec);
    const inScaled = BigInt(amountIn) * BigInt(10) ** BigInt(top - inDec);
    const allowedLoss = (inScaled * BigInt(CONVERSION_LOSS_CEILING_BPS)) / BigInt(10_000);
    const grossOutScaled = inScaled - allowedLoss;
    // Back to the destination's units, rounding UP so the result is the first value that passes.
    const scaleOut = BigInt(10) ** BigInt(top - outDec);
    const grossOut = (grossOutScaled + scaleOut - BigInt(1)) / scaleOut;
    return grossOut - BigInt(fee);
  }

  it.each([
    ["18 → 18 (ETH)", ETH_TO_NEAR, "near:mainnet", 18, 18],
    ["8 → 8 (nBTC → Bitcoin, with a Network Fee)", NBTC_TO_BITCOIN, "btc:mainnet", 8, 8],
    ["18 → 6 (USDT on BSC)", USDT_BSC_TO_NEAR, "near:mainnet", 18, 6],
    ["7 → 6 (USDC on Stellar, with a Network Fee)", USDC_STELLAR_TO_ETHEREUM, "eth:1", 7, 6],
  ] as const)("%s: passes on the ceiling, refuses one base unit under it", async (_n, recorded, chainId, inDec, outDec) => {
    const r = recorded as Recorded;
    const atCeiling = minOutAtCeiling(r.quote.amountIn, inDec, r.quote.withdrawFee, outDec);
    const setMin = (v: bigint) => (body: Recorded) => {
      body.quote.minAmountOut = v.toString();
      body.quote.amountOut = (v > BigInt(body.quote.amountOut) ? v : BigInt(body.quote.amountOut)).toString();
    };
    expect((await run(r, chainId, setMin(atCeiling))).ok).toBe(true);
    expectUnavailable(await run(r, chainId, setMin(atCeiling - BigInt(1))), /loss above the conversion ceiling/);
  });

  it("measures today's routes well inside the ceiling", () => {
    // The real answers sit at ~50 bps of loss on `minAmountOut`: the slippage, plus 0–3 of cost.
    for (const [r, inDec, outDec] of [
      [ETH_TO_NEAR, 18, 18],
      [NBTC_TO_BITCOIN, 8, 8],
      [USDT_BSC_TO_NEAR, 18, 6],
      [USDC_STELLAR_TO_ETHEREUM, 7, 6],
      [USDT_NEAR_TO_TRON, 6, 6],
    ] as const) {
      const { loss, of } = normalizedLoss({
        amountInRaw: r.quote.amountIn,
        inDecimals: inDec,
        outRaw: r.quote.minAmountOut,
        withdrawFeeRaw: r.quote.withdrawFee,
        outDecimals: outDec,
      });
      expect(Number((loss * BigInt(10_000)) / of)).toBeLessThanOrEqual(53);
    }
  });

  describe("Network Fee ceiling off NEAR: twice the registry's fee for the Delivery Token", () => {
    it.each([
      // Registry: btc.omft.near 1500 sats; measured 1900.
      ["Bitcoin", NBTC_TO_BITCOIN, "btc:mainnet", "3000"],
      // Registry: USDC on Ethereum 300000; measured 300000.
      ["Ethereum", USDC_STELLAR_TO_ETHEREUM, "eth:1", "600000"],
      // Registry: USDT on Tron 1000000; measured 917954.
      ["Tron", USDT_NEAR_TO_TRON, "tron:mainnet", "2000000"],
    ] as const)("%s: %s passes, one more is refused", async (_n, recorded, chainId, ceiling) => {
      const r = recorded as Recorded;
      // Lower amountOut by as much as the fee rises: the loss (fee excluded) stays exactly what
      // 1Click quoted, so the fee line is the only thing that can decide.
      const withFee = (fee: bigint) => (body: Recorded) => {
        const delta = fee - BigInt(body.quote.withdrawFee);
        body.quote.withdrawFee = fee.toString();
        body.quote.amountOut = (BigInt(body.quote.amountOut) - delta).toString();
        body.quote.minAmountOut = (BigInt(body.quote.minAmountOut) - delta).toString();
      };
      expect((await run(r, chainId, withFee(BigInt(ceiling)))).ok).toBe(true);
      expectUnavailable(
        await run(r, chainId, withFee(BigInt(ceiling) + BigInt(1))),
        /Network Fee above its ceiling/
      );
    });

    it("refuses a fee above twice the registry's even when the loss stays small", async () => {
      // Only the fee line moves: `amountOut` stays, so the loss figure even improves (the fee is
      // subtracted from it) and the refusal can only come from the fee ceiling.
      const result = await run(NBTC_TO_BITCOIN, "btc:mainnet", (r) => {
        r.quote.withdrawFee = "3001";
      });
      expectUnavailable(result, /Network Fee above its ceiling/);
    });
  });

  describe("Network Fee ceiling to NEAR: one account registration, with room", () => {
    it("accepts the 8 sats 1Click charges to register an nBTC account", async () => {
      expect((await run(BTC_TO_UNREGISTERED_NEAR, "near:mainnet")).ok).toBe(true);
    });

    it.each([
      ["nep141:nbtc.bridge.near", "100"],
      ["nep141:eth.bridge.near", "40000000000000"],
      ["nep141:usdt.tether-token.near", "100000"],
      ["nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "100000"],
    ])("caps %s at %s base units", (tokenId, ceiling) => {
      expect(NEAR_DELIVERY_FEE_CEILING_RAW[tokenId]).toBe(ceiling);
    });

    it("refuses an nBTC delivery fee one sat over the ceiling", async () => {
      const result = await run(BTC_TO_UNREGISTERED_NEAR, "near:mainnet", (r) => {
        r.quote.withdrawFee = "101";
      });
      expectUnavailable(result, /Network Fee above its ceiling/);
    });

    it("passes an nBTC delivery fee exactly on the ceiling", async () => {
      const result = await run(BTC_TO_UNREGISTERED_NEAR, "near:mainnet", (r) => {
        r.quote.withdrawFee = "100";
        r.quote.amountOut = "19894";
        r.quote.minAmountOut = "19800";
      });
      expect(result.ok).toBe(true);
    });
  });

  describe("Network Fee ceiling when the delivery opens a token account (D-441)", () => {
    const SOL = "sol:mainnet";
    const USDC_SOL = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";

    it("passes a Solana wallet that already holds USDC, with no account to open", async () => {
      const result = await run(USDC_NEAR_TO_SOLANA_WITH_ACCOUNT, SOL);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.quote.createsTokenAccount).toBe(false);
    });

    it("passes a fresh Solana wallet and says the fee opens its USDC account", async () => {
      // 314337 is past the regular ceiling (2 × 30000): before D-441 this was "unavailable".
      const result = await run(USDC_NEAR_TO_SOLANA_NO_ACCOUNT, SOL);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.quote.createsTokenAccount).toBe(true);
      expect(result.quote.withdrawFeeRaw).toBe("314337");
    });

    // Live prices from 1Click's `/v0/tokens` the moment the fixtures were re-measured (s231).
    const LIVE: Record<string, number> = { "nep141:sol.omft.near": 116.31, [USDC_SOL]: 0.999845 };
    const live = (prices: Record<string, number>) => (id: string) => prices[id] ?? null;
    const USDT_SOL = "nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near";
    const REGULAR = BigInt(60000); // 2 × the registry's 30000

    describe("the ceiling follows the live SOL price", () => {
      it("is the regular ceiling plus three times the rent (1 488 440 lamports) at the live prices", () => {
        // 0.00148844 SOL × 116.31 × 3 / 0.999845 = 0.519442 USDC.
        expect(tokenAccountFeeCeiling(USDC_SOL, 6, REGULAR, live(LIVE))).toBe(BigInt(579442));
      });

      it("moves with SOL: twice the price, twice the allowance", () => {
        const doubled = tokenAccountFeeCeiling(USDC_SOL, 6, REGULAR, live({ ...LIVE, "nep141:sol.omft.near": 232.62 }));
        expect(doubled).toBe(BigInt(1098884));
      });

      it("falls back to the fixed 0.60 without a live price for either token", () => {
        const partial: Record<string, number>[] = [{}, { "nep141:sol.omft.near": 116.31 }, { [USDT_SOL]: 1 }];
        for (const prices of partial) {
          expect(tokenAccountFeeCeiling(USDT_SOL, 6, REGULAR, live(prices))).toBe(BigInt(600000));
        }
        expect(tokenAccountFeeCeiling(USDT_SOL, 6, REGULAR)).toBe(BigInt(600000));
        expect(tokenAccountFeeCeiling(USDC_SOL, 6, REGULAR, live({ ...LIVE, "nep141:sol.omft.near": 0 }))).toBe(
          BigInt(600000)
        );
      });

      it("is undefined where no account has to be opened", () => {
        expect(tokenAccountFeeCeiling("nep141:usdt.tether-token.near", 6, REGULAR, live(LIVE))).toBeUndefined();
      });
    });

    // As in the regular ceiling's test: the fee moves, the loss (fee excluded) stays as quoted.
    const withFee = (fee: bigint) => (body: Recorded) => {
      const delta = fee - BigInt(body.quote.withdrawFee);
      body.quote.withdrawFee = fee.toString();
      body.quote.amountOut = (BigInt(body.quote.amountOut) - delta).toString();
      body.quote.minAmountOut = (BigInt(body.quote.minAmountOut) - delta).toString();
    };

    it("with live prices: passes the measured fee and one exactly on the ceiling, refuses one unit over", async () => {
      const over = { liveUsdPrice: live(LIVE) };
      expect((await run(USDC_NEAR_TO_SOLANA_NO_ACCOUNT, SOL, undefined, over)).ok).toBe(true);
      expect((await run(USDC_NEAR_TO_SOLANA_NO_ACCOUNT, SOL, withFee(BigInt(579442)), over)).ok).toBe(true);
      // Past it 1Click charges well over what opening the account costs: nothing specific to say.
      expectUnavailable(
        await run(USDC_NEAR_TO_SOLANA_NO_ACCOUNT, SOL, withFee(BigInt(579443)), over),
        /token-account ceiling/
      );
    });

    it("refuses the measured fee if SOL were so cheap that it is over three times the rent", async () => {
      const cheap = { liveUsdPrice: live({ ...LIVE, "nep141:sol.omft.near": 50 }) };
      expectUnavailable(await run(USDC_NEAR_TO_SOLANA_NO_ACCOUNT, SOL, undefined, cheap), /token-account ceiling/);
    });

    it("without live prices: the fixed 0.60, exactly on it passes, one unit over is 'unavailable'", async () => {
      expect((await run(USDC_NEAR_TO_SOLANA_NO_ACCOUNT, SOL, withFee(BigInt(600000)))).ok).toBe(true);
      expectUnavailable(
        await run(USDC_NEAR_TO_SOLANA_NO_ACCOUNT, SOL, withFee(BigInt(600001))),
        /token-account ceiling/
      );
    });

    // Cross-review s231: the loss check leaves the fee out and the account ceiling is absolute, so
    // a small amount could pass with almost all of it spent on opening the account.
    const smallAmount = (amountIn: string, amountOut: string, minAmountOut: string) => (body: Recorded) => {
      body.quoteRequest.amount = amountIn;
      body.quote.amountIn = amountIn;
      body.quote.minAmountIn = amountIn;
      body.quote.amountOut = amountOut;
      body.quote.minAmountOut = minAmountOut;
    };

    it("refuses an amount the account fee would take more than half of, asking for twice the live fee", async () => {
      const result = await run(
        USDC_NEAR_TO_SOLANA_NO_ACCOUNT,
        SOL,
        smallAmount("320000", "5663", "5600"),
        { amountRaw: "320000" }
      );
      expect(result).toEqual({
        ok: false,
        reason: "token-account-below-minimum",
        minAmountRaw: "628674",
        feeRaw: "314337",
      });
    });

    it("passes the fee at exactly half of the amount", async () => {
      const result = await run(
        USDC_NEAR_TO_SOLANA_NO_ACCOUNT,
        SOL,
        smallAmount("628674", "314000", "312400"),
        { amountRaw: "628674" }
      );
      expect(result.ok).toBe(true);
    });

    it("lets an ordinary fee through on a small amount: the share applies only to opening an account", async () => {
      const result = await run(
        USDC_NEAR_TO_SOLANA_WITH_ACCOUNT,
        SOL,
        smallAmount("15000", "4800", "4770"),
        { amountRaw: "15000" }
      );
      expect(result.ok).toBe(true);
    });

    it("a response wrong in another way reads 'unavailable', not 'the minimum is …'", async () => {
      const result = await run(
        USDC_NEAR_TO_SOLANA_NO_ACCOUNT,
        SOL,
        (r) => {
          smallAmount("320000", "5663", "5600")(r);
          (r as { signature: string }).signature = "";
        },
        { amountRaw: "320000" }
      );
      expectUnavailable(result, /not signed/);
    });

    it("keeps the regular ceiling's refusal on chains with no token account to open", async () => {
      // Tron's regular ceiling is 2 000 000; no account allowance there.
      expectUnavailable(
        await run(USDT_NEAR_TO_TRON, "tron:mainnet", withFee(BigInt(2000001))),
        /Network Fee above its ceiling/
      );
    });
  });

  it("refuses a refund that would keep more than a conversion may", async () => {
    const result = await run(ETH_TO_NEAR, "near:mainnet", (r) => {
      r.quote.refundFee = "50000000000001"; // 100 bps of 0.005 ETH is 5e13
    });
    expectUnavailable(result, /refundFee above/);
  });
});

describe("quoteConversion — deadline and G7", () => {
  it("refuses a response whose deadline cannot be read", async () => {
    const result = await run(ETH_TO_NEAR, "near:mainnet", (r) => {
      r.quote.deadline = "in three days";
    });
    expectUnavailable(result, /deadline unreadable/);
  });

  it("refuses an unsigned quote: there would be no proof of what was offered", async () => {
    const result = await run(ETH_TO_NEAR, "near:mainnet", (r) => {
      r.signature = "";
    });
    expectUnavailable(result, /not signed/);
  });
});

describe("quoteConversion — failures that are not quotes", () => {
  it("reads 'try at least N' as a minimum in the held token's units", async () => {
    const result = await quoteConversion({
      originTokenId: "nep245:v2_1.omni.hot.tg:56_2CMMyVTGZkeyNZTSvS5sarzfir6g",
      chainId: "tron:mainnet",
      amountRaw: "1000000000000000000",
      recipient: "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7",
      refundTo: "pablofork.near",
      deps: { fetchImpl: respond(BELOW_TRON_FLOOR, 400), now: () => 1_800_000_000_000 },
    });
    expect(result).toEqual({ ok: false, reason: "below-minimum", minAmountRaw: "1928333454953453638" });
  });

  it.each([
    ["any other 400", respond({ message: "recipient is not valid" }, 400), /answered 400/],
    ["a 500", respond({ message: "Internal error" }, 500), /answered 500/],
    ["a body that is not JSON", vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("x"); } })), /no quote/],
    ["a network failure", vi.fn(async () => { throw new TypeError("Failed to fetch"); }), /unreachable/],
  ])("turns %s into 'unavailable'", async (_name, fetchImpl, detail) => {
    const result = await quoteConversion({
      ...paramsFor(ETH_TO_NEAR, "near:mainnet"),
      deps: { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => nowFor(ETH_TO_NEAR) },
    });
    expectUnavailable(result, detail);
  });

  it("does not read a minimum out of a 200", async () => {
    const result = await run(ETH_TO_NEAR, "near:mainnet", (r) => {
      (r as Record<string, unknown>).message = "try at least 1";
      delete (r as Partial<Recorded>).quote;
    });
    expectUnavailable(result, /no quote/);
  });
});

describe("normalizedLoss and conversionCostBps", () => {
  it.each([
    // in, inDec, out, fee, outDec, expected loss (scaled), of (scaled)
    ["6 → 6", "20000000", 6, "19990000", "0", 6, BigInt(10000), BigInt(20000000)],
    ["7 → 6", "200000000", 7, "19990000", "0", 6, BigInt(100000), BigInt(200000000)],
    ["18 → 6", "20000000000000000000", 18, "19990000", "0", 6, BigInt("10000000000000000"), BigInt("20000000000000000000")],
    ["8 → 8 with a fee", "20000", 8, "18100", "1900", 8, BigInt(0), BigInt(20000)],
    ["6 → 18", "1000000", 6, "999000000000000000", "0", 18, BigInt("1000000000000000"), BigInt("1000000000000000000")],
  ])("%s", (_n, amountInRaw, inDecimals, outRaw, withdrawFeeRaw, outDecimals, loss, of) => {
    expect(normalizedLoss({ amountInRaw, inDecimals, outRaw, withdrawFeeRaw, outDecimals })).toEqual({ loss, of });
  });

  it("reports the Conversion Cost of real quotes in basis points, the Network Fee excluded", async () => {
    const eth = await run(ETH_TO_NEAR, "near:mainnet");
    const bsc = await run(USDT_BSC_TO_NEAR, "near:mainnet");
    const tron = await run(USDT_NEAR_TO_TRON, "tron:mainnet");
    if (!eth.ok || !bsc.ok || !tron.ok) throw new Error("fixtures must pass");
    expect(conversionCostBps(eth.quote)).toBeCloseTo(2.01, 2);
    expect(conversionCostBps(bsc.quote)).toBeCloseTo(2.02, 2);
    // 20 − 19.077279 − 0.917954 = 0.004767 USDT on 20 → 2.38 bps, not the 4.6% the fee alone is.
    expect(conversionCostBps(tron.quote)).toBeCloseTo(2.38, 2);
  });

  it("never reports a negative cost", async () => {
    const result = await run(NBTC_TO_BITCOIN, "btc:mainnet");
    if (!result.ok) throw new Error("fixture must pass");
    expect(conversionCostBps({ ...result.quote, amountOutRaw: "18200" })).toBe(0);
  });
});
