// Post-submit confirmation for a COMPOSITION-ONLY commit (008.plan, Phase 2).
//
// Why this exists: a composition-only `commit_portfolio_changes` opens no pending and
// moves no funds, so there is nothing to *settle* — and the code used to return as soon
// as the relayer had submitted. But "nothing to settle" is not "nothing to confirm": the
// caller invalidates the vault read-model right after, and a refetch that races the chain
// caches the PRE-commit composition. With `staleTime` on that query, the user then stares
// at their old targets and concludes the save was lost (it was not — it is on-chain).
//
// So this waits for the one thing that actually matters to the UI: that the new
// composition is READABLE. No funds are at risk here in any outcome — the commit either
// landed or it did not, and this only decides when to re-read.
//
// A timeout is NOT a failure and must never be reported as one. The commit may well have
// landed; we just could not observe it in time. The caller proceeds and the UI refreshes
// on the next invalidation — strictly better than returning early, never a false error.

import { getPortfolio } from "./vault-read-client";
import type { CompositionRowBps } from "./change-set-preflight";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_INTERVAL_MS = 1_000;

export type WaitForCompositionParams = {
  portfolioId: string;
  /** The composition the change set folds to — from the pre-flight, not re-derived here. */
  expected: CompositionRowBps[];
  timeoutMs?: number;
  intervalMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Order-independent comparison, keyed by token id. The contract's `resulting_composition`
 * and our mirror of it apply removals→retargets→additions in the same order, so the rows
 * SHOULD line up positionally — but a confirmation poll must not fail on an ordering
 * assumption. Matching the row set exactly (same tokens, same bps) is precise enough:
 * every value the user changed is checked.
 */
function sameComposition(a: CompositionRowBps[], b: CompositionRowBps[]): boolean {
  if (a.length !== b.length) return false;
  const byToken = new Map(b.map((row) => [row.tokenId, row]));
  return a.every((row) => {
    const other = byToken.get(row.tokenId);
    return (
      other !== undefined &&
      other.targetBps === row.targetBps &&
      other.toleranceBps === row.toleranceBps
    );
  });
}

/**
 * Polls `get_portfolio` until the vault reports `expected`.
 *
 * Resolves `true` once observed, `false` on timeout. It never throws and never rejects:
 * see the header — an unobserved commit is not a lost one, and the caller has no
 * remediation to offer for it.
 */
export async function waitForCompositionCommit(
  p: WaitForCompositionParams
): Promise<boolean> {
  const timeoutMs = p.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = p.intervalMs ?? DEFAULT_INTERVAL_MS;
  const sleep = p.sleep ?? defaultSleep;
  const now = p.now ?? Date.now;
  const startedAt = now();

  for (;;) {
    try {
      const portfolio = await getPortfolio(p.portfolioId);
      if (portfolio) {
        const onChain = portfolio.composition.map((c) => ({
          tokenId: c.token_id,
          targetBps: c.target_bps,
          toleranceBps: c.tolerance_bps,
        }));
        if (sameComposition(p.expected, onChain)) return true;
      }
    } catch {
      // Transient read error — keep waiting. Same reasoning as unallocate-poll.
    }

    if (now() - startedAt >= timeoutMs) return false;
    await sleep(intervalMs);
  }
}
