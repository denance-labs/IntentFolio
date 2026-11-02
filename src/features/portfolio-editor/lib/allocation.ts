import type { CurrentPortfolioQty, TargetAllocation, WithdrawnQty } from "../types";
import type { TokenDefinition, TokenPriceMap } from "@/features/market/types";
import { getTokenById } from "@/features/market/lib/token-registry";
import { NO_BUY_ROUTE_TOKEN_IDS } from "@/features/bridge/lib/token-availability";

// D-491: a target with no buy route may go down or out, never up — nobody could fill the
// extra. Redistribution treats it as fixed, like a locked row.
const canGrow = (target: TargetAllocation) => !NO_BUY_ROUTE_TOKEN_IDS.has(target.tokenId);

export function makeTarget(tokenId = "", targetPct: number | "" = "", tolerancePct: number | "" = 10, locked = false): TargetAllocation {
  return {
    id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${tokenId || "new"}-${Date.now()}-${Math.random()}`,
    tokenId,
    targetPct,
    tolerancePct,
    locked
  };
}

export function buildTargetsFromCurrentPortfolio(tokens: TokenDefinition[], currentPortfolioQty: CurrentPortfolioQty) {
  const totalUsd = tokens.reduce((sum, token) => {
    const qty = currentPortfolioQty[token.id] || 0;
    return sum + qty * token.fallbackUsdPrice;
  }, 0);

  return tokens
    .filter((token) => (currentPortfolioQty[token.id] || 0) > 0)
    .map((token) => {
      const currentUsd = (currentPortfolioQty[token.id] || 0) * token.fallbackUsdPrice;
      const currentPct = totalUsd > 0 ? Number(((currentUsd / totalUsd) * 100).toFixed(2)) : 0;
      return makeTarget(token.id, currentPct, 10, false);
    });
}

// Create-mode (7.5b-08): synthesize a target set for a brand-new portfolio from the
// chosen allocations. Each funded token's target is its USD weight across the funded
// total, so targets start == initial weights (mirrors allocateToPortfolio's behaviour
// in the editor). Tokens added without funds (target-only) start at 0%. Rounding drift
// is folded onto the largest funded target so the funded set sums to exactly 100.
export function buildScratchTargets(
  allocations: Record<string, number>,
  targetOnlyIds: string[],
  prices: TokenPriceMap,
  defaultTolerancePct = 10
): TargetAllocation[] {
  const funded = Object.entries(allocations).filter(([, qty]) => qty > 0);

  let totalUsd = 0;
  const usdById = new Map<string, number>();
  for (const [id, qty] of funded) {
    const price = prices[id]?.usdPrice ?? getTokenById(id)?.fallbackUsdPrice ?? 0;
    const usd = qty * price;
    usdById.set(id, usd);
    totalUsd += usd;
  }

  const fundedTargets = funded.map(([id]) => {
    const pct = totalUsd > 0 ? Number((((usdById.get(id) ?? 0) / totalUsd) * 100).toFixed(2)) : 0;
    return makeTarget(id, pct, defaultTolerancePct, false);
  });

  if (fundedTargets.length > 0) {
    const sum = fundedTargets.reduce((s, t) => s + (Number(t.targetPct) || 0), 0);
    const drift = Number((100 - sum).toFixed(2));
    if (Math.abs(drift) >= 0.01) {
      let bestIndex = 0;
      let bestValue = -Infinity;
      fundedTargets.forEach((t, i) => {
        const v = Number(t.targetPct) || 0;
        if (v > bestValue) {
          bestValue = v;
          bestIndex = i;
        }
      });
      fundedTargets[bestIndex] = {
        ...fundedTargets[bestIndex],
        targetPct: Number((bestValue + drift).toFixed(2)),
      };
    }
  }

  const targetOnlyTargets = targetOnlyIds
    .filter((id) => !(allocations[id] > 0))
    .map((id) => makeTarget(id, 0, defaultTolerancePct, false));

  return [...fundedTargets, ...targetOnlyTargets];
}

// USD-weighted share (%) of one token across an effective portfolio (committed balances
// + draft deltas), using the same (qty × price) / totalUsd weighting as the rendered
// rows. Seeds a freshly-allocated token's target at its current weight so funding from
// My Account keeps targets == current weights (allocate update to D-143(3)).
export function currentUsdWeightPct(
  tokenId: string,
  committedBalances: CurrentPortfolioQty,
  deltas: Record<string, number>,
  prices: TokenPriceMap
): number {
  let totalUsd = 0;
  let tokenUsd = 0;
  const ids = new Set([...Object.keys(committedBalances), ...Object.keys(deltas)]);
  for (const id of ids) {
    const qty = (committedBalances[id] ?? 0) + (deltas[id] ?? 0);
    if (qty <= 0) continue;
    const token = getTokenById(id);
    const price = prices[id]?.usdPrice ?? token?.fallbackUsdPrice ?? 0;
    const usd = qty * price;
    totalUsd += usd;
    if (id === tokenId) tokenUsd = usd;
  }
  return totalUsd > 0 ? (tokenUsd / totalUsd) * 100 : 0;
}

export function distributeUnlockedTargetPct(targets: TargetAllocation[], changedId: string, nextPct: number | string) {
  const changed = targets.find((target) => target.id === changedId);
  if (!changed || changed.locked) return { targets, clamped: false };

  const safeNextPct = Math.max(0, Math.min(100, Number(nextPct) || 0));
  const fixed = (target: TargetAllocation) => target.locked || !canGrow(target);
  const lockedTotal = targets
    .filter((target) => fixed(target) && target.id !== changedId)
    .reduce((sum, target) => sum + (Number(target.targetPct) || 0), 0);
  const ownCeiling = canGrow(changed) ? 100 : Number(changed.targetPct) || 0;
  const maxAllowed = Math.max(0, Math.min(ownCeiling, 100 - lockedTotal));
  const changedPct = Math.min(safeNextPct, maxAllowed);
  const clamped = changedPct < safeNextPct;
  const remainingForOthers = Math.max(0, 100 - lockedTotal - changedPct);
  const otherUnlocked = targets.filter((target) => !fixed(target) && target.id !== changedId);
  const otherUnlockedTotal = otherUnlocked.reduce((sum, target) => sum + (Number(target.targetPct) || 0), 0);

  const next = targets.map((target) => {
    if (target.id === changedId) return { ...target, targetPct: Number(changedPct.toFixed(2)) };
    if (fixed(target) || otherUnlocked.length === 0) return target;
    const currentPct = Number(target.targetPct) || 0;
    const nextOtherPct = otherUnlockedTotal > 0
      ? (currentPct / otherUnlockedTotal) * remainingForOthers
      : remainingForOthers / otherUnlocked.length;
    return { ...target, targetPct: Number(nextOtherPct.toFixed(2)) };
  });

  const sumNow = next.reduce((sum, target) => sum + (Number(target.targetPct) || 0), 0);
  const drift = Number((100 - sumNow).toFixed(2));

  if (Math.abs(drift) >= 0.01 && otherUnlocked.length > 0) {
    let bestIndex = -1;
    let bestValue = -Infinity;

    next.forEach((target, index) => {
      if (target.id === changedId || fixed(target)) return;
      const value = Number(target.targetPct) || 0;
      if (value > bestValue) {
        bestValue = value;
        bestIndex = index;
      }
    });

    if (bestIndex >= 0) {
      next[bestIndex] = {
        ...next[bestIndex],
        targetPct: Math.max(0, Math.min(100, Number((bestValue + drift).toFixed(2))))
      };
    }
  }

  return { targets: next, clamped };
}

// D-143 (5.2): a held-but-untargeted row is editable — typing a target % promotes it
// into a real target and re-includes it in the mix. The promoted target keeps a stable
// id (`held-${tokenId}`) so the table row's React key survives the synthetic→real
// transition and the input never loses focus mid-keystroke. Redistribution then keeps
// the unlocked rows summing to 100.
export function promoteHeldToTarget(
  targets: TargetAllocation[],
  tokenId: string,
  nextPct: number | string,
  defaultTolerancePct = 10
): TargetAllocation[] {
  const existing = targets.find((target) => target.tokenId === tokenId);
  if (existing) {
    // Already a target (defensive — a held row should never be in `targets`): just
    // route through the normal redistribution path.
    return distributeUnlockedTargetPct(targets, existing.id, nextPct).targets;
  }
  const promoted = [
    ...targets,
    { ...makeTarget(tokenId, 0, defaultTolerancePct, false), id: `held-${tokenId}` }
  ];
  return distributeUnlockedTargetPct(promoted, `held-${tokenId}`, nextPct).targets;
}

// D-513: a held token promoted in this draft and taken back to 0% goes back to being held.
// Kept as a 0% target, Save would sign it as a new composition token for nothing: a held
// token and a 0% target are both sold whole (D-514).
export function demotePromotedAtZero(targets: TargetAllocation[]): TargetAllocation[] {
  const next = targets.filter((target) => !(target.id === `held-${target.tokenId}` && (Number(target.targetPct) || 0) === 0));
  return next.length === targets.length ? targets : next;
}

export function removeAndRedistributeTarget(targets: TargetAllocation[], id: string): TargetAllocation[] {
  const removed = targets.find((t) => t.id === id);
  const remaining = targets.filter((t) => t.id !== id);
  const freedPct = removed ? (Number(removed.targetPct) || 0) : 0;

  if (freedPct === 0 || remaining.length === 0) return remaining;

  // 027 A-11: the freed % goes to the unlocked rows; with none left it goes to every row,
  // locked ones included, so a removal always keeps the total at 100. The lock still
  // shields a row from edits to other rows' %, not from a removal.
  // D-491: rows that can't grow take none of it, unless nothing else is left to.
  const pool = remaining.some(canGrow) ? remaining.filter(canGrow) : remaining;
  const poolIds = new Set(pool.map((row) => row.id));
  const anyUnlocked = pool.some((row) => !row.locked);
  const receives = (row: TargetAllocation) => poolIds.has(row.id) && (!anyUnlocked || !row.locked);
  const receivers = remaining.filter(receives);

  const receiversSum = receivers.reduce((s, row) => s + (Number(row.targetPct) || 0), 0);
  const redistributed = remaining.map((row) => {
    if (!receives(row)) return row;
    const currentPct = Number(row.targetPct) || 0;
    const share = receiversSum > 0 ? currentPct / receiversSum : 1 / receivers.length;
    return { ...row, targetPct: Number((currentPct + freedPct * share).toFixed(2)) };
  });

  const sumNow = redistributed.reduce((s, r) => s + (Number(r.targetPct) || 0), 0);
  const drift = Number((100 - sumNow).toFixed(2));

  if (Math.abs(drift) >= 0.01) {
    let bestIndex = -1;
    let bestValue = -Infinity;
    redistributed.forEach((row, i) => {
      if (!receives(row)) return;
      const v = Number(row.targetPct) || 0;
      if (v > bestValue) { bestValue = v; bestIndex = i; }
    });
    if (bestIndex >= 0) {
      redistributed[bestIndex] = {
        ...redistributed[bestIndex],
        targetPct: Math.max(0, Math.min(100, Number((bestValue + drift).toFixed(2))))
      };
    }
  }

  return redistributed;
}

// 027 A-11: the % removing `id` will spread over locked rows — set only when no other row
// is unlocked (see removeAndRedistributeTarget), so the remove dialog can say so first.
export function lockedSpreadPct(targets: TargetAllocation[], id: string): number | null {
  const removed = targets.find((row) => row.id === id);
  const others = targets.filter((row) => row.id !== id);
  const pct = removed ? Number(removed.targetPct) || 0 : 0;
  const pool = others.some(canGrow) ? others.filter(canGrow) : others;
  if (pct <= 0 || others.length === 0 || pool.some((row) => !row.locked)) return null;
  return pct;
}

// Removal as the editor applies it: the freed % goes to the unlocked rows, and if that
// leaves a single unlocked row among several, every row locks (one unlocked row has
// nothing to trade % with). `autoLocked` tells the caller to say so.
export function removeTargetFromDraft(
  targets: TargetAllocation[],
  id: string
): { targets: TargetAllocation[]; autoLocked: boolean } {
  const next = removeAndRedistributeTarget(targets, id);
  const unlockedCount = next.filter((row) => !row.locked).length;
  if (next.length >= 2 && unlockedCount === 1) {
    return { targets: next.map((row) => (row.locked ? row : { ...row, locked: true })), autoLocked: true };
  }
  return { targets: next, autoLocked: false };
}

function sameRows(a: TargetAllocation[], b: TargetAllocation[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (row, i) =>
        row.id === b[i].id &&
        row.tokenId === b[i].tokenId &&
        row.targetPct === b[i].targetPct &&
        row.tolerancePct === b[i].tolerancePct &&
        row.locked === b[i].locked
    )
  );
}

// Below this a redistributed % is the same one the portfolio holds, give or take the
// 2-decimal rounding of the proportional split.
const RESTORE_SNAP_PCT = 0.02;

// 021 R2: "Undo" on a row the draft removed puts that committed token back.
//
// `before` is the draft as it was right before the removal. If nothing was edited since,
// the draft still equals what the removal produced from it, and `before` comes back as is —
// the exact inverse, locks and auto-lock included. Otherwise (other rows edited, or the
// snapshot is gone after a reload) the token returns at its committed row, in its committed
// position, taking its % back from the unlocked rows the same way typing a % does. Rows the
// split lands within rounding of their committed % snap back to it, so remove + undo does
// not leave 0.01% changes to sign.
export function restoreRemovedTarget(
  draft: TargetAllocation[],
  committed: TargetAllocation[],
  tokenId: string,
  before?: TargetAllocation[]
): TargetAllocation[] {
  const prev = committed.find((row) => row.tokenId === tokenId);
  if (!prev || draft.some((row) => row.tokenId === tokenId)) return draft;

  if (before) {
    const removedRow = before.find((row) => row.tokenId === tokenId);
    if (removedRow && sameRows(removeTargetFromDraft(before, removedRow.id).targets, draft)) {
      return before;
    }
  }

  // Committed position: before the first draft row that comes after it in the portfolio
  // (rows the portfolio does not hold yet sort last).
  const order = new Map(committed.map((row, i) => [row.tokenId, i]));
  const at = order.get(tokenId) ?? Infinity;
  const insertAt = draft.findIndex((row) => (order.get(row.tokenId) ?? Infinity) > at);
  const restored = { ...prev, locked: false };
  const inserted =
    insertAt === -1 ? [...draft, restored] : [...draft.slice(0, insertAt), restored, ...draft.slice(insertAt)];
  const spread = distributeUnlockedTargetPct(inserted, prev.id, Number(prev.targetPct) || 0).targets.map((row) =>
    row.id === prev.id ? { ...row, locked: prev.locked } : row
  );

  const committedPct = new Map(committed.map((row) => [row.tokenId, Number(row.targetPct) || 0]));
  const snapped = spread.map((row) => {
    const pct = committedPct.get(row.tokenId);
    const current = Number(row.targetPct) || 0;
    return pct !== undefined && Math.abs(current - pct) <= RESTORE_SNAP_PCT ? { ...row, targetPct: pct } : row;
  });
  const sum = (rows: TargetAllocation[]) => rows.reduce((s, row) => s + (Number(row.targetPct) || 0), 0);
  return Math.abs(sum(snapped) - sum(spread)) < 0.005 ? snapped : spread;
}

export function setAllLockState(targets: TargetAllocation[], locked: boolean) {
  return targets.map((target) => ({ ...target, locked }));
}

export function getEffectiveCurrentPortfolio(currentPortfolioQty: CurrentPortfolioQty, withdrawnQty: WithdrawnQty) {
  return Object.fromEntries(
    Object.entries(currentPortfolioQty).map(([tokenId, qty]) => [
      tokenId,
      Math.max(0, qty - (withdrawnQty[tokenId] || 0))
    ])
  );
}
