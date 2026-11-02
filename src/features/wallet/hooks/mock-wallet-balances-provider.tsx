"use client";

import type { ReactNode } from "react";
import { WalletBalancesOverrideContext } from "./use-wallet-balances";
import type { WalletBalancesResult } from "./use-wallet-balances";

export function MockWalletBalancesProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: WalletBalancesResult;
}) {
  return (
    <WalletBalancesOverrideContext.Provider value={value}>
      {children}
    </WalletBalancesOverrideContext.Provider>
  );
}
