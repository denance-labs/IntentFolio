// Server-side core of a portfolio's Performance read (plan 028-3, D-492): swaps and earned
// spread from the history database (migration 008, written by `history-recorder.ts`). SERVER
// ONLY: the route (`src/app/api/history/portfolio-stats/route.ts`) is a thin shell around this
// module, like `portfolio-trade-in-flight` is around `trade-in-flight-service.ts`.
//
// Read with `intentfolio_history_reader` (SELECT on the eight history tables, nothing else).
// Public on purpose (028 decision 6): every number here is on chain already, and the read needs
// a portfolio id, never lists. What keeps a flood cheap is the CDN cache in front of the route,
// then the per-caller brake; the recorder sets its own pace whatever the reads do.
//
// Freshness is the AGE OF THE DATA, not `history_cursor.last_error`: an error alone is often
// harmless to these numbers (a pass that found the lock taken, call arguments it dropped) and is
// the operator's signal (D-496). A transaction the recorder cannot record pins "recorded until",
// and FastNEAR being down stops it from moving: both reach the screen as old data.

import { toRegistryTokenId } from "@/features/market/lib/intents-token-id";
import { quantityOf } from "@/features/vault/lib/vault-history";
import {
  createOpsRateLimiter,
  type OpsRateLimiter,
  type Queryable,
  type TransactionalQueryable,
} from "@/features/vault/lib/ops-records-service";
import { PACE_MS, type PassResult, type RecorderDeps } from "./history-recorder";

/** Data recorded up to this long ago is up to date: the solver rebalances every ~30 min. */
export const UP_TO_DATE_MS = 5 * 60 * 1000;

/** The budget of the pass a read starts: the live walk of a few new transactions, not a load. */
export const CATCH_UP_BUDGET_MS = 20_000;

/** The contract's portfolio id: `p_` + 12 hex digits. */
export const PORTFOLIO_ID_RE = /^p_[0-9a-f]{12}$/;

export const CURSOR_SQL = `
SELECT backfill_done, last_ok_at, last_run_at
  FROM history_cursor
 WHERE vault_id = $1`;

/**
 * One row per day the portfolio took part in a rebalance. A day's spread is the sum over its
 * tokens; what had no price when it was recorded comes along per token, with the price the
 * recorder kept for that same day, if any. The day is spelled with `to_char`, not `::text`, whose
 * shape follows the session's DateStyle.
 */
export const DAILY_SQL = `
SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
       SUM(d.swaps)::int AS swaps,
       SUM(d.spread_usd)::text AS spread_usd,
       COALESCE(jsonb_agg(jsonb_build_object('token', d.token_id,
                                             'qty', d.spread_unpriced::text,
                                             'price', p.price_usd::text))
                FILTER (WHERE d.spread_unpriced > 0), '[]'::jsonb) AS unpriced
  FROM portfolio_daily d
  LEFT JOIN token_price_daily p ON p.day = d.day AND p.token_id = d.token_id
 WHERE d.vault_id = $1 AND d.portfolio_id = $2
 GROUP BY d.day
 ORDER BY d.day`;

export type CursorRow = { backfill_done: boolean; last_ok_at: Date | null; last_run_at: Date | null };
type UnpricedPart = { token: string; qty: string; price: string | null };
type DailyRow = { day: string; swaps: number; spread_usd: string; unpriced: UnpricedPart[] };

export type PortfolioStatsDay = { day: string; swaps: number; spreadUsd: number };

export type PortfolioStatsBody =
  | {
      ok: true;
      /** Rebalances the portfolio took part in, external and forced alike. */
      swaps: number;
      spreadUsd: number;
      /** Some spread could not be valued (no price that day, or a token outside the registry): `spreadUsd` is a floor. */
      spreadIsMinimum: boolean;
      /** Oldest day first. */
      daily: PortfolioStatsDay[];
      /** Every vault transaction is recorded up to this block time (ms); null before the first pass. */
      recordedUntil: number | null;
      upToDate: boolean;
      /** The initial load has not finished: older rebalances may still be missing. */
      loading: boolean;
    }
  | { ok: false; code: "bad-request" | "too-many-requests" | "not-configured" | "read-failed"; error: string };

export type PortfolioStatsOutput = {
  status: number;
  body: PortfolioStatsBody;
  cacheControl: string;
  /** The data is behind and no pass ran in the last `PACE_MS`: the route starts one after answering. */
  catchUp: boolean;
};

/** Up to date ⇒ the CDN may hold it a little; behind ⇒ barely, so a re-read sees the pass that follows. */
const CACHE_UP_TO_DATE = "public, s-maxage=30, stale-while-revalidate=30";
const CACHE_BEHIND = "public, s-maxage=5";

// Its own brake, apart from the record routes'. A Performance view is one read plus at most a
// few re-reads while it catches up, well inside 60 a minute.
const readLimiter: OpsRateLimiter = createOpsRateLimiter();

export type HandlePortfolioStatsInput = {
  portfolioId: string | null;
  vaultId: string;
  callerKey: string;
  db: Queryable;
  limiter?: OpsRateLimiter;
  now?: () => number;
};

export async function handlePortfolioStats(input: HandlePortfolioStatsInput): Promise<PortfolioStatsOutput> {
  const { portfolioId, vaultId, db } = input;
  if (vaultId === "") {
    return fail(503, "not-configured", "No vault is configured on this deployment");
  }
  if (portfolioId === null || !PORTFOLIO_ID_RE.test(portfolioId)) {
    return fail(400, "bad-request", "portfolio must be a vault portfolio id (p_ + 12 hex digits)");
  }
  if (!(input.limiter ?? readLimiter).check(input.callerKey)) {
    return fail(429, "too-many-requests", "Too many history reads from this caller");
  }

  let cursor: CursorRow | undefined;
  let days: DailyRow[];
  try {
    ({ rows: [cursor] } = await db.query<CursorRow>(CURSOR_SQL, [vaultId]));
    ({ rows: days } = await db.query<DailyRow>(DAILY_SQL, [vaultId, portfolioId]));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(`[history] portfolio-stats read failed for ${portfolioId}: ${message}`);
    return fail(502, "read-failed", "Could not read the portfolio's history");
  }

  const now = (input.now ?? Date.now)();
  let swaps = 0;
  let spreadUsd = 0;
  let spreadIsMinimum = false;
  const daily: PortfolioStatsDay[] = days.map((d) => {
    let dayUsd = Number(d.spread_usd);
    for (const part of d.unpriced) {
      const usd = valueOf(part);
      if (usd === null) spreadIsMinimum = true;
      else dayUsd += usd;
    }
    swaps += d.swaps;
    spreadUsd += dayUsd;
    return { day: d.day, swaps: d.swaps, spreadUsd: dayUsd };
  });

  const { recordedUntil, upToDate, loading, cacheControl, catchUp } = freshnessOf(cursor, now);
  return {
    status: 200,
    body: { ok: true, swaps, spreadUsd, spreadIsMinimum, daily, recordedUntil, upToDate, loading },
    cacheControl,
    catchUp,
  };
}

/** How fresh a history read is, from the recorder's cursor. Shared by every portfolio history route. */
export function freshnessOf(cursor: CursorRow | undefined, now: number) {
  const recordedUntil = cursor?.last_ok_at ? cursor.last_ok_at.getTime() : null;
  const upToDate = recordedUntil !== null && now - recordedUntil <= UP_TO_DATE_MS;
  const lastRun = cursor?.last_run_at ? cursor.last_run_at.getTime() : null;
  return {
    recordedUntil,
    upToDate,
    loading: cursor?.backfill_done !== true,
    cacheControl: upToDate ? CACHE_UP_TO_DATE : CACHE_BEHIND,
    // A `last_run_at` in the future is a pass still running; a recent one, the pace. The pass
    // checks both again itself: this only spares a writer connection that would change nothing.
    catchUp: !upToDate && (lastRun === null || lastRun <= now - PACE_MS),
  };
}

/**
 * The USD value of spread recorded without a price, at the price kept for that day (028
 * decision 5): null when there is none, or the token is outside the registry (unknown decimals).
 */
function valueOf(part: UnpricedPart): number | null {
  if (part.price === null) return null;
  // The vault spells NEAR `nep141:wrap.near`; the registry keys it `near`.
  const qty = quantityOf(toRegistryTokenId(part.token), part.qty);
  return qty === null ? null : qty * Number(part.price);
}

function fail(
  status: number,
  code: Extract<PortfolioStatsBody, { ok: false }>["code"],
  error: string
): PortfolioStatsOutput {
  return { status, body: { ok: false, code, error }, cacheControl: "no-store", catchUp: false };
}

export type CatchUpInput = {
  vaultId: string;
  resolveDb: () => { ok: true; db: TransactionalQueryable } | { ok: false; issues: string[] };
  run: (deps: RecorderDeps) => Promise<PassResult>;
};

/**
 * The pass a read starts after answering (028 decision 4): what keeps Performance fresh between
 * the hourly crons. Never throws — nobody is waiting for it. Logged only when it ran, in the
 * cron's format; a paced one is the normal case and says nothing.
 */
export async function catchUpAfterRead(input: CatchUpInput): Promise<void> {
  const db = input.resolveDb();
  if (!db.ok) {
    console.warn(`[history] no catch-up pass: ${db.issues.join(", ")}`);
    return;
  }
  try {
    const result = await input.run({ db: db.db, vaultId: input.vaultId, budgetMs: CATCH_UP_BUDGET_MS });
    if (result.ran) console.log(`[history] ${JSON.stringify(result)}`);
  } catch (e) {
    console.error(`[history] catch-up pass threw: ${e instanceof Error ? e.message : String(e)}`);
  }
}
