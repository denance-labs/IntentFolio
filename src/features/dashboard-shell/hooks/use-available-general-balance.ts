"use client";

import { useMemo, useSyncExternalStore } from "react";
import { useLoginWallet } from "@/features/login-wallet";
import { mockContract } from "@/features/intents-account/mock-contract";
import type { TokenId } from "@/features/intents-account/mock-contract/types";
import { useIntentsBalances } from "@/features/wallet";
import { computeAvailableGeneralBalance } from "../lib/general-balance";

/**
 * Available General Balance per token (real on-chain total − committed portfolio
 * allocations, mock generalBalance as fallback while the on-chain query loads). The
 * single source for both My Account's display and the editor's allocate flow.
 *
 * Re-derives on every mock mutation (a commit moves funds in/out of portfolios) and
 * whenever the on-chain balances refetch. Memoized so the returned Map keeps a stable
 * identity between unrelated re-renders.
 */
export function useAvailableGeneralBalance(): Map<TokenId, number> {
  const { intentsAccountId } = useLoginWallet();
  const { data: intentsBalances } = useIntentsBalances(intentsAccountId);
  const version = useSyncExternalStore(mockContract.subscribe, mockContract.getVersion, () => 0);

  return useMemo(() => {
    void version; // re-read the (non-reactive) mock state whenever it mutates
    const allocatedByToken = new Map<TokenId, number>();
    const portfolios = mockContract.getIntentsAccount(intentsAccountId)?.portfolios ?? [];
    for (const p of portfolios) {
      // A real portfolio's funds ALREADY left the on-chain General Balance, so
      // `intentsBalances` reflects the debit. Subtracting its allocations here too would
      // double-count them (007.plan Phase 1 — see PortfolioRecord.isReal).
      //
      // D-R7 asked whether this guard falls away once real portfolios stop being mirrored
      // (008.plan Phase 1). It does NOT, and the reason is worth stating: no NEW `isReal`
      // record can be written here any more, but records the retired `mirrorRealPortfolio`
      // already wrote still sit in a returning user's localStorage. Dropping the guard
      // would subtract those stale allocations from a General Balance that never held
      // them — understating what the user can allocate, silently. It costs one line.
      if (p.isReal) continue;
      for (const [tokenId, qty] of mockContract.getPortfolioBalance(intentsAccountId, p.id)) {
        allocatedByToken.set(tokenId, (allocatedByToken.get(tokenId) ?? 0) + qty);
      }
    }
    return computeAvailableGeneralBalance(
      intentsBalances,
      allocatedByToken,
      mockContract.getGeneralBalance(intentsAccountId)
    );
  }, [intentsAccountId, version, intentsBalances]);
}
