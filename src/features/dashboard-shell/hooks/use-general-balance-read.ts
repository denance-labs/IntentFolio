"use client";

import { useMemo } from "react";
import { useLoginWallet } from "@/features/login-wallet";
import { useIntentsBalances } from "@/features/wallet";

export type GeneralBalanceRead =
  | { status: "loading" }
  // `retry` re-runs the read; while it runs the status is "loading" again.
  | { status: "error"; retry: () => void }
  | { status: "read" };

/**
 * Whether the on-chain General Balance has been read at least once (D-541). Until it has,
 * `useAvailableGeneralBalance` answers from the mock ledger, which is empty for a real account:
 * shown as is, that is a false $0 and a false "your funding account is empty".
 *
 * "error" once the FIRST read failed twice with nothing cached. The query keeps its global
 * 3 retries (2/4/8 s, ~14 s with a dead RPC) so a short blip still resolves on its own; only
 * the screen stops waiting after the second failure (~2 s). A failed REFRESH keeps the last
 * balance, so it stays "read". A Retry restarts the fetch, which resets `failureCount` and
 * puts a query without data back in `isLoading`.
 *
 * With no session the query is disabled: nothing to read, so "read" (the callers' signed-out
 * branches own that state).
 */
export function useGeneralBalanceRead(): GeneralBalanceRead {
  const { intentsAccountId } = useLoginWallet();
  const { isLoading, isError, failureCount, data, refetch } = useIntentsBalances(intentsAccountId);

  return useMemo<GeneralBalanceRead>(() => {
    if (data === undefined && (isError || failureCount >= 2)) {
      return { status: "error", retry: () => void refetch() };
    }
    if (isLoading) return { status: "loading" };
    return { status: "read" };
  }, [isLoading, isError, failureCount, data, refetch]);
}
