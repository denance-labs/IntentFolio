import type { Portfolio } from "../context/portfolio-context";
import { getTokenById } from "@/features/market/lib/token-registry";
import type { TokenPriceMap } from "@/features/market/types";
import type { DepositStatusEntry } from "@/features/bridge";
import type { PendingUnallocationRecord } from "@/features/intents-account/mock-contract/types";

export type AccountTotals = {
  generalUsd: number;
  portfoliosUsd: number;
  totalUsd: number;
};

/**
 * USD value of every Portfolio Balance across all portfolios (D-299), priced with the same
 * rule as the General Balance rows: live price, else the registry fallback.
 *
 * A token the registry does not know contributes 0 — without its metadata it has no price
 * either. The vault projection already drops those, so this only guards mock data.
 */
export function sumPortfoliosUsd(portfolios: Portfolio[], prices: TokenPriceMap): number {
  let usd = 0;
  for (const portfolio of portfolios) {
    for (const [tokenId, qty] of Object.entries(portfolio.deposits)) {
      if (!(qty > 0)) continue;
      const token = getTokenById(tokenId);
      if (!token) continue;
      usd += qty * (prices[tokenId]?.usdPrice ?? token.fallbackUsdPrice);
    }
  }
  return usd;
}

/**
 * USD value of the General Balance, priced like its rows on My Account: live price, else the
 * registry fallback, else 0 for a token the registry does not know.
 */
export function sumBalanceUsd(balance: ReadonlyMap<string, number>, prices: TokenPriceMap): number {
  let usd = 0;
  for (const [tokenId, qty] of balance) {
    if (!(qty > 0)) continue;
    usd += qty * (prices[tokenId]?.usdPrice ?? getTokenById(tokenId)?.fallbackUsdPrice ?? 0);
  }
  return usd;
}

const toCents = (usd: number) => Math.round(usd * 100) / 100;

/**
 * The three My Account figures. Each part is rounded to cents BEFORE adding, so the two
 * small figures on screen always add up to the big one — rounding the sum on its own could
 * leave it a cent off from what the reader can check by hand.
 *
 * Only balances the chain confirms go in (D-299 / D3): an Allocate still in transit is
 * NOT added, because the pending notice deliberately over-reports (an unreadable seal keeps
 * a credited Allocate listed) and adding it here would count that amount twice. What the
 * totals leave out is flagged by `hasMovementsInProgress` instead.
 */
export function computeAccountTotals(generalUsd: number, portfoliosUsd: number): AccountTotals {
  const general = toCents(generalUsd);
  const inPortfolios = toCents(portfoliosUsd);
  return { generalUsd: general, portfoliosUsd: inPortfolios, totalUsd: toCents(general + inPortfolios) };
}

/**
 * Whether money the user moved may be missing from the totals right now (D-299 / D3). One
 * note covers every such case instead of a rule per operation: an Allocate in transit
 * (including an orphan awaiting rescue), a portfolio withdrawal on its way back to the
 * General Balance, a deposit not yet credited.
 *
 * A withdrawal to an external wallet is deliberately NOT here: until it executes the funds
 * are still in the General Balance, and once it executes they have left IntentFolio — the
 * totals are right at every step, so the note would only cast doubt on a correct number
 * (observed in QA: it lingered ~150 s after the balance had already dropped).
 */
export function hasMovementsInProgress({
  pendingAllocates,
  deposits,
  unallocations,
}: {
  pendingAllocates: number;
  deposits: readonly DepositStatusEntry[];
  unallocations: readonly PendingUnallocationRecord[];
}): boolean {
  return (
    pendingAllocates > 0 ||
    deposits.some((d) => d.status === "PENDING") ||
    unallocations.some((u) => u.status === "PENDING")
  );
}

/**
 * The figures under the tab strip's names (021 R5): My Account's funding account — the same
 * number as the first figure of its breakdown — and each portfolio's value. Not the account's
 * total (029 B-16): next to the portfolios' own figures, that counted them twice, so the row
 * now adds up to the total instead.
 */
export function computeTabValues(
  generalBalance: ReadonlyMap<string, number>,
  portfolios: Portfolio[],
  prices: TokenPriceMap
): { fundingUsd: number; byPortfolio: ReadonlyMap<string, number> } {
  return {
    fundingUsd: computeAccountTotals(sumBalanceUsd(generalBalance, prices), 0).generalUsd,
    byPortfolio: new Map(portfolios.map((p) => [p.id, toCents(sumPortfoliosUsd([p], prices))])),
  };
}
