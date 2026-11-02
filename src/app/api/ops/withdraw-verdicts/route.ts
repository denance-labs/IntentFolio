// POST /api/ops/withdraw-verdicts — the solver's final verdicts for the withdrawal records this
// browser holds (024-D, ADR-0025 §9). Body `{ ids: [...] }`; read by the pending-withdrawals
// hook on load, before its own re-checks, off the path of any click.
//
// Transport only: validation, SQL and the anti-spam brake live in `withdraw-verdicts-service.ts`.
// NOT authenticated, on purpose: the ids are the browser's own unguessable uuids, and the
// browser treats any failure here as "no verdict" — what it did before this route existed.
// No alerts for the same reason.

import { NextResponse } from "next/server";
import { resolveOpsDb } from "@/features/vault/lib/ops-db-pool";
import { handleWithdrawVerdicts, type WithdrawVerdictsOutput } from "@/features/bridge/lib/withdraw-verdicts-service";

// `pg` opens TCP sockets: Node runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Caller identity for the rate limiter — spoofable, which is fine for an anti-spam brake. */
function callerKeyOf(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first && first.length > 0 ? first : "unknown";
}

function respond(result: WithdrawVerdictsOutput) {
  return NextResponse.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  // The same one-connection read pool as the Allocate verdicts: a public read must not take the
  // connections the fail-closed Allocate write needs.
  const db = resolveOpsDb(process.env, "verdict");
  if (!db.ok) {
    return respond({
      status: 503,
      body: { ok: false, code: "not-configured", error: `Ops database is not configured: ${db.issues.join(", ")}` },
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return respond({ status: 400, body: { ok: false, code: "bad-request", error: "Body is not valid JSON" } });
  }

  return respond(await handleWithdrawVerdicts({ body, callerKey: callerKeyOf(request), db: db.db }));
}
