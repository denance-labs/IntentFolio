// Mock rebalance event generator and seeder (7.1).
//
// Two exports:
//   generateRebalanceEvents — pure function, fully testable without side effects.
//   seedAccountRebalances   — orchestrator; calls mockContract + eventSnapshotStore.
//
// The seeder is idempotent: if any external_rebalance already exists for the account
// it exits immediately. Called once on mount from MockRebalanceSeedEffect.

import type {
  ContractEvent,
  TokenId,
  IntentsAccountId,
  PortfolioId,
} from "@/features/intents-account/mock-contract/types";
import { mockContract } from "@/features/intents-account/mock-contract";
import { tokenRegistry, symbolForTokenId } from "@/features/market/lib/token-registry";
import type { TokenPriceMap } from "@/features/market/types";
import {
  eventSnapshotStore,
  type CompositionPct,
  type EventCompositionSnapshot,
} from "./event-presentation-store";

// Simple LCG for a seeded, deterministic pseudo-random stream. Returns values in [0, 1).
function makeLcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

// Produces a UUID-shaped string from four LCG values. Deterministic when the
// generator is seeded, so event_ids are reproducible in tests.
function lcgUuid(rng: () => number): string {
  const hex = (n: number, len: number) =>
    Math.floor(n * 0x100000000)
      .toString(16)
      .padStart(8, "0")
      .slice(0, len);
  // xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx (version 4 shape, non-compliant but UUID-like)
  const a = hex(rng(), 8);
  const b = hex(rng(), 4);
  const c = "4" + hex(rng(), 3);
  const d = (8 + Math.floor(rng() * 4)).toString(16) + hex(rng(), 3);
  const e = hex(rng(), 8) + hex(rng(), 4);
  return `${a}-${b}-${c}-${d}-${e}`;
}

// Renormalize an array of CompositionPct so percentages sum to exactly 100.
function renormalize(pcts: CompositionPct[]): CompositionPct[] {
  const sum = pcts.reduce((acc, p) => acc + p.pct, 0);
  if (sum === 0) return pcts;
  return pcts.map((p) => ({ ...p, pct: (p.pct / sum) * 100 }));
}

export type GenerateRebalanceEventsParams = {
  accountId: IntentsAccountId;
  portfolioId: PortfolioId;
  composition: Array<{ tokenId: TokenId; targetPct: number; tolerancePct: number }>;
  totalValueUsd: number;
  fallbackPrices: TokenPriceMap;
  count?: number;     // default 60
  windowMs?: number;  // default 30 * 24 * 60 * 60 * 1000
  now?: number;       // injectable for tests; default Date.now()
  seed?: number;      // for deterministic RNG in tests
};

export function generateRebalanceEvents(params: GenerateRebalanceEventsParams): {
  events: ContractEvent[];
  snapshots: Map<string, EventCompositionSnapshot>;
} {
  const {
    accountId,
    portfolioId,
    composition,
    totalValueUsd,
    fallbackPrices,
    count = 60,
    windowMs = 30 * 24 * 60 * 60 * 1000,
    now = Date.now(),
    seed,
  } = params;

  if (composition.length < 2) {
    return { events: [], snapshots: new Map() };
  }

  const rng = makeLcg(seed ?? now);

  const events: ContractEvent[] = [];
  const snapshots = new Map<string, EventCompositionSnapshot>();

  for (let i = 0; i < count; i++) {
    // Timestamps spread over the window; older events have larger i.
    const ts = now - windowMs * (i / count) - rng() * (windowMs / count / 2);

    const isForced = rng() < 0.12;

    // Pick two distinct token indices.
    const tokenInIdx = Math.floor(rng() * composition.length);
    const tokenOutIdx =
      (tokenInIdx + 1 + Math.floor(rng() * (composition.length - 1))) %
      composition.length;

    const tokenIn = composition[tokenInIdx];
    const tokenOut = composition[tokenOutIdx];

    // Drift magnitude: 3–13% of target.
    const drift = 0.03 + rng() * 0.10;

    // Build "before" composition: start from target, apply drift.
    const before: CompositionPct[] = composition.map((c) => ({
      symbol: symbolForTokenId(c.tokenId),
      pct: c.targetPct,
    }));
    before[tokenInIdx].pct = Math.max(1, before[tokenInIdx].pct - drift * 100);
    before[tokenOutIdx].pct += (drift * 100) / 2;
    const beforeNorm = renormalize(before);

    // Build "after" composition: near-target with small random noise.
    const after: CompositionPct[] = composition.map((c) => ({
      symbol: symbolForTokenId(c.tokenId),
      pct: c.targetPct + (rng() - 0.5) * 2,
    }));
    const afterNorm = renormalize(after);

    // Swap sizing.
    const swapFraction = drift * 0.5 + rng() * 0.05;
    const swapUsd = totalValueUsd * swapFraction;
    const priceIn = fallbackPrices[tokenIn.tokenId]?.usdPrice ?? 1;
    const priceOut = fallbackPrices[tokenOut.tokenId]?.usdPrice ?? 1;
    const qtyIn = swapUsd / priceIn;
    const qtyOut = swapUsd / priceOut;

    // Spread attribution (only for external_rebalance).
    const spreadPct = 0.0012 + rng() * 0.0006;
    const attributedSpread = swapUsd * spreadPct;

    const event_id = lcgUuid(rng);

    const event: ContractEvent = isForced
      ? {
          kind: "forced_internal_rebalance",
          event_id,
          account_id: accountId,
          portfolio_id: portfolioId,
          token_in: tokenIn.tokenId,
          qty_in: qtyIn,
          token_out: tokenOut.tokenId,
          qty_out: qtyOut,
          ts,
        }
      : {
          kind: "external_rebalance",
          event_id,
          account_id: accountId,
          portfolio_id: portfolioId,
          token_in: tokenIn.tokenId,
          qty_in: qtyIn,
          token_out: tokenOut.tokenId,
          qty_out: qtyOut,
          attributed_spread: attributedSpread,
          ts,
        };

    events.push(event);
    snapshots.set(event_id, { before: beforeNorm, after: afterNorm });
  }

  return { events, snapshots };
}

// Orchestrator. Idempotent: exits if any external_rebalance already exists for this
// account. Iterates over all portfolios with at least 2 tokens, generates events, and
// writes snapshots before seeding into the mock contract.
export function seedAccountRebalances(accountId: IntentsAccountId): void {
  // Idempotent guard.
  if (
    mockContract
      .getEvents(accountId)
      .some((e) => e.kind === "external_rebalance")
  ) {
    return;
  }

  const account = mockContract.getIntentsAccount(accountId);
  if (!account) return;

  // Build a price map from registry fallback prices.
  const fallbackPrices: TokenPriceMap = Object.fromEntries(
    tokenRegistry.map((t) => [
      t.id,
      {
        symbol: t.symbol,
        usdPrice: t.fallbackUsdPrice,
        updatedAt: new Date().toISOString(),
        source: "fallback",
      },
    ])
  );

  const allEvents: ContractEvent[] = [];

  for (const portfolio of account.portfolios) {
    if (portfolio.composition.length < 2) continue;

    // Compute portfolio total value from live balances.
    const balances = mockContract.getPortfolioBalance(accountId, portfolio.id);
    let totalValueUsd = 0;
    for (const [tokenId, qty] of balances) {
      totalValueUsd += qty * (fallbackPrices[tokenId]?.usdPrice ?? 0);
    }
    if (totalValueUsd < 1) continue;

    const { events, snapshots } = generateRebalanceEvents({
      accountId,
      portfolioId: portfolio.id,
      composition: portfolio.composition,
      totalValueUsd,
      fallbackPrices,
    });

    for (const [key, snap] of snapshots) {
      eventSnapshotStore.put(key, snap);
    }
    allEvents.push(...events);
  }

  if (allEvents.length) {
    mockContract.seedEvents(accountId, allEvents);
  }
}
