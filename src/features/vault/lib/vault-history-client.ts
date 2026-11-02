// FastNEAR transaction API — what the history recorders read the chain with (triage 016, block
// 1b; D-339; 028). Server side and measurement scripts only: since 028-7 the browser reads the
// history route, never FastNEAR (D-010).
//
// Why FastNEAR and not the RPC: no NEAR RPC lists transactions by account, and a relayed
// operation is signed by the relayer and received by the vault or `intents.near`, so the user
// is neither signer nor receiver. FastNEAR also indexes the accounts NAMED IN EVENT LOGS
// (`is_event_log`), and every vault event that matters here carries the user's `account_id`.
// Measured 2026-09-28: 100% of the vault transactions whose events name the user were listed
// (NEAR, EVM and hex identities). NearBlocks and the Meta Pool RPC (non-archival, ~2 days) did
// not serve — see D-339.
//
// Attribution: see ATTRIBUTIONS.md #21 (FastNEAR transaction API).
//
// Two endpoints: `/v0/account` (the account's tx hashes, newest first, 200 per page, continued
// with `resume_token`) and `/v0/transactions` (full outcomes, 20 hashes per call).
//
// The service answered ~30% of calls with a 500 ("Internal server error (Clickhouse)") in
// bursts during the measurement, so every call retries. After the retries it THROWS: an empty
// answer here would read as "this portfolio has no history", which is a lie, not a fallback.
//
// It also rate-limits: measured 2026-10-17 (028-4), ~35–40 calls in 15–25 s answer 429 with
// `retry-after: 0`, and the limit lifts in under a minute. A server pass (`waitOutRateLimit`)
// waits a 429 out with a longer backoff than a 500, never past its deadline; without it a call
// does not wait. Either way the last 429 throws
// `FastNearRateLimitError`, which a server pass reads as "come back later", not as a failure.

const FASTNEAR_TX_BASE_URL = "https://tx.main.fastnear.com";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 5;
/** `/v0/transactions` accepts at most 20 hashes per call. */
export const TX_BATCH_SIZE = 20;

/**
 * The receipt fields the history readers use (the service returns many more). The optional ones
 * are read only by the server-side recorder (`history-recorder`), which keys rows by receipt and
 * keeps call arguments; the trimmed test fixtures of the event extractor omit them.
 */
export type FastNearReceipt = {
  execution_outcome: {
    /** The receipt id. */
    id?: string;
    block_height?: number;
    block_timestamp: number;
    outcome: {
      executor_id: string;
      logs: string[];
      status: Record<string, unknown>;
      /** The receipts this one created: how the recorder tells a finished transaction. */
      receipt_ids?: string[];
    };
  };
  receipt?: {
    receipt_id?: string;
    receipt?: {
      Action?: {
        actions?: Array<Record<string, unknown>>;
      };
    };
  };
};

export type FastNearTx = {
  transaction: { hash: string; signer_id: string; receiver_id: string };
  execution_outcome: {
    block_timestamp: number;
    block_height?: number;
    outcome?: { receipt_ids?: string[] };
  };
  receipts: FastNearReceipt[];
};

type AccountTxsResponse = {
  account_txs?: Array<{ transaction_hash?: unknown; tx_block_height?: unknown; tx_block_timestamp?: unknown }>;
  resume_token?: unknown;
};

type TransactionsResponse = { transactions?: unknown };

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type HistoryClientDeps = {
  fetchImpl?: FetchLike;
  /** Injected so tests do not wait out the backoff. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Epoch ms past which no call is started or kept waiting, retries included. For a server
   * function with a hard time limit (the history recorder): without it, one hanging connection
   * costs 5 attempts × 15 s, and a page of transactions several of those.
   */
  deadlineAt?: number;
  /** Retry a 429 with long waits (server passes). Without it a 429 throws at once. */
  waitOutRateLimit?: boolean;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A 4xx or a malformed body: retrying cannot change the answer. */
class FastNearFatalError extends Error {}

/** FastNEAR kept answering 429 until the retries or the deadline ran out. */
export class FastNearRateLimitError extends Error {}

/** Waits after a 429, by attempt: the limit measured lifts within a minute. */
const RATE_LIMIT_WAITS_MS = [2_000, 4_000, 8_000, 16_000];

async function postJson<T>(path: string, body: unknown, deps: HistoryClientDeps): Promise<T> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  let lastError: unknown = null;
  let rateLimited = false;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const wait = rateLimited ? RATE_LIMIT_WAITS_MS[attempt - 1] : Math.min(300 * 2 ** (attempt - 1), 4_000);
      await sleep(deps.deadlineAt === undefined ? wait : Math.max(0, Math.min(wait, deps.deadlineAt - Date.now())));
    }
    const left = deps.deadlineAt === undefined ? REQUEST_TIMEOUT_MS : deps.deadlineAt - Date.now();
    if (left <= 0) {
      if (rateLimited) throw new FastNearRateLimitError(`FastNEAR ${path}: rate-limited until out of time`);
      throw new FastNearFatalError(`FastNEAR ${path}: out of time`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(REQUEST_TIMEOUT_MS, left));
    try {
      const res = await fetchImpl(`${FASTNEAR_TX_BASE_URL}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      rateLimited = res.status === 429;
      if (rateLimited) {
        lastError = new FastNearRateLimitError(`FastNEAR ${path} answered 429`);
        if (!deps.waitOutRateLimit) throw lastError;
        continue;
      }
      if (res.status >= 400 && res.status < 500) {
        throw new FastNearFatalError(`FastNEAR ${path} answered ${res.status}`);
      }
      if (!res.ok) {
        lastError = new Error(`FastNEAR ${path} answered ${res.status}`);
        continue;
      }
      return (await res.json()) as T;
    } catch (e) {
      if (e instanceof FastNearFatalError || e instanceof FastNearRateLimitError) throw e;
      rateLimited = false;
      lastError = e; // network error, timeout, or a 5xx body that is not JSON
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`FastNEAR ${path} failed`);
}

/** One listed transaction, as the account index gives it. */
export type AccountTxRow = {
  hash: string;
  blockHeight: number;
  /** Milliseconds, exact: the index sends nanoseconds as a decimal string. */
  blockTsMs: number;
};

/**
 * One page of the account's transactions, newest first, for a reader that keeps its own place.
 * `resumeToken` continues to the next (older) page, `null` past the last. Measured 2026-10-16:
 * the token is `(block_height << 32) | tx_index` of the page's last row — a position, not an
 * offset, so it stays valid while newer transactions arrive and can be stored to resume later.
 */
export async function fetchAccountTxPage(
  accountId: string,
  resumeToken: string | null,
  deps: HistoryClientDeps = {}
): Promise<{ rows: AccountTxRow[]; resumeToken: string | null }> {
  const body: Record<string, string> = { account_id: accountId };
  if (resumeToken) body.resume_token = resumeToken;
  const res = await postJson<AccountTxsResponse>("/v0/account", body, deps);
  if (!Array.isArray(res.account_txs)) throw new FastNearFatalError("FastNEAR /v0/account: no account_txs");

  const rows: AccountTxRow[] = [];
  const seen = new Set<string>();
  for (const row of res.account_txs) {
    const hash = row.transaction_hash;
    const height = row.tx_block_height;
    const ts = row.tx_block_timestamp;
    if (typeof hash !== "string" || seen.has(hash)) continue;
    // A row without its block cannot be placed: refusing the page is safer than guessing.
    if (typeof height !== "number" || typeof ts !== "string" || !/^\d{1,30}$/.test(ts)) {
      throw new FastNearFatalError("FastNEAR /v0/account: a row without its block");
    }
    seen.add(hash);
    rows.push({ hash, blockHeight: height, blockTsMs: Number(BigInt(ts) / BigInt(1_000_000)) });
  }
  // An empty token would read as "first page" on the next call.
  const next = typeof res.resume_token === "string" && res.resume_token.length > 0 ? res.resume_token : null;
  return { rows, resumeToken: next };
}

/**
 * The newest block FastNEAR has indexed, in ms (`GET /status`, measured 2026-10-16:
 * `{latest_block_height, latest_block_timestamp: "<ns>", lag_seconds, …}`). A transaction in a
 * block at or before it should be listed; one after it may not be yet. Throws when the service
 * does not say.
 */
export async function fetchIndexedHeadMs(deps: HistoryClientDeps = {}): Promise<number> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const left = deps.deadlineAt === undefined ? REQUEST_TIMEOUT_MS : deps.deadlineAt - Date.now();
  if (left <= 0) throw new FastNearFatalError("FastNEAR /status: out of time");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(REQUEST_TIMEOUT_MS, left));
  try {
    const res = await fetchImpl(`${FASTNEAR_TX_BASE_URL}/status`, { signal: controller.signal });
    if (!res.ok) throw new Error(`FastNEAR /status answered ${res.status}`);
    const ts = ((await res.json()) as { latest_block_timestamp?: unknown }).latest_block_timestamp;
    if (typeof ts !== "string" || !/^\d{1,30}$/.test(ts)) throw new Error("FastNEAR /status: no latest_block_timestamp");
    return Number(BigInt(ts) / BigInt(1_000_000));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Batches in flight at once. All of them in parallel is ~7 calls for a busy test account,
 * against a service that already fails in bursts; one at a time is ~2 s per batch.
 */
const BATCH_CONCURRENCY = 3;

/**
 * Full outcomes of the given transactions, in batches. Throws if any batch fails. A hash the
 * service does not know is OMITTED from its answer (checked 2026-09-28), not returned as null;
 * the caller treats a missing hash as "not indexed yet" and asks again on the next load.
 */
export async function fetchTransactions(
  hashes: string[],
  deps: HistoryClientDeps = {}
): Promise<FastNearTx[]> {
  const batches: string[][] = [];
  for (let i = 0; i < hashes.length; i += TX_BATCH_SIZE) batches.push(hashes.slice(i, i + TX_BATCH_SIZE));

  const txs: FastNearTx[] = [];
  for (let i = 0; i < batches.length; i += BATCH_CONCURRENCY) {
    const results = await Promise.all(
      batches
        .slice(i, i + BATCH_CONCURRENCY)
        .map((batch) => postJson<TransactionsResponse>("/v0/transactions", { tx_hashes: batch }, deps))
    );
    for (const res of results) {
      if (!Array.isArray(res.transactions)) {
        throw new FastNearFatalError("FastNEAR /v0/transactions: no transactions");
      }
      for (const tx of res.transactions) if (tx) txs.push(tx as FastNearTx);
    }
  }
  return txs;
}
