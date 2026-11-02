"use client";

import { useEffect } from "react";
import type { ReactNode } from "react";
import { WalletContext } from "@/features/dashboard-shell/context/wallet-context";
import { PortfolioProvider } from "@/features/dashboard-shell";
import { MockWalletBalancesProvider } from "@/features/wallet";
import { DashboardShell } from "@/features/dashboard-shell";
import { MOCK_WALLET_FIXTURE } from "@/features/wallet/lib/mock-wallet-fixture";
import { MockLoginWalletProvider } from "@/features/login-wallet/mock/mock-login-wallet-provider";
import { useLoginWallet } from "@/features/login-wallet";
import { seedAccountRebalances } from "@/features/dashboard-shell/lib/rebalance-seeder";
import { seedNavHistory } from "@/features/dashboard-shell/lib/nav-seeder";
import { RealAllocateDisabled } from "@/features/vault/context/real-allocate-context";

// Seeds mock rebalance history and NAV snapshots once the identity is resolved. Idempotent.
function MockSeedEffect() {
  const { intentsAccountId } = useLoginWallet();
  useEffect(() => {
    if (intentsAccountId) {
      seedAccountRebalances(intentsAccountId);
      seedNavHistory(intentsAccountId);
    }
  }, [intentsAccountId]);
  return null;
}

// Hardcoded connected wallet for the QA route. No real HOT Connect session needed.
const MOCK_WALLET_VALUE = {
  status: "connected" as const,
  signedAccountId: "demo.testnet",
  walletNetwork: "mainnet" as const,
  signIn: async () => {},
  signOut: async () => {},
};

export function MockDashboardProviders({ children }: { children: ReactNode }) {
  return (
    <WalletContext.Provider value={MOCK_WALLET_VALUE}>
      {/* MockLoginWalletProvider supplies the deterministic identity + signMessage that
          PortfolioProvider reads via useLoginWallet (5.5-D), so the signed commit
          round-trip runs headless and its outcome is driven by `?sign=`. State is
          isolated from any real connected account. */}
      <MockLoginWalletProvider>
        <MockSeedEffect />
        {/* The root layout provides a real NEAR signer to every route, and this QA identity
            presents as a NEAR login — so the live-vault path is hard-disabled here. The QA
            dashboard must never be able to move real funds, flag on or off. */}
        <RealAllocateDisabled>
          <PortfolioProvider>
            <MockWalletBalancesProvider value={MOCK_WALLET_FIXTURE}>
              <DashboardShell basePath="/mock-dashboard">
                {children}
              </DashboardShell>
            </MockWalletBalancesProvider>
          </PortfolioProvider>
        </RealAllocateDisabled>
      </MockLoginWalletProvider>
    </WalletContext.Provider>
  );
}
