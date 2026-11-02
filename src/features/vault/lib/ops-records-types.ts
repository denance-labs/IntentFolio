// Wire contract between the browser and `/api/ops/allocate-records` (ADR-0017 §3).
//
// The Allocate rescue record is the ONE artefact IntentFolio persists off-client, and the
// table it lands in is a contract between two repositories: the DDL lives in the solver
// (`intentfolio-solver/db/migrations/001_allocate_rescue_record.sql`) and this side matches
// it. Nothing here may drift from that file — see `intentfolio-solver/db/README.md` for the
// change rule (a nullable column is safe from either side; anything else lands here first).
//
// Attribution: see ATTRIBUTIONS.md #17.
//
// No secrets, no `pg`, no environment: this module is imported by the browser AND by the
// route, which is why the credential lives in `ops-records-service.ts` instead.

import type { AllocateRecordStatus as StoredStatus } from "./allocate-rescue-store";

export const OPS_RECORDS_ENDPOINT = "/api/ops/allocate-records";

/**
 * The lifecycle vocabulary, mirroring the `status` CHECK in 001.
 *
 * `suspected_orphan` is written by the 120s credit poll giving up (ADR-0017 §7, wired in
 * P-OPS v1 point 5) and is what puts a record on the solver's rescue worklist —
 * `listSuspectedOrphans` selects on this value and nothing else. The localStorage store knows
 * it too now, which is what the guard below checks; this type stays the mirror of the
 * DATABASE, not of the store.
 */
export type OpsRecordStatus =
  | "signing"
  | "submitted"
  | "suspected_orphan"
  | "credited"
  | "failed";

export const OPS_RECORD_STATUSES: readonly OpsRecordStatus[] = [
  "signing",
  "submitted",
  "suspected_orphan",
  "credited",
  "failed",
];

// Compile-time guard against the two vocabularies drifting: every status the localStorage
// store can hold must be one the database would accept. If someone adds a value to the store
// without adding it to the DDL, this stops the build instead of failing a live write.
const _storedStatusIsWritable: OpsRecordStatus = null as unknown as StoredStatus;
void _storedStatusIsWritable;

/** One funded leg, base units. Amounts stay STRINGS: they exceed Number.MAX_SAFE_INTEGER. */
export type OpsRecordLeg = { tokenId: string; amount: string };

/**
 * Ceilings mirroring the CHECK constraints in 001, 003_size_bounds.sql and 004.
 *
 * The DATABASE is the authority; these exist so a malformed record is refused with a
 * readable message instead of surfacing a raw Postgres constraint violation, and so the
 * browser can fail before spending a round-trip. They must never be TIGHTER than the DDL —
 * that would reject records the table would have accepted, and the record is the rescue.
 */
export const OPS_RECORD_LIMITS = {
  signerIdMin: 2,
  signerIdMax: 128,
  msgMax: 16_384,
  vaultIdMin: 2,
  vaultIdMax: 64,
  portfolioNameMax: 256,
  legsMax: 64,
  /**
   * The signed envelope, measured as the JSON the route would store.
   *
   * 64 KiB is the ceiling the envelope cannot legitimately reach: the biggest thing inside it
   * is `msg`, capped at 16 KiB by the DDL, and it appears there escaped inside a JSON string
   * (at worst ~2x) plus the payload wrapper. A real envelope is ~1-2 KB.
   *
   * ⚠️ UNLIKE EVERY OTHER CEILING HERE, THIS ONE IS NOT A MIRROR — it is DELIBERATELY TIGHTER
   * than the DDL. `signed_envelope` was unbounded until 2026-08-23, when the solver repo added
   * `004_signed_envelope_bound.sql` (`length(signed_envelope::text) <= 131072`) — twice this
   * value, so this validator still refuses first and with a readable message. Keeping the two
   * numbers apart is intentional and must not be "fixed" by raising this one to match.
   *
   * The gap exists because THE TWO SIDES DO NOT MEASURE THE SAME THING. We count UTF-16 units
   * of `JSON.stringify`; the CHECK counts characters of Postgres's own jsonb rendering, which
   * inserts `": "` and `", "` we never emit — a legitimate document of many small entries
   * arrives up to 1.21x larger than we measured it.
   *
   * And one thing we structurally CANNOT catch, which is why 004 was written: jsonb stores
   * numbers as `numeric`. `1e308` is six characters to us and 309 digits to Postgres, so an
   * array of them passes this ceiling and lands as ~2.9 MB in a row nobody can delete. That
   * expansion has not happened yet at the point we validate. The DDL is the backstop for it;
   * this ceiling is the readable error for everything else.
   */
  signedEnvelopeMax: 65_536,
} as const;

/** POST body — the insert, written BEFORE the signature is requested (ADR-0017 §4). */
export type CreateAllocateRecordBody = {
  /** `crypto.randomUUID()` from the browser; the PRIMARY KEY, so a retry is a no-op. */
  id: string;
  signerId: string;
  /** RAW AuthCallMsg, verbatim as signed. The sha256 pre-image — never rebuild it. */
  msg: string;
  vaultId: string;
  portfolioName: string;
  legs: OpsRecordLeg[];
  /** Browser clock, epoch ms. The database stamps its own `received_at` separately. */
  createdAt: number;
};

/** PATCH body — the lifecycle columns, the only ones the writer credential may update. */
export type PatchAllocateRecordBody = {
  id: string;
  status?: OpsRecordStatus;
  /**
   * The canonical MultiPayload, verbatim as `prepareSwapSignedData` returned it.
   *
   * NOT a best-effort field, and NOT one the caller may reshape. ADR-0017 §5 was amended on
   * 2026-08-18 (D-289): the solver's rescue tool REFUSES TO SIGN a credit without it, because
   * attribution needs three things this object carries and nothing else does — the signature,
   * the sibling `Transfer` intent naming the vault, and the nonce `intents.near` burns on
   * execution. A record with no envelope is evidence, not something rescuable with the Solver
   * key; only `claim_orphan_transfer` (implicit accounts) is left.
   *
   * It is stored raw for the same reason `msg` is: `rescue/envelope.ts` in the solver reads
   * `{standard, payload, public_key, signature}` off it and re-derives the signed digest.
   */
  signedEnvelope?: unknown;
  txHash?: string;
  error?: string;
};

export type OpsRecordErrorCode =
  | "not-configured"
  | "bad-request"
  | "too-many-requests"
  | "not-found"
  /** PATCH only: the record already holds a different signed envelope (write-once, D-449). */
  | "conflict"
  | "write-failed";

export type OpsRecordResponseBody =
  | {
      ok: true;
      id: string;
      /** POST only. False when the id was already present — a retry, not a duplicate. */
      created?: boolean;
      /** PATCH only. */
      updated?: boolean;
    }
  | { ok: false; code: OpsRecordErrorCode; error: string };

// ── Rescue verdicts (D-448) ─────────────────────────────────────────────────────────────
//
// The solver's final word on a record, from `allocate_rescue_verdict`
// (`intentfolio-solver/db/migrations/005_allocate_rescue_verdict.sql`). Read-only from here.

export const OPS_VERDICTS_ENDPOINT = "/api/ops/allocate-verdicts";

/**
 * Mirrors the `verdict` CHECK in 005. Every one is permanent.
 *   - `credited`: a credit path ran (the vault held a seal). Wins over anything else.
 *   - `never_executed`: past the AuthCall deadline, nothing moved.
 *   - `orphan_escalated`: past the deadline, the funds reached the vault and were never
 *     credited. The team's way out (a Return or a repair) does not change it.
 */
export type AllocateVerdict = "credited" | "never_executed" | "orphan_escalated";

export const ALLOCATE_VERDICTS: readonly AllocateVerdict[] = ["credited", "never_executed", "orphan_escalated"];

/** Ids per request. The browser batches above it; a real store holds a handful of candidates. */
export const ALLOCATE_VERDICT_IDS_MAX = 20;

/** POST body. */
export type AllocateVerdictsBody = { ids: string[] };

/** Keyed by lower-cased record id; a record with no verdict is absent — "not decided yet". */
export type AllocateVerdictsResponseBody =
  | { ok: true; verdicts: Record<string, AllocateVerdict> }
  | { ok: false; code: "bad-request" | "too-many-requests" | "not-configured" | "read-failed"; error: string };
