// Which portfolio tab should be selected, given what is currently known (008.plan Phase 2).
//
// Extracted from the provider effect because the interesting case is a TIMING one and a
// pure function is the only way to pin it: the vault read is async, so there is a window on
// every page load where a selection has already been restored from the side-table but the
// portfolio list is still empty. Reading that window as "this account has no portfolios"
// discards the restored id, and the later fill-in then falls through to the first
// portfolio — which is how a reload silently moved the user to a portfolio they had not
// chosen, and how a subsequent commit reached the wrong one.
//
// The rule: never decide anything while the list is still loading.

export type ReconcileInput = {
  /** True only while a FIRST read is in flight — see the caller's note on isLoading. */
  loading: boolean;
  portfolioIds: string[];
  activeId: string | null;
};

export type ReconcileResult =
  /** Leave the current selection alone. */
  | { change: false }
  /** Adopt `next` (null = nothing selectable). */
  | { change: true; next: string | null };

export function reconcileActivePortfolio(input: ReconcileInput): ReconcileResult {
  // Still loading: the list is not evidence of anything yet.
  if (input.loading) return { change: false };

  if (input.portfolioIds.length === 0) {
    return input.activeId === null ? { change: false } : { change: true, next: null };
  }

  // Adopt the first portfolio only when there is genuinely nothing valid selected: no
  // selection at all, or one pointing at a portfolio that no longer exists.
  if (!input.activeId || !input.portfolioIds.includes(input.activeId)) {
    return { change: true, next: input.portfolioIds[0] };
  }

  return { change: false };
}
