"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LoginWalletAdapter, LoginWalletState } from "../../types";
import { useRegisterLoginWalletAdapter } from "../../context/login-wallet-context";
import { buildTronSignature } from "./tron-sign";
import {
  readTronChainId,
  resolveTronProvider,
  tronNetworkWarning,
  type TronProvider,
} from "./tron-discovery";

// This bridge speaks TIP-6963 (`tron-provider.ts`), NOT the legacy `window.tronLink` /
// `window.tronWeb` globals it used until block 4.2's real-funds run. Those globals turned out
// to be claimed by another installed wallet in an ordinary browser, which broke both the
// login AND the signer — see the header of `tron-provider.ts` for the measurements.
//
// Everything below therefore reads off `provider.tronWeb`, the instance the authorising
// extension owns, and never off a global.

// `tronWeb` is `false` until the origin is authorised, and the extension flips it
// asynchronously after the prompt resolves. Both waits below poll for it rather than assume
// it is there.
const TRONWEB_POLL_INTERVAL_MS = 100;
// Mount restore is a SILENT path: if the origin is not already trusted nothing will ever
// arrive, so waiting long only delays the picker.
const RESTORE_TIMEOUT_MS = 3000;
// After an explicit prompt the user may have had to unlock the wallet first, so the extension
// can take far longer than a restore. 3 s here used to abort while TronLink was still waiting
// on the user — the operator hit exactly that with a locked wallet.
const CONNECT_TIMEOUT_MS = 30000;

type LocalError = string | null;

function readAddress(provider: TronProvider | null): string | null {
  // `tronWeb` is `false` until the origin is authorised, so the falsy check covers both
  // "absent" and "not yet authorised". `ready` is the flag the extension flips once an
  // account is actually active; reading `defaultAddress` without it reports an address the
  // wallet has not committed to.
  const tronWeb = provider?.tronWeb;
  if (!tronWeb || !tronWeb.ready) return null;
  const addr = tronWeb.defaultAddress;
  return addr && addr.base58 ? addr.base58 : null;
}

async function waitForAddress(
  provider: TronProvider,
  timeoutMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const addr = readAddress(provider);
    if (addr) return addr;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, TRONWEB_POLL_INTERVAL_MS));
  }
}

function deriveState(
  address: string | null,
  isConnecting: boolean,
  error: LocalError,
): LoginWalletState {
  if (error !== null) {
    return { status: "error", connection: null, error };
  }
  if (address !== null) {
    return { status: "connected", connection: { chainKind: "tron", address }, error: null };
  }
  if (isConnecting) {
    return { status: "connecting", connection: null, error: null };
  }
  return { status: "idle", connection: null, error: null };
}

/**
 * Headless bridge: discovers a Tron provider over TIP-6963, builds a LoginWalletAdapter, and
 * registers it with the neutral LoginWalletContext.
 */
export function TronAdapterBridge() {
  const [address, setAddress] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [localError, setLocalError] = useState<LocalError>(null);
  const [networkWarning, setNetworkWarning] = useState<string | null>(null);
  // State drives the listener effect (a ref cannot — mutating `.current` renders nothing, so
  // the effect would run once with `null` and never attach). The ref mirrors it so the
  // callbacks read the current provider without being rebuilt on every discovery.
  const [provider, setProvider] = useState<TronProvider | null>(null);
  const providerRef = useRef<TronProvider | null>(null);

  const adoptProvider = useCallback((next: TronProvider) => {
    providerRef.current = next;
    setProvider(next);
  }, []);

  // Discover once, then silently restore if the extension already trusts this origin (D-131).
  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;

    void (async () => {
      const selected = await resolveTronProvider();
      if (cancelled || !selected) return;
      adoptProvider(selected.provider);

      const addr = await waitForAddress(selected.provider, RESTORE_TIMEOUT_MS);
      if (!cancelled && addr) setAddress(addr);
    })();

    return () => {
      cancelled = true;
    };
  }, [adoptProvider]);

  // Account and network switches inside the extension.
  //
  // Every other family gets this free from a reactive SDK hook (wagmi, near-connect-hooks,
  // @solana/wallet-adapter-react, @tonconnect/ui-react); Tron has no library under it. The
  // previous implementation listened to `window.postMessage` broadcasts because the legacy
  // surface offers nothing better — `provider.on` is the mechanism actually designed for it,
  // and it cannot be spoofed by a page that simply posts a message to itself.
  //
  // This is not cosmetic. `liveConnection` (use-login-wallet.ts) is derived from this state,
  // and `assertWalletMatchesAccount` (portfolio-context.tsx) compares it to decide whether the
  // plugged-in wallet belongs to the session (D-218). Fed a stale address, that guard compares
  // the session against itself and cannot fail.
  useEffect(() => {
    if (!provider || typeof provider.on !== "function") return;

    const onAccountsChanged = () => {
      // Re-read from the provider rather than trust the event payload, and only ever UPDATE a
      // session that already exists — an event must never be able to create a login.
      setAddress((prev) => (prev === null ? null : readAddress(providerRef.current)));
    };
    const onDisconnect = () => {
      setAddress(null);
      setNetworkWarning(null);
    };
    const onChainChanged = () => {
      void readTronChainId(provider).then((id) => setNetworkWarning(tronNetworkWarning(id)));
    };

    provider.on("accountsChanged", onAccountsChanged);
    provider.on("chainChanged", onChainChanged);
    provider.on("disconnect", onDisconnect);

    return () => {
      if (typeof provider.removeListener !== "function") return;
      provider.removeListener("accountsChanged", onAccountsChanged);
      provider.removeListener("chainChanged", onChainChanged);
      provider.removeListener("disconnect", onDisconnect);
    };
    // Re-runs when a provider is discovered after mount. The handlers read the live address
    // through the ref and the state updater, so `address` is deliberately not a dependency:
    // re-subscribing on every account change would be churn for no gain.
  }, [provider]);

  const state = useMemo(
    () => deriveState(address, isConnecting, localError),
    [address, isConnecting, localError],
  );

  const connect = useCallback(async () => {
    setLocalError(null);
    setIsConnecting(true);
    try {
      // Re-resolve rather than rely on the mount effect: a user can install or unlock a wallet
      // after the page loaded, and the picker's job is to work on the second try.
      const active = providerRef.current ?? (await resolveTronProvider())?.provider ?? null;
      if (!active) {
        throw new Error("No Tron wallet found. Install TronLink and reload the page.");
      }
      adoptProvider(active);

      // Resolves only once the user answers; if the wallet is locked, the unlock prompt comes
      // first and this stays pending throughout. Errors arrive as thrown rejections here,
      // unlike the legacy `tron_requestAccounts`, which resolved with a code.
      await active.request({ method: "eth_requestAccounts" });

      const addr = await waitForAddress(active, CONNECT_TIMEOUT_MS);
      if (!addr) throw new Error("The Tron wallet authorised this site but exposed no address.");
      setAddress(addr);

      // Read AFTER authorisation: the chain is not reliably readable before it, and this is a
      // warning rather than a gate — see `tronNetworkWarning`.
      setNetworkWarning(tronNetworkWarning(await readTronChainId(active)));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Tron connection failed";
      setLocalError(msg);
      throw e;
    } finally {
      setIsConnecting(false);
    }
  }, [adoptProvider]);

  const disconnect = useCallback(async () => {
    // Tron wallets expose no disconnect — clear local state only.
    setAddress(null);
    setLocalError(null);
    setNetworkWarning(null);
  }, []);

  const signMessage = useCallback(
    async (message: string) => {
      const provider = providerRef.current;
      if (!address) throw new Error("Wallet not connected");
      const tronWeb = provider?.tronWeb;
      // The signer comes off the PROVIDER, never off `window.tronWeb`: that global was found
      // hijacked, and signing through it would hand the message to another extension.
      if (!tronWeb) {
        throw new Error("Tron wallet not available");
      }
      // A refused or failed signature is the caller's to report. Setting `localError` here made the
      // derived state `error` with no connection, so the app showed a signed-out user (D-433).
      const signature = await tronWeb.trx.signMessageV2(message);
      return buildTronSignature(message, signature);
    },
    [address],
  );

  const clearError = useCallback(() => setLocalError(null), []);

  const adapter = useMemo<LoginWalletAdapter>(
    () => ({ chainKind: "tron", state, connect, disconnect, signMessage, clearError }),
    [state, connect, disconnect, signMessage, clearError],
  );

  useRegisterLoginWalletAdapter(adapter);

  // Surfaced as a passive banner rather than a blocker: see `tronNetworkWarning`.
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
