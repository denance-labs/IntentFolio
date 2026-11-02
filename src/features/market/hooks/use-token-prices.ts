"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { tokenRegistry } from "../lib/token-registry";
import type { TokenPriceMap } from "../types";

type TokenPriceState = {
  prices: TokenPriceMap;
  isLoading: boolean;
  error: string | null;
  lastUpdatedAt: string | null;
};

// True when nothing in the map came from a real quote — neither live nor from the server's
// one-hour cache (D-179). Every number on screen is then a hardcoded `fallbackUsdPrice`, so
// callers must say so instead of passing them off as real.
function noRealQuotes(prices: TokenPriceMap): boolean {
  const entries = Object.values(prices);
  return entries.length > 0 && entries.every((p) => p.source === "fallback");
}

const fallbackPrices: TokenPriceMap = Object.fromEntries(
  tokenRegistry.map((token) => [
    token.id,
    {
      symbol: token.symbol,
      usdPrice: token.fallbackUsdPrice,
      updatedAt: new Date(0).toISOString(),
      source: "fallback"
    }
  ])
);

const INITIAL_STATE: TokenPriceState = {
  prices: fallbackPrices,
  isLoading: true,
  error: null,
  lastUpdatedAt: null
};

// A new instance mounting within this long of the last request reuses its answer instead of
// asking again.
export const PRICE_FRESH_MS = 30_000;
// A request that hangs past this is given up, so it cannot block every later refresh.
const REQUEST_TIMEOUT_MS = 15_000;
// Interval timers drift; a tick this early still counts as due.
const TICK_SLACK_MS = 1_000;

// One store shared by every caller (D-411). Each instance used to fetch on mount and again on
// its own interval; with ~10 callers on a dashboard that burst tripped Vercel's DDoS rule
// (a Challenge, which a `fetch` cannot solve) against a real user. Now there is at most one
// request in flight and one interval — at the shortest cadence any mounted caller asked for —
// that skips while the tab is hidden.
//
// Sharing also covers s186 (016 block 2.4): a component mounted after another already loaded
// starts from that answer instead of the registry's hardcoded fallbacks, which can be several
// times off (NEAR at $1.58 while it trades near $5) — 0.3 NEAR read as $0.47 once made "can the
// General Balance fund a portfolio?" say no to someone holding $1.47.
let state: TokenPriceState = INITIAL_STATE;
let lastRequestAt: number | null = null;
let inFlight = false;
// Bumped by the test reset so a request started before it cannot write after it.
let generation = 0;
const listeners = new Set<() => void>();
const cadences = new Map<symbol, number>();
let timer: number | null = null;
let timerMs: number | null = null;

function emit() {
  for (const listener of listeners) listener();
}

function shortestCadence(): number | null {
  return cadences.size === 0 ? null : Math.min(...cadences.values());
}

async function loadPrices() {
  inFlight = true;
  lastRequestAt = Date.now();
  const startedIn = generation;
  const controller = new AbortController();
  let timeout: number | undefined;
  try {
    const response = await Promise.race([
      fetch("/api/market/prices", { cache: "no-store", signal: controller.signal }),
      new Promise<never>((_, reject) => {
        timeout = window.setTimeout(() => {
          controller.abort();
          reject(new Error("Price API timed out"));
        }, REQUEST_TIMEOUT_MS);
      })
    ]);
    if (!response.ok) throw new Error(`Price API returned ${response.status}`);
    const payload = (await response.json()) as { prices: TokenPriceMap; updatedAt: string };
    if (startedIn !== generation) return;
    state = {
      prices: payload.prices,
      isLoading: false,
      error: null,
      lastUpdatedAt: payload.updatedAt
    };
  } catch (error) {
    if (startedIn !== generation) return;
    // Keeps the last prices (real or fallback); the error is what callers branch on.
    state = {
      ...state,
      isLoading: false,
      error: error instanceof Error ? error.message : "Unable to load token prices"
    };
  } finally {
    window.clearTimeout(timeout);
    if (startedIn === generation) {
      inFlight = false;
      emit();
    }
  }
}

function refreshIfOlderThan(ms: number) {
  if (inFlight) return;
  if (lastRequestAt !== null && Date.now() - lastRequestAt < ms) return;
  void loadPrices();
}

function tick() {
  const cadence = shortestCadence();
  if (cadence === null || document.visibilityState === "hidden") return;
  refreshIfOlderThan(cadence - TICK_SLACK_MS);
}

function onVisibilityChange() {
  const cadence = shortestCadence();
  if (cadence !== null && document.visibilityState === "visible") refreshIfOlderThan(cadence);
}

// Keeps one interval at the shortest cadence any mounted caller asked for, and none (nor the
// visibility listener) when nobody is mounted.
function reschedule() {
  const cadence = shortestCadence();
  if (cadence === timerMs) return;
  if (timer !== null) window.clearInterval(timer);
  timer = null;
  timerMs = cadence;
  if (cadence === null) {
    document.removeEventListener("visibilitychange", onVisibilityChange);
    return;
  }
  timer = window.setInterval(tick, cadence);
  document.addEventListener("visibilitychange", onVisibilityChange);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => state;
const getServerSnapshot = () => INITIAL_STATE;

/** Forgets the shared answer and any request in flight. For tests, which must start from the first load. */
export function resetTokenPriceCache(): void {
  generation += 1;
  state = INITIAL_STATE;
  lastRequestAt = null;
  inFlight = false;
}

export function useTokenPrices(refreshMs = 60000) {
  const current = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    const id = Symbol("useTokenPrices");
    cadences.set(id, refreshMs);
    reschedule();
    refreshIfOlderThan(PRICE_FRESH_MS);
    return () => {
      cadences.delete(id);
      reschedule();
    };
  }, [refreshMs]);

  return useMemo(
    () => ({ ...current, pricesUnavailable: !current.isLoading && noRealQuotes(current.prices) }),
    [current]
  );
}
