// Server-side core of the in-flight trade read (D-471, the frontend half of the solver's 945).
// SERVER ONLY: the route (`src/app/api/ops/portfolio-trade-in-flight/route.ts`) is a thin
// shell around this module, like `allocate-records` is around `ops-records-service.ts`.
//
// Between a trade's settlement and its reconcile (~20-60 s) the vault has moved the tokens but
// not yet booked them to the portfolios involved. An owner who commits a change in that window
// signs over balances about to change, and can hold the reconcile for hours. The solver's
// reconciler writes `portfolio_trade_event` (migration 007); this reads it so the confirm modal
// can wait BEFORE the click. Never between signing and sending: the signed amounts and the
// wallet's ~5 s popup window rule that out.
//
// It narrows a race, it does not guard funds (945 D3). Every failure here means "go ahead",
// and the browser goes ahead on its own when this is slow. Nothing alerts.
//
// The vault is the server's own (`VAULT_CONTRACT_ID`), not a parameter: one less thing a
// caller can vary. What the answer reveals — "this portfolio has a trade settling" — is
// public on-chain seconds later (945 §9).

import { createOpsRateLimiter, type OpsRateLimiter, type Queryable } from "./ops-records-service";

/** The reader's cap: a trade that has not closed 90 s after it opened no longer holds anyone. */
export const TRADE_IN_FLIGHT_CAP_MS = 90_000;

/** The contract's portfolio id: `p_` + 12 hex digits. */
const PORTFOLIO_ID_RE = /^p_[0-9a-f]{12}$/;

export type TradeInFlightBody =
  | { ok: true; inFlight: boolean; remainingMs: number }
  | { ok: false; code: "bad-request" | "too-many-requests" | "not-configured" | "read-failed"; error: string };

export type TradeInFlightOutput = { status: number; body: TradeInFlightBody };

/**
 * The query from 007's header, verbatim in shape. The `closed` is matched per
 * (quote_hash, portfolio_id), not per portfolio: one quote can open several portfolios and
 * close them together, and another quote's `closed` says nothing about this one. Both sides
 * of the 90 s comparison use the database's clock — the caller's may be off.
 */
export const TRADE_IN_FLIGHT_SQL = `
SELECT GREATEST(0, ${TRADE_IN_FLIGHT_CAP_MS} - EXTRACT(EPOCH FROM now() - o.at) * 1000)::int AS remaining_ms
  FROM portfolio_trade_event o
 WHERE o.vault_id = $1 AND o.portfolio_id = $2 AND o.event = 'opened'
   AND o.at > now() - interval '${TRADE_IN_FLIGHT_CAP_MS / 1000} seconds'
   AND NOT EXISTS (SELECT 1 FROM portfolio_trade_event c
                    WHERE c.quote_hash = o.quote_hash AND c.portfolio_id = o.portfolio_id
                      AND c.event = 'closed')
 ORDER BY o.at DESC LIMIT 1`;

// Its own brake: a modal polls every 3-5 s (12-20 a minute), well inside 60 per minute, and a
// flood here must not spend the budget of the record routes.
const readLimiter: OpsRateLimiter = createOpsRateLimiter();

export type HandleTradeInFlightInput = {
  portfolioId: string | null;
  vaultId: string;
  callerKey: string;
  db: Queryable;
  limiter?: OpsRateLimiter;
};

export async function handleTradeInFlight(input: HandleTradeInFlightInput): Promise<TradeInFlightOutput> {
  const { portfolioId, vaultId, db } = input;
  if (vaultId === "") {
    return fail(503, "not-configured", "No vault is configured on this deployment");
  }
  if (portfolioId === null || !PORTFOLIO_ID_RE.test(portfolioId)) {
    return fail(400, "bad-request", "portfolio must be a vault portfolio id (p_ + 12 hex digits)");
  }
  if (!(input.limiter ?? readLimiter).check(input.callerKey)) {
    return fail(429, "too-many-requests", "Too many in-flight trade reads from this caller");
  }

  let rows: Array<{ remaining_ms: number }>;
  try {
    ({ rows } = await db.query<{ remaining_ms: number }>(TRADE_IN_FLIGHT_SQL, [vaultId, portfolioId]));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // The portfolio id is not user data in the ADR-0017 §8 sense (it is on-chain and carries
    // no amounts), but nothing else goes to the log.
    console.warn(`[ops] trade-in-flight read failed for ${portfolioId}: ${message}`);
    return fail(502, "read-failed", "Could not read the in-flight trade state");
  }

  const remainingMs = rows.length > 0 ? clampRemaining(rows[0].remaining_ms) : 0;
  return { status: 200, body: { ok: true, inFlight: remainingMs > 0, remainingMs } };
}

/** A driver or a clock edge must not turn into a wait longer than the cap, or a negative one. */
function clampRemaining(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.round(n), TRADE_IN_FLIGHT_CAP_MS);
}

function fail(
  status: number,
  code: Extract<TradeInFlightBody, { ok: false }>["code"],
  error: string
): TradeInFlightOutput {
  return { status, body: { ok: false, code, error } };
}
