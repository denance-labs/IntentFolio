// GET /api/ops/portfolio-trade-in-flight?portfolio=<id> — whether the solver is settling a
// trade in that portfolio right now (D-471, solver 945). Read by the confirm-changes modal on
// open and while it stays open, so the user waits BEFORE the click, never mid-signature.
//
// Transport only: validation, SQL and the anti-spam brake live in `trade-in-flight-service.ts`.
// NOT authenticated, on purpose: the answer is public on-chain seconds later, and the browser
// treats any failure here as "go ahead". No alerts for the same reason.

import { NextResponse } from "next/server";
import { resolveOpsDb } from "@/features/vault/lib/ops-db-pool";
import { handleTradeInFlight, type TradeInFlightOutput } from "@/features/vault/lib/trade-in-flight-service";
import { VAULT_CONTRACT_ID } from "@/features/wallet/config/network";

// `pg` opens TCP sockets: Node runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Caller identity for the rate limiter — spoofable, which is fine for an anti-spam brake. */
function callerKeyOf(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first && first.length > 0 ? first : "unknown";
}

function respond(result: TradeInFlightOutput) {
  // The answer is good for a few seconds at most: no cache may hold it.
  return NextResponse.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: Request) {
  // Its own one-connection pool with short timeouts: a public poll must not take the
  // connections the fail-closed Allocate write needs.
  const db = resolveOpsDb(process.env, "trade");
  if (!db.ok) {
    return respond({
      status: 503,
      body: { ok: false, code: "not-configured", error: `Ops database is not configured: ${db.issues.join(", ")}` },
    });
  }

  const portfolioId = new URL(request.url).searchParams.get("portfolio");
  return respond(
    await handleTradeInFlight({
      portfolioId,
      vaultId: VAULT_CONTRACT_ID,
      callerKey: callerKeyOf(request),
      db: db.db,
    })
  );
}
