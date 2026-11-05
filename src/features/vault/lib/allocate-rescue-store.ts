"use client";

// Anti-orphan record for ② Allocate (007.plan, Phase 1). THE safety net of the whole
// round-trip — read this before changing anything here.
//
// The failure it exists for: an Allocate is a `[Transfer, AuthCall]`. The Transfer can
// SETTLE (funds leave General Balance, land on the vault) while the vault's `on_auth`
// FAILS. The funds are then stranded — held by the vault but credited to no portfolio.
// The only way out is the operator calling the solver-gated
// `credit_pending_allocation {signer_id, msg}` on the vault.
//
// That rescue needs the EXACT RAW `msg` bytes that were signed: the contract sha256's them
// and compares (allocate.rs). A re-serialisation that differs by one byte — a reordered
// key, a re-encoded number — produces a different hash and the rescue fails. So we persist
// the raw string verbatim, never a parsed-and-rebuilt object.
//
// Consequences for this module, all deliberate:
//   - `recordPendingAllocate` THROWS if it cannot persist. Unlike portfolio-draft-store,
//     which may swallow quota errors, a lost record here can mean unrecoverable funds. The
//     caller must abort BEFORE asking the wallet to sign.
//   - The record is written BEFORE signing, so a crash between signing and submitting still
//     leaves a recoverable trail.
//   - It also console.log's the record as a second, independent channel: a wet test with
//     devtools open keeps a copy even if localStorage is later cleared. The signed envelope
//     is the exception: logged only when opted in (D-472, `vault-debug-log.ts`).
//   - Credited records are marked, not deleted. They are the evidence trail of a wet test
//     and they are tiny; only `clearAllocateRecords` (operator tooling) removes them.

import { logSignedEnvelope } from "./vault-debug-log";

const KEY = "vault.allocate-rescue.v1";

/**
 * The lifecycle, in the DDL's own order (`001_allocate_rescue_record.sql`).
 *
 * `suspected_orphan` is the 120s credit poll giving up (ADR-0017 §7) — or, since FE #5, the
 * submit seeing the vault's `on_auth` receipt fail under a settled Transfer — and it is the value the
 * SOLVER's worklist selects on — `listSuspectedOrphans` reads `status = 'suspected_orphan'` and
 * nothing else — so a record left at `submitted` is invisible to the watchdog however stranded
 * its funds are. Local semantics are unchanged: `listUnresolvedAllocateRecords` already keeps
 * everything that is not `credited`.
 *
 * Attribution: see ATTRIBUTIONS.md #17.
 */
export type AllocateRecordStatus =
  | "signing"
  | "submitted"
  | "suspected_orphan"
  | "credited"
  | "failed";

export type AllocateRescueRecord = {
  id: string;
  /** `signer_id` argument of credit_pending_allocation. */
  signerId: string;
  /** RAW AuthCall msg, verbatim as signed. The sha256 pre-image — never rebuild it. */
  msg: string;
  vaultId: string;
  /** Human context for identifying the record during a manual rescue. */
  portfolioName: string;
  /**
   * Every funded leg, base units. A list and not a single `{tokenId, amount}` since Phase 2
   * (008.plan): an Allocate may fund several tokens in one Transfer, and a rescue is decided
   * by a human reading this record — showing only the first leg would understate what is
   * stranded. Records written before Phase 2 have no `legs`; the `msg` next to it is the
   * only field the rescue itself needs, so those stay usable.
   */
  legs: Array<{ tokenId: string; amount: string }>;
  createdAt: number;
  status: AllocateRecordStatus;
  /**
   * The canonical MultiPayload, written between the signature and the submit (ADR-0017 §5 as
   * amended, D-289). The `msg` above is what a rescue REPLAYS; this is what proves the funds
   * being replayed are this signer's — the signature, the sibling Transfer naming the vault,
   * and the nonce `intents.near` burns on execution.
   *
   * It lives here and not only in the database because the database is behind a flag that
   * defaults off: without this, a deployment with `NEXT_PUBLIC_OPS_RECORDS` unset would store
   * no envelope anywhere at all, and every record it produced would be un-rescuable with the
   * Solver key. Records written before this field exists simply do not have it.
   */
  signedEnvelope?: unknown;
  /**
   * The envelope's V1 nonce, base64 — the id `intents.near` burns on execution — and the
   * envelope's own deadline (D-312). Together they answer "did this envelope EVER execute?"
   * without parsing the signed payload of each scheme: past the envelope deadline, an unused
   * nonce under a still-valid salt means it never ran and never will. Local only (the ops row
   * is built field by field and does not carry them); records written before D-312 lack both.
   */
  verifierNonce?: string;
  envelopeDeadlineSecs?: number;
  /**
   * When this browser recorded that the envelope never executed (`markAllocateRecordNeverExecuted`,
   * D-556). What tells a `failed` the user still has to hear about from a revert or a refusal, whose
   * modal already said so, and from a `failed` written before this notice existed. Local only.
   */
  neverExecutedAt?: number;
  /** When the user dismissed the "your deposit didn't go through" notice (D-556). Local only. */
  notExecutedNoticeDismissedAt?: number;
  txHash?: string;
  error?: string;
};

type RescueStore = Record<string, AllocateRescueRecord>; // id -> record

function readStore(): RescueStore {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as RescueStore;
  } catch {
    /* corrupt storage — start fresh rather than blocking a new allocate */
  }
  return {};
}

// Throws on failure by design: callers treat a failed write as "do not sign".
function writeStore(store: RescueStore): void {
  if (typeof window === "undefined") {
    throw new Error("allocate rescue record: no window (cannot persist)");
  }
  window.localStorage.setItem(KEY, JSON.stringify(store));
}

export type RecordPendingAllocateParams = Omit<
  AllocateRescueRecord,
  "id" | "createdAt" | "status" | "txHash" | "error" | "neverExecutedAt" | "notExecutedNoticeDismissedAt"
> & {
  /**
   * Injected by `allocate-record-sink.ts` so the localStorage copy and the database row are
   * ONE record with one identity. The id is the database's primary key, which is what makes a
   * retry after a lost response a no-op instead of a duplicate (ADR-0017 §4) — generating a
   * second one here would break that. Omitted, it is minted locally as before.
   */
  id?: string;
  /** Injected with `id`, for the same reason: both channels must agree on the clock. */
  createdAt?: number;
};

/**
 * Persist the rescue record. Call this BEFORE requesting the signature; if it throws,
 * abort the allocate instead of signing.
 */
export function recordPendingAllocate(params: RecordPendingAllocateParams): string {
  const record: AllocateRescueRecord = {
    ...params,
    id: params.id ?? crypto.randomUUID(),
    createdAt: params.createdAt ?? Date.now(),
    status: "signing",
  };
  const store = readStore();
  store[record.id] = record;
  writeStore(store);

  // Second channel — survives a cleared localStorage in an open session.
  console.log("[vault] allocate rescue record persisted", record);
  return record.id;
}

/** Best-effort status update. A lost status update is recoverable; a lost msg is not. */
export function updateAllocateRecord(
  id: string,
  patch: Partial<
    Pick<AllocateRescueRecord, "status" | "txHash" | "error" | "neverExecutedAt" | "notExecutedNoticeDismissedAt">
  >
): void {
  try {
    const store = readStore();
    const existing = store[id];
    if (!existing) return;
    store[id] = { ...existing, ...patch };
    writeStore(store);
    // After the signature the record carries the envelope: the status line leaves it out (D-472).
    console.log("[vault] allocate rescue record updated", { ...store[id], signedEnvelope: undefined });
  } catch {
    /* status is a convenience; never block the flow on it */
  }
}

/**
 * Attaches the signed envelope. THROWS on failure, unlike `updateAllocateRecord` above.
 *
 * The difference is deliberate and it is the same rule as `recordPendingAllocate`: a status is
 * a convenience, an envelope is evidence. Call this AFTER the signature and BEFORE submitting,
 * so that a failure aborts while nothing has moved (ADR-0017 §5, D-289).
 *
 * A missing record throws rather than returning quietly: it means the local copy of an
 * in-flight Allocate is gone, which is exactly the state this store must not report as fine.
 */
export function recordSignedEnvelope(id: string, signedEnvelope: unknown): void {
  const store = readStore();
  const existing = store[id];
  if (!existing) {
    throw new Error(`allocate rescue record ${id} is not in local storage (cannot attach the envelope)`);
  }
  store[id] = { ...existing, signedEnvelope };
  writeStore(store);
  // Second channel, same as the initial write: a session with devtools open keeps a copy of
  // the envelope even if localStorage is later cleared. Opt-in only (D-472, `vault-debug-log.ts`):
  // the envelope is submittable by any account until its deadline.
  logSignedEnvelope("[vault] allocate rescue record envelope stored", store[id]);
}

export function listAllocateRecords(): AllocateRescueRecord[] {
  return Object.values(readStore()).sort((a, b) => b.createdAt - a.createdAt);
}

/** Records that may correspond to stranded funds — the manual-rescue worklist. */
export function listUnresolvedAllocateRecords(): AllocateRescueRecord[] {
  return listAllocateRecords().filter((r) => r.status !== "credited");
}

/** Operator tooling only. Deletes the evidence trail. */
export function clearAllocateRecords(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(KEY);
}
