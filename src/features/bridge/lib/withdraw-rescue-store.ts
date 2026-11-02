"use client";

// Durable trace of a withdrawal that may be in flight (005.plan §8, Phase 5, block 5.3 — D-190).
//
// The gap it closes: a published withdrawal lived only in memory. Close the tab between the
// publish and the settlement and the `intentHash` is gone, and with it any way to re-check
// what happened. `WithdrawSettlementUnconfirmedError` carries the hash, but an exception is
// not storage.
//
// WHY IT IS NOT A COPY OF allocate-rescue-store.ts, EVEN THOUGH IT LOOKS LIKE ONE
// The Allocate store holds the sha256 PRE-IMAGE (`msg`) that `credit_pending_allocation`
// consumes: lose those exact bytes and stranded funds become unrecoverable, so it persists
// BEFORE the signature — the artifact does not exist earlier and cannot be rebuilt.
// A withdrawal has no such artifact. Every field below is reproducible from the user's own
// input, no contract call consumes this record, and an unpublished signature is inert: it
// moves nothing and costs nothing to discard.
//
// WHEN IT IS WRITTEN: after the signature, immediately before the publish (D-190, option a).
//   - Not after the publish: the request can be sent and the answer never arrive — exactly
//     the `WithdrawPublishUnknownError` case — and that window would leave no trace at all.
//   - Not before the signature (the Allocate moment): the earliest instant a withdrawal can
//     move money is the publish, and writing earlier would file a record for every wallet
//     prompt the user cancels. This worklist is only worth reading if everything on it might
//     really be in flight; padding it with cancellations is how a safety net gets ignored.
//
// WHEN IT IS CLEARED (see `pruneResolved`):
//   - UNRESOLVED records (`publishing` / `published` / `settled`) are never pruned, at any
//     age. They are the entire reason the store exists, and "old" is not evidence of
//     anything: our timeouts bound what we REPORT, not what the relay and the bridge do.
//   - RESOLVED records (`delivered`, `failed`, `refunded`, `dismissed`) are kept as the wet-test evidence
//     trail and dropped after RESOLVED_RETENTION_MS. Bounded, so the store cannot grow forever.
//   - `clearWithdrawRecords()` deletes everything; operator tooling only.
//
// A record is marked `failed` ONLY on an error whose `fundsState` is `untouched`. That field
// is fixed by the 5.2 error matrix and is the single source of truth about where the money
// is (withdraw-errors.ts) — resolving a record on anything weaker would drop the one case
// this store exists to keep.
//
// TWO KINDS OF RECORD, ONE KEY (plan 020 §5.4). A Converting Withdrawal (`kind: "conversion"`)
// is written at the same moment and resolved by the same rule, plus one more resolved state:
// `refunded`, set only from 1Click's own `REFUNDED`. Records written before conversions existed
// carry no `kind` and are direct — the key stays `v1` because nothing about them changed.

import type { SupportedWithdrawRoute } from "./withdraw-envelope";

const KEY = "bridge.withdraw-rescue.v1";

/** Resolved records are evidence, not a worklist; 30 days is the bound on that evidence. */
export const RESOLVED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type WithdrawRecordStatus =
  /** Signed and about to be published. The outcome of the publish is not known yet. */
  | "publishing"
  /** The relay returned an intent hash. Settlement not observed. */
  | "published"
  /** Settled on NEAR: the funds have left the General Balance. */
  | "settled"
  /** Delivered on the destination chain (or on NEAR, for `near-native`). Resolved. */
  | "delivered"
  /** Definitively did not move the funds — only ever set from `fundsState: "untouched"`. */
  | "failed"
  /** Conversions only: 1Click sent the money back to the General Balance. Resolved. */
  | "refunded"
  /**
   * D-463 (023-B) — closed by the USER, not by an observation: says nothing about where the money
   * is. Only `dismissWithdrawRecord` sets it, on a record no re-check could close.
   */
  | "dismissed";

const RESOLVED: readonly WithdrawRecordStatus[] = ["delivered", "failed", "refunded", "dismissed"];

/**
 * How long a record must stay open before the user may close it by hand (023 §4.3). Long past
 * every wait this page runs, so a record still moving is answered by a re-check first.
 */
export const DISMISS_AFTER_MS = 24 * 60 * 60 * 1000;

type WithdrawRecordBase = {
  id: string;
  /** The INTENTS account the funds are leaving. */
  signerId: string;
  /** Full defuse asset id of the token that LEAVES the General Balance. */
  tokenId: string;
  /** Base units. Authoritative: `qty` below is the human rendering of this. */
  amount: string;
  /** Human units, as the user entered them. For a person reading the record. */
  qty: number;
  /** Destination chain id (registry-derived) and address, so a re-check knows where to look. */
  chainId: string;
  destinationAddress: string;
  /** Only present for chains that route on a tag; dropping it strands funds at a shared address. */
  destinationMemo?: string;
  createdAt: number;
  status: WithdrawRecordStatus;
  /**
   * D-463 — base64 of the nonce the envelope was signed with, and when that envelope stops being
   * executable (ms). Together they let a reload ask `intents.near` whether the publish ever ran,
   * long after the relay has forgotten the intent hash (`withdraw-publication-check.ts`).
   * Absent on records written before D-463.
   */
  nonce?: string;
  deadline?: number;
  /** The relay's handle for re-checking. Absent when the publish outcome was never learned. */
  intentHash?: string;
  /** The NEAR settlement transaction. Recorded the moment it is known, not at the end. */
  txHash?: string;
  /** The destination-chain transaction, once the bridge (or 1Click) confirms delivery. */
  destinationTxHash?: string;
  /** Conversions only: base units of `tokenId` 1Click sent back, set with `refunded`. */
  refundedAmount?: string;
  /** Conversions only: base units of the Delivery Token 1Click reports delivered, set with `delivered`. */
  deliveredAmount?: string;
  error?: string;
};

/** A direct withdrawal: the held token itself goes out on `route`. Old records have no `kind`. */
export type DirectWithdrawRescueRecord = WithdrawRecordBase & {
  kind?: "direct";
  route: SupportedWithdrawRoute;
};

/**
 * What a Converting Withdrawal's record keeps beyond the base (plan 020 §5.4): the handle 1Click is
 * followed by, what it promised, and its signature over that promise (G7).
 */
export type ConversionRecordDetails = {
  /** The quote's deposit address — what the `transfer` paid and the key `/v0/status` is read by. */
  depositAddress: string;
  /** Full defuse asset id of what arrives on `chainId`. */
  deliveryTokenId: string;
  /** Base units of the Delivery Token expected, and the least that may arrive. */
  amountOut: string;
  minAmountOut: string;
  /** The deadline the quote request asked for (ms). */
  requestedDeadlineMs: number;
  /** 1Click's signature over the quote. */
  quoteSignature: string;
};

export type ConversionWithdrawRescueRecord = WithdrawRecordBase & {
  kind: "conversion";
  conversion: ConversionRecordDetails;
};

export type WithdrawRescueRecord = DirectWithdrawRescueRecord | ConversionWithdrawRescueRecord;

type RescueStore = Record<string, WithdrawRescueRecord>; // id -> record

function readStore(): RescueStore {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as RescueStore;
  } catch {
    /* corrupt storage — start fresh rather than blocking a withdrawal */
  }
  return {};
}

// Throws on failure by design: a caller that cannot persist must not publish.
function writeStore(store: RescueStore): void {
  if (typeof window === "undefined") {
    throw new Error("withdraw rescue record: no window (cannot persist)");
  }
  window.localStorage.setItem(KEY, JSON.stringify(store));
}

export function isResolvedWithdrawRecord(record: WithdrawRescueRecord): boolean {
  return RESOLVED.includes(record.status);
}

/**
 * Drops resolved records past the retention window. Runs on WRITE, never on read: a getter
 * with side effects would delete records during a render, and the read paths are the ones a
 * worried operator uses.
 */
function pruneResolved(store: RescueStore, now: number): RescueStore {
  const kept: RescueStore = {};
  for (const [id, record] of Object.entries(store)) {
    const expired =
      isResolvedWithdrawRecord(record) && now - record.createdAt > RESOLVED_RETENTION_MS;
    if (!expired) kept[id] = record;
  }
  return kept;
}

type WrittenLater =
  | "id"
  | "createdAt"
  | "status"
  | "intentHash"
  | "txHash"
  | "destinationTxHash"
  | "refundedAmount"
  | "deliveredAmount"
  | "error";

/** Distributes over the union, so each kind keeps its own required fields. */
export type RecordPendingWithdrawParams =
  | Omit<DirectWithdrawRescueRecord, WrittenLater>
  | Omit<ConversionWithdrawRescueRecord, WrittenLater>;

/**
 * Persist the trace. Call this AFTER the signature and BEFORE the publish; if it throws,
 * do not publish — a withdrawal we cannot track is worse than a signature thrown away.
 */
export function recordPendingWithdraw(params: RecordPendingWithdrawParams): string {
  const now = Date.now();
  const record: WithdrawRescueRecord = {
    ...params,
    id: crypto.randomUUID(),
    createdAt: now,
    status: "publishing",
  };
  const store = pruneResolved(readStore(), now);
  store[record.id] = record;
  writeStore(store);

  // Second channel — survives a cleared localStorage in an open session, same as the
  // Allocate store. A wet test with devtools open keeps a copy either way.
  console.log("[withdraw] rescue record persisted", record);
  return record.id;
}

/** Best-effort progress update. A lost status is recoverable; a lost record is not. */
export function updateWithdrawRecord(
  id: string,
  patch: Partial<
    Pick<
      WithdrawRecordBase,
      | "status"
      | "intentHash"
      | "txHash"
      | "destinationTxHash"
      | "refundedAmount"
      | "deliveredAmount"
      | "error"
    >
  >
): void {
  try {
    const store = readStore();
    const existing = store[id];
    if (!existing) return;
    const next = { ...existing, ...patch };
    // D-435 — a resolved record is never reopened: another tab sharing this store may have closed
    // it after this one's live run last looked. The other fields of the patch still land.
    if (isResolvedWithdrawRecord(existing) && !isResolvedWithdrawRecord(next)) next.status = existing.status;
    store[id] = next;
    writeStore(store);
    console.log("[withdraw] rescue record updated", store[id]);
  } catch {
    /* progress is a convenience; never block the withdrawal on it */
  }
}

/**
 * D-463 — applies a re-check's verdict ONLY if the publish is still unanswered (`publishing` /
 * `published`), read right before the write. Another tab may have finished the same withdrawal
 * while this one was asking the chain; a blind merge would reopen a `delivered` record as
 * `settled` and bring the strip back for good. Returns whether it wrote.
 */
export function resolveUnansweredPublish(
  id: string,
  patch: Parameters<typeof updateWithdrawRecord>[1]
): boolean {
  try {
    const store = readStore();
    const existing = store[id];
    if (!existing || (existing.status !== "publishing" && existing.status !== "published")) return false;
    store[id] = { ...existing, ...patch };
    writeStore(store);
    console.log("[withdraw] rescue record updated", store[id]);
    return true;
  } catch {
    return false;
  }
}

/**
 * 024-D — closes a record with the solver's final verdict. Applied only while the record is still
 * OPEN, read right before the write: a re-check (or another tab) that closed it meanwhile wins.
 * `onlyFrom` narrows it further to the statuses the verdict can follow. Returns whether it wrote.
 */
export function closeWithServerVerdict(
  id: string,
  patch: Parameters<typeof updateWithdrawRecord>[1],
  onlyFrom?: readonly WithdrawRecordStatus[]
): boolean {
  try {
    const store = readStore();
    const existing = store[id];
    if (!existing || isResolvedWithdrawRecord(existing)) return false;
    if (onlyFrom && !onlyFrom.includes(existing.status)) return false;
    store[id] = { ...existing, ...patch };
    writeStore(store);
    console.log("[withdraw] rescue record updated", store[id]);
    return true;
  } catch {
    return false;
  }
}

/**
 * D-463 (023-B) — the manual way out for a record that stays open for good: written before D-463
 * (no nonce to ask `intents.near` about), or executed on a bridge route whose settlement tx the
 * relay has forgotten. Applies only to a record still OPEN and older than `DISMISS_AFTER_MS`, read
 * right before the write — a re-check that closed it meanwhile wins. Returns whether it wrote.
 *
 * The record is kept, as evidence, for `RESOLVED_RETENTION_MS` like any other resolved one.
 */
export function dismissWithdrawRecord(id: string, now: number = Date.now()): boolean {
  try {
    const store = readStore();
    const existing = store[id];
    if (!existing || isResolvedWithdrawRecord(existing)) return false;
    if (now - existing.createdAt <= DISMISS_AFTER_MS) return false;
    store[id] = { ...existing, status: "dismissed" };
    writeStore(store);
    console.log("[withdraw] rescue record dismissed by the user", store[id]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The settlement transactions of the records this signer dismissed here (D-463). The history
 * lists the same Converting Withdrawals on every device (028-8): what the user hid in this
 * browser must stay hidden in it. Kept as long as the record is.
 */
export function dismissedWithdrawTxHashes(signerId: string): Set<string> {
  const hashes = new Set<string>();
  for (const r of listWithdrawRecords()) {
    if (r.signerId === signerId && r.status === "dismissed" && r.txHash) hashes.add(r.txHash);
  }
  return hashes;
}

export function getWithdrawRecord(id: string): WithdrawRescueRecord | undefined {
  return readStore()[id];
}

export function listWithdrawRecords(): WithdrawRescueRecord[] {
  return Object.values(readStore()).sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * The worklist: withdrawals that may still be in flight. Everything here needs a human or a
 * re-check to close it out — nothing here is known to have failed.
 */
export function listUnresolvedWithdrawRecords(): WithdrawRescueRecord[] {
  return listWithdrawRecords().filter((r) => !isResolvedWithdrawRecord(r));
}

/** Operator tooling only. Deletes the evidence trail AND any open worklist. */
export function clearWithdrawRecords(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(KEY);
}
