"use client";

import { useMemo } from "react";
import { TonConnectUIProvider } from "@tonconnect/ui-react";

/**
 * TonConnect has NO origin-relative default for the manifest. Passing `manifestUrl:
 * undefined` makes the SDK throw `TON_CONNECT_SDK_ERROR: You have to specify a
 * 'manifestUrl' or a 'connector'` while rendering, and because this provider is mounted
 * inside the app tree it takes THE WHOLE APP down, not just the TON login.
 *
 * The comment that used to sit here asserted the opposite fallback, so the env var read as
 * an optional production override when it was in fact the only thing keeping TON alive.
 * With it unset — the default everywhere, including production — TON login was unreachable.
 * Nothing caught it because no test mounts this provider against the real SDK.
 *
 * `||` and not `??`: an env key present-but-empty must fall back, not become the URL (same
 * reasoning as RPC_ENDPOINTS in wallet/config/network.ts).
 */
export function resolveTonManifestUrl(origin: string): string {
  return (
    process.env.NEXT_PUBLIC_TONCONNECT_MANIFEST_URL ||
    `${origin}/tonconnect-manifest.json`
  );
}

/**
 * FamilyProvider for the TON family.
 * Wraps the subtree with TonConnectUIProvider so that TonConnect hooks
 * (useTonConnectUI, useTonAddress, useTonWallet) work inside TonAdapterBridge.
 * restoreConnection is false — session restore follows D-131 (identity self-persist).
 */
export function TonWalletProvider({ children }: { children: React.ReactNode }) {
  // Only ever mounted client-side (React.lazy in LazyFamilyMount), so `window` is there.
  // The guard is so an SSR mount degrades to "no TON login" instead of crashing the render.
  const manifestUrl = useMemo(
    () =>
      typeof window === "undefined"
        ? null
        : resolveTonManifestUrl(window.location.origin),
    [],
  );

  if (manifestUrl === null) return <>{children}</>;

  return (
    <TonConnectUIProvider manifestUrl={manifestUrl} restoreConnection={false}>
      {children}
    </TonConnectUIProvider>
  );
}
