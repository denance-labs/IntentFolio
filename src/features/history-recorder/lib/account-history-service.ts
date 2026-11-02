// Server-side core of an account's history read (plan 028-7, D-492 stage 2): what a portfolio's
// History and My Account's recent activity show, from the history database instead of FastNEAR
// in the browser. SERVER ONLY: the route (`src/app/api/history/account/route.ts`) is a thin
// shell around this module, as `portfolio-stats` is around `portfolio-stats-service.ts`.
//
// The events keep the shape the browser read from the chain (`ChainHistoryEvent`), so the
// screens' mappers stay as they are:
//   - the vault's: `vault_event` by the account index (008), the kinds the browser's chain read
//     kept until 028-7 (`VAULT_EVENTS`; `PORTFOLIO_HISTORY_EVENTS` with `portfolio=`). Never a rebalance:
//     those carry no account (D-015);
//   - `intents.near`'s: `account_movement` (009), deposits and withdrawals with the memo the
//     honest flows carry (`deposit` / `withdraw`): anyone can mint a token of their own to an
//     account with any memo;
//   - Converting Withdrawals (028-8, D-423): a `transfer_out` whose receiver is the deposit
//     address of a conversion IntentFolio recorded for that account and the solver closed
//     (`withdraw_conversion_outcome`, 010: a view over 006 with `delivered` / `refunded` only, the oldest
//     record per address, neither the record's id nor the browser's hints). Final only because
//     anyone can POST a record: one the solver tied to what was signed and 1Click confirmed is a
//     real conversion. Gas purchases and other sends have no record, so they never match. The
//     token and amount are the chain's; the outcome is the solver's;
//   - a Setup's Storage Cost (D-528, D-539): the account's own `transfer_out` to the ops account
//     with memo `storage`. Only for a transaction already on the page: it never lists one by
//     itself, so it lands next to the creation it paid for (a portfolio's History included).
// A page is N TRANSACTIONS, not N events: one operation is several events of one transaction
// (D-082) and must not be split between pages. A transaction sorts by its oldest kept event,
// so all of a page's events lie at or after the page's last key. What paging takes away from a
// page, the answer adds: each portfolio's latest name, the name a rename replaced, and what a
// composition edit signed (D-489, from `vault_call`) and the composition it replaced (D-530,
// replayed from the portfolio's Setup).
//
// Public, like Performance (028 decision 6): everything here is on chain already. Read with
// `intentfolio_history_reader`; `expect` / `fresh` (the user's own operation, 028-7 (d)) and the
// pass a read starts after answering use the writer, through `account-recorder.ts` and its brakes.

import {
  ACCOUNT_CONVERSION_EVENT,
  ACCOUNT_DEPOSIT_EVENT,
  ACCOUNT_STORAGE_COST_EVENT,
  ACCOUNT_WITHDRAWAL_EVENT,
  PORTFOLIO_HISTORY_EVENTS,
  VAULT_EVENTS,
  type ChainHistoryEvent,
} from "@/features/vault/lib/vault-history";
import {
  createOpsRateLimiter,
  type OpsRateLimiter,
  type Queryable,
  type TransactionalQueryable,
} from "@/features/vault/lib/ops-records-service";
import {
  ACCOUNT_PACE_MS,
  ACCOUNT_TX_CAP,
  followAccount,
  isFollowableAccountId,
  recordExpectedTx,
  runAccountPass,
  type AccountPassDeps,
  type AccountPassResult,
  type ExpectDeps,
  type ExpectStatus,
  type FollowResult,
} from "./account-recorder";
import {
  applyCompositionEdit,
  compositionEditOf,
  setupCompositionOf,
  type CompositionEdit,
  type SignedTarget,
} from "./signed-change-set";
import { STORAGE_COST_MEMO, STORAGE_COST_RECEIVER } from "@/features/vault/lib/storage-cost";

/** Transactions per page: the screens' "show more" step (`ACTIVITY_PAGE_SIZE`). */
export const PAGE_TXS = 20;
/** Recorded until longer ago than this: behind; a read starts a pass after answering. */
export const ACCOUNT_STALE_MS = 60_000;
/** The pass a read starts after answering. */
export const CATCH_UP_BUDGET_MS = 20_000;
/** `fresh` runs before answering: the user waits on it, and re-reads anyway. */
export const FRESH_BUDGET_MS = 8_000;

const PORTFOLIO_ID_RE = /^p_[0-9a-f]{12}$/;
/** A transaction hash: base58 in the chain; bounded alphanumerics here (009 checks 1–64). */
const TX_HASH_RE = /^[0-9A-Za-z]{1,64}$/;
/** `before=`: the last key of the previous page, `<ms>_<tx hash>`. */
const BEFORE_RE = /^(\d{1,15})_([0-9A-Za-z]{1,64})$/;

/** The memo each kind carries in the honest flows (028-4 (a): 55 / 17 / 6, no other seen). */
const MOVEMENT_FILTER = `((kind = 'deposit' AND memo = 'deposit') OR (kind = 'withdrawal' AND memo = 'withdraw'))`;

/**
 * A conversion's `transfer_out` and its outcome. `c.signer_id = $2`, never `= m.account_id`:
 * `account_id` is `COLLATE "C"` and `signer_id` is not, so the derived filter would miss
 * `withdraw_record_signer_idx` and read every account's final verdicts (EXPLAIN, 010).
 */
const CONVERSION_JOIN = `account_movement m
    JOIN withdraw_conversion_outcome c ON c.signer_id = $2 AND c.deposit_address = m.counterparty
   WHERE $5 AND m.account_id = $2 AND m.kind = 'transfer_out'`;

export const CURSOR_SQL = `
SELECT backfill_done, last_ok_at, last_run_at,
       CASE WHEN last_error IS NOT NULL
            THEN (SELECT count(*) FROM (SELECT 1 FROM account_tx WHERE account_id = $1 LIMIT $2) AS t)::int
       END AS recorded
  FROM account_cursor
 WHERE account_id = $1`;

/**
 * The page's transactions, newest first. The whole account is grouped on every page: bounded by
 * the cap of 5,000 transactions per account on the `intents.near` side; the vault side has no
 * cap (a user's own operations), so a very active account pays tens of ms here — accepted.
 */
export const PAGE_SQL = `
WITH ev AS (
  SELECT tx_hash, block_ts
    FROM vault_event
   WHERE vault_id = $1 AND account_id = $2 AND event = ANY($3::text[])
     AND ($4::text IS NULL OR raw #>> '{data,0,portfolio_id}' = $4)
  UNION ALL
  SELECT tx_hash, block_ts
    FROM account_movement
   WHERE $5 AND account_id = $2 AND ${MOVEMENT_FILTER}
  UNION ALL
  SELECT m.tx_hash, m.block_ts
    FROM ${CONVERSION_JOIN}
)
SELECT tx_hash, min(block_ts) AS ts
  FROM ev
 GROUP BY tx_hash
HAVING $6::timestamptz IS NULL OR (min(block_ts), tx_hash) < ($6::timestamptz, $7::text)
 ORDER BY ts DESC, tx_hash DESC
 LIMIT $8`;

/**
 * Every kept event of the page's transactions; `$7` (the page's last key) bounds the index scan.
 * The Storage Cost ignores `$5`: a portfolio's History shows it too, with its creation. Its
 * `transfer` lands receipts before the vault's `portfolio_created`, so in a portfolio's History
 * (no movements on the page) it is older than the last key: its bound reaches an hour back.
 */
export const EVENTS_SQL = `
SELECT 'vault' AS source, tx_hash, block_ts, block_height, receipt_id, log_index,
       0 AS entry_index, 0 AS token_index, event, raw -> 'data' -> 0 AS data
  FROM vault_event
 WHERE vault_id = $1 AND account_id = $2 AND event = ANY($3::text[])
   AND ($4::text IS NULL OR raw #>> '{data,0,portfolio_id}' = $4)
   AND block_ts >= $7 AND tx_hash = ANY($6::text[])
UNION ALL
SELECT 'intents', tx_hash, block_ts, block_height, receipt_id, log_index,
       entry_index, token_index, kind,
       jsonb_build_object('account_id', account_id, 'token', token_id, 'amount', amount::text)
  FROM account_movement
 WHERE $5 AND account_id = $2 AND ${MOVEMENT_FILTER}
   AND block_ts >= $7 AND tx_hash = ANY($6::text[])
UNION ALL
SELECT 'conversion', m.tx_hash, m.block_ts, m.block_height, m.receipt_id, m.log_index,
       m.entry_index, m.token_index, 'conversion',
       jsonb_build_object('account_id', m.account_id, 'token', m.token_id, 'amount', m.amount::text,
                          'deposit_address', m.counterparty, 'chain_id', c.chain_id,
                          'delivery_token', c.delivery_token_id,
                          'verdict', c.verdict, 'destination_tx', c.destination_tx)
  FROM ${CONVERSION_JOIN}
   AND m.block_ts >= $7 AND m.tx_hash = ANY($6::text[])
UNION ALL
SELECT 'storage', tx_hash, block_ts, block_height, receipt_id, log_index,
       entry_index, token_index, kind,
       jsonb_build_object('account_id', account_id, 'token', token_id, 'amount', amount::text)
  FROM account_movement
 WHERE account_id = $2 AND kind = 'transfer_out' AND counterparty = $8 AND memo = $9
   AND block_ts >= $7::timestamptz - interval '1 hour' AND tx_hash = ANY($6::text[])
 ORDER BY block_ts, block_height, receipt_id, log_index, entry_index, token_index`;

/** The name events of the page's portfolios, oldest first, for the latest name and each rename's previous one. */
export const NAMES_SQL = `
SELECT receipt_id, log_index, raw #>> '{data,0,portfolio_id}' AS portfolio_id, raw #>> '{data,0,name}' AS name
  FROM vault_event
 WHERE vault_id = $1 AND account_id = $2 AND event IN ('portfolio_created', 'portfolio_renamed')
   AND raw #>> '{data,0,portfolio_id}' = ANY($3::text[])
 ORDER BY block_ts, block_height, receipt_id, log_index`;

/**
 * The page's edited portfolios back to their creation (D-530): each Setup and edit up to the
 * page's newest edit (`$4`), with the signed calls that carried it (008 decision 9), oldest
 * first. Replayed, they give each edit what it signed and the composition it replaced.
 */
export const COMPOSITIONS_SQL = `
SELECT e.tx_hash, e.event, e.raw #>> '{data,0,portfolio_id}' AS portfolio_id, c.method, c.args
  FROM vault_event e
  JOIN vault_call c ON c.vault_id = e.vault_id AND c.tx_hash = e.tx_hash
                   AND c.method IN ('commit_portfolio_changes', 'on_auth')
 WHERE e.vault_id = $1 AND e.account_id = $2
   AND e.event IN ('portfolio_created', 'portfolio_composition_changed')
   AND e.raw #>> '{data,0,portfolio_id}' = ANY($3::text[]) AND e.block_ts <= $4
 ORDER BY e.block_ts, e.block_height, e.receipt_id, e.log_index, c.block_ts, c.receipt_id, c.action_index`;

type CursorRow = { backfill_done: boolean; last_ok_at: Date | null; last_run_at: Date | null; recorded: number | null };
type PageRow = { tx_hash: string; ts: Date };
type EventRow = {
  source: "vault" | "intents" | "conversion" | "storage";
  tx_hash: string;
  block_ts: Date;
  receipt_id: string;
  log_index: number;
  event: string;
  data: Record<string, unknown>;
};
type NameRow = { receipt_id: string; log_index: number; portfolio_id: string; name: string | null };
type CompositionRow = { tx_hash: string; event: string; portfolio_id: string; method: string; args: unknown };

/** What `expect=<hash>` says: `pending` while it is not in the database yet. */
export type AccountExpectStatus = Exclude<ExpectStatus, "not-followed">;

export type AccountHistoryBody =
  | {
      ok: true;
      /** Newest transaction first; a transaction's events together, oldest first. */
      events: ChainHistoryEvent[];
      /** Each portfolio on the page: its latest name on chain. The screen prefers the live one. */
      names: Record<string, string>;
      /** `before=` for the next page; null on the last one. */
      next: string | null;
      /** Every transaction of the account is recorded up to this block time (ms); null before the first pass. */
      recordedUntil: number | null;
      upToDate: boolean;
      /** Not followed yet, or the initial load has not finished: older rows may be missing. */
      loading: boolean;
      /** Past the cap of transactions per account (decision 8): its movements are not recorded any more. */
      unavailable: boolean;
      /** Only with `expect=`. */
      expect?: AccountExpectStatus;
    }
  | { ok: false; code: "bad-request" | "too-many-requests" | "not-configured" | "read-failed"; error: string };

export type AccountHistoryOutput = {
  status: number;
  body: AccountHistoryBody;
  /** What the route runs in `after()`: follow the account and load it, or bring it up to date. */
  catchUp: "follow" | "pass" | null;
};

type WriterDb = { ok: true; db: TransactionalQueryable } | { ok: false; issues: string[] };

export type AccountRecorderFns = {
  follow: (db: TransactionalQueryable, accountId: string, options: { capped: boolean }) => Promise<FollowResult>;
  runPass: (deps: AccountPassDeps) => Promise<AccountPassResult>;
  expectTx: (deps: ExpectDeps) => Promise<{ status: ExpectStatus; detail?: string }>;
};

const LIVE_RECORDER: AccountRecorderFns = { follow: followAccount, runPass: runAccountPass, expectTx: recordExpectedTx };

// Its own brake. The re-reads after an operation are one every ~2 s for a minute: 30.
const readLimiter: OpsRateLimiter = createOpsRateLimiter();

export type HandleAccountHistoryInput = {
  query: URLSearchParams;
  vaultId: string;
  callerKey: string;
  reader: Queryable;
  /** Resolved only for `expect` / `fresh`, which write before answering. */
  writer: () => WriterDb;
  limiter?: OpsRateLimiter;
  now?: () => number;
  recorder?: AccountRecorderFns;
};

type Query = {
  accountId: string;
  portfolioId: string | null;
  before: { ts: Date; hash: string } | null;
  expect: string | null;
  fresh: boolean;
};

function parseQuery(params: URLSearchParams): Query | string {
  const accountId = params.get("account");
  if (accountId === null || !isFollowableAccountId(accountId)) return "account must be an account id intents.near knows";
  const portfolioId = params.get("portfolio");
  if (portfolioId !== null && !PORTFOLIO_ID_RE.test(portfolioId)) return "portfolio must be a vault portfolio id (p_ + 12 hex digits)";
  const beforeText = params.get("before");
  const before = beforeText === null ? null : BEFORE_RE.exec(beforeText);
  if (beforeText !== null && before === null) return "before must be the `next` of a previous page";
  const expect = params.get("expect");
  if (expect !== null && !TX_HASH_RE.test(expect)) return "expect must be a transaction hash";
  const freshText = params.get("fresh");
  if (freshText !== null && freshText !== "1") return "fresh must be 1";
  if (expect !== null && freshText !== null) return "expect and fresh do not go together";
  return {
    accountId,
    portfolioId,
    before: before ? { ts: new Date(Number(before[1])), hash: before[2] } : null,
    expect,
    fresh: freshText === "1",
  };
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

function fail(status: number, code: Extract<AccountHistoryBody, { ok: false }>["code"], error: string): AccountHistoryOutput {
  return { status, body: { ok: false, code, error }, catchUp: null };
}

export async function handleAccountHistory(input: HandleAccountHistoryInput): Promise<AccountHistoryOutput> {
  const { vaultId, reader } = input;
  if (vaultId === "") return fail(503, "not-configured", "No vault is configured on this deployment");
  const q = parseQuery(input.query);
  if (typeof q === "string") return fail(400, "bad-request", q);
  if (!(input.limiter ?? readLimiter).check(input.callerKey)) {
    return fail(429, "too-many-requests", "Too many history reads from this caller");
  }
  const recorder = input.recorder ?? LIVE_RECORDER;
  const { accountId } = q;

  // The user's own operation: recorded before answering, so this very answer shows it.
  let expect: AccountExpectStatus | undefined;
  let ranFresh = false;
  if (q.expect !== null || q.fresh) {
    if (q.expect !== null) expect = "pending";
    const writer = input.writer();
    if (!writer.ok) {
      console.warn(`[history:account] no writer for ${q.expect !== null ? "expect" : "fresh"}: ${writer.issues.join(", ")}`);
    } else {
      try {
        if (q.expect !== null) {
          const r = await recorder.expectTx({ db: writer.db, accountId, vaultId, txHash: q.expect });
          // Not followed yet: the pass after this answer follows it, and a re-read finds it.
          if (r.status !== "not-followed") expect = r.status;
        } else {
          const r = await recorder.runPass({ db: writer.db, accountId, vaultId, mode: "fresh", budgetMs: FRESH_BUDGET_MS });
          ranFresh = r.ran;
          if (r.ran) console.log(`[history:account] ${accountId} fresh ${JSON.stringify(r)}`);
        }
      } catch (e) {
        console.warn(`[history:account] ${accountId}: ${q.expect !== null ? "expect" : "fresh"} failed: ${messageOf(e)}`);
      }
    }
  }

  let cursor: CursorRow | undefined;
  let page: Awaited<ReturnType<typeof readPage>>;
  try {
    ({ rows: [cursor] } = await reader.query<CursorRow>(CURSOR_SQL, [accountId, ACCOUNT_TX_CAP]));
    page = await readPage(reader, vaultId, q);
  } catch (e) {
    console.warn(`[history:account] read failed for ${accountId}: ${messageOf(e)}`);
    return fail(502, "read-failed", "Could not read the account's history");
  }

  const now = (input.now ?? Date.now)();
  const recordedUntil = cursor?.last_ok_at ? cursor.last_ok_at.getTime() : null;
  const upToDate = recordedUntil !== null && now - recordedUntil <= ACCOUNT_STALE_MS;
  const unavailable = (cursor?.recorded ?? 0) >= ACCOUNT_TX_CAP;
  const lastRun = cursor?.last_run_at ? cursor.last_run_at.getTime() : null;
  // A `last_run_at` in the future is a pass still running; a recent one, the pace. The pass
  // checks both again itself: this only spares a writer connection that would change nothing.
  // An unfinished initial load goes on while the account is read, up to date or not: every pass
  // moves "recorded until" to the head first, and a load cut short resumes only on a visit.
  const behind = !upToDate || cursor?.backfill_done !== true;
  const catchUp =
    cursor === undefined
      ? "follow"
      : !unavailable && !ranFresh && behind && (lastRun === null || lastRun <= now - ACCOUNT_PACE_MS)
        ? "pass"
        : null;

  return {
    status: 200,
    body: {
      ok: true,
      ...page,
      recordedUntil,
      upToDate,
      loading: cursor?.backfill_done !== true,
      unavailable,
      ...(expect !== undefined && { expect }),
    },
    catchUp,
  };
}

async function readPage(
  db: Queryable,
  vaultId: string,
  q: Query
): Promise<{ events: ChainHistoryEvent[]; names: Record<string, string>; next: string | null }> {
  const kinds = [...(q.portfolioId === null ? VAULT_EVENTS : PORTFOLIO_HISTORY_EVENTS)];
  const movements = q.portfolioId === null;
  const { rows: listed } = await db.query<PageRow>(PAGE_SQL, [
    vaultId,
    q.accountId,
    kinds,
    q.portfolioId,
    movements,
    q.before?.ts ?? null,
    q.before?.hash ?? null,
    PAGE_TXS + 1,
  ]);
  const txs = listed.slice(0, PAGE_TXS);
  if (txs.length === 0) return { events: [], names: {}, next: null };
  const last = txs[txs.length - 1];
  const next = listed.length > PAGE_TXS ? `${last.ts.getTime()}_${last.tx_hash}` : null;

  const { rows } = await db.query<EventRow>(EVENTS_SQL, [
    vaultId,
    q.accountId,
    kinds,
    q.portfolioId,
    movements,
    txs.map((t) => t.tx_hash),
    last.ts,
    STORAGE_COST_RECEIVER,
    STORAGE_COST_MEMO,
  ]);
  const byTx = new Map<string, EventRow[]>();
  for (const row of rows) byTx.set(row.tx_hash, [...(byTx.get(row.tx_hash) ?? []), row]);

  const portfolioIds = [
    ...new Set(rows.flatMap((r) => (r.source === "vault" && typeof r.data.portfolio_id === "string" ? [r.data.portfolio_id] : []))),
  ];
  const names: Record<string, string> = {};
  const replaced = new Map<string, string>();
  if (portfolioIds.length > 0) {
    const { rows: named } = await db.query<NameRow>(NAMES_SQL, [vaultId, q.accountId, portfolioIds]);
    for (const n of named) {
      const before = names[n.portfolio_id];
      if (before !== undefined) replaced.set(`${n.receipt_id}:${n.log_index}`, before);
      if (n.name) names[n.portfolio_id] = n.name;
    }
  }

  const edits = rows.filter((r) => r.event === "portfolio_composition_changed");
  let replayed = new Map<string, ReplayedEdit>();
  if (edits.length > 0) {
    const edited = [...new Set(edits.map((r) => String(r.data.portfolio_id ?? "")))];
    const newest = new Date(Math.max(...edits.map((r) => r.block_ts.getTime())));
    const { rows: steps } = await db.query<CompositionRow>(COMPOSITIONS_SQL, [vaultId, q.accountId, edited, newest]);
    replayed = replayCompositions(steps);
  }

  const events: ChainHistoryEvent[] = [];
  for (const { tx_hash } of txs) {
    (byTx.get(tx_hash) ?? []).forEach((row, index) => {
      const event: ChainHistoryEvent = {
        txHash: tx_hash,
        index,
        ts: row.block_ts.getTime(),
        event:
          row.source === "vault"
            ? row.event
            : row.source === "conversion"
              ? ACCOUNT_CONVERSION_EVENT
              : row.source === "storage"
                ? ACCOUNT_STORAGE_COST_EVENT
                : row.event === "deposit"
                ? ACCOUNT_DEPOSIT_EVENT
                : ACCOUNT_WITHDRAWAL_EVENT,
        data: row.source === "conversion" ? conversionData(row.data) : row.data,
      };
      if (row.event === "portfolio_renamed") {
        const previous = replaced.get(`${row.receipt_id}:${row.log_index}`);
        if (previous !== undefined) event.previousName = previous;
      }
      if (row.event === "portfolio_composition_changed") {
        const step = replayed.get(`${String(row.data.portfolio_id ?? "")}:${tx_hash}`);
        event.edit = step?.edit ?? null;
        event.before = step?.before ?? null;
      }
      events.push(event);
    });
  }
  return { events, names, next };
}

type ReplayedEdit = { edit: CompositionEdit | null; before: SignedTarget[] | null };

/**
 * Each edit of `steps` keyed `portfolio:tx`: what it signed, and the composition right before
 * it — the Setup's, with every earlier edit applied. A step that cannot be read whole leaves
 * every later `before` of that portfolio null rather than guessed.
 */
export function replayCompositions(steps: CompositionRow[]): Map<string, ReplayedEdit> {
  const byStep = new Map<string, CompositionRow[]>();
  for (const s of steps) {
    const key = `${s.portfolio_id}:${s.tx_hash}`;
    byStep.set(key, [...(byStep.get(key) ?? []), s]);
  }
  const current = new Map<string, SignedTarget[] | null>();
  const out = new Map<string, ReplayedEdit>();
  for (const [key, calls] of byStep) {
    const id = calls[0].portfolio_id;
    if (calls[0].event === "portfolio_created") {
      current.set(id, calls.map((c) => setupCompositionOf(c.method, c.args)).find((c) => c !== null) ?? null);
      continue;
    }
    const edit = calls.map((c) => compositionEditOf(c.method, c.args, id)).find((e) => e !== null) ?? null;
    const before = current.get(id) ?? null;
    out.set(key, { edit, before });
    current.set(id, before && edit ? applyCompositionEdit(before, edit) : null);
  }
  return out;
}

/** Where a conversion's money went, from the solver's verdict; null for anything else. */
export type ConversionOutcome = "delivered" | "refunded";

/**
 * The view lists `delivered` and `refunded` only: `never_executed` proves its payload moved
 * nothing, so it can never describe a transfer the chain has (a retry of the same quote leaves
 * one next to the record that delivered). Anything else is a shape this code does not know, and
 * no verdict is "not decided yet", never "fine" (006's rule for readers): the browser skips it.
 */
export function conversionOutcomeOf(verdict: unknown): ConversionOutcome | null {
  return verdict === "delivered" || verdict === "refunded" ? verdict : null;
}

function conversionData({ verdict, ...data }: Record<string, unknown>): Record<string, unknown> {
  return { ...data, outcome: conversionOutcomeOf(verdict) };
}

export type AccountCatchUpInput = {
  accountId: string;
  vaultId: string;
  catchUp: "follow" | "pass";
  resolveDb: () => WriterDb;
  recorder?: AccountRecorderFns;
};

/**
 * The work a read starts after answering (028 decision 1): on the first visit, follow the
 * account (capped per hour, decision 9) and start its initial load; later, bring it up to date.
 * Never throws — nobody is waiting for it. A signup that waited out its lock (55P03, R3) or hit
 * the hourly cap is tried again by the next read: the answer already said "loading".
 */
export async function catchUpAccountAfterRead(input: AccountCatchUpInput): Promise<void> {
  const { accountId, vaultId } = input;
  const recorder = input.recorder ?? LIVE_RECORDER;
  const db = input.resolveDb();
  if (!db.ok) {
    console.warn(`[history:account] no catch-up pass: ${db.issues.join(", ")}`);
    return;
  }
  try {
    if (input.catchUp === "follow") {
      const followed = await recorder.follow(db.db, accountId, { capped: true });
      if (followed === "capped") {
        console.warn(`[history:account] ${accountId}: not followed, the hourly cap on new accounts is reached`);
        return;
      }
    }
    const result = await recorder.runPass({ db: db.db, accountId, vaultId, budgetMs: CATCH_UP_BUDGET_MS });
    if (result.ran) console.log(`[history:account] ${accountId} ${JSON.stringify(result)}`);
  } catch (e) {
    console.warn(`[history:account] ${accountId}: catch-up failed: ${messageOf(e)}`);
  }
}
