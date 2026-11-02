// NAV history seeder for the mock demo (7.3 / D-149).
// Generates 60 daily NAV snapshots working backwards from today.
// Idempotent: skips portfolios that already have NAV data.

import type { IntentsAccountId } from "@/features/intents-account/mock-contract/types";
import { mockContract } from "@/features/intents-account/mock-contract";
import { tokenRegistry } from "@/features/market/lib/token-registry";
import type { TokenPriceMap } from "@/features/market/types";
import { seedNavSnapshots, getNavSeries, type NavPoint } from "./nav-snapshot-store";

// Simple LCG for deterministic noise (same approach as rebalance-seeder).
function makeLcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function dateStr(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

// Seeds 60 daily NAV snapshots whose most recent point equals the current value, so
// the chart shows steady growth that ends exactly where today's live value sits.
//
// Re-anchors instead of being write-once: currentValueUsd resolves in steps as prices
// settle, and takeSnapshot keeps moving "today" upward. If the synthetic history froze
// at the first resolved value, the right edge would jump in one step (the spike). So we
// regenerate whenever the latest stored point no longer matches startValueUsd, and skip
// the work once it already agrees (within 0.5%).
export function seedNavFromCurrentValue(portfolioId: string, startValueUsd: number): void {
  if (startValueUsd < 1) return;

  const anchored = getNavSeries(portfolioId, 3650).at(-1)?.navUsd;
  if (anchored !== undefined && Math.abs(anchored - startValueUsd) <= startValueUsd * 0.005) {
    return;
  }

  const seed = (portfolioId.charCodeAt(0) ?? 65) * 31 + (portfolioId.charCodeAt(1) ?? 97);
  const rng = makeLcg(seed);
  const now = Date.now();
  const points: NavPoint[] = [];

  // Two-zone backwards walk so the chart (left=old, right=today) shows:
  //   - Last 30 days (i=0..29): strong drift down going backwards → clear
  //     upward growth when viewed forward. bias=0.37, vol=0.013.
  //   - First 30 days (i=30..59): lighter drift, more sideways. bias=0.46, vol=0.013.
  // Reduced volatility (0.013) keeps daily noise below the drift signal.
  let nav = startValueUsd;
  for (let i = 0; i < 60; i++) {
    const date = dateStr(now - i * 86400000);
    points.push({ date, navUsd: Math.max(0, nav) });
    const bias = i < 30 ? 0.37 : 0.46;
    nav *= 1 - (rng() - bias) * 0.013;
  }

  seedNavSnapshots(portfolioId, points);
}

export function seedNavHistory(accountId: IntentsAccountId): void {
  const account = mockContract.getIntentsAccount(accountId);
  if (!account) return;

  const fallbackPrices: TokenPriceMap = Object.fromEntries(
    tokenRegistry.map((t) => [
      t.id,
      {
        symbol: t.symbol,
        usdPrice: t.fallbackUsdPrice,
        updatedAt: new Date().toISOString(),
        source: "fallback" as const,
      },
    ])
  );

  for (const portfolio of account.portfolios) {
    const balances = mockContract.getPortfolioBalance(accountId, portfolio.id);
    let currentNav = 0;
    for (const [tokenId, qty] of balances) {
      currentNav += qty * (fallbackPrices[tokenId]?.usdPrice ?? 0);
    }
    seedNavFromCurrentValue(portfolio.id, currentNav);
  }
}
