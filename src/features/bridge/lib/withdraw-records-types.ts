// Wire contract between the browser and `/api/ops/withdraw-records` (ADR-0025).
//
// The table it lands in is a contract between two repositories: the DDL lives in the solver
// (`intentfolio-solver/db/migrations/006_withdraw_record.sql`) and this side matches it. A
// nullable column is safe from either side; anything else lands here first (see
// `intentfolio-solver/db/README.md`).
//
// No secrets, no `pg`, no environment: this module is imported by the browser AND by the
// route, which is why the credential lives in `ops-records-service.ts` instead.

import type { SupportedWithdrawRoute } from "./withdraw-envelope";
import type { ConversionRecordDetails, WithdrawRecordStatus } from "./withdraw-rescue-store";

export const WITHDRAW_RECORDS_ENDPOINT = "/api/ops/withdraw-records";

/**
 * The lifecycle vocabulary, mirroring the `status` CHECK in 006.
 *
 * The browser store's vocabulary minus `dismissed`: hiding a record is the user's display
 * preference and says nothing about where the money is, so it never leaves the browser
 * (ADR-0025 §4). Every value here is a HINT — the solver resolves each record on its own.
 */
export type WithdrawWireStatus = Exclude<WithdrawRecordStatus, "dismissed">;

export const WITHDRAW_WIRE_STATUSES: readonly WithdrawWireStatus[] = [
  "publishing",
  "published",
  "settled",
  "delivered",
  "failed",
  "refunded",
];

/** The routes 006 accepts. A route the registry adds later needs a migration there first. */
export const WITHDRAW_WIRE_ROUTES: readonly SupportedWithdrawRoute[] = [
  "omft",
  "hot-omni",
  "near-native",
  "near-unwrap",
];

/**
 * Ceilings mirroring the CHECK constraints in 006. The DATABASE is the authority; these exist
 * so a malformed record is refused with a readable message. Never tighter than the DDL.
 */
export const WITHDRAW_RECORD_LIMITS = {
  signerIdMin: 2,
  signerIdMax: 128,
  tokenIdMax: 256,
  /** Decimal width of u256 — far above anything a token can hold. */
  amountDigitsMax: 78,
  chainIdMax: 64,
  destinationAddressMax: 256,
  destinationMemoMax: 256,
  nonceMax: 128,
  /**
   * The one ceiling DELIBERATELY TIGHTER than the DDL (4096). We measure `JSON.stringify`; the
   * CHECK measures Postgres's jsonb rendering, which adds `": "`/`", "` and runs up to ~1.2x
   * larger — so matching 4096 here would let a record pass this check and fail the table's.
   * A real quote is ~400 characters.
   */
  conversionMax: 3_000,
  /**
   * The signed MultiPayload, measured as `JSON.stringify`. Half the DDL's 65536 on purpose, for
   * the same reason as `conversionMax`: Postgres renders jsonb larger than we measure. A real
   * one is ~1-2 KB.
   */
  signedPayloadMax: 32_768,
  intentHashMax: 128,
  txHashMax: 128,
  destinationTxHashMax: 256,
  /** The DDL allows 2048; the route truncates to this, as the Allocate route does. */
  errorMax: 2_000,
} as const;

/** POST body — the insert, sent after the signature and before the publish (ADR-0025 §1). */
export type CreateWithdrawRecordBody = {
  /** The localStorage record's id; the PRIMARY KEY, so a retry is a no-op. */
  id: string;
  kind: "direct" | "conversion";
  signerId: string;
  tokenId: string;
  /** Base units. A string: it exceeds Number.MAX_SAFE_INTEGER. */
  amount: string;
  chainId: string;
  /** Direct withdrawals only. */
  route?: SupportedWithdrawRoute;
  destinationAddress: string;
  destinationMemo?: string;
  /** base64 of the signed nonce. */
  nonce: string;
  /** When the signed envelope stops being executable, epoch ms. */
  deadline: number;
  /** Conversions only. */
  conversion?: ConversionRecordDetails;
  /**
   * The MultiPayload exactly as it is handed to the relay (`signed_data`). Lets the solver
   * derive the intent hash itself when the tab dies before the relay answers, and check the
   * record against what was really signed (ADR-0025 §1, amended).
   */
  signedPayload: unknown;
  /** Browser clock, epoch ms. The database stamps its own `received_at`. */
  createdAt: number;
};

/** PATCH body — the lifecycle hints, the only columns the writer credential may update. */
export type PatchWithdrawRecordBody = {
  id: string;
  status?: WithdrawWireStatus;
  intentHash?: string;
  txHash?: string;
  destinationTxHash?: string;
  error?: string;
};

export type WithdrawRecordErrorCode =
  | "not-configured"
  | "bad-request"
  | "too-many-requests"
  | "not-found"
  | "write-failed";

export type WithdrawRecordResponseBody =
  | {
      ok: true;
      id: string;
      /** POST only. False when the id was already present — a retry, not a duplicate. */
      created?: boolean;
      /** PATCH only. */
      updated?: boolean;
    }
  | { ok: false; code: WithdrawRecordErrorCode; error: string };

// ── Server verdicts (024-D) ─────────────────────────────────────────────────────────────
//
// The solver's FINAL word on a record, from `withdraw_verdict` (006). The one narrow read
// ADR-0025 §9 allows: by record id, the verdict and its two tx hashes, nothing of the record.

export const WITHDRAW_VERDICTS_ENDPOINT = "/api/ops/withdraw-verdicts";

/**
 * The final verdicts of 006 — the only ones read. `settled` and the escalations are not: they
 * close nothing, and the browser's own re-checks already say "in progress" or "unconfirmed".
 *   - `delivered`: the funds reached the destination.
 *   - `refunded`: a conversion 1Click sent back to the General Balance.
 *   - `never_executed`: past the deadline with the nonce unused — nothing left the balance.
 */
export type WithdrawFinalVerdict = "delivered" | "refunded" | "never_executed";

export const WITHDRAW_FINAL_VERDICTS: readonly WithdrawFinalVerdict[] = ["delivered", "refunded", "never_executed"];

/** One record's verdict. The hashes come from the verdict's `detail`, and only when it names them. */
export type WithdrawVerdictAnswer = {
  verdict: WithdrawFinalVerdict;
  txHash?: string;
  destinationTxHash?: string;
};

/** Keyed by lower-cased record id; a record with no final verdict is absent — "not decided yet". */
export type WithdrawVerdictsResponseBody =
  | { ok: true; verdicts: Record<string, WithdrawVerdictAnswer> }
  | { ok: false; code: "bad-request" | "too-many-requests" | "not-configured" | "read-failed"; error: string };
