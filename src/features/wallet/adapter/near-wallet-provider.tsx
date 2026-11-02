"use client";
import type { ReactNode } from "react";
import { NearProvider } from "near-connect-hooks";
import { NETWORK, RPC_ENDPOINTS } from "../config/network";

/**
 * Which wallets the NEAR picker offers, expressed as required capabilities (D-282).
 *
 * 🔴 NOT `{ mainnet: true }`, and this is not a style preference — it hid six wallets from
 * every NEAR tester. Measured 2026-08-13 against the live HOT Connect manifest (v1.1.0, 13
 * wallets): only meteor, ledger, near-mobile and near-cli SET that key. The other nine —
 * including hot-wallet, intear-wallet, nightly-wallet, mynearwallet, okx-wallet and
 * hana-wallet — simply OMIT it. The connector's filter is
 *
 *     if (value && !wallet.manifest.features?.[key]) return false   // NearConnector.js
 *
 * so an absent key reads as "unsupported" and those nine vanish from the picker. Filtering
 * on `mainnet` therefore filters on how completely the upstream manifest entry happens to be
 * filled in, not on what the wallet can do — HOT plainly supports mainnet.
 *
 * Nothing needed that filter: the network is pinned by `network` below, and the SDK checks
 * testnet on a separate branch. `signMessage` is the capability we genuinely require
 * (NEP-413 signing), and 12 of the 13 declare it.
 *
 * Exported so `near-wallet-provider.test.ts` can run it against the measured manifest —
 * re-adding a key the upstream manifest under-populates is exactly the regression that
 * cannot be caught by reading this file.
 */
export const NEAR_WALLET_FEATURES = { signMessage: true } as const;

export function NearWalletProvider({ children }: { children: ReactNode }) {
  return (
    <NearProvider
      config={{
        network: NETWORK,
        providers: { [NETWORK]: [RPC_ENDPOINTS[NETWORK]] },
        features: NEAR_WALLET_FEATURES,
        autoConnect: true,
        footerBranding: null,
      }}
    >
      {children}
    </NearProvider>
  );
}
