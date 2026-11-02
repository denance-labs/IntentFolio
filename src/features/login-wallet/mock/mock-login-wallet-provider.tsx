"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  LoginWalletContext,
  type LoginWalletContextValue,
} from "../context/login-wallet-context";
import { deriveIntentsAccountId } from "../lib/identity";
import type { Signature } from "@/features/intents-account/mock-contract/types";

/**
 * QA-only deterministic LoginWallet context for the /mock-dashboard route (5.5-D).
 *
 * The real LoginWalletProvider (root layout) routes signMessage to a live wallet picker,
 * which can't run headless — so the signed commit round-trip can't be exercised in QA.
 * Nesting this provider inside the mock route overrides that surface with a fixed,
 * connected identity and a signMessage whose outcome is chosen via the `?sign=` query
 * param, so QA (and Playwright) can drive both the happy path and the 5.5 error states:
 *
 *   ?sign=ok       (default) → returns a deterministic signature, commit succeeds
 *   ?sign=reject             → throws a user-rejection error      → "cancel" state
 *   ?sign=locked             → throws a wallet-unavailable error  → "unavailable" state
 *   ?sign=error              → throws an unexpected error         → "error" state
 *
 * Isolated from prod: it lives in mock/, is imported only by the mock route, and the param
 * is read at sign time from window so no render-time hook (or Suspense boundary) is needed.
 */

// A stable mainnet-style NEAR identity so the derived intentsAccountId is reproducible.
// Defaults to a public-facing demo persona (`satoshi.near`) instead of an internal
// "qa-demo.near", which read as a QA artifact in the live demo. The address is
// overridable via the `?account=` query param (read post-mount, same pattern as
// `?sign=`) so QA can capture landing screenshots under a chosen persona
// (e.g. `?account=alice.near`, D-001/7.6).
const DEFAULT_MOCK_ADDRESS = "satoshi.near";

function resolveMockAddress(): string {
  if (typeof window === "undefined") return DEFAULT_MOCK_ADDRESS;
  return new URLSearchParams(window.location.search).get("account") || DEFAULT_MOCK_ADDRESS;
}

function buildMockSignature(message: string): Signature {
  return { scheme: "nep413", payload: message, signature: "mock-signature", publicKey: "ed25519:mock" };
}

export async function deterministicSign(message: string): Promise<Signature> {
  const outcome =
    typeof window === "undefined" ? "ok" : new URLSearchParams(window.location.search).get("sign");
  switch (outcome) {
    case "reject":
      throw new Error("User rejected the request");
    case "locked":
      throw new Error("Wallet not connected");
    case "error":
      throw new Error("Mock signer failure");
    default:
      return buildMockSignature(message);
  }
}

const noop = () => {};
const asyncNoop = async () => {};

export function MockLoginWalletProvider({ children }: { children: ReactNode }) {
  // Mirror the real provider's D-137 gate: stay unhydrated (no identity) until after
  // mount. Otherwise SSR would render a connected identity whose localStorage-backed
  // portfolios only exist on the client → hydration mismatch. Pre-mount the consumer
  // sees status "restoring" (matching SSR), then it flips to connected.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Resolve the address only post-mount so SSR (identity null) matches the first client
  // paint; reading the query param at render time would otherwise risk a hydration mismatch.
  const address = mounted ? resolveMockAddress() : DEFAULT_MOCK_ADDRESS;

  const value = useMemo<LoginWalletContextValue>(
    () => ({
      activeFamily: mounted ? "near" : null,
      lastUsedFamily: "near",
      state: mounted
        ? { status: "connected", connection: { chainKind: "near", address }, error: null }
        : { status: "idle", connection: null, error: null },
      identity: mounted
        ? { chainKind: "near", address, intentsAccountId: deriveIntentsAccountId(address, "near") }
        : null,
      hydrated: mounted,
      adapterRegistered: mounted,
      restoreSettled: mounted,
      selectFamily: noop,
      connect: asyncNoop,
      disconnect: asyncNoop,
      signMessage: deterministicSign,
      signOut: asyncNoop,
      clearError: noop,
      // QA fixture: the mock identity is never gated, so headless runs of /mock-dashboard
      // exercise the screens instead of the D-280 banner. The gate is real-wallet-only by
      // construction — it needs a signature no mock can produce.
      keyVerification: { kind: "not-required" },
      // Answers what the fixture already claims above, so B4's door lets QA through instead
      // of awaiting a verification that can never run here.
      verifyKey: async () => ({ kind: "not-required" }) as const,
      // No-ops for the same reason: `not-required` can never reach a state that offers to
      // register, so a mock that sent anything would be simulating a path this fixture is
      // deliberately not on.
      registerKey: asyncNoop,
      cancelRegistration: noop,
      // The mock identity is NEAR, and nothing here may ever reach a wallet that moves funds.
      sendEvmTransaction: null,
      registerAdapter: noop,
    }),
    [mounted, address],
  );

  return <LoginWalletContext.Provider value={value}>{children}</LoginWalletContext.Provider>;
}
