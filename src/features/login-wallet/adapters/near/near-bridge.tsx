"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNearWallet } from "near-connect-hooks";
import type { LoginWalletAdapter, LoginWalletState } from "../../types";
import { useRegisterLoginWalletAdapter } from "../../context/login-wallet-context";
import { buildNearSignature } from "./near-sign";
import { normalizeWalletError } from "@/features/wallet/adapter/normalize-error";
import type { Signature } from "@/features/intents-account/mock-contract/types";
import { requiresKeyRegistration } from "../../lib/near-key-registration";
import {
  completeNearKeyVerification,
  recheckNearKeyVerification,
  runNearKeyVerification,
  type NearKeyVerification,
  type NearKeyVerificationOutcome,
  type ProbeSignature,
} from "../../lib/near-key-verification";
import {
  registerNearKey,
  registrationTarget,
  toVerificationState,
} from "../../lib/near-key-register";
import type { Action } from "near-connect-hooks";
import {
  readNearKeyProof,
  writeIdentity,
  writeLastUsedFamily,
  writeNearKeyProof,
  type PersistedNearKeyProof,
} from "../../lib/persistence";
import { deriveIntentsAccountId } from "../../lib/identity";

// Used as the NEP-413 `recipient` field — identifies this dApp to the wallet.
const RECIPIENT = "intentfolio.app";

const LOGIN_VERIFICATION_MESSAGE =
  "Sign in to IntentFolio. This signature verifies wallet ownership and does not authorize transactions.";

function persistVerifiedIdentity(
  outcome: NearKeyVerificationOutcome,
  walletId: string | null,
): void {
  // These three outcomes all passed the signer/account equality check. The chain lookup
  // controls whether money may move, not whether ownership was proven for login persistence.
  if (
    outcome.kind !== "registered" &&
    outcome.kind !== "not-registered" &&
    outcome.kind !== "unknown"
  ) {
    return;
  }
  writeLastUsedFamily("near");
  writeIdentity({
    chainKind: "near",
    address: outcome.accountId,
    intentsAccountId: deriveIntentsAccountId(outcome.accountId, "near"),
  });
  if (walletId && outcome.publicKey) {
    writeNearKeyProof({
      accountId: outcome.accountId,
      walletId,
      publicKey: outcome.publicKey,
    });
  }
}

type ConnectorWalletSnapshot = {
  wallet: { manifest: { id: string } };
  accounts: Array<{ accountId: string; publicKey?: string | null }>;
};

type ConnectorWithSnapshot = {
  getConnectedWallet: () => Promise<ConnectorWalletSnapshot>;
};

type CurrentWallet = { walletId: string; reportedPublicKey: string | null };

async function readCurrentWallet(
  connector: ConnectorWithSnapshot,
  accountId: string,
): Promise<CurrentWallet | null> {
  try {
    const { wallet, accounts } = await connector.getConnectedWallet();
    const own = accounts.find((account) => account.accountId === accountId);
    return {
      walletId: wallet.manifest.id,
      reportedPublicKey: own?.publicKey ?? null,
    };
  } catch {
    return null;
  }
}

async function matchingPersistedProof(
  connector: ConnectorWithSnapshot,
  accountId: string,
): Promise<PersistedNearKeyProof | null> {
  const proof = readNearKeyProof();
  if (!proof || proof.accountId !== accountId) return null;
  const wallet = await readCurrentWallet(connector, accountId);
  if (!wallet || wallet.walletId !== proof.walletId) return null;
  if (wallet.reportedPublicKey && wallet.reportedPublicKey !== proof.publicKey) return null;
  return proof;
}

// D-120: error sentinel set when a NEAR wallet connects on a non-mainnet network.
// The WalletPicker maps it to a localized, actionable message.
export const NEAR_NETWORK_MISMATCH_ERROR = "near-network-mismatch";

type LocalState =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "error"; message: string };

function deriveState(
  lib: { loading: boolean; signedAccountId: string },
  local: LocalState,
): LoginWalletState {
  if (local.kind === "error") {
    return { status: "error", connection: null, error: local.message };
  }
  if (local.kind === "connecting") {
    return { status: "connecting", connection: null, error: null };
  }
  if (lib.signedAccountId && !lib.loading) {
    return {
      status: "connected",
      connection: { chainKind: "near", address: lib.signedAccountId },
      error: null,
    };
  }
  return { status: "idle", connection: null, error: null };
}

/**
 * Headless bridge: reads HOT Connect state, builds a LoginWalletAdapter,
 * and registers it with the neutral LoginWalletContext.
 * Must be rendered inside NearWalletProvider.
 */
export function NearAdapterBridge() {
  const lib = useNearWallet();
  const [local, setLocal] = useState<LocalState>(() => {
    const proof = readNearKeyProof();
    return lib.signedAccountId && proof?.accountId === lib.signedAccountId
      ? { kind: "connecting" }
      : { kind: "idle" };
  });
  const [keyVerification, setKeyVerification] = useState<NearKeyVerification>({
    kind: "unchecked",
  });

  const state = useMemo(
    () => deriveState(lib, local),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lib.loading, lib.signedAccountId, local],
  );

  // D-280 B2. `signNEP413Message` lives on the lib, and the lib object is a fresh identity
  // on every render, so the running verification reads it through a ref instead of closing
  // over it — otherwise `verifyKey` would be a new function on every render and re-register
  // the adapter in a loop.
  const libRef = useRef(lib);
  libRef.current = lib;
  const connectInFlightRef = useRef(false);
  const verifyKey = useCallback(async (): Promise<NearKeyVerification> => {
    const current = libRef.current;
    const accountId = current.signedAccountId;
    // 🔴 `unchecked`, not a throw and not an optimistic pass: B4 calls this from the money
    // door and reads the answer, so every early exit has to return a state that DENIES.
    if (!accountId) return { kind: "unchecked" };
    setKeyVerification({ kind: "checking" });
    const proof = await matchingPersistedProof(current.connector, accountId);
    const outcome = proof
      ? await recheckNearKeyVerification({
          chainKind: "near",
          accountId,
          publicKey: proof.publicKey,
        })
      : await runNearKeyVerification({
          chainKind: "near",
          sessionAccountId: accountId,
          signNep413: (request) => current.signNEP413Message(request),
        });
    // The account can change mid-flight (the user switches accounts in the extension while
    // the prompt is open). Dropping the result is the safe direction: a stale answer
    // attributed to the new account is the same class of lie the proof scoping exists to
    // prevent. The reset effect below has already put the new account back to `unchecked`,
    // and that is what a caller waiting on this must hear too.
    if (libRef.current.signedAccountId !== accountId) return { kind: "unchecked" };

    // D-225/D-252. Persist at the point where the proof exists, not later from an adapter
    // registration snapshot. HOT publishes connection and verification through separate
    // renders in a real Meteor session, so waiting for the context to observe both at once
    // left `intentfolio.identity` null even though the signature succeeded. These three
    // outcomes all passed the signer/account equality check; the chain lookup result controls
    // whether money may move, not whether the login was proven. Never persist a mismatch,
    // decline or failed signature.
    const wallet = await readCurrentWallet(current.connector, accountId);
    persistVerifiedIdentity(outcome, wallet?.walletId ?? null);
    setKeyVerification(outcome);
    return outcome;
  }, []);

  // D-280 B3 — the registration transaction. Read through a ref for the same reason
  // `verifyKey` is: a callback that closes over the state would be a new identity on every
  // render and re-register the adapter in a loop.
  const verificationRef = useRef(keyVerification);
  verificationRef.current = keyVerification;
  /** Lets the user stop WAITING. A sent transaction cannot be recalled. */
  const registerAbortRef = useRef<AbortController | null>(null);

  const registerKey = useCallback(async () => {
    const current = libRef.current;
    // 🔴 The pair comes from the STATE, never from the wallet and never from the account
    // list. `registrationTarget` is also what refuses the states that must not register —
    // `unknown` (the key may be empty), `signer-mismatch` (the pair is known to be wrong)
    // and `register-not-applied` (it would land in the same wrong account).
    const target = registrationTarget(verificationRef.current);
    if (!target) return;
    const { accountId, publicKey } = target;
    // The user can switch accounts in the extension between the render that drew the button
    // and the click. Registering `accountId`'s key while the wallet is on another account is
    // how the pair gets crossed, so refuse rather than adapt.
    if (current.signedAccountId !== accountId) return;

    const controller = new AbortController();
    registerAbortRef.current = controller;
    setKeyVerification({ kind: "registering", accountId, publicKey });

    let result;
    try {
      result = await registerNearKey({
        accountId,
        publicKey,
        signAndSend: (params) =>
          current.signAndSendTransaction({
            receiverId: params.receiverId,
            actions: params.actions as Action[],
          }),
        signal: controller.signal,
      });
    } finally {
      registerAbortRef.current = null;
    }

    // Same staleness rule as `verifyKey`: an answer about an account the session has already
    // left is dropped, not re-attributed. The reset effect has put the new account back to
    // `unchecked` by now.
    if (libRef.current.signedAccountId !== accountId) return;
    setKeyVerification(toVerificationState(result, accountId, publicKey));
  }, []);

  const cancelRegistration = useCallback(() => {
    registerAbortRef.current?.abort();
  }, []);

  // A restored session may reuse the exact PUBLIC tuple that a previous signature proved,
  // but never its registration result. The account and wallet must still match, any public
  // key the connector reports must agree, and `has_public_key` is re-read on every reload.
  // A different wallet or key falls back to `unchecked` and therefore cannot move funds.
  useEffect(() => {
    let stale = false;
    const accountId = lib.signedAccountId;
    if (!accountId) {
      setKeyVerification({ kind: "unchecked" });
      setLocal({ kind: "idle" });
      return;
    }
    if (!requiresKeyRegistration("near", accountId)) {
      setKeyVerification({ kind: "not-required" });
      setLocal({ kind: "idle" });
      return;
    }
    // The fresh connect path owns its combined signature and publishes the outcome itself.
    if (connectInFlightRef.current) return;

    const candidate = readNearKeyProof();
    if (!candidate || candidate.accountId !== accountId) {
      setKeyVerification({ kind: "unchecked" });
      setLocal({ kind: "idle" });
      return;
    }

    setLocal({ kind: "connecting" });
    void (async () => {
      const proof = await matchingPersistedProof(libRef.current.connector, accountId);
      if (stale || libRef.current.signedAccountId !== accountId) return;
      if (!proof) {
        setKeyVerification({ kind: "unchecked" });
        setLocal({ kind: "idle" });
        return;
      }
      const outcome = await recheckNearKeyVerification({
        chainKind: "near",
        accountId,
        publicKey: proof.publicKey,
      });
      if (stale || libRef.current.signedAccountId !== accountId) return;
      setKeyVerification(outcome);
      setLocal({ kind: "idle" });
    })();

    return () => {
      stale = true;
    };
  }, [lib.signedAccountId]);

  // Reject-at-door (D-120): NEAR is the only login family whose wallet is bound to a
  // network. If the connected wallet is not on mainnet, sign out immediately and surface an
  // actionable message — the "connected on the wrong network" state never exists, so no
  // downstream mutation guard is needed. The network is only known post-connect, so this is
  // connect → read → bounce (covers both sign-in and a mid-session network switch).
  useEffect(() => {
    if (local.kind === "error") return;
    if (lib.loading || !lib.signedAccountId) return;
    if (lib.network && lib.network !== "mainnet") {
      void lib.signOut();
      setLocal({ kind: "error", message: NEAR_NETWORK_MISMATCH_ERROR });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lib.loading, lib.signedAccountId, lib.network]);

  const connect = useCallback(async () => {
    connectInFlightRef.current = true;
    setLocal({ kind: "connecting" });
    const current = libRef.current;
    const connector = current.connector;
    let combinedAccount:
      | { accountId: string; signedMessage: ProbeSignature }
      | undefined;
    const onCombinedSignIn = (payload: {
      accounts: Array<{ accountId: string; signedMessage: ProbeSignature }>;
    }) => {
      combinedAccount = payload.accounts[0];
    };
    try {
      await connector.whenManifestLoaded;

      // The wrong-network path must not spend the ownership signature. It is bounced by the
      // existing effect after an ordinary connection, exactly as before.
      if (current.network && current.network !== "mainnet") {
        await current.signIn();
        setLocal({ kind: "idle" });
        return;
      }

      // near-connect's supported authentication path: login + ownership signature in ONE
      // wallet interaction. A standalone `signMessage` after sign-in requires a second user
      // gesture in Meteor; both immediate and delayed automatic attempts opened Connect but
      // never delivered the request to the wallet.
      connector.on("wallet:signInAndSignMessage", onCombinedSignIn);
      const nonce = new Uint8Array(32);
      crypto.getRandomValues(nonce);
      await connector.connect({
        signMessageParams: {
          message: LOGIN_VERIFICATION_MESSAGE,
          recipient: RECIPIENT,
          nonce,
        },
      });

      if (!combinedAccount) {
        throw new Error("Wallet signed in without returning the ownership signature");
      }
      setKeyVerification({ kind: "checking" });
      const outcome = await completeNearKeyVerification({
        chainKind: "near",
        sessionAccountId: combinedAccount.accountId,
        signed: combinedAccount.signedMessage,
      });

      // The hook updates asynchronously from the same event. An empty live account is allowed
      // briefly; a different one invalidates this result rather than re-attributing it.
      const liveAccountId = libRef.current.signedAccountId;
      if (liveAccountId && liveAccountId !== combinedAccount.accountId) {
        setKeyVerification({ kind: "unchecked" });
        setLocal({ kind: "idle" });
        return;
      }
      const wallet = await readCurrentWallet(connector, combinedAccount.accountId);
      persistVerifiedIdentity(outcome, wallet?.walletId ?? null);
      setKeyVerification(outcome);
      setLocal({ kind: "idle" });
    } catch (e) {
      const n = normalizeWalletError(e);
      setLocal(n.kind === "cancel" ? { kind: "idle" } : { kind: "error", message: n.message });
    } finally {
      connectInFlightRef.current = false;
      connector.off("wallet:signInAndSignMessage", onCombinedSignIn);
    }
  }, []);

  const disconnect = useCallback(async () => {
    try {
      await lib.signOut();
    } catch {
      // best-effort disconnect
    }
    setLocal({ kind: "idle" });
  }, [lib]);

  const signMessage = useCallback(
    async (message: string): Promise<Signature> => {
      const nonce = new Uint8Array(32);
      crypto.getRandomValues(nonce);
      const raw = await lib.signNEP413Message({ message, recipient: RECIPIENT, nonce });
      return buildNearSignature(raw, message);
    },
    [lib],
  );

  const clearError = useCallback(() => setLocal({ kind: "idle" }), []);

  const adapter = useMemo<LoginWalletAdapter>(
    () => ({
      chainKind: "near",
      state,
      connect,
      disconnect,
      signMessage,
      clearError,
      // D-545: near-connect-hooks drops `loading` once `getConnectedWallet()` has answered,
      // live account or not.
      restoreSettled: !lib.loading,
      keyVerification,
      verifyKey,
      registerKey,
      cancelRegistration,
    }),
    [state, lib.loading, connect, disconnect, signMessage, clearError, keyVerification, verifyKey, registerKey, cancelRegistration],
  );

  useRegisterLoginWalletAdapter(adapter);

  return null;
}
