// The real `pg` pool for the ops database. SERVER ONLY, and the ONLY module in the frontend
// that imports `pg` — everything else takes a `Queryable`, which is what keeps the validation
// and the SQL testable without a database.
//
// One pool per server instance, created lazily and kept across invocations: on Vercel a warm
// instance reuses it, and a cold one pays for a single connection. The pool settings — and in
// particular the `statement_timeout` that is deliberately NOT among them — are built and
// explained in `createPoolConfig`.

import { Pool, type PoolConfig } from "pg";
import {
  createPoolConfig,
  readOpsDbConfig,
  type OpsDbConfig,
  type Queryable,
  type TransactionalQueryable,
} from "./ops-records-service";

/**
 * Which route a pool serves. Separate pools, not one shared: the Allocate write is FAIL-CLOSED,
 * and a flood on the public withdrawal-record route must not be able to take the connections
 * an Allocate needs — a connection timeout there cancels the Allocate (ADR-0025 §2).
 */
export type OpsDbSlot = "allocate" | "withdraw" | "trade" | "verdict" | "history" | "history-read";

/** The withdrawal record is best-effort and one INSERT per withdrawal: it needs little. */
const WITHDRAW_MAX_CONNECTIONS = 1;

/**
 * The in-flight trade read (D-471) is one indexed SELECT, and the browser gives up on it after
 * 2 s and goes ahead. Waiting longer here only holds a connection for an answer nobody reads.
 */
const TRADE_MAX_CONNECTIONS = 1;
const TRADE_TIMEOUT_MS = 1_500;

/**
 * The history recorder (plan 028-2) runs one pass at a time per instance and its writes go
 * through one transaction on one lent connection; the second slot is for the few autocommit
 * statements around it (the pace claim, the cursor), so they never queue behind the lend.
 */
const HISTORY_MAX_CONNECTIONS = 2;

/**
 * The Performance read (plan 028-3): two indexed SELECTs per uncached view. Its connection wait is
 * the default 5 s, not the trade read's 1.5 s: the history database sleeps when idle, and the
 * first view after a quiet spell pays for waking it.
 */
const HISTORY_READ_MAX_CONNECTIONS = 1;
const HISTORY_READ_QUERY_TIMEOUT_MS = 3_000;

/** The rescue-verdict read (D-448) is the same shape: one indexed SELECT, fail-open in the browser. */
const READ_ONLY_SLOTS: ReadonlySet<OpsDbSlot> = new Set(["trade", "verdict"]);

function sizeFor(config: OpsDbConfig, slot: OpsDbSlot): OpsDbConfig {
  if (slot === "withdraw") return { ...config, maxConnections: WITHDRAW_MAX_CONNECTIONS };
  if (slot === "history") return { ...config, maxConnections: HISTORY_MAX_CONNECTIONS };
  if (slot === "history-read") {
    return {
      ...config,
      maxConnections: HISTORY_READ_MAX_CONNECTIONS,
      queryTimeoutMs: Math.min(config.queryTimeoutMs, HISTORY_READ_QUERY_TIMEOUT_MS),
    };
  }
  if (READ_ONLY_SLOTS.has(slot)) {
    return {
      ...config,
      maxConnections: TRADE_MAX_CONNECTIONS,
      connectionTimeoutMs: Math.min(config.connectionTimeoutMs, TRADE_TIMEOUT_MS),
      queryTimeoutMs: Math.min(config.queryTimeoutMs, TRADE_TIMEOUT_MS),
    };
  }
  return config;
}

const pools = new Map<OpsDbSlot, { pool: Pool; key: string }>();

/**
 * The process-wide pool for this configuration and slot.
 *
 * Re-created if the connection string changes, which only happens in tests: a serverless
 * instance never sees its environment change under it.
 */
export function getOpsDbPool(config: OpsDbConfig, slot: OpsDbSlot = "allocate"): Queryable {
  const existing = pools.get(slot);
  if (existing && existing.key === config.connectionString) return existing.pool as unknown as Queryable;
  // A stale pool is closed in the background: `end()` waits for in-flight queries and there
  // is nothing useful to do with the result here.
  void existing?.pool.end().catch(() => {});
  const pool = new Pool(createPoolConfig(sizeFor(config, slot)) as PoolConfig);
  // Without a listener, a connection dropped by the pooler surfaces as an unhandled 'error'
  // event and takes the whole Node process down — which, with fail-closed writes, would turn
  // an idle-connection reset into an outage of every Allocate.
  pool.on("error", (e) => console.error(`[ops] idle pool client error (${slot}): ${e.message}`));
  pools.set(slot, { pool, key: config.connectionString });
  return pool as unknown as Queryable;
}

export type OpsDbHandle =
  | { ok: true; db: Queryable }
  | { ok: false; issues: string[] };

/** Reads the environment and hands back a pool, or the reason there is none. */
export function resolveOpsDb(
  env: Record<string, string | undefined> = process.env,
  slot: OpsDbSlot = "allocate"
): OpsDbHandle {
  const config = readOpsDbConfig(env);
  if (!config.ok) return { ok: false, issues: config.issues };
  return { ok: true, db: getOpsDbPool(config.config, slot) };
}

/** The history recorder's credential (`intentfolio_history_writer`, migration 008). Server only. */
export const HISTORY_WRITER_URL_VAR = "INTENTFOLIO_HISTORY_WRITER_DB_URL";

/**
 * The history recorder's pool: its own role, so a bug there cannot reach the rescue or
 * withdrawal tables (008 grants it nothing on them), and its own connections.
 */
export function resolveHistoryWriterDb(
  env: Record<string, string | undefined> = process.env
): { ok: true; db: TransactionalQueryable } | { ok: false; issues: string[] } {
  const config = readOpsDbConfig(env, HISTORY_WRITER_URL_VAR);
  if (!config.ok) return { ok: false, issues: config.issues };
  // The same `pg.Pool`: it has `connect()` as well as `query()`.
  return { ok: true, db: getOpsDbPool(config.config, "history") as unknown as TransactionalQueryable };
}

/** The read routes' credential (`intentfolio_history_reader`, migration 008: SELECT only). Server only. */
export const HISTORY_READER_URL_VAR = "INTENTFOLIO_HISTORY_READER_DB_URL";

/**
 * The read routes' pool: a role that can only SELECT the eight history tables, so a public read
 * cannot write anything, and connections of its own, so a flood of views cannot take the
 * recorder's.
 */
export function resolveHistoryReaderDb(env: Record<string, string | undefined> = process.env): OpsDbHandle {
  const config = readOpsDbConfig(env, HISTORY_READER_URL_VAR);
  if (!config.ok) return { ok: false, issues: config.issues };
  return { ok: true, db: getOpsDbPool(config.config, "history-read") };
}
