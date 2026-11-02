"use client";

import { useMemo } from "react";
import { tokenRegistry } from "@/features/market/lib/token-registry";
import { buildHeldNoTargetRows, computeTargets } from "../lib/calculations";
import { buildTokenColorMap } from "../lib/format";
import { placeRemovedRows, type PendingMarks } from "../lib/changeset";
import { validateComposition } from "../lib/validation";
import type { CurrentPortfolioQty, TargetAllocation } from "../types";
import type { TokenPriceMap } from "@/features/market/types";

type Params = {
  targets: TargetAllocation[];
  effectiveCurrentPortfolioQty: CurrentPortfolioQty;
  priceMap: TokenPriceMap;
  /** Live-vault portfolio: an emptied one is a valid on-chain state (see validation.ts). */
  allowEmptyPortfolio?: boolean;
  /** Live-vault portfolio: a token joins at 0% with no balance (D-187, see validation.ts). */
  allowZeroTargetZeroBalance?: boolean;
  /** Open draft's struck rows: they stay in the color order so no other token's color shifts. */
  pendingMarks?: Pick<PendingMarks, "removed" | "committedOrder"> | null;
};

export function usePortfolioComputed({
  targets,
  effectiveCurrentPortfolioQty,
  priceMap,
  allowEmptyPortfolio = false,
  allowZeroTargetZeroBalance = false,
  pendingMarks,
}: Params) {
  // Recomputed on every price tick — intentional. This is what makes currentPct move.
  const currentTotalUsd = tokenRegistry.reduce((sum, token) => {
    const qty = effectiveCurrentPortfolioQty[token.id] || 0;
    const price = priceMap[token.id]?.usdPrice ?? token.fallbackUsdPrice;
    return sum + qty * price;
  }, 0);

  const selectedTokenIds = targets.map((t) => t.tokenId).filter(Boolean);

  const computedTargets = useMemo(
    () => computeTargets(targets, tokenRegistry, priceMap, effectiveCurrentPortfolioQty, currentTotalUsd),
    [targets, priceMap, effectiveCurrentPortfolioQty, currentTotalUsd]
  );

  // Real-time validation engine (5.0): same predicates as the contract gate, so the
  // editor's per-row + global feedback can't drift from what a commit will accept.
  // Balances are the mock qty today; swapping the source to get_portfolio_balance is
  // deferred to 5.3 (the mock contract holds no portfolio balances until commit lands).
  const validation = useMemo(
    () =>
      validateComposition(computedTargets, effectiveCurrentPortfolioQty, {
        allowEmptyPortfolio,
        allowZeroTargetZeroBalance,
      }),
    [
      computedTargets,
      effectiveCurrentPortfolioQty,
      allowEmptyPortfolio,
      allowZeroTargetZeroBalance,
    ]
  );

  const targetTotalUsd = computedTargets.reduce((sum, item) => sum + item.targetUsd, 0);
  const targetTotalPct = computedTargets.reduce((sum, item) => sum + item.targetPct, 0);
  const remainingTargetPct = Math.max(0, 100 - targetTotalPct);
  const targetDeltaUsd = targetTotalUsd - currentTotalUsd;

  const allLocked = targets.length > 0 && targets.every((t) => t.locked);
  const allUnlocked = targets.every((t) => !t.locked);

  // Superset consumed by the donut, its legend AND the targets table (D-143(1)):
  // target rows + held-but-untargeted rows. Held rows are full ComputedTargetAllocation
  // objects flagged heldNoTarget, so the table and donut can never disagree on which
  // tokens to show.
  const heldNoTargetRows = useMemo(
    () => buildHeldNoTargetRows(computedTargets, tokenRegistry, priceMap, effectiveCurrentPortfolioQty, currentTotalUsd),
    [computedTargets, priceMap, effectiveCurrentPortfolioQty, currentTotalUsd]
  );

  // D-513: a held token given a % in this draft (promoteHeldToTarget's `held-` id) keeps its
  // place among the held rows until the draft is saved, so the row never moves under the
  // slider or the % field. Held rows come in registry order; so does the merge.
  const chartRows = useMemo(() => {
    const promoted = computedTargets.filter((row) => row.id === `held-${row.tokenId}`);
    if (promoted.length === 0) return [...computedTargets, ...heldNoTargetRows];
    const order = new Map(tokenRegistry.map((token, i) => [token.id, i]));
    const at = (tokenId: string) => order.get(tokenId) ?? Infinity;
    const held = [...promoted, ...heldNoTargetRows].sort((a, b) => at(a.tokenId) - at(b.tokenId));
    return [...computedTargets.filter((row) => !promoted.includes(row)), ...held];
  }, [computedTargets, heldNoTargetRows]);

  // Single source of truth for per-token colors, derived from the full set of
  // tokens in play (chartRows = target rows + held-but-untargeted tokens). Shared by
  // the donut, its legend and the targets table so a token has one color everywhere.
  // A row the draft strikes still takes its slot, in the table's order: colors go by
  // position, so dropping it from the list would shift every token below it.
  const colorByToken = useMemo(
    () =>
      buildTokenColorMap(
        placeRemovedRows(chartRows, pendingMarks).map((item) =>
          item.kind === "row" ? item.row.tokenId : item.removed.tokenId
        )
      ),
    [chartRows, pendingMarks]
  );

  return {
    currentTotalUsd,
    selectedTokenIds,
    computedTargets,
    validation,
    chartRows,
    colorByToken,
    targetTotalUsd,
    targetTotalPct,
    remainingTargetPct,
    targetDeltaUsd,
    allLocked,
    allUnlocked
  };
}
