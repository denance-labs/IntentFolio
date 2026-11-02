"use client";

// Draft persistence (5.4-B1). The in-flight portfolio edit normally lives only in the
// PortfolioProvider's memory (5.4-A), which already survives route navigation. This
// side-table is the next level down: it lets the draft survive a full reload.
//
// One entry per intents account. At any moment there is at most one draft per account
// (switching portfolios leaves the previous draft dormant but does not create a second
// one), and the draft carries the portfolio id it belongs to in `DraftState.id`, so the
// rehydration step can reject a draft whose portfolio no longer exists instead of
// resurrecting it against the wrong portfolio.
//
// Key namespace note: the provider runs a one-time cleanup that removes "portfolio.state"
// and every "portfolio.portfolios.*" key. This store deliberately uses a different
// namespace ("portfolio.draft.v1"), the same way portfolio-ui-prefs uses
// "portfolio.ui-prefs.v1", so it is never caught by that sweep.

import type { DraftState } from "../context/portfolio-context";

const KEY = "portfolio.draft.v1";

type DraftStore = Record<string, DraftState>; // intentsAccountId -> draft

function readStore(): DraftStore {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as DraftStore;
  } catch {
    /* corrupt storage — start fresh */
  }
  return {};
}

function writeStore(store: DraftStore): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* ignore quota / serialization errors */
  }
}

export function readDraft(accountId: string): DraftState | null {
  return readStore()[accountId] ?? null;
}

export function writeDraft(accountId: string, draft: DraftState): void {
  const store = readStore();
  store[accountId] = draft;
  writeStore(store);
}

export function clearDraft(accountId: string): void {
  const store = readStore();
  if (!(accountId in store)) return;
  delete store[accountId];
  writeStore(store);
}
