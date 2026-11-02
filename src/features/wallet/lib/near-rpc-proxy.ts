// Server-side NEAR RPC proxy behind POST /api/near-rpc (D-173, 014.plan).
//
// Why it exists: the primary RPC (Meta Pool's own node) authenticates with an `X-API-Key`
// header. Anything the browser calls directly is inlined into the bundle, so the key can only
// be attached here, on the server. The browser's read paths (near-view.ts, balance-fetcher.ts,
// ft-metadata.ts) call this route instead of an RPC host.
//
// What it deliberately does NOT carry: near-connect's RPC list. near-connect serializes that
// list into every wallet's sandboxed iframe (origin `null`), and the wallets use it to SEND
// transactions — a relative URL, CORS from `null` and broadcast methods are all things this
// proxy must not serve. The signing popup does not depend on it: it opens from the top window
// after OUR reads (the prelude) finish, and those reads go through here.
//
// Allowlist, not passthrough: the route is public, so it only forwards the read requests the
// app actually makes. Anything else is refused before an upstream is touched.
//
// All the logic lives here and is unit-tested; the route file is only the transport.

/** Response header naming which upstream answered. Lets a failover be SEEN, not just survived. */
export const RPC_UPSTREAM_HEADER = "x-rpc-upstream";

export const DEFAULT_PRIMARY_RPC_URL = "https://rpc.metapool.app";
export const FALLBACK_RPC_URL = "https://free.rpc.fastnear.com";

/**
 * The largest read the app sends is `mt_batch_balance_of` over every registry token: ~4.4 KB
 * for 64 tokens (measured 2026-09-26). 16 KB covers ~230 tokens without inviting bulk use.
 */
export const MAX_BODY_BYTES = 16 * 1024;

/**
 * How long the PRIMARY gets before the fallback is tried.
 *
 * `query` is 1.5s because of the Allocate prelude: two sequential reads run inside the click
 * handler before the wallet popup opens, and Blink only keeps the click's activation for 5s.
 * Worst case with the primary hanging: 2 × (1.5s + ~0.3s FastNEAR) ≈ 3.6s — still inside.
 * `tx` waits for execution (`wait_until: EXECUTED_OPTIMISTIC`), so it gets longer; its only
 * caller (hot-delivery.ts) polls, so a slow answer costs one poll, not a popup.
 */
const PRIMARY_TIMEOUT_MS: Record<AllowedRpcMethod, number> = { query: 1_500, tx: 4_000 };
/** The fallback is the last resort: bounded only to stay under the browser's own 10s abort. */
const FALLBACK_TIMEOUT_MS: Record<AllowedRpcMethod, number> = { query: 8_000, tx: 5_000 };

type AllowedRpcMethod = "query" | "tx";

const ALLOWED_QUERY_REQUEST_TYPES = new Set(["call_function", "view_account"]);
const ALLOWED_FINALITIES = new Set(["optimistic", "near-final", "final"]);
const ALLOWED_WAIT_UNTIL = new Set([
  "NONE",
  "INCLUDED",
  "INCLUDED_FINAL",
  "EXECUTED_OPTIMISTIC",
  "EXECUTED",
  "FINAL",
]);

/**
 * Every contract method the browser reads through `call_function`. A method missing here fails
 * with HTTP 400 — so `viewCall` (near-view.ts) only accepts these names at compile time, and
 * near-rpc-proxy.test.ts scans the raw `method_name:` bodies for the readers that bypass it.
 */
const VIEW_METHODS = [
  // NEP-141 / NEP-245 token reads (balance-fetcher.ts, ft-metadata.ts, withdraw-submit.ts,
  // near-wallet-deposit.ts)
  "ft_balance_of",
  "ft_metadata",
  "storage_balance_of",
  "storage_balance_bounds",
  "mt_balance_of",
  "mt_batch_balance_of",
  // Verifier (intents.near): intents-read-client.ts, near-key-registration.ts
  "current_salt",
  "is_nonce_used",
  "is_valid_salt",
  "has_public_key",
  // IntentFolio vault: vault-read-client.ts
  "get_solver_pubkey",
  "get_pause_state",
  "list_portfolios_for",
  "get_portfolio_balance",
  "get_pool_total",
  "get_portfolio",
  "get_account",
  // IntentFolio vault, views the final contract added (017-9a): vault-read-client.ts
  "get_config",
  "get_portfolio_positions",
  "get_allocate_seal",
  "get_reservoir",
  "get_token_freeze",
  "get_pending_unallocation",
  "get_return",
  // HOT bridge delivery wait: hot-delivery.ts
  "get_withdrawal_hash",
] as const;

export type AllowedViewMethod = (typeof VIEW_METHODS)[number];

export const ALLOWED_VIEW_METHODS: ReadonlySet<string> = new Set(VIEW_METHODS);

export type NearRpcUpstream = {
  role: "primary" | "fallback";
  url: string;
  headers: Record<string, string>;
};

export type NearRpcConfig = { upstreams: NearRpcUpstream[] };

/**
 * Reads the upstream list from server-only env (never `NEXT_PUBLIC_*`).
 *
 * No key ⇒ FastNEAR only. That keeps Preview (mock by design, D-297) and local runs without a
 * key working exactly as before, instead of sending unauthenticated requests to a node that
 * answers 401.
 *
 * The key travels ONLY in the `X-API-Key` header, never in NEAR_RPC_PRIMARY_URL: near-api-js
 * puts the URL in its error messages, and the relay returns those messages to the browser
 * (relay-service.ts). A primary URL that is not a valid https URL drops the primary instead of
 * breaking both routes; its value is not logged, in case someone did put a key in it.
 */
export function readNearRpcConfig(
  env: Record<string, string | undefined> = process.env,
  log: (line: string) => void = (line) => console.warn(line)
): NearRpcConfig {
  const fallback: NearRpcUpstream = { role: "fallback", url: FALLBACK_RPC_URL, headers: {} };
  const apiKey = env.NEAR_RPC_API_KEY?.trim();
  if (!apiKey) return { upstreams: [fallback] };
  // `||`, not `??`: an env key present-but-empty must fall back to the default URL.
  const primaryUrl = env.NEAR_RPC_PRIMARY_URL?.trim() || DEFAULT_PRIMARY_RPC_URL;
  let protocol: string | null = null;
  try {
    protocol = new URL(primaryUrl).protocol;
  } catch {}
  // https only: over plain http the key would travel in the clear.
  if (protocol !== "https:") {
    log("[near-rpc] NEAR_RPC_PRIMARY_URL is not a valid https URL — primary dropped, fallback only");
    return { upstreams: [fallback] };
  }
  return {
    upstreams: [{ role: "primary", url: primaryUrl, headers: { "X-API-Key": apiKey } }, fallback],
  };
}

export type NearRpcProxyResult = {
  status: number;
  /** JSON text, passed through verbatim from the upstream that answered. */
  body: string;
  /** Which upstream answered; `null` when the request was refused or every upstream failed. */
  upstream: NearRpcUpstream["role"] | null;
};

type ValidRequest = { method: AllowedRpcMethod; id: unknown; forward: string };

type Validation = { ok: true; request: ValidRequest } | { ok: false; id: unknown; reason: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** Copies only `fields` that are present, so nothing the validation did not look at is forwarded. */
const pick = (params: Record<string, unknown>, fields: string[]) =>
  Object.fromEntries(fields.filter((f) => f in params).map((f) => [f, params[f]]));

/**
 * Refuses what only another site's page would send through a visitor's browser.
 *
 * `application/json` is not a CORS-safelisted content type, so a cross-origin page must send a
 * preflight first, and this route answers none with CORS headers: the browser blocks the call.
 * Requiring it closes the "simple request" loophole (a `text/plain` POST needs no preflight).
 * `Sec-Fetch-Site` is set by the browser and cannot be forged from page JS; when present it
 * must say `same-origin`. Neither stops a script calling the route directly — that is rate
 * limiting's job (014.plan, "Qué espera").
 */
export function refuseByHeaders(headers: Headers): NearRpcProxyResult | null {
  const contentType = headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    return nearRpcRefusal(415, null, "content-type must be application/json");
  }
  const site = headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return nearRpcRefusal(403, null, "cross-site request");
  return null;
}

export function validateNearRpcRequest(bodyText: string): Validation {
  if (new TextEncoder().encode(bodyText).length > MAX_BODY_BYTES) {
    return { ok: false, id: null, reason: "body too large" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { ok: false, id: null, reason: "body is not JSON" };
  }
  // Batches are refused on purpose: one request per call keeps the allowlist a single check.
  if (!isRecord(parsed)) return { ok: false, id: null, reason: "expected one JSON-RPC object" };
  const { jsonrpc, id, method, params } = parsed;
  if (jsonrpc !== "2.0") return { ok: false, id, reason: "jsonrpc must be \"2.0\"" };
  if (!isRecord(params)) return { ok: false, id, reason: "params must be an object" };

  let forwardParams: Record<string, unknown>;
  if (method === "query") {
    const requestType = params.request_type;
    if (typeof requestType !== "string" || !ALLOWED_QUERY_REQUEST_TYPES.has(requestType)) {
      return { ok: false, id, reason: `query request_type not allowed: ${String(requestType)}` };
    }
    if (!isNonEmptyString(params.account_id)) {
      return { ok: false, id, reason: "query needs account_id" };
    }
    if ("finality" in params && !ALLOWED_FINALITIES.has(String(params.finality))) {
      return { ok: false, id, reason: `finality not allowed: ${String(params.finality)}` };
    }
    if ("block_id" in params && typeof params.block_id !== "string" && typeof params.block_id !== "number") {
      return { ok: false, id, reason: "block_id must be a hash or a height" };
    }
    const fields = ["request_type", "account_id", "finality", "block_id"];
    if (requestType === "call_function") {
      const methodName = params.method_name;
      if (typeof methodName !== "string" || !ALLOWED_VIEW_METHODS.has(methodName)) {
        return { ok: false, id, reason: `view method not allowed: ${String(methodName)}` };
      }
      if (typeof params.args_base64 !== "string") {
        return { ok: false, id, reason: "call_function needs args_base64" };
      }
      fields.push("method_name", "args_base64");
    }
    forwardParams = pick(params, fields);
  } else if (method === "tx") {
    if (!isNonEmptyString(params.tx_hash) || !isNonEmptyString(params.sender_account_id)) {
      return { ok: false, id, reason: "tx needs tx_hash and sender_account_id" };
    }
    if ("wait_until" in params && !ALLOWED_WAIT_UNTIL.has(String(params.wait_until))) {
      return { ok: false, id, reason: `wait_until not allowed: ${String(params.wait_until)}` };
    }
    forwardParams = pick(params, ["tx_hash", "sender_account_id", "wait_until"]);
  } else {
    return { ok: false, id, reason: `method not allowed: ${String(method)}` };
  }

  // Rebuilt, not re-serialized: only the fields checked above reach the upstream.
  const forward = JSON.stringify({ jsonrpc, id, method, params: forwardParams });
  return { ok: true, request: { method, id, forward } };
}

/** A JSON-RPC-shaped refusal, so callers that parse `error` still get something readable. */
export function nearRpcRefusal(status: number, id: unknown, message: string): NearRpcProxyResult {
  return {
    status,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: id ?? null,
      error: { code: -32600, name: "REQUEST_VALIDATION_ERROR", message },
    }),
    upstream: null,
  };
}

type Attempt =
  | { ok: true; status: number; body: string }
  | { ok: false; reason: string; status?: number; body?: string };

/**
 * JSON-RPC errors that mean "this node cannot answer right now", not "the answer is no".
 * nearcore sends them with HTTP 200, in `error.cause.name` or `error.name`.
 */
const SICK_NODE_ERRORS = new Set([
  "NO_SYNCED_BLOCKS",
  "UNAVAILABLE_SHARD",
  "NOT_SYNCED_YET",
  "INTERNAL_ERROR",
  "TIMEOUT_ERROR",
]);

function sickNodeError(envelope: Record<string, unknown>): string | null {
  const { error } = envelope;
  if (!isRecord(error)) return null;
  const causeName = isRecord(error.cause) ? error.cause.name : undefined;
  for (const name of [causeName, error.name]) {
    if (typeof name === "string" && SICK_NODE_ERRORS.has(name)) return name;
  }
  return null;
}

/**
 * One upstream call. `ok` means "this upstream ANSWERED": HTTP 200 with a JSON-RPC envelope
 * carrying `result` or `error`.
 *
 * A JSON-RPC `error` is an answer, not a failure, and must NOT trigger the fallback:
 * `accountExists` (near-view.ts) turns UNKNOWN_ACCOUNT into a definite `false`, and asking a
 * second node would only add latency to a question already answered. The exception is a
 * sick-node error (SICK_NODE_ERRORS): another node may well answer. Transport errors,
 * timeouts and non-200 statuses (401/403 from a revoked key, 429, 5xx) are failures.
 */
async function callUpstream(
  upstream: NearRpcUpstream,
  request: ValidRequest,
  timeoutMs: number,
  fetchImpl: typeof fetch
): Promise<Attempt> {
  let res: Response;
  try {
    res = await fetchImpl(upstream.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...upstream.headers },
      body: request.forward,
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return { ok: false, reason: timedOut ? `timeout after ${timeoutMs}ms` : "network error" };
  }
  let body: string;
  try {
    body = await res.text();
  } catch {
    return { ok: false, reason: "body read failed", status: res.status };
  }
  if (res.status !== 200) return { ok: false, reason: `http ${res.status}`, status: res.status, body };
  let envelope: unknown;
  try {
    envelope = JSON.parse(body);
  } catch {
    return { ok: false, reason: "answer is not JSON", status: res.status, body };
  }
  if (!isRecord(envelope) || !("result" in envelope || "error" in envelope)) {
    return { ok: false, reason: "answer is not a JSON-RPC envelope", status: res.status, body };
  }
  const sick = sickNodeError(envelope);
  if (sick) return { ok: false, reason: `node error ${sick}`, status: res.status, body };
  return { ok: true, status: res.status, body };
}

/** How often the primary's head is read, at most, per server instance (D-331). */
export const HEAD_CHECK_INTERVAL_MS = 30_000;
/**
 * How far behind the clock the primary's `final` head may be before it is skipped. Measured
 * 2026-10-18: ~3s on both the primary and FastNEAR, so a minute is a frozen node, not a slow one.
 */
export const MAX_HEAD_LAG_MS = 60_000;
const HEAD_CHECK_TIMEOUT_MS = 1_500;
const HEAD_REQUEST = JSON.stringify({ jsonrpc: "2.0", id: "head", method: "block", params: { finality: "final" } });

/**
 * Whether the primary's head is frozen (D-331). A node that stops advancing can keep answering
 * `finality: final` with old state, and `callUpstream` takes that as healthy: stale balances,
 * and a credit poll that ends in `pending-unconfirmed`. Not a money path (the chain refuses a
 * signature over stale caps), but only a head check can see it.
 *
 * Module state, so one per server instance. The check never sits in front of a request: the
 * request reads the last verdict and, when it is older than the interval, starts the next one
 * in the background — the Allocate prelude has no latency to spare (PRIMARY_TIMEOUT_MS). A
 * failed or unreadable check changes nothing: a primary that does not answer is already
 * handled by the failover.
 *
 * Compared against the server clock rather than against the fallback's head: no extra
 * FastNEAR call, and the fallback lagging too would hide the primary's lag.
 */
export type PrimaryHeadWatch = {
  lagging: boolean;
  /** When the last check started; null before the first. */
  checkedAt: number | null;
  /** The check in flight, exposed so tests can await it. */
  inFlight: Promise<void> | null;
};

export function createPrimaryHeadWatch(): PrimaryHeadWatch {
  return { lagging: false, checkedAt: null, inFlight: null };
}

async function readHeadLagMs(
  upstream: NearRpcUpstream,
  fetchImpl: typeof fetch,
  now: () => number
): Promise<number | null> {
  try {
    const res = await fetchImpl(upstream.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...upstream.headers },
      body: HEAD_REQUEST,
      signal: AbortSignal.timeout(HEAD_CHECK_TIMEOUT_MS),
      cache: "no-store",
    });
    if (res.status !== 200) return null;
    const envelope: unknown = await res.json();
    const header = isRecord(envelope) && isRecord(envelope.result) ? envelope.result.header : undefined;
    const nanos = isRecord(header) ? header.timestamp_nanosec : undefined;
    if (typeof nanos !== "string" || !/^\d+$/.test(nanos)) return null;
    return now() - Number(BigInt(nanos) / BigInt(1_000_000));
  } catch {
    return null;
  }
}

function refreshPrimaryHead(
  watch: PrimaryHeadWatch,
  upstream: NearRpcUpstream,
  fetchImpl: typeof fetch,
  log: (line: string) => void,
  now: () => number
): void {
  const at = now();
  if (watch.inFlight || (watch.checkedAt !== null && at - watch.checkedAt < HEAD_CHECK_INTERVAL_MS)) return;
  watch.checkedAt = at;
  watch.inFlight = readHeadLagMs(upstream, fetchImpl, now).then((lagMs) => {
    watch.inFlight = null;
    if (lagMs === null) return;
    const lagging = lagMs > MAX_HEAD_LAG_MS;
    if (lagging !== watch.lagging) {
      const host = new URL(upstream.url).host;
      log(
        lagging
          ? `[near-rpc] primary ${host} head is ${Math.round(lagMs / 1000)}s behind — skipping it`
          : `[near-rpc] primary ${host} head caught up — using it again`
      );
    }
    watch.lagging = lagging;
  });
}

export type NearRpcProxyDeps = {
  config: NearRpcConfig;
  fetchImpl?: typeof fetch;
  /** Receives one line per upstream failure. Never given headers, so it never sees the key. */
  log?: (line: string) => void;
  /** The primary's head check (D-331). Without one, the primary is never skipped. */
  headWatch?: PrimaryHeadWatch;
  now?: () => number;
};

export async function handleNearRpcRequest(
  bodyText: string,
  { config, fetchImpl = fetch, log = (line) => console.warn(line), headWatch, now = Date.now }: NearRpcProxyDeps
): Promise<NearRpcProxyResult> {
  const validation = validateNearRpcRequest(bodyText);
  if (!validation.ok) {
    const status = validation.reason === "body too large" ? 413 : 400;
    return nearRpcRefusal(status, validation.id, validation.reason);
  }
  const { request } = validation;

  const primary = config.upstreams.find((u) => u.role === "primary");
  if (headWatch && primary) refreshPrimaryHead(headWatch, primary, fetchImpl, log, now);
  // Skipped only while another upstream is left to ask.
  const upstreams =
    headWatch?.lagging && config.upstreams.length > 1
      ? config.upstreams.filter((u) => u.role !== "primary")
      : config.upstreams;

  let last: Attempt | null = null;
  for (const [index, upstream] of upstreams.entries()) {
    const timeoutMs = (upstream.role === "primary" ? PRIMARY_TIMEOUT_MS : FALLBACK_TIMEOUT_MS)[
      request.method
    ];
    const attempt = await callUpstream(upstream, request, timeoutMs, fetchImpl);
    if (attempt.ok) return { status: attempt.status, body: attempt.body, upstream: upstream.role };
    last = attempt;
    const next = upstreams[index + 1];
    // Host only: the URL is safe to log, the headers (the key) never reach this line.
    log(
      `[near-rpc] ${upstream.role} ${new URL(upstream.url).host} failed on ${request.method}: ` +
        `${attempt.reason}${next ? ` — trying ${next.role}` : " — no upstream left"}`
    );
  }

  // Every upstream failed. If the last one did answer with an HTTP error, pass it through so
  // the caller sees the real status; otherwise it is a gateway failure.
  if (last && last.status !== undefined && last.body !== undefined) {
    return { status: last.status, body: last.body, upstream: null };
  }
  return nearRpcRefusal(502, request.id, `no RPC upstream answered (${last?.reason ?? "none configured"})`);
}
