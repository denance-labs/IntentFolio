// Single source of truth for portfolio composition validity (5.0).
//
// Both consumers evaluate the SAME predicates here so they cannot drift:
//   - the mock/vault contract (authoritative commit gate) maps the first
//     error-severity violation to its English error string (see mock-contract.ts);
//   - the editor's inline validation engine renders every violation per-row and
//     globally, localized, and disables Confirm while any error remains.
//
// The module is intentionally UI- and i18n-agnostic: it emits structured codes,
// never message text. Each consumer owns its own presentation.
//
// Rules:
//   5 universal rules (D-098): sum=100, ≥1 target>0, no 0%-target/0-balance token,
//   ≥1 funded token, non-empty composition.
//   Tolerance band (D-008): hard [2%, 30%] (error), soft >15% (warning), 2% floor.

import type { TokenId } from "./types";

// D-008: tolerance band bounds. The hard bounds are enforced as errors by both
// consumers; the soft bound is a warning the contract ignores (it only gates on
// error-severity via firstError). clampTolerance is the single choke-point the
// editor uses so an out-of-band value can never be entered in the first place.
export const TOLERANCE_MIN_PCT = 2;
export const TOLERANCE_MAX_PCT = 30;
export const TOLERANCE_SOFT_WARN_PCT = 15;

export function clampTolerance(value: number): number {
  if (Number.isNaN(value)) return TOLERANCE_MIN_PCT;
  return Math.max(TOLERANCE_MIN_PCT, Math.min(TOLERANCE_MAX_PCT, value));
}

export type RuleCode =
  | "empty-composition"
  | "sum-not-100"
  | "no-target-above-zero"
  | "zero-target-zero-balance"
  | "no-funded-token"
  | "tolerance-below-min"
  | "tolerance-above-max"
  | "tolerance-high";

export type RuleSeverity = "error" | "warning";

export type RuleViolation = {
  code: RuleCode;
  severity: RuleSeverity;
  // Present for per-row rules (zero/zero, tolerance-*); absent for global rules.
  tokenId?: TokenId;
  // Numeric context for message interpolation by each consumer.
  context?: { sum?: number; tolerancePct?: number };
};

export type CompositionEntry = {
  tokenId: TokenId;
  targetPct: number;
  tolerancePct: number;
};

// Pure. Returns every violation, ordered so that the contract's first-error
// string is preserved: empty → sum → target>0 → zero/zero → funded → tolerance.
export function evaluatePortfolioRules(
  composition: CompositionEntry[],
  balances: Record<TokenId, number>
): RuleViolation[] {
  // Empty composition short-circuits: every other rule would also fire, but the
  // only actionable feedback is "add a token". Matches the contract's early return.
  if (composition.length === 0) {
    return [{ code: "empty-composition", severity: "error" }];
  }

  const violations: RuleViolation[] = [];

  const sum = composition.reduce((acc, t) => acc + t.targetPct, 0);
  if (Math.abs(sum - 100) > 0.001) {
    violations.push({ code: "sum-not-100", severity: "error", context: { sum } });
  }

  if (!composition.some((t) => t.targetPct > 0)) {
    violations.push({ code: "no-target-above-zero", severity: "error" });
  }

  for (const entry of composition) {
    const bal = balances[entry.tokenId] ?? 0;
    if (entry.targetPct === 0 && bal === 0) {
      violations.push({ code: "zero-target-zero-balance", severity: "error", tokenId: entry.tokenId });
    }
  }

  const hasFunds = Object.values(balances).some((qty) => qty > 0);
  if (!hasFunds) {
    violations.push({ code: "no-funded-token", severity: "error" });
  }

  // D-008 tolerance band, evaluated last so structural errors take priority.
  for (const entry of composition) {
    const tol = entry.tolerancePct;
    if (tol < TOLERANCE_MIN_PCT) {
      violations.push({ code: "tolerance-below-min", severity: "error", tokenId: entry.tokenId, context: { tolerancePct: tol } });
    } else if (tol > TOLERANCE_MAX_PCT) {
      violations.push({ code: "tolerance-above-max", severity: "error", tokenId: entry.tokenId, context: { tolerancePct: tol } });
    } else if (tol > TOLERANCE_SOFT_WARN_PCT) {
      violations.push({ code: "tolerance-high", severity: "warning", tokenId: entry.tokenId, context: { tolerancePct: tol } });
    }
  }

  return violations;
}

// First error-severity violation in priority order, or null if the composition
// passes the gate. Warnings (soft) are never returned — the contract gates on
// errors only, so the soft band warning is editor-only without special-casing.
export function firstError(violations: RuleViolation[]): RuleViolation | null {
  return violations.find((v) => v.severity === "error") ?? null;
}
