"use client";

import { useMemo } from "react";
import { getTokenById } from "@/features/market/lib/token-registry";
import { useTokenPrices } from "@/features/market/hooks/use-token-prices";
import type { TokenId } from "@/features/intents-account/mock-contract/types";
import { fundableTokenIds, fundableUsd } from "../lib/general-balance";
import { useAvailableGeneralBalance } from "./use-available-general-balance";
import { useGeneralBalanceRead } from "./use-general-balance-read";

export type FundableGeneralBalance =
  | { status: "loading" }
  // The first read failed and nothing is cached (`useGeneralBalanceRead`, D-541): no path can
  // be picked without guessing.
  | { status: "error"; retry: () => void }
  // `usd`: what those tokens are worth — the amount a draft's confirmation names (D-413).
  | { status: "known"; fundable: boolean; tokenIds: TokenId[]; usd: number };

/**
 * Whether the General Balance can fund a new portfolio right now (any token worth at least
 * MIN_FUNDED_USD) — the one fact that picks the creation path (016 block 2, D-397): with funds,
 * create and sign; without, save a New Portfolio Draft; with a draft and funds, confirm it.
 * It is read from the balance, not from a deposit event, so every way in (QR, the NEAR
 * wallet tab, My Account's standalone Deposit button) resolves the same way.
 *
 * "loading" while the FIRST on-chain read is in flight, and the callers wait: a false
 * "no funds" sends someone who already deposited to the draft editor, a false "funds" back
 * to today's dead end. `isLoading` and not `isPending`, for the reason given in
 * portfolio-context: a disabled query (no session) is `isPending` forever. After that first
 * read, a failed or refetching query keeps the balance My Account shows. "error" when that first
 * read failed (D-541): the callers keep waiting rather than guess from the empty fallback.
 *
 * Prices: the live quote, else the registry's `fallbackUsdPrice`. Also "loading" until the price
 * hook has its first answer: before it, every price is that fallback, which can be several times
 * off — 0.3 NEAR read as $0.47 on a fresh mount and sent a funded draft to the editor (s186).
 * If the price route fails, the answer is the fallback, flagged as such (`pricesUnavailable`).
 */
export function useFundableGeneralBalance(): FundableGeneralBalance {
  const read = useGeneralBalanceRead();
  const available = useAvailableGeneralBalance();
  const { prices, isLoading: pricesLoading } = useTokenPrices();

  return useMemo<FundableGeneralBalance>(() => {
    if (read.status === "error") return read;
    if (read.status === "loading" || pricesLoading) return { status: "loading" };
    const priceOf = (id: TokenId) => prices[id]?.usdPrice ?? getTokenById(id)?.fallbackUsdPrice ?? 0;
    const tokenIds = fundableTokenIds(available, priceOf);
    return { status: "known", fundable: tokenIds.length > 0, tokenIds, usd: fundableUsd(available, priceOf) };
  }, [read, pricesLoading, available, prices]);
}
