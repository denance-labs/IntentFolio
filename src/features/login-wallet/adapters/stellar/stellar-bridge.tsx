"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getAddress,
  isConnected as freighterIsConnected,
  requestAccess,
  signMessage as freighterSignMessage,
} from "@stellar/freighter-api";
import type { LoginWalletAdapter, LoginWalletState } from "../../types";
import { useRegisterLoginWalletAdapter } from "../../context/login-wallet-context";
import { buildStellarSignature } from "./stellar-sign";
import { startFreighterWatch, stellarNetworkWarning } from "./stellar-watch";

type LocalError = string | null;

function deriveState(
  address: string | null,
  isConnecting: boolean,
  error: LocalError,
): LoginWalletState {
  if (error !== null) {
    return { status: "error", connection: null, error };
  }
  if (address !== null) {
    return { status: "connected", connection: { chainKind: "stellar", address }, error: null };
  }
  if (isConnecting) {
    return { status: "connecting", connection: null, error: null };
  }
  return { status: "idle", connection: null, error: null };
}

/**
 * Headless bridge: calls Freighter extension APIs, builds a LoginWalletAdapter,
 * and registers it with the neutral LoginWalletContext.
 * Freighter is request-based (no session); restore relies on D-131 self-persist.
 * On mount, attempts a silent getAddress() to detect a previously-granted access, then keeps
 * following the extension through `stellar-watch.ts` — without that, `liveConnection` could
 * only ever hold the mount's reading, and the D-218 guard that consumes it would be comparing
 * the session against itself (D-220).
 */
export function StellarAdapterBridge() {
  const [address, setAddress] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [localError, setLocalError] = useState<LocalError>(null);
  const [network, setNetwork] = useState<string | null>(null);
  // Set when the user disconnects inside the app. Freighter has no disconnect of its own, so
  // the poll keeps returning the address it still considers allowed — without this, a session
  // the user just ended would come back on its own within 3 s.
  const dismissedRef = useRef(false);
  const hasSession = address !== null;
  // D-545: the mount read below has answered, address or not.
  const [restoreSettled, setRestoreSettled] = useState(false);

  // Silent restore: if the user already granted access, getAddress() returns it immediately.
  useEffect(() => {
    getAddress()
      .then((result) => {
        if (!result.error && result.address && !dismissedRef.current) setAddress(result.address);
      })
      .catch(() => undefined)
      .finally(() => setRestoreSettled(true));
  }, []);

  // Account and network switches inside the extension (D-220). See `stellar-watch.ts` for the
  // measured behaviour of `WatchWalletChanges`; it is a poll, not an event stream.
  //
  // Re-runs when a session appears or goes away, and that dependency is load-bearing rather
  // than tidiness. `isConnected()` answers over the message channel — the `window.freighter`
  // fast path is legacy and the current extension does not set it (measured in the operator's
  // browser, 2026-08-08) — and that channel RESOLVES FALSE after its own 2 s timeout when
  // nothing answered in time. With an empty dependency array, one slow answer from a cold
  // extension would leave account tracking off for the rest of the session and quietly restore
  // the exact staleness D-220 exists to remove. Keying on the session means a successful
  // connect always gets a second attempt, by which point the extension is demonstrably awake.
  useEffect(() => {
    let stop: (() => void) | null = null;
    let cancelled = false;

    void freighterIsConnected().then(({ isConnected }) => {
      // Gate on the extension being present. Freighter's transport gives
      // REQUEST_NETWORK_DETAILS no timeout, so on a browser without the extension the first
      // tick never settles and leaves a dangling `message` listener behind instead of polling.
      if (cancelled || !isConnected) return;
      stop = startFreighterWatch(({ address: next, network: nextNetwork }) => {
        setNetwork(nextNetwork);
        setAddress((prev) => {
          // Unlike Tron, a silent read IS allowed to establish the session here: that is
          // exactly what the mount restore above does (D-131), and Freighter only answers for
          // an origin the user has already authorised. It also repairs a restore that lost the
          // race — `getAddress()` gives up after 2 s, which a cold extension can exceed.
          // The one case that must not create a session is a user who just disconnected.
          if (prev === null && dismissedRef.current) return null;
          return next;
        });
      });
    });

    return () => {
      cancelled = true;
      stop?.();
    };
    // `hasSession` rather than `address`: a switch from one account to another must not tear
    // the watcher down and rebuild it — only the appearance or loss of a session should.
  }, [hasSession]);

  const state = useMemo(
    () => deriveState(address, isConnecting, localError),
    [address, isConnecting, localError],
  );

  const connect = useCallback(async () => {
    setLocalError(null);
    setIsConnecting(true);
    dismissedRef.current = false;
    try {
      const { isConnected } = await freighterIsConnected();
      // Names the wallet rather than the chain, and says the reload part out loud. Freighter's
      // `isConnected` only ever answers for Freighter — no other Stellar wallet can satisfy
      // this check — so "a Stellar wallet" would be both vaguer and less true. Keeps the
      // literal "not found", which `normalizeWalletError` matches to classify this as
      // recoverable-unavailable rather than a bug.
      if (!isConnected) {
        throw new Error("Freighter wallet not found. Install Freighter and reload the page.");
      }
      const result = await requestAccess();
      if (result.error) throw new Error(result.error.message);
      setAddress(result.address);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Stellar connection failed";
      setLocalError(msg);
      throw e;
    } finally {
      setIsConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    // Freighter has no SDK disconnect — clear local state only, and tell the watcher not to
    // re-establish what the user just ended.
    dismissedRef.current = true;
    setAddress(null);
    setLocalError(null);
  }, []);

  const signMessage = useCallback(
    async (message: string) => {
      if (address === null) throw new Error("Wallet not connected");
      // A refused or failed signature is the caller's to report. Setting `localError` here made the
      // derived state `error` with no connection, so the app showed a signed-out user (D-433).
      const result = await freighterSignMessage(message, { address });
      if (result.error) throw new Error(result.error.message);
      if (result.signedMessage === null) throw new Error("Freighter returned null signature");
      // signedMessage may be Buffer (legacy) or string (base64) — normalise to string.
      const signature =
        typeof result.signedMessage === "string"
          ? result.signedMessage
          : Buffer.from(result.signedMessage).toString("base64");
      return buildStellarSignature(result.signerAddress, message, signature);
    },
    [address],
  );

  const clearError = useCallback(() => setLocalError(null), []);

  const adapter = useMemo<LoginWalletAdapter>(
    () => ({ chainKind: "stellar", state, connect, disconnect, signMessage, clearError, restoreSettled }),
    [state, connect, disconnect, signMessage, clearError, restoreSettled],
  );

  useRegisterLoginWalletAdapter(adapter);

  // Only meaningful while a wallet is actually plugged in, and passive rather than blocking —
  // same call as Tron's: IntentFolio can flag a wrong network but cannot stop a transfer the
  // user sends from inside the wallet.
  const networkWarning = address === null ? null : stellarNetworkWarning(network);
  if (networkWarning === null) return null;
  return (
    <div
      role="status"
      className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-amber-500/40 bg-amber-950/90 px-4 py-2 text-sm text-amber-200 shadow-lg"
    >
      {networkWarning}
    </div>
  );
}
