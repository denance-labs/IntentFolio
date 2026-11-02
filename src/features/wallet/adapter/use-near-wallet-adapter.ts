"use client";
import { useCallback, useMemo, useState } from "react";
import { useNearWallet } from "near-connect-hooks";
import type { NearContextValue } from "near-connect-hooks";
import { NETWORK } from "../config/network";
import type { NearNetwork } from "../config/network";
import { normalizeWalletError } from "./normalize-error";
import type { WalletAdapter, WalletAdapterState } from "./types";

type LocalState =
  | { kind: "idle" }
  | { kind: "signing-in" }
  | { kind: "error"; message: string };

type LibSnapshot = Pick<NearContextValue, "loading" | "signedAccountId" | "network">;

export function deriveWalletState(lib: LibSnapshot, local: LocalState): WalletAdapterState {
  if (local.kind === "error") {
    return { status: "error", signedAccountId: null, walletNetwork: null, error: local.message };
  }
  if (local.kind === "signing-in") {
    return { status: "signing-in", signedAccountId: null, walletNetwork: null, error: null };
  }
  if (lib.loading) {
    return { status: "initializing", signedAccountId: null, walletNetwork: null, error: null };
  }
  if (lib.signedAccountId) {
    return {
      status: "signed-in",
      signedAccountId: lib.signedAccountId,
      walletNetwork: lib.network as NearNetwork,
      error: null,
    };
  }
  return { status: "signed-out", signedAccountId: null, walletNetwork: null, error: null };
}

export function useNearWalletAdapter(): WalletAdapter {
  const lib = useNearWallet();
  const [local, setLocal] = useState<LocalState>({ kind: "idle" });

  const state = useMemo(
    () => deriveWalletState(lib, local),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lib.loading, lib.signedAccountId, lib.network, local]
  );

  const signIn = useCallback(async () => {
    setLocal({ kind: "signing-in" });
    try {
      await lib.connector.whenManifestLoaded;
      await lib.signIn();
      setLocal({ kind: "idle" });
    } catch (e) {
      const n = normalizeWalletError(e);
      setLocal(n.kind === "cancel" ? { kind: "idle" } : { kind: "error", message: n.message });
    }
  }, [lib]);

  const signOut = useCallback(async () => {
    try {
      await lib.signOut();
      setLocal({ kind: "idle" });
    } catch (e) {
      const n = normalizeWalletError(e);
      setLocal({ kind: "error", message: n.message });
    }
  }, [lib]);

  const clearError = useCallback(() => {
    setLocal({ kind: "idle" });
  }, []);

  return { state, dappNetwork: NETWORK, signIn, signOut, clearError };
}
