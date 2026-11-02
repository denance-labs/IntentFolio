"use client";

import React, {
  createContext,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ChainKind, LoginWalletAdapter, LoginWalletState } from "../types";
import type { IntentsAccountId, Signature } from "@/features/intents-account/mock-contract/types";
import {
  clearIdentity,
  readIdentity,
  readLastUsedFamily,
  writeIdentity,
  writeLastUsedFamily,
  type PersistedIdentity,
} from "../lib/persistence";
import {
  deriveIntentsAccountId,
  walletMatchesAccount,
  WalletAccountMismatchError,
} from "../lib/identity";
import type { NearKeyVerification } from "../lib/near-key-verification";
import { requiresKeyRegistration } from "../lib/near-key-registration";

// ---------------------------------------------------------------------------
// Context shape
// ---------------------------------------------------------------------------

type LoginWalletContextValue = {
  activeFamily: ChainKind | null;
  lastUsedFamily: ChainKind | null;
  state: LoginWalletState;
  identity: PersistedIdentity | null;
  /** False until the post-mount localStorage read completes (D-137). */
  hydrated: boolean;
  /**
   * True once the active family's bridge has registered an adapter; false again on a family
   * switch or sign-out. The app renders before the family chunk lands (D-498), so this is what
   * tells "the wallet code is still loading" apart from "the wallet is not live".
   */
  adapterRegistered: boolean;
  /** The registered adapter's `restoreSettled` (D-545); false when there is none or it cannot tell. */
  restoreSettled: boolean;
  selectFamily: (family: ChainKind, options?: { autoConnect?: boolean }) => void;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  /**
   * Sign `message` with the live wallet. When `expectedAccountId` is given, the connected
   * wallet is asserted to resolve to it before signing (anti-squat pre-check, H8.1c) —
   * throws {@link WalletAccountMismatchError} on a mismatch.
   */
  signMessage: (message: string, expectedAccountId?: IntentsAccountId) => Promise<Signature>;
  signOut: () => Promise<void>;
  clearError: () => void;
  /**
   * D-280 B2 — the active family's key-registration state. `not-required` when the family
   * does not publish one, which is the correct reading: only NEAR named accounts are gated.
   */
  keyVerification: NearKeyVerification;
  /**
   * Triggers the gate on demand (restored session, retry after a decline), and RETURNS what
   * it concluded — B4's money door awaits it inside a single click, before React re-renders.
   */
  verifyKey: () => Promise<NearKeyVerification>;
  /** D-280 B3 — sends the registration for the observed key, then re-reads. No-op off NEAR. */
  registerKey: () => Promise<void>;
  /** Stops waiting on that registration. Cannot recall a transaction already sent. */
  cancelRegistration: () => void;
  /**
   * D-445 part 2 — the active adapter's EVM send, or null when it has none (every family but
   * EVM, and EVM before its bridge mounts). Null is the answer the deposit tab gates on.
   */
  sendEvmTransaction: LoginWalletAdapter["sendEvmTransaction"] | null;
  /** Called by each FamilyAdapterBridge to register/deregister itself. */
  registerAdapter: (adapter: LoginWalletAdapter | null) => void;
};

// Exported only so the QA-only MockLoginWalletProvider (mock/) can supply a deterministic
// value to the /mock-dashboard subtree. Prod code must use the hooks, never this directly.
export const LoginWalletContext = createContext<LoginWalletContextValue | null>(null);
export type { LoginWalletContextValue };

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

type FamilyModule = {
  FamilyProvider: React.ComponentType<{ children: React.ReactNode }>;
  FamilyAdapterBridge: React.ComponentType<Record<string, never>>;
};

// Registry of lazy loaders per family — filled in as adapters are implemented (3.2–3.7).
// Each entry is a function that dynamically imports the family's Provider + Bridge.
const familyLoaders: Partial<Record<ChainKind, () => Promise<FamilyModule>>> = {};

// React.lazy must be called outside any render function — calling it inside creates a new
// component reference on every render, which causes React to unmount+remount on every re-render
// (unmount triggers registerAdapter(null), mount triggers registerAdapter(adapter), looping).
const lazyModuleCache = new Map<ChainKind, React.LazyExoticComponent<React.ComponentType>>();

/** Register a family's lazy loader. Called by each adapter module (3.2–3.7). */
export function registerFamilyLoader(
  family: ChainKind,
  loader: () => Promise<FamilyModule>,
): void {
  familyLoaders[family] = loader;
}

/**
 * Mounts the active family's provider and headless bridge — and nothing else.
 *
 * 🔴 It does NOT wrap the app (D-498). It used to take `{children}`, so restoring a session
 * moved the whole tree from the provider's root into this `<Suspense>`: React unmounted and
 * remounted every page, and the boundary showed `null` until it settled — ~300 ms of blank
 * screen on every signed-in load, measured in Production. Nothing outside `adapters/` reads a
 * family's context (wagmi, TonConnect, solana-wallet-adapter): each bridge reads it and
 * publishes a neutral `LoginWalletAdapter` through `registerAdapter`, and their modals portal
 * out on their own. So the bridge can sit beside the app instead of around it.
 */
function LazyFamilyMount({ family }: { family: ChainKind }) {
  const loader = familyLoaders[family];
  if (!loader) {
    // Family not yet implemented — no bridge to mount.
    return null;
  }
  if (!lazyModuleCache.has(family)) {
    lazyModuleCache.set(
      family,
      React.lazy(async () => {
        const mod = await loader();
        const { FamilyProvider, FamilyAdapterBridge } = mod;
        return {
          default: () => (
            <FamilyProvider>
              <FamilyAdapterBridge />
            </FamilyProvider>
          ),
        };
      }),
    );
  }
  const LazyModule = lazyModuleCache.get(family)!;
  return <LazyModule />;
}

const idle: LoginWalletState = { status: "idle", connection: null, error: null };

/**
 * What the gate answers when no adapter PUBLISHES one — for BOTH `keyVerification` and
 * `verifyKey`, which must never disagree (D-284).
 *
 * 🔴 "No gate published" is wider than "no adapter registered", and the difference is
 * reachable. `keyVerification` and `verifyKey` are both optional on `LoginWalletAdapter`, and
 * all five non-NEAR bridges omit them — so this also runs with an adapter fully registered.
 * Combined with `identity` surviving a family switch (only `signMessage` and `signOut` rewrite
 * it), a NEAR named identity left behind while an EVM adapter is active answers `unchecked`
 * forever: the four doors deny, and the notice offers a "Verify" button that cannot resolve
 * because there is no gate to run. That soft-lock is filed as its own decision, not fixed
 * here; the direction is still the safe one (before D-284 that same state answered
 * `not-required` and let the user sign an EVM envelope carrying a NEAR `signer_id`).
 *
 * 🔴 It used to be a flat `not-required`, which made absence of information equal permission
 * on the money path: `not-required` is in `MAY_OPERATE`, so `ensureCanOperate` returned
 * without running `verify()` at all. And a null adapter does not mean there is no live path —
 * `useLoginWallet.connection` falls back to the PERSISTED identity, so `intentsAccountId`,
 * `family: "near"` and the live signer stay non-null and a NEAR named account could sign.
 * This window is REACHABLE now: since D-498 the app renders beside the lazy family mount, not
 * inside its `<Suspense>`, so a restored session shows the app before the family chunk lands
 * and its bridge registers. Before that it was unreachable only by accident (the whole app
 * rendered `null` until the chunk landed), which is why this function has to be right.
 *
 * 🔴 The source is `identity`, not `activeFamily`: for NEAR the `intentsAccountId` IS the
 * accountId as-is (`lib/identity.ts`), and the persisted identity is exactly what the
 * connection falls back to, so it is what would sign the envelope.
 *
 * 🔴 Still NOT blanket fail-closed. Answering `unchecked` unconditionally would deny every
 * EVM, Solana, TON, Stellar and Tron user a withdrawal — the same fail-closed mistake in a
 * place where it is total. `requiresKeyRegistration` is false for those five families and for
 * NEAR implicit accounts, whose id the contract can authenticate on its own.
 *
 * 🔴 `identity === null` stays `not-required` on purpose: there is no account to gate, and
 * `unchecked` paints a registration banner that a fresh pre-hydration visitor would see — and
 * that visitor's `children` render with no family mounted at all.
 */
function keyVerificationWithoutGate(identity: PersistedIdentity | null): NearKeyVerification {
  if (identity && requiresKeyRegistration(identity.chainKind, identity.intentsAccountId)) {
    return { kind: "unchecked" };
  }
  return { kind: "not-required" };
}

export function LoginWalletProvider({ children }: { children: React.ReactNode }) {
  // Persisted session is read AFTER mount (not in the useState initializers) so
  // the first client render matches the server, which has no localStorage. Reading
  // it synchronously caused a hydration mismatch + a flash of the Sign In screen on
  // every refresh for signed-in users (D-137). `hydrated` gates the derived status.
  const [activeFamily, setActiveFamily] = useState<ChainKind | null>(null);
  const [lastUsedFamily, setLastUsedFamily] = useState<ChainKind | null>(null);
  const [identity, setIdentity] = useState<PersistedIdentity | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [adapterRegistered, setAdapterRegistered] = useState(false);

  useEffect(() => {
    const fam = readLastUsedFamily();
    const id = readIdentity();
    // `fam && id`, not `fam` alone: the family key survives sign-out on purpose (it drives
    // the "Recent" badge), so it is no longer evidence that a session exists. Mounting the
    // adapter without one would let an SDK connection that outlived our `disconnect()` —
    // which is fired with `.catch(() => undefined)` — report `connected` and sign the user
    // back in right after they signed out. `lastUsedFamily` is set either way.
    if (fam && id) setActiveFamily(fam);
    setLastUsedFamily(fam);
    if (id) setIdentity(id);
    setHydrated(true);
  }, []);

  const adapterRef = useRef<LoginWalletAdapter | null>(null);
  // When true, the next adapter registration triggers connect() automatically (D-130 lazy-mount + WalletPicker UX).
  const pendingConnectRef = useRef(false);
  // Tracks the last state content we rendered from — survives the null cleanup so
  // the subsequent non-null registration can compare against the real previous state.
  const lastKnownStateRef = useRef<LoginWalletState>(idle);
  // Tracked alongside the state for the same reason and with the same lifetime: it is
  // adapter content the UI renders, so a change in it has to reach React. Kept as its own
  // ref rather than folded into `lastKnownStateRef` because it is not part of
  // `LoginWalletState` — the gate is one family's concern, not the neutral session shape.
  const lastKnownVerificationRef = useRef<NearKeyVerification | undefined>(undefined);
  // Same again for D-545: a restore that settles while the state stays `idle` changes nothing
  // the comparison above sees, and the session would wait out the clock regardless.
  const lastKnownRestoreSettledRef = useRef<boolean | undefined>(undefined);
  // The persisted identity, readable from the stable callbacks below (D-284). Same pattern
  // and same reason as the two refs above: `verifyKey` is deliberately `useCallback(…, [])`
  // so it never re-registers the adapter, so it cannot capture `identity`.
  //
  // 🔴 Assigned DURING RENDER, not in an effect, and the difference is observable. A child's
  // passive effects run BEFORE its parent's, so with the sync in a provider effect the very
  // commit that first publishes `unchecked` still had `identityRef.current === null` — the
  // rendered `keyVerification` said `unchecked` while `verifyKey()` answered `not-required`.
  // `ensureCanOperate` then takes the `unchecked` branch, awaits `verify()`, is told
  // `not-required`, and throws `NearKeyJustVerifiedError` even though nothing was verified.
  // That false claim is the same absence-reads-as-permission shape D-284 exists to remove.
  // Render assignment is also the established pattern here (`near-bridge.tsx` does it), and
  // the "discarded render" hazard that would argue for an effect does not apply: `identity`
  // is React state, so every render already holds a committed value, and this repo uses no
  // concurrent APIs (no `startTransition`, no `useDeferredValue`).
  const identityRef = useRef<PersistedIdentity | null>(null);
  identityRef.current = identity;
  // Bumped only when state content changes; forces LoginWalletProvider to re-render
  // and re-derive `state` from adapterRef (a plain ref mutation does not trigger a render).
  const [adapterTick, setAdapterTick] = useState(0);

  const registerAdapter = useCallback((adapter: LoginWalletAdapter | null) => {
    if (adapter === null) {
      // Cleanup path: just clear the ref. Never fire a tick here — the cleanup
      // always runs immediately before the replacement adapter registers, so
      // firing a tick would produce a spurious idle flash and risk an update loop.
      adapterRef.current = null;
      return;
    }
    const prev = lastKnownStateRef.current;
    const prevVerification = lastKnownVerificationRef.current;
    const prevRestoreSettled = lastKnownRestoreSettledRef.current;
    adapterRef.current = adapter;
    // Idempotent: React bails out of a same-value update, so re-registrations cost nothing.
    setAdapterRegistered(true);
    const next = adapter.state;
    lastKnownStateRef.current = next;
    lastKnownVerificationRef.current = adapter.keyVerification;
    lastKnownRestoreSettledRef.current = adapter.restoreSettled;

    // Only re-render when the state content actually changed.
    //
    // The verification is compared here and not only in the bridge: without it, a gate that
    // moves from `unchecked` to `not-registered` mutates a ref and never reaches React, so
    // the tester sits on a stale banner while the app has already decided they are blocked.
    // Compared by `kind` alone on purpose — the payload fields (account, key) cannot change
    // without the kind changing too, since every account change resets the state first.
    if (
      prev.status !== next.status ||
      prev.error !== next.error ||
      prev.connection?.address !== next.connection?.address ||
      prevVerification?.kind !== adapter.keyVerification?.kind ||
      prevRestoreSettled !== adapter.restoreSettled
    ) {
      setAdapterTick((n) => n + 1);
    }
    if (pendingConnectRef.current) {
      pendingConnectRef.current = false;
      adapter.connect().catch(() => undefined);
    }
  }, []);

  const selectFamily = useCallback(
    (family: ChainKind, options?: { autoConnect?: boolean }) => {
      if (family === activeFamily) {
        // Family already mounted — connect directly if requested.
        if (options?.autoConnect && adapterRef.current) {
          adapterRef.current.connect().catch(() => undefined);
        }
        return;
      }
      // Disconnect the previous family's adapter before switching (D-130).
      adapterRef.current?.disconnect().catch(() => undefined);
      adapterRef.current = null;
      setAdapterRegistered(false);
      pendingConnectRef.current = options?.autoConnect ?? false;
      writeLastUsedFamily(family);
      setActiveFamily(family);
      // Keep the in-memory copy in step with storage. Without this the "Recent" badge is
      // frozen at whatever the mount effect read, so switching family mid-session leaves
      // the picker pointing at the PREVIOUS session's wallet until the next reload.
      setLastUsedFamily(family);
    },
    [activeFamily],
  );

  const getAdapter = (): LoginWalletAdapter => {
    if (!adapterRef.current) throw new Error("No wallet family active");
    return adapterRef.current;
  };

  const connect = useCallback(async () => {
    const adapter = getAdapter();
    await adapter.connect();
  }, []);

  const disconnect = useCallback(async () => {
    adapterRef.current?.disconnect().catch(() => undefined);
  }, []);

  const signMessage = useCallback(async (message: string, expectedAccountId?: IntentsAccountId): Promise<Signature> => {
    let adapter = getAdapter();
    // If identity is restored but wallet is not live, re-prompt connect first (D-131).
    if (adapter.state.status !== "connected") {
      await adapter.connect();
      // connect() re-renders the active bridge, which re-registers a *fresh* adapter via
      // an effect (post-render, async). The adapter captured before connect still has
      // stale closures (empty address/publicKey) and would fail its own "not connected"
      // precheck. Wait a few frames for the freshly-registered connected adapter, then
      // re-read it; fall back to whatever is current so signing proceeds rather than
      // hangs if connect resolved without reaching "connected" (5.5).
      for (let i = 0; i < 10 && adapterRef.current?.state.status !== "connected"; i++) {
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
      adapter = getAdapter();
    }
    // Anti-squat pre-check (H8.1c): the live wallet about to sign MUST resolve to the
    // account this operation is recorded under. Guards the restored-identity(A) vs
    // live-wallet(B) seam — the id in scope comes from persisted identity, but connect()
    // above could have brought up a different wallet. Signing a setup/commit for A with
    // B's key is exactly what the contract rejects (E_ACCOUNT_ID_MISMATCH at apply_setup,
    // allocate.rs:154; assert_signer_bound for the CC-004 binding). Fail fast here rather
    // than emit a signature the contract will bounce. Only enforced once the wallet is
    // live — a failed connect surfaces via adapter.signMessage's own precheck below.
    if (expectedAccountId && adapter.state.status === "connected") {
      const { chainKind, address } = adapter.state.connection;
      if (!walletMatchesAccount(address, chainKind, expectedAccountId)) {
        let connectedAccountId = "unknown";
        try {
          connectedAccountId = deriveIntentsAccountId(address, chainKind);
        } catch {
          // derivation failed (e.g. TON without a pubkey) → keep the "unknown" placeholder
        }
        // Addresses, not just derived ids: they are what the extension and the account chip
        // show, so they are the only form of this sentence the user can act on. The session
        // address comes from persisted identity — the same place `expectedAccountId` was
        // derived from — and is omitted rather than guessed if it is not there.
        const sessionAddress = readIdentity()?.address;
        throw new WalletAccountMismatchError(
          expectedAccountId,
          connectedAccountId,
          sessionAddress
            ? { expectedAddress: sessionAddress, connectedAddress: address }
            : undefined,
        );
      }
    }
    const sig = await adapter.signMessage(message);
    // Persist identity after a successful sign if connection is now known.
    const currentState = adapter.state;
    if (currentState.status === "connected") {
      const { chainKind, address } = currentState.connection;
      let intentsAccountId = "" as import("@/features/intents-account/mock-contract/types").IntentsAccountId;
      try {
        intentsAccountId = deriveIntentsAccountId(address, chainKind);
      } catch {
        // safe fallback: address format mismatch (e.g. TON without publicKey)
      }
      const newIdentity: PersistedIdentity = { chainKind, address, intentsAccountId };
      writeIdentity(newIdentity);
      setIdentity(newIdentity);
    }
    return sig;
  }, []);

  const signOut = useCallback(async () => {
    adapterRef.current?.disconnect().catch(() => undefined);
    adapterRef.current = null;
    setAdapterRegistered(false);
    clearIdentity();
    setIdentity(null);
    setActiveFamily(null);
  }, []);

  const clearError = useCallback(() => {
    adapterRef.current?.clearError();
  }, []);

  // Resolved through the ref rather than captured, so it is stable and never re-registers
  // the adapter. A family that does not publish `verifyKey` has no gate to run, so this
  // resolves rather than throwing: callers should not need to know which family is active.
  //
  // 🔴 The absent-gate case does not answer a flat `not-required` any more (D-284): it asks
  // `keyVerificationWithoutGate` about the persisted identity, so a NEAR named account
  // whose adapter has not registered yet gets `unchecked` — which `ensureCanOperate` turns
  // into a real verification and, failing that, a denial — while the five non-NEAR families
  // and NEAR implicit accounts keep passing. Answering `unchecked` for all of them would deny
  // every EVM, Solana, TON, Stellar and Tron user the moment B4's money door awaited this.
  const verifyKey = useCallback(async (): Promise<NearKeyVerification> => {
    const run = adapterRef.current?.verifyKey;
    if (!run) return keyVerificationWithoutGate(identityRef.current);
    return run();
  }, []);

  // Same shape and same reason as `verifyKey`: resolved through the ref so it is stable, and
  // a no-op rather than a throw for the five families that publish no gate.
  const registerKey = useCallback(async () => {
    await adapterRef.current?.registerKey?.();
  }, []);

  const cancelRegistration = useCallback(() => {
    adapterRef.current?.cancelRegistration?.();
  }, []);

  // Derive the current state from the active adapter; fall back to idle.
  // Note: this is intentionally NOT reactive to adapter.state changes — each
  // FamilyAdapterBridge is responsible for calling registerAdapter when its
  // state changes, so the context re-renders when a new adapter is registered.
  const state: LoginWalletState = adapterRef.current?.state ?? idle;

  // D-546 — a connection the user asked for is a session, signed or not. EVM, Solana, Stellar,
  // TON and Tron connect without a signature, so before this the identity was only written by
  // the first `signMessage`, and reloading before one put the user back at "Connect wallet"
  // (the mount guard below found no identity and never remounted the family).
  //
  // 🔴 This does not reopen the sign-out hole the mount guard closes: after `signOut`,
  // `activeFamily` is null, so no bridge is mounted and no `connected` can reach this effect
  // until the user picks a family in the picker again — which is the request this persists.
  //
  // Never overwrites an identity (a foreign live wallet stays a mismatch, not a new session),
  // skips NEAR (it persists only with its ownership proof, D-225/D-252), and skips a wallet
  // whose account cannot be derived (TON without a pubkey) rather than storing `""`.
  const liveChainKind = state.status === "connected" ? state.connection.chainKind : null;
  const liveAddress = state.status === "connected" ? state.connection.address : null;
  useEffect(() => {
    if (identity !== null || !liveChainKind || !liveAddress) return;
    if (activeFamily === null || activeFamily === "near" || liveChainKind !== activeFamily) return;
    let intentsAccountId: IntentsAccountId;
    try {
      intentsAccountId = deriveIntentsAccountId(liveAddress, liveChainKind);
    } catch {
      return;
    }
    const newIdentity: PersistedIdentity = { chainKind: liveChainKind, address: liveAddress, intentsAccountId };
    writeIdentity(newIdentity);
    setIdentity(newIdentity);
  }, [identity, activeFamily, liveChainKind, liveAddress]);
  // `undefined` means the active family publishes no gate — for the five non-NEAR families
  // that is a real answer (`not-required`) and not a missing one, and reading it as "not
  // verified yet" would put a registration banner in front of every EVM and Solana user.
  // 🔴 But for a NEAR named account it IS a missing one, so the default is derived from the
  // identity instead of assumed — same function as `verifyKey` above so the published state
  // and the awaited answer cannot diverge (D-284).
  const keyVerification: NearKeyVerification =
    adapterRef.current?.keyVerification ?? keyVerificationWithoutGate(identity);

  const value = useMemo<LoginWalletContextValue>(
    () => ({
      activeFamily,
      lastUsedFamily,
      state,
      identity,
      hydrated,
      adapterRegistered,
      restoreSettled: adapterRef.current?.restoreSettled ?? false,
      selectFamily,
      connect,
      disconnect,
      signMessage,
      signOut,
      clearError,
      keyVerification,
      verifyKey,
      registerKey,
      cancelRegistration,
      // Read off the adapter like `state`: it re-registers on every change, and `adapterTick`
      // below recomputes this value when it does.
      sendEvmTransaction: adapterRef.current?.sendEvmTransaction ?? null,
      registerAdapter,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeFamily, lastUsedFamily, state, identity, hydrated, adapterRegistered, adapterTick, selectFamily, connect, disconnect, signMessage, signOut, clearError, keyVerification.kind, verifyKey, registerKey, cancelRegistration, registerAdapter],
  );

  // `{children}` keeps the same position whether or not a family is active, so restoring a
  // session, signing in, switching family or signing out never remounts the app (D-498).
  return (
    <LoginWalletContext.Provider value={value}>
      {activeFamily && (
        <Suspense fallback={null}>
          <LazyFamilyMount family={activeFamily} />
        </Suspense>
      )}
      {children}
    </LoginWalletContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function useLoginWalletContext(): LoginWalletContextValue {
  const ctx = useContext(LoginWalletContext);
  if (!ctx) throw new Error("useLoginWalletContext must be used inside LoginWalletProvider");
  return ctx;
}

/**
 * Called by each FamilyAdapterBridge inside its useEffect to register/deregister
 * the concrete adapter with the neutral context.
 */
export function useRegisterLoginWalletAdapter(adapter: LoginWalletAdapter | null): void {
  const { registerAdapter } = useLoginWalletContext();
  React.useEffect(() => {
    registerAdapter(adapter);
    return () => registerAdapter(null);
  }, [adapter, registerAdapter]);
}
