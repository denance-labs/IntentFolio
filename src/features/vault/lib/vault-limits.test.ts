import { beforeEach, describe, it, expect, vi } from "vitest";
import { MIRRORED_LIMITS } from "./change-set-preflight";
import { limitsFromConfig, loadPreflightLimits, resetPreflightLimitsCache } from "./vault-limits";
import type { VaultConfig } from "./vault-read-client";

// `get_config().limits` exactly as the final contract answers it (views.rs `VaultLimits::current`,
// wasm 11f7d489…): the fields the FE reads plus the ones it ignores. The FE-read fields match
// `intentfolio-vault.near` as read on 2026-10-04 (D-366).
const V2_CONFIG = {
  limits: {
    max_portfolios_per_account: 16,
    max_linked_wallets_per_account: 10,
    max_tokens_per_portfolio: 32,
    max_token_id_len: 128,
    max_portfolio_name_len: 128,
    max_wallet_address_len: 128,
    max_unalloc_legs_per_commit: 32,
    max_composition_changes_per_commit: 64,
    max_attributions_per_reconcile: 64,
    target_sum_bps: 10_000,
    tolerance_min_bps: 200,
    tolerance_max_bps: 3_000,
    max_commit_storage_growth_bytes: 24_576,
    max_credit_storage_growth_bytes: 32_768,
    max_page_limit: 200,
    admin_timelock_secs: 172_800,
    max_unalloc_pause_secs: 259_200,
    max_commit_deadline_secs: 86_400,
  },
} as unknown as VaultConfig;

beforeEach(() => resetPreflightLimitsCache());

describe("limitsFromConfig", () => {
  it("maps the contract's limits — and the offline mirror equals them", () => {
    expect(limitsFromConfig(V2_CONFIG)).toEqual(MIRRORED_LIMITS);
  });

  it("throws on a missing or non-integer field instead of guessing", () => {
    const rest: Record<string, number> = { ...(V2_CONFIG as unknown as { limits: Record<string, number> }).limits };
    delete rest.tolerance_min_bps;
    expect(() => limitsFromConfig({ limits: rest } as unknown as VaultConfig)).toThrow(/tolerance_min_bps/);
    expect(() =>
      limitsFromConfig({ limits: { ...V2_CONFIG.limits, max_token_id_len: "128" } } as unknown as VaultConfig)
    ).toThrow(/max_token_id_len/);
    expect(() => limitsFromConfig({} as VaultConfig)).toThrow(/no limits/);
  });
});

describe("loadPreflightLimits", () => {
  it("reads get_config once and caches it", async () => {
    const read = vi.fn().mockResolvedValue(V2_CONFIG);
    const first = await loadPreflightLimits(read);
    const second = await loadPreflightLimits(read);
    expect(first).toEqual(MIRRORED_LIMITS);
    expect(second).toBe(first);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("fails closed: a failed read rejects (nothing is signed) and is not cached", async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error("RPC HTTP 502")).mockResolvedValueOnce(V2_CONFIG);
    await expect(loadPreflightLimits(read)).rejects.toThrow(/502/);
    await expect(loadPreflightLimits(read)).resolves.toMatchObject({ maxPortfolioNameLen: 128 });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("fails closed on an answer of the wrong shape too", async () => {
    const read = vi.fn().mockResolvedValue({ admin: "x.near" });
    await expect(loadPreflightLimits(read)).rejects.toThrow(/no limits/);
  });
});
