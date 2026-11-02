// Post-submit confirmation for ③ Unallocate (007.plan, Phase 2).
//
// Why polling and not the tx receipt: `commit_portfolio_changes` only OPENS the
// withdrawal. It locks the legs, fires an `mt_batch_transfer` on the Verifier and settles
// in a `#[private]` callback (unallocate.rs `on_unallocate_resolved`). Until that callback
// lands, `qty_held` is unchanged — the debit happens at settle, not at commit
// (`apply_settled_leg`). So the only trustworthy confirmation is the vault ledger itself
// showing the position drained.
//
// A timeout is NOT a loss and must never be reported as one: if the batch reverts, the
// contract releases the locks and the funds stay in the portfolio. There is no orphan on
// this leg — nothing to rescue, only something to retry.

import { getPortfolioBalance } from "./vault-read-client";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_INTERVAL_MS = 3_000;

export type UnallocateExpectation = {
  tokenId: string;
  /** Base units the position must be at or below once the withdrawal settles. */
  expectedRemaining: bigint;
};

export type WaitForUnallocateParams = {
  portfolioId: string;
  legs: UnallocateExpectation[];
  /**
   * v2 (D-379): true once OUR batch is no longer pending (`get_pending_unallocation(commit_id)`
   * answers null). Without it the balance alone can read "settled" early: with another
   * withdrawal of the same position in flight, that one settling can drop the balance below
   * our expected remainder before ours lands. Balances are only judged after this says yes.
   */
  batchResolved?: () => Promise<boolean>;
  timeoutMs?: number;
  intervalMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Polls the vault ledger until every withdrawn leg has settled. Resolves with the
 * portfolio's remaining balances (base units) — the caller re-syncs its mirror from
 * these, never from the amounts it asked for.
 *
 * Throws on timeout. The funds are still in the portfolio when that happens.
 */
export async function waitForUnallocateSettlement(
  p: WaitForUnallocateParams
): Promise<Array<[string, bigint]>> {
  const timeoutMs = p.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = p.intervalMs ?? DEFAULT_INTERVAL_MS;
  const sleep = p.sleep ?? defaultSleep;
  const now = p.now ?? Date.now;
  const startedAt = now();

  // Transient read errors must not abort the wait: the withdrawal is in flight and giving
  // up early would leave the UI claiming less than the chain will do.
  let lastError: unknown;

  for (;;) {
    try {
      const resolved = p.batchResolved ? await p.batchResolved() : true;
      if (!resolved) throw new Error("the withdrawal batch is still pending");
      const balances = await getPortfolioBalance(p.portfolioId);
      const held = new Map(balances);
      const settled = p.legs.every(
        (leg) => (held.get(leg.tokenId) ?? BigInt(0)) <= leg.expectedRemaining
      );
      if (settled) return balances;
    } catch (e) {
      lastError = e;
    }

    if (now() - startedAt >= timeoutMs) {
      const suffix = lastError instanceof Error ? ` (last read error: ${lastError.message})` : "";
      throw new Error(
        `Unallocate not settled within ${Math.round(timeoutMs / 1000)}s${suffix}. ` +
          `The funds are still held by the portfolio — nothing was lost.`
      );
    }
    await sleep(intervalMs);
  }
}
