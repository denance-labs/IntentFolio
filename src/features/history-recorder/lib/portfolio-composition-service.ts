// Server-side core of a portfolio's Evolution read (plan 033-A, D-516): how the portfolio's value
// was split between its tokens, one snapshot per UTC day, from the history database (migration
// 008, written by `history-recorder.ts`). SERVER ONLY: the route
// (`src/app/api/history/portfolio-composition/route.ts`) is a thin shell around this module.
//
// Public like `portfolio-stats` (028 decision 6), with its own brake; freshness and the catch-up
// pass are that module's.
//
// What a day is: the portfolio's holdings at 00:00 UTC — every movement of the days before — valued
// at the price `token_price_daily` keeps for that day (written ~00:05 UTC). Prices start on
// 2026-10-17, so older days do not exist here. A day is left out when any token held then cannot be
// valued (no price that day, outside the registry, a running balance below zero): a share computed
// without one of the tokens would be wrong for all of them.
//
// Measured 2026-10-30 against Production (033 «Medición»): folding these legs gives the vault's
// `qty_held` exactly for every (portfolio, token) recorded up to the cursor.

import { toRegistryTokenId } from "@/features/market/lib/intents-token-id";
import { quantityOf } from "@/features/vault/lib/vault-history";
import { createOpsRateLimiter, type OpsRateLimiter, type Queryable } from "@/features/vault/lib/ops-records-service";
import { CURSOR_SQL, PORTFOLIO_ID_RE, freshnessOf, type CursorRow } from "./portfolio-stats-service";

/**
 * The net change of each token per UTC day, from every row of the portfolio that moves a quantity
 * (see `vault_event_portfolio` in 008 for what qty_in / qty_out mean). The token is on the event:
 * `token` for allocate / unallocate; a rebalance row carries BOTH legs, qty_in of `token_in` and
 * qty_out of `token_out`; a repair names it per row in `corrections[ord][1]`. Rows of other events
 * move nothing and have both quantities NULL. A token the line does not name comes back as ''.
 */
export const MOVES_SQL = `
SELECT COALESCE(l.token, '') AS token,
       to_char(l.day, 'YYYY-MM-DD') AS day,
       SUM(l.delta)::text AS delta
  FROM (
    SELECT leg.token, (p.block_ts AT TIME ZONE 'UTC')::date AS day, leg.delta
      FROM vault_event_portfolio p
      JOIN vault_event e USING (vault_id, receipt_id, log_index)
     CROSS JOIN LATERAL (
       SELECT e.raw #>> '{data,0,token}' AS token, COALESCE(p.qty_in, 0) - COALESCE(p.qty_out, 0) AS delta
        WHERE e.event IN ('allocate', 'unallocate')
       UNION ALL
       SELECT e.raw #>> '{data,0,token_in}', p.qty_in
        WHERE e.event IN ('external_rebalance', 'forced_internal_rebalance') AND p.qty_in IS NOT NULL
       UNION ALL
       SELECT e.raw #>> '{data,0,token_out}', -p.qty_out
        WHERE e.event IN ('external_rebalance', 'forced_internal_rebalance') AND p.qty_out IS NOT NULL
       UNION ALL
       SELECT e.raw #>> ARRAY['data', '0', 'corrections', p.ord::text, '1'], COALESCE(p.qty_in, 0) - COALESCE(p.qty_out, 0)
        WHERE e.event = 'reconciliation_repaired'
     ) leg
     WHERE p.vault_id = $1 AND p.portfolio_id = $2
       AND (p.qty_in IS NOT NULL OR p.qty_out IS NOT NULL)
  ) l
 GROUP BY l.token, l.day
 ORDER BY l.day, l.token`;

/** The kept prices of those tokens, from the day after the first movement (the first snapshot). */
export const PRICES_SQL = `
SELECT to_char(day, 'YYYY-MM-DD') AS day, token_id, price_usd::text AS price_usd
  FROM token_price_daily
 WHERE token_id = ANY($1::text[]) AND day > $2::date
 ORDER BY day, token_id`;

const ZERO = BigInt(0);

type MoveRow = { token: string; day: string; delta: string };
type PriceRow = { day: string; token_id: string; price_usd: string };

export type CompositionToken = { tokenId: string; usd: number };
/** One snapshot: the portfolio at 00:00 UTC of `day`. Every token held then, none at zero. */
export type CompositionDay = { day: string; tokens: CompositionToken[] };

export type PortfolioCompositionBody =
  | {
      ok: true;
      /** Oldest day first; days that could not be valued are absent, not zero. */
      days: CompositionDay[];
      /** Every vault transaction is recorded up to this block time (ms); null before the first pass. */
      recordedUntil: number | null;
      upToDate: boolean;
      /** The initial load has not finished: older movements may still be missing. */
      loading: boolean;
    }
  | { ok: false; code: "bad-request" | "too-many-requests" | "not-configured" | "read-failed"; error: string };

export type PortfolioCompositionOutput = {
  status: number;
  body: PortfolioCompositionBody;
  cacheControl: string;
  /** The data is behind and no pass ran in the last `PACE_MS`: the route starts one after answering. */
  catchUp: boolean;
};

// Its own brake, apart from Performance's: each view is one read plus a few re-reads while it catches up.
const readLimiter: OpsRateLimiter = createOpsRateLimiter();

export type HandlePortfolioCompositionInput = {
  portfolioId: string | null;
  vaultId: string;
  callerKey: string;
  db: Queryable;
  limiter?: OpsRateLimiter;
  now?: () => number;
};

export async function handlePortfolioComposition(
  input: HandlePortfolioCompositionInput
): Promise<PortfolioCompositionOutput> {
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
  let moves: MoveRow[];
  let prices: PriceRow[] = [];
  try {
    ({ rows: [cursor] } = await db.query<CursorRow>(CURSOR_SQL, [vaultId]));
    ({ rows: moves } = await db.query<MoveRow>(MOVES_SQL, [vaultId, portfolioId]));
    if (moves.length > 0) {
      const tokens = [...new Set(moves.map((m) => m.token))];
      ({ rows: prices } = await db.query<PriceRow>(PRICES_SQL, [tokens, moves[0].day]));
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(`[history] portfolio-composition read failed for ${portfolioId}: ${message}`);
    return fail(502, "read-failed", "Could not read the portfolio's history");
  }

  const { recordedUntil, upToDate, loading, cacheControl, catchUp } = freshnessOf(cursor, (input.now ?? Date.now)());
  return {
    status: 200,
    body: { ok: true, days: snapshotsOf(moves, prices), recordedUntil, upToDate, loading },
    cacheControl,
    catchUp,
  };
}

/**
 * Folds the daily changes (oldest first) into a snapshot per priced day. Quantities stay `bigint`
 * until a token is valued; only the USD value is a float.
 */
export function snapshotsOf(moves: MoveRow[], prices: PriceRow[]): CompositionDay[] {
  const priceByDay = new Map<string, Map<string, number>>();
  for (const p of prices) {
    let day = priceByDay.get(p.day);
    if (!day) priceByDay.set(p.day, (day = new Map()));
    day.set(p.token_id, Number(p.price_usd));
  }

  const held = new Map<string, bigint>();
  const days: CompositionDay[] = [];
  let next = 0;
  for (const [day, dayPrices] of priceByDay) {
    // 00:00 UTC of `day`: every movement of an earlier day, none of its own.
    for (; next < moves.length && moves[next].day < day; next++) {
      const { token, delta } = moves[next];
      held.set(token, (held.get(token) ?? ZERO) + BigInt(delta));
    }
    const tokens: CompositionToken[] = [];
    let valued = true;
    for (const [token, qty] of held) {
      if (qty === ZERO) continue;
      const tokenId = toRegistryTokenId(token);
      // A negative balance is a gap in the data: `quantityOf` refuses it like an unknown token.
      const units = quantityOf(tokenId, qty.toString());
      const price = dayPrices.get(token);
      if (units === null || price === undefined) {
        valued = false;
        break;
      }
      tokens.push({ tokenId, usd: units * price });
    }
    if (valued && tokens.some((t) => t.usd > 0)) days.push({ day, tokens });
  }
  return days;
}

function fail(
  status: number,
  code: Extract<PortfolioCompositionBody, { ok: false }>["code"],
  error: string
): PortfolioCompositionOutput {
  return { status, body: { ok: false, code, error }, cacheControl: "no-store", catchUp: false };
}
