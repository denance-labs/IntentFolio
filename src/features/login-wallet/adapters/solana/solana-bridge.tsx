"use client";

import { useCallback, useMemo, useRef } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import type { LoginWalletAdapter, LoginWalletState } from "../../types";
import { useRegisterLoginWalletAdapter } from "../../context/login-wallet-context";
import { buildSolanaSignature } from "./solana-sign";

function deriveState(
  connected: boolean,
  connecting: boolean,
  publicKey: string | undefined,
): LoginWalletState {
  if (connected && publicKey) {
    return { status: "connected", connection: { chainKind: "solana", address: publicKey }, error: null };
  }
  if (connecting) {
    return { status: "connecting", connection: null, error: null };
  }
  return { status: "idle", connection: null, error: null };
}

/**
 * Headless bridge: reads solana-wallet-adapter state, builds a LoginWalletAdapter,
 * and registers it with the neutral LoginWalletContext.
 * Must be rendered inside SolanaWalletProvider.
 */
export function SolanaAdapterBridge() {
  const { wallet, connected, connecting, publicKey, disconnect: walletDisconnect, signMessage: walletSignMessage } = useWallet();
  const { setVisible } = useWalletModal();

  const publicKeyBase58 = publicKey?.toBase58();

  const state = useMemo(
    () => deriveState(connected, connecting, publicKeyBase58),
    [connected, connecting, publicKeyBase58],
  );

  // D-545: `autoConnect` only runs for a saved wallet whose extension is there, and it shows as
  // one `connecting` pass. With no such wallet (`wallet === null`) nothing will run, so the
  // restore is settled from the start. A saved wallet that is not detected yet stays unsettled
  // on purpose: Phantom's adapter keeps looking for the extension, and settling early would let
  // a late auto-connect blank the content it had already shown.
  const sawAutoConnectRef = useRef(false);
  if (connecting) sawAutoConnectRef.current = true;
  const restoreSettled = !connecting && (sawAutoConnectRef.current || wallet === null);

  const connect = useCallback(async () => {
    // Opens the WalletModal for wallet selection; resolves immediately (modal is async).
    setVisible(true);
  }, [setVisible]);

  const disconnect = useCallback(async () => {
    try {
      await walletDisconnect();
    } catch {
      // best-effort disconnect
    }
  }, [walletDisconnect]);

  const signMessage = useCallback(
    async (message: string) => {
      if (!walletSignMessage) throw new Error("Wallet does not support signMessage");
      if (!publicKeyBase58) throw new Error("Wallet not connected");
      // A refused or failed signature is the caller's to report. Setting an error state here made the
      // derived state `error` with no connection, so the app showed a signed-out user (D-433).
      const encoded = new TextEncoder().encode(message);
      const sigBytes = await walletSignMessage(encoded);
      return buildSolanaSignature(sigBytes, publicKeyBase58, message);
    },
    [walletSignMessage, publicKeyBase58],
  );

  const clearError = useCallback(() => {}, []);

  const adapter = useMemo<LoginWalletAdapter>(
    () => ({ chainKind: "solana", state, connect, disconnect, signMessage, clearError, restoreSettled }),
    [state, connect, disconnect, signMessage, clearError, restoreSettled],
  );

  useRegisterLoginWalletAdapter(adapter);
  return null;
}
