// POST /api/ops/allocate-verdicts — the solver's final verdicts for the rescue records this
// browser holds (D-448, solver 942). Body `{ ids: [...] }`; read by the pending-Allocate notice
// and the hygiene sweep, off the path of any click.
//
// Transport only: validation, SQL and the anti-spam brake live in `allocate-verdicts-service.ts`.
// NOT authenticated, on purpose: the ids are the browser's own unguessable uuids, and the
// browser treats any failure here as "no verdict" — what it did before this route existed.
// No alerts for the same reason.

import { NextResponse } from "next/server";
import { resolveOpsDb } from "@/features/vault/lib/ops-db-pool";
import { handleAllocateVerdicts, type AllocateVerdictsOutput } from "@/features/vault/lib/allocate-verdicts-service";

// `pg` opens TCP sockets: Node runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Caller identity for the rate limiter — spoofable, which is fine for an anti-spam brake. */
function callerKeyOf(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first && first.length > 0 ? first : "unknown";
}

function respond(result: AllocateVerdictsOutput) {
  return NextResponse.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  // Its own one-connection pool with short timeouts: a public read must not take the
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

  return respond(await handleAllocateVerdicts({ body, callerKey: callerKeyOf(request), db: db.db }));
}
