"use client";

import { useCallback, useMemo, useState } from "react";
import { useTonAddress, useTonConnectModal, useTonConnectUI, useTonWallet } from "@tonconnect/ui-react";
import type { LoginWalletAdapter, LoginWalletState } from "../../types";
import { useRegisterLoginWalletAdapter } from "../../context/login-wallet-context";
import { buildTonSignature } from "./ton-sign";

function deriveState(
  address: string,
  publicKey: string,
  isConnecting: boolean,
): LoginWalletState {
  // authHandleToIntentsUserId for TON requires the hex-encoded public key (64 chars),
  // not the user-facing EQ/UQ address. Use publicKey when available (D-131 / 3.10).
  const identifier = publicKey !== "" ? publicKey : address;
  if (identifier !== "") {
    return { status: "connected", connection: { chainKind: "ton", address: identifier }, error: null };
  }
  if (isConnecting) {
    return { status: "connecting", connection: null, error: null };
  }
  return { status: "idle", connection: null, error: null };
}

/**
 * Headless bridge: reads TonConnect state, builds a LoginWalletAdapter,
 * and registers it with the neutral LoginWalletContext.
 * Must be rendered inside TonWalletProvider.
 */
export function TonAdapterBridge() {
  const address = useTonAddress();
  const wallet = useTonWallet();
  const [tonConnectUI] = useTonConnectUI();
  const { open: openModal } = useTonConnectModal();
  const [isConnecting, setIsConnecting] = useState(false);

  const publicKey = wallet?.account.publicKey ?? "";

  const state = useMemo(
    () => deriveState(address, publicKey, isConnecting),
    [address, publicKey, isConnecting],
  );

  const connect = useCallback(async () => {
    setIsConnecting(true);
    // Opens the TonConnect wallet modal; connection completes async via wallet.
    openModal();
    // Reset connecting flag after the modal opens — actual connection updates address.
    setIsConnecting(false);
  }, [openModal]);

  const disconnect = useCallback(async () => {
    try {
      await tonConnectUI.disconnect();
    } catch {
      // best-effort disconnect
    }
  }, [tonConnectUI]);

  const signMessage = useCallback(
    async (message: string) => {
      if (address === "") throw new Error("Wallet not connected");
      // A refused or failed signature is the caller's to report. Setting an error state here made the
      // derived state `error` with no connection, so the app showed a signed-out user (D-433).
      const result = await tonConnectUI.signData({ type: "text", text: message });
      const publicKey = wallet?.account.publicKey ?? "";
      return buildTonSignature(
        result.address,
        result.domain,
        result.timestamp,
        message,
        result.signature,
        publicKey,
      );
    },
    [address, tonConnectUI, wallet],
  );

  const clearError = useCallback(() => {}, []);

  const adapter = useMemo<LoginWalletAdapter>(
    // D-545: settled from the start — the provider runs with `restoreConnection={false}`, so no
    // live session ever comes back on its own.
    () => ({ chainKind: "ton", state, connect, disconnect, signMessage, clearError, restoreSettled: true }),
    [state, connect, disconnect, signMessage, clearError],
  );

  useRegisterLoginWalletAdapter(adapter);
  return null;
}
