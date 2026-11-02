// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The flag is read at module load, so each block stubs the environment and re-imports — the
// wiring from the variable to the behaviour is under test too (as in allocate-record-sink).
async function loadSink(enabled: boolean) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_WITHDRAW_RECORDS", enabled ? "true" : "false");
  const sink = await import("./withdraw-record-sink");
  const store = await import("./withdraw-rescue-store");
  return { sink, store };
}

const direct = {
  signerId: "alice.near",
  tokenId: "nep141:wrap.near",
  amount: "1000000000000000000000000",
  qty: 1,
  route: "near-unwrap" as const,
  chainId: "near:mainnet",
  destinationAddress: "bob.near",
  nonce: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
  deadline: 1_760_011_800_000,
};

/** Stands in for the MultiPayload handed to the relay; the sink only forwards it. */
const SIGNED = { standard: "nep413", payload: { message: "{}" }, signature: "ed25519:sig" };

const conversionDetails = {
  depositAddress: "0x1111111111111111111111111111111111111111",
  deliveryTokenId: "nep141:eth.bridge.near",
  amountOut: "990000",
  minAmountOut: "980000",
  requestedDeadlineMs: 1_760_011_800_000,
  quoteSignature: "ed25519:abc",
};

type Sent = { method: string; body: Record<string, unknown>; keepalive: boolean | undefined };

/** A fetch that records every write and can hold the POST until released. */
function recordingFetch(options: { holdPost?: boolean; fail?: boolean } = {}) {
  const sent: Sent[] = [];
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    if (init.method === "POST" && options.holdPost) await held;
    sent.push({ method: init.method as string, body, keepalive: init.keepalive });
    if (options.fail) throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify({ ok: true, id: body.id }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchImpl);
  return { sent, fetchImpl, release };
}

/** Lets every queued write settle. */
const drain = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  window.localStorage.clear();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("withdraw-record-sink — flag off", () => {
  it("behaves exactly as the store: localStorage only, no network", async () => {
    const { fetchImpl } = recordingFetch();
    const { sink, store } = await loadSink(false);

    const id = sink.recordPendingWithdraw(direct, SIGNED);
    sink.updateWithdrawRecord(id, { status: "published", intentHash: "ih" });
    await drain();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.getWithdrawRecord(id)).toMatchObject({ status: "published", intentHash: "ih" });
  });
});

describe("withdraw-record-sink — flag on", () => {
  it("posts the record with keepalive, as the route expects it", async () => {
    const { sent } = recordingFetch();
    const { sink, store } = await loadSink(true);

    const id = sink.recordPendingWithdraw(direct, SIGNED);
    await drain();

    const record = store.getWithdrawRecord(id)!;
    expect(sent).toEqual([
      {
        method: "POST",
        keepalive: true,
        body: {
          id,
          kind: "direct",
          route: "near-unwrap",
          signerId: "alice.near",
          tokenId: "nep141:wrap.near",
          amount: direct.amount,
          chainId: "near:mainnet",
          destinationAddress: "bob.near",
          nonce: direct.nonce,
          deadline: direct.deadline,
          signedPayload: SIGNED,
          createdAt: record.createdAt,
        },
      },
    ]);
  });

  it("posts a conversion with its quote and no route", async () => {
    const { sent } = recordingFetch();
    const { sink } = await loadSink(true);
    const { route: _route, ...base } = direct;
    void _route;

    sink.recordPendingWithdraw({ ...base, kind: "conversion", conversion: conversionDetails }, SIGNED);
    await drain();

    expect(sent[0].body).toMatchObject({ kind: "conversion", conversion: conversionDetails });
    expect(sent[0].body).not.toHaveProperty("route");
  });

  it("returns before the database answers: the publish never waits on it", async () => {
    const { sent, release } = recordingFetch({ holdPost: true });
    const { sink } = await loadSink(true);

    const id = sink.recordPendingWithdraw(direct, SIGNED);

    expect(typeof id).toBe("string");
    expect(sent).toEqual([]);
    release();
    await drain();
    expect(sent).toHaveLength(1);
  });

  it("sends each PATCH after the POST, in order, even while the POST is slow", async () => {
    const { sent, release } = recordingFetch({ holdPost: true });
    const { sink } = await loadSink(true);

    const id = sink.recordPendingWithdraw(direct, SIGNED);
    sink.updateWithdrawRecord(id, { status: "published", intentHash: "ih" });
    sink.updateWithdrawRecord(id, { status: "settled", txHash: "Gx1" });
    await drain();
    expect(sent).toEqual([]);

    release();
    await drain();
    await drain();
    expect(sent.map((s) => [s.method, s.body.status])).toEqual([
      ["POST", undefined],
      ["PATCH", "published"],
      ["PATCH", "settled"],
    ]);
  });

  it("mirrors only the columns the table holds", async () => {
    const { sent } = recordingFetch();
    const { sink } = await loadSink(true);
    const id = sink.recordPendingWithdraw(direct, SIGNED);

    sink.updateWithdrawRecord(id, { status: "delivered", destinationTxHash: "0xd", deliveredAmount: "5" });
    sink.updateWithdrawRecord(id, { refundedAmount: "1" });
    await drain();
    await drain();

    expect(sent.map((s) => s.body)).toEqual([
      expect.objectContaining({ id }),
      { id, status: "delivered", destinationTxHash: "0xd" },
    ]);
  });

  it("drops an empty hash instead of losing the status it travels with", async () => {
    const { sent } = recordingFetch();
    const { sink } = await loadSink(true);
    const id = sink.recordPendingWithdraw(direct, SIGNED);

    sink.updateWithdrawRecord(id, { status: "delivered", destinationTxHash: "" });
    await drain();
    await drain();

    expect(sent[1].body).toEqual({ id, status: "delivered" });
  });

  it("sends no memo when the memo is empty: absence is NULL in the table", async () => {
    const { sent } = recordingFetch();
    const { sink } = await loadSink(true);

    sink.recordPendingWithdraw({ ...direct, destinationMemo: "" }, SIGNED);
    await drain();

    expect(sent[0].body).not.toHaveProperty("destinationMemo");
  });

  it("never sends `dismissed`", async () => {
    const { sent } = recordingFetch();
    const { sink } = await loadSink(true);
    const id = sink.recordPendingWithdraw(direct, SIGNED);

    sink.updateWithdrawRecord(id, { status: "dismissed" });
    await drain();

    expect(sent.map((s) => s.method)).toEqual(["POST"]);
  });

  it("mirrors a re-check's verdict only when the guarded write happened", async () => {
    const { sent } = recordingFetch();
    const { sink, store } = await loadSink(true);
    const id = sink.recordPendingWithdraw(direct, SIGNED);
    store.updateWithdrawRecord(id, { status: "delivered" }); // another tab got there first

    expect(sink.resolveUnansweredPublish(id, { status: "settled", txHash: "Gx1" })).toBe(false);
    await drain();
    expect(sent.map((s) => s.method)).toEqual(["POST"]);
  });

  it("never throws when the database is unreachable", async () => {
    recordingFetch({ fail: true });
    const { sink, store } = await loadSink(true);

    const id = sink.recordPendingWithdraw(direct, SIGNED);
    sink.updateWithdrawRecord(id, { status: "published" });
    await drain();
    await drain();

    expect(store.getWithdrawRecord(id)).toMatchObject({ status: "published" });
    expect(console.warn).toHaveBeenCalled();
  });

  it("still throws — and sends nothing — when localStorage cannot persist", async () => {
    const { fetchImpl } = recordingFetch();
    const { sink } = await loadSink(true);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });

    expect(() => sink.recordPendingWithdraw(direct, SIGNED)).toThrow(/Quota/);
    await drain();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("skips the POST for a record with no nonce: the table could not resolve it", async () => {
    const { fetchImpl } = recordingFetch();
    const { sink } = await loadSink(true);
    const { nonce: _nonce, ...noNonce } = direct;
    void _nonce;

    sink.recordPendingWithdraw(noNonce, SIGNED);
    await drain();

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
