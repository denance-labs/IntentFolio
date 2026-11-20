// The "your deposit arrived" notice for Receive, read off the account's history (D-580, D-584).
//
// WHY THE HISTORY. PoA's Bridge API, which listed bridge deposits (`recent_deposits`), closed on
// 2026-11-11, and Receive now gives 1Click's reusable deposit addresses: 1Click credits a deposit
// as a transfer from the set's internal account, which no bridge lists. The account's history
// (`/api/history/account`, plan 028) shows both kinds as `intents:deposit`: an `mt_mint` with memo
// `deposit` (a bridge, the Omni Bridge's ZEC of D-580), and the `transfer_in` from one of the
// account's own address sets (solver migration 015). It catches the account up on every read.
//
// WHY ONLY WHILE ONE IS EXPECTED. Polling the history route for every open dashboard, forever,
// would be a permanent read per user for an event that happens rarely. Receive marks the account
// when it shows a deposit address (or the wallet tab sends one), and the watch runs for
// `WATCH_MS` after that. A deposit that lands later shows in the balance and the history, without
// the notice.

import { toRegistryTokenId } from "@/features/market/lib/intents-token-id";
import { withdrawalRegistry } from "./withdrawal-registry";

/** How long after Receive showed the address the watch keeps looking. Zcash needs 5 blocks (~6 min). */
export const WATCH_MS = 60 * 60 * 1000;

/**
 * Slack before the mark: a deposit credited a little before Receive was opened again (a second
 * visit while the first send was in flight) still counts. Older ones were either announced or
 * belong to a visit whose own window already closed.
 */
export const SINCE_SLACK_MS = 10 * 60 * 1000;

const KEY = "bridge.deposit-expected.v1";

type Store = Record<string, number>;

function readStore(): Store {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    return {};
  }
}

/** Receive showed a deposit address to this account, or sent from its wallet: start (or extend) the watch. */
export function expectDeposit(accountId: string, now = Date.now()): void {
  if (typeof window === "undefined" || !accountId) return;
  const store = readStore();
  for (const [id, at] of Object.entries(store)) if (now - at > WATCH_MS) delete store[id];
  store[accountId] = now;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* storage unavailable — the deposit shows in the balance on reload, without the notice */
  }
}

/** When the current watch started for this account, or null when there is none. */
export function depositExpectedSince(accountId: string, now = Date.now()): number | null {
  if (!accountId) return null;
  const at = readStore()[accountId];
  return typeof at === "number" && now - at <= WATCH_MS ? at : null;
}

/** One history event as `/api/history/account` returns it, narrowed to what is read here. */
export type HistoryEventLike = {
  event?: unknown;
  txHash?: unknown;
  ts?: unknown;
  data?: { token?: unknown; amount?: unknown } | null;
};

export type CreditedDeposit = {
  /** `${txHash}:${chain}` — the key shape of the notified store (the wallet tab writes it too). */
  key: string;
  /** The registry's id: the history's `nep141:wrap.near` is `near` here (D-421). */
  tokenId: string;
  /** The token's network in the registry; `near:mainnet` for one it does not list. */
  chainId: string;
  amountRaw: string;
  /** The NEAR transaction that credited it. */
  txHash: string;
  ts: number;
};

/** Every deposit in `events` that can be read whole, in their order. */
export function creditedDeposits(events: readonly HistoryEventLike[]): CreditedDeposit[] {
  const out: CreditedDeposit[] = [];
  for (const e of events) {
    if (e.event !== "intents:deposit") continue;
    const token = e.data?.token;
    const amountRaw = e.data?.amount;
    if (typeof token !== "string" || !token) continue;
    const tokenId = toRegistryTokenId(token);
    if (typeof amountRaw !== "string" || !/^\d+$/.test(amountRaw)) continue;
    if (typeof e.txHash !== "string" || typeof e.ts !== "number") continue;
    const chainId = withdrawalRegistry[tokenId]?.chainId ?? "near:mainnet";
    out.push({ key: `${e.txHash}:${chainId}`, tokenId, chainId, amountRaw, txHash: e.txHash, ts: e.ts });
  }
  return out;
}

/**
 * The deposits in `events` that are new: credited no earlier than `sinceMs − SINCE_SLACK_MS`, and
 * not already announced (`notified`).
 */
export function pickNewDeposits(
  events: readonly HistoryEventLike[],
  sinceMs: number,
  notified: ReadonlySet<string>
): CreditedDeposit[] {
  return creditedDeposits(events).filter((d) => d.ts >= sinceMs - SINCE_SLACK_MS && !notified.has(d.key));
}

/** The account's newest history page, or null when it could not be read. */
export async function fetchHistoryEvents(accountId: string, fetchImpl: typeof fetch = fetch): Promise<HistoryEventLike[] | null> {
  const res = await fetchImpl(`/api/history/account?account=${encodeURIComponent(accountId)}`, { cache: "no-store" });
  if (!res.ok) return null;
  const body = (await res.json()) as { events?: unknown };
  return Array.isArray(body.events) ? (body.events as HistoryEventLike[]) : null;
}
