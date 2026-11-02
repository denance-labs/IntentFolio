/** "0%" for nothing at all, one decimal otherwise — the editor's precision. */
export function formatShare(pct: number): string {
  return pct === 0 ? "0%" : `${pct.toFixed(1)}%`;
}
