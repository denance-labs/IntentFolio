"use client";

import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { useNearWalletAdapter } from "@/features/wallet";
import type { NearNetwork } from "@/features/wallet/config/network";

export type WalletStatus = "disconnected" | "connecting" | "connected" | "error";

type WalletContextValue = {
  status: WalletStatus;
  signedAccountId: string | null;
  walletNetwork: NearNetwork | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
};

function mapAdapterStatus(
  adapterStatus: "initializing" | "signed-out" | "signing-in" | "signed-in" | "error"
): WalletStatus {
  switch (adapterStatus) {
    case "signed-in":
      return "connected";
    case "signing-in":
    case "initializing":
      return "connecting";
    case "error":
      return "error";
    default:
      return "disconnected";
  }
}

export const WalletContext = createContext<WalletContextValue | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const { state, signIn, signOut } = useNearWalletAdapter();

  useEffect(() => {
    try { localStorage.removeItem("portfolio.walletStatus"); } catch { /* ignore */ }
  }, []);

  const value = useMemo<WalletContextValue>(
    () => ({
      status: mapAdapterStatus(state.status),
      signedAccountId: state.signedAccountId,
      walletNetwork: state.walletNetwork,
      signIn,
      signOut,
    }),
    [state, signIn, signOut]
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet() {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used within a WalletProvider");
  return ctx;
}
