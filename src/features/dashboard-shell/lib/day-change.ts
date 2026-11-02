import type { TokenPriceMap } from "@/features/market/types";
import type { CurrentPortfolioQty } from "@/features/portfolio-editor/types";
import type { DayPrices } from "@/features/vault/hooks/use-day-prices";
import type { ShowcaseDayChange } from "@/features/portfolio-showcase/types";

export type DayChangeInput = {
  deposits: CurrentPortfolioQty;
  /** Live prices; null when they failed to load. */
  prices: TokenPriceMap | null;
  dayPrices: DayPrices | null;
  /** When the portfolio was created (ms); 0 when unknown. */
  createdAt: number;
  now: number;
};

/**
 * How much the prices of what the portfolio holds moved today (D-523): today's quantities at
 * today's live price against the same quantities at the price recorded at the start of the UTC
 * day. Holding the quantities still is what keeps deposits and withdrawals out of it.
 *
 * Null — the caller hides the change, never shows a 0 % it did not measure — when the reference
 * is not today's, a held token has no live price or no reference, or the portfolio did not exist
 * yet when the reference was taken.
 */
export function dayChange({ deposits, prices, dayPrices, createdAt, now }: DayChangeInput): ShowcaseDayChange | null {
  if (!prices || !dayPrices || dayPrices.day !== new Date(now).toISOString().slice(0, 10)) return null;
  let current = 0;
  let reference = 0;
  let since = 0;
  for (const [tokenId, qty] of Object.entries(deposits)) {
    if (!(qty > 0)) continue;
    const live = prices[tokenId];
    const ref = dayPrices.prices[tokenId];
    if (!live || live.source === "fallback" || !(live.usdPrice > 0) || !ref) return null;
    current += qty * live.usdPrice;
    reference += qty * ref.usd;
    // A token first priced later in the day moves from then: the change runs from the latest.
    since = Math.max(since, ref.at);
  }
  if (!(reference > 0) || createdAt > since) return null;
  const usd = current - reference;
  return { usd, pct: (usd / reference) * 100, since };
}
