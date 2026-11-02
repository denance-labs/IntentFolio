"use client";

import { useQuery } from "@tanstack/react-query";
import { VAULT_ROUNDTRIP_ENABLED } from "../lib/vault-flag";
import type { RealPortfolioRead } from "../lib/project-vault-portfolio";
import { readPortfoliosFor } from "../lib/vault-read-client";

/** Shared so callers can invalidate this exact query after a write. */
export function realPortfoliosQueryKey(intentsAccountId: string) {
  return ["real-portfolios", intentsAccountId] as const;
}

/**
 * The account's portfolios as the VAULT holds them (008.plan Phase 1, D-R6).
 *
 * Replaces the `mirrorRealPortfolio` localStorage mirror as the source of truth for real
 * portfolios. The composite read itself lives in `vault-read-client` (`readPortfoliosFor`),
 * which is where its money-adjacent rules — no silent empty, no partial list, deleted is
 * not empty — are documented and tested.
 *
 * `staleTime` is generous because a portfolio's composition only changes when the user
 * changes it — and every such write invalidates this key explicitly, so freshness comes
 * from invalidation, not from polling.
 */
export function useRealPortfolios(intentsAccountId: string) {
  return useQuery({
    queryKey: realPortfoliosQueryKey(intentsAccountId),
    queryFn: (): Promise<RealPortfolioRead[]> => readPortfoliosFor(intentsAccountId),
    enabled: VAULT_ROUNDTRIP_ENABLED && !!intentsAccountId,
    staleTime: 60 * 1000,
    retry: 3,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8_000),
    refetchOnWindowFocus: true,
  });
}
