"use client";

// The scheduled Returns addressed to this account, for the My Account notice (D-302 h2). The
// walk and its rules live in `findScheduledReturns`; this feeds it the real vault reads
// through react-query, so a failed refetch keeps the last good list on screen.
//
// Gated three ways, all of which mean "no reads at all": the live vault round-trip is off,
// no vault is configured (the empty contract id of local and mock builds), or there is no
// account to match.
//
// 🔴 Never on the path of a click: these are RPC reads, and nothing here runs inside a
// signing handler — only on mount, focus and expiry.

import { useQuery } from "@tanstack/react-query";
import { VAULT_ROUNDTRIP_ENABLED } from "../lib/vault-flag";
import { VAULT_CONTRACT_ID } from "@/features/wallet/config/network";
import { getConfig, getReturn, type ReturnView } from "../lib/vault-read-client";
import { findScheduledReturns } from "../lib/vault-returns";

/** The query's key. Nothing in the app schedules a Return (the vault's admin does), so nothing invalidates it. */
export function scheduledReturnsQueryKey(accountId: string) {
  return ["scheduled-returns", accountId] as const;
}

// Returns are rare and slow — a 7-day timelock — so minutes of staleness cost nothing, and
// each refetch walks every id below the counter.
const STALE_MS = 5 * 60_000;

/**
 * Whether this build can read Returns at all. Both inputs are build-time constants, so the
 * notice checks this BEFORE mounting the component that calls the hook: on builds without a
 * vault or with the flag off no query is registered and no QueryClient is needed.
 */
export function scheduledReturnsReadable(): boolean {
  return VAULT_ROUNDTRIP_ENABLED && VAULT_CONTRACT_ID !== "";
}

export function useScheduledReturns(accountId: string | null | undefined) {
  const id = accountId ?? "";
  const enabled = scheduledReturnsReadable() && !!id;

  const query = useQuery({
    queryKey: scheduledReturnsQueryKey(id),
    queryFn: (): Promise<ReturnView[]> =>
      findScheduledReturns({ accountId: id, readConfig: getConfig, readReturn: getReturn }),
    enabled,
    staleTime: STALE_MS,
    refetchOnWindowFocus: true,
  });

  /** `undefined` while loading, disabled, or after a first read that failed. */
  const returns: ReturnView[] | undefined = enabled ? query.data : undefined;
  return { returns, isFetching: query.isFetching };
}
