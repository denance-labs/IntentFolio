// 029 B-23 — the "you have funds to assign" window, offered once per draft or $0 portfolio.
//
// What "once" means is kept here: when the user last answered it (either button, Escape or a
// click outside), per account and per subject (the draft, or a portfolio id). It comes back
// only after a NEW deposit to the funding account — a chain deposit (`mt_mint`, read from the
// history route), never funds moved out of a portfolio, which reach the account as a vault
// transfer. A per-browser convenience, not state anything depends on: storage that fails or
// is cleared only offers it once more.

import { ACCOUNT_DEPOSIT_EVENT, type ChainHistoryEvent } from "@/features/vault/lib/vault-history";

const KEY = "portfolio.assign-funds-prompt.v1";

/** The draft's subject. Not a portfolio id: those never start with "*". */
export const DRAFT_SUBJECT = "*draft";

// intentsAccountId -> subject -> when it was last answered (ms)
type Store = Record<string, Record<string, number>>;

function read(): Store {
  if (typeof window === "undefined") return {};
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? "{}");
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Store) : {};
  } catch {
    return {}; // corrupt or blocked storage
  }
}

function write(store: Store): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* ignore quota / blocked storage */
  }
}

export function getAssignFundsPromptSeenAt(accountId: string, subject: string): number | null {
  const at = read()[accountId]?.[subject];
  return typeof at === "number" && Number.isFinite(at) ? at : null;
}

export function markAssignFundsPromptSeen(accountId: string, subject: string, at: number = Date.now()): void {
  if (!accountId) return;
  const store = read();
  store[accountId] = { ...(store[accountId] ?? {}), [subject]: at };
  write(store);
}

/** A discarded or signed draft takes its answer with it: the next draft is offered it again. */
export function forgetAssignFundsPrompt(accountId: string, subject: string): void {
  const store = read();
  if (store[accountId]?.[subject] === undefined) return;
  delete store[accountId][subject];
  write(store);
}

/** The newest deposit among `events`, or null with none. */
export function latestDepositTs(events: readonly ChainHistoryEvent[]): number | null {
  let latest: number | null = null;
  for (const e of events) {
    if (e.event === ACCOUNT_DEPOSIT_EVENT && (latest === null || e.ts > latest)) latest = e.ts;
  }
  return latest;
}

/**
 * Whether the window should be on offer. Never answered: as soon as the subject is eligible.
 * Answered: only once the history has settled and holds a deposit newer than the answer. A
 * history that failed, or that is off (mock portfolios), counts as no new deposit: when in
 * doubt it does not insist.
 */
export function shouldOfferAssignFunds(input: {
  eligible: boolean;
  seenAt: number | null;
  /** "pending" while the history is read (or re-read, being behind); null with no deposit, failed or off. */
  latestDeposit: number | null | "pending";
}): boolean {
  const { eligible, seenAt, latestDeposit } = input;
  if (!eligible) return false;
  if (seenAt === null) return true;
  return latestDeposit !== "pending" && latestDeposit !== null && latestDeposit > seenAt;
}
