// Server-side core of the rescue-verdict read (D-448, the frontend half of the solver's 942).
// SERVER ONLY: the route (`src/app/api/ops/allocate-verdicts/route.ts`) is a thin shell around
// this module, like `portfolio-trade-in-flight` is around `trade-in-flight-service.ts`.
//
// The solver's resolver writes a final verdict for a rescue record once it can no longer change
// (`intentfolio-solver/db/migrations/005_allocate_rescue_verdict.sql`). It is the one proof that
// outlives the on-chain ones the browser reads — the Allocate seal can be purged after the
// AuthCall deadline, and the nonce witness expires a week later — so without it a record whose
// browser came back too late stays "Still confirming" forever (D-320).
//
// Read BY RECORD ID, never by account: the ids are the browser's own uuids, so the public route
// cannot enumerate anyone else's records. And POST, not GET: an id is enough to PATCH a record's
// lifecycle columns, so it must not land in an access log as part of a URL.
//
// Only the verdict leaves the server. `detail` and `decided_at` are written freely by the
// solver's role (942 §9, review F6) and prove nothing; nothing here reads them.
//
// Fail-open: every failure is "no verdict", which the browser treats exactly as before this
// route existed. Nothing alerts.

import { createOpsRateLimiter, type OpsRateLimiter, type Queryable } from "./ops-records-service";
import {
  ALLOCATE_VERDICTS,
  ALLOCATE_VERDICT_IDS_MAX,
  type AllocateVerdict,
  type AllocateVerdictsResponseBody,
} from "./ops-records-types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ALLOCATE_VERDICTS_SQL =
  "SELECT record_id::text AS record_id, verdict FROM allocate_rescue_verdict WHERE record_id = ANY($1::uuid[])";

// Its own brake: one read per evaluation of the pending notice, and a flood here must not spend
// the budget of the record routes — whose POST is fail-closed.
const readLimiter: OpsRateLimiter = createOpsRateLimiter();

export type AllocateVerdictsOutput = { status: number; body: AllocateVerdictsResponseBody };

export type HandleAllocateVerdictsInput = {
  body: unknown;
  callerKey: string;
  db: Queryable;
  limiter?: OpsRateLimiter;
};

/** The requested ids, lower-cased and de-duplicated, or why the body is refused. */
export function validateVerdictIds(body: unknown): { ok: true; ids: string[] } | { ok: false; error: string } {
  const ids = (body as { ids?: unknown } | null)?.ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > ALLOCATE_VERDICT_IDS_MAX) {
    return { ok: false, error: `ids must be an array of 1-${ALLOCATE_VERDICT_IDS_MAX} record ids` };
  }
  const unique = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || !UUID_RE.test(id)) return { ok: false, error: "every id must be a UUID" };
    unique.add(id.toLowerCase());
  }
  return { ok: true, ids: [...unique] };
}

/**
 * Which verdict stands for each record — the reader's rule in 005: `credited` wins whenever
 * present; otherwise the database allows one row at most. Should two negatives ever appear,
 * `orphan_escalated` wins: it keeps the record on screen, and showing is the safe direction.
 * A value this file does not know is dropped, which reads as "not decided yet".
 */
export function foldVerdicts(rows: Array<{ record_id: unknown; verdict: unknown }>): Record<string, AllocateVerdict> {
  const rank: Record<AllocateVerdict, number> = { credited: 3, orphan_escalated: 2, never_executed: 1 };
  const out: Record<string, AllocateVerdict> = {};
  for (const { record_id, verdict } of rows) {
    if (typeof record_id !== "string" || !ALLOCATE_VERDICTS.includes(verdict as AllocateVerdict)) continue;
    const id = record_id.toLowerCase();
    const current = out[id];
    if (!current || rank[verdict as AllocateVerdict] > rank[current]) out[id] = verdict as AllocateVerdict;
  }
  return out;
}

export async function handleAllocateVerdicts(input: HandleAllocateVerdictsInput): Promise<AllocateVerdictsOutput> {
  const validated = validateVerdictIds(input.body);
  if (!validated.ok) return fail(400, "bad-request", validated.error);
  if (!(input.limiter ?? readLimiter).check(input.callerKey)) {
    return fail(429, "too-many-requests", "Too many verdict reads from this caller");
  }

  let rows: Array<{ record_id: unknown; verdict: unknown }>;
  try {
    ({ rows } = await input.db.query<{ record_id: unknown; verdict: unknown }>(ALLOCATE_VERDICTS_SQL, [
      validated.ids,
    ]));
  } catch (e) {
    // No ids in the line: they are bearer-like (see the header) and ADR-0017 §8 keeps them out.
    const message = e instanceof Error ? e.message : String(e);
    console.warn(`[ops] rescue-verdict read failed for ${validated.ids.length} id(s): ${message}`);
    return fail(502, "read-failed", "Could not read the rescue verdicts");
  }

  return { status: 200, body: { ok: true, verdicts: foldVerdicts(rows) } };
}

function fail(
  status: number,
  code: Extract<AllocateVerdictsResponseBody, { ok: false }>["code"],
  error: string
): AllocateVerdictsOutput {
  return { status, body: { ok: false, code, error } };
}
