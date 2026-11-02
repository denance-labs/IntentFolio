"use client";

import { useEffect, useState } from "react";
import { useInfiniteQuery, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import type { ContractEvent } from "@/features/intents-account/mock-contract/types";
import type { AccountHistoryBody } from "@/features/history-recorder/lib/account-history-service";
import { VAULT_ROUNDTRIP_ENABLED } from "../lib/vault-flag";
import { toContractEvents, type ChainHistoryEvent } from "../lib/vault-history";

/** Shared so every real operation can invalidate it after it lands. */
export function realPortfolioHistoryQueryKey(intentsAccountId: string) {
  return ["real-portfolio-history", intentsAccountId] as const;
}

// ── The history route (028-7) ────────────────────────────────────────────────

export type AccountHistoryPage = Extract<AccountHistoryBody, { ok: true }>;

const ENDPOINT = "/api/history/account";

/** How long after an answer that is behind, or still loading, the view reads again. */
export const HISTORY_REREAD_MS = 15_000;
/** Re-reads per stretch of the same old data before the view says the latest may be missing. */
export const HISTORY_REREADS = 4;

/** Throws on anything but a successful answer: the view shows an error, never an empty history. */
export async function fetchAccountHistoryPage(
  params: { accountId: string; portfolioId?: string | null; before?: string | null },
  fetchImpl: typeof fetch = fetch
): Promise<AccountHistoryPage> {
  const query = new URLSearchParams({ account: params.accountId });
  if (params.portfolioId) query.set("portfolio", params.portfolioId);
  if (params.before) query.set("before", params.before);
  const response = await fetchImpl(`${ENDPOINT}?${query}`);
  const body = (await response.json().catch(() => null)) as AccountHistoryBody | null;
  if (!response.ok || body?.ok !== true) {
    throw new Error(`history answered ${response.status}${body && !body.ok ? ` (${body.code})` : ""}`);
  }
  return body;
}

// ── After the user's own operation (028-7 (d)) ───────────────────────────────

/** How often the route is asked after an operation, and for how long: 30 asks, the route's brake allows 60 a minute. */
export const ANNOUNCE_EVERY_MS = 2_000;
export const ANNOUNCE_FOR_MS = 60_000;

export type AnnounceDeps = {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * The user's own operation just landed: has the history database record it, then refreshes
 * the views. With the operation's NEAR hash, `expect=` until the database holds it, or says it
 * never will (not this account's, past the cap). Without one (a bridge deposit, a commit
 * confirmed by polling), `fresh=1` until the account is recorded up to the moment the
 * operation was seen — by this browser's clock, so a clock running behind can stop it early
 * and the views' own re-reads take over. Every `ANNOUNCE_EVERY_MS`, for at most
 * `ANNOUNCE_FOR_MS`; the views are invalidated either way. Never throws: the operation already
 * happened.
 */
export async function announceOperation(
  queryClient: QueryClient,
  accountId: string,
  txHash: string | null,
  deps: AnnounceDeps = {}
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const seenAt = now();
  const query = new URLSearchParams({ account: accountId });
  if (txHash) query.set("expect", txHash);
  else query.set("fresh", "1");

  const recorded = async (): Promise<boolean> => {
    try {
      const response = await fetchImpl(`${ENDPOINT}?${query}`);
      const body = (await response.json().catch(() => null)) as AccountHistoryBody | null;
      // A refused request, or a deployment without the database, will not change in a minute.
      if (!body?.ok) return body?.code === "bad-request" || body?.code === "not-configured";
      if (txHash) return body.expect !== "pending";
      return body.unavailable || (body.recordedUntil !== null && body.recordedUntil >= seenAt);
    } catch {
      return false; // the network: ask again
    }
  };
  if (VAULT_ROUNDTRIP_ENABLED && accountId) {
    while (!(await recorded()) && now() + ANNOUNCE_EVERY_MS - seenAt < ANNOUNCE_FOR_MS) await sleep(ANNOUNCE_EVERY_MS);
  }
  await queryClient.invalidateQueries({ queryKey: realPortfolioHistoryQueryKey(accountId) });
}

/**
 * The loaded pages' events, each transaction once. A transaction whose key moved between two
 * reads (its older events recorded later) can come back on the next page too: the first page
 * that brought it wins, or a mapper would count its amounts twice.
 */
export function joinPages(pages: AccountHistoryPage[]): ChainHistoryEvent[] {
  const seen = new Set<string>();
  const out: ChainHistoryEvent[] = [];
  for (const page of pages) {
    const here = new Set<string>();
    for (const e of page.events) {
      if (seen.has(e.txHash)) continue;
      here.add(e.txHash);
      out.push(e);
    }
    here.forEach((h) => seen.add(h));
  }
  return out;
}

/** The flags every page answers with; the first page is the newest read. */
function flagsOf(d: InfiniteData<AccountHistoryPage, string | null>) {
  return {
    /** The account's initial load has not finished: older rows may still be missing. */
    loading: d.pages[0]?.loading ?? false,
    upToDate: d.pages[0]?.upToDate ?? true,
    /** Past the cap of transactions per account (028 decision 8). */
    unavailable: d.pages[0]?.unavailable ?? false,
  };
}

export type RealPortfolioHistory = ReturnType<typeof flagsOf> & { events: ContractEvent[] };
export type AccountHistory = ReturnType<typeof flagsOf> & {
  events: ChainHistoryEvent[];
  /** Each portfolio on the loaded pages: its latest name on chain. */
  names: Record<string, string>;
};

// Module-level so `select` keeps its identity and React Query does not re-map on every render.
const toPortfolioHistory = (d: InfiniteData<AccountHistoryPage, string | null>): RealPortfolioHistory => ({
  ...flagsOf(d),
  events: toContractEvents(joinPages(d.pages)),
});
const toAccountHistory = (d: InfiniteData<AccountHistoryPage, string | null>): AccountHistory => ({
  ...flagsOf(d),
  events: joinPages(d.pages),
  names: Object.assign({}, ...d.pages.map((p) => p.names)),
});

/**
 * One read of the history route, a page of transactions at a time: "show more" asks for the
 * next page (`fetchNextPage`). Keyed under `realPortfolioHistoryQueryKey`, so the
 * invalidations after every real operation refresh it.
 *
 * An answer that is behind, or of an account still loading, started a pass on the server after
 * it went out, so the view reads again every `HISTORY_REREAD_MS`, up to `HISTORY_REREADS` times
 * per stretch — `usePortfolioStats`'s rule. Still behind after the last one, it is `outOfDate`.
 */
function useHistoryRoute<T extends { loading: boolean; upToDate: boolean }>(
  intentsAccountId: string | null,
  portfolioId: string | null,
  enabled: boolean,
  select: (d: InfiniteData<AccountHistoryPage, string | null>) => T
) {
  const account = intentsAccountId ?? "";
  const query = useInfiniteQuery({
    queryKey: [...realPortfolioHistoryQueryKey(account), portfolioId === null ? "account" : "portfolio", portfolioId ?? ""],
    queryFn: ({ pageParam }) => fetchAccountHistoryPage({ accountId: account, portfolioId, before: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
    select,
    enabled: VAULT_ROUNDTRIP_ENABLED && enabled && !!intentsAccountId,
    staleTime: 15 * 1000,
    retry: 1,
  });
  const { data, refetch } = query;

  const stretch = `${account}|${portfolioId ?? ""}`;
  const [rereads, setRereads] = useState<{ stretch: string; n: number }>({ stretch: "", n: 0 });
  const settled = !!data && data.upToDate && !data.loading;
  // An answer up to date ends the stretch (state adjusted while rendering, React's pattern for it).
  if (settled && rereads.n !== 0) setRereads({ stretch, n: 0 });
  const n = rereads.stretch === stretch ? rereads.n : 0;
  const behind = !!data && !settled;

  useEffect(() => {
    if (!behind || n >= HISTORY_REREADS) return;
    const timer = setTimeout(() => {
      void refetch().finally(() => setRereads({ stretch, n: n + 1 }));
    }, HISTORY_REREAD_MS);
    return () => clearTimeout(timer);
  }, [behind, stretch, n, refetch]);

  return {
    data,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
    hasNextPage: query.hasNextPage,
    fetchNextPage: query.fetchNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    outOfDate: !!data && !data.upToDate && n >= HISTORY_REREADS,
  };
}

/**
 * A real portfolio's History (028-7, D-492 stage 2): the account's events of this portfolio
 * from the history database, as the History mapper reads them. Off for mock portfolios
 * (`enabled`): Preview never calls the route.
 */
export function useRealPortfolioHistory(intentsAccountId: string | null, portfolioId: string | null, enabled: boolean) {
  return useHistoryRoute(intentsAccountId, portfolioId, enabled && !!portfolioId, toPortfolioHistory);
}

/**
 * My Account's recent activity (017-7, D-364; 028-7): every kept event of the account — its
 * portfolios and its General Balance — from the history database, with each portfolio's
 * latest name (a page may not hold its creation). Off with the vault round-trip off.
 */
export function useAccountHistory(intentsAccountId: string | null, enabled: boolean) {
  return useHistoryRoute(intentsAccountId, null, enabled, toAccountHistory);
}
