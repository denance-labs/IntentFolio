"use client";

import { useQuery } from "@tanstack/react-query";
import type { DayPricesBody } from "@/features/history-recorder/lib/day-prices-service";
import { VAULT_ROUNDTRIP_ENABLED } from "../lib/vault-flag";

export type DayPrices = Extract<DayPricesBody, { ok: true }>;

const ENDPOINT = "/api/history/day-prices";

/** Throws on anything but a successful answer: the change is hidden, never computed from nothing. */
export async function fetchDayPrices(fetchImpl: typeof fetch = fetch): Promise<DayPrices> {
  const response = await fetchImpl(ENDPOINT);
  const body = (await response.json().catch(() => null)) as DayPricesBody | null;
  if (!response.ok || body?.ok !== true) {
    throw new Error(`day-prices answered ${response.status}${body && !body.ok ? ` (${body.code})` : ""}`);
  }
  return body;
}

/**
 * Each token's price at the start of the UTC day, from the history database (D-523). Off for
 * mock portfolios (`enabled`), like `usePortfolioStats`.
 */
export function useDayPrices(enabled: boolean): DayPrices | null {
  const query = useQuery({
    queryKey: ["day-prices"],
    queryFn: () => fetchDayPrices(),
    enabled: VAULT_ROUNDTRIP_ENABLED && enabled,
    // The route's CDN cache holds an answer for 5 minutes; a token priced later in the day is rare.
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
  return query.data ?? null;
}
