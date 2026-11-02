"use client";

// The Allocates of this browser still in transit, for the My Account notice (D-293, 012.plan
// B2). The deciding rule lives in `findPendingAllocates`; this only feeds it the real store
// and the real seal read, through react-query so the result is cached and re-evaluated.
//
// 🔴 Never on the path of a click. The Allocate handler has to reach the wallet popup within
// the browser's ~5 s user-activation window, and these are RPC reads. Everything here runs on
// mount, on invalidation (the context invalidates this key after every create attempt), and
// when the portfolio list refetches — none of which is inside `handleConfirm`.

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { VAULT_ROUNDTRIP_ENABLED } from "../lib/vault-flag";
import { listAllocateRecords } from "../lib/allocate-rescue-store";
import { readAllocateSeal } from "../lib/allocate-seal";
import { readNonceWitness } from "../lib/intents-read-client";
import { fetchAllocateVerdicts } from "../lib/allocate-verdicts-client";
import { findPendingAllocates, type PendingAllocate } from "../lib/pending-allocates";
import { useRealPortfolios } from "./use-real-portfolios";

/** Shared so the create flow can invalidate this exact query after an attempt. */
export function pendingAllocatesQueryKey(signerId: string) {
  return ["pending-allocates", signerId] as const;
}

export function usePendingAllocates(signerId: string | null | undefined) {
  const id = signerId ?? "";
  const enabled = VAULT_ROUNDTRIP_ENABLED && !!id;

  const query = useQuery({
    queryKey: pendingAllocatesQueryKey(id),
    queryFn: (): Promise<PendingAllocate[]> =>
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
  const pending: PendingAllocate[] | undefined = enabled && !olderThanList ? data : undefined;
  return { pending, isFetching };
}
