// POST/PATCH /api/ops/withdraw-records — the withdrawal tracking record ingest (ADR-0025).
//
// Same-origin, called by the browser with `keepalive` and never awaited: POST when a signed
// withdrawal is about to be published, PATCH for the lifecycle hints afterwards. The solver
// never calls this — it reads the table over an outbound connection and resolves every record
// on its own evidence.
//
// Transport only, like `/api/ops/allocate-records`: validation, SQL and the anti-spam brake
// live in `withdraw-records-service.ts`; the pool in `ops-db-pool.ts`.
//
// NOT authenticated, on purpose (ADR-0017 §6, ADR-0025 §4): a record is a hint the solver
// re-checks, never an authorisation. What the endpoint needs is anti-spam.

import { NextResponse } from "next/server";
import { getOpsAlerter, sanitiseForAlert } from "@/features/vault/lib/ops-alerts";
import { resolveOpsDb } from "@/features/vault/lib/ops-db-pool";
import type { HandleOpsRecordInput } from "@/features/vault/lib/ops-records-service";
import {
  handleCreateRecord,
  handlePatchRecord,
  type HandleWithdrawRecordOutput,
} from "@/features/bridge/lib/withdraw-records-service";
import { WITHDRAW_RECORDS_ENABLED } from "@/features/bridge/lib/withdraw-records-flag";

// `pg` opens TCP sockets: Node runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Caller identity for the rate limiter — spoofable, which is fine for an anti-spam brake. */
function callerKeyOf(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first && first.length > 0 ? first : "unknown";
}

type Handler = (input: HandleOpsRecordInput) => Promise<HandleWithdrawRecordOutput>;

/**
 * The answers worth a message: the deployment has no database, or a statement reached it and
 * failed. Everything else is reachable by any anonymous caller and stays in the logs.
 *
 * WARN, not critical — the difference from the Allocate route that ADR-0025 §2 exists for. A
 * failed write here stops nothing: the withdrawal was published anyway and the browser keeps
 * its own record. What degrades is the solver's view, so the operator should know, but nobody
 * should be woken up.
 */
const ALERTABLE = {
  "not-configured": {
    id: "withdraw_write_not_configured",
    subject: "the withdrawal-record database is not configured on this deployment",
  },
  "write-failed": {
    id: "withdraw_write_failed",
    subject: "the withdrawal-record write failed",
  },
} as const;

async function alertIfNeeded(method: string, result: HandleWithdrawRecordOutput): Promise<void> {
  if (result.body.ok) return;
  const alertable = ALERTABLE[result.body.code as keyof typeof ALERTABLE];
  if (!alertable) return;
  // Gated on the flag that decides whether any browser writes here: with it off, a 503 means
  // an idle URL was poked, not that withdrawals are going untracked.
  if (!WITHDRAW_RECORDS_ENABLED) return;

  await getOpsAlerter().send({
    id: alertable.id,
    severity: "warn",
    message:
      `${method} /api/ops/withdraw-records: ${alertable.subject}. ` +
      `Withdrawals still go out, but the solver cannot follow them. ${sanitiseForAlert(result.body.error)}`,
  });
}

async function respond(request: Request, run: Handler) {
  // Its own pool, so this public route cannot starve the fail-closed Allocate write.
  const db = resolveOpsDb(process.env, "withdraw");
  if (!db.ok) {
    const result: HandleWithdrawRecordOutput = {
      status: 503,
      body: {
        ok: false,
        code: "not-configured",
        error: `Withdrawal-record storage is not configured: ${db.issues.join(", ")}`,
      },
    };
    await alertIfNeeded(request.method, result);
    return NextResponse.json(result.body, { status: result.status });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, code: "bad-request", error: "Body is not valid JSON" },
      { status: 400 }
    );
  }

  const result = await run({ body, callerKey: callerKeyOf(request), db: db.db });
  await alertIfNeeded(request.method, result);
  return NextResponse.json(result.body, { status: result.status });
}

export async function POST(request: Request) {
  return respond(request, handleCreateRecord);
}

export async function PATCH(request: Request) {
  return respond(request, handlePatchRecord);
}
