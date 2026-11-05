"use client";

// The Allocates of this browser still in transit, for the My Account notice (D-293, 012.plan
// B2). The deciding rule lives in `findPendingAllocates`; this only feeds it the real store
// and the real seal read, through react-query so the result is cached and re-evaluated.
//
// 🔴 Never on the path of a click. The Allocate handler has to reach the wallet popup within
// the browser's ~5 s user-activation window, and these are RPC reads. Everything here runs on
// mount, on invalidation (the context invalidates this key after every create attempt), on a
// timer while a row can still change, and when the portfolio list refetches — none of which is
// inside `handleConfirm`.

import { useCallback, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { VAULT_ROUNDTRIP_ENABLED } from "../lib/vault-flag";
import { listAllocateRecords, updateAllocateRecord } from "../lib/allocate-rescue-store";
import { readAllocateSeal } from "../lib/allocate-seal";
import { readNonceWitness } from "../lib/intents-read-client";
import { fetchAllocateVerdicts } from "../lib/allocate-verdicts-client";
import {
  findPendingAllocates,
  type NotExecutedAllocate,
  type PendingAllocate,
  type PendingAllocatesResult,
} from "../lib/pending-allocates";
import { useRealPortfolios } from "./use-real-portfolios";

/** Shared so the create flow can invalidate this exact query after an attempt. */
export function pendingAllocatesQueryKey(signerId: string) {
  return ["pending-allocates", signerId] as const;
}

/**
 * How often a row that can still change is read again (D-556). Without it a tab left open keeps
 * saying "not confirmed" long after the envelope closed, because nothing else re-runs this
 * unless the list refetches. Paused with the tab hidden, react-query's default for an interval.
 */
export const PENDING_ALLOCATES_RECHECK_MS = 30_000;

const NO_NOT_EXECUTED: NotExecutedAllocate[] = [];

export function usePendingAllocates(signerId: string | null | undefined) {
  const id = signerId ?? "";
  const enabled = VAULT_ROUNDTRIP_ENABLED && !!id;
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: pendingAllocatesQueryKey(id),
    queryFn: (): Promise<PendingAllocatesResult> =>
      findPendingAllocates({
        records: listAllocateRecords,
        readSeal: readAllocateSeal,
        readNonceWitness,
        readVerdicts: (ids) => fetchAllocateVerdicts(ids),
        signerId: id,
      }),
    enabled,
    // Freshness comes from the portfolio list below, not from focus: a focus already
    // refetches that list, which re-runs this one.
    refetchOnWindowFocus: false,
    // `review` is permanent: the solver's verdict does not change.
    refetchInterval: (q) =>
      q.state.data?.pending.some((p) => p.kind !== "review") ? PENDING_ALLOCATES_RECHECK_MS : false,
  });

  // The double-count guard (012.plan B2 risk 1). When a credit lands, the portfolio shows up
  // in the list AND its row would still be here — the same funds shown twice. So an
  // evaluation older than the list is not shown at all, and is re-run. The row disappears in
  // the same render the portfolio appears; the cost is the notice blinking out for one seal
  // read whenever the list refetches. Comparing timestamps (not "the list changed") also
  // skips the redundant pass on mount when this already ran after the list.
  const { dataUpdatedAt: portfoliosUpdatedAt } = useRealPortfolios(id);
  const { data, dataUpdatedAt: pendingUpdatedAt, refetch, isFetching } = query;
  const olderThanList = portfoliosUpdatedAt > pendingUpdatedAt;
  useEffect(() => {
    if (!enabled || isFetching) return;
    if (pendingUpdatedAt > 0 && olderThanList) void refetch();
  }, [enabled, isFetching, pendingUpdatedAt, olderThanList, refetch]);

  /** `undefined` while loading, disabled, or older than the portfolio list. */
  const pending: PendingAllocate[] | undefined = enabled && !olderThanList ? data?.pending : undefined;
  // Not behind the guard above: money that never moved cannot be counted twice, and a notice the
  // user has to read should not blink each time the list refetches.
  const notExecuted = enabled ? (data?.notExecuted ?? NO_NOT_EXECUTED) : NO_NOT_EXECUTED;

  const dismissNotExecuted = useCallback(
    (ids: string[]) => {
      const dismissedAt = Date.now();
      for (const recordId of ids) updateAllocateRecord(recordId, { notExecutedNoticeDismissedAt: dismissedAt });
      const queryKey = pendingAllocatesQueryKey(id);
      queryClient.setQueryData<PendingAllocatesResult>(queryKey, (previous) =>
        previous && { ...previous, notExecuted: previous.notExecuted.filter((n) => !ids.includes(n.id)) }
      );
      // Also drops a re-read already in flight, which read the store before this write and would
      // bring the notice back.
      void queryClient.invalidateQueries({ queryKey });
    },
    [id, queryClient]
  );

  return { pending, notExecuted, dismissNotExecuted, isFetching };
}
