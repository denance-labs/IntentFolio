import { describe, expect, it, vi } from "vitest";
import { WithdrawError, WithdrawRelayRejectedError } from "@/features/bridge/lib/withdraw-errors";
import { getTokenById } from "@/features/market/lib/token-registry";
import { runStockSwap } from "./run-stock-swap";
import {
  STOCK_QUOTE_MAX_AGE_MS,
  STOCK_TEST_ASSETS,
  STOCK_TEST_FUNDING_ASSETS,
  StockSwapNotSignableError,
  buildStockSwapSignRequest,
  formatRaw,
  impliedStockPriceUsd,
  parseAmountToRaw,
  quoteStockSwap,
  type StockSwapQuote,
} from "./stock-swap";

const ACCOUNT = "pablofork.near";
const APPLE = STOCK_TEST_ASSETS[0];
const USDT = STOCK_TEST_FUNDING_ASSETS[0];
const USDC_ARB = STOCK_TEST_FUNDING_ASSETS.find((asset) => asset.label === "USDC (Arbitrum)")!;
const USDT_ID = USDT.id;
const DEPOSIT = "c2285b251eff358ddf799a190e264badcf8cd33d7811ad1312c137968a772225";
const CAP = 25;
const NOW = Date.parse("2026-11-04T10:40:00.000Z");
const DEADLINE = "2026-11-04T10:50:00.000Z";

// The shape of the non-dry answer measured on 2026-11-04 (10 USDT → AAPLon).
function answer(overrides: { quote?: object; quoteRequest?: object; root?: object } = {}) {
  return {
    quote: {
      depositAddress: DEPOSIT,
      amountIn: "10000000",
      minAmountIn: "10000000",
      amountInUsd: "9.98",
      amountOut: "29820653812812409",
      minAmountOut: "29522447274684285",
      amountOutUsd: "9.93",
      withdrawFee: "0",
      refundFee: "0",
      timeEstimate: 10,
      deadline: "2026-11-07T10:56:29.302Z",
      ...overrides.quote,
    },
    quoteRequest: {
      dry: false,
      depositMode: "SIMPLE",
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: USDT_ID,
      depositType: "INTENTS",
      destinationAsset: APPLE.id,
      amount: "10000000",
      refundTo: ACCOUNT,
      refundType: "INTENTS",
      recipient: ACCOUNT,
      recipientType: "INTENTS",
      deadline: DEADLINE,
      confidentiality: "public",
      appFees: [{ recipient: "5880ad2b", fee: 20 }],
      ...overrides.quoteRequest,
    },
    signature: "ed25519:abc",
    ...overrides.root,
  };
}

/** Answers with the request's own fields echoed, so a case only states what it changes in the quote. */
function echoing(body: { quote: object; quoteRequest: object }) {
  return vi.fn(async (_url: unknown, init?: RequestInit) => {
    const sent = JSON.parse(String(init?.body)) as object;
    return new Response(JSON.stringify({ ...body, quoteRequest: { ...body.quoteRequest, ...sent } }), { status: 201 });
  }) as unknown as typeof fetch;
}

function fetchReturning(body: unknown, status = 201) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

async function quoteWith(body: unknown, status = 201, amountRaw = "10000000") {
  return quoteStockSwap({
    side: "buy",
    stock: APPLE,
    funding: USDT,
    amountRaw,
    accountId: ACCOUNT,
    maxTradeUsd: CAP,
    deps: { fetchImpl: fetchReturning(body, status), now: () => NOW },
  });
}

async function goodQuote(): Promise<StockSwapQuote> {
  const result = await quoteWith(answer());
  if (!result.ok) throw new Error(result.detail);
  return result.quote;
}

describe("STOCK_TEST_FUNDING_ASSETS", () => {
  it("agrees with the token registry on id and decimals", () => {
    for (const asset of STOCK_TEST_FUNDING_ASSETS) {
      expect(getTokenById(asset.id)?.decimals).toBe(asset.decimals);
    }
  });
});

describe("parseAmountToRaw", () => {
  it("converts without going through a float", () => {
    expect(parseAmountToRaw("10", 6)).toBe("10000000");
    expect(parseAmountToRaw("0,5", 6)).toBe("500000");
    expect(parseAmountToRaw("0.029820653812812409", 18)).toBe("29820653812812409");
  });

  it("refuses what is not a positive amount at these decimals", () => {
    for (const bad of ["", "0", "-1", "1e3", "abc", "1.2.3", "0.0000001"]) {
      expect(parseAmountToRaw(bad, 6)).toBeNull();
    }
  });
});

describe("formatRaw", () => {
  it("cuts instead of rounding up", () => {
    expect(formatRaw("29829999999999999", 18)).toBe("0.029829");
    expect(formatRaw("10000000", 6)).toBe("10");
    expect(formatRaw(BigInt(0), 6)).toBe("0");
  });

  it("gives back the whole balance when asked for every digit", () => {
    expect(formatRaw("29820653812812409", 18, 18)).toBe("0.029820653812812409");
  });
});

describe("quoteStockSwap", () => {
  it("accepts the measured answer", async () => {
    const quote = await goodQuote();
    expect(quote.depositAddress).toBe(DEPOSIT);
    expect(quote.costBps).toBeCloseTo(50.1, 0);
    expect(impliedStockPriceUsd(quote)).toBeCloseTo(333, 0);
  });

  it("asks for the swap to pay and refund the account inside Intents", async () => {
    const fetchImpl = fetchReturning(answer());
    await quoteStockSwap({ side: "buy", stock: APPLE, funding: USDT, amountRaw: "10000000", accountId: ACCOUNT, maxTradeUsd: CAP, deps: { fetchImpl, now: () => NOW } });
    const body = JSON.parse((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body).toMatchObject({
      dry: false,
      originAsset: USDT_ID,
      destinationAsset: APPLE.id,
      depositType: "INTENTS",
      recipient: ACCOUNT,
      recipientType: "INTENTS",
      refundTo: ACCOUNT,
      refundType: "INTENTS",
    });
  });

  it("swaps the assets when selling", async () => {
    const fetchImpl = fetchReturning({});
    await quoteStockSwap({ side: "sell", stock: APPLE, funding: USDT, amountRaw: "30000000000000000", accountId: ACCOUNT, maxTradeUsd: CAP, deps: { fetchImpl, now: () => NOW } });
    const body = JSON.parse((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body).toMatchObject({ originAsset: APPLE.id, destinationAsset: USDT_ID });
  });

  it("never reaches 1Click for a stock outside the list or a trade over the cap", async () => {
    const fetchImpl = fetchReturning(answer());
    const params = { side: "buy" as const, funding: USDT, accountId: ACCOUNT, maxTradeUsd: CAP, deps: { fetchImpl, now: () => NOW } };
    const outside = { ticker: "X", name: "X", id: "nep141:evil.near", decimals: 18 };
    expect((await quoteStockSwap({ ...params, stock: outside, amountRaw: "10000000" })).ok).toBe(false);
    expect((await quoteStockSwap({ ...params, stock: APPLE, amountRaw: "25000001" })).ok).toBe(false);
    const otherFunding = { label: "X", id: "nep141:evil.near", decimals: 6 };
    expect((await quoteStockSwap({ ...params, funding: otherFunding, stock: APPLE, amountRaw: "10000000" })).ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("pays with the chosen stablecoin and returns to it when selling", async () => {
    const buyFetch = fetchReturning({});
    await quoteStockSwap({ side: "buy", stock: APPLE, funding: USDC_ARB, amountRaw: "10000000", accountId: ACCOUNT, maxTradeUsd: CAP, deps: { fetchImpl: buyFetch, now: () => NOW } });
    expect(JSON.parse((buyFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body)).toMatchObject({ originAsset: USDC_ARB.id, destinationAsset: APPLE.id });
    const sellFetch = fetchReturning({});
    await quoteStockSwap({ side: "sell", stock: APPLE, funding: USDC_ARB, amountRaw: "30000000000000000", accountId: ACCOUNT, maxTradeUsd: CAP, deps: { fetchImpl: sellFetch, now: () => NOW } });
    expect(JSON.parse((sellFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body)).toMatchObject({ originAsset: APPLE.id, destinationAsset: USDC_ARB.id });
  });

  it("refuses an answer about another stablecoin than the one asked", async () => {
    expect((await quoteWith(answer({ quoteRequest: { originAsset: USDC_ARB.id } }))).ok).toBe(false);
  });

  it("shows 1Click's own refusal", async () => {
    const result = await quoteWith({ message: "No liquidity available" }, 400);
    expect(result).toEqual({ ok: false, reason: "no_liquidity", detail: "1Click respondió 400: No liquidity available" });
  });

  it.each([
    ["another recipient", { quoteRequest: { recipient: "attacker.near" } }],
    ["another refund account", { quoteRequest: { refundTo: "attacker.near" } }],
    ["another stock", { quoteRequest: { destinationAsset: STOCK_TEST_ASSETS[1].id } }],
    ["a recipient message nobody asked for", { quoteRequest: { customRecipientMsg: "x" } }],
    ["confidential handling", { quoteRequest: { confidentiality: "confidential" } }],
    ["a deposit memo", { quote: { depositMemo: "1" } }],
    ["a named deposit account", { quote: { depositAddress: "intents.near" } }],
    ["the signer as deposit account", { quote: { depositAddress: ACCOUNT } }],
    ["a different input amount", { quote: { amountIn: "20000000" } }],
    ["a guarantee above the expectation", { quote: { minAmountOut: "29820653812812410" } }],
    ["a guarantee below the tolerance", { quote: { minAmountOut: "29000000000000000" } }],
    ["a fee on a swap inside Intents", { quote: { withdrawFee: "1" } }],
    ["a cost over the ceiling", { quote: { amountOutUsd: "9.70" } }],
    ["a trade valued over the cap", { quote: { amountInUsd: "25.01" } }],
    ["no USD values", { quote: { amountOutUsd: undefined } }],
    ["no signature", { root: { signature: "" } }],
  ])("refuses %s", async (_name, overrides) => {
    expect((await quoteWith(answer(overrides))).ok).toBe(false);
  });
});

describe("quoteStockSwap for a sale in Production", () => {
  const SALE_RAW = "30000000000000000"; // 0.03 of a stock
  const saleAnswer = (usdcOut: string) =>
    answer({
      quote: {
        amountIn: SALE_RAW,
        minAmountIn: SALE_RAW,
        amountInUsd: "10000.00",
        amountOutUsd: "9990.00",
        amountOut: usdcOut,
        minAmountOut: usdcOut,
      },
      quoteRequest: { originAsset: APPLE.id, destinationAsset: USDT_ID, amount: SALE_RAW },
    });
  const sell = (usdcOut: string, extra: { maxTradeUsd: number | null; referenceUsdPrice?: number | null }) =>
    quoteStockSwap({
      side: "sell",
      stock: APPLE,
      funding: USDT,
      amountRaw: SALE_RAW,
      accountId: ACCOUNT,
      deps: { fetchImpl: echoing(saleAnswer(usdcOut)), now: () => NOW },
      ...extra,
    });

  it("has no ceiling with a null cap, and refuses the same trade with one", async () => {
    expect((await sell("9990000000", { maxTradeUsd: null })).ok).toBe(true);
    expect((await sell("9990000000", { maxTradeUsd: CAP })).ok).toBe(false);
  });

  it("refuses a sale that pays far below the reference price, whatever 1Click says it is worth", async () => {
    // 0.03 × $340 = $10.20: 10.10 USDC is 98 bps below, 9.90 is 294 bps below.
    expect((await sell("10100000", { maxTradeUsd: null, referenceUsdPrice: 340 })).ok).toBe(true);
    expect(await sell("9900000", { maxTradeUsd: null, referenceUsdPrice: 340 })).toMatchObject({
      ok: false,
      reason: "cost_too_high",
    });
  });

  it("goes without a reference when the screen has none", async () => {
    expect((await sell("9900000", { maxTradeUsd: null, referenceUsdPrice: null })).ok).toBe(true);
  });

  it("names the refusals a product screen tells apart", async () => {
    expect(await quoteWith({ message: "No liquidity available" }, 400)).toMatchObject({ reason: "no_liquidity" });
    expect(await quoteWith({ message: "Bad request" }, 400)).toMatchObject({ reason: "unavailable" });
    expect(await quoteWith(answer({ quote: { amountOutUsd: "9.70" } }))).toMatchObject({ reason: "cost_too_high" });
  });

});

describe("the operator's screen swaps any token of the app against the funding assets", () => {
  const USDC_BASE = STOCK_TEST_FUNDING_ASSETS.find((asset) => asset.label === "USDC (Base)")!;
  const assetById = (id: string) => STOCK_TEST_ASSETS.find((asset) => asset.id === id);

  it("lists the stocks first, then the rest under the ids the contracts read", () => {
    expect(STOCK_TEST_ASSETS[0].ticker).toBe("AAPL");
    expect(assetById("nep141:wrap.near")).toMatchObject({ ticker: "NEAR", decimals: 24 });
    expect(assetById("near")).toBeUndefined();
    expect(assetById(USDC_BASE.id)?.decimals).toBe(6);
    expect(new Set(STOCK_TEST_ASSETS.map((asset) => asset.id)).size).toBe(STOCK_TEST_ASSETS.length);
  });

  it("asks 1Click for wNEAR → USDC (Base), and refuses a token against itself", async () => {
    const fetchImpl = fetchReturning(answer());
    const wNear = assetById("nep141:wrap.near")!;
    await quoteStockSwap({
      side: "sell",
      stock: wNear,
      funding: USDC_BASE,
      amountRaw: "27000000000000000000000000",
      accountId: ACCOUNT,
      maxTradeUsd: CAP,
      deps: { fetchImpl, now: () => NOW },
    });
    const [, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(JSON.parse(String(init.body))).toMatchObject({ originAsset: wNear.id, destinationAsset: USDC_BASE.id });

    const self = await quoteStockSwap({
      side: "sell",
      stock: assetById(USDC_BASE.id)!,
      funding: USDC_BASE,
      amountRaw: "1000000",
      accountId: ACCOUNT,
      maxTradeUsd: CAP,
      deps: { fetchImpl, now: () => NOW },
    });
    expect(self.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("buildStockSwapSignRequest", () => {
  const params = (quote: StockSwapQuote) => ({
    signerId: ACCOUNT,
    quote,
    heldRaw: BigInt(quote.amountInRaw),
    nowMs: NOW + 1000,
    nonce: new Uint8Array(32),
  });

  it("signs exactly one transfer of the quoted amount to the deposit address", async () => {
    const quote = await goodQuote();
    const request = buildStockSwapSignRequest(params(quote));
    expect(request.intents).toEqual([
      { intent: "transfer", receiver_id: DEPOSIT, tokens: { [USDT_ID]: "10000000" } },
    ]);
    expect(request.nep413.recipient).toBe("intents.near");
  });

  it("makes the signature die before the quote", async () => {
    const quote = await goodQuote();
    const { deadlineSecs } = buildStockSwapSignRequest(params(quote));
    expect(deadlineSecs * 1000).toBeLessThan(quote.requestedDeadlineMs);
  });

  it.each([
    ["another signer", (q: StockSwapQuote) => ({ ...params(q), signerId: "other.near" })],
    ["a short balance", (q: StockSwapQuote) => ({ ...params(q), heldRaw: BigInt(q.amountInRaw) - BigInt(1) })],
    ["a quote too old", (q: StockSwapQuote) => ({ ...params(q), nowMs: q.quotedAtMs + STOCK_QUOTE_MAX_AGE_MS + 1 })],
    ["a quote over the cap", (q: StockSwapQuote) => params({ ...q, amountInUsd: 25.01 })],
    ["a pair outside the list", (q: StockSwapQuote) => params({ ...q, destinationAsset: "nep141:evil.near" })],
    ["a named deposit account", (q: StockSwapQuote) => params({ ...q, depositAddress: "intents.near" })],
  ])("refuses %s", async (_name, build) => {
    const quote = await goodQuote();
    expect(() => buildStockSwapSignRequest(build(quote))).toThrow(StockSwapNotSignableError);
  });
});

describe("runStockSwap", () => {
  const signer = { scheme: "ed25519", signEnvelope: vi.fn(async () => ({}) as never) } as never;
  const base = async () => ({
    accountId: ACCOUNT,
    quote: await goodQuote(),
    signer,
    readHeld: async () => BigInt(10000000),
    publish: async () => ({ status: "OK", intent_hash: "HASH" }) as never,
    waitForSettlement: (async () => ({ txHash: "TX", intentHash: "HASH" })) as never,
    envelope: { nowMs: NOW + 1000, nonce: new Uint8Array(32) },
  });

  it("reports what 1Click delivered", async () => {
    const result = await runStockSwap({
      ...(await base()),
      watchSwap: async () =>
        ({ kind: "delivered", reading: { status: "SUCCESS", amountOutRaw: "29820653812812409" } }) as never,
    });
    expect(result).toEqual({ kind: "delivered", intentHash: "HASH", txHash: "TX", amountOutRaw: "29820653812812409" });
  });

  it("does not take a relay reason it cannot read as proof nothing moved", async () => {
    const quote = await goodQuote();
    const result = await runStockSwap({
      ...(await base()),
      publish: (async () => {
        throw new WithdrawRelayRejectedError("UNKNOWN_ERROR", "something new");
      }) as never,
    });
    expect(result).toMatchObject({ kind: "unconfirmed", intentHash: null, depositAddress: quote.depositAddress });
  });

  it("still throws a relay refusal it can read: that one proves nothing moved", async () => {
    await expect(
      runStockSwap({
        ...(await base()),
        publish: (async () => {
          throw new WithdrawRelayRejectedError("INSUFFICIENT_BALANCE", "insufficient balance or overflow");
        }) as never,
      })
    ).rejects.toBeInstanceOf(WithdrawRelayRejectedError);
  });

  it("keeps the deposit address and a hash it already saw when settlement goes unanswered", async () => {
    const quote = await goodQuote();
    const result = await runStockSwap({
      ...(await base()),
      waitForSettlement: (async (p: { onTxHashKnown?: (hash: string) => void }) => {
        p.onTxHashKnown?.("SEEN");
        throw new Error("no final answer");
      }) as never,
    });
    expect(result).toMatchObject({ kind: "unconfirmed", txHash: "SEEN", depositAddress: quote.depositAddress });
  });

  it("does not call a final-less watch a failure", async () => {
    const result = await runStockSwap({
      ...(await base()),
      watchSwap: async () => ({ kind: "unanswered", last: null, detail: "no final answer" }) as never,
    });
    expect(result).toMatchObject({ kind: "unconfirmed", intentHash: "HASH", txHash: "TX" });
  });

  it("does not call a lost publish a failure", async () => {
    const result = await runStockSwap({
      ...(await base()),
      publish: async () => {
        throw new Error("connection reset");
      },
    });
    expect(result).toMatchObject({ kind: "unconfirmed", intentHash: null });
  });

  it("throws only a refusal that proves nothing moved", async () => {
    await expect(
      runStockSwap({
        ...(await base()),
        publish: async () => {
          throw new WithdrawError("refused", "untouched");
        },
      })
    ).rejects.toThrow("refused");
  });

  it("never asks the wallet when the balance is short", async () => {
    const signEnvelope = vi.fn();
    await expect(
      runStockSwap({
        ...(await base()),
        signer: { scheme: "ed25519", signEnvelope } as never,
        readHeld: async () => BigInt(1),
      })
    ).rejects.toThrow(StockSwapNotSignableError);
    expect(signEnvelope).not.toHaveBeenCalled();
  });
});
