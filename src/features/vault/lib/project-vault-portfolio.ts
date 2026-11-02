// Projection: what the vault stores → what the dashboard renders (008.plan Phase 1, D-R6).
//
// This is the seam that replaces the localStorage mirror. Until now a real portfolio was
// rendered from `mockContract`, written by `mirrorRealPortfolio` at the end of every
// successful write. That made the dashboard show what the app BELIEVED it had written,
// not what the chain holds — and D-174 is what that costs: a composition displayed at 0%
// while `get_portfolio` returns the five targets intact.
//
// Kept pure and separate from the hook so the two conversions that can silently corrupt
// money — basis points → percent, base units → human units — are unit-testable without a
// React tree or an RPC.

import type { Portfolio } from "@/features/dashboard-shell/context/portfolio-context";
import { getTokenById } from "@/features/market/lib/token-registry";
import { fromBaseUnits } from "./base-units";
import type { RealPortfolioRead } from "./vault-read-client";

export type { RealPortfolioRead };

/** Basis points → percent. 3000 → 30, 500 → 5. */
export function bpsToPct(bps: number): number {
  return bps / 100;
}

export function projectVaultPortfolio(
  read: RealPortfolioRead,
  defaultTolerancePct: number
): Portfolio {
  const deposits: Record<string, number> = {};
  for (const [tokenId, amount] of read.balances) {
    const token = getTokenById(tokenId);
    // A held token outside the curated registry has no known `decimals`, so its quantity
    // cannot be converted — and inventing one would misreport a balance. It is skipped
    // rather than shown wrong. Unreachable today: both ways funds enter a portfolio
    // (deposit, then allocate from General Balance) are gated by the same registry
    // (ADR-0016), so the vault can only hold tokens this map knows.
    if (!token) continue;
    deposits[tokenId] = fromBaseUnits(amount, token.decimals);
  }

  return {
    id: read.id,
    name: read.portfolio.name,
    deposits,
    // The row id is derived from the tokenId, not generated: a changing id would remount
    // the table row and drop input focus on every re-read (same rule as the mock path's
    // compositionToTargets).
    targets: read.portfolio.composition.map((c) => ({
      id: `target-${c.token_id}`,
      tokenId: c.token_id,
      targetPct: bpsToPct(c.target_bps),
      tolerancePct: bpsToPct(c.tolerance_bps),
      locked: false,
    })),
    // The contract timestamps in UNIX seconds; everything in the app is milliseconds.
    createdAt: read.portfolio.created_at * 1000,
    defaultTolerancePct,
    isReal: true,
    // The contract's delete condition is `held_tokens` empty (`delete_empty_portfolio`); the
    // balances are checked too so the two can only make the offer stricter, never looser.
    holdsNothingOnChain:
      read.portfolio.held_tokens.length === 0 &&
      read.balances.every(([, amount]) => amount === BigInt(0)),
  };
}

export function projectVaultPortfolios(
  reads: RealPortfolioRead[],
  defaultTolerancePct: number
): Portfolio[] {
  return reads.map((read) => projectVaultPortfolio(read, defaultTolerancePct));
}
