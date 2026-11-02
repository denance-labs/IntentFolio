// Editing operations of the New Portfolio Draft editor (016 block 2.2). The rows are the
// draft's own (`NewPortfolioDraftRow`); every % change goes through the Composition
// editor's redistribution functions (`allocation.ts`) unchanged (plan B2), converted with
// `draftToTargets`. What this module decides on top of them — the operator's s184 answers
// (016 §7, E1/E2) and the draft's own shape — is:
//   - an added token takes an equal share of the FREE part (not 1/n of the total), so the
//     draft stays valid after every add and a pinned row is not squeezed;
//   - removing a token that leaves a single free row releases every lock (the editor has
//     no "Unlock all" to recover from Composition's lock-them-all);
//   - with one or two rows nothing is locked: one row is 100%, and two rows can never pin
//     one (the "two free rows" cap), so the lock is hidden rather than always disabled.

import {
  evaluatePortfolioRules,
  type RuleViolation,
} from "@/features/intents-account/mock-contract/rules";
import type { TokenId } from "@/features/intents-account/mock-contract/types";
import { APP_MAX_TOKENS_PER_PORTFOLIO } from "@/features/vault/lib/change-set-preflight";
import {
  distributeUnlockedTargetPct,
  removeAndRedistributeTarget,
  removeTargetFromDraft,
} from "@/features/portfolio-editor/lib/allocation";
import type { TargetAllocation } from "@/features/portfolio-editor/types";
import { getPreset, type PresetId } from "@/content/portfolio-presets";
import { draftToTargets, type NewPortfolioDraftRow } from "./new-portfolio-draft";

// "Start from scratch" tolerance, the same default as the funded scratch path.
export const DRAFT_DEFAULT_TOLERANCE_PCT = 10;

/** The tolerance a newly added token gets: the preset's, else the scratch default. */
export function draftDefaultTolerance(presetId: PresetId | null): number {
  return (presetId && getPreset(presetId)?.tolerancePct) || DRAFT_DEFAULT_TOLERANCE_PCT;
}

/** First unused "<base>" / "<base> N", so a default name never collides (as the create modals do). */
export function uniqueDefaultName(base: string, existing: string[]): string {
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  let i = 2;
  while (taken.has(`${base} ${i}`.toLowerCase())) i++;
  return `${base} ${i}`;
}

/**
 * What the % field keeps of the typed text: digits and one decimal separator ("," becomes
 * "."), cut at 2 decimals. Cut as text, not as a number: `Math.trunc(33.33 * 100)` is 3332.
 */
export function sanitizeDraftPctInput(raw: string): string {
  const [int, ...rest] = raw.replace(/,/g, ".").replace(/[^\d.]/g, "").split(".");
  return rest.length === 0 ? int : `${int}.${rest.join("").slice(0, 2)}`;
}

/** A preset's slots as draft rows, with the preset's tolerance and nothing locked. */
export function presetDraftRows(presetId: PresetId): NewPortfolioDraftRow[] {
  const preset = getPreset(presetId);
  if (!preset) return [];
  return preset.slots.map((slot) => ({
    tokenId: slot.tokenId,
    targetPct: slot.targetPct,
    tolerancePct: preset.tolerancePct,
    locked: false,
  }));
}

function fromTargets(targets: TargetAllocation[]): NewPortfolioDraftRow[] {
  return targets.map((t) => ({
    tokenId: t.tokenId,
    targetPct: Number(t.targetPct) || 0,
    tolerancePct: Number(t.tolerancePct) || 0,
    locked: t.locked,
  }));
}

const idOf = (tokenId: TokenId) => `target-${tokenId}`;

function round2(n: number): number {
  return Number(n.toFixed(2));
}

/**
 * The lock invariant of the draft: with ≤ 2 rows nothing is locked, and a lone row holds
 * 100%. Applied after every structural change and to a draft being resumed.
 */
export function normalizeDraftLocks(rows: NewPortfolioDraftRow[]): NewPortfolioDraftRow[] {
  if (rows.length === 1) return [{ ...rows[0], targetPct: 100, locked: false }];
  if (rows.length === 2 && rows.some((r) => r.locked)) return rows.map((r) => ({ ...r, locked: false }));
  return rows;
}

export function draftHasToken(rows: NewPortfolioDraftRow[], tokenId: TokenId): boolean {
  return rows.some((r) => r.tokenId === tokenId);
}

/**
 * E1: the new token takes an equal share of what is not locked — `free / (freeRows + 1)` —
 * and the other free rows shrink in proportion (the redistribution function does that).
 * From scratch: 100 → 50/50 → 33.33/33.34/33.33 (the redistribution's rounding fix lands
 * the odd cent on a free row). A duplicate or a token past the app's cap (D-528) is a no-op.
 */
export function addDraftToken(
  rows: NewPortfolioDraftRow[],
  tokenId: TokenId,
  tolerancePct: number
): NewPortfolioDraftRow[] {
  if (draftHasToken(rows, tokenId) || rows.length >= APP_MAX_TOKENS_PER_PORTFOLIO) return rows;
  const lockedTotal = rows.filter((r) => r.locked).reduce((sum, r) => sum + r.targetPct, 0);
  const freeRows = rows.filter((r) => !r.locked).length;
  const share = round2(Math.max(0, 100 - lockedTotal) / (freeRows + 1));
  const withNew = [...rows, { tokenId, targetPct: 0, tolerancePct, locked: false }];
  const { targets } = distributeUnlockedTargetPct(draftToTargets({ rows: withNew }), idOf(tokenId), share);
  return normalizeDraftLocks(fromTargets(targets));
}

/**
 * Removes a token; its % goes to the free rows in proportion. E2: if that leaves exactly
 * one free row among several, every lock is released (`locksReleased`) — the numbers do
 * not change, the rows just become editable again.
 */
export function removeDraftToken(
  rows: NewPortfolioDraftRow[],
  tokenId: TokenId
): { rows: NewPortfolioDraftRow[]; locksReleased: boolean } {
  if (!draftHasToken(rows, tokenId)) return { rows, locksReleased: false };
  const next = fromTargets(removeAndRedistributeTarget(draftToTargets({ rows }), idOf(tokenId)));
  const freeRows = next.filter((r) => !r.locked).length;
  const locksReleased = next.length >= 3 && freeRows === 1;
  const released = locksReleased ? next.map((r) => ({ ...r, locked: false })) : next;
  return { rows: normalizeDraftLocks(released), locksReleased };
}

/**
 * 027 A-10: a removal in the draft's table, which has Composition's "Lock all / Unlock all",
 * so it follows Composition's rule rather than E2: if one free row is left among several,
 * every row locks (`autoLocked`) and "Unlock all" brings them back.
 */
export function removeDraftTokenInTable(
  rows: NewPortfolioDraftRow[],
  tokenId: TokenId
): { rows: NewPortfolioDraftRow[]; autoLocked: boolean } {
  if (!draftHasToken(rows, tokenId)) return { rows, autoLocked: false };
  const { targets, autoLocked } = removeTargetFromDraft(draftToTargets({ rows }), idOf(tokenId));
  return { rows: fromTargets(targets), autoLocked };
}

/**
 * The Composition interaction: the changed row takes the value (capped by what locked
 * rows leave) and the other free rows re-spread to keep 100. `clamped` when the cap bit.
 * The redistribution rounds to 2 decimals (1 bp, the vault's unit); the editor cuts the
 * typed text at 2 decimals before calling this, so the rounding never changes a digit.
 */
export function setDraftTokenPct(
  rows: NewPortfolioDraftRow[],
  tokenId: TokenId,
  pct: number
): { rows: NewPortfolioDraftRow[]; clamped: boolean } {
  if (rows.length <= 1) return { rows, clamped: false };
  const safe = Number.isFinite(pct) ? pct : 0;
  const { targets, clamped } = distributeUnlockedTargetPct(draftToTargets({ rows }), idOf(tokenId), safe);
  return { rows: fromTargets(targets), clamped };
}

export function setDraftTokenTolerance(
  rows: NewPortfolioDraftRow[],
  tokenId: TokenId,
  tolerancePct: number
): NewPortfolioDraftRow[] {
  return rows.map((r) => (r.tokenId === tokenId ? { ...r, tolerancePct } : r));
}

export type DraftLockState =
  | { shown: false }
  | { shown: true; canToggle: boolean };

/**
 * Whether a row's lock is shown and usable. Hidden with ≤ 2 rows. Locking is refused when
 * it would leave fewer than two free rows — the same cap as Composition's table.
 */
export function draftLockState(rows: NewPortfolioDraftRow[], tokenId: TokenId): DraftLockState {
  if (rows.length <= 2) return { shown: false };
  const row = rows.find((r) => r.tokenId === tokenId);
  if (!row) return { shown: false };
  const freeRows = rows.filter((r) => !r.locked).length;
  return { shown: true, canToggle: row.locked || freeRows > 2 };
}

export function toggleDraftTokenLock(rows: NewPortfolioDraftRow[], tokenId: TokenId): NewPortfolioDraftRow[] {
  const state = draftLockState(rows, tokenId);
  if (!state.shown || !state.canToggle) return rows;
  return rows.map((r) => (r.tokenId === tokenId ? { ...r, locked: !r.locked } : r));
}

/**
 * The highest % this row can take given the locked rows — Composition's
 * `maxAllowedPct`. A free row sitting at it gets the "unlock another row" hint.
 */
export function draftRowCeiling(rows: NewPortfolioDraftRow[], tokenId: TokenId): number {
  const lockedTotal = rows
    .filter((r) => r.locked && r.tokenId !== tokenId)
    .reduce((sum, r) => sum + r.targetPct, 0);
  return Math.max(0, Math.min(100, 100 - lockedTotal));
}

/**
 * Each row's tolerance violation (D-008: hard [2, 30] is an error, > 15 a warning), from
 * the shared rules engine — the same predicates Composition shows, keyed by token.
 */
export function draftToleranceViolations(rows: NewPortfolioDraftRow[]): Record<TokenId, RuleViolation> {
  const out: Record<TokenId, RuleViolation> = {};
  for (const v of evaluatePortfolioRules(rows, {})) {
    if (!v.tokenId) continue;
    if (v.code === "tolerance-below-min" || v.code === "tolerance-above-max" || v.code === "tolerance-high") {
      out[v.tokenId] = v;
    }
  }
  return out;
}
