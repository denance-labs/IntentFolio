"use client";

// The withdrawal record's TWO channels, behind the store's own three writes (ADR-0025).
//
// Same signatures as `withdraw-rescue-store.ts`, so the call sites only change their import:
//   - localStorage FIRST and unchanged. It is still the fail-closed channel — if
//     `recordPendingWithdraw` throws, nothing is published (D-190).
//   - the ops database SECOND, best-effort: fired with `keepalive`, never awaited, never
//     throwing. A withdrawal does not wait for it and does not stop for it (ADR-0025 §2).
//
// Writes for one record go out IN ORDER: each PATCH waits for the one before it, and the first
// one waits for the POST. Without that, a `published` sent while the INSERT is still in flight
// would reach the table first, match no row, and be lost. A PATCH lost anyway (the page died,
// the database was down) costs nothing: the solver resolves every record on its own evidence,
// and these columns are hints to it (ADR-0025 §4).
//
// `dismissWithdrawRecord` is deliberately NOT wrapped: hiding a record is the user's display
// preference and never leaves the browser.

import { WITHDRAW_RECORDS_ENABLED } from "./withdraw-records-flag";
import {
  getWithdrawRecord,
  recordPendingWithdraw as storeRecordPendingWithdraw,
  resolveUnansweredPublish as storeResolveUnansweredPublish,
  updateWithdrawRecord as storeUpdateWithdrawRecord,
  type RecordPendingWithdrawParams,
  type WithdrawRescueRecord,
} from "./withdraw-rescue-store";
import { sendWithdrawRecord, type WithdrawRecordSendResult } from "./withdraw-records-client";
import type {
  CreateWithdrawRecordBody,
  PatchWithdrawRecordBody,
  WithdrawWireStatus,
} from "./withdraw-records-types";

type RecordPatch = Parameters<typeof storeUpdateWithdrawRecord>[1];

/** The tail of each record's write chain. Dropped once it drains, so the map stays small. */
const queues = new Map<string, Promise<void>>();

function enqueue(id: string, task: () => Promise<WithdrawRecordSendResult>, what: string): void {
  const run = async () => {
    const result = await task();
    if (!result.ok) {
      // Second channel, as everywhere else in this store: devtools keep a trace of what the
      // database did not get. Ids and codes only — no amounts or addresses.
      console.warn(`[withdraw] ops ${what} not stored for ${id} (${result.code}): ${result.message}`);
    }
  };
  const tail = (queues.get(id) ?? Promise.resolve()).then(run, run);
  queues.set(id, tail);
  void tail.finally(() => {
    if (queues.get(id) === tail) queues.delete(id);
  });
}

function toCreateBody(record: WithdrawRescueRecord, signedPayload: unknown): CreateWithdrawRecordBody | null {
  // 006 requires both: without them the solver cannot resolve the record past the relay's
  // memory. Every writer passes them since D-463, so this only guards a future regression.
  if (record.nonce === undefined || record.deadline === undefined) return null;
  const base = {
    id: record.id,
    signerId: record.signerId,
    tokenId: record.tokenId,
    amount: record.amount,
    chainId: record.chainId,
    destinationAddress: record.destinationAddress,
    // An empty memo is no memo: 006 stores absence as NULL, never as ''.
    ...(record.destinationMemo ? { destinationMemo: record.destinationMemo } : {}),
    nonce: record.nonce,
    deadline: record.deadline,
    signedPayload,
    createdAt: record.createdAt,
  };
  return record.kind === "conversion"
    ? { ...base, kind: "conversion", conversion: record.conversion }
    : { ...base, kind: "direct", route: record.route };
}

/**
 * The part of a store patch the table holds; null when nothing in it is mirrored. An EMPTY hash
 * is dropped, not sent: the bridge can answer `""` for a destination tx (`run-real-withdraw.ts`
 * keeps it locally on purpose), the route refuses an empty hash, and the refusal would take the
 * `delivered` travelling with it.
 */
function toPatchBody(id: string, patch: RecordPatch): PatchWithdrawRecordBody | null {
  const body: PatchWithdrawRecordBody = { id };
  if (patch.status !== undefined && patch.status !== "dismissed") {
    body.status = patch.status as WithdrawWireStatus;
  }
  if (patch.intentHash) body.intentHash = patch.intentHash;
  if (patch.txHash) body.txHash = patch.txHash;
  if (patch.destinationTxHash) body.destinationTxHash = patch.destinationTxHash;
  if (patch.error !== undefined) body.error = patch.error;
  return Object.keys(body).length > 1 ? body : null;
}

function mirrorPatch(id: string, patch: RecordPatch): void {
  if (!WITHDRAW_RECORDS_ENABLED) return;
  try {
    const body = toPatchBody(id, patch);
    if (body) enqueue(id, () => sendWithdrawRecord("PATCH", body), "update");
  } catch {
    /* best-effort: never let the mirror break the withdrawal it follows */
  }
}

/**
 * Persists the trace — localStorage first, and THROWS if that fails, exactly as before: do not
 * publish. Then queues the database insert, which nobody waits for.
 *
 * `signedPayload` is the MultiPayload about to be published. It goes to the database only, not
 * to localStorage: the browser re-checks by nonce and relay, and has no use for it.
 */
export function recordPendingWithdraw(params: RecordPendingWithdrawParams, signedPayload: unknown): string {
  const id = storeRecordPendingWithdraw(params);
  if (!WITHDRAW_RECORDS_ENABLED) return id;
  try {
    const record = getWithdrawRecord(id);
    const body = record ? toCreateBody(record, signedPayload) : null;
    if (body) {
      enqueue(id, () => sendWithdrawRecord("POST", body), "record");
    } else {
      console.warn(`[withdraw] ops record not sent for ${id}: no nonce or deadline to resolve it by`);
    }
  } catch {
    /* best-effort */
  }
  return id;
}

/** Best-effort progress update, on both channels. */
export function updateWithdrawRecord(id: string, patch: RecordPatch): void {
  storeUpdateWithdrawRecord(id, patch);
  mirrorPatch(id, patch);
}

/**
 * D-463's guarded write: applied only while the publish is still unanswered locally. Mirrored
 * only when it wrote — a verdict another tab already overtook is not news to anyone.
 */
export function resolveUnansweredPublish(id: string, patch: RecordPatch): boolean {
  const wrote = storeResolveUnansweredPublish(id, patch);
  if (wrote) mirrorPatch(id, patch);
  return wrote;
}
