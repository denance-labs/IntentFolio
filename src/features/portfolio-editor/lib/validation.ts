// Editor-side adapter over the shared rules module (5.0). The contract gate and
// this inline engine evaluate the SAME predicates (evaluatePortfolioRules), so the
// editor's real-time feedback cannot drift from what commitPortfolioChanges accepts.
//
// This adapter only reshapes the structured violations for rendering: global vs
// per-row (by tokenId), plus a hasErrors flag that gates the Save/Confirm button.
// Message text is owned by the i18n layer (RULE_MESSAGE_KEYS → translations).

import {
  evaluatePortfolioRules,
  type RuleCode,
  type RuleViolation,
} from "@/features/intents-account/mock-contract/rules";
import type { ComputedTargetAllocation, CurrentPortfolioQty } from "../types";

export type { RuleViolation, RuleCode };

export type CompositionValidation = {
  violations: RuleViolation[];
  global: RuleViolation[]; // violations without a tokenId — rendered in the summary
  byTokenId: Record<string, RuleViolation[]>; // per-row, keyed by tokenId (unique per row)
  hasErrors: boolean; // any error-severity violation → Save is disabled
};

export type ValidateCompositionOptions = {
  /**
   * Drop the `no-funded-token` gate (007.plan Phase 2).
   *
   * That rule mirrors the MOCK contract, which models an emptied portfolio as one that
   * gets deleted (see the portfolio-emptied → delete flow in the editor). The VAULT models
   * it differently and on purpose: `apply_settled_leg` prunes `qty_held` and keeps the
   * portfolio alive with its composition intact — deleting is a separate, operator-gated
   * op (FU-DEL / D-152). So for a live-vault portfolio an empty balance is a legitimate
   * on-chain state, and blocking it would make a full withdrawal impossible.
   *
   * This does not break the adapter's "no drift from the gate" invariant, it keeps it:
   * the gate for a mirrored portfolio IS the vault, and the real path never reaches
   * `mockContract.commitPortfolioChanges`.
   */
  allowEmptyPortfolio?: boolean;

  /**
   * Drop the `zero-target-zero-balance` gate (008.plan Phase 2, D-187).
   *
   * Same shape of divergence as `allowEmptyPortfolio`, and for the same reason: this is
   * §7.1 rule 4 ("no `balance == 0 && target == 0` dead row"), which the MOCK enforces
   * and the VAULT does not. Verified against the deployed contract source: `apply_commit`
   * (`unallocate.rs`) runs shape caps → `validate_change_set` → ownership →
   * `resulting_composition` → token cap → nonce → reservoir/pause → per-leg gates, and
   * never evaluates rules 4 or 5. They exist in `contract-spec.md` §7.1 and in the
   * `composition.rs` header (both claim commit-time enforcement) but not in the WASM.
   *
   * Keeping the rule on a live-vault portfolio makes a legal on-chain state unreachable: a
   * token with no balance yet joining at 0% is precisely the row this gate rejects, while the
   * same change set is valid for the vault. (The staging contract required every addition to
   * join at 0%; the final one also takes an addition with its target, FE #6 — D-187.)
   */
  allowZeroTargetZeroBalance?: boolean;
};

export function validateComposition(
  rows: ComputedTargetAllocation[],
  balances: CurrentPortfolioQty,
  options: ValidateCompositionOptions = {}
): CompositionValidation {
  const composition = rows.map((r) => ({
    tokenId: r.tokenId,
    targetPct: r.targetPct,
    tolerancePct: r.tolerancePct,
  }));

  // Rules the VAULT does not enforce (see the option docs). Dropped per-option rather
  // than behind one "live vault" flag: they are distinct §7.1 rules, and a future
  // contract could implement one without the other.
  const dropped = new Set<RuleCode>();
  if (options.allowEmptyPortfolio) dropped.add("no-funded-token");
  if (options.allowZeroTargetZeroBalance) dropped.add("zero-target-zero-balance");

  const evaluated = evaluatePortfolioRules(composition, balances);
  const violations = dropped.size > 0
    ? evaluated.filter((v) => !dropped.has(v.code))
    : evaluated;

  const global: RuleViolation[] = [];
  const byTokenId: Record<string, RuleViolation[]> = {};
  for (const v of violations) {
    if (v.tokenId === undefined) {
      global.push(v);
    } else {
      (byTokenId[v.tokenId] ??= []).push(v);
    }
  }

  return {
    violations,
    global,
    byTokenId,
    hasErrors: violations.some((v) => v.severity === "error"),
  };
}

// Maps each rule code to its translation key. Both the table (per-row) and the
// editor (global summary) localize through these keys, so the copy lives in one place.
export const RULE_MESSAGE_KEYS: Record<RuleCode, string> = {
  "empty-composition": "ruleEmptyComposition",
  "sum-not-100": "ruleSumNot100",
  "no-target-above-zero": "ruleNoTargetAboveZero",
  "zero-target-zero-balance": "ruleZeroTargetZeroBalance",
  "no-funded-token": "ruleNoFundedToken",
  "tolerance-below-min": "ruleToleranceBelowMin",
  "tolerance-above-max": "ruleToleranceAboveMax",
  "tolerance-high": "ruleToleranceHigh",
};
