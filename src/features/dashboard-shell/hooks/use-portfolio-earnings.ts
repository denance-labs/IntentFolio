"use client";

import { useMemo, useSyncExternalStore } from "react";
import { mockContract } from "@/features/intents-account/mock-contract";
import type { ContractEvent } from "@/features/intents-account/mock-contract/types";
import { usePortfolioStats } from "@/features/vault/hooks/use-portfolio-stats";
import { utcDay, type DayCount } from "@/features/portfolio-showcase/lib/showcase-geometry";
import type { ShowcaseEarnings } from "@/features/portfolio-showcase/types";
import type { Portfolio } from "../context/portfolio-context";

export type PortfolioEarnings = {
  earnings: ShowcaseEarnings;
  /** Behind after its catch-up re-reads: true only up to `recordedUntil`. */
  outOfDate: boolean;
  recordedUntil: number | null;
  /** The history's initial load has not finished: older days may still be missing. */
  partial: boolean;
};

/**
 * What a portfolio earned on the way, for the Overview (D-518): the same sources as Performance —
 * the history database for a real portfolio (028-3, spread at each day's price), the mock's
 * external_rebalance events for a mock one — grouped by UTC day.
 */
export function usePortfolioEarnings(portfolio: Portfolio | null, intentsAccountId: string | null): PortfolioEarnings {
  const isReal = portfolio?.isReal === true;
  const stats = usePortfolioStats(isReal ? (portfolio?.id ?? null) : null, isReal);
  const contractVersion = useSyncExternalStore(mockContract.subscribe, mockContract.getVersion, mockContract.getVersion);

  const mockEarnings = useMemo<ShowcaseEarnings | null>(() => {
    void contractVersion;
    if (!portfolio || isReal || !intentsAccountId) return null;
    const rebalances = mockContract
      .getEvents(intentsAccountId)
      .filter(
        (e): e is Extract<ContractEvent, { kind: "external_rebalance" }> =>
          e.kind === "external_rebalance" && e.portfolio_id === portfolio.id
      )
      .sort((a, b) => a.ts - b.ts);
    const byDay = new Map<string, DayCount>();
    for (const e of rebalances) {
      const day = utcDay(e.ts);
      const entry = byDay.get(day) ?? { day, swaps: 0, spreadUsd: 0 };
      entry.swaps += 1;
      entry.spreadUsd += e.attributed_spread;
      byDay.set(day, entry);
    }
    return {
      status: "ready",
      spreadUsd: rebalances.reduce((sum, e) => sum + e.attributed_spread, 0),
      spreadIsMinimum: false,
      swaps: rebalances.length,
      daily: [...byDay.values()],
    };
  }, [portfolio, isReal, intentsAccountId, contractVersion]);

  if (!isReal) {
    return {
      earnings: mockEarnings ?? { status: "ready", spreadUsd: 0, spreadIsMinimum: false, swaps: 0, daily: [] },
      outOfDate: false,
      recordedUntil: null,
      partial: false,
    };
  }
  const data = stats.data;
  if (data) {
    return {
      earnings: {
        status: "ready",
        spreadUsd: data.spreadUsd,
        spreadIsMinimum: data.spreadIsMinimum,
        swaps: data.swaps,
        daily: data.daily,
      },
      outOfDate: stats.outOfDate,
      recordedUntil: data.recordedUntil,
      partial: data.loading,
    };
  }
  // Not loading and nothing read (an error, or the read is off on this deployment): "—", never a
  // zero it did not read.
  return {
    earnings: stats.isLoading ? { status: "loading" } : { status: "failed" },
    outOfDate: false,
    recordedUntil: null,
    partial: false,
  };
}
