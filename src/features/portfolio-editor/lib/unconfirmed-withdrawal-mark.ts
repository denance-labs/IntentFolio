// D-369: a withdrawal that ended "unconfirmed" leaves a mark on its portfolio after the
// modal closes, so the editor can keep saying "this may still go through" while a stale read
// would otherwise invite signing the same withdrawal again.
//
// The mark lives exactly as long as that signature can still execute: the envelope's deadline
// (`ENVELOPE_TTL_SECS`, counted here from the moment the outcome was judged, which is after
// signing — so it outlives the real deadline, never the other way). Past it, the vault refuses
// the first envelope, and a second withdrawal can only be the one the user means.
//
// A warning, not a gate: a mark never blocks Save. Best-effort storage on purpose — a lost
// mark (private window, cleared site data) only loses the warning, never money.

import { ENVELOPE_TTL_SECS } from "@/features/vault/lib/unallocate-submit";

const KEY = "intentfolio:unconfirmed-withdrawals";

type MarkStore = Record<string, number>; // portfolio id -> expiry (ms since epoch)

const listeners = new Set<() => void>();

function readStore(): MarkStore {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as MarkStore;
  } catch {
    /* unreadable storage — no mark, no warning */
  }
  return {};
}

function writeStore(store: MarkStore): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* unwritable storage — the warning is lost, nothing else */
  }
}

export function markUnconfirmedWithdrawal(portfolioId: string, now: number = Date.now()): void {
  if (typeof window === "undefined") return;
  const store = readStore();
  for (const [id, expiresAt] of Object.entries(store)) if (expiresAt <= now) delete store[id];
  store[portfolioId] = now + ENVELOPE_TTL_SECS * 1000;
  writeStore(store);
  listeners.forEach((l) => l());
}

/** The mark's expiry for this portfolio, or null when there is none still in force. */
export function unconfirmedWithdrawalUntil(portfolioId: string, now: number = Date.now()): number | null {
  const expiresAt = readStore()[portfolioId];
  return typeof expiresAt === "number" && expiresAt > now ? expiresAt : null;
}

export function subscribeUnconfirmedWithdrawals(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
