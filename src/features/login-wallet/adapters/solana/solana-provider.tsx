"use client";

import { useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-wallets";
import "@solana/wallet-adapter-react-ui/styles.css";

// Solana mainnet RPC endpoint.
const SOLANA_RPC_ENDPOINT = "https://api.mainnet-beta.solana.com";

/**
 * FamilyProvider for the Solana family.
 * Wraps the subtree with ConnectionProvider + WalletProvider + WalletModalProvider
 * so that Solana hooks (useWallet, useWalletModal) work inside SolanaAdapterBridge.
 */
export function SolanaWalletProvider({ children }: { children: React.ReactNode }) {
  // Only Phantom is listed explicitly; `WalletProvider` wraps this list with
  // `useStandardWalletAdapters`, so any Wallet Standard wallet the browser has registered
  // (Backpack, Solflare, ...) is appended automatically and needs no entry here.
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);

  return (
    <ConnectionProvider endpoint={SOLANA_RPC_ENDPOINT}>
      {/*
        `autoConnect` MUST be true, and it is not the convenience flag the name suggests.
        The wallet modal's click handler only calls `select(name)` (WalletModal.js:74) — it
        never connects. With `autoConnect={false}` nothing else does either, so choosing a
        wallet persisted `walletName` and then sat there: the picker's 8s fallback timer
        (wallet-picker.tsx:206) cleared the spinner and login silently did nothing. Measured
        against Backpack on 2026-08-06 (008.plan F4.2).

        This is NOT "connect without asking". `WalletProvider` branches on whether the user
        picked the wallet in this session (WalletProvider.js:136-141): a fresh selection gets
        `adapter.connect()` (prompts, as it should), while a page load with a persisted name
        gets `adapter.autoConnect()` — the silent variant that only proceeds if the wallet
        already trusts this origin. Hand-rolling the connect call in the bridge would have
        collapsed that distinction, and would also have missed `handleConnectError` clearing
        `walletName` on failure, which is what makes a retry re-trigger at all.
      */}
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
