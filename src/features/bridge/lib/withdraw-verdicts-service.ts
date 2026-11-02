// Server-side core of the withdrawal-verdict read (024-D, ADR-0025 §9). SERVER ONLY: the route
// (`src/app/api/ops/withdraw-verdicts/route.ts`) is a thin shell around this module, as
// `allocate-verdicts` is around `allocate-verdicts-service.ts`, whose shape it copies.
//
// The solver resolves every withdrawal record on its own evidence and writes a final verdict
// into `withdraw_verdict` (006). This read hands that verdict back to the browser that created
// the record, so a user who returns after the relay forgot the intent sees "Delivered" instead
// of "unconfirmed" (D-465).
//
// Read BY RECORD ID, never by account: the ids are the browser's own uuids, so the public route
// cannot enumerate anyone else's records. And POST, not the GET §9 first sketched: an id is
// enough to PATCH a record's lifecycle columns, so it must not land in an access log as part of
// a URL — the same reason the Allocate read is a POST.
//
// Only the verdict and its two tx hashes leave the server; both hashes are public on-chain.
// Nothing of the record itself (signer, destination, amount) is read here.
//
// Fail-open: every failure is "no verdict", which the browser treats exactly as before this
// route existed — its own re-checks decide. Nothing alerts.

import { createOpsRateLimiter, type OpsRateLimiter, type Queryable } from "@/features/vault/lib/ops-records-service";
import { validateVerdictIds } from "@/features/vault/lib/allocate-verdicts-service";
import {
  WITHDRAW_FINAL_VERDICTS,
  type WithdrawFinalVerdict,
  type WithdrawVerdictAnswer,
  type WithdrawVerdictsResponseBody,
} from "./withdraw-records-types";

/** Final verdicts only: 006 allows one per record (`withdraw_verdict_one_final`). */
export const WITHDRAW_VERDICTS_SQL = `SELECT record_id::text AS record_id, verdict,
    detail->>'tx' AS tx, detail->>'destinationTx' AS destination_tx
  FROM withdraw_verdict
  WHERE record_id = ANY($1::uuid[])
    AND verdict IN ('delivered', 'refunded', 'never_executed')`;

/**
 * A hash the browser may show and link. The solver already filters what it writes (its
 * `DESTINATION_TX_RE`); this repeats the check because `detail` is written freely by its role,
 * and anything else reads as "no hash" — never as text passed along.
 */
const HASH_RE = /^[0-9A-Za-z+/=_-]{16,128}$/;

function hashOf(v: unknown): string | undefined {
  return typeof v === "string" && HASH_RE.test(v) ? v : undefined;
}

// Its own brake, apart from the record routes and the Allocate read.
const readLimiter: OpsRateLimiter = createOpsRateLimiter();

export type WithdrawVerdictsOutput = { status: number; body: WithdrawVerdictsResponseBody };

export type HandleWithdrawVerdictsInput = {
  body: unknown;
  callerKey: string;
  db: Queryable;
  limiter?: OpsRateLimiter;
};

type VerdictRow = { record_id: unknown; verdict: unknown; tx: unknown; destination_tx: unknown };

/** The rows as answers. A verdict this file does not know is dropped: "not decided yet". */
export function toAnswers(rows: VerdictRow[]): Record<string, WithdrawVerdictAnswer> {
  const out: Record<string, WithdrawVerdictAnswer> = {};
  for (const row of rows) {
    if (typeof row.record_id !== "string") continue;
    if (!WITHDRAW_FINAL_VERDICTS.includes(row.verdict as WithdrawFinalVerdict)) continue;
    const txHash = hashOf(row.tx);
    const destinationTxHash = hashOf(row.destination_tx);
    out[row.record_id.toLowerCase()] = {
      verdict: row.verdict as WithdrawFinalVerdict,
      ...(txHash !== undefined && { txHash }),
      ...(destinationTxHash !== undefined && { destinationTxHash }),
    };
  }
  return out;
}

export async function handleWithdrawVerdicts(input: HandleWithdrawVerdictsInput): Promise<WithdrawVerdictsOutput> {
  const validated = validateVerdictIds(input.body);
  if (!validated.ok) return fail(400, "bad-request", validated.error);
  if (!(input.limiter ?? readLimiter).check(input.callerKey)) {
    return fail(429, "too-many-requests", "Too many verdict reads from this caller");
  }

  let rows: VerdictRow[];
  try {
    ({ rows } = await input.db.query<VerdictRow>(WITHDRAW_VERDICTS_SQL, [validated.ids]));
  } catch (e) {
    // No ids in the line: they are bearer-like (see the header) and ADR-0017 §8 keeps them out.
    const message = e instanceof Error ? e.message : String(e);
    console.warn(`[ops] withdraw-verdict read failed for ${validated.ids.length} id(s): ${message}`);
    return fail(502, "read-failed", "Could not read the withdrawal verdicts");
  }

  return { status: 200, body: { ok: true, verdicts: toAnswers(rows) } };
}

function fail(
  status: number,
  code: Extract<WithdrawVerdictsResponseBody, { ok: false }>["code"],
  error: string
): WithdrawVerdictsOutput {
  return { status, body: { ok: false, code, error } };
}
