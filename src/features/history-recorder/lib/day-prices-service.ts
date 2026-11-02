// Server-side core of the Overview's change "today" (D-523): the price each token was recorded at
// on the current UTC day, from `token_price_daily` (migration 008). The recorder writes a token's
// row on the first pass of the UTC day that has a price for it (~00:05 with the hourly cron) and
// never moves it after, so the answer only grows during the day. SERVER ONLY: the route
// (`src/app/api/history/day-prices/route.ts`) is a thin shell around this module.
//
// Read with `intentfolio_history_reader`. Public and without parameters: every price here is a
// market price, and the answer is the same for everyone, so the CDN holds one copy of it.

import { toRegistryTokenId } from "@/features/market/lib/intents-token-id";
import { createOpsRateLimiter, type OpsRateLimiter, type Queryable } from "@/features/vault/lib/ops-records-service";

export const DAY_PRICES_SQL = `
SELECT token_id, price_usd::text AS price_usd, recorded_at
  FROM token_price_daily
 WHERE day = $1::date`;

type PriceRow = { token_id: string; price_usd: string; recorded_at: Date };

/** A token's reference price for the day, and when the recorder took it (ms). */
export type DayPrice = { usd: number; at: number };

export type DayPricesBody =
  | {
      ok: true;
      /** The UTC day, "YYYY-MM-DD": a client on another day must not use these. */
      day: string;
      /** By registry token id. Empty before the day's first pass. */
      prices: Record<string, DayPrice>;
    }
  | { ok: false; code: "too-many-requests" | "not-configured" | "read-failed"; error: string };

export type DayPricesOutput = { status: number; body: DayPricesBody; cacheControl: string };

/** The rows of a day only grow, one per token, and the first pass writes nearly all of them. */
const CACHE_PRICED = "public, s-maxage=300, stale-while-revalidate=60";
/** Nothing yet today (the first minutes of the UTC day): barely, so the first pass shows soon. */
const CACHE_EMPTY = "public, s-maxage=30";

const readLimiter: OpsRateLimiter = createOpsRateLimiter();

export type HandleDayPricesInput = {
  callerKey: string;
  db: Queryable;
  limiter?: OpsRateLimiter;
  now?: () => number;
};

export async function handleDayPrices(input: HandleDayPricesInput): Promise<DayPricesOutput> {
  if (!(input.limiter ?? readLimiter).check(input.callerKey)) {
    return fail(429, "too-many-requests", "Too many history reads from this caller");
  }
  const day = new Date((input.now ?? Date.now)()).toISOString().slice(0, 10);

  let rows: PriceRow[];
  try {
    ({ rows } = await input.db.query<PriceRow>(DAY_PRICES_SQL, [day]));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(`[history] day-prices read failed for ${day}: ${message}`);
    return fail(502, "read-failed", "Could not read the day's prices");
  }

  const prices: Record<string, DayPrice> = {};
  for (const row of rows) {
    const usd = Number(row.price_usd);
    if (!(usd > 0)) continue;
    // The vault spells NEAR `nep141:wrap.near`; the registry keys it `near`.
    prices[toRegistryTokenId(row.token_id)] = { usd, at: row.recorded_at.getTime() };
  }
  return {
    status: 200,
    body: { ok: true, day, prices },
    cacheControl: rows.length > 0 ? CACHE_PRICED : CACHE_EMPTY,
  };
}

export function fail(
  status: number,
  code: Extract<DayPricesBody, { ok: false }>["code"],
  error: string
): DayPricesOutput {
  return { status, body: { ok: false, code, error }, cacheControl: "no-store" };
}
