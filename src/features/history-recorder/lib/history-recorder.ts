// The history recorder's pass (plan 028-2, D-492; ADR-0026 in the monorepo): reads the vault's
// transactions from FastNEAR and writes them to the ops database (migration 008, the eight
// history tables). Server only. Triggered by the hourly cron (`/api/cron/history`) and, from
// 028-3, after the read routes answer.
//
// THE RULES A CHANGE HERE MUST KEEP (each has a test):
//   1. Idempotent. Every row has a natural key and goes in with `ON CONFLICT DO NOTHING`; the
//      daily sums only add the `vault_event_portfolio` rows that `RETURNING` says were inserted
//      by this very statement, each once. Replaying a transaction — two passes racing, a retry
//      after a timeout, the initial load meeting the live walk — inserts nothing and adds nothing.
//   2. Never a silent hole. `history_cursor.last_ok_at` ("recorded until") is a WATERMARK: the
//      minimum of the newest block FastNEAR had indexed when the walk began and the block time of
//      the oldest transaction this pass could not record (receipts still to come, not served by
//      FastNEAR, refused by the database). The next pass lists back to the watermark minus
//      `LIST_MARGIN_MS`, so a stuck transaction is retried on every pass and named in
//      `last_error` until it goes in — it pins "recorded until", and the screens say "out of
//      date", instead of falling out of the window. The initial load does the same by not
//      advancing past a page that has one. A walk cut short says so (`last_error`, `ok: false`),
//      except when FastNEAR rate-limits it or another writer holds a row it needs (below): the
//      watermark has not moved past anything, so the next pass simply picks it up.
//   3. One transaction per page, one SAVEPOINT per transaction in it. A transaction and its
//      share of the daily sums commit together or not at all; a bad one does not take its
//      page down; a load cut by the time limit keeps every page it finished.
//   4. Paced and single-file. A pass claims `last_run_at` with a conditional UPDATE and sets it
//      in the FUTURE, past the latest moment the pass can still be running: no other pass can
//      start while it lives, even if it is killed, and at most one starts per `PACE_MS` after
//      it ends. Its writes run under `pg_try_advisory_xact_lock` as well. Every FastNEAR call
//      has a hard deadline, so a hanging service cannot push a pass past Vercel's limit.
//      Nothing here loops or reschedules itself — a runaway loop is the one way this could run
//      the Vercel team into its spend cap (Pause On at US$ 500 pauses Production).
//
// Since 009 the per-account pass (`account-recorder.ts`) writes these tables too, WITHOUT this
// pass's advisory lock (009 header, "Concurrency"). Two writers that lock overlapping keys in
// different orders deadlock in normal operation; Postgres aborts one of them, which records
// nothing. So `deadlock_detected`, `serialization_failure` and `lock_not_available` are
// TRANSIENT here: the transaction stays below the watermark and the next pass records it,
// without an error to report.
//
// A transaction that can never be recorded (FastNEAR lost it, or a shape this code does not
// know) pins "recorded until" for good, by design. The way out is a decision, not code: fix the
// reader, or — accepting the gap — insert its `vault_tx` row by hand as the database owner, so
// the walk counts it as recorded.
//
// Attribution: see ATTRIBUTIONS.md #1 (1Click prices), #8 (vault events), #21 (FastNEAR).

import type { Queryable, TransactionalQueryable } from "@/features/vault/lib/ops-records-service";
import {
  FastNearRateLimitError,
  fetchAccountTxPage,
  fetchIndexedHeadMs,
  fetchTransactions,
  type AccountTxRow,
  type FastNearTx,
} from "@/features/vault/lib/vault-history-client";
import { extractTx, type ExtractedTx } from "./history-extract";
import { fetchPriceBook, type PriceBook } from "./history-prices";

/** At most one pass starts per this after the previous one ended, across every instance. */
export const PACE_MS = 60_000;
/**
 * How far behind the watermark a pass lists again. Not for late receipts — a transaction is
 * recorded only once every receipt is in (`countMissingReceipts`) — but for FastNEAR's account
 * index listing a transaction a little after newer ones.
 */
export const LIST_MARGIN_MS = 60 * 60 * 1000;
/** A transaction still incomplete after this is not normal any more: it goes in `last_error`. */
export const STUCK_REPORT_MS = 10 * 60 * 1000;
/** A swap valued more than this after it happened is marked `usd_from_backfill`. */
export const LATE_VALUATION_MS = 24 * 60 * 60 * 1000;
/** The cron's budget for starting pages. The route's `maxDuration` is 300 s. */
export const DEFAULT_BUDGET_MS = 200_000;
/** Past budget + this, every FastNEAR call gives up (one call alone can take ~80 s). */
export const FASTNEAR_GRACE_MS = 45_000;
/** Past budget + this, a page fetched late is not written: its BEGIN would run too close to the limit. */
export const WRITE_GRACE_MS = 60_000;
/** How long past its budget a pass holds `last_run_at`: beyond everything above. */
export const HOLD_GRACE_MS = 90_000;

const ERROR_MAX_CHARS = 2_048;

export type FastNearSource = {
  /** The newest block FastNEAR has indexed, in ms. */
  indexedHeadMs(): Promise<number>;
  listPage(accountId: string, resumeToken: string | null): Promise<{ rows: AccountTxRow[]; resumeToken: string | null }>;
  fetchTxs(hashes: string[]): Promise<FastNearTx[]>;
};

/** The real service, with every call bounded by `deadlineAt`. */
function liveFastNear(deadlineAt: number): FastNearSource {
  const deps = { deadlineAt, waitOutRateLimit: true };
  return {
    indexedHeadMs: () => fetchIndexedHeadMs(deps),
    listPage: (accountId, resumeToken) => fetchAccountTxPage(accountId, resumeToken, deps),
    fetchTxs: (hashes) => fetchTransactions(hashes, deps),
  };
}

export type RecorderDeps = {
  db: TransactionalQueryable;
  vaultId: string;
  fastnear?: FastNearSource;
  /** Today's prices, or a rejection when 1Click cannot answer (the pass goes on without). */
  prices?: () => Promise<PriceBook>;
  now?: () => number;
  /** Past this, no new page is started. */
  budgetMs?: number;
};

export type StuckTx = {
  hash: string;
  blockTsMs: number;
  reason: string;
  /** Lost a lock to another writer: retried next pass, not reported. */
  transient?: boolean;
};

export type PassResult =
  | { ran: false; reason: "paced" }
  | {
      ran: true;
      /** False when anything went into `last_error` (see `error`). */
      ok: boolean;
      /** Transactions and events this pass inserted (a replay inserts none). */
      recordedTxs: number;
      recordedEvents: number;
      /** Transactions this pass met and could not record (retried next pass). */
      stuck: StuckTx[];
      /** Call arguments of recorded transactions that could not be kept, with why. */
      droppedCalls: string[];
      /** Accounts named by the events this pass inserted: the cron brings them up to date next. */
      accounts: string[];
      /** The live walk reached the watermark (so "recorded until" moved). */
      liveComplete: boolean;
      backfillDone: boolean;
      /** Why the pass stopped early, when it did. */
      stoppedBy: StopReason | null;
      pages: number;
      ms: number;
      error?: string;
    };

type CursorRow = {
  last_run_at: Date;
  last_ok_at: Date | null;
  backfill_done: boolean;
  backfill_resume: string | null;
};

export type StopReason = "budget" | "busy" | "rate-limited";

/**
 * The pass stops here, without it being a failure of the code: out of time, the lock is taken,
 * or FastNEAR asks to come back later.
 */
class Stop extends Error {
  constructor(readonly why: StopReason) {
    super(why);
  }
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function clip(text: string): string {
  return text.length <= ERROR_MAX_CHARS ? text : `${text.slice(0, ERROR_MAX_CHARS - 1)}…`;
}

/** An error's message, with Postgres's SQLSTATE in front when there is one. */
export function messageOf(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const code = (e as Error & { code?: unknown }).code;
  return typeof code === "string" ? `${code}: ${e.message}` : e.message;
}

/**
 * Postgres refused the DATA (classes 22 data exception, 23 integrity, 54 limits): retrying the
 * same row cannot succeed. Anything else — a timeout, a cancel, a lost connection — might.
 */
export function isDataRefusal(e: unknown): boolean {
  const code = e instanceof Error ? (e as Error & { code?: unknown }).code : undefined;
  return typeof code === "string" && /^(22|23|54)/.test(code);
}

/**
 * How long a row another writer holds is waited for, then 55P03 (transient). Below the pool's
 * client-side `query_timeout` (5 s by default, `ops-records-service.ts`), never equal: at 5 s
 * both fired together and a held row came back as "Query read timeout" — a lasting error — as
 * often as the transient conflict it is (s303, measured on the account pass's test).
 */
export const LOCK_TIMEOUT = "4s";

/** Lost to another writer (009 header): the same row will go in on the next pass. */
const TRANSIENT_CODES: ReadonlySet<string> = new Set(["40P01", "40001", "55P03"]);

export function isTransientConflict(e: unknown): boolean {
  const code = e instanceof Error ? (e as Error & { code?: unknown }).code : undefined;
  return typeof code === "string" && TRANSIENT_CODES.has(code);
}

// ── Writing one transaction ──────────────────────────────────────────────────────────────

export type FinishedTx = Extract<ExtractedTx, { complete: true }>;
type RowRef = {
  e: Pick<FinishedTx["events"][number], "receiptId" | "logIndex" | "blockTsMs">;
  p: FinishedTx["events"][number]["portfolios"][number];
};
type DailyDelta = { portfolioId: string; day: string; token: string; swaps: number; spread: bigint; late: boolean };

/**
 * Writes one finished transaction inside the caller's SAVEPOINT. Returns what it inserted. The
 * parent rows go first (008's foreign keys); the daily sums take only what the
 * `vault_event_portfolio` INSERT returned as new.
 */
export async function writeTx(
  db: Queryable,
  vaultId: string,
  x: FinishedTx,
  ctx: { prices: PriceBook | null; nowMs: number; dropped: string[] }
): Promise<{ tx: number; events: number }> {
  const tx = await db.query(
    `INSERT INTO vault_tx (vault_id, tx_hash, block_height, block_ts)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (vault_id, tx_hash) DO NOTHING`,
    [vaultId, x.tx.txHash, x.tx.blockHeight, new Date(x.tx.blockTsMs)]
  );

  // The arguments are optional data and written by a user: arguments Postgres refuses AS DATA
  // are dropped, not allowed to hold the whole transaction back. Any other failure (a timeout)
  // is thrown: the transaction is then retried whole, because once recorded it is never read
  // again and the arguments would be lost for good.
  for (const call of x.calls) {
    await db.query("SAVEPOINT history_call");
    try {
      await db.query(
        `INSERT INTO vault_call (vault_id, receipt_id, action_index, tx_hash, block_height, block_ts, method, args)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         ON CONFLICT (vault_id, receipt_id, action_index) DO NOTHING`,
        [vaultId, call.receiptId, call.actionIndex, x.tx.txHash, call.blockHeight, new Date(call.blockTsMs), call.method, call.argsText]
      );
      await db.query("RELEASE SAVEPOINT history_call");
    } catch (e) {
      if (!isDataRefusal(e)) throw e;
      await db.query("ROLLBACK TO SAVEPOINT history_call");
      ctx.dropped.push(`${x.tx.txHash} ${call.method}: ${messageOf(e)}`);
    }
  }
  for (const d of x.droppedCalls) ctx.dropped.push(`${x.tx.txHash} action ${d.actionIndex}: ${d.reason}`);

  if (x.events.length === 0) return { tx: tx.rowCount ?? 0, events: 0 };
  const ev = x.events;
  const events = await db.query(
    `INSERT INTO vault_event
       (vault_id, receipt_id, log_index, tx_hash, block_height, block_ts, event, version, account_id, raw)
     SELECT $1, r, l, $2, h, ts, e, v, a, raw::jsonb
       FROM unnest($3::text[], $4::smallint[], $5::bigint[], $6::timestamptz[],
                   $7::text[], $8::text[], $9::text[], $10::text[]) AS u(r, l, h, ts, e, v, a, raw)
     ON CONFLICT (vault_id, receipt_id, log_index) DO NOTHING`,
    [
      vaultId,
      x.tx.txHash,
      ev.map((e) => e.receiptId),
      ev.map((e) => e.logIndex),
      ev.map((e) => e.blockHeight),
      ev.map((e) => new Date(e.blockTsMs)),
      ev.map((e) => e.event),
      ev.map((e) => e.version),
      ev.map((e) => e.accountId),
      ev.map((e) => e.rawText),
    ]
  );

  const rows: RowRef[] = ev.flatMap((e) => e.portfolios.map((p) => ({ e, p })));
  if (rows.length > 0) {
    const inserted = await db.query<{ receipt_id: string; log_index: number; ord: number }>(
      `INSERT INTO vault_event_portfolio
         (vault_id, receipt_id, log_index, ord, portfolio_id, block_ts, qty_in, qty_out, spread)
       SELECT $1, r, l, o, p, ts, qi::numeric, qo::numeric, sp::numeric
         FROM unnest($2::text[], $3::smallint[], $4::smallint[], $5::text[], $6::timestamptz[],
                     $7::text[], $8::text[], $9::text[]) AS u(r, l, o, p, ts, qi, qo, sp)
       ON CONFLICT (vault_id, receipt_id, log_index, ord) DO NOTHING
       RETURNING receipt_id, log_index, ord`,
      [
        vaultId,
        rows.map(({ e }) => e.receiptId),
        rows.map(({ e }) => e.logIndex),
        rows.map(({ p }) => p.ord),
        rows.map(({ p }) => p.portfolioId),
        rows.map(({ e }) => new Date(e.blockTsMs)),
        rows.map(({ p }) => p.qtyIn),
        rows.map(({ p }) => p.qtyOut),
        rows.map(({ p }) => p.spread),
      ]
    );
    await addToDaily(db, vaultId, swapsToAdd(rows, inserted.rows), ctx);
  }

  const owners = ev.filter((e) => e.owner !== null);
  if (owners.length > 0) {
    await db.query(
      `INSERT INTO portfolio_owner (vault_id, portfolio_id, account_id, receipt_id, log_index, block_ts)
       SELECT $1, p, a, r, l, ts
         FROM unnest($2::text[], $3::text[], $4::text[], $5::smallint[], $6::timestamptz[]) AS u(p, a, r, l, ts)
       ON CONFLICT (vault_id, portfolio_id) DO NOTHING`,
      [
        vaultId,
        owners.map((e) => e.owner!.portfolioId),
        owners.map((e) => e.owner!.accountId),
        owners.map((e) => e.receiptId),
        owners.map((e) => e.logIndex),
        owners.map((e) => new Date(e.blockTsMs)),
      ]
    );
  }
  return { tx: tx.rowCount ?? 0, events: events.rowCount ?? 0 };
}

/**
 * The rebalance rows to add to the daily sums: one per key the INSERT RETURNED, looked up in
 * the rows sent. A row sent twice (the same receipt served twice) is added once, because the
 * table returned it once; a row that was already there is not added at all.
 */
export function swapsToAdd<R extends RowRef>(
  rows: R[],
  returned: Array<{ receipt_id: string; log_index: number; ord: number }>
): R[] {
  const byKey = new Map(rows.map((r) => [`${r.e.receiptId}|${r.e.logIndex}|${r.p.ord}`, r]));
  return returned
    .map((k) => byKey.get(`${k.receipt_id}|${k.log_index}|${k.ord}`))
    .filter((r): r is R => r !== undefined && r.p.swapToken !== null);
}

/**
 * Adds newly inserted rebalance rows into `portfolio_daily`: one swap each, and the spread,
 * valued at the price of NOW (decision 5) — or kept as `spread_unpriced` when there is none.
 */
async function addToDaily(
  db: Queryable,
  vaultId: string,
  rows: RowRef[],
  ctx: { prices: PriceBook | null; nowMs: number }
): Promise<void> {
  if (rows.length === 0) return;
  const deltas = new Map<string, DailyDelta>();
  for (const { e, p } of rows) {
    const day = utcDay(e.blockTsMs);
    const token = p.swapToken!;
    const key = `${p.portfolioId}|${day}|${token}`;
    const d = deltas.get(key) ?? { portfolioId: p.portfolioId, day, token, swaps: 0, spread: BigInt(0), late: false };
    d.swaps += 1;
    d.spread += BigInt(p.spread ?? "0");
    d.late ||= ctx.nowMs - e.blockTsMs > LATE_VALUATION_MS;
    deltas.set(key, d);
  }
  const list = [...deltas.values()];
  const quote = (token: string) => ctx.prices?.get(token) ?? null;
  await db.query(
    `INSERT INTO portfolio_daily
       (vault_id, portfolio_id, day, token_id, swaps, spread, spread_usd, spread_unpriced, usd_from_backfill)
     SELECT $1, p, d::date, t, s, sp::numeric,
            CASE WHEN pr IS NULL THEN 0 ELSE round(sp::numeric * pr::numeric / power(10::numeric, dec), 12) END,
            CASE WHEN pr IS NULL THEN sp::numeric ELSE 0 END,
            late
       FROM unnest($2::text[], $3::text[], $4::text[], $5::int[], $6::text[], $7::text[], $8::int[], $9::bool[])
            AS u(p, d, t, s, sp, pr, dec, late)
     ON CONFLICT (vault_id, portfolio_id, day, token_id) DO UPDATE SET
       swaps             = portfolio_daily.swaps + EXCLUDED.swaps,
       spread            = portfolio_daily.spread + EXCLUDED.spread,
       spread_usd        = portfolio_daily.spread_usd + EXCLUDED.spread_usd,
       spread_unpriced   = portfolio_daily.spread_unpriced + EXCLUDED.spread_unpriced,
       usd_from_backfill = portfolio_daily.usd_from_backfill OR EXCLUDED.usd_from_backfill`,
    [
      vaultId,
      list.map((d) => d.portfolioId),
      list.map((d) => d.day),
      list.map((d) => d.token),
      list.map((d) => d.swaps),
      list.map((d) => d.spread.toString()),
      // A zero spread needs no price: it is worth $0 whatever the token costs.
      list.map((d) => (d.spread === BigInt(0) ? "0" : quote(d.token)?.priceText ?? null)),
      list.map((d) => quote(d.token)?.decimals ?? 0),
      list.map((d) => d.late),
    ]
  );
}

// ── One page ─────────────────────────────────────────────────────────────────────────────

type PageOutcome = {
  recordedTxs: number;
  recordedEvents: number;
  stuck: StuckTx[];
  dropped: string[];
  accounts: Set<string>;
};

/**
 * Records every transaction of a listed page that is not recorded yet, in one database
 * transaction. Transactions already in `vault_tx` are not fetched again: one goes in only once
 * it is finished, so there is nothing left to add to it.
 */
async function recordPage(
  rows: AccountTxRow[],
  deps: { db: TransactionalQueryable; vaultId: string; fastnear: FastNearSource },
  ctx: { prices: PriceBook | null; nowMs: number; canWrite: () => boolean }
): Promise<PageOutcome> {
  const { db, vaultId } = deps;
  const out: PageOutcome = { recordedTxs: 0, recordedEvents: 0, stuck: [], dropped: [], accounts: new Set() };
  if (rows.length === 0) return out;

  const known = await db.query<{ tx_hash: string }>(
    "SELECT tx_hash FROM vault_tx WHERE vault_id = $1 AND tx_hash = ANY($2::text[])",
    [vaultId, rows.map((r) => r.hash)]
  );
  const recorded = new Set(known.rows.map((r) => r.tx_hash));
  const todo = rows.filter((r) => !recorded.has(r.hash));
  if (todo.length === 0) return out;

  const fetched = new Map((await deps.fastnear.fetchTxs(todo.map((r) => r.hash))).map((t) => [t?.transaction?.hash, t]));
  const ready: Array<{ row: AccountTxRow; x: FinishedTx }> = [];
  for (const row of todo) {
    const tx = fetched.get(row.hash);
    if (!tx) {
      out.stuck.push({ hash: row.hash, blockTsMs: row.blockTsMs, reason: "listed but not served by FastNEAR" });
      continue;
    }
    try {
      const x = extractTx(tx, vaultId);
      if (x.complete) ready.push({ row, x });
      else out.stuck.push({ hash: row.hash, blockTsMs: row.blockTsMs, reason: `${x.missingReceipts} receipt(s) still to come` });
    } catch (e) {
      // Whatever the cause — a shape this code does not know, or a bug in it — only this
      // transaction is held back; the rest of the page goes in.
      out.stuck.push({ hash: row.hash, blockTsMs: row.blockTsMs, reason: `cannot read it: ${messageOf(e)}` });
    }
  }
  if (ready.length === 0) return out;
  if (!ctx.canWrite()) throw new Stop("budget");

  const client = await db.connect();
  let broken: Error | undefined;
  try {
    // 009's concurrency rules assume READ COMMITTED: said here, not left to a server default.
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    // Server-side bounds, the only form a transaction-mode pooler passes through (see
    // `createPoolConfig`): a statement stuck on the server dies with the transaction, and so
    // does a transaction whose function was killed without its socket closing — which would
    // otherwise keep the advisory lock and stop every later pass.
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '60s'");
    // A row another writer holds is waited for this long at most, then 55P03 (transient).
    await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
    const lock = await client.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok",
      [`intentfolio-history:${vaultId}`]
    );
    if (!lock.rows[0]?.ok) throw new Stop("busy");

    let lost = false;
    for (const { row, x } of ready) {
      // After a lock lost to another writer, the rest of the page waits for the next pass: each
      // try could wait out `lock_timeout` again on a row this transaction now holds.
      if (lost) {
        out.stuck.push({ hash: row.hash, blockTsMs: row.blockTsMs, reason: "after a lost lock in its page", transient: true });
        continue;
      }
      await client.query("SAVEPOINT history_tx");
      try {
        const wrote = await writeTx(client, vaultId, x, { ...ctx, dropped: out.dropped });
        await client.query("RELEASE SAVEPOINT history_tx");
        out.recordedTxs += wrote.tx;
        // New to the database: whoever its events name moved since their account was last read.
        if (wrote.tx > 0) for (const e of x.events) if (e.accountId) out.accounts.add(e.accountId);
        out.recordedEvents += wrote.events;
      } catch (e) {
        // If the connection itself is gone this throws too, and the page fails as a whole.
        await client.query("ROLLBACK TO SAVEPOINT history_tx");
        lost = isTransientConflict(e);
        out.stuck.push(
          lost
            ? { hash: row.hash, blockTsMs: row.blockTsMs, reason: `lost a lock: ${messageOf(e)}`, transient: true }
            : { hash: row.hash, blockTsMs: row.blockTsMs, reason: `refused by the database: ${messageOf(e)}` }
        );
      }
    }
    await client.query("COMMIT");
    return out;
  } catch (e) {
    if (!(e instanceof Stop)) broken = e instanceof Error ? e : new Error(String(e));
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    // A connection whose transaction state is unknown is not handed back to the pool.
    client.release(broken);
  }
}

/** A page whose token does not move the walk on would be read again and again until the budget ends. */
export function assertAdvances(page: { rows: AccountTxRow[]; resumeToken: string | null }, previous: string | null): void {
  if (page.resumeToken !== null && (page.rows.length === 0 || page.resumeToken === previous)) {
    throw new Error("FastNEAR returned a page that does not advance");
  }
}

// ── The pass ─────────────────────────────────────────────────────────────────────────────

/**
 * One pass: claim the pace, store today's prices if they are missing, walk the newest
 * transactions back to the watermark, then continue the initial load while the budget lasts.
 * Never throws; a failure is reported in the result and in `history_cursor.last_error`.
 */
export async function runHistoryPass(deps: RecorderDeps): Promise<PassResult> {
  const { db, vaultId } = deps;
  const now = deps.now ?? Date.now;
  const budgetMs = deps.budgetMs ?? DEFAULT_BUDGET_MS;
  const startedAt = now();
  const fastnear = deps.fastnear ?? liveFastNear(Date.now() + budgetMs + FASTNEAR_GRACE_MS);
  const overBudget = () => now() - startedAt > budgetMs;
  const canWrite = () => now() - startedAt <= budgetMs + WRITE_GRACE_MS;

  const result: Extract<PassResult, { ran: true }> = {
    ran: true,
    ok: true,
    recordedTxs: 0,
    recordedEvents: 0,
    stuck: [],
    droppedCalls: [],
    accounts: [],
    liveComplete: false,
    backfillDone: false,
    stoppedBy: null,
    pages: 0,
    ms: 0,
  };
  const issues: string[] = [];
  const tally = (page: PageOutcome) => {
    result.recordedTxs += page.recordedTxs;
    for (const a of page.accounts) if (!result.accounts.includes(a)) result.accounts.push(a);
    result.recordedEvents += page.recordedEvents;
    result.stuck.push(...page.stuck);
    result.droppedCalls.push(...page.dropped);
    result.pages += 1;
  };

  let hold: Date | null = null;
  // A pass FastNEAR cut short saw less than a clean one: it must not clear the last error.
  let cutByFastNear = false;
  try {
    await db.query("INSERT INTO history_cursor (vault_id) VALUES ($1) ON CONFLICT (vault_id) DO NOTHING", [vaultId]);
    const claim = await db.query<CursorRow>(
      `UPDATE history_cursor
          SET last_run_at = date_trunc('milliseconds', now() + make_interval(secs => $3))
        WHERE vault_id = $1
          AND (last_run_at IS NULL OR last_run_at <= now() - make_interval(secs => $2))
        RETURNING last_run_at, last_ok_at, backfill_done, backfill_resume`,
      [vaultId, PACE_MS / 1000, (budgetMs + HOLD_GRACE_MS) / 1000]
    );
    if (!claim.rowCount) return { ran: false, reason: "paced" };
    const cursor = claim.rows[0];
    hold = cursor.last_run_at;
    result.backfillDone = cursor.backfill_done;

    const prices = await loadPrices(db, deps.prices ?? (() => fetchPriceBook()), startedAt);
    const ctx = { prices, nowMs: startedAt, canWrite };

    // ── Live: newest first, back to the watermark ──
    const firstPass = !cursor.backfill_done && cursor.backfill_resume === null;
    const floorMs = cursor.last_ok_at ? cursor.last_ok_at.getTime() - LIST_MARGIN_MS : null;
    // Asked BEFORE the listing: a transaction in a block up to here should be in it.
    const headMs = await fastnear.indexedHeadMs().catch((e: unknown) => {
      console.warn(`[history] no indexed head: ${messageOf(e)}`);
      return null;
    });
    let token: string | null = null;
    let newestListedMs: number | null = null;
    let liveStuck: StuckTx[] = [];
    for (;;) {
      if (result.pages > 0 && overBudget()) throw new Stop("budget");
      const page = await fastnear.listPage(vaultId, token);
      assertAdvances(page, token);
      if (newestListedMs === null && page.rows.length > 0) newestListedMs = Math.max(...page.rows.map((r) => r.blockTsMs));
      const outcome = await recordPage(page.rows, { db, vaultId, fastnear }, ctx);
      tally(outcome);
      liveStuck = liveStuck.concat(outcome.stuck);
      token = page.resumeToken;
      // The first pass ever takes page 1 only; everything older is the initial load's.
      if (firstPass || token === null) break;
      if (floorMs !== null && Math.min(...page.rows.map((r) => r.blockTsMs)) < floorMs) break;
    }
    result.liveComplete = true;

    // Without the indexed head, the newest listed transaction: never claims more than was seen.
    const seenUpTo = headMs ?? newestListedMs;
    const watermark = seenUpTo === null ? null : Math.min(seenUpTo, ...liveStuck.map((s) => s.blockTsMs));
    const reportable = liveStuck.filter((s) => !s.transient && startedAt - s.blockTsMs > STUCK_REPORT_MS);
    if (reportable.length > 0) issues.push(describeStuck(reportable));
    if (firstPass && token === null) result.backfillDone = true; // the whole history was one page
    await db.query(
      `UPDATE history_cursor
          SET last_ok_at      = COALESCE($2, last_ok_at),
              backfill_resume = CASE WHEN $3::text IS NULL THEN backfill_resume ELSE $3 END,
              backfill_done   = backfill_done OR $4
        WHERE vault_id = $1`,
      [vaultId, watermark === null ? null : new Date(watermark), firstPass ? token : null, result.backfillDone]
    );

    // ── The initial load: older pages, resumable, while the budget lasts ──
    let loadToken: string | null = firstPass ? token : cursor.backfill_resume;
    while (!result.backfillDone && loadToken !== null) {
      if (overBudget()) throw new Stop("budget");
      const page = await fastnear.listPage(vaultId, loadToken);
      assertAdvances(page, loadToken);
      const outcome = await recordPage(page.rows, { db, vaultId, fastnear }, ctx);
      tally(outcome);
      if (outcome.stuck.length > 0) {
        // Not past it: the next pass lists this page again and retries.
        const lasting = outcome.stuck.filter((s) => !s.transient);
        if (lasting.length > 0) issues.push(`initial load held at a page: ${describeStuck(lasting)}`);
        break;
      }
      loadToken = page.resumeToken;
      result.backfillDone = loadToken === null;
      await db.query(
        `UPDATE history_cursor
            SET backfill_resume = CASE WHEN $2::text IS NULL THEN backfill_resume ELSE $2 END,
                backfill_done   = backfill_done OR $3
          WHERE vault_id = $1`,
        [vaultId, loadToken, result.backfillDone]
      );
    }
  } catch (e) {
    if (e instanceof FastNearRateLimitError) {
      result.stoppedBy = "rate-limited";
      cutByFastNear = true;
      console.warn(`[history] FastNEAR rate limit after ${result.pages} page(s): ${e.message}`);
    } else if (e instanceof Stop) {
      result.stoppedBy = e.why;
      issues.push(
        e.why === "busy"
          ? "the write lock is held by another session"
          : `stopped by the time budget after ${result.pages} page(s), ` +
              (result.liveComplete ? "in the initial load" : "before reaching 'recorded until'")
      );
    } else {
      issues.push(messageOf(e));
    }
  }
  if (result.droppedCalls.length > 0) {
    issues.push(`${result.droppedCalls.length} call argument(s) not kept: ${result.droppedCalls.join("; ")}`);
  }

  if (hold !== null) {
    // A clean pass clears the last error: every way of not looking at something (out of time,
    // a held load, a lock) is itself an issue, so "clean" means it saw everything. The two
    // that are not issues — FastNEAR's rate limit, a row lost to another writer — are not
    // "everything" either: they leave the last error as it was.
    const error = issues.length > 0 ? clip(issues.join(" · ")) : null;
    if (error !== null || (!cutByFastNear && !result.stuck.some((s) => s.transient))) {
      await db
        .query(
          `UPDATE history_cursor
              SET last_error    = $2,
                  last_error_at = CASE WHEN $2::text IS NOT NULL THEN now() ELSE last_error_at END
            WHERE vault_id = $1`,
          [vaultId, error]
        )
        .catch((e: unknown) => console.warn(`[history] could not record the pass's outcome: ${messageOf(e)}`));
    }
    // Hand the pace back: the next pass may start `PACE_MS` after this one ENDED.
    await db
      .query(
        `UPDATE history_cursor SET last_run_at = date_trunc('milliseconds', now())
          WHERE vault_id = $1 AND last_run_at = $2`,
        [vaultId, hold]
      )
      .catch(() => {});
  }
  result.ok = issues.length === 0;
  if (!result.ok) result.error = clip(issues.join(" · "));
  result.ms = now() - startedAt;
  return result;
}

export function describeStuck(stuck: StuckTx[]): string {
  return `${stuck.length} transaction(s) not recorded: ` + stuck.map((s) => `${s.hash} (${s.reason})`).join("; ");
}

/**
 * Today's prices for valuing spreads, and the day's row in `token_price_daily` for every priced
 * token that has none yet — in practice all of them on the first pass of each UTC day — in a
 * statement of its own (a refusal there must not roll back events). No price is not an error:
 * the spread goes in as unpriced.
 */
async function loadPrices(
  db: Queryable,
  fetchBook: () => Promise<PriceBook>,
  nowMs: number
): Promise<PriceBook | null> {
  let book: PriceBook;
  try {
    book = await fetchBook();
  } catch (e) {
    console.warn(`[history] no prices this pass: ${messageOf(e)}`);
    return null;
  }
  if (book.size === 0) return null;
  const day = utcDay(nowMs);
  const entries = [...book.entries()];
  // Per token, not "any row today": a token 1Click starts pricing mid-day still gets its row.
  const stored = await db.query<{ n: string }>(
    "SELECT count(*) AS n FROM token_price_daily WHERE day = $1::date AND token_id = ANY($2::text[])",
    [day, entries.map(([id]) => id)]
  );
  if (Number(stored.rows[0]?.n ?? 0) < entries.length) {
    await db.query(
      `INSERT INTO token_price_daily (day, token_id, price_usd, source)
       SELECT $1::date, t, p::numeric, '1click' FROM unnest($2::text[], $3::text[]) AS u(t, p)
       ON CONFLICT (day, token_id) DO NOTHING`,
      [day, entries.map(([id]) => id), entries.map(([, q]) => q.priceText)]
    );
  }
  return book;
}
