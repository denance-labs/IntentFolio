import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { accountExists, accountHasContract, fetchTxOutcome, utf8Base64, viewCall } from "./near-view";

// `accountExists` gates whether a NEAR withdrawal is allowed to reach the wallet, so the
// only answer it may ever invent is "no". A transient RPC problem read as "this account is
// fine" would sign a transfer that cannot be delivered — and the `near-native` intent
// deliberately carries no `storage_deposit`, so there is no refund. Hence: definite answers
// only, everything else throws.

function rpcResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch(body: unknown) {
  const fn = vi.fn().mockResolvedValue(rpcResponse(body));
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("accountExists", () => {
  it("is true when view_account returns an account", async () => {
    const fetchMock = stubFetch({ result: { amount: "1000", locked: "0" } });
    await expect(accountExists("pablofork.near")).resolves.toBe(true);

    // Through the same-origin proxy, never an RPC host (D-173).
    expect(vi.mocked(fetchMock).mock.calls[0][0]).toBe("/api/near-rpc");
    const body = JSON.parse(vi.mocked(fetchMock).mock.calls[0][1].body as string);
    expect(body.params.request_type).toBe("view_account");
    expect(body.params.account_id).toBe("pablofork.near");
  });

  it("is false on the RPC's structured UNKNOWN_ACCOUNT", async () => {
    stubFetch({
      error: {
        code: -32000,
        message: "Server error",
        name: "HANDLER_ERROR",
        cause: { name: "UNKNOWN_ACCOUNT" },
      },
    });
    await expect(accountExists("definitely-not-real.near")).resolves.toBe(false);
  });

  it("is false on the legacy prose form, which some endpoints still return", async () => {
    stubFetch({
      error: {
        code: -32000,
        message: "Server error",
        data: "account definitely-not-real.near does not exist while viewing",
      },
    });
    await expect(accountExists("definitely-not-real.near")).resolves.toBe(false);
  });

  it("THROWS on any other RPC error rather than guessing", async () => {
    // The dangerous reading would be "no error I recognise, so the account is fine".
    stubFetch({ error: { code: -32000, message: "Server error", data: "timeout" } });
    await expect(accountExists("pablofork.near")).rejects.toThrow(/view_account/);
  });

  it("THROWS on a response with neither result nor error", async () => {
    stubFetch({});
    await expect(accountExists("pablofork.near")).rejects.toThrow(/empty RPC result/);
  });
});

// `fetchTxOutcome` feeds the HOT delivery wait (008.plan block 4.3.4), whose whole job is to
// find a withdrawal nonce in a transaction's RECEIPT logs. A wrong parameter name here does
// not fail loudly: the RPC answers, the receipts are absent, and every HOT withdrawal looks
// permanently undelivered. So the request shape is pinned, not just the happy path.

describe("fetchTxOutcome", () => {
  it("asks for the transaction by hash and sender, waiting for execution", async () => {
    const outcome = { receipts_outcome: [{ outcome: { logs: [`{"memo":"42"}`] } }] };
    const fetchMock = stubFetch({ result: outcome });

    await expect(fetchTxOutcome("8xTxHash", "intents.near")).resolves.toEqual(outcome);

    const body = JSON.parse(vi.mocked(fetchMock).mock.calls[0][1].body as string);
    expect(body.method).toBe("tx");
    expect(body.params).toEqual({
      tx_hash: "8xTxHash",
      sender_account_id: "intents.near",
      // Anything stricter waits for finality the delivery poll does not need; anything
      // looser can answer before the receipts exist.
      wait_until: "EXECUTED_OPTIMISTIC",
    });
  });

  it("THROWS on an RPC error instead of returning an outcome with no receipts", async () => {
    // Read as "no receipts" this would burn the retry budget on a transaction that is
    // simply unknown to this endpoint.
    stubFetch({ error: { code: -32000, message: "Server error", data: "UNKNOWN_TRANSACTION" } });
    await expect(fetchTxOutcome("8xTxHash", "intents.near")).rejects.toThrow(/8xTxHash/);
  });

  it("THROWS on a response with neither result nor error", async () => {
    stubFetch({});
    await expect(fetchTxOutcome("8xTxHash", "intents.near")).rejects.toThrow(/empty RPC result/);
  });
});

// 017-9a cross-review: a v2 `get_allocate_seal` sends the raw Setup msg, and the portfolio
// name in it is free text. `btoa` alone would send Latin-1 (or throw), not the UTF-8 the
// contract parses.
describe("viewCall args encoding", () => {
  it("utf8Base64 encodes UTF-8 bytes, accents and emoji included", () => {
    for (const text of ['{"msg":"Jubilación"}', '{"msg":"Largo plazo 🚀"}', "{}"]) {
      expect(Buffer.from(utf8Base64(text), "base64").toString("utf8")).toBe(text);
    }
  });

  it("sends a non-ASCII argument as UTF-8 JSON", async () => {
    const bytes = Array.from(new TextEncoder().encode("null"));
    const fetchMock = stubFetch({ result: { result: bytes, logs: [], block_height: 1, block_hash: "h" } });
    await viewCall("v.near", "get_allocate_seal", { signer_id: "a.near", msg: "Jubilación 🚀" });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(JSON.parse(Buffer.from(body.params.args_base64, "base64").toString("utf8"))).toEqual({
      signer_id: "a.near",
      msg: "Jubilación 🚀",
    });
  });
});

// D-386 (d): drives a warning, not a refusal — but a wrong "no" would hide it, so only a
// definite `view_account` answer counts and everything else throws for the caller to drop.
describe("accountHasContract", () => {
  const view = (extra: Record<string, unknown>) => ({
    result: { amount: "1", locked: "0", storage_usage: 1, ...extra },
  });

  it("is false for the empty code hash", async () => {
    stubFetch(view({ code_hash: "11111111111111111111111111111111" }));
    await expect(accountHasContract("pablofork.near")).resolves.toBe(false);
  });

  it("is true for any other code hash", async () => {
    stubFetch(view({ code_hash: "BtA1BEFNS619KkvXFsgcpQ21Tb5yMm32aaUkn7xNothk" }));
    await expect(accountHasContract("intents.near")).resolves.toBe(true);
  });

  it("is true for an account running a global contract", async () => {
    stubFetch(view({ code_hash: "11111111111111111111111111111111", global_contract_account_id: "lib.near" }));
    await expect(accountHasContract("multisig.near")).resolves.toBe(true);
  });

  it("throws on an RPC error or a result without a code hash", async () => {
    stubFetch({ error: { code: -32000, message: "Server error" } });
    await expect(accountHasContract("pablofork.near")).rejects.toThrow(/view_account/);
    stubFetch(view({}));
    await expect(accountHasContract("pablofork.near")).rejects.toThrow(/code_hash/);
  });
});
