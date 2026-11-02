"use client";

import { useEffect, useMemo, useState } from "react";
import { useLoginWalletContext } from "../context/login-wallet-context";
import type { ChainKind, LoginWalletAdapter, LoginWalletConnection, LoginWalletStatus } from "../types";
import type { PersistedIdentity } from "../lib/persistence";
import type { Signature } from "@/features/intents-account/mock-contract/types";
import { deriveIntentsAccountId, walletMatchesAccount } from "../lib/identity";
import type { NearKeyVerification } from "../lib/near-key-verification";

// How long to show "restoring" skeleton before degrading to "connected" (wallet unavailable, D-131).
export const RESTORE_TIMEOUT_MS = 1500;

export type LoginWalletHookStatus =
  | "idle"        // no session — show WalletPicker
  | "restoring"   // persisted identity exists, adapter not yet live (skeleton, D-054)
  | "connecting"  // user-initiated connection in progress
  | "connected"   // wallet live OR identity known (wallet connects on demand at sign time)
  | "error";

export type UseLoginWalletResult = {
  status: LoginWalletHookStatus;
  /** Adapter error sentinel/message when status is "error" (D-120). */
  error: string | null;
  connection: LoginWalletConnection | null;
  /**
   * The wallet currently connected in the extension, unfiltered. Differs from `connection`
   * exactly when a wallet other than the session's own is active. Read this to check which
   * wallet is plugged in; read `connection` to know who the session belongs to.
   */
  liveConnection: LoginWalletConnection | null;
  /** Derived from connection via authHandleToIntentsUserId (D-131). Empty string when no connection. */
  intentsAccountId: string;
  family: ChainKind | null;
  lastUsedFamily: ChainKind | null;
  selectFamily: (family: ChainKind, options?: { autoConnect?: boolean }) => void;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  signMessage: (message: string, expectedAccountId?: string) => Promise<Signature>;
  signOut: () => Promise<void>;
  clearError: () => void;
  /**
   * D-280 B2 — whether the key the live wallet signs with is authorised on `intents.near`.
   * Always `not-required` off the NEAR family. B2 only surfaces it; B4 enforces it.
   */
  keyVerification: NearKeyVerification;
  /**
   * Runs the gate: one NEP-413 prompt, then one chain read, and RETURNS what it concluded.
   * The money door (B4) needs the answer inside the same click, before React re-renders.
   */
  verifyKey: () => Promise<NearKeyVerification>;
  /**
   * D-280 B3 — registers the key the gate saw sign, then re-reads the chain. The re-read is
   * the only thing that can conclude `registered`; a successful receipt is not enough.
   */
  registerKey: () => Promise<void>;
  /** Stops waiting on that registration. Cannot recall a transaction already sent. */
  cancelRegistration: () => void;
  /** D-445 part 2 — the EVM wallet's send (switch network, then send), or null off EVM. */
  sendEvmTransaction: LoginWalletAdapter["sendEvmTransaction"] | null;
};

export function deriveStatus(
  adapterStatus: LoginWalletStatus,
  identity: PersistedIdentity | null,
  activeFamily: ChainKind | null,
  isRestoringTimedOut: boolean,
): LoginWalletHookStatus {
  if (adapterStatus === "connected") return "connected";
  if (adapterStatus === "connecting") return "connecting";
  if (adapterStatus === "error") return "error";
  // idle: check for persisted identity
  if (identity !== null && activeFamily !== null) {
    // After timeout, show as "connected" — wallet connects on demand at sign time (D-131).
    return isRestoringTimedOut ? "connected" : "restoring";
  }
  return "idle";
}

/**
 * Single hook for the rest of the app to access wallet identity/session.
 * Hides which wallet family is active behind a stable surface.
 */
export function useLoginWallet(): UseLoginWalletResult {
  const ctx = useLoginWalletContext();
  const [isRestoringTimedOut, setIsRestoringTimedOut] = useState(false);

  const isRestoring =
    ctx.identity !== null &&
    ctx.activeFamily !== null &&
    ctx.state.status === "idle";

  // 🔴 The clock starts once the family's adapter has registered, not at hydration (D-498).
  // The app now renders while the family chunk is still loading; timing out then would report
  // `connected` with no adapter behind it — signing fails with "No wallet family active" and a
  // NEAR named account gets a Verify button with no gate to run. Until the adapter is there,
  // the session stays `restoring`, which is what the old in-Suspense mount amounted to.
  const restoreClockRunning = isRestoring && ctx.adapterRegistered;

  useEffect(() => {
    if (!restoreClockRunning) {
      setIsRestoringTimedOut(false);
      return;
    }
    const timer = setTimeout(() => setIsRestoringTimedOut(true), RESTORE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [restoreClockRunning]);

  // D-545 — the clock is only a cap. Measured 2026-10-31: HOT Connect knows there is no live
  // session ~160 ms in (~430–730 ms with a saved sandbox wallet), yet the app sat ~1.5 s more
  // on "Signing in…". When the adapter itself says its restore is over, stop waiting. Same
  // D-498 floor as the clock: only a registered adapter can say so.
  const restoreSettled = restoreClockRunning && ctx.restoreSettled;

  // Before the provider has read localStorage (server render + first client
  // render), report "restoring" so the UI shows the neutral skeleton instead of
  // the Sign In screen — keeps SSR and client in sync and avoids a flash for
  // signed-in users on refresh (D-137).
  const status = !ctx.hydrated
    ? "restoring"
    : deriveStatus(
        ctx.state.status,
        ctx.identity,
        ctx.activeFamily,
        isRestoringTimedOut || restoreSettled,
      );

  // Connection prefers the live adapter; falls back to persisted identity for the restoring
  // state — EXCEPT when the live wallet is not the account this session belongs to.
  //
  // The live connection used to win unconditionally. That meant switching the active account
  // inside the wallet extension silently re-identified the entire app: chip, `intentsAccountId`,
  // and every balance/history query keyed off it. No signature, no confirmation, no notice.
  // Observed on 2026-08-06 (008.plan F4.2) — switching from Wallet 1 to Wallet 2 in Backpack
  // mid-session moved the whole app onto an account the user had never signed in with.
  //
  // The rule applied here is not new; it is the one the SIGNING path already enforced at
  // `login-wallet-context.tsx:242-252` (`walletMatchesAccount` → `WalletAccountMismatchError`).
  // The gap was that it only ran at sign time, so everything the user READ in between came
  // from an identity nothing had authorised. A wallet that does not derive to this session's
  // account is a MISMATCH, not a new session; signing out is what changes accounts.
  //
  // Guarded on a non-empty `intentsAccountId`: the context stores `""` when derivation failed
  // (a TON identity with no pubkey — see `login-wallet-context.tsx:259-264`), and comparing
  // against `""` would report a mismatch for every wallet and pin those sessions to the
  // persisted address forever.
  const connection = useMemo<LoginWalletConnection | null>(() => {
    const persisted = ctx.identity
      ? { chainKind: ctx.identity.chainKind, address: ctx.identity.address }
      : null;
    if (ctx.state.status === "connected") {
      const live = ctx.state.connection;
      const belongsToSession =
        ctx.identity === null ||
        ctx.identity.intentsAccountId === "" ||
        walletMatchesAccount(live.address, live.chainKind, ctx.identity.intentsAccountId);
      return belongsToSession ? live : persisted;
    }
    return persisted;
  }, [ctx.state, ctx.identity]);

  // The wallet the extension has active RIGHT NOW, with none of the session-ownership
  // filtering `connection` applies. Anything whose job is to ask "is the correct wallet
  // plugged in?" must read this: `connection` deliberately reports the session's own account
  // when a foreign wallet is connected, so checking it would compare a value against itself
  // and could never fail. Kept separate rather than folded in, because the two questions —
  // "who is this session?" and "what is plugged in?" — stopped having the same answer the
  // moment the app started refusing to switch identity on its own.
  const liveConnection = useMemo<LoginWalletConnection | null>(
    () => (ctx.state.status === "connected" ? ctx.state.connection : null),
    [ctx.state],
  );

  const intentsAccountId = useMemo<string>(() => {
    if (!connection) return "";
    try {
      return deriveIntentsAccountId(connection.address, connection.chainKind);
    } catch {
      return "";
    }
  }, [connection]);

  return {
    status,
    error: ctx.state.error ?? null,
    connection,
    liveConnection,
    intentsAccountId,
    family: ctx.activeFamily,
    lastUsedFamily: ctx.lastUsedFamily,
    selectFamily: ctx.selectFamily,
    connect: ctx.connect,
    disconnect: ctx.disconnect,
    signMessage: ctx.signMessage,
    signOut: ctx.signOut,
    clearError: ctx.clearError,
    keyVerification: ctx.keyVerification,
    verifyKey: ctx.verifyKey,
    registerKey: ctx.registerKey,
    cancelRegistration: ctx.cancelRegistration,
    sendEvmTransaction: ctx.sendEvmTransaction,
  };
}
