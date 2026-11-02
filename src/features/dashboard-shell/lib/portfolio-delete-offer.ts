// Whether a portfolio can be deleted right now, and if not, why (017-9c; 027 A-9a). Pure, so
// every branch is pinned by a test: a wrong "empty" costs a signature the vault refuses, a
// wrong "funded" leaves a portfolio the user cannot get rid of.

import type { Portfolio } from "../context/portfolio-context";
import type { PendingAllocate } from "@/features/vault/lib/pending-allocates";

export type DeleteOfferInput = {
  portfolio: Pick<Portfolio, "id" | "isReal" | "deposits" | "holdsNothingOnChain">;
  /** This browser's credits still in transit; `undefined` while unknown (loading, stale). */
  pendingAllocates: PendingAllocate[] | undefined;
  /** Mock only: withdrawals the mock is still settling for this portfolio. */
  mockPendingUnallocations: number;
};

/**
 * - `empty`: the delete can be signed.
 * - `funded`: it still holds funds; they go to the General Balance first.
 * - `incoming`: a credit is on its way to it — deleting now would bounce that credit into a
 *   week-long Return (ADR-0023, D-302 g).
 * - `checking`: not known yet. Unknown is not "empty".
 *
 * No editing input (A-9a): a real portfolio's emptiness is the chain's word, which no draft
 * changes, and the delete lives in the tab menu, which does not depend on the mode (D-416).
 */
export type DeleteStatus = "empty" | "funded" | "incoming" | "checking";

export function portfolioDeleteStatus(p: DeleteOfferInput): DeleteStatus {
  if (p.portfolio.isReal) {
    // Empty is the CHAIN's word (raw base units), not `deposits`, which skips a token the
    // registry cannot price.
    // Residual: a credit sent from another browser is not in `pendingAllocates`. The delete
    // still goes through (the portfolio IS empty), and that credit comes back to the General
    // Balance by a Return (ADR-0023).
    if (p.portfolio.holdsNothingOnChain === false) return "funded";
    if (p.portfolio.holdsNothingOnChain === undefined || p.pendingAllocates === undefined) return "checking";
    if (p.pendingAllocates.some((a) => a.portfolioId === p.portfolio.id)) return "incoming";
    return "empty";
  }
  // The mock's funds being released still sit in the portfolio until they settle.
  if (p.mockPendingUnallocations > 0) return "funded";
  return Object.values(p.portfolio.deposits).some((qty) => qty > 0) ? "funded" : "empty";
}
