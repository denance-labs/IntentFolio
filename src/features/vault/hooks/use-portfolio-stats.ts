"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { VAULT_CONTRACT_ID } from "@/features/wallet/config/network";
import type { PortfolioStatsBody } from "@/features/history-recorder/lib/portfolio-stats-service";
import { VAULT_ROUNDTRIP_ENABLED } from "../lib/vault-flag";

export type PortfolioStats = Extract<PortfolioStatsBody, { ok: true }>;

const ENDPOINT = "/api/history/portfolio-stats";

/** How long after a "behind" answer the view reads again: the pass that answer started is done by then. */
export const CATCH_UP_REREAD_MS = 15_000;
/** Re-reads per stretch of the same old data before the view says it is out of date. */
export const CATCH_UP_REREADS = 4;

/** Throws on anything but a successful answer: the card shows "—", never a zero it did not read. */
export async function fetchPortfolioStats(portfolioId: string, fetchImpl: typeof fetch = fetch): Promise<PortfolioStats> {
  const response = await fetchImpl(`${ENDPOINT}?portfolio=${encodeURIComponent(portfolioId)}`);
  const body = (await response.json().catch(() => null)) as PortfolioStatsBody | null;
  if (!response.ok || body?.ok !== true) {
    throw new Error(`portfolio-stats answered ${response.status}${body && !body.ok ? ` (${body.code})` : ""}`);
  }
  return body;
}

/**
 * A real portfolio's swaps and earned spread, from the history database (plan 028-3, D-492). Off
 * for mock portfolios (`enabled`) — Preview has none, so it never calls the route.
 *
 * An answer that is behind started a catch-up pass on the server after it went out, so the view
 * reads again every `CATCH_UP_REREAD_MS`, up to `CATCH_UP_REREADS` times; still behind after the
 * last one, it is `outOfDate` and stops. Counted per portfolio, and back to zero only on an
 * answer that is up to date (or a new mount): data that moves but stays behind — FastNEAR's index
 * lagging by more than the threshold, so each pass advances "recorded until" a little — must not
 * restart the count, or the view would re-read forever and never say so.
 */
export function usePortfolioStats(portfolioId: string | null, enabled: boolean) {
  const query = useQuery({
    queryKey: ["portfolio-stats", VAULT_CONTRACT_ID, portfolioId],
    queryFn: () => fetchPortfolioStats(portfolioId ?? ""),
    enabled: VAULT_ROUNDTRIP_ENABLED && enabled && !!portfolioId && !!VAULT_CONTRACT_ID,
    // The solver rebalances every ~30 min; the route's CDN cache holds an answer 30-60 s anyway.
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

/**
 * The re-reads of a history read whose answer is behind (see `usePortfolioStats`); true once the
 * last one is in and still behind. Shared with Evolution's read (`usePortfolioComposition`).
 */
export function useCatchUpRereads(
  portfolioId: string | null,
  data: { upToDate: boolean } | undefined,
  refetch: () => Promise<unknown>
): boolean {
  const [rereads, setRereads] = useState<{ portfolioId: string | null; n: number }>({ portfolioId: null, n: 0 });
  // An up-to-date answer ends the stretch (state adjusted while rendering, React's pattern for it).
  if (data?.upToDate && rereads.n !== 0) setRereads({ portfolioId, n: 0 });
  const n = rereads.portfolioId === portfolioId ? rereads.n : 0;
  const behind = !!data && !data.upToDate;

  useEffect(() => {
    if (!behind || n >= CATCH_UP_REREADS) return;
    const timer = setTimeout(() => {
      // Counted once the answer is in, so `outOfDate` never shows ahead of the last re-read.
      void refetch().finally(() => setRereads({ portfolioId, n: n + 1 }));
    }, CATCH_UP_REREAD_MS);
    return () => clearTimeout(timer);
  }, [behind, portfolioId, n, refetch]);

  return behind && n >= CATCH_UP_REREADS;
}
