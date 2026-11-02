// POST/PATCH /api/ops/allocate-records — the Allocate rescue record ingest (ADR-0017 §3).
//
// Same-origin, called by the browser. POST inserts the record BEFORE the wallet is asked to
// sign and the caller aborts the Allocate if it does not succeed (fail-closed, ADR-0017 §4);
// PATCH carries the lifecycle afterwards. The solver never calls this — it reads the table
// directly over an outbound connection, which is why no inbound port is opened on the host
// that holds the Solver key.
//
// This file is transport only. The validation, the SQL, the anti-spam brake and the pool
// settings live in `ops-records-service.ts` / `ops-db-pool.ts` and are tested there, the same
// split `/api/relay` uses.
//
// NOT authenticated, on purpose and per ADR-0017 §6: a record is a hint, never an
// authorisation, and every rescue cross-checks on-chain evidence before it moves anything. An
// auth gate here would have to be a secret the browser holds, which is not a gate. What the
// endpoint does need is anti-spam, and that is the rate limiter in the service.

import { NextResponse } from "next/server";
import { getOpsAlerter, sanitiseForAlert } from "@/features/vault/lib/ops-alerts";
import { resolveOpsDb } from "@/features/vault/lib/ops-db-pool";
import {
  handleCreateRecord,
  handlePatchRecord,
  type HandleOpsRecordOutput,
  type Queryable,
} from "@/features/vault/lib/ops-records-service";
import { OPS_RECORDS_ENABLED } from "@/features/vault/lib/vault-flag";

// `pg` opens TCP sockets: Node runtime, never the edge one.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Caller identity for the rate limiter. `x-forwarded-for` is set by Vercel's proxy and is
 * spoofable by anyone talking to the origin directly — acceptable, because this keys an
 * anti-spam brake and not a trust boundary. Keying by SOMETHING is what stops one abusive
 * source from consuming a global budget and fail-closing everyone else's Allocate.
 */
function callerKeyOf(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first && first.length > 0 ? first : "unknown";
}

type Handler = (input: {
  body: unknown;
  callerKey: string;
  db: Queryable;
}) => Promise<HandleOpsRecordOutput>;

/**
 * Which answers are worth waking someone up for — ADR-0017 §7's first failure, "the write
 * path is broken".
 *
 * The list is short on purpose, and what is ABSENT is the decision. `bad-request` (400),
 * `too-many-requests` (429), `not-found` (404) and `conflict` (409, a second envelope for a
 * record that has one) are all reachable by any anonymous caller
 * sending whatever they like to a public URL, so alerting on them would hand a stranger the
 * operator's phone. They stay in the logs, where the ingest service already writes them —
 * including the 404, which the service flags as louder than it looks.
 *
 * What is left cannot be produced by a request body: the deployment has no database
 * (`not-configured`), or the statement reached one and failed (`write-failed`). The frontend's
 * validator mirrors every CHECK in 001/003, so a well-formed record cannot be rejected by the
 * table — a `write-failed` means infrastructure, not input.
 *
 * The alert carries no record id: this condition is about the PLATFORM, not about one
 * Allocate, and the operator's next step is the logs or the table, never a single id.
 */
const ALERTABLE = {
  "not-configured": {
    id: "ops_write_not_configured",
    subject: "the rescue-record database is not configured on this deployment",
  },
  "write-failed": {
    id: "ops_write_failed",
    subject: "the rescue-record write failed",
  },
} as const;

/**
 * Fires the alert for an answer, if that answer deserves one.
 *
 * Awaited, not fired and forgotten: a serverless invocation may be frozen the instant the
 * response is returned, which would drop the alert precisely during an outage. It costs the
 * caller nothing — this is the failure path, the browser abandoned the request at
 * `OPS_WRITE_BUDGET_MS` (1200ms), and the alerter caps itself at ~2.5s. `send` is documented
 * never to reject, which is what makes an unguarded `await` here safe.
 */
async function alertIfNeeded(method: string, result: HandleOpsRecordOutput): Promise<void> {
  if (result.body.ok) return;
  const alertable = ALERTABLE[result.body.code as keyof typeof ALERTABLE];
  if (!alertable) return;

  // Gated on the flag that decides whether any Allocate actually depends on this route.
  // Without it the endpoint is a loaded gun pointed at the operator: on a deployment with the
  // flag off (a Vercel preview has neither the flag nor a database), the first scanner to POST
  // here would fire a CRITICAL "Allocates are blocked" — while Allocates run perfectly, because
  // with the flag off the client never calls this route at all. The alert must describe the
  // platform, not the URL. Production has had the flag on since 2026-08-31.
  if (!OPS_RECORDS_ENABLED) return;

  await getOpsAlerter().send({
    id: alertable.id,
    // Critical in both cases: the pre-signature write is fail-closed, so this is not a
    // degraded feature — every Allocate on the platform stops until it is fixed.
    severity: "critical",
    message:
      `${method} /api/ops/allocate-records: ${alertable.subject}. ` +
      `Allocates are blocked while this lasts. ${sanitiseForAlert(result.body.error)}`,
  });
}

async function respond(request: Request, run: Handler) {
  const db = resolveOpsDb();
  if (!db.ok) {
    // 503, not 500: the database is not configured on this deployment. The browser turns this
    // into "the rescue record could not be stored, so nothing was signed" — the fail-closed
    // consequence ADR-0017 accepts, and the reason the client keeps its own feature flag.
    const result: HandleOpsRecordOutput = {
      status: 503,
      body: {
        ok: false,
        code: "not-configured",
        error: `Rescue-record storage is not configured: ${db.issues.join(", ")}`,
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
