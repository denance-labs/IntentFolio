// The pre-flight's limits for the configured vault (017-9a, T2).
//
// `get_config().limits` — the contract's own numbers, so no signing path relies on a cap
// copied by hand (D-334, D-361, D-302 e). Those limits are compile-time constants of the
// deployed code: they change only with an upgrade, so one read per page load is enough.
//
// FAIL CLOSED. These limits are the orphan guards of the Allocate path — a Setup or an
// AllocateInto the vault refuses inside `on_auth` strands the funds — so a read that fails, or
// answers something that is not the shape below, throws and nothing is signed. Falling back to
// the mirrored constants (change-set-preflight.ts) would guard a contract we did not read.
//
// Attribution: see ATTRIBUTIONS.md #8.

import type { PreflightLimits } from "./change-set-preflight";
import { getConfig, type VaultConfig, type VaultLimits } from "./vault-read-client";

const NUMERIC_FIELDS = [
  "max_portfolios_per_account",
  "max_tokens_per_portfolio",
  "max_token_id_len",
  "max_portfolio_name_len",
  "max_wallet_address_len",
  "max_unalloc_legs_per_commit",
  "max_composition_changes_per_commit",
  "target_sum_bps",
  "tolerance_min_bps",
  "tolerance_max_bps",
] as const satisfies ReadonlyArray<keyof VaultLimits>;

/** `get_config().limits` → the pre-flight's rules. Throws on any field that is not a positive integer. */
export function limitsFromConfig(config: VaultConfig): PreflightLimits {
  const raw: unknown = config?.limits;
  if (typeof raw !== "object" || raw === null) throw new Error("get_config has no limits");
  const limits = raw as Record<string, unknown>;
  for (const field of NUMERIC_FIELDS) {
    const value = limits[field];
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      throw new Error(`get_config limits.${field} is not a positive integer: ${String(value)}`);
    }
  }
  const l = raw as VaultLimits;
  return {
    targetSumBps: l.target_sum_bps,
    toleranceMinBps: l.tolerance_min_bps,
    toleranceMaxBps: l.tolerance_max_bps,
    maxTokensPerPortfolio: l.max_tokens_per_portfolio,
    maxCompositionChangesPerCommit: l.max_composition_changes_per_commit,
    maxUnallocLegsPerCommit: l.max_unalloc_legs_per_commit,
    maxTokenIdLen: l.max_token_id_len,
    maxPortfoliosPerAccount: l.max_portfolios_per_account,
    maxPortfolioNameLen: l.max_portfolio_name_len,
    maxWalletAddressLen: l.max_wallet_address_len,
  };
}

let cached: Promise<PreflightLimits> | null = null;

/**
 * The limits to validate against: the chain's, read once and cached; a failed read is not
 * cached, so the next attempt reads again.
 */
export function loadPreflightLimits(read: () => Promise<VaultConfig> = getConfig): Promise<PreflightLimits> {
  if (!cached) {
    const attempt = read().then(limitsFromConfig);
    cached = attempt;
    attempt.catch(() => {
      if (cached === attempt) cached = null;
    });
  }
  return cached;
}

/** Tests only. */
export function resetPreflightLimitsCache(): void {
  cached = null;
}
