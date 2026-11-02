"use client";

import { useQuery } from "@tanstack/react-query";
import { VAULT_CONTRACT_ID } from "@/features/wallet/config/network";
import type { PortfolioCompositionBody } from "@/features/history-recorder/lib/portfolio-composition-service";
import { VAULT_ROUNDTRIP_ENABLED } from "../lib/vault-flag";
import { useCatchUpRereads } from "./use-portfolio-stats";

export type PortfolioComposition = Extract<PortfolioCompositionBody, { ok: true }>;

const ENDPOINT = "/api/history/portfolio-composition";

/** Throws on anything but a successful answer: the view shows "—", never a split it did not read. */
export async function fetchPortfolioComposition(
  portfolioId: string,
  fetchImpl: typeof fetch = fetch
): Promise<PortfolioComposition> {
  const response = await fetchImpl(`${ENDPOINT}?portfolio=${encodeURIComponent(portfolioId)}`);
  const body = (await response.json().catch(() => null)) as PortfolioCompositionBody | null;
  if (!response.ok || body?.ok !== true) {
    throw new Error(`portfolio-composition answered ${response.status}${body && !body.ok ? ` (${body.code})` : ""}`);
  }
  return body;
}

/**
 * A real portfolio's daily split between its tokens, from the history database (plan 033-B,
 * D-516). Off for mock portfolios (`enabled`): Preview has none, so it never calls the route.
 * An answer that is behind is read again like Performance's (`useCatchUpRereads`).
 */
export function usePortfolioComposition(portfolioId: string | null, enabled: boolean) {
  const query = useQuery({
    queryKey: ["portfolio-composition", VAULT_CONTRACT_ID, portfolioId],
    queryFn: () => fetchPortfolioComposition(portfolioId ?? ""),
    enabled: VAULT_ROUNDTRIP_ENABLED && enabled && !!portfolioId && !!VAULT_CONTRACT_ID,
    // A new snapshot is one a day; what moves today is the "now" point, from the live vault.
    staleTime: 60 * 1000,
    retry: 1,
  });

  return {
    data: query.data,
    isLoading: query.isLoading,
    isError: query.isError,
    outOfDate: useCatchUpRereads(portfolioId, query.data, query.refetch),
  };
}
