import { describe, expect, it, vi } from "vitest";
import { Account, KeyPair, actions, type KeyPairString, type Provider } from "near-api-js";
import {
  classifySendResponse,
  classifyViewResponse,
  createRelayRpc,
  relayUpstreamsFromConfig,
  type RelayUpstream,
} from "./relay-rpc-provider";
import { readNearRpcConfig } from "@/features/wallet/lib/near-rpc-proxy";

const BLOCK_HASH = "11111111111111111111111111111111";

/** A fake upstream implementing only what Account reads. Every method is a spy. */
function fakeUpstream(role: RelayUpstream["role"], overrides: Record<string, unknown> = {}) {
  const provider = {
    viewAccessKey: vi.fn(async () => ({ nonce: BigInt(41), permission: "FullAccess" })),
    viewBlock: vi.fn(async () => ({ header: { hash: BLOCK_HASH, height: 1 } })),
    sendTransactionUntil: vi.fn(async () => ({ status: { SuccessValue: "" } })),
    sendJsonRpc: vi.fn(async (method: string) => ({ via: role, method })),
    connection: { url: `https://${role}.example` },
    ...overrides,
  };
  return {
    role,
    host: `${role}.example`,
    url: `https://${role}.example/rpc`,
    headers: (role === "primary" ? { "X-API-Key": "secret" } : {}) as Record<string, string>,
    provider: provider as unknown as Provider,
    spies: provider,
  };
}

const quiet = { log: () => {} };

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

const OUTCOME = {
  status: { SuccessValue: "" },
  transaction_outcome: { id: "tx", outcome: { tokens_burnt: "1" } },
  receipts_outcome: [],
};

/** A `send_tx` JSON-RPC answer, the way nearcore's HTTP layer returns it. */
const rpcResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// Shape near-api-js 7.2.0 parses into InvalidNonceError (providers/errors/parse.js).
const INVALID_NONCE = {
  name: "HANDLER_ERROR",
  cause: { name: "INVALID_TRANSACTION", info: {} },
  data: { TxExecutionError: { InvalidTxError: { InvalidNonce: { ak_nonce: 50, tx_nonce: 42 } } } },
};

describe("createRelayRpc — reads", () => {
  it("serves reads from the primary when it answers", async () => {
    const primary = fakeUpstream("primary");
    const fallback = fakeUpstream("fallback");
    const { provider: p } = createRelayRpc([primary, fallback], quiet);

    await p.viewBlock({ finality: "final" });
    expect(primary.spies.viewBlock).toHaveBeenCalledTimes(1);
    expect(fallback.spies.viewBlock).not.toHaveBeenCalled();
  });

  it("moves a read to the fallback on an error, and logs the host without secrets", async () => {
    const lines: string[] = [];
    const primary = fakeUpstream("primary", {
      viewBlock: vi.fn(async () => {
        throw new SyntaxError("Unexpected token U in JSON"); // what a 401 body turns into
      }),
    });
    const fallback = fakeUpstream("fallback");
    const { provider: p } = createRelayRpc([primary, fallback], { log: (l) => lines.push(l) });

    await expect(p.viewBlock({ finality: "final" })).resolves.toMatchObject({ header: { hash: BLOCK_HASH } });
    expect(fallback.spies.viewBlock).toHaveBeenCalledTimes(1);
    expect(lines).toEqual([
      "[relay-rpc] primary primary.example failed on viewBlock: Unexpected token U in JSON — trying fallback",
    ]);
  });

  it("moves a read to the fallback when the primary hangs (near-api-js has no timeout of its own)", async () => {
    const primary = fakeUpstream("primary", { viewBlock: vi.fn(() => new Promise(() => {})) });
    const fallback = fakeUpstream("fallback");
    const { provider: p } = createRelayRpc([primary, fallback], { readTimeoutMs: 20, ...quiet });

    await expect(p.viewBlock({ finality: "final" })).resolves.toBeDefined();
    expect(fallback.spies.viewBlock).toHaveBeenCalledTimes(1);
  });

  it("gives the LAST upstream a looser budget: a slow FastNEAR still answers (as before D-173)", async () => {
    const slow = () => new Promise((r) => setTimeout(() => r({ header: { hash: BLOCK_HASH } }), 60));
    const primary = fakeUpstream("primary", { viewBlock: vi.fn(async () => { throw new Error("down"); }) });
    const fallback = fakeUpstream("fallback", { viewBlock: vi.fn(slow) });
    const { provider: p } = createRelayRpc([primary, fallback], { readTimeoutMs: 20, ...quiet });
    await expect(p.viewBlock({ finality: "final" })).resolves.toMatchObject({ header: { hash: BLOCK_HASH } });

    // Without a key FastNEAR is the only upstream, hence also the last.
    const only = createRelayRpc([fakeUpstream("fallback", { viewBlock: vi.fn(slow) })], { readTimeoutMs: 20, ...quiet });
    await expect(only.provider.viewBlock({ finality: "final" })).resolves.toBeDefined();
  });

  it("cuts a hung LAST upstream off at its own budget, so the relay answers before maxDuration (D-368)", async () => {
    const hang = vi.fn(() => new Promise(() => {}));
    const primary = fakeUpstream("primary", { viewAccessKey: vi.fn(async () => { throw new Error("down"); }) });
    const fallback = fakeUpstream("fallback", { viewAccessKey: hang });
    const { provider: p } = createRelayRpc([primary, fallback], { readTimeoutMs: 20, lastReadTimeoutMs: 40, ...quiet });

    await expect(p.viewAccessKey({ accountId: "relayer.near", publicKey: "ed25519:x" })).rejects.toThrow(
      "timeout after 40ms"
    );
    expect(hang).toHaveBeenCalledTimes(1);
  });

  it("throws the last error when every upstream fails a read", async () => {
    const boom = (msg: string) => vi.fn(async () => { throw new Error(msg); });
    const { provider: p } = createRelayRpc(
      [fakeUpstream("primary", { viewBlock: boom("p") }), fakeUpstream("fallback", { viewBlock: boom("f") })],
      quiet
    );
    await expect(p.viewBlock({ finality: "final" })).rejects.toThrow("f");
  });

  it("does not turn non-methods into functions (awaiting the provider must not hang)", async () => {
    const p = createRelayRpc([fakeUpstream("primary")], quiet).provider as unknown as Record<string, unknown>;
    expect(p.then).toBeUndefined();
    expect(p.connection).toEqual({ url: "https://primary.example" });
  });
});

describe("createRelayRpc — the reads provider refuses to send (D-329)", () => {
  it("rejects sendTransactionUntil and sendJsonRpc('send_tx') without touching any upstream", async () => {
    const primary = fakeUpstream("primary");
    const { provider } = createRelayRpc([primary, fakeUpstream("fallback")], quiet);
    const p = provider as unknown as { sendJsonRpc: (m: string, params: unknown) => Promise<unknown> };

    await expect(provider.sendTransactionUntil({} as never, "EXECUTED_OPTIMISTIC")).rejects.toThrow(/does not send/);
    await expect(p.sendJsonRpc("send_tx", {})).rejects.toThrow(/does not send/);
    expect(primary.spies.sendTransactionUntil).not.toHaveBeenCalled();
    expect(primary.spies.sendJsonRpc).not.toHaveBeenCalled();
    // A generic read still goes through.
    await expect(p.sendJsonRpc("query", {})).resolves.toEqual({ via: "primary", method: "query" });
  });
});

describe("createRelayRpc — sendOnce posts once, to one node", () => {
  it("posts send_tx once to the primary, with its key, when the primary served the reads", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => rpcResponse({ jsonrpc: "2.0", id: "relay-send", result: OUTCOME }));
    const primary = fakeUpstream("primary");
    const rpc = createRelayRpc([primary, fakeUpstream("fallback")], { fetchImpl, ...quiet });

    await rpc.provider.viewBlock({ finality: "final" });
    await expect(rpc.sendOnce("AAEC")).resolves.toEqual({ kind: "outcome", outcome: OUTCOME });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://primary.example/rpc");
    expect(init.headers).toMatchObject({ "X-API-Key": "secret", "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string)).toMatchObject({
      method: "send_tx",
      params: { signed_tx_base64: "AAEC", wait_until: "EXECUTED_OPTIMISTIC" },
    });
  });

  it("posts to the fallback when the reads failed over — never to both", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => rpcResponse({ result: OUTCOME }));
    const primary = fakeUpstream("primary", { viewBlock: vi.fn(async () => { throw new Error("down"); }) });
    const rpc = createRelayRpc([primary, fakeUpstream("fallback")], { fetchImpl, ...quiet });

    await rpc.provider.viewBlock({ finality: "final" });
    await rpc.sendOnce("AAEC");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://fallback.example/rpc");
  });

  it("keeps the send on the fallback when a parallel primary read finishes after a failover", async () => {
    // Account reads nonce ∥ block: the nonce fails over first, the block answers late from the primary.
    const primary = fakeUpstream("primary", {
      viewAccessKey: vi.fn(async () => { throw new Error("down"); }),
      viewBlock: vi.fn(() => new Promise((r) => setTimeout(() => r({ header: { hash: BLOCK_HASH } }), 30))),
    });
    const fetchImpl = vi.fn<FetchImpl>(async () => rpcResponse({ result: OUTCOME }));
    const rpc = createRelayRpc([primary, fakeUpstream("fallback")], { fetchImpl, ...quiet });

    await Promise.all([
      rpc.provider.viewAccessKey({ accountId: "relayer.near", publicKey: "ed25519:x" }),
      rpc.provider.viewBlock({ finality: "final" }),
    ]);
    await rpc.sendOnce("AAEC");
    expect(fetchImpl.mock.calls[0][0]).toBe("https://fallback.example/rpc");
  });

  it.each([
    ["a 503", () => new Response("unavailable", { status: 503 }), /HTTP 503/],
    ["a 500", () => new Response("oops", { status: 500 }), /HTTP 500/],
    ["nearcore's own 408 TIMEOUT_ERROR", () => rpcResponse({ error: { name: "HANDLER_ERROR", cause: { name: "TIMEOUT_ERROR" } } }, 408), /TIMEOUT_ERROR/],
  ])("answers unknown on %s — once, never re-posted", async (_label, answer, message) => {
    const fetchImpl = vi.fn<FetchImpl>(async () => answer());
    const rpc = createRelayRpc([fakeUpstream("primary"), fakeUpstream("fallback")], { fetchImpl, ...quiet });

    const result = await rpc.sendOnce("AAEC");
    expect(result.kind).toBe("unknown");
    expect(result.kind === "unknown" && result.error).toMatch(message);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("answers unknown when the connection drops after posting", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => { throw new TypeError("fetch failed"); });
    const rpc = createRelayRpc([fakeUpstream("primary"), fakeUpstream("fallback")], { fetchImpl, ...quiet });

    await expect(rpc.sendOnce("AAEC")).resolves.toEqual({ kind: "unknown", error: "fetch failed" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("cuts a hung send off and answers unknown instead of waiting for the function limit (D-330)", async () => {
    const fetchImpl = vi.fn<FetchImpl>(
      (_url, init) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        })
    );
    const rpc = createRelayRpc([fakeUpstream("primary"), fakeUpstream("fallback")], { fetchImpl, sendTimeoutMs: 20, ...quiet });

    await expect(rpc.sendOnce("AAEC")).resolves.toEqual({ kind: "unknown", error: "no answer within 20ms" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("the cut-off also covers a body that stops arriving after the headers", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async (_url, init) => {
      const body = new ReadableStream({
        start(controller) {
          init.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
        },
      });
      return new Response(body, { status: 200 });
    });
    const rpc = createRelayRpc([fakeUpstream("primary")], { fetchImpl, sendTimeoutMs: 20, ...quiet });

    await expect(rpc.sendOnce("AAEC")).resolves.toEqual({ kind: "unknown", error: "no answer within 20ms" });
  });

  it("answers invalid-nonce on the node's InvalidNonce refusal", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => rpcResponse({ error: INVALID_NONCE }));
    const rpc = createRelayRpc([fakeUpstream("primary")], { fetchImpl, ...quiet });

    await expect(rpc.sendOnce("AAEC")).resolves.toMatchObject({ kind: "invalid-nonce" });
  });
});

describe("classifySendResponse", () => {
  it("only an execution outcome is an outcome — a revert included", () => {
    const reverted = { ...OUTCOME, status: { Failure: { ActionError: {} } } };
    expect(classifySendResponse(200, { result: reverted })).toEqual({ kind: "outcome", outcome: reverted });
  });

  it("a result without transaction_outcome proves nothing", () => {
    expect(classifySendResponse(200, { result: { final_execution_status: "NONE" } }).kind).toBe("unknown");
    expect(classifySendResponse(200, { result: null }).kind).toBe("unknown");
    expect(classifySendResponse(200, {}).kind).toBe("unknown");
  });

  it("any other refusal at validation is rejected — a re-sign would not fix it", () => {
    const expired = { ...INVALID_NONCE, data: { TxExecutionError: { InvalidTxError: "Expired" } } };
    expect(classifySendResponse(200, { error: expired })).toEqual({
      kind: "rejected",
      error: "The node refused the transaction: Expired",
    });
    const allowance = {
      ...INVALID_NONCE,
      data: {
        TxExecutionError: {
          InvalidTxError: { InvalidAccessKeyError: { NotEnoughAllowance: { allowance: "1", cost: "2" } } },
        },
      },
    };
    const result = classifySendResponse(200, { error: allowance });
    expect(result.kind).toBe("rejected");
    expect(result.kind === "rejected" && result.error).toMatch(/NotEnoughAllowance/);
  });

  it("a JSON-RPC error that is not a refusal at validation stays unknown", () => {
    const internal = { name: "INTERNAL_ERROR", cause: { name: "INTERNAL_ERROR", info: {} } };
    expect(classifySendResponse(500, { error: internal }).kind).toBe("unknown");
  });
});

describe("with the real near-api-js Account", () => {
  const key = KeyPair.fromRandom("ed25519").toString() as KeyPairString;

  it("builds a signed transaction from the reads provider without sending anything", async () => {
    const primary = fakeUpstream("primary");
    const account = new Account("relayer.near", createRelayRpc([primary, fakeUpstream("fallback")], quiet).provider, key);

    const signed = await account.createSignedTransaction({
      receiverId: "intents.near",
      actions: [actions.functionCall("execute_intents", {}, BigInt(1), BigInt(0))],
    });
    expect(signed.transaction.nonce).toBe(BigInt(42));
    expect(primary.spies.viewAccessKey).toHaveBeenCalledTimes(1);
    expect(primary.spies.sendTransactionUntil).not.toHaveBeenCalled();
  });
});

describe("relayUpstreamsFromConfig", () => {
  it("builds primary + fallback from the shared server config, hosts only in the labels", () => {
    const upstreams = relayUpstreamsFromConfig(readNearRpcConfig({ NEAR_RPC_API_KEY: "k" }));
    expect(upstreams.map(({ role, host }) => [role, host])).toEqual([
      ["primary", "rpc.metapool.app"],
      ["fallback", "free.rpc.fastnear.com"],
    ]);
  });

  it("without a key, FastNEAR only — same behaviour as before D-173", () => {
    expect(relayUpstreamsFromConfig(readNearRpcConfig({})).map((u) => u.host)).toEqual(["free.rpc.fastnear.com"]);
  });
});

describe("createRelayRpc — view (017-2)", () => {
  const viewResult = (value: unknown) =>
    rpcResponse({ jsonrpc: "2.0", id: "v", result: { result: [...Buffer.from(JSON.stringify(value))], logs: [] } });
  // What FastNEAR answered for a panicking view, measured against intents.near (s194).
  const legacyPanic = (msg: string) =>
    rpcResponse({
      jsonrpc: "2.0",
      id: "v",
      result: { error: `wasm execution failed with error: HostError(GuestPanic { panic_msg: "${msg}" })`, logs: [] },
    });

  it("returns the decoded value and asks for optimistic finality", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => viewResult({ owner: "alice.near" }));
    const rpc = createRelayRpc([fakeUpstream("primary")], { ...quiet, fetchImpl });

    await expect(rpc.view("vault.near", "get_portfolio", { portfolio_id: "1" })).resolves.toEqual({
      kind: "value",
      value: { owner: "alice.near" },
    });
    const sent = JSON.parse(fetchImpl.mock.calls[0][1].body as string);
    expect(sent.params).toMatchObject({ request_type: "call_function", finality: "optimistic", method_name: "get_portfolio" });
    expect(JSON.parse(Buffer.from(sent.params.args_base64, "base64").toString())).toEqual({ portfolio_id: "1" });
  });

  it("a panic is an answer: returned with its message, and NOT retried on the fallback", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => legacyPanic("invalid signature"));
    const rpc = createRelayRpc([fakeUpstream("primary"), fakeUpstream("fallback")], { ...quiet, fetchImpl });

    await expect(rpc.view("intents.near", "simulate_intents", {})).resolves.toEqual({
      kind: "panic",
      message: "invalid signature",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reads the structured CONTRACT_EXECUTION_ERROR shape as a panic too", () => {
    const body = {
      error: {
        name: "HANDLER_ERROR",
        cause: { name: "CONTRACT_EXECUTION_ERROR", info: { vm_error: 'HostError(GuestPanic { panic_msg: "E_NOT_OWNER" })' } },
      },
    };
    expect(classifyViewResponse(200, body)).toEqual({ kind: "panic", message: "E_NOT_OWNER" });
  });

  it("fails over on a transport error and remembers the fallback for the send", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async (url, init) => {
      if (url.includes("primary")) return new Response("unauthorized", { status: 401 });
      const { method } = JSON.parse(init.body as string) as { method: string };
      return method === "send_tx" ? rpcResponse({ result: OUTCOME }) : viewResult(true);
    });
    const rpc = createRelayRpc([fakeUpstream("primary"), fakeUpstream("fallback")], { ...quiet, fetchImpl });

    await expect(rpc.view("intents.near", "has_public_key", {})).resolves.toEqual({ kind: "value", value: true });
    await expect(rpc.sendOnce("dHg=")).resolves.toEqual({ kind: "outcome", outcome: OUTCOME });
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "https://primary.example/rpc",
      "https://fallback.example/rpc",
      "https://fallback.example/rpc",
    ]);
  });

  it("throws only when no upstream answered", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => rpcResponse({ error: { name: "INTERNAL_ERROR" } }, 500));
    const rpc = createRelayRpc([fakeUpstream("primary"), fakeUpstream("fallback")], { ...quiet, fetchImpl });

    await expect(rpc.view("intents.near", "simulate_intents", {})).rejects.toThrow(/INTERNAL_ERROR/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("cuts a slow non-last upstream off at the read budget", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async (url) =>
      url.includes("primary") ? new Promise<Response>(() => {}) : viewResult(null)
    );
    const rpc = createRelayRpc([fakeUpstream("primary"), fakeUpstream("fallback")], {
      ...quiet,
      fetchImpl,
      readTimeoutMs: 10,
    });

    await expect(rpc.view("vault.near", "get_portfolio", {})).resolves.toEqual({ kind: "value", value: null });
  });
});
