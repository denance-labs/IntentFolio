// Withdrawal maturity from the chain (017-9a, T5).
//
// The vault exposes each position's `matures_at` (`get_portfolio_positions`). The chain's
// number is the only one that follows the Solver: a reconcile restarts a position's clock,
// which no client can see coming. So nothing here promises a time; it reports the deadline as
// the chain has it right now, and the countdown re-reads when it runs out.
//
// A COURTESY gate, never a safety barrier: the vault defers an immature commit on its own.
//
// Attribution: see ATTRIBUTIONS.md #8.

import type { PortfolioPosition } from "./vault-read-client";

export type MaturityStatus = {
  matured: boolean;
  /** Seconds left until the last-maturing token clears; 0 once matured. */
  remainingSecs: number;
  /** False when NO token in the set has a clock — the gate then stays out of the way. */
  known: boolean;
};

/**
 * The commit is atomic, so the LATEST deadline among the tokens involved gates it. A token with no clock (`matures_at == 0`) or not held at all
 * counts as mature; with none of them clocked the gate stays out of the way (`known: false`).
 */
export function maturityFromPositions(
  positions: readonly PortfolioPosition[],
  tokenIds: readonly string[],
  nowSecs: number
): MaturityStatus {
  const wanted = new Set(tokenIds);
  let latest = 0;
  let known = false;
  for (const position of positions) {
    if (!wanted.has(position.tokenId) || position.maturesAtSecs <= 0) continue;
    known = true;
    if (position.maturesAtSecs > latest) latest = position.maturesAtSecs;
  }
  if (!known) return { matured: true, remainingSecs: 0, known: false };
  const remaining = Math.max(0, latest - nowSecs);
  return { matured: remaining === 0, remainingSecs: remaining, known: true };
}
