"use client";

import { createContext, useContext } from "react";

// D-529: lets a page inside the shell open the shell's Deposit modal (`ReceiveModal`), which the
// shell owns. Null outside the shell (tests, a page rendered alone): callers then offer no Deposit.
const DepositActionContext = createContext<(() => void) | null>(null);

export const DepositActionProvider = DepositActionContext.Provider;

export function useOpenDeposit(): (() => void) | null {
  return useContext(DepositActionContext);
}
