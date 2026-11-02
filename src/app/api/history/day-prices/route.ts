// GET /api/history/day-prices — the price of each token recorded on the current UTC day, from
// the history database (D-523, table of plan 028). Read by the Overview's change "today".
//
// Transport only: SQL and cache policy live in `day-prices-service.ts`. NOT authenticated: these
// are market prices, the same for everyone.

import { NextResponse } from "next/server";
import { resolveHistoryReaderDb } from "@/features/vault/lib/ops-db-pool";
import { fail, handleDayPrices, type DayPricesOutput } from "@/features/history-recorder/lib/day-prices-service";

// `pg` opens TCP sockets: Node runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Caller identity for the rate limiter — spoofable, which is fine for an anti-spam brake. */
function callerKeyOf(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first && first.length > 0 ? first : "unknown";
}

function respond(result: DayPricesOutput) {
  return NextResponse.json(result.body, { status: result.status, headers: { "Cache-Control": result.cacheControl } });
}

export async function GET(request: Request) {
  const db = resolveHistoryReaderDb(process.env);
  if (!db.ok) {
    return respond(fail(503, "not-configured", `History database is not configured: ${db.issues.join(", ")}`));
  }
  return respond(await handleDayPrices({ callerKey: callerKeyOf(request), db: db.db }));
}
