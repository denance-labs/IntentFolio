"use client";

import { useSyncExternalStore, useEffect, useRef } from "react";
import { mockContract } from "@/features/intents-account/mock-contract";
import type { PendingUnallocationRecord } from "@/features/intents-account/mock-contract/types";

// C1 — drives the async settlement of pending unallocations (mirror of use-pending-withdrawals).
// A Portfolio Commit applies composition + allocations atomically, but each unallocation leg
// settles separately on intents.near: the funds stay RESERVED in the portfolio until the
// solver reserve frees up (a quote was not accepted / the TTL expired). This hook abstracts
// that release into a per-record timer hung off the record's reserveDeadline (= reserve TTL).
//
// Timing is deterministic by unallocationId (same id → same path, no render-time randomness):
//   FAILED   (~25%, first char {0,1,2,3}): the async leg reverts at the reserve deadline.
//   extended (~12.5%, first char {4,5})  : settles late, near the reserve deadline.
//   fast     (the rest)                  : settles quickly (~8s; real ≈ 5–15s).
//
// Durability (settle-on-load): records are persisted by the mock, so on mount a leg whose
// computed settle time already passed (e.g. the tab was closed past its deadline) is applied
// immediately — a pending unallocation is guaranteed to complete, never stuck.

export const FAST_SETTLE_MS = 8_000;

// Exported for unit testing the deterministic settlement buckets (no render-time randomness).
export function isFailPath(id: string): boolean {
  return ["0", "1", "2", "3"].includes(id[0] ?? "");
}

export function isExtendedPath(id: string): boolean {
  return ["4", "5"].includes(id[0] ?? "");
}

// Absolute timestamp at which this leg resolves. Fast legs settle a fixed delay after the
// commit; extended and failed legs resolve at the reserve deadline (the TTL boundary).
export function resolveAt(record: PendingUnallocationRecord): number {
  if (isFailPath(record.unallocationId) || isExtendedPath(record.unallocationId)) {
    return record.reserveDeadline;
  }
  return record.ts + FAST_SETTLE_MS;
}

type Options = {
  intentsAccountId: string;
  onSettled?: (record: PendingUnallocationRecord) => void;
  onFailed?: (record: PendingUnallocationRecord) => void;
};

export function usePendingUnallocations({
  intentsAccountId,
  onSettled,
  onFailed,
}: Options): PendingUnallocationRecord[] {
  useSyncExternalStore(mockContract.subscribe, mockContract.getVersion, mockContract.getVersion);

  const scheduledRef = useRef(new Set<string>());
  const timerIdsRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;
  const onFailedRef = useRef(onFailed);
  onFailedRef.current = onFailed;

  const records = intentsAccountId
    ? mockContract.getPendingUnallocations(intentsAccountId)
    : [];

  // Schedule resolution for each newly PENDING leg. The guard prevents double-scheduling
  // across re-renders; a leg whose resolve time has already passed is applied immediately
  // (settle-on-load), so reload never leaves a pending leg stuck.
  useEffect(() => {
    for (const record of records) {
      if (record.status !== "PENDING") continue;
      if (scheduledRef.current.has(record.unallocationId)) continue;
      scheduledRef.current.add(record.unallocationId);

      const id = record.unallocationId;
      const fail = isFailPath(id);
      const apply = () => {
        if (fail) {
          mockContract.failUnallocation(intentsAccountId, id);
          onFailedRef.current?.(record);
        } else {
          mockContract.settleUnallocation(intentsAccountId, id);
          onSettledRef.current?.(record);
        }
      };

      const remaining = resolveAt(record) - Date.now();
      if (remaining <= 0) {
        apply();
      } else {
        timerIdsRef.current.push(setTimeout(apply, remaining));
      }
    }
  });

  useEffect(() => {
    return () => {
      timerIdsRef.current.forEach(clearTimeout);
    };
  }, []);

  return records;
}
