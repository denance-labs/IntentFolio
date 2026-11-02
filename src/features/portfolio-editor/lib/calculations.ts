import type { BandState, ComputedTargetAllocation, CurrentPortfolioQty, TargetAllocation } from "../types";
import type { TokenDefinition, TokenPriceMap } from "@/features/market/types";

// Held-but-untargeted tokens worth less than this in USD are dust (e.g. a sub-cent
// stNEAR remainder) — hidden so they don't add noise rows to the table and donut. Only
// applied when a price is known, so a token with a missing price is never dropped by
// accident (mirrors D-007's price-known guard).
const MIN_HELD_USD = 0.01;

// D-143(1): rows for tokens held in the portfolio (current > 0) that are NOT in the
// target composition. They complete the superset rendered by both the donut and the
// targets table, so a held-but-untargeted token can't show in one and vanish from the
// other (the "2 in table / 4 in donut" bug). D-513: such a token is sold whole like a 0%
// target, so it gets the same band [0, 0] and state, and the table draws it as one.
// Sub-cent dust is filtered out (MIN_HELD_USD).
export function buildHeldNoTargetRows(
  computedTargets: ComputedTargetAllocation[],
  tokens: TokenDefinition[],
  prices: TokenPriceMap,
  currentPortfolioQty: CurrentPortfolioQty,
  currentTotalUsd: number
): ComputedTargetAllocation[] {
  const targetedIds = new Set(computedTargets.map((t) => t.tokenId).filter(Boolean));
  return tokens
    .filter((token) => {
      const qty = currentPortfolioQty[token.id] || 0;
      if (qty <= 0 || targetedIds.has(token.id)) return false;
      const usdPrice = prices[token.id]?.usdPrice ?? token.fallbackUsdPrice;
      // Drop dust only when we can price it; an unknown price (0) stays visible.
      if (usdPrice > 0 && qty * usdPrice < MIN_HELD_USD) return false;
      return true;
    })
    .map((token) => {
      const usdPrice = prices[token.id]?.usdPrice ?? token.fallbackUsdPrice;
      const currentQty = currentPortfolioQty[token.id] || 0;
      const currentUsd = currentQty * usdPrice;
      const currentPct = currentTotalUsd > 0 ? (currentUsd / currentTotalUsd) * 100 : 0;
      return {
        id: `held-${token.id}`,
        tokenId: token.id,
        targetPct: 0,
        tolerancePct: 0,
        locked: false,
        symbol: token.symbol,
        token: { ...token, usdPrice },
        hasToken: true,
        minPct: 0,
        maxPct: 0,
        targetUsd: 0,
        currentUsd,
        currentQty,
        currentPct,
        bandState: currentTotalUsd > 0 ? getBandState(currentPct, 0, 0, true) : ("empty" as const),
        differenceUsd: -currentUsd,
        cryptoAmount: 0,
        heldNoTarget: true,
      };
    });
}

export function getBandState(currentPct: number, minPct: number, maxPct: number, hasToken: boolean): BandState {
  if (!hasToken) return "empty";
  if (currentPct < minPct) return "below";
  if (currentPct > maxPct) return "above";
  return "inside";
}

// targetPct: set by the user, stored as-is, never recalculated when prices change.
// currentPct: derived each render as (qty × price) / totalUsd — moves with the market.
// The band [targetPct ± tolerancePct] detects drift between intent and reality ([0, 0] at a 0% target).
export function computeTargets(
  targets: TargetAllocation[],
  tokens: TokenDefinition[],
  prices: TokenPriceMap,
  currentPortfolioQty: CurrentPortfolioQty,
  currentTotalUsd: number
): ComputedTargetAllocation[] {
  return targets.map((target) => {
    const token = tokens.find((item) => item.id === target.tokenId) ?? null;
    const hasToken = Boolean(token);
    const usdPrice = target.tokenId ? prices[target.tokenId]?.usdPrice ?? token?.fallbackUsdPrice ?? 0 : 0;
    const tokenWithPrice = token ? { ...token, usdPrice } : null;
    const currentQty = hasToken ? currentPortfolioQty[target.tokenId] || 0 : 0;
    const currentUsd = currentQty * usdPrice;
    const currentPct = currentTotalUsd > 0 ? (currentUsd / currentTotalUsd) * 100 : 0;
    const targetPct = Math.max(0, Math.min(100, Number(target.targetPct) || 0));
    const rawTolerance = target.tolerancePct === "" || target.tolerancePct === undefined ? 10 : Number(target.tolerancePct);
    const tolerancePct = Number.isFinite(rawTolerance) ? Math.max(0, rawTolerance) : 0;
    // D-514: a 0% target is sold whole, whatever tolerance it keeps — the band is [0, 0], as
    // the solver's `bandOf` reads it. The tolerance is still stored and signed (the contract's
    // floor applies), it just has no range to draw.
    const minPct = targetPct === 0 ? 0 : Math.max(0, targetPct - tolerancePct);
    const maxPct = targetPct === 0 ? 0 : Math.min(100, targetPct + tolerancePct);
    const targetUsd = (currentTotalUsd * targetPct) / 100;

    return {
      ...target,
      symbol: token?.symbol ?? target.tokenId,
      token: tokenWithPrice,
      hasToken,
      targetPct,
      tolerancePct,
      minPct,
      maxPct,
      targetUsd,
      currentUsd,
      currentQty,
      currentPct,
      // D-416: a portfolio holding nothing has no band to be in or out of — "—", not "Under".
      bandState: currentTotalUsd > 0 ? getBandState(currentPct, minPct, maxPct, hasToken) : "empty",
      differenceUsd: targetUsd - currentUsd,
      cryptoAmount: hasToken && usdPrice > 0 ? targetUsd / usdPrice : 0
    };
  });
}

export function getBandStateClass(state: BandState) {
  if (state === "below") return "border-violet-400/40 bg-violet-400/10 text-violet-200";
  if (state === "above") return "border-violet-400/40 bg-violet-400/10 text-violet-200";
  if (state === "empty") return "border-slate-700 bg-slate-800/60 text-slate-400";
  return "border-emerald-400/40 bg-emerald-400/15 text-emerald-100";
}
