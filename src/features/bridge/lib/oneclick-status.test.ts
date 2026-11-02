import { describe, expect, it, vi } from "vitest";
import {
  CONVERSION_POLL_FIRST_MS,
  CONVERSION_POLL_MAX_MS,
  CONVERSION_WATCH_FLOOR_MS,
  ONE_CLICK_STATUSES,
  conversionWatchBudgetMs,
  readConversionStatus,
  waitForConversionOutcome,
  type OneClickStatus,
} from "./oneclick-status";

// What these tests defend: only an answer PROVABLY about our quote may close anything, only
// SUCCESS and REFUNDED close it, and nothing — an outage, a 404, a shape we do not know — is
// ever read as a conclusion.

const DEPOSIT = "5863efabda6c40d89b37aa899add569e32cb7a670e6b56a7f2cbb8d62c5333a0";
const SIGNATURE =
  "ed25519:3pqqpV5Xz3UboL1wq7TjCeJ9AD6xQUzSSZ2FAawWc7MPLqn4vsW4U3vfZHUeBrVGFM2kbdkvpq69F7gZUHUeybHr";

// ── Recorded 2026-10-06 (s226) from the live API, no key: `/v0/status` on the deposit address of
// the ETH → NEAR quote the 020-1 fixtures were taken from (nobody paid it). Verbatim.
const RECORDED_PENDING_DEPOSIT = {
  status: "PENDING_DEPOSIT",
  updatedAt: "2026-10-06T10:17:24.275Z",
  correlationId: "547cf394-a748-4e78-9305-68cf2956025a",
  swapDetails: {
    depositedAmount: null, depositedAmountUsd: null, depositedAmountFormatted: null,
    intentHashes: [], nearTxHashes: [], amountIn: null, amountInFormatted: null, amountInUsd: null,
    amountOut: null, amountOutFormatted: null, amountOutUsd: null, slippage: null,
    refundedAmount: "0", refundedAmountFormatted: "0", refundedAmountUsd: "0", refundReason: null,
    refundFee: "0", withdrawFee: "0", originChainTxHashes: [], destinationChainTxHashes: [],
  },
  quoteResponse: {
    timestamp: "2026-10-06T10:17:23.945Z",
    signature: SIGNATURE,
    quoteRequest: {
      dry: false, swapType: "EXACT_INPUT", depositMode: "SIMPLE", slippageTolerance: 50,
      originAsset: "nep141:eth.omft.near", depositType: "INTENTS",
      destinationAsset: "nep141:eth.bridge.near", amount: "5000000000000000",
      refundTo: "pablofork.near", refundType: "INTENTS", recipient: "pablofork.near",
      recipientType: "DESTINATION_CHAIN", deadline: "2026-10-06T10:27:22.000Z",
      appFees: [
        {
          limitOrderId: null,
          recipient: "5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd",
          fee: 1,
        },
      ],
      virtualChainRecipient: null, virtualChainRefundRecipient: null, referral: null,
      confidentiality: "public",
    },
    quote: {
      amountIn: "5000000000000000", amountInFormatted: "0.005", amountInUsd: "13.569750000000",
      minAmountIn: "5000000000000000", amountOut: "4998990052004899",
      amountOutFormatted: "0.004998990052004899", amountOutUsd: "13.567009051639",
      minAmountOut: "4973995101744874", timeWhenInactive: "2026-10-09T10:27:22.000Z",
      depositAddress: DEPOSIT, deadline: "2026-10-09T10:27:22.000Z", timeEstimate: 10,
      refundFee: "0", withdrawFee: "0",
    },
  },
};

/**
 * The other six states have not been seen live yet (020-4). Built from the recorded shape plus the
 * fields the spec documents for them (`SwapDetails`, `TransactionDetails {hash, explorerUrl}`).
 */
function withStatus(status: OneClickStatus, swapDetails: Record<string, unknown> = {}) {
  return {
    ...RECORDED_PENDING_DEPOSIT,
    status,
    swapDetails: { ...RECORDED_PENDING_DEPOSIT.swapDetails, ...swapDetails },
  };
}

const SUCCESS = withStatus("SUCCESS", {
  amountIn: "5000000000000000",
  amountOut: "4998990052004899",
  nearTxHashes: ["NearTxA", "NearTxB"],
  destinationChainTxHashes: [{ hash: "DestTx123", explorerUrl: "https://nearblocks.io/txns/DestTx123" }],
});
const REFUNDED = withStatus("REFUNDED", { refundedAmount: "5000000000000000", refundReason: "EXPIRED" });

function respond(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

/** A fetch that never answers on its own: it settles only when its signal aborts. */
function hanging() {
  return vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })
  ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

function read(fetchImpl: typeof fetch, quoteSignature?: string) {
  return readConversionStatus({ depositAddress: DEPOSIT, quoteSignature, deps: { fetchImpl } });
}

describe("readConversionStatus — one read", () => {
  it("reads the recorded PENDING_DEPOSIT answer", async () => {
    const result = await read(respond(RECORDED_PENDING_DEPOSIT), SIGNATURE);
    expect(result).toEqual({
      ok: true,
      reading: {
        status: "PENDING_DEPOSIT",
        updatedAt: "2026-10-06T10:17:24.275Z",
        destinationTxHash: null,
        amountOutRaw: null,
        refundedAmountRaw: "0",
      },
    });
  });

  it("asks 1Click by deposit address, on /v0/status", async () => {
    const fetchImpl = respond(RECORDED_PENDING_DEPOSIT);
    await read(fetchImpl);
    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`https://1click.chaindefuser.com/v0/status?depositAddress=${DEPOSIT}`);
  });

  it("accepts each of the seven documented states", async () => {
    for (const status of ONE_CLICK_STATUSES) {
      const result = await read(respond(withStatus(status)));
      expect(result.ok && result.reading.status).toBe(status);
    }
  });

  it("reads the destination transaction and what went out on SUCCESS", async () => {
    const result = await read(respond(SUCCESS), SIGNATURE);
    expect(result).toMatchObject({
      ok: true,
      reading: { status: "SUCCESS", destinationTxHash: "DestTx123", amountOutRaw: "4998990052004899" },
    });
  });

  it("reads what came back on REFUNDED", async () => {
    const result = await read(respond(REFUNDED), SIGNATURE);
    expect(result).toMatchObject({
      ok: true,
      reading: { status: "REFUNDED", refundedAmountRaw: "5000000000000000" },
    });
  });

  it("refuses a status outside the seven — an unknown word is not a conclusion", async () => {
    const result = await read(respond({ ...RECORDED_PENDING_DEPOSIT, status: "COMPLETED" }));
    expect(result.ok).toBe(false);
  });

  it("refuses an answer about another deposit address", async () => {
    const other = {
      ...SUCCESS,
      quoteResponse: {
        ...SUCCESS.quoteResponse,
        quote: { ...SUCCESS.quoteResponse.quote, depositAddress: "f".repeat(64) },
      },
    };
    expect((await read(respond(other))).ok).toBe(false);
  });

  it("refuses an answer with no quoteResponse to prove what it is about", async () => {
    const bare: Partial<typeof SUCCESS> = { ...SUCCESS };
    delete bare.quoteResponse;
    expect((await read(respond(bare))).ok).toBe(false);
  });

  it("refuses an answer signed for another quote, and accepts ours", async () => {
    expect((await read(respond(SUCCESS), "ed25519:someOtherQuote")).ok).toBe(false);
    expect((await read(respond(SUCCESS), SIGNATURE)).ok).toBe(true);
  });

  it("turns 404, 5xx, a broken body and an outage into no answer — never a throw", async () => {
    expect((await read(respond({ message: "Deposit address not found" }, 404))).ok).toBe(false);
    expect((await read(respond({}, 503))).ok).toBe(false);
    const broken = vi.fn(async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    expect((await read(broken)).ok).toBe(false);
    const down = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await read(down)).toEqual({ ok: false, detail: "1Click status unreachable (Failed to fetch)" });
  });

  it("gives up on a request that never answers — no answer this round, not a hung watch", async () => {
    const result = await readConversionStatus({
      depositAddress: DEPOSIT,
      readTimeoutMs: 5,
      deps: { fetchImpl: hanging() },
    });
    expect(result).toMatchObject({ ok: false, detail: expect.stringContaining("within 5ms") });
  });

  it("gives up on a body that never finishes arriving", async () => {
    const stalledBody = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = new ReadableStream({
        start(c) {
          init?.signal?.addEventListener("abort", () => c.error(init.signal?.reason));
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    const result = await readConversionStatus({
      depositAddress: DEPOSIT,
      readTimeoutMs: 5,
      deps: { fetchImpl: stalledBody },
    });
    expect(result).toEqual({ ok: false, detail: "1Click status gave no answer within 5ms" });
  });

  it("drops amounts that are not base-unit integers instead of passing them on", async () => {
    const result = await read(respond(withStatus("SUCCESS", { amountOut: "4.99", refundedAmount: -1 })));
    expect(result).toMatchObject({ ok: true, reading: { amountOutRaw: null, refundedAmountRaw: null } });
  });
});

/** A fake clock: `sleep` advances it, so a 15-minute watch runs in microseconds. */
function fakeTime() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
  };
}

/** A fetch that answers each body in turn, then repeats the last one. */
function sequence(...bodies: Array<{ body: unknown; status?: number }>) {
  let i = 0;
  return vi.fn(async () => {
    const { body, status = 200 } = bodies[Math.min(i++, bodies.length - 1)];
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

function watch(
  fetchImpl: typeof fetch,
  over: { timeoutMs?: number; signal?: AbortSignal; readTimeoutMs?: number } = {}
) {
  const time = fakeTime();
  const readings: string[] = [];
  const promise = waitForConversionOutcome({
    depositAddress: DEPOSIT,
    quoteSignature: SIGNATURE,
    timeoutMs: over.timeoutMs ?? CONVERSION_WATCH_FLOOR_MS,
    signal: over.signal,
    readTimeoutMs: over.readTimeoutMs,
    onReading: (r) => readings.push(r.status),
    deps: { fetchImpl, now: time.now, sleep: time.sleep },
  });
  return { promise, time, readings };
}

describe("waitForConversionOutcome — the watch", () => {
  it("follows the states until SUCCESS and reports every reading", async () => {
    const fetchImpl = sequence(
      { body: RECORDED_PENDING_DEPOSIT },
      { body: withStatus("KNOWN_DEPOSIT_TX") },
      { body: withStatus("PROCESSING") },
      { body: SUCCESS }
    );
    const { promise, readings } = watch(fetchImpl);
    const outcome = await promise;
    expect(outcome).toMatchObject({ kind: "delivered", reading: { destinationTxHash: "DestTx123" } });
    expect(readings).toEqual(["PENDING_DEPOSIT", "KNOWN_DEPOSIT_TX", "PROCESSING", "SUCCESS"]);
  });

  it("ends on REFUNDED with what came back", async () => {
    const outcome = await watch(sequence({ body: withStatus("PROCESSING") }, { body: REFUNDED })).promise;
    expect(outcome).toMatchObject({ kind: "refunded", reading: { refundedAmountRaw: "5000000000000000" } });
  });

  it("ends on FAILED at once — and reports it as failed, which resolves nothing", async () => {
    const fetchImpl = sequence({ body: withStatus("FAILED") }, { body: REFUNDED });
    const outcome = await watch(fetchImpl).promise;
    expect(outcome.kind).toBe("failed");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("keeps watching through INCOMPLETE_DEPOSIT: a refund is on its way, not an answer", async () => {
    const outcome = await watch(
      sequence({ body: withStatus("INCOMPLETE_DEPOSIT") }, { body: withStatus("INCOMPLETE_DEPOSIT") }, { body: REFUNDED })
    ).promise;
    expect(outcome.kind).toBe("refunded");
  });

  it("rides out unreadable answers without concluding anything from them", async () => {
    const fetchImpl = sequence(
      { body: { message: "Deposit address not found" }, status: 404 },
      { body: {}, status: 502 },
      { body: { ...SUCCESS, status: "DONE" } },
      { body: SUCCESS }
    );
    const outcome = await watch(fetchImpl).promise;
    expect(outcome.kind).toBe("delivered");
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("stops at the budget with the last reading and why — not delivered, not failed", async () => {
    const { promise, time } = watch(sequence({ body: withStatus("PROCESSING") }), { timeoutMs: 60_000 });
    const outcome = await promise;
    expect(outcome).toEqual({
      kind: "unanswered",
      last: expect.objectContaining({ status: "PROCESSING" }),
      detail: "no final answer within 60s (1Click still reports PROCESSING)",
    });
    // The last sleep is clipped to what is left, so the final read lands ON the deadline.
    expect(time.sleeps.reduce((a, b) => a + b, 0)).toBe(60_000);
  });

  it("reports the outage, not a state, when 1Click never answered usefully", async () => {
    const outcome = await watch(sequence({ body: {}, status: 503 }), { timeoutMs: 10_000 }).promise;
    expect(outcome).toEqual({
      kind: "unanswered",
      last: null,
      detail: "no final answer within 10s (1Click status answered 503)",
    });
  });

  it("ends at the budget even when every request hangs", async () => {
    const fetchImpl = hanging();
    const outcome = await watch(fetchImpl, { timeoutMs: 10_000, readTimeoutMs: 5 }).promise;
    expect(outcome).toMatchObject({
      kind: "unanswered",
      last: null,
      detail: expect.stringContaining("no final answer within 10s"),
    });
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1);
  });

  it("backs off from 2 s to a 15 s ceiling", async () => {
    const { promise, time } = watch(sequence({ body: withStatus("PROCESSING") }), { timeoutMs: 120_000 });
    await promise;
    expect(time.sleeps.slice(0, 7)).toEqual([
      CONVERSION_POLL_FIRST_MS, 3_000, 4_500, 6_750, 10_125, CONVERSION_POLL_MAX_MS, CONVERSION_POLL_MAX_MS,
    ]);
  });

  it("stops when the caller aborts, without another read", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => {
      controller.abort();
      return new Response(JSON.stringify(withStatus("PROCESSING")));
    }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    const outcome = await watch(fetchImpl, { signal: controller.signal }).promise;
    expect(outcome).toMatchObject({ kind: "unanswered", detail: "stopped watching" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("wakes from the real sleep as soon as the caller aborts", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const fetchImpl = vi.fn() as unknown as typeof fetch & ReturnType<typeof vi.fn>;
      const promise = waitForConversionOutcome({
        depositAddress: DEPOSIT,
        timeoutMs: CONVERSION_WATCH_FLOOR_MS,
        signal: controller.signal,
        deps: { fetchImpl },
      });
      controller.abort();
      await expect(promise).resolves.toMatchObject({ kind: "unanswered", detail: "stopped watching" });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("conversionWatchBudgetMs", () => {
  it("never watches less than the floor", () => {
    expect(conversionWatchBudgetMs(null)).toBe(CONVERSION_WATCH_FLOOR_MS);
    expect(conversionWatchBudgetMs(10)).toBe(CONVERSION_WATCH_FLOOR_MS);
    expect(conversionWatchBudgetMs(0)).toBe(CONVERSION_WATCH_FLOOR_MS);
  });

  it("gives a slow route four times 1Click's estimate", () => {
    // nBTC → Bitcoin was quoted at ~8 minutes (plan 020 §6).
    expect(conversionWatchBudgetMs(480)).toBe(32 * 60 * 1000);
  });
});
