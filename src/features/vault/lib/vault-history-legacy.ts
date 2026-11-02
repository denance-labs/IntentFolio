// Its own module, free of imports: the root layout runs it on every load (allocate-record-hygiene),
// and importing vault-history.ts there would pull the token registry into every page.
const LEGACY_CACHE_PREFIXES = [
  "vault-history:v1:", // D-420
  "vault-history:v2:", // the browser's FastNEAR read, retired in 028-7 (the history route reads the database)
  "vault-rebalances:v1:", // D-493's browser read of the vault, retired in 028-3
];

/** Removes the chain-history cache entries nothing reads any more. Safe to call on every load. */
export function clearLegacyHistoryCache(): void {
  if (typeof window === "undefined") return;
  try {
    const storage = window.localStorage;
    const legacy: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key && LEGACY_CACHE_PREFIXES.some((prefix) => key.startsWith(prefix))) legacy.push(key);
    }
    for (const key of legacy) storage.removeItem(key);
  } catch {
    // Blocked storage: nothing was readable there either.
  }
}
