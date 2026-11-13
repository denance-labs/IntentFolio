// The "your deposit arrived" notice for tokens the Omni Bridge credits directly (D-580).
//
// WHY A SECOND SOURCE. Every other deposit is announced off the PoA bridge's `recent_deposits`
// (use-recent-deposits.ts). A ZEC deposit to the Receive address is credited by Omni's Zcash
// connector instead, and PoA never lists it — measured 2026-11-13 with real money: 0.009 ZEC
// minted to `pablofork.near` at 03:49 UTC, `recent_deposits` still empty for `zec:mainnet`
// twelve minutes later. So no notice fired and the General Balance only showed it on a reload.
//
// The account's history (`/api/history/account`, plan 028) does see it: it reads `intents.near`'s
// `mt_mint` with memo `deposit` from the chain, whoever credited it, and catches the account up
// on every read. That is the source here.
//
// WHY ONLY WHILE ONE IS EXPECTED. Polling the history route for every open dashboard, forever,
// would be a permanent read per user for an event that happens rarely. Receive marks the account
// when it shows an Omni-credited deposit address, and the watch runs for `WATCH_MS` after that.

import { withdrawalRegistry } from "./withdrawal-registry";

/** Tokens whose deposits the Omni Bridge credits without PoA listing them: the `omni` route. */
export const OMNI_CREDITED_DEPOSIT_TOKEN_IDS: ReadonlySet<string> = new Set(
  Object.entries(withdrawalRegistry)
    .filter(([, entry]) => entry.bridgeRoute === "omni")
    .map(([tokenId]) => tokenId)
);

/** The chains of those tokens: what Receive checks before marking a deposit as expected. */
export const OMNI_CREDITED_DEPOSIT_CHAIN_IDS: ReadonlySet<string> = new Set(
  [...OMNI_CREDITED_DEPOSIT_TOKEN_IDS].map((id) => withdrawalRegistry[id].chainId)
);

/** How long after Receive showed the address the watch keeps looking. Zcash needs 5 blocks (~6 min). */
export const WATCH_MS = 60 * 60 * 1000;

/**
 * Slack before the mark: a deposit credited a little before Receive was opened again (a second
 * visit while the first send was in flight) still counts. Older ones were either announced or
 * belong to a visit whose own window already closed.
 */
export const SINCE_SLACK_MS = 10 * 60 * 1000;

const KEY = "bridge.omni-deposit-expected.v1";

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

/** Receive showed an Omni-credited deposit address to this account: start (or extend) the watch. */
export function expectOmniDeposit(accountId: string, now = Date.now()): void {
  if (typeof window === "undefined" || !accountId) return;
  const store = readStore();
  for (const [id, at] of Object.entries(store)) if (now - at > WATCH_MS) delete store[id];
  store[accountId] = now;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* storage unavailable — the notice falls back to today's behaviour (balance on reload) */
  }
}

/** When the current watch started for this account, or null when there is none. */
export function omniDepositExpectedSince(accountId: string, now = Date.now()): number | null {
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

export type OmniCreditedDeposit = {
  /** `${txHash}:${chain}` — the same key shape the PoA poller writes to the notified store. */
  key: string;
  tokenId: string;
  chainId: string;
  amountRaw: string;
  txHash: string;
};

/**
 * The Omni-credited deposits in `events` that are new: in the watched set, credited no earlier
 * than `sinceMs − SINCE_SLACK_MS`, and not already announced (`notified`).
 */
export function pickNewOmniDeposits(
  events: readonly HistoryEventLike[],
  sinceMs: number,
  notified: ReadonlySet<string>
): OmniCreditedDeposit[] {
  const out: OmniCreditedDeposit[] = [];
  for (const e of events) {
    if (e.event !== "intents:deposit") continue;
    const tokenId = e.data?.token;
    const amountRaw = e.data?.amount;
    if (typeof tokenId !== "string" || !OMNI_CREDITED_DEPOSIT_TOKEN_IDS.has(tokenId)) continue;
    if (typeof amountRaw !== "string" || !/^\d+$/.test(amountRaw)) continue;
    if (typeof e.txHash !== "string" || typeof e.ts !== "number") continue;
    if (e.ts < sinceMs - SINCE_SLACK_MS) continue;
    const chainId = withdrawalRegistry[tokenId].chainId;
    const key = `${e.txHash}:${chainId}`;
    if (notified.has(key)) continue;
    out.push({ key, tokenId, chainId, amountRaw, txHash: e.txHash });
  }
  return out;
}
