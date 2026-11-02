// The account recorder (plan 028-6, D-492 stage 2; ADR-0027 in the monorepo): one account's
// transactions from FastNEAR into migration 009 (`account_tx`, `intents_event`,
// `account_movement`, `account_cursor`) and, for the vault events those transactions carry, into
// 008 with `writeTx` — so an operation shows up through the account without waiting for the
// vault's pass. Server only. The contract it serves is the header of
// `intentfolio-solver/db/migrations/009_account_history.sql`.
//
// The rules of `history-recorder.ts` hold here unchanged, per account: idempotent inserts,
// "recorded until" as a watermark that never passes a transaction it could not record, one
// database transaction per page and a SAVEPOINT per transaction, a resumable initial load, a
// pace claimed in `last_run_at`, and a hard deadline on every FastNEAR call. What is new:
//   - The floor (decision 7): nothing before the first transaction of `intentfolio-vault.near`
//     is listed, stored or shown. The initial load ends where the listing crosses it.
//   - Brakes, because anyone may ask for any account: a cap of transactions per account
//     (decision 8: past it, the account is not recorded any more and `last_error` says so); a
//     cap of NEW accounts per hour, counted under an advisory lock so it is exact (decision 9);
//     a cap of FastNEAR calls per pass, under the ~35–40 calls that trip its rate limit (028-4).
//   - Its own lock (`intentfolio-history:account:<account>`). It writes 008's tables WITHOUT
//     the vault's lock: two writers of one event cannot both count it (`ON CONFLICT DO NOTHING`
//     plus `RETURNING`), and a deadlock between them is transient, retried on the next pass.
//   - A cut initial load is progress, not an error: `backfill_done` already says "still
//     loading", and a huge account is meant to load in pieces, one pass per visit. Only a live
//     walk cut before "recorded until" is reported.
//
// Attribution: see ATTRIBUTIONS.md #21 (FastNEAR transaction API).

import type { Queryable, TransactionalQueryable } from "@/features/vault/lib/ops-records-service";
import {
  FastNearRateLimitError,
  TX_BATCH_SIZE,
  fetchAccountTxPage,
  fetchIndexedHeadMs,
  fetchTransactions,
  type AccountTxRow,
} from "@/features/vault/lib/vault-history-client";
import { extractAccountTx, type AccountTx } from "./account-extract";
import { fetchPriceBook, type PriceBook } from "./history-prices";
import {
  FASTNEAR_GRACE_MS,
  HOLD_GRACE_MS,
  LIST_MARGIN_MS,
  LOCK_TIMEOUT,
  STUCK_REPORT_MS,
  WRITE_GRACE_MS,
  assertAdvances,
  clip,
  describeStuck,
  isTransientConflict,
  messageOf,
  writeTx,
  type FastNearSource,
  type StuckTx,
} from "./history-recorder";

/** The first transaction of `intentfolio-vault.near` (2026-07-14): nothing older is kept (decision 7). */
export const FLOOR_BLOCK_HEIGHT = 206_987_572;
/**
 * At this many recorded transactions an account is not recorded any more (decision 8). Checked
 * between pages, so the page that reaches it goes in whole: at most 199 over.
 */
export const ACCOUNT_TX_CAP = 5_000;
/** New accounts followed per hour from a public request (decision 9). */
export const NEW_ACCOUNTS_PER_HOUR = 60;
/** FastNEAR calls one pass may make: under the burst that trips its rate limit (028-4). */
export const MAX_CALLS_PER_PASS = 25;
/** At most one pass per account per this, after the previous one ended. */
export const ACCOUNT_PACE_MS = 30_000;
/** The pace of a pass a user's own operation asks for (`fresh`, `expect`). */
export const FRESH_PACE_MS = 5_000;
export const DEFAULT_ACCOUNT_BUDGET_MS = 20_000;

const SIGNUP_LOCK = "intentfolio-history:account-signup";

/**
 * The account ids `intents.near` knows: NEAR named, 64 hex (implicit, Solana, TON, Stellar) or
 * `0x` + 40 hex (EVM). Checked before anything reaches FastNEAR or the database.
 */
export function isFollowableAccountId(id: string): boolean {
  if (/^[0-9a-f]{64}$/.test(id) || /^0x[0-9a-f]{40}$/.test(id)) return true;
  return id.length >= 2 && id.length <= 64 && /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(id);
}

const lockKey = (accountId: string) => `intentfolio-history:account:${accountId}`;

async function signupsThisHour(db: Queryable): Promise<number> {
  const recent = await db.query<{ n: string }>("SELECT count(*) AS n FROM account_cursor WHERE created_at > now() - interval '1 hour'");
  return Number(recent.rows[0]?.n ?? 0);
}

// ── Following an account ─────────────────────────────────────────────────────────────────

export type FollowResult = "followed" | "already" | "capped";

/**
 * Starts following `accountId` (its `account_cursor` row). `capped` applies the hourly cap on
 * new accounts — for a public request; the cron and the operator follow accounts the vault
 * already knows, which no stranger can choose. Count and insert run under one advisory lock,
 * so concurrent requests cannot pass the cap together (decision 9).
 */
export async function followAccount(
  db: TransactionalQueryable,
  accountId: string,
  options: { capped: boolean; /** Tests only. */ perHour?: number }
): Promise<FollowResult> {
  const known = await db.query("SELECT 1 FROM account_cursor WHERE account_id = $1", [accountId]);
  if (known.rowCount) return "already";
  if (!options.capped) {
    const added = await db.query(
      "INSERT INTO account_cursor (account_id) VALUES ($1) ON CONFLICT (account_id) DO NOTHING",
      [accountId]
    );
    return added.rowCount ? "followed" : "already";
  }

  // Past the cap already: answered without the lock, so a flood of new ids while the cap holds
  // does not queue on it, each one holding a writer connection up to the lock timeout. Under the
  // cap this count is only a hint; the exact one is taken again under the lock.
  if (await signupsThisHour(db) >= (options.perHour ?? NEW_ACCOUNTS_PER_HOUR)) return "capped";

  const client = await db.connect();
  let broken: Error | undefined;
  try {
    // READ COMMITTED, said: under a stricter level the count would read a snapshot taken
    // before the lock wait and miss the signups it waited for.
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    // Past this the lock wait throws 55P03: a caller answers "try again", not an error.
    await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [SIGNUP_LOCK]);
    // READ COMMITTED: every statement after the lock sees every signup committed before it.
    const again = await client.query("SELECT 1 FROM account_cursor WHERE account_id = $1", [accountId]);
    if (again.rowCount) {
      await client.query("COMMIT");
      return "already";
    }
    if ((await signupsThisHour(client)) >= (options.perHour ?? NEW_ACCOUNTS_PER_HOUR)) {
      await client.query("COMMIT");
      return "capped";
    }
    const added = await client.query(
      "INSERT INTO account_cursor (account_id) VALUES ($1) ON CONFLICT (account_id) DO NOTHING",
      [accountId]
    );
    await client.query("COMMIT");
    return added.rowCount ? "followed" : "already";
  } catch (e) {
    broken = e instanceof Error ? e : new Error(String(e));
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release(broken);
  }
}

// ── FastNEAR, metered ────────────────────────────────────────────────────────────────────

class CallCap extends Error {}

type MeteredSource = FastNearSource & { calls(): number };

/** Counts calls (a fetch is one per 20 hashes) and refuses the one past the cap. */
function metered(source: FastNearSource, max: number): MeteredSource {
  let calls = 0;
  const take = (n: number) => {
    if (calls + n > max) throw new CallCap(`${max} FastNEAR calls`);
    calls += n;
  };
  return {
    calls: () => calls,
    indexedHeadMs: () => source.indexedHeadMs(), // `/status`: not the rate-limited index
    listPage: async (accountId, token) => {
      take(1);
      return source.listPage(accountId, token);
    },
    fetchTxs: async (hashes) => {
      if (hashes.length === 0) return [];
      take(Math.ceil(hashes.length / TX_BATCH_SIZE));
      return source.fetchTxs(hashes);
    },
  };
}

function liveFastNear(deadlineAt: number): FastNearSource {
  const deps = { deadlineAt, waitOutRateLimit: true };
  return {
    indexedHeadMs: () => fetchIndexedHeadMs(deps),
    listPage: (accountId, resumeToken) => fetchAccountTxPage(accountId, resumeToken, deps),
    fetchTxs: (hashes) => fetchTransactions(hashes, deps),
  };
}

// ── Writing one transaction ──────────────────────────────────────────────────────────────

type Finished = Extract<AccountTx, { complete: true }>;
type WriteCtx = { vaultId: string; prices: PriceBook | null; nowMs: number; dropped: string[] };

/**
 * Writes one finished transaction inside the caller's SAVEPOINT, parents first (009's foreign
 * keys): `account_tx` → `intents_event` → `account_movement`, then the vault's rows with 008's
 * `writeTx`. Returns whether the transaction was new and how many movements went in.
 */
async function writeAccountTx(
  db: Queryable,
  accountId: string,
  x: Finished,
  ctx: WriteCtx
): Promise<{ tx: number; movements: number }> {
  const tx = await db.query(
    `INSERT INTO account_tx (account_id, tx_hash, block_height, block_ts)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (account_id, tx_hash) DO NOTHING`,
    [accountId, x.tx.txHash, x.tx.blockHeight, new Date(x.tx.blockTsMs)]
  );

  if (x.lines.length > 0) {
    const l = x.lines;
    // A line naming two followed accounts goes in once, whichever pass sees it first.
    await db.query(
      `INSERT INTO intents_event (receipt_id, log_index, tx_hash, block_height, block_ts, standard, event, line)
       SELECT r, i, $1, h, ts, s, e, ln
         FROM unnest($2::text[], $3::smallint[], $4::bigint[], $5::timestamptz[], $6::text[], $7::text[], $8::text[])
              AS u(r, i, h, ts, s, e, ln)
       ON CONFLICT (receipt_id, log_index) DO NOTHING`,
      [
        x.tx.txHash,
        l.map((v) => v.receiptId),
        l.map((v) => v.logIndex),
        l.map((v) => v.blockHeight),
        l.map((v) => new Date(v.blockTsMs)),
        l.map((v) => v.standard),
        l.map((v) => v.event),
        l.map((v) => v.line),
      ]
    );
  }

  let movements = 0;
  if (x.movements.length > 0) {
    const m = x.movements;
    const inserted = await db.query(
      `INSERT INTO account_movement
         (account_id, receipt_id, log_index, entry_index, token_index, kind, token_id, amount,
          counterparty, memo, intent_hash, tx_hash, block_height, block_ts)
       SELECT $1, r, i, en, tk, k, t, a::numeric, cp, mm, ih, $2, h, ts
         FROM unnest($3::text[], $4::smallint[], $5::smallint[], $6::smallint[], $7::text[], $8::text[],
                     $9::text[], $10::text[], $11::text[], $12::text[], $13::bigint[], $14::timestamptz[])
              AS u(r, i, en, tk, k, t, a, cp, mm, ih, h, ts)
       ON CONFLICT (receipt_id, log_index, entry_index, token_index) DO NOTHING`,
      [
        accountId,
        x.tx.txHash,
        m.map((v) => v.receiptId),
        m.map((v) => v.logIndex),
        m.map((v) => v.entryIndex),
        m.map((v) => v.tokenIndex),
        m.map((v) => v.kind),
        m.map((v) => v.tokenId),
        m.map((v) => v.amount),
        m.map((v) => v.counterparty),
        m.map((v) => v.memo),
        m.map((v) => v.intentHash),
        m.map((v) => v.blockHeight),
        m.map((v) => new Date(v.blockTsMs)),
      ]
    );
    movements = inserted.rowCount ?? 0;
  }

  if (x.vault) await writeTx(db, ctx.vaultId, x.vault, ctx);
  return { tx: tx.rowCount ?? 0, movements };
}

/** Prices are needed only to value a rebalance's spread, which an account's listing rarely holds. */
function needsPrices(ready: Array<{ x: Finished }>): boolean {
  return ready.some(({ x }) => x.vault?.events.some((e) => e.portfolios.some((p) => p.swapToken !== null)));
}

// ── One page ─────────────────────────────────────────────────────────────────────────────

type PageOutcome = { recordedTxs: number; recordedMovements: number; stuck: StuckTx[]; skipped: string[]; dropped: string[] };

class Stop extends Error {
  constructor(readonly why: AccountStopReason) {
    super(why);
  }
}

type PageDeps = {
  db: TransactionalQueryable;
  accountId: string;
  fastnear: FastNearSource;
  vaultId: string;
  prices: () => Promise<PriceBook | null>;
  nowMs: number;
  canWrite: () => boolean;
};

/**
 * Records every listed transaction of the account not recorded yet, in one database
 * transaction under the account's lock. A transaction already in `account_tx` is not fetched
 * again: it went in only once finished.
 */
async function recordAccountPage(rows: AccountTxRow[], deps: PageDeps): Promise<PageOutcome> {
  const { db, accountId } = deps;
  const out: PageOutcome = { recordedTxs: 0, recordedMovements: 0, stuck: [], skipped: [], dropped: [] };
  if (rows.length === 0) return out;

  const known = await db.query<{ tx_hash: string }>(
    "SELECT tx_hash FROM account_tx WHERE account_id = $1 AND tx_hash = ANY($2::text[])",
    [accountId, rows.map((r) => r.hash)]
  );
  const recorded = new Set(known.rows.map((r) => r.tx_hash));
  const todo = rows.filter((r) => !recorded.has(r.hash));
  if (todo.length === 0) return out;

  const fetched = new Map((await deps.fastnear.fetchTxs(todo.map((r) => r.hash))).map((t) => [t?.transaction?.hash, t]));
  const ready: Array<{ row: AccountTxRow; x: Finished }> = [];
  for (const row of todo) {
    const tx = fetched.get(row.hash);
    if (!tx) {
      out.stuck.push({ hash: row.hash, blockTsMs: row.blockTsMs, reason: "listed but not served by FastNEAR" });
      continue;
    }
    try {
      const x = extractAccountTx(tx, accountId, deps.vaultId);
      if (x.complete) ready.push({ row, x });
      else out.stuck.push({ hash: row.hash, blockTsMs: row.blockTsMs, reason: `${x.missingReceipts} receipt(s) still to come` });
    } catch (e) {
      out.stuck.push({ hash: row.hash, blockTsMs: row.blockTsMs, reason: `cannot read it: ${messageOf(e)}` });
    }
  }
  if (ready.length === 0) return out;
  if (!deps.canWrite()) throw new Stop("budget");
  const prices = needsPrices(ready) ? await deps.prices() : null;

  const client = await db.connect();
  let broken: Error | undefined;
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    // The bounds of `history-recorder.ts`'s pages, for the same reasons.
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '60s'");
    await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
    const lock = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok", [
      lockKey(accountId),
    ]);
    if (!lock.rows[0]?.ok) throw new Stop("busy");

    let lost = false;
    for (const { row, x } of ready) {
      // As in `history-recorder.ts`: after a lost lock, the rest of the page waits for next pass.
      if (lost) {
        out.stuck.push({ hash: row.hash, blockTsMs: row.blockTsMs, reason: "after a lost lock in its page", transient: true });
        continue;
      }
      await client.query("SAVEPOINT account_tx");
      try {
        const wrote = await writeAccountTx(client, accountId, x, {
          vaultId: deps.vaultId,
          prices,
          nowMs: deps.nowMs,
          dropped: out.dropped,
        });
        await client.query("RELEASE SAVEPOINT account_tx");
        out.recordedTxs += wrote.tx;
        out.recordedMovements += wrote.movements;
        out.skipped.push(...x.skipped.map((s) => `${x.tx.txHash} ${s}`));
      } catch (e) {
        await client.query("ROLLBACK TO SAVEPOINT account_tx");
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
    client.release(broken);
  }
}

/** The page's rows from the floor up, and whether the listing went below it. */
function aboveFloor(rows: AccountTxRow[]): { rows: AccountTxRow[]; crossed: boolean } {
  const kept = rows.filter((r) => r.blockHeight >= FLOOR_BLOCK_HEIGHT);
  return { rows: kept, crossed: kept.length < rows.length };
}

// ── The pass ─────────────────────────────────────────────────────────────────────────────

export type AccountStopReason = "budget" | "calls" | "busy" | "rate-limited" | "over-cap";

export type AccountPassDeps = {
  db: TransactionalQueryable;
  accountId: string;
  vaultId: string;
  fastnear?: FastNearSource;
  /** Today's prices, only fetched when a rebalance must be valued. */
  prices?: () => Promise<PriceBook>;
  now?: () => number;
  /** Past this, no new page is started. */
  budgetMs?: number;
  /**
   * `catch-up` (default): the live walk back to "recorded until", then the initial load.
   * `fresh`: the same pass, right after a user's operation without a hash, paced at 5 s. The
   * whole walk, not page 1 only: a pass every 5 s that stopped short of "recorded until" would
   * keep the full one from ever running (R1, 028-7).
   */
  mode?: "catch-up" | "fresh";
  maxCalls?: number;
};

export type AccountPassResult =
  | { ran: false; reason: "paced" | "not-followed" }
  | {
      ran: true;
      /** False when anything went into `last_error` (see `error`). */
      ok: boolean;
      recordedTxs: number;
      recordedMovements: number;
      stuck: StuckTx[];
      /** Movements left out because Postgres cannot hold a value of theirs (U+0000). */
      skipped: string[];
      droppedCalls: string[];
      liveComplete: boolean;
      backfillDone: boolean;
      stoppedBy: AccountStopReason | null;
      pages: number;
      calls: number;
      ms: number;
      error?: string;
    };

type CursorRow = { last_run_at: Date; last_ok_at: Date | null; backfill_done: boolean; backfill_resume: string | null };

/**
 * One pass over one followed account. Never throws; a failure is reported in the result and in
 * `account_cursor.last_error`.
 */
export async function runAccountPass(deps: AccountPassDeps): Promise<AccountPassResult> {
  const { db, accountId, vaultId } = deps;
  const now = deps.now ?? Date.now;
  const fresh = deps.mode === "fresh";
  const budgetMs = deps.budgetMs ?? DEFAULT_ACCOUNT_BUDGET_MS;
  const startedAt = now();
  const fastnear = metered(
    deps.fastnear ?? liveFastNear(Date.now() + budgetMs + FASTNEAR_GRACE_MS),
    deps.maxCalls ?? MAX_CALLS_PER_PASS
  );
  const overBudget = () => now() - startedAt > budgetMs;
  const canWrite = () => now() - startedAt <= budgetMs + WRITE_GRACE_MS;
  let priceBook: Promise<PriceBook | null> | null = null;
  const prices = () =>
    (priceBook ??= (deps.prices ?? (() => fetchPriceBook()))().catch((e: unknown) => {
      console.warn(`[history:account] no prices this pass: ${messageOf(e)}`);
      return null;
    }));

  const result: Extract<AccountPassResult, { ran: true }> = {
    ran: true,
    ok: true,
    recordedTxs: 0,
    recordedMovements: 0,
    stuck: [],
    skipped: [],
    droppedCalls: [],
    liveComplete: false,
    backfillDone: false,
    stoppedBy: null,
    pages: 0,
    calls: 0,
    ms: 0,
  };
  const issues: string[] = [];
  let room = ACCOUNT_TX_CAP;
  const tally = (page: PageOutcome) => {
    result.recordedTxs += page.recordedTxs;
    result.recordedMovements += page.recordedMovements;
    result.stuck.push(...page.stuck);
    result.skipped.push(...page.skipped);
    result.droppedCalls.push(...page.dropped);
    result.pages += 1;
    room -= page.recordedTxs;
  };
  const pageDeps = { db, accountId, fastnear, vaultId, prices, nowMs: startedAt, canWrite };

  let hold: Date | null = null;
  // Stops that are not issues: they must not clear an earlier error either (see the end).
  let quiet = false;
  try {
    const pace = (fresh ? FRESH_PACE_MS : ACCOUNT_PACE_MS) / 1000;
    const claim = await db.query<CursorRow>(
      `UPDATE account_cursor
          SET last_run_at = date_trunc('milliseconds', now() + make_interval(secs => $3))
        WHERE account_id = $1
          AND (last_run_at IS NULL OR last_run_at <= now() - make_interval(secs => $2))
        RETURNING last_run_at, last_ok_at, backfill_done, backfill_resume`,
      [accountId, pace, (budgetMs + HOLD_GRACE_MS) / 1000]
    );
    if (!claim.rowCount) {
      const followed = await db.query("SELECT 1 FROM account_cursor WHERE account_id = $1", [accountId]);
      return { ran: false, reason: followed.rowCount ? "paced" : "not-followed" };
    }
    const cursor = claim.rows[0];
    hold = cursor.last_run_at;
    result.backfillDone = cursor.backfill_done;

    // Decision 8. Counted through the primary key, never past the cap.
    const counted = await db.query<{ n: string }>(
      "SELECT count(*) AS n FROM (SELECT 1 FROM account_tx WHERE account_id = $1 LIMIT $2) AS t",
      [accountId, ACCOUNT_TX_CAP]
    );
    room = ACCOUNT_TX_CAP - Number(counted.rows[0]?.n ?? 0);
    if (room <= 0) throw new Stop("over-cap");

    // ── Live: newest first, back to the watermark ──
    const firstPass = !cursor.backfill_done && cursor.backfill_resume === null;
    const floorMs = cursor.last_ok_at ? cursor.last_ok_at.getTime() - LIST_MARGIN_MS : null;
    const headMs = await fastnear.indexedHeadMs().catch((e: unknown) => {
      console.warn(`[history:account] no indexed head: ${messageOf(e)}`);
      return null;
    });
    let token: string | null = null;
    let newestListedMs: number | null = null;
    let liveStuck: StuckTx[] = [];
    let reached = false;
    for (;;) {
      if (result.pages > 0 && overBudget()) throw new Stop("budget");
      const page = await fastnear.listPage(accountId, token);
      assertAdvances(page, token);
      if (newestListedMs === null && page.rows.length > 0) newestListedMs = Math.max(...page.rows.map((r) => r.blockTsMs));
      const { rows, crossed } = aboveFloor(page.rows);
      const outcome = await recordAccountPage(rows, pageDeps);
      tally(outcome);
      liveStuck = liveStuck.concat(outcome.stuck);
      if (room <= 0) throw new Stop("over-cap");
      token = crossed ? null : page.resumeToken;
      // The first pass ever takes page 1 only; everything older is the initial load's.
      reached = firstPass || token === null || (floorMs !== null && Math.min(...page.rows.map((r) => r.blockTsMs)) < floorMs);
      if (reached) break;
    }
    if (reached) {
      result.liveComplete = true;
      const seenUpTo = headMs ?? newestListedMs;
      const watermark = seenUpTo === null ? null : Math.min(seenUpTo, ...liveStuck.map((s) => s.blockTsMs));
      const reportable = liveStuck.filter((s) => !s.transient && startedAt - s.blockTsMs > STUCK_REPORT_MS);
      if (reportable.length > 0) issues.push(describeStuck(reportable));
      if (firstPass && token === null) result.backfillDone = true; // the whole history was one page
      await db.query(
        `UPDATE account_cursor
            SET last_ok_at      = COALESCE($2, last_ok_at),
                backfill_resume = CASE WHEN $3::text IS NULL THEN backfill_resume ELSE $3 END,
                backfill_done   = backfill_done OR $4
          WHERE account_id = $1`,
        [accountId, watermark === null ? null : new Date(watermark), firstPass ? token : null, result.backfillDone]
      );
    }

    // ── The initial load: older pages, resumable, down to the floor ──
    let loadToken: string | null = !reached ? null : firstPass ? token : cursor.backfill_resume;
    while (!result.backfillDone && loadToken !== null) {
      if (overBudget()) throw new Stop("budget");
      const page = await fastnear.listPage(accountId, loadToken);
      assertAdvances(page, loadToken);
      const { rows, crossed } = aboveFloor(page.rows);
      const outcome = await recordAccountPage(rows, pageDeps);
      tally(outcome);
      if (room <= 0) throw new Stop("over-cap");
      if (outcome.stuck.length > 0) {
        // Not past it: the next pass lists this page again and retries.
        const lasting = outcome.stuck.filter((s) => !s.transient);
        if (lasting.length > 0) issues.push(`initial load held at a page: ${describeStuck(lasting)}`);
        else quiet = true;
        break;
      }
      loadToken = crossed ? null : page.resumeToken;
      result.backfillDone = loadToken === null;
      await db.query(
        `UPDATE account_cursor
            SET backfill_resume = CASE WHEN $2::text IS NULL THEN backfill_resume ELSE $2 END,
                backfill_done   = backfill_done OR $3
          WHERE account_id = $1`,
        [accountId, loadToken, result.backfillDone]
      );
    }
  } catch (e) {
    const why: AccountStopReason | null =
      e instanceof Stop ? e.why : e instanceof CallCap ? "calls" : e instanceof FastNearRateLimitError ? "rate-limited" : null;
    if (why === null) {
      issues.push(messageOf(e));
    } else {
      result.stoppedBy = why;
      if (why === "over-cap") {
        issues.push(`over the cap of ${ACCOUNT_TX_CAP} transactions: this account is not recorded any more`);
      } else if ((why === "budget" || why === "calls") && !result.liveComplete) {
        issues.push(`stopped by the ${why === "budget" ? "time budget" : `cap of ${MAX_CALLS_PER_PASS} calls`} after ${result.pages} page(s), before reaching 'recorded until'`);
      } else {
        // Rate-limited, the lock taken by this account's other writer, or an initial load cut
        // short: the next pass picks it up where it stands.
        quiet = true;
      }
    }
  }
  if (result.skipped.length > 0) console.warn(`[history:account] ${accountId}: ${result.skipped.join("; ")}`);
  if (result.droppedCalls.length > 0) {
    issues.push(`${result.droppedCalls.length} call argument(s) not kept: ${result.droppedCalls.join("; ")}`);
  }
  result.calls = fastnear.calls();

  if (hold !== null) {
    // A clean pass clears the last error only when it saw everything it set out to see.
    const error = issues.length > 0 ? clip(issues.join(" · ")) : null;
    const sawEverything = !quiet && result.liveComplete && !result.stuck.some((s) => s.transient);
    if (error !== null || sawEverything) {
      await db
        .query(
          `UPDATE account_cursor
              SET last_error    = $2,
                  last_error_at = CASE WHEN $2::text IS NOT NULL THEN now() ELSE last_error_at END
            WHERE account_id = $1`,
          [accountId, error]
        )
        .catch((e: unknown) => console.warn(`[history:account] could not record the pass's outcome: ${messageOf(e)}`));
    }
    // Hand the pace back: the next pass may start a pace after this one ENDED.
    await db
      .query(
        `UPDATE account_cursor SET last_run_at = date_trunc('milliseconds', now())
          WHERE account_id = $1 AND last_run_at = $2`,
        [accountId, hold]
      )
      .catch(() => {});
  }
  result.ok = issues.length === 0;
  if (!result.ok) result.error = clip(issues.join(" · "));
  result.ms = now() - startedAt;
  return result;
}

// ── One expected transaction ─────────────────────────────────────────────────────────────

export type ExpectStatus =
  /** In the database now (or already was). */
  | "recorded"
  /** Not finished, not served yet, or another writer is on it: ask again in a moment. */
  | "pending"
  /** FastNEAR's transaction does not name this account, or is older than the floor. */
  | "not-this-account"
  | "not-followed"
  | "over-cap";

export type ExpectDeps = {
  db: TransactionalQueryable;
  accountId: string;
  vaultId: string;
  txHash: string;
  fastnear?: FastNearSource;
  prices?: () => Promise<PriceBook>;
  now?: () => number;
};

/**
 * Records ONE transaction the browser just saw go through (`expect=<hash>`, 028-7), before the
 * account's listing has it, so the user's operation shows at once. It must name the account —
 * a movement or line of its own, or a vault event with its `account_id` — or nothing is
 * written: anyone may send any hash. One FastNEAR call, none within 5 s of a pass's end or
 * while one runs. Does not move "recorded until" (the walk will list it and skip it), never
 * writes `last_error`, and hands `last_run_at` back as it found it: the browser asks every ~2 s
 * for a minute, and a pace taken from those asks would keep the full pass from ever running (R1).
 * So asks are NOT paced among themselves: one call each, braked only per caller by the route
 * (accepted with R2, 028-7).
 */
export async function recordExpectedTx(deps: ExpectDeps): Promise<{ status: ExpectStatus; detail?: string }> {
  const { db, accountId, vaultId, txHash } = deps;
  const now = deps.now ?? Date.now;
  const known = await db.query("SELECT 1 FROM account_tx WHERE account_id = $1 AND tx_hash = $2", [accountId, txHash]);
  if (known.rowCount) return { status: "recorded" };

  const budgetMs = 10_000;
  // `found` is the row as this statement's snapshot saw it: the value to hand back.
  const claim = await db.query<{ last_run_at: Date; found: Date | null }>(
    `UPDATE account_cursor AS c
        SET last_run_at = date_trunc('milliseconds', now() + make_interval(secs => $3))
       FROM account_cursor AS prev
      WHERE c.account_id = $1 AND prev.account_id = $1
        AND (c.last_run_at IS NULL OR c.last_run_at <= now() - make_interval(secs => $2))
      RETURNING c.last_run_at, prev.last_run_at AS found`,
    [accountId, FRESH_PACE_MS / 1000, (budgetMs + HOLD_GRACE_MS) / 1000]
  );
  if (!claim.rowCount) {
    const followed = await db.query("SELECT 1 FROM account_cursor WHERE account_id = $1", [accountId]);
    return { status: followed.rowCount ? "pending" : "not-followed" };
  }
  const { last_run_at: hold, found } = claim.rows[0];
  try {
    const counted = await db.query<{ n: string }>(
      "SELECT count(*) AS n FROM (SELECT 1 FROM account_tx WHERE account_id = $1 LIMIT $2) AS t",
      [accountId, ACCOUNT_TX_CAP]
    );
    if (Number(counted.rows[0]?.n ?? 0) >= ACCOUNT_TX_CAP) return { status: "over-cap" };

    const fastnear = metered(deps.fastnear ?? liveFastNear(Date.now() + budgetMs), 1);
    const [tx] = (await fastnear.fetchTxs([txHash])).filter((t) => t?.transaction?.hash === txHash);
    if (!tx) return { status: "pending", detail: "not served by FastNEAR yet" };
    const x = extractAccountTx(tx, accountId, vaultId);
    if (!x.complete) return { status: "pending", detail: `${x.missingReceipts} receipt(s) still to come` };
    const names = x.lines.length > 0 || (x.vault?.events.some((e) => e.accountId === accountId) ?? false);
    if (!names || x.tx.blockHeight < FLOOR_BLOCK_HEIGHT) return { status: "not-this-account" };

    const startedAt = now();
    const outcome = await recordAccountPage([{ hash: txHash, blockHeight: x.tx.blockHeight, blockTsMs: x.tx.blockTsMs }], {
      db,
      accountId,
      // Already fetched: the page reads it from here, not from the service again.
      fastnear: { ...fastnear, fetchTxs: async () => [tx] },
      vaultId,
      prices: () => (deps.prices ?? (() => fetchPriceBook()))().catch(() => null),
      nowMs: startedAt,
      canWrite: () => now() - startedAt <= budgetMs,
    });
    if (outcome.stuck.length > 0) return { status: "pending", detail: outcome.stuck[0].reason };
    return { status: "recorded" };
  } catch (e) {
    if (e instanceof Stop || e instanceof FastNearRateLimitError) return { status: "pending", detail: messageOf(e) };
    throw e;
  } finally {
    await db
      .query("UPDATE account_cursor SET last_run_at = $3 WHERE account_id = $1 AND last_run_at = $2", [accountId, hold, found])
      .catch(() => {});
  }
}
