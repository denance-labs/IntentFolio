"use client";

// Publishes the NEAR wallet capabilities the live-vault Allocate needs (007.plan Phase 1).
//
// Why a context instead of calling useNearWallet() inside PortfolioProvider: PortfolioProvider
// also renders on /mock-dashboard, which has NO NearWalletProvider above it (see
// app/(mock)/mock-dashboard/mock-providers.tsx). Calling the HOT Connect hook there would
// crash the QA seed path. Consumers get `null` when this provider is absent, and fall back
// to the mock exactly as before.
//
// Rendering this provider does NOT enable anything on its own — the real path is still
// gated on VAULT_ROUNDTRIP_ENABLED plus a connected NEAR wallet.

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useNearWallet } from "near-connect-hooks";
import type { NearSigner } from "../lib/allocate-submit";

/**
 * Sends a transaction asking the wallet to sign AS `signerId`. Asking, not enforcing: Meteor and
 * MyNearWallet ignore it (near-wallet-deposit.ts, `wrong-signer`).
 */
export type SendTransactionAs = (params: {
  signerId: string;
  receiverId: string;
  actions: unknown[];
}) => Promise<unknown>;

type RealNearWallet = NearSigner & { sendTransactionAs: SendTransactionAs };

/**
 * No connected wallet to send through. Thrown BEFORE sending; its name is what
 * `classifyWalletDepositError` matches (`WALLET_NOT_CONNECTED_ERROR`).
 */
export class WalletNotConnectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletNotConnectedError";
  }
}

const RealAllocateContext = createContext<RealNearWallet | null>(null);

export function RealAllocateProvider({ children }: { children: ReactNode }) {
  const lib = useNearWallet();

  const signer = useMemo<RealNearWallet>(
    () => ({
      signNEP413Message: (params) => lib.signNEP413Message(params),
      signAndSendTransaction: (params) =>
        lib.signAndSendTransaction(
          params as Parameters<typeof lib.signAndSendTransaction>[0]
        ),
      // near-connect's own method, NOT the hook's above: `useNearWallet().signAndSendTransaction`
      // forwards only `{receiverId, actions}` and drops `signerId` without an error
      // (`near-connect-hooks` `useNearWallet.js:110-114`). The `await connector.wallet()` is
      // the same one the hook does, so this adds no latency before the wallet opens.
      sendTransactionAs: async (params) => {
        let wallet: Awaited<ReturnType<typeof lib.connector.wallet>>;
        try {
          wallet = await lib.connector.wallet();
        } catch (e) {
          // near-connect throws here ("No accounts found") before anything reaches a wallet, so
          // this refusal PROVES nothing was sent — which a generic throw from the send cannot.
          throw new WalletNotConnectedError(e instanceof Error ? e.message : String(e));
        }
        return wallet.signAndSendTransaction(
          params as Parameters<typeof wallet.signAndSendTransaction>[0]
        );
      },
    }),
    [lib]
  );

  return <RealAllocateContext.Provider value={signer}>{children}</RealAllocateContext.Provider>;
}

/**
 * Hard-disables the live-vault path for everything below, regardless of the flag.
 *
 * Required by /mock-dashboard: the root layout renders RealAllocateProvider above EVERY
 * route, and the mock QA identity presents as a NEAR login — so without this, turning the
 * flag on would let the mock/QA dashboard move real funds. QA must never be able to.
 */
export function RealAllocateDisabled({ children }: { children: ReactNode }) {
  return <RealAllocateContext.Provider value={null}>{children}</RealAllocateContext.Provider>;
}

/** The NEAR signer, or null when the real path is not available in this tree. */
export function useRealAllocateSigner(): NearSigner | null {
  return useContext(RealAllocateContext);
}

/**
 * The sender a wallet deposit signs with (016 §5.3, block 2a), or null when the real path is not
 * available in this tree — the same kill-switch as the signer: `RealAllocateDisabled` nulls both.
 */
export function useSendTransactionAs(): SendTransactionAs | null {
  return useContext(RealAllocateContext)?.sendTransactionAs ?? null;
}
