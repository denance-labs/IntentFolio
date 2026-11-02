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
 * `flow` is the part of `delta` that the user moved in or out (allocate / unallocate, D-548):
 * what Performance marks on its curve so it is not read as a gain or a loss.
 */
export const MOVES_SQL = `
SELECT COALESCE(l.token, '') AS token,
       to_char(l.day, 'YYYY-MM-DD') AS day,
       SUM(l.delta)::text AS delta,
       COALESCE(SUM(l.delta) FILTER (WHERE l.flow), 0)::text AS flow
  FROM (
    SELECT leg.token, (p.block_ts AT TIME ZONE 'UTC')::date AS day, leg.delta, leg.flow
      FROM vault_event_portfolio p
      JOIN vault_event e USING (vault_id, receipt_id, log_index)
     CROSS JOIN LATERAL (
       SELECT e.raw #>> '{data,0,token}' AS token, COALESCE(p.qty_in, 0) - COALESCE(p.qty_out, 0) AS delta, TRUE AS flow
        WHERE e.event IN ('allocate', 'unallocate')
       UNION ALL
       SELECT e.raw #>> '{data,0,token_in}', p.qty_in, FALSE
        WHERE e.event IN ('external_rebalance', 'forced_internal_rebalance') AND p.qty_in IS NOT NULL
       UNION ALL
       SELECT e.raw #>> '{data,0,token_out}', -p.qty_out, FALSE
        WHERE e.event IN ('external_rebalance', 'forced_internal_rebalance') AND p.qty_out IS NOT NULL
       UNION ALL
       SELECT e.raw #>> ARRAY['data', '0', 'corrections', p.ord::text, '1'], COALESCE(p.qty_in, 0) - COALESCE(p.qty_out, 0), FALSE
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

/** `flow`: the part of `delta` from allocate / unallocate; absent counts as none. */
type MoveRow = { token: string; day: string; delta: string; flow?: string };
type PriceRow = { day: string; token_id: string; price_usd: string };

export type CompositionToken = { tokenId: string; usd: number };
/** One snapshot: the portfolio at 00:00 UTC of `day`. Every token held then, none at zero. */
export type CompositionDay = {
  day: string;
  tokens: CompositionToken[];
  /**
   * What the user moved in (+) or out (−) since the previous snapshot, at this day's price (D-548);
   * null when a token moved has no price that day. Absent when nothing moved, and on the first
   * snapshot, which has no previous one to jump from.
   */
  flowUsd?: number | null;
};

export type PortfolioCompositionBody =
  | {
      ok: true;
      /** Oldest day first; days that could not be valued are absent, not zero. */
      days: CompositionDay[];
      /**
       * What the user moved in or out after the last snapshot — Performance's "now" point — at the
       * last kept price (D-548). Same meaning as `CompositionDay.flowUsd`; absent when nothing moved.
       */
      nowFlowUsd?: number | null;
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
    body: { ok: true, ...snapshotsOf(moves, prices), recordedUntil, upToDate, loading },
    cacheControl,
    catchUp,
  };
}

/**
 * Folds the daily changes (oldest first) into a snapshot per priced day. Quantities stay `bigint`
 * until a token is valued; only the USD value is a float.
 *
 * Alongside, what the user moved in or out (D-548): netted per token since the previous snapshot
 * that came out — a day left out passes its movements on to the next — and valued at the price of
 * the snapshot it first shows in, the one its point is drawn at. The jump between two points is
 * then exactly this plus what the earlier holdings gained or lost on price.
 */
export function snapshotsOf(
  moves: MoveRow[],
  prices: PriceRow[]
): { days: CompositionDay[]; nowFlowUsd?: number | null } {
  const priceByDay = new Map<string, Map<string, number>>();
  for (const p of prices) {
    let day = priceByDay.get(p.day);
    if (!day) priceByDay.set(p.day, (day = new Map()));
    day.set(p.token_id, Number(p.price_usd));
  }

  const held = new Map<string, bigint>();
  // Moved in or out since the last snapshot that came out.
  const flow = new Map<string, bigint>();
  const fold = ({ token, delta, flow: moved }: MoveRow) => {
    held.set(token, (held.get(token) ?? ZERO) + BigInt(delta));
    if (moved !== undefined && moved !== "0") flow.set(token, (flow.get(token) ?? ZERO) + BigInt(moved));
  };
  const days: CompositionDay[] = [];
  let lastPrices: Map<string, number> | undefined;
  let next = 0;
  for (const [day, dayPrices] of priceByDay) {
    lastPrices = dayPrices;
    // 00:00 UTC of `day`: every movement of an earlier day, none of its own.
    for (; next < moves.length && moves[next].day < day; next++) fold(moves[next]);
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
    if (valued && tokens.some((t) => t.usd > 0)) {
      const flowUsd = days.length > 0 ? valueOfFlow(flow, dayPrices) : undefined;
      days.push(flowUsd === undefined ? { day, tokens } : { day, tokens, flowUsd });
      flow.clear();
    }
  }
  if (days.length === 0 || !lastPrices) return { days };
  // After the last snapshot: today's movements, and those of any days left out since.
  for (; next < moves.length; next++) fold(moves[next]);
  const nowFlowUsd = valueOfFlow(flow, lastPrices);
  return nowFlowUsd === undefined ? { days } : { days, nowFlowUsd };
}

/** Undefined when nothing moved; null when a token moved cannot be valued at these prices. */
function valueOfFlow(flow: Map<string, bigint>, prices: Map<string, number>): number | null | undefined {
  let usd = 0;
  let moved = false;
  for (const [token, qty] of flow) {
    if (qty === ZERO) continue;
    moved = true;
    // `quantityOf` takes no negatives: value the size, then put the sign back.
    const units = quantityOf(toRegistryTokenId(token), (qty < ZERO ? -qty : qty).toString());
    const price = prices.get(token);
    if (units === null || price === undefined) return null;
    usd += (qty < ZERO ? -units : units) * price;
  }
  return moved ? usd : undefined;
}

function fail(
  status: number,
  code: Extract<PortfolioCompositionBody, { ok: false }>["code"],
  error: string
): PortfolioCompositionOutput {
  return { status, body: { ok: false, code, error }, cacheControl: "no-store", catchUp: false };
}
