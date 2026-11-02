// Presentation layer (7.0) — the local stand-in for the E8 indexer.
//
// Holds the before/after allocation % of a portfolio, FROZEN at the moment an event
// was created, keyed by commit_id (Portfolio Commits) or event_id (standalone
// rebalances). This is intentionally NOT part of the lean ContractEvent log: the
// on-chain contract is price-blind, so it cannot produce a value-weighted % — that is
// an indexer/presentation concern. In MVP the snapshot is written at event-creation
// time (7.1 generator for seeded rebalances; the commit call-site in 7.2 for real
// user commits) and read back here by the history mapper. In E8 the indexer serves it.
//
// See ".claude/plans → 7.0 — Decisiones de shape lockeadas" (points 6 and 8).

import type { TokenId } from "@/features/intents-account/mock-contract/types";
import { symbolForTokenId } from "@/features/market/lib/token-registry";
import type { TokenPriceMap } from "@/features/market/types";

export type CompositionPct = { symbol: string; pct: number };
export type EventCompositionSnapshot = { before: CompositionPct[]; after: CompositionPct[] };

const STORAGE_KEY = "event-snapshots:v1";

class EventSnapshotStore {
  private map = new Map<string, EventCompositionSnapshot>();
  private loaded = false;

  private load(): void {
    if (this.loaded || typeof window === "undefined") return;
    this.loaded = true;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, EventCompositionSnapshot>;
      for (const [key, snap] of Object.entries(parsed)) this.map.set(key, snap);
    } catch {
      // corrupt storage — start fresh
    }
  }

  private persist(): void {
    if (typeof window === "undefined") return;
    const obj: Record<string, EventCompositionSnapshot> = {};
    for (const [key, snap] of this.map) obj[key] = snap;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  }

  // Freeze a snapshot keyed by commit_id (commits) or event_id (rebalances).
  put(key: string, snapshot: EventCompositionSnapshot): void {
    this.load();
    this.map.set(key, snapshot);
    this.persist();
  }

  get = (key: string): EventCompositionSnapshot | undefined => {
    this.load();
    return this.map.get(key);
  };

  _reset(): void {
    this.map.clear();
    this.loaded = true;
    if (typeof window !== "undefined") window.localStorage.removeItem(STORAGE_KEY);
  }
}

export const eventSnapshotStore = new EventSnapshotStore();

// Value-weighted allocation % per token. Pure. Needs prices because % is value-based
// (the price-blind contract cannot compute it). Callers freeze the result into
// eventSnapshotStore at event-creation time. Tokens with no price or zero total fall
// back to 0% rather than dividing by zero.
export function buildCompositionSnapshot(
  composition: Array<{ tokenId: TokenId; targetPct: number; tolerancePct: number }>,
  balances: Record<TokenId, number>,
  prices: TokenPriceMap
): CompositionPct[] {
  const rows = composition.map((c) => {
    const qty = balances[c.tokenId] ?? 0;
    const price = prices[c.tokenId]?.usdPrice ?? 0;
    return { symbol: symbolForTokenId(c.tokenId), value: qty * price };
  });
  const total = rows.reduce((sum, r) => sum + r.value, 0);
  return rows.map((r) => ({ symbol: r.symbol, pct: total > 0 ? (r.value / total) * 100 : 0 }));
}
