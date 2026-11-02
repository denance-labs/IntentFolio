"use client";

// Durable de-dup for "already toasted this deposit as credited" (D-265).
//
// The bug it fixes: use-recent-deposits.ts used to keep the notified set in a plain
// `useRef(new Set())`, which only lives for the hook's mount. dashboard-shell.tsx passes
// `intentsAccountId: loginConnected ? intentsAccountId : ""`, and `loginConnected` starts
// false and flips true once the async wallet-session restore resolves (see project memory:
// "Wallet localStorage restore bug") — so on basically every page load the hook mounts with
// "", then the identity-change effect fires again once the real account id arrives, which
// reset the ref to an empty Set. Every deposit that was already COMPLETED at that moment then
// looked unseen and re-fired its "credited" toast, no matter how old it actually was.
//
// There is nothing server-side to filter this with either: the bridge's recent_deposits
// endpoint has no since/cursor param (checked GetDepositStatusRequest in
// @defuse-protocol/internal-utils — only account_id, chain, status, limit), and DepositStatus
// carries no timestamp field at all. The only fix is to remember, across reloads, which
// tx-hash+chain pairs this browser already announced for this account.

const KEY = "bridge.credited-deposits.v1";

/** Bounds growth for a long-lived account. Same order of magnitude as withdraw-rescue-store's
 *  evidence retention — old enough that a re-appearance past this window is worth a fresh toast. */
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// accountId -> (`${tx_hash}:${chain}` -> when we recorded the notification)
type Store = Record<string, Record<string, number>>;

function readStore(): Store {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Store;
  } catch {
    /* corrupt storage — treat as never-notified rather than blocking a real toast */
  }
  return {};
}

function writeStore(store: Store): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* storage full/unavailable — the caller's in-memory Set still prevents this-session dupes */
  }
}

function prune(store: Store, now: number): Store {
  const kept: Store = {};
  for (const [accountId, entries] of Object.entries(store)) {
    const keptEntries: Record<string, number> = {};
    for (const [key, notifiedAt] of Object.entries(entries)) {
      if (now - notifiedAt <= RETENTION_MS) keptEntries[key] = notifiedAt;
    }
    if (Object.keys(keptEntries).length > 0) kept[accountId] = keptEntries;
  }
  return kept;
}

/**
 * The notified set for one account, as of now (already pruned of anything past retention).
 * Callers seed their in-memory dedupe Set from this on mount / account change instead of
 * starting empty, so a reload does not look like a brand-new "never seen this before" state.
 */
export function loadNotifiedDeposits(accountId: string): Set<string> {
  if (!accountId) return new Set();
  const store = prune(readStore(), Date.now());
  return new Set(Object.keys(store[accountId] ?? {}));
}

/** Marks one tx-hash+chain pair notified for this account so a later reload does not re-toast it. */
export function markDepositNotified(accountId: string, key: string): void {
  markDepositsNotified(accountId, [key]);
}

/**
 * Marks several pairs notified at once, refreshing the time of any already there. The poller
 * passes every COMPLETED deposit the bridge still lists, so retention only drops entries the
 * bridge stopped listing — a deposit still listed past RETENTION_MS would otherwise come back
 * as a fresh toast (D-475).
 */
export function markDepositsNotified(accountId: string, keys: string[]): void {
  if (!accountId || keys.length === 0) return;
  const now = Date.now();
  const store = prune(readStore(), now);
  const entries = { ...store[accountId] };
  for (const key of keys) entries[key] = now;
  store[accountId] = entries;
  writeStore(store);
}

// D-475: the notified set above starts empty for an account this browser has never seen (a new
// browser, or a new domain — localStorage is per origin), so every deposit the bridge still lists
// as COMPLETED looked new and got toasted, however old. Seen at the public opening (s264): an
// account's first visit to intentfolio.app announced a deposit made days earlier on staging.
//
// The fix is a baseline: the first successful read for such an account records what was already
// COMPLETED without announcing it, and only what completes after that is news. The baseline is a
// persisted per-account marker, not just "the notified set is empty", because an account can have
// a deposit still PENDING at the first read — if a reload landed before it completed, an empty set
// would be taken as "never seen" again and that real arrival would be swallowed into a new baseline.

const BASELINE_KEY = "bridge.deposit-baseline.v1";

// accountId -> when the baseline was taken. Not pruned: one small entry per account ever seen.
type BaselineStore = Record<string, number>;

function readBaselines(): BaselineStore {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(BASELINE_KEY);
    if (raw) return JSON.parse(raw) as BaselineStore;
  } catch {
    /* corrupt storage — the caller then takes a fresh baseline, which only costs a toast */
  }
  return {};
}

/**
 * Whether this browser already has a starting point for this account's deposits. An account with
 * notified entries from before the marker existed counts as having one, so the upgrade does not
 * silently re-baseline it.
 */
export function hasDepositBaseline(accountId: string): boolean {
  if (!accountId) return false;
  return accountId in readBaselines() || loadNotifiedDeposits(accountId).size > 0;
}

/** Records that this account's deposits from here on are news. */
export function markDepositBaseline(accountId: string): void {
  if (!accountId || typeof window === "undefined") return;
  const store = readBaselines();
  store[accountId] = Date.now();
  try {
    window.localStorage.setItem(BASELINE_KEY, JSON.stringify(store));
  } catch {
    /* storage full/unavailable — the hook keeps the baseline in memory for this session */
  }
}
