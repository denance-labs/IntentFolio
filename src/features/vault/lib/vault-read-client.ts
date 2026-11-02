// Read-only client for the IntentFolio vault (`VAULT_CONTRACT_ID`; there is no default, D-398).
// The RPC plumbing now lives in near-view.ts, shared with the Verifier's `current_salt`
// read (Phase 1 added that third caller, which is the trigger this file called out).
//
// Reads only — no funds move here. Write paths (Allocate / Unallocate) go through the
// wallet's signAndSendTransaction / a relayer.

import { VAULT_CONTRACT_ID } from "@/features/wallet/config/network";
import { toIntentsTokenId, toRegistryTokenId } from "@/features/market/lib/intents-token-id";
import { viewCall } from "./near-view";
import type { AllowedViewMethod } from "@/features/wallet/lib/near-rpc-proxy";

function vaultView<T>(methodName: AllowedViewMethod, args: Record<string, unknown> = {}): Promise<T> {
  return viewCall<T>(VAULT_CONTRACT_ID, methodName, args);
}

// ── Health check ─────────────────────────────────────────────────────────────
// Confirms the configured account is the initialised vault (solver key matches the
// deploy) and that it is operable (no pause area engaged). Used to fail fast before a
// wet round-trip, and as a sanity probe in dev.

/** One paused area. `until` is unix seconds; a pause past it is dead (the contract expires it lazily). */
export type AreaPause = { until: number | null; reason: string; since: number; actor: string };

/** Indexed by `PauseArea`: [0] Allocations, [1] Unallocations, [2] SolverOps. `null` = not paused. */
export type PauseState = { areas: (AreaPause | null)[] };

export async function getSolverPubkey(): Promise<string> {
  return vaultView<string>("get_solver_pubkey");
}

export async function getPauseState(): Promise<PauseState> {
  return vaultView<PauseState>("get_pause_state");
}

// ── Core round-trip reads ────────────────────────────────────────────────────

export async function listPortfoliosFor(accountId: string): Promise<string[]> {
  return vaultView<string[]>("list_portfolios_for", { account_id: accountId });
}

// get_portfolio_balance returns Vec<(TokenId, U128)>; U128 serialises as a decimal
// string. We surface it as [tokenId, bigint] pairs — the raw base units, no rounding.
//
// Token ids are translated back to REGISTRY ids here (`nep141:wrap.near` → `near`), and the
// same is done for the stored composition below. This file is the whole read boundary, so
// doing it here means nothing downstream — the credit poll, the maturity clock, the
// projection, the editor — ever has to know that the vault spells NEAR differently. The
// projection in particular fails SILENTLY on an unknown id: `getTokenById` answers
// undefined and `projectVaultPortfolio` skips the row, so a NEAR position would render as
// a portfolio that holds nothing.
export async function getPortfolioBalance(portfolioId: string): Promise<Array<[string, bigint]>> {
  const raw = await vaultView<Array<[string, string]>>("get_portfolio_balance", {
    portfolio_id: portfolioId,
  });
  return raw.map(([token, amount]) => [toRegistryTokenId(token), BigInt(amount)]);
}

export async function getPoolTotal(token: string): Promise<bigint> {
  const raw = await vaultView<string>("get_pool_total", {
    token: toIntentsTokenId(token),
  });
  return BigInt(raw);
}

// ── Read-model reads (008.plan Phase 1, D-R6) ────────────────────────────────
// These are what let the dashboard render a real portfolio WITHOUT the localStorage
// mirror. Shapes verified against the v1 staging vault on mainnet (2026-07-30, retired since),
// not against the contract source: the wire format is snake_case and percentages are
// basis points, both of which differ from the app's own types.

/** One composition row as the contract stores it: bps, not percent. */
export type VaultCompositionEntry = {
  token_id: string;
  target_bps: number;
  tolerance_bps: number;
};

export type VaultPortfolio = {
  owner: string;
  name: string;
  composition: VaultCompositionEntry[];
  held_tokens: string[];
  /** UNIX seconds — the app works in milliseconds, so callers must scale it. */
  created_at: number;
  deleted: boolean;
  deleted_at: number;
};

export type VaultAccount = {
  linked_wallets: Array<[string, string]>;
  portfolios: string[];
  created_at: number;
};

/** One portfolio as read from the vault: its id, its record, and its ledger balances. */
export type RealPortfolioRead = {
  id: string;
  portfolio: VaultPortfolio;
  /** `get_portfolio_balance` output: base units, keyed by contract token id. */
  balances: Array<[string, bigint]>;
};

/**
 * Returns `null` for an unknown portfolio id — the contract answers with JSON `null`
 * rather than panicking, so this is an ordinary "not found", not an error to surface.
 * On the v1 staging contract a DELETED portfolio still came back (with `deleted: true`); the
 * final contract removes the record, so a deleted one reads `null` — "issued and `null`" is
 * how `isPortfolioDeleted` (run-real-portfolio-meta.ts) tells it from one never issued. Either
 * way "deleted" and "empty but alive" (D-R15) are different states.
 */
export async function getPortfolio(portfolioId: string): Promise<VaultPortfolio | null> {
  const raw = await vaultView<VaultPortfolio | null>("get_portfolio", {
    portfolio_id: portfolioId,
  });
  if (!raw) return null;
  // Same translation as `getPortfolioBalance`, on the two id-bearing fields of the record.
  return {
    ...raw,
    composition: raw.composition.map((c) => ({ ...c, token_id: toRegistryTokenId(c.token_id) })),
    held_tokens: raw.held_tokens.map(toRegistryTokenId),
  };
}

/** Null for an account the vault has never registered. */
export async function getAccount(accountId: string): Promise<VaultAccount | null> {
  return vaultView<VaultAccount | null>("get_account", { account_id: accountId });
}

/**
 * Every portfolio the account owns, with its record and its ledger balances — the whole
 * read-model for real portfolios in one call (008.plan Phase 1, D-R6).
 *
 * `list_portfolios_for`, then `get_portfolio` + `get_portfolio_balance` per id, fanned out
 * in parallel. Three money-adjacent rules, all of them about what this must NOT do:
 *
 *  - **No silent empty.** A read failure REJECTS. It must never resolve to `[]`: the caller
 *    renders that as "you have no portfolios", which to someone who just deposited reads as
 *    lost funds. Surfacing the error is the whole difference.
 *  - **No partial list.** `Promise.all`, not `allSettled` — one unreadable portfolio fails
 *    the read instead of quietly returning the others, which would look exactly like a
 *    portfolio that vanished.
 *  - **Deleted is not empty.** `deleted: true` is dropped; a portfolio the vault keeps alive
 *    with no funds (D-R15) is not deleted and stays in the list, composition and all.
 */
export async function readPortfoliosFor(accountId: string): Promise<RealPortfolioRead[]> {
  const ids = await listPortfoliosFor(accountId);
  const reads = await Promise.all(
    ids.map(async (id): Promise<RealPortfolioRead | null> => {
      const [portfolio, balances] = await Promise.all([
        getPortfolio(id),
        getPortfolioBalance(id),
      ]);
      // `null` = the vault does not know this id. Listed-but-unreadable should not happen;
      // dropping it beats projecting a half-record.
      if (!portfolio || portfolio.deleted) return null;
      return { id, portfolio, balances };
    })
  );
  return reads.filter((r): r is RealPortfolioRead => r !== null);
}

// ── v2 reads (017-9a) ────────────────────────────────────────────────────────
// Views the final contract added over the staging one (Appendix D.1).

/** `get_config().limits`: the compile-time caps. Lengths count UTF-8 bytes (Appendix D.0). */
export type VaultLimits = {
  max_portfolios_per_account: number;
  max_tokens_per_portfolio: number;
  max_token_id_len: number;
  max_portfolio_name_len: number;
  max_wallet_address_len: number;
  max_unalloc_legs_per_commit: number;
  max_composition_changes_per_commit: number;
  target_sum_bps: number;
  tolerance_min_bps: number;
  tolerance_max_bps: number;
};

/** The part of `get_config` the FE reads; the rest (roles, governance, params) is ignored. */
export type VaultConfig = {
  /**
   * The next portfolio id to be issued. A well-formed `p_X` with X below it that
   * `get_portfolio` reads as `null` was deleted (ADR-0023 §3).
   */
  portfolio_counter: number;
  /**
   * The next Return id to be issued. Ids run from 0 and are never reused: the pending Returns
   * are the ids below it for which `get_return` is not `null`.
   */
  return_counter: number;
  limits: VaultLimits;
};

export async function getConfig(): Promise<VaultConfig> {
  return vaultView<VaultConfig>("get_config");
}

/** One entry of `get_portfolio_positions`, with the token id translated like every other read. */
export type PortfolioPosition = {
  tokenId: string;
  qtyHeld: bigint;
  lockedQty: bigint;
  /** `qtyHeld − lockedQty`: what a new withdrawal may take. */
  available: bigint;
  /** Unix seconds from which a withdrawal of this token no longer defers; 0 with no clock. */
  maturesAtSecs: number;
};

type RawPortfolioPosition = {
  token: string;
  qty_held: string;
  locked_qty: string;
  available: string;
  matures_at: number;
};

/** `null` for a portfolio that does not exist (unlike `get_portfolio_balance`, which answers `[]`). */
export async function getPortfolioPositions(portfolioId: string): Promise<PortfolioPosition[] | null> {
  const raw = await vaultView<RawPortfolioPosition[] | null>("get_portfolio_positions", {
    portfolio_id: portfolioId,
  });
  if (!raw) return null;
  return raw.map((p) => ({
    tokenId: toRegistryTokenId(p.token),
    qtyHeld: BigInt(p.qty_held),
    lockedQty: BigInt(p.locked_qty),
    available: BigInt(p.available),
    maturesAtSecs: p.matures_at,
  }));
}

/** `get_allocate_seal`: `null` when no credit route applied this exact `msg`. */
export type AllocateSealView = { msg_hash: string; deadline: number };

export async function getAllocateSeal(signerId: string, msg: string): Promise<AllocateSealView | null> {
  return vaultView<AllocateSealView | null>("get_allocate_seal", { signer_id: signerId, msg });
}

/** `get_reservoir`: the two cuts the contract gates user gestures with (Appendix D.1). Other fields ignored. */
export type ReservoirStatus = { deposits_open: boolean; withdrawals_open: boolean };

export async function getReservoir(): Promise<ReservoirStatus> {
  return vaultView<ReservoirStatus>("get_reservoir");
}

/** `get_token_freeze`: `null` = not frozen. Takes a registry id; the wire id is the contract's. */
export async function getTokenFreeze(tokenId: string): Promise<{ reason: string } | null> {
  return vaultView<{ reason: string } | null>("get_token_freeze", { token: toIntentsTokenId(tokenId) });
}

/** `get_pending_unallocation`: `null` = never opened or already resolved (settled, failed or stale-resolved). */
export async function getPendingUnallocation(commitId: string): Promise<{ commit_id: string } | null> {
  return vaultView<{ commit_id: string } | null>("get_pending_unallocation", { commit_id: commitId });
}

/**
 * `get_return`: a scheduled Return (C-5, Appendix D.5) — funds the vault sends back to `to`'s
 * General Balance once `eta` (unix seconds) has passed. `null` = never issued (id at or above
 * `return_counter`), or already executed or cancelled. `amount` is base units as a string;
 * `token` is the contract's id, translated to the registry id here like every other read.
 */
export type ReturnView = {
  id: number;
  token: string;
  amount: string;
  to: string;
  reason: string;
  eta: number;
  /** `true` from `execute_return` until its final callback. */
  executing: boolean;
};

export async function getReturn(id: number): Promise<ReturnView | null> {
  const raw = await vaultView<ReturnView | null>("get_return", { id });
  if (!raw) return null;
  return { ...raw, token: toRegistryTokenId(raw.token) };
}
