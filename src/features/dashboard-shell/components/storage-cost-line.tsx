"use client";

// The Setup's Storage Cost in the two screens that create a portfolio (D-528, 031.plan): the
// quote they both read, how its cost reads in the summary, and why a Setup cannot be confirmed
// when it cannot be priced. Shown only when creating; adding funds never charges it.

import { useMemo } from "react";
import { useTokenPrices } from "@/features/market/hooks/use-token-prices";
import { getTokenById } from "@/features/market/lib/token-registry";
import {
  livePriceOf,
  quoteStorageCost,
  type SetupStorageCost,
  type StorageQuote,
} from "@/features/vault/lib/storage-cost";
import { usePortfolio } from "../context/portfolio-context";
import type { ShellTranslations } from "../lib/translations";

/**
 * The Storage Cost of the Setup about to be signed, priced from exactly what it signs: the
 * trimmed name, the composition's token ids and the GROSS amounts the user chose. Null before
 * there is an account or anything funded.
 */
export function useSetupStorageQuote(input: {
  portfolioName: string;
  compositionTokenIds: readonly string[];
  grossAllocations: Readonly<Record<string, number>>;
}): StorageQuote | null {
  const { setupSigner } = usePortfolio();
  const { prices } = useTokenPrices();
  const { portfolioName, compositionTokenIds, grossAllocations } = input;
  return useMemo(() => {
    if (!setupSigner || !Object.values(grossAllocations).some((qty) => qty > 0)) return null;
    return quoteStorageCost({
      accountId: setupSigner.accountId,
      loginAddress: setupSigner.loginAddress,
      portfolioName,
      compositionTokenIds,
      grossAllocations,
      priceOf: (id) => livePriceOf(prices, id),
    });
  }, [setupSigner, portfolioName, compositionTokenIds, grossAllocations, prices]);
}

const symbolOf = (tokenId: string) => getTokenById(tokenId)?.symbol ?? tokenId;

/** Enough significant digits to read a cost of cents in any token (0.0343 USDC, 0.000000343 BTC). */
function formatCostQty(qty: number): string {
  return new Intl.NumberFormat("en-US", { maximumSignificantDigits: 4 }).format(qty);
}

/** The cost in the token it is charged in, as a phrase ("0.0343 USDC"). */
export function storageCostText(quote: SetupStorageCost): string {
  return `${formatCostQty(quote.qty)} ${symbolOf(quote.tokenId)}`;
}

/** Why the Setup cannot be confirmed for its Storage Cost, in the user's terms; null when it can. */
export function storageQuoteProblem(quote: StorageQuote | null, t: ShellTranslations): string | null {
  if (!quote || quote.ok) return null;
  switch (quote.reason) {
    case "no-funds":
      return null; // the amounts section already says there is nothing to fund
    case "prices-not-live":
      return t.storageCostPricesNotLive;
    case "exceeds-amount":
      return t.storageCostExceedsAmount
        .replace("{token}", symbolOf(quote.tokenId))
        .replace("{cost}", `${formatCostQty(quote.qty)} ${symbolOf(quote.tokenId)}`);
    case "implausible":
      return t.storageCostImplausible;
  }
}
