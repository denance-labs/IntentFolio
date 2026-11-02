// GET /api/history/portfolio-stats?portfolio=<id> — a real portfolio's swaps and earned spread,
// from the history database (plan 028-3, D-492). Read by Performance.
//
// Transport only: validation, SQL, valuation and freshness live in `portfolio-stats-service.ts`;
// the pass in `history-recorder.ts`. NOT authenticated, on purpose (028 decision 6): the
// numbers are public on-chain, and the read needs a portfolio id, never lists.

import { after, NextResponse } from "next/server";
import { resolveHistoryReaderDb, resolveHistoryWriterDb } from "@/features/vault/lib/ops-db-pool";
import { VAULT_CONTRACT_ID } from "@/features/wallet/config/network";
import {
  catchUpAfterRead,
  handlePortfolioStats,
  type PortfolioStatsOutput,
} from "@/features/history-recorder/lib/portfolio-stats-service";
import { runHistoryPass } from "@/features/history-recorder/lib/history-recorder";

// `pg` opens TCP sockets: Node runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The answer goes out first; the catch-up pass after it runs in the same invocation, and with
// its grace periods may outlive a short limit (`CATCH_UP_BUDGET_MS` + the recorder's margins).
export const maxDuration = 300;

/** Caller identity for the rate limiter — spoofable, which is fine for an anti-spam brake. */
function callerKeyOf(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first && first.length > 0 ? first : "unknown";
}

function respond(result: Pick<PortfolioStatsOutput, "status" | "body" | "cacheControl">) {
  return NextResponse.json(result.body, { status: result.status, headers: { "Cache-Control": result.cacheControl } });
}

export async function GET(request: Request) {
  // Its own one-connection pool, as a role that can only SELECT the history tables.
  const db = resolveHistoryReaderDb(process.env);
  if (!db.ok) {
    return respond({
      status: 503,
      body: { ok: false, code: "not-configured", error: `History database is not configured: ${db.issues.join(", ")}` },
      cacheControl: "no-store",
    });
  }

  const portfolioId = new URL(request.url).searchParams.get("portfolio");
  const result = await handlePortfolioStats({
    portfolioId,
    vaultId: VAULT_CONTRACT_ID,
    callerKey: callerKeyOf(request),
    db: db.db,
  });
  if (result.catchUp) {
    after(() =>
      catchUpAfterRead({
        vaultId: VAULT_CONTRACT_ID,
        resolveDb: () => resolveHistoryWriterDb(process.env),
        run: runHistoryPass,
      })
    );
  }
  return respond(result);
}
