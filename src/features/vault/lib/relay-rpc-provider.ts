// The relayer's NEAR RPC (D-173, 014.plan B3; D-329/D-330, 017-1; D-557): Meta Pool's keyed RPC
// first, FastNEAR as fallback. A read moves on any error. A signed transaction goes to one upstream
// and, only if that answer proves nothing, the SAME bytes go once to the next (D-557).
//
// Two halves, and they are deliberately not the same mechanism:
//
// - `provider` serves READS (the nonce via `viewAccessKey`, the block hash via `viewBlock`). They
//   are raced against a timeout and move to the next upstream on any error — they are idempotent,
//   and an error that is really an answer (or a sick node's JSON-RPC error) just gets asked again
//   of the fallback. It REFUSES to send: a send through it throws before anything leaves.
// - `sendSigned` posts the signed bytes to whichever upstream served the reads, with a hard cut-off
//   shared by every post. It never throws; it says what the answer proves.
//
// Why the second post is safe (D-557): the same bytes are the same hash and the same nonce, so the
// chain cannot run them twice. Measured 2026-11-06 on FastNEAR with an already executed relayer tx
// (`DyZ7MqXT…`, 7 h old): HTTP 200 in 197 ms with the original outcome, key nonce unchanged. That
// sample does not cover a node lagging seconds behind the first post, which could refuse the tx for
// a nonce it already spent. So after a re-post only an outcome counts: a refusal is not proof that
// the tx never ran, it stays `unknown`, and `unknown` is never signed again (relay-sender.ts).
//
// Why not near-api-js's own send (measured against near-api-js 7.2.0):
// - `JsonRpcProvider` re-posts the same signed bytes up to 12 times on HTTP 408/500/503 or a fetch
//   failure (json-rpc-provider.js REQUEST_RETRY_NUMBER, fetch_json.js retryConfig). A first attempt
//   that landed makes a later one fail with `InvalidNonce`, and `Account.signAndSendTransaction`
//   then signs a SECOND transaction (account.js:237-251). Its revert is what the relay used to
//   hand back, hiding the success of the first (D-329).
// - `fetchJsonRpc` calls `fetch` with no signal: a node that accepts the tx and hangs holds the
//   request until the function times out (D-330).
//
// Why not near-api-js's FailoverRpcProvider: its `withBackoff` catches EVERY error, a refusal at
// validation included, re-sends the same signed transaction to the next node, and after the last
// one throws a generic RetriesExceeded. The caller cannot tell what any of those answers proved.
//
// A JS Proxy rather than a Provider implementation: Account only calls a handful of methods
// (viewAccessKey, viewBlock, …), and wrapping by name keeps this file independent of the
// ~30-method Provider interface.

import { JsonRpcProvider, type Provider } from "near-api-js";
import type { NearRpcConfig, NearRpcUpstream } from "@/features/wallet/lib/near-rpc-proxy";

/**
 * Per-read budget before the next upstream is tried. Not popup-bound (the user signed before the
 * relay is called), so it is looser than the browser proxy's 1.5s; the primary answers these
 * reads in ~0.1s when healthy (solver measurement from `pericles`, 2026-09).
 *
 * The LAST upstream does not get this budget: with nothing left to try, cutting it off early only
 * turns a slow answer into a failed relay. Its views are bounded by the relay's check budget
 * (RELAY_CHECK_BUDGET_MS); its provider reads get RELAY_LAST_READ_TIMEOUT_MS.
 */
export const RELAY_READ_TIMEOUT_MS = 3_000;

/**
 * Budget for a provider read (the sender's nonce ∥ block, before signing) on the LAST upstream.
 * Without it a hung FastNEAR — or near-api-js's own 12 retries — holds the request past the
 * route's `maxDuration`, and the platform's 504 replaces the relay's answer (D-368). A read is
 * not a send: cutting it off cannot lose a broadcast tx, the relay answers "nothing ran".
 * Loose enough that a slow answer still lands: checks (10 s) + primary read (3 s) + this (10 s)
 * + send (30 s) + allowance (2 s) = 55 s < 60 s for one attempt. Not a closed budget: two
 * InvalidNonce re-signs whose reads each answer just under this cut can still pass 60 s.
 */
export const RELAY_LAST_READ_TIMEOUT_MS = 10_000;

/**
 * How long the send may take, re-post included, before the relay stops waiting and answers
 * "unknown outcome". One budget for both posts: a first post that used it all gets no second, and
 * the relay's arithmetic against `maxDuration` does not change.
 * `send_tx` waits for EXECUTED_OPTIMISTIC, i.e. through the fan-out receipts (execute_intents →
 * the vault's on_auth, or the commit → mt_batch_transfer): a handful of blocks, seconds when the
 * chain is healthy. 30 s leaves room for a congested shard and still answers well inside the
 * function's own limit. Not measured yet against the `[relay]` logs (017-1 §Enfoque).
 */
export const RELAY_SEND_TIMEOUT_MS = 30_000;

/** Methods that put a transaction on the network. The reads-only provider refuses them. */
const SEND_METHODS = new Set(["sendTransaction", "sendTransactionUntil", "sendTransactionAsync"]);

/** The generic `sendJsonRpc` escape hatch counts as a send when the RPC method is one. */
const isSendCall = (prop: string, args: unknown[]): boolean =>
  SEND_METHODS.has(prop) ||
  (prop === "sendJsonRpc" && typeof args[0] === "string" && /^(send_tx|broadcast_tx)/.test(args[0]));

export type RelayUpstream = {
  role: NearRpcUpstream["role"];
  host: string;
  /** Full URL and headers (the key): `sendSigned` posts to them. Never logged — `host` is. */
  url: string;
  headers: Record<string, string>;
  provider: Provider;
};

/**
 * What the send proves. The relay's whole honesty rests on these three staying apart:
 *   - `outcome`: the chain executed the tx; the outcome says how (a revert is still an outcome);
 *   - `invalid-nonce`: the node refused the FIRST post at validation because another tx from the
 *     same key took the nonce first. It was never executed and, with its nonce spent, never will be;
 *   - `rejected`: the node refused the FIRST post at validation for any other reason (the key's
 *     allowance or the account's balance ran out, an expired block hash, a congested shard, …). A
 *     refused tx is never forwarded, so it never runs — the same proof as InvalidNonce, but a
 *     re-sign would not fix it (operator decision, 017-1 s193);
 *   - `unknown`: anything else — a cut-off, a 5xx, an unreadable body, any other JSON-RPC
 *     error. The tx may have landed. Nothing here may be read as "it failed".
 */
export type RelaySendResult =
  | { kind: "outcome"; outcome: unknown }
  | { kind: "invalid-nonce"; error: string }
  | { kind: "rejected"; error: string }
  | { kind: "unknown"; error: string };

/**
 * What a contract view answered. A panic IS an answer — the contract looked at the arguments and
 * said no — so it comes back here instead of failing over: asking FastNEAR the same question
 * would only double the wait for the same "no".
 */
export type RelayViewResult = { kind: "value"; value: unknown } | { kind: "panic"; message: string };

export type RelayRpc = {
  /** Reads only. Any send through it throws before a byte leaves (see the header). */
  provider: Provider;
  /** Posts the signed transaction (base64 borsh), re-posting once if the answer proves nothing. Never throws. */
  sendSigned: (signedTxBase64: string) => Promise<RelaySendResult>;
  /**
   * A contract view at `optimistic` finality — the state the send would meet, so funds credited
   * a block ago are not refused. Fails over like the reads; throws only when no upstream
   * answered at all (017-2, D-365: the relay's checks before paying the gas).
   */
  view: (contractId: string, methodName: string, args: Record<string, unknown>) => Promise<RelayViewResult>;
};

type Options = {
  readTimeoutMs?: number;
  lastReadTimeoutMs?: number;
  sendTimeoutMs?: number;
  /** Only ever called as `(url, init)`; injectable so the send is testable without a network. */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  log?: (line: string) => void;
};

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * One RPC per relay request (route.ts builds it per POST), so "the upstream that served the
 * reads" is scoped to that request and a primary blip never pins later requests to FastNEAR.
 */
export function createRelayRpc(
  upstreams: RelayUpstream[],
  {
    readTimeoutMs = RELAY_READ_TIMEOUT_MS,
    lastReadTimeoutMs = RELAY_LAST_READ_TIMEOUT_MS,
    sendTimeoutMs = RELAY_SEND_TIMEOUT_MS,
    fetchImpl = fetch,
    log = (line) => console.warn(line),
  }: Options = {}
): RelayRpc {
  if (upstreams.length === 0) throw new Error("relay provider needs at least one upstream");
  let active = 0;

  const read = async (method: string, args: unknown[]): Promise<unknown> => {
    let lastError: unknown;
    for (let i = active; i < upstreams.length; i++) {
      const { role, host, provider } = upstreams[i];
      try {
        const fn = (provider as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method];
        const call = fn.apply(provider, args);
        const result = await withTimeout(call, i === upstreams.length - 1 ? lastReadTimeoutMs : readTimeoutMs);
        // Only ever moves forward: Account reads in parallel (nonce ∥ block), and a primary read
        // finishing after one that failed over must not move the send back to the primary.
        active = Math.max(active, i);
        return result;
      } catch (e) {
        lastError = e;
        const next = upstreams[i + 1];
        // Host only: the key lives in the provider's headers and never reaches this line.
        log(
          `[relay-rpc] ${role} ${host} failed on ${method}: ${e instanceof Error ? e.message : String(e)}` +
            (next ? ` — trying ${next.role}` : " — no upstream left")
        );
      }
    }
    throw lastError;
  };

  const members = (provider: Provider) => provider as unknown as Record<string, unknown>;

  const provider = new Proxy({} as Provider, {
    get(_target, prop) {
      if (typeof prop !== "string") return undefined;
      // Only wrap what the upstream really has as a method. Anything else (`then` when someone
      // awaits the provider, plain properties) must not turn into a function.
      const member = members(upstreams[active].provider)[prop];
      if (typeof member !== "function") return member;
      return (...args: unknown[]) => {
        if (!isSendCall(prop, args)) return read(prop, args);
        // Rejected, not forwarded: a send through near-api-js brings its retries back (header).
        return Promise.reject(new Error(`relay provider does not send (${prop}); use sendSigned`));
      };
    },
  });

  const sendSigned = async (signedTxBase64: string): Promise<RelaySendResult> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), sendTimeoutMs);
    const post = async ({ url, headers }: RelayUpstream): Promise<RelaySendResult> => {
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "relay-send",
            method: "send_tx",
            params: { signed_tx_base64: signedTxBase64, wait_until: "EXECUTED_OPTIMISTIC" },
          }),
          signal: controller.signal,
        });
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          return unknown(controller, sendTimeoutMs, `HTTP ${response.status} with an unreadable body`);
        }
        return classifySendResponse(response.status, body);
      } catch (e) {
        return unknown(controller, sendTimeoutMs, e instanceof Error ? e.message : String(e));
      }
    };

    try {
      const from = upstreams[active];
      const next = upstreams[active + 1];
      const first = await post(from);
      if (first.kind !== "unknown" || !next || controller.signal.aborted) return first;

      log(`[relay-rpc] ${from.role} ${from.host} left the send unknown: ${first.error} — re-posting to ${next.role}`);
      const second = await post(next);
      // Only an outcome proves anything here (header): this may not be the first copy to arrive.
      if (second.kind === "outcome") return second;
      return { kind: "unknown", error: `${first.error}; ${next.role}: ${second.error}` };
    } finally {
      clearTimeout(timer);
    }
  };

  /** One JSON-RPC `query` per upstream, failing over on a throw, like `read`. */
  const queryWithFailover = async <T>(
    label: string,
    params: Record<string, unknown>,
    classify: (status: number, body: unknown) => T
  ): Promise<T> => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: "relay-view", method: "query", params });
    let lastError: unknown;
    for (let i = active; i < upstreams.length; i++) {
      const { role, host, url, headers } = upstreams[i];
      try {
        const call = (async () => {
          const response = await fetchImpl(url, {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body,
          });
          return classify(response.status, await response.json());
        })();
        const result = await (i === upstreams.length - 1 ? call : withTimeout(call, readTimeoutMs));
        active = Math.max(active, i);
        return result;
      } catch (e) {
        lastError = e;
        const next = upstreams[i + 1];
        log(
          `[relay-rpc] ${role} ${host} failed on ${label}: ${e instanceof Error ? e.message : String(e)}` +
            (next ? ` — trying ${next.role}` : " — no upstream left")
        );
      }
    }
    throw lastError;
  };

  const view = (contractId: string, methodName: string, args: Record<string, unknown>) =>
    queryWithFailover(
      `view ${methodName}`,
      {
        request_type: "call_function",
        finality: "optimistic",
        account_id: contractId,
        method_name: methodName,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      },
      classifyViewResponse
    );

  return { provider, sendSigned, view };
}

/**
 * Reads a `call_function` answer. Nodes report a contract panic in two shapes: the legacy
 * `result.error` string (what FastNEAR answers today, measured s194) and the structured
 * `error.cause.name === "CONTRACT_EXECUTION_ERROR"`. Both are answers. Anything else without a
 * result — another JSON-RPC error, an empty body — throws, so the caller tries the next node.
 */
export function classifyViewResponse(status: number, body: unknown): RelayViewResult {
  const json = (body ?? {}) as {
    error?: { cause?: { name?: unknown; info?: unknown }; data?: unknown };
    result?: { error?: unknown; result?: unknown };
  };
  if (json.error !== undefined) {
    if (json.error?.cause?.name === "CONTRACT_EXECUTION_ERROR") {
      return { kind: "panic", message: panicMessage(JSON.stringify(json.error.cause.info ?? json.error.data ?? "")) };
    }
    throw new Error(`RPC error (HTTP ${status}): ${describeRpcError(json.error)}`);
  }
  if (typeof json.result?.error === "string") return { kind: "panic", message: panicMessage(json.result.error) };
  const bytes = json.result?.result;
  if (!Array.isArray(bytes)) throw new Error(`HTTP ${status} without a view result`);
  if (bytes.length === 0) return { kind: "value", value: undefined };
  return { kind: "value", value: JSON.parse(Buffer.from(bytes as number[]).toString("utf8")) };
}

/** `…GuestPanic { panic_msg: "invalid signature" }…` ⇒ `invalid signature`; otherwise the raw text. */
function panicMessage(raw: string): string {
  const unescaped = raw.replace(/\\"/g, '"');
  const match = /panic_msg: "([^"]*)"/.exec(unescaped);
  return match ? match[1] : unescaped;
}

function unknown(controller: AbortController, ms: number, error: string): RelaySendResult {
  return { kind: "unknown", error: controller.signal.aborted ? `no answer within ${ms}ms` : error };
}

/**
 * Reads a `send_tx` answer. Only two things are conclusive: an execution outcome, and the
 * node's refusal at validation (same shape near-api-js parses: `cause.name` INVALID_TRANSACTION
 * with the variant in `data.TxExecutionError.InvalidTxError`, parse.js). Everything else is
 * `unknown`, whatever the HTTP status — nearcore answers its own TIMEOUT_ERROR with a 408, and
 * that one means "routed, not finished yet".
 *
 * Attribution: see ATTRIBUTIONS.md #16.
 */
export function classifySendResponse(status: number, body: unknown): RelaySendResult {
  const json = (body ?? {}) as { error?: unknown; result?: unknown };
  if (json.error !== undefined) {
    if (isInvalidNonce(json.error)) {
      return { kind: "invalid-nonce", error: "InvalidNonce: another transaction took this nonce first" };
    }
    if (isInvalidTransaction(json.error)) {
      return { kind: "rejected", error: `The node refused the transaction: ${describeInvalidTx(json.error)}` };
    }
    return { kind: "unknown", error: `RPC error (HTTP ${status}): ${describeRpcError(json.error)}` };
  }
  const result = json.result as { transaction_outcome?: unknown } | null | undefined;
  if (result && typeof result === "object" && result.transaction_outcome !== undefined) {
    return { kind: "outcome", outcome: result };
  }
  return { kind: "unknown", error: `HTTP ${status} without an execution outcome` };
}

type RawRpcError = {
  cause?: { name?: unknown };
  data?: { TxExecutionError?: { InvalidTxError?: unknown } };
};

function isInvalidTransaction(error: unknown): boolean {
  return (error as RawRpcError)?.cause?.name === "INVALID_TRANSACTION";
}

function isInvalidNonce(error: unknown): boolean {
  const invalidTx = (error as RawRpcError)?.data?.TxExecutionError?.InvalidTxError;
  return (
    isInvalidTransaction(error) &&
    typeof invalidTx === "object" &&
    invalidTx !== null &&
    "InvalidNonce" in invalidTx
  );
}

/** The InvalidTxError variant, e.g. `Expired` or `{"InvalidAccessKeyError":{"NotEnoughAllowance":…}}`. */
function describeInvalidTx(error: unknown): string {
  const invalidTx = (error as RawRpcError)?.data?.TxExecutionError?.InvalidTxError;
  if (invalidTx === undefined) return "INVALID_TRANSACTION";
  return typeof invalidTx === "string" ? invalidTx : JSON.stringify(invalidTx);
}

function describeRpcError(error: unknown): string {
  const e = error as { name?: unknown; cause?: { name?: unknown }; message?: unknown };
  const parts = [e?.name, e?.cause?.name, e?.message].filter((p) => typeof p === "string");
  return parts.length > 0 ? parts.join(" / ") : JSON.stringify(error);
}

/** The relay's upstreams from the same server-only config the browser proxy uses. */
export function relayUpstreamsFromConfig(config: NearRpcConfig): RelayUpstream[] {
  return config.upstreams.map(({ role, url, headers }) => ({
    role,
    host: new URL(url).host,
    url,
    headers,
    provider: new JsonRpcProvider({ url, headers }),
  }));
}
