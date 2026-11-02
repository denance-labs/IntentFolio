import type { TokenId } from "@/features/intents-account/mock-contract/types";
import { NO_SELL_ROUTE_TOKEN_IDS } from "@/features/bridge/lib/token-availability";

/**
 * Available General Balance per token = total balance − funds already allocated to
 * portfolios. "Available" is what is free to allocate into a portfolio or to withdraw.
 *
 * Two sources, one formula (5.3.2): when the real on-chain intents balance is loaded,
 * total = on-chain and we subtract the mock's committed portfolio allocations. While it
 * is still loading, the mock's own generalBalance is already net of allocations (every
 * commit moves funds between it and the portfolios), so it is returned as-is.
 *
 * Shared by My Account (display) and the editor (allocate source + over-allocation
 * guard) so the two can never disagree on how much is free.
 */
export function computeAvailableGeneralBalance(
  intentsBalances: Map<TokenId, number> | null | undefined,
  allocatedByToken: Map<TokenId, number>,
  mockGeneralBalance: Map<TokenId, number>
): Map<TokenId, number> {
  if (!intentsBalances) return new Map(mockGeneralBalance);

  const available = new Map<TokenId, number>();
  for (const [tokenId, qty] of intentsBalances) {
    const free = Math.max(0, qty - (allocatedByToken.get(tokenId) ?? 0));
    if (free > 0) available.set(tokenId, free);
  }
  return available;
}

// A funded token line is worth at least one cent (027 A-2; it was $1 under D-007). The
// contract sets no minimum: this only keeps a remainder the screen shows as "$0.00" from
// counting as funds — a draft is not "ready" on 0.003 USDT left after a withdrawal. Compared
// in rounded cents, like the per-row checks (add-funds-modal `rowBelowMin`, preset-review
// `belowMin`), so what the screen shows as "$0.01" counts.
export const MIN_FUNDED_USD = 0.01;

/**
 * USD value of the lines `fundableTokenIds` returns — what confirming a New Portfolio Draft
 * can put in (D-413). Dust is left out, as it is from the offer.
 */
export function fundableUsd(available: Map<TokenId, number>, priceOf: (tokenId: TokenId) => number): number {
  let usd = 0;
  for (const tokenId of fundableTokenIds(available, priceOf)) usd += (available.get(tokenId) ?? 0) * priceOf(tokenId);
  return usd;
}

/**
 * The General Balance tokens that can fund a new portfolio: available quantity worth at
 * least MIN_FUNDED_USD at the given price, most valuable first. A token with no price
 * (0 or missing) never counts — its value is unknown, and offering it risks funding dust.
 * Neither does one with no sell route (D-491): inside the portfolio it could never be
 * converted into the targets.
 */
export function fundableTokenIds(
  available: Map<TokenId, number>,
  priceOf: (tokenId: TokenId) => number
): TokenId[] {
  const usd: Array<[TokenId, number]> = [];
  for (const [tokenId, qty] of available) {
    if (NO_SELL_ROUTE_TOKEN_IDS.has(tokenId)) continue;
    // A price or quantity of 0 values the line at $0, and NaN fails the comparison: neither counts.
    const value = qty * priceOf(tokenId);
    if (Math.round(value * 100) / 100 >= MIN_FUNDED_USD) usd.push([tokenId, value]);
  }
  return usd
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tokenId]) => tokenId);
}
