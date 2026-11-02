"use client";

import { WagmiProvider } from "wagmi";
import { wagmiConfig } from "./evm-config";

/**
 * FamilyProvider for the EVM family.
 * Wraps the subtree with wagmi's WagmiProvider so that EVM hooks
 * (useAccount, useSignMessage, useDisconnect) work inside EvmAdapterBridge.
 * TanStack QueryClientProvider is already present at the app root (providers.tsx).
 */
export function EvmWalletProvider({ children }: { children: React.ReactNode }) {
  return <WagmiProvider config={wagmiConfig}>{children}</WagmiProvider>;
}
