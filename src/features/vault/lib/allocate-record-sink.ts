"use client";

// The Allocate rescue record's TWO channels, behind one call (ADR-0017 §2-5, P-OPS v1 points 3-4).
//
// Two of the three writes here are FAIL-CLOSED, at the only two instants where that still
// stops funds from moving: the record before the signature (§4) and the envelope before the
// submit (§5, amended 2026-08-18 — D-289). Everything after the submit is best-effort,
// because by then there is nothing left to fail closed on.
//
// Until this module the only copy of the sha256 pre-image lived in the user's browser. A
// cleared storage, a new device, or a user who never reports the problem, and stranded funds
// became unrecoverable — the solver never sees that payload, because it is not on the Allocate
// path. So the record now goes to two places, and this is the only module that knows that:
// `allocate-rescue-store.ts` stays purely localStorage, `ops-records-client.ts` stays purely
// HTTP, and callers get one function whose failure rule is the safety property.
//
// THE ORDER IS DELIBERATE, and it is not "cheap thing first". Both writes are fail-closed, so
// whichever runs second leaves a stray record behind when the other one has already succeeded
// and the Allocate then aborts. localStorage goes first because ITS stray is local noise on
// the user's own worklist (and is marked `failed` below), whereas a stray database row sits on
// the SOLVER's rescue worklist and puts a human on the trail of an Allocate that never
// happened. Cheap-and-synchronous is a bonus, not the reason.

import { OPS_RECORDS_ENABLED } from "./vault-flag";
import {
  recordPendingAllocate,
  recordSignedEnvelope,
  updateAllocateRecord,
  type AllocateRescueRecord,
  type RecordPendingAllocateParams,
} from "./allocate-rescue-store";
import {
  postAllocateRecord,
  patchAllocateRecord,
  patchAllocateRecordResult,
  patchSignedEnvelope,
} from "./ops-records-client";

export type PersistAllocateRecordParams = Omit<RecordPendingAllocateParams, "id" | "createdAt">;

/**
 * Persists the rescue record to both channels and returns the shared id.
 *
 * THROWS if either channel fails — the caller must abort the Allocate rather than sign. This
 * is the fail-closed rule of ADR-0017 §4, and it is the same rule the localStorage store has
 * always applied on its own; the database simply adds a second way to fail.
 *
 * The consequence to keep in view: with the flag on, a database outage stops every Allocate.
 * That is the accepted trade (the alternative is signing with no rescue net), which is why the
 * error text has to say what happened and that nothing was signed.
 */
export async function persistAllocateRecord(
  params: PersistAllocateRecordParams
): Promise<string> {
  // Minted here, once, and handed to both channels: the id is the database's primary key, so
  // a retry after a lost response must reuse it to be a no-op instead of a duplicate.
  const id = crypto.randomUUID();
  const createdAt = Date.now();

  recordPendingAllocate({ ...params, id, createdAt });
  if (!OPS_RECORDS_ENABLED) return id;

  try {
    const { created } = await postAllocateRecord({
      id,
      signerId: params.signerId,
      msg: params.msg,
      vaultId: params.vaultId,
      portfolioName: params.portfolioName,
      legs: params.legs,
      createdAt,
    });
    if (!created) {
      // The id was already in the table. With a fresh randomUUID that means a retry whose
      // response was lost, not a collision — worth one line, never a failure.
      console.log(`[ops] rescue record ${id} was already stored (retry of a lost response)`);
    }
  } catch (e) {
    // Keep the local worklist truthful: nothing was signed, so this record can never
    // correspond to stranded funds and must not sit there looking unresolved.
    updateAllocateRecord(id, {
      status: "failed",
      error: `rescue record not stored off-client: ${describe(e)}`,
    });
    throw new Error(
      `The rescue record could not be stored, so nothing was signed and no funds moved. ` +
        `${describe(e)} — try again in a moment.`
    );
  }

  return id;
}

/**
 * Persists the signed envelope on both channels. THROWS if either fails.
 *
 * The SECOND fail-closed gate of the Allocate, and the reason it is a separate function rather
 * than a field on `AllocateRecordPatch` below: routing the envelope through the best-effort
 * patch would make it silently droppable, which is the exact thing ADR-0017 §5 was amended on
 * 2026-08-18 to stop (D-289). Keeping `signedEnvelope` out of that type is what makes "the
 * envelope can only be written fail-closed" a property the compiler holds, not a convention.
 *
 * Ordering matches `persistAllocateRecord`: localStorage first, so the stray left behind by an
 * abort is local noise rather than a half-updated row on the solver's worklist.
 *
 * The caller must run this BETWEEN the signature and the submit. That is the last instant at
 * which throwing is safe: nothing has been sent, so an abort costs a signature the user has to
 * approve again and cannot strand anything. Run after the submit, it would be a fail-closed
 * gate on a horse that already left.
 */
export async function persistSignedEnvelope(
  id: string,
  signedEnvelope: unknown
): Promise<void> {
  try {
    recordSignedEnvelope(id, signedEnvelope);
    if (OPS_RECORDS_ENABLED) await patchSignedEnvelope(id, signedEnvelope);
  } catch (e) {
    throw new Error(
      `The signed envelope could not be stored, so nothing was submitted and no funds moved. ` +
        `${describe(e)} — try again; you will be asked to sign once more.`
    );
  }
}

export type AllocateRecordPatch = Partial<
  Pick<AllocateRescueRecord, "status" | "txHash" | "error">
>;

/**
 * Best-effort lifecycle update on both channels. NEVER throws.
 *
 * A lost status update is recoverable — the record, its `msg` and its envelope are already
 * stored, and the solver cross-checks on-chain evidence before acting on any of it. A lost
 * pre-image or a lost envelope is not, which is why the two functions above are the only ones
 * allowed to fail an Allocate.
 */
export async function updateAllocateRecordEverywhere(
  id: string,
  patch: AllocateRecordPatch
): Promise<void> {
  updateAllocateRecord(id, patch);
  if (!OPS_RECORDS_ENABLED) return;
  await patchAllocateRecord({ id, ...patch });
}

/**
 * Flips a `suspected_orphan` record to `credited` once its on-chain seal has been seen
 * (009.plan FE #4, `922` H4). NEVER throws. Returns whether the local record was flipped.
 *
 * THE ORDER IS THE INVERSE of the three functions above — DATABASE FIRST, local after — and
 * that is the whole function. Those three write local-first so the user's own copy stays
 * truthful when the database is down. Here the database IS the objective: the row is what
 * sits on the solver's worklist. Written local-first, a lost PATCH would leave the local copy
 * saying `credited`, nothing would ever re-check it, and the row would stay `suspected_orphan`
 * for good — the one case this exists for, failed silently. So the local flip happens only
 * once the database has the status, and a failed PATCH leaves the local record as it was,
 * which is what makes the next app load retry it.
 *
 * `not-found` is not a failure: it is a record from before the database existed (localStorage
 * only), with nothing to fix off-client. Treated as failure, it would be re-checked on every
 * load forever.
 *
 * The caller decides monotonicity (only a local `suspected_orphan` with a seal reaches here);
 * the database does not enforce it.
 */
export async function confirmAllocateRecordCredited(id: string): Promise<boolean> {
  if (OPS_RECORDS_ENABLED) {
    const result = await patchAllocateRecordResult({ id, status: "credited" });
    if (!result.ok && result.code !== "not-found") {
      console.warn(
        `[ops] rescue record ${id} is credited on-chain but the database was not updated — kept for the next load`,
        result.message
      );
      return false;
    }
  }
  updateAllocateRecord(id, { status: "credited" });
  return true;
}

/** What a record flipped by `markAllocateRecordNeverExecuted` says, on both channels. */
export const NEVER_EXECUTED_ERROR =
  "The signed envelope expired unused (nonce not burnt, salt valid): it never executed and never will";

/**
 * Flips a `submitted`/`signing` record whose envelope provably never executed to `failed`
 * (D-295). NEVER throws. Returns whether the local record was flipped.
 *
 * Database first, local after — the same order as `confirmAllocateRecordCredited`, and for the
 * same reason: the row a human reads during an incident must not keep saying "sent" once the
 * local copy has stopped. A failed PATCH leaves the local record as it was, so the next load
 * retries — for as long as the proof holds (the nonce's own deadline, ~10 days after signing).
 * `not-found` is a record from before the database existed, with nothing to fix off-client.
 */
export async function markAllocateRecordNeverExecuted(id: string): Promise<boolean> {
  if (OPS_RECORDS_ENABLED) {
    const result = await patchAllocateRecordResult({ id, status: "failed", error: NEVER_EXECUTED_ERROR });
    if (!result.ok && result.code !== "not-found") {
      console.warn(
        `[ops] rescue record ${id} provably never executed but the database was not updated — kept for the next load`,
        result.message
      );
      return false;
    }
  }
  updateAllocateRecord(id, { status: "failed", error: NEVER_EXECUTED_ERROR });
  return true;
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
