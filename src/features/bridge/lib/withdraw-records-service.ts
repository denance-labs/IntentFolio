// Server-side core of the withdrawal tracking record ingest (ADR-0025). SERVER ONLY.
//
// The route (`src/app/api/ops/withdraw-records/route.ts`) is a thin shell around this module,
// as `allocate-records` is around `ops-records-service.ts`, whose configuration, pool and
// `Queryable` it reuses: one database, one writer credential (`intentfolio_ops_writer`).
//
// What differs from the Allocate ingest, and why (ADR-0025 §2, §4):
//   - The write is BEST-EFFORT. Nothing on-chain consumes this record, so the browser never
//     waits for it and a failure here never stops a withdrawal.
//   - Everything the PATCH carries is a HINT. The solver resolves each record on its own
//     evidence, so nothing here is write-once and nothing is cross-checked: a forged hint costs
//     resolver work, never a wrong verdict.
//   - Its own rate limiters and its own connection pool (`ops-db-pool.ts`, slot "withdraw"). A
//     flood on this public route must not spend the Allocate route's budget or connections —
//     that write is fail-closed, and a 429 or a connection timeout there cancels an Allocate.
//     POST and PATCH get separate budgets too: a user whose open records re-PATCH on every load
//     must not spend the budget of the next withdrawal's POST, the one write with no retry.
//
// The database enforces the rest (006): the writer may INSERT and UPDATE five lifecycle
// columns; a trigger freezes the withdrawal's identity even for the owner; nobody holds DELETE.

import {
  createOpsRateLimiter,
  type HandleOpsRecordInput,
  type OpsRateLimiter,
} from "@/features/vault/lib/ops-records-service";
import {
  WITHDRAW_RECORD_LIMITS as L,
  WITHDRAW_WIRE_ROUTES,
  WITHDRAW_WIRE_STATUSES,
  type CreateWithdrawRecordBody,
  type PatchWithdrawRecordBody,
  type WithdrawRecordErrorCode,
  type WithdrawRecordResponseBody,
  type WithdrawWireStatus,
} from "./withdraw-records-types";
import type { SupportedWithdrawRoute } from "./withdraw-envelope";
import type { ConversionRecordDetails } from "./withdraw-rescue-store";

const createLimiter: OpsRateLimiter = createOpsRateLimiter();
const patchLimiter: OpsRateLimiter = createOpsRateLimiter();

// ── Validation ──────────────────────────────────────────────────────────────────────────
//
// Mirrors the CHECK constraints of 006 so a malformed record gets a readable message instead
// of a raw constraint violation. The DATABASE remains the authority.

type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AMOUNT_RE = new RegExp(`^[0-9]{1,${L.amountDigitsMax}}$`);
/** Upper bound of a JS `Date`. The lower bound is the epoch: nothing here predates 1970. */
const MAX_EPOCH_MS = 8.64e15;

/**
 * A string Postgres will store and measure as we do. Counted in CODE POINTS, as Postgres
 * counts characters (a lone astral character is 2 UTF-16 units but 1 character), and with no
 * NUL, which neither `text` nor `jsonb` accepts. Anything the table would refuse must be
 * refused HERE: past this point a refusal is a 502 that alerts the operator, and a stranger
 * must not be able to provoke that.
 */
function isText(v: unknown, min: number, max: number): v is string {
  if (typeof v !== "string" || v.includes("\u0000")) return false;
  const length = Array.from(v).length;
  return length >= min && length <= max;
}

function isEpochMs(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_EPOCH_MS;
}

/** A JSON object with no NUL anywhere in its serialisation, within `max` characters. */
function isJsonObject(v: unknown, max: number): boolean {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const serialised = JSON.stringify(v);
  return !serialised.includes("\\u0000") && serialised.length <= max;
}

const CONVERSION_STRING_FIELDS = [
  "depositAddress",
  "deliveryTokenId",
  "amountOut",
  "minAmountOut",
  "quoteSignature",
] as const;

function validateConversion(raw: unknown): Validated<ConversionRecordDetails> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad("conversion must be an object");
  const c = raw as Record<string, unknown>;
  for (const field of CONVERSION_STRING_FIELDS) {
    if (!isText(c[field], 0, L.conversionMax)) return bad(`conversion.${field} must be a string`);
  }
  if (!isEpochMs(c.requestedDeadlineMs)) return bad("conversion.requestedDeadlineMs must be epoch ms");
  // Rebuilt from the known fields: a stray key from a hand-made request does not reach the row.
  const value: ConversionRecordDetails = {
    depositAddress: c.depositAddress as string,
    deliveryTokenId: c.deliveryTokenId as string,
    amountOut: c.amountOut as string,
    minAmountOut: c.minAmountOut as string,
    requestedDeadlineMs: c.requestedDeadlineMs,
    quoteSignature: c.quoteSignature as string,
  };
  if (JSON.stringify(value).length > L.conversionMax) {
    return bad(`conversion must serialise to at most ${L.conversionMax} characters`);
  }
  return { ok: true, value };
}

export function validateCreateBody(body: unknown): Validated<CreateWithdrawRecordBody> {
  if (!body || typeof body !== "object") return bad("Body must be a JSON object");
  const b = body as Record<string, unknown>;

  if (typeof b.id !== "string" || !UUID_RE.test(b.id)) return bad("id must be a UUID");
  if (b.kind !== "direct" && b.kind !== "conversion") return bad("kind must be direct or conversion");
  if (!isText(b.signerId, L.signerIdMin, L.signerIdMax)) {
    return bad(`signerId must be ${L.signerIdMin}-${L.signerIdMax} characters`);
  }
  if (!isText(b.tokenId, 1, L.tokenIdMax)) return bad(`tokenId must be 1-${L.tokenIdMax} characters`);
  if (typeof b.amount !== "string" || !AMOUNT_RE.test(b.amount)) {
    return bad("amount must be base units: decimal digits only");
  }
  if (!isText(b.chainId, 1, L.chainIdMax)) return bad(`chainId must be 1-${L.chainIdMax} characters`);
  if (!isText(b.destinationAddress, 1, L.destinationAddressMax)) {
    return bad(`destinationAddress must be 1-${L.destinationAddressMax} characters`);
  }
  if (b.destinationMemo !== undefined && !isText(b.destinationMemo, 1, L.destinationMemoMax)) {
    return bad(`destinationMemo, when present, must be 1-${L.destinationMemoMax} characters`);
  }
  if (!isText(b.nonce, 1, L.nonceMax)) return bad(`nonce must be 1-${L.nonceMax} characters`);
  if (!isEpochMs(b.deadline)) return bad("deadline must be an epoch-milliseconds number");
  // Not sanity-checked against the server clock, as in the Allocate ingest: `received_at` is
  // the one to trust when ordering.
  if (!isEpochMs(b.createdAt)) return bad("createdAt must be an epoch-milliseconds number");
  if (!isJsonObject(b.signedPayload, L.signedPayloadMax)) {
    return bad(`signedPayload must be the signed MultiPayload object, at most ${L.signedPayloadMax} characters`);
  }

  // 006's `withdraw_record_kind_shape`: a direct withdrawal names its route and carries no
  // quote; a conversion is the reverse.
  let route: SupportedWithdrawRoute | undefined;
  let conversion: ConversionRecordDetails | undefined;
  if (b.kind === "direct") {
    if (!WITHDRAW_WIRE_ROUTES.includes(b.route as SupportedWithdrawRoute)) {
      return bad(`route must be one of ${WITHDRAW_WIRE_ROUTES.join(", ")}`);
    }
    if (b.conversion !== undefined) return bad("a direct withdrawal carries no conversion");
    route = b.route as SupportedWithdrawRoute;
  } else {
    if (b.route !== undefined) return bad("a conversion has no route of its own");
    const validated = validateConversion(b.conversion);
    if (!validated.ok) return validated;
    conversion = validated.value;
  }

  return {
    ok: true,
    value: {
      id: b.id,
      kind: b.kind,
      signerId: b.signerId,
      tokenId: b.tokenId,
      amount: b.amount,
      chainId: b.chainId,
      ...(route !== undefined ? { route } : {}),
      destinationAddress: b.destinationAddress,
      ...(b.destinationMemo !== undefined ? { destinationMemo: b.destinationMemo as string } : {}),
      nonce: b.nonce,
      deadline: b.deadline,
      ...(conversion !== undefined ? { conversion } : {}),
      signedPayload: b.signedPayload,
      createdAt: b.createdAt,
    },
  };
}

export function validatePatchBody(body: unknown): Validated<PatchWithdrawRecordBody> {
  if (!body || typeof body !== "object") return bad("Body must be a JSON object");
  const b = body as Record<string, unknown>;
  if (typeof b.id !== "string" || !UUID_RE.test(b.id)) return bad("id must be a UUID");

  const patch: PatchWithdrawRecordBody = { id: b.id };
  if (b.status !== undefined) {
    if (!WITHDRAW_WIRE_STATUSES.includes(b.status as WithdrawWireStatus)) {
      return bad(`status must be one of ${WITHDRAW_WIRE_STATUSES.join(", ")}`);
    }
    patch.status = b.status as WithdrawWireStatus;
  }
  if (b.intentHash !== undefined) {
    if (!isText(b.intentHash, 1, L.intentHashMax)) return bad("intentHash must be a non-empty string");
    patch.intentHash = b.intentHash;
  }
  if (b.txHash !== undefined) {
    if (!isText(b.txHash, 1, L.txHashMax)) return bad("txHash must be a non-empty string");
    patch.txHash = b.txHash;
  }
  if (b.destinationTxHash !== undefined) {
    if (!isText(b.destinationTxHash, 1, L.destinationTxHashMax)) {
      return bad("destinationTxHash must be a non-empty string");
    }
    patch.destinationTxHash = b.destinationTxHash;
  }
  if (b.error !== undefined) {
    if (typeof b.error !== "string") return bad("error must be a string");
    // Cleaned and truncated, not refused: `error` carries arbitrary upstream messages, and a long
    // one — or one with a NUL, which Postgres cannot store — must not cost the status it travels
    // with.
    patch.error = Array.from(b.error.replace(/\u0000/g, "")).slice(0, L.errorMax).join("");
  }

  if (Object.keys(patch).length === 1) {
    return bad("patch must carry at least one of status, intentHash, txHash, destinationTxHash, error");
  }
  return { ok: true, value: patch };
}

// ── Handlers ────────────────────────────────────────────────────────────────────────────

export type HandleWithdrawRecordOutput = { status: number; body: WithdrawRecordResponseBody };

const INSERT_SQL = `INSERT INTO withdraw_record
    (id, kind, signer_id, token_id, amount, chain_id, route, destination_address,
     destination_memo, nonce, deadline, conversion, signed_payload, created_at, status)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14, 'publishing')
  ON CONFLICT (id) DO NOTHING
  RETURNING id`;

/**
 * The INSERT. `ON CONFLICT DO NOTHING` makes a retried POST a no-op: the id is the browser's
 * `crypto.randomUUID()` and it is the primary key.
 */
export async function handleCreateRecord(
  input: HandleOpsRecordInput
): Promise<HandleWithdrawRecordOutput> {
  const log = input.log ?? ((m: string) => console.log(m));
  const limiter = input.limiter ?? createLimiter;

  const validated = validateCreateBody(input.body);
  if (!validated.ok) return fail(400, "bad-request", validated.error);
  if (!limiter.check(input.callerKey)) {
    return fail(429, "too-many-requests", "Too many withdrawal-record writes from this caller");
  }

  const r = validated.value;
  let rowCount: number | null;
  try {
    const result = await input.db.query<{ id: string }>(INSERT_SQL, [
      r.id,
      r.kind,
      r.signerId,
      r.tokenId,
      r.amount,
      r.chainId,
      r.route ?? null,
      r.destinationAddress,
      r.destinationMemo ?? null,
      r.nonce,
      new Date(r.deadline),
      r.conversion !== undefined ? JSON.stringify(r.conversion) : null,
      JSON.stringify(r.signedPayload),
      new Date(r.createdAt),
    ]);
    rowCount = result.rowCount;
  } catch (e) {
    // ⚠️ The message may name a column and a constraint; it must never carry the row — the
    // signer, the destination and the amount stay out of logs (ADR-0025 §7, ADR-0017 §8).
    const message = e instanceof Error ? e.message : String(e);
    log(`[ops] withdraw-record INSERT FAILED id=${r.id}: ${message}`);
    return fail(502, "write-failed", `Could not persist the withdrawal record: ${message}`);
  }

  const created = (rowCount ?? 0) > 0;
  log(`[ops] withdraw-record ${created ? "stored" : "already present"} id=${r.id}`);
  return { status: 200, body: { ok: true, id: r.id, created } };
}

/**
 * Columns a PATCH may touch, as an allowlist that doubles as the name map. Column names come
 * from HERE, never from the request. 006 grants UPDATE on exactly these, so a bug in this map
 * cannot widen what the credential reaches. `updated_at` is set by the freeze trigger.
 */
const PATCHABLE_COLUMNS = {
  status: "status",
  intentHash: "intent_hash",
  txHash: "tx_hash",
  destinationTxHash: "destination_tx_hash",
  error: "error",
} as const;

export function buildPatchStatement(patch: Record<string, unknown> & { id: string }): {
  sql: string;
  values: unknown[];
  columns: string[];
} {
  const assignments: string[] = [];
  const columns: string[] = [];
  const values: unknown[] = [patch.id];
  for (const [field, column] of Object.entries(PATCHABLE_COLUMNS)) {
    const value = patch[field];
    if (value === undefined) continue;
    values.push(value);
    assignments.push(`${column} = $${values.length}`);
    columns.push(column);
  }
  return {
    sql: `UPDATE withdraw_record SET ${assignments.join(", ")} WHERE id = $1 RETURNING id`,
    values,
    columns,
  };
}

export async function handlePatchRecord(
  input: HandleOpsRecordInput
): Promise<HandleWithdrawRecordOutput> {
  const log = input.log ?? ((m: string) => console.log(m));
  const limiter = input.limiter ?? patchLimiter;

  const validated = validatePatchBody(input.body);
  if (!validated.ok) return fail(400, "bad-request", validated.error);
  if (!limiter.check(input.callerKey)) {
    return fail(429, "too-many-requests", "Too many withdrawal-record writes from this caller");
  }

  const patch = validated.value;
  const { sql, values, columns } = buildPatchStatement(patch);
  let rowCount: number | null;
  try {
    const result = await input.db.query<{ id: string }>(sql, values);
    rowCount = result.rowCount;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log(`[ops] withdraw-record UPDATE FAILED id=${patch.id}: ${message}`);
    return fail(502, "write-failed", `Could not update the withdrawal record: ${message}`);
  }

  if ((rowCount ?? 0) === 0) {
    // Expected now and then, and not an alarm: the POST is best-effort, and a record written
    // before this ingest existed is resolved on a later load with no row to update.
    log(`[ops] withdraw-record UPDATE MISSED — no row with id=${patch.id}`);
    return fail(404, "not-found", `No withdrawal record with id ${patch.id}`);
  }

  log(`[ops] withdraw-record updated id=${patch.id} fields=${columns.join("+")}`);
  return { status: 200, body: { ok: true, id: patch.id, updated: true } };
}

function bad(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function fail(status: number, code: WithdrawRecordErrorCode, error: string): HandleWithdrawRecordOutput {
  return { status, body: { ok: false, code, error } };
}
