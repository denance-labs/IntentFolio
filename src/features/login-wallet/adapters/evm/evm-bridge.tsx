"use client";

// Attribution: see ATTRIBUTIONS.md #23 (the switch-then-send of `sendEvmTransaction`).
import { useCallback, useMemo, useRef } from "react";
import { UserRejectedRequestError, withTimeout } from "viem";
import { useAccount, useDisconnect, useSendTransaction, useSignMessage, useSwitchChain } from "wagmi";
import { useAppKit } from "@reown/appkit/react";
import type { EvmTransactionRequest, LoginWalletAdapter, LoginWalletState } from "../../types";
import { useRegisterLoginWalletAdapter } from "../../context/login-wallet-context";
import { EvmChainSwitchError, EvmChainSwitchTimeoutError } from "../../lib/evm-send-errors";
import { buildEvmSignature } from "./evm-sign";

/**
 * How long the wallet gets to switch networks. near.com's figure: WalletConnect never answers a
 * switch it cannot make, so without a limit the deposit would wait forever.
 */
const CHAIN_SWITCH_TIMEOUT_MS = 30_000;

/** A decline anywhere in the error's cause chain: the user said no, in the wallet. */
function isUserRejection(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 8; e = (e as { cause?: unknown }).cause, depth++) {
    if (e instanceof UserRejectedRequestError) return true;
    if ((e as { code?: unknown }).code === 4001) return true;
  }
  return false;
}

function deriveState(
  status: "connected" | "connecting" | "reconnecting" | "disconnected",
  address: string | undefined,
): LoginWalletState {
  if (status === "connected" && address) {
    return { status: "connected", connection: { chainKind: "evm", address }, error: null };
  }
  if (status === "connecting" || status === "reconnecting") {
    return { status: "connecting", connection: null, error: null };
  }
  return { status: "idle", connection: null, error: null };
}

/**
 * Headless bridge: reads wagmi + AppKit state, builds a LoginWalletAdapter,
 * and registers it with the neutral LoginWalletContext.
 * Must be rendered inside EvmWalletProvider (WagmiProvider).
 */
export function EvmAdapterBridge() {
  const { status, address, connector } = useAccount();
  const { open } = useAppKit();
  const { disconnect: wagmiDisconnect } = useDisconnect();
  const { signMessageAsync } = useSignMessage();
  const { switchChainAsync } = useSwitchChain();
  const { sendTransactionAsync } = useSendTransaction();

  const state = useMemo(
    () => deriveState(status, address),
    [status, address],
  );

  // D-545: wagmi's mount `reconnect()` always passes through `connecting`/`reconnecting` and
  // leaves it once every connector has answered. The `disconnected` before it is only the
  // initial state (`ssr: true`, evm-config.ts), so the restore counts as settled only after
  // that pass has been seen. Written during render, like the other refs read in render here.
  const sawReconnectRef = useRef(false);
  if (status === "connecting" || status === "reconnecting") sawReconnectRef.current = true;
  const restoreSettled =
    sawReconnectRef.current && status !== "connecting" && status !== "reconnecting";

  const connect = useCallback(async () => {
    // Opens the AppKit modal; resolves when the modal closes.
    await open({ view: "Connect" });
  }, [open]);

  const disconnect = useCallback(async () => {
    try {
      wagmiDisconnect();
    } catch {
      // best-effort disconnect
    }
  }, [wagmiDisconnect]);

  const signMessage = useCallback(
    async (message: string) => {
      // A refused or failed signature is the caller's to report. Setting an error state here made the
      // derived state `error` with no connection, so the app showed a signed-out user (D-433).
      const sig = await signMessageAsync({ message });
      return buildEvmSignature(sig, message);
    },
    [signMessageAsync],
  );

  const clearError = useCallback(() => {}, []);

  // D-445 part 2. The chain is read off the connector itself, not from wagmi's state, which can
  // lag the wallet (near.com does the same). A switch the user declines is rethrown as it is — a
  // decline; any other switch failure becomes `EvmChainSwitchError`, so the deposit can say the
  // network is the problem. The send is asked for only on the right chain, and `chainId` makes
  // wagmi refuse it if the wallet moved in between. A `gas` the deposit names goes to the wallet
  // as the limit; without one, `gas: null` leaves the estimate to the wallet.
  const sendEvmTransaction = useCallback(
    async (tx: EvmTransactionRequest) => {
      if (!connector) throw new Error("WalletNotConnectedError");
      const current = await connector.getChainId();
      if (current !== tx.chainId) {
        try {
          await withTimeout(() => switchChainAsync({ connector, chainId: tx.chainId }), {
            timeout: CHAIN_SWITCH_TIMEOUT_MS,
            errorInstance: new EvmChainSwitchTimeoutError(tx.chainId),
          });
        } catch (error) {
          if (error instanceof EvmChainSwitchTimeoutError || isUserRejection(error)) throw error;
          throw new EvmChainSwitchError(tx.chainId, error);
        }
      }
      return sendTransactionAsync({
        connector,
        chainId: tx.chainId,
        to: tx.to,
        value: tx.value,
        data: tx.data,
        gas: tx.gas ?? null,
      });
    },
    [connector, switchChainAsync, sendTransactionAsync],
  );

  const adapter = useMemo<LoginWalletAdapter>(
    () => ({
      chainKind: "evm",
      state,
      connect,
      disconnect,
      signMessage,
      clearError,
      restoreSettled,
      sendEvmTransaction,
    }),
    [state, connect, disconnect, signMessage, clearError, restoreSettled, sendEvmTransaction],
  );

  useRegisterLoginWalletAdapter(adapter);
  return null;
}
