// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import React from "react";
import {
  LoginWalletProvider,
  registerFamilyLoader,
  useLoginWalletContext,
  useRegisterLoginWalletAdapter,
} from "./login-wallet-context";
import {
  canOperate,
  ensureCanOperate,
  NearKeyNotVerifiedError,
} from "../lib/near-key-verification";
import type { ChainKind, LoginWalletAdapter, LoginWalletState } from "../types";
import type { Signature } from "@/features/intents-account/mock-contract/types";

// ---------------------------------------------------------------------------
// MockBridge helper — creates a controllable LoginWalletAdapter
// ---------------------------------------------------------------------------

function makeMockAdapter(overrides?: Partial<LoginWalletAdapter>): LoginWalletAdapter {
  const dummySig: Signature = {
    scheme: "nep413",
    payload: "hello",
    signature: "sig123",
    publicKey: "ed25519:abc",
  };
  return {
    chainKind: "near",
    state: { status: "idle", connection: null, error: null },
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    signMessage: vi.fn().mockResolvedValue(dummySig),
    clearError: vi.fn(),
    ...overrides,
  };
}

function MockBridge({ adapter }: { adapter: LoginWalletAdapter }) {
  useRegisterLoginWalletAdapter(adapter);
  return null;
}

function wrapper({ children }: { children: React.ReactNode }) {
  return <LoginWalletProvider>{children}</LoginWalletProvider>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LoginWalletContext", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("starts with idle state and no active family", () => {
    const { result } = renderHook(() => useLoginWalletContext(), { wrapper });
    expect(result.current.activeFamily).toBeNull();
    expect(result.current.state.status).toBe("idle");
    expect(result.current.identity).toBeNull();
    expect(result.current.hydrated).toBe(true);
  });

  it("reads persisted identity after mount, not in the initializer (D-137)", () => {
    localStorage.setItem("intentfolio.lastUsedWalletFamily", "near");
    localStorage.setItem(
      "intentfolio.identity",
      JSON.stringify({ chainKind: "near", address: "alice.near", intentsAccountId: "alice.near" }),
    );
    const { result } = renderHook(() => useLoginWalletContext(), { wrapper });
    // After the post-mount effect (run inside renderHook's act), the session is restored.
    expect(result.current.hydrated).toBe(true);
    expect(result.current.activeFamily).toBe("near");
    expect(result.current.identity?.address).toBe("alice.near");
  });

  it("selectFamily updates activeFamily and persists to localStorage", () => {
    const { result } = renderHook(() => useLoginWalletContext(), { wrapper });
    act(() => {
      result.current.selectFamily("evm");
    });
    expect(result.current.activeFamily).toBe("evm");
    expect(localStorage.getItem("intentfolio.lastUsedWalletFamily")).toBe("evm");
  });

  it("selectFamily switches family and disconnects previous adapter", async () => {
    const adapter = makeMockAdapter();
    function FullWrapper({ children }: { children: React.ReactNode }) {
      return (
        <LoginWalletProvider>
          <MockBridge adapter={adapter} />
          {children}
        </LoginWalletProvider>
      );
    }
    const { result } = renderHook(() => useLoginWalletContext(), { wrapper: FullWrapper });

    await act(async () => {
      result.current.selectFamily("near");
    });
    await act(async () => {
      result.current.selectFamily("evm");
    });

    expect(adapter.disconnect).toHaveBeenCalled();
    expect(result.current.activeFamily).toBe("evm");
  });

  it("signMessage delegates to registered adapter", async () => {
    const connectedState: LoginWalletState = {
      status: "connected",
      connection: { chainKind: "near", address: "alice.near" },
      error: null,
    };
    const adapter = makeMockAdapter({ state: connectedState });

    function FullWrapper({ children }: { children: React.ReactNode }) {
      return (
        <LoginWalletProvider>
          <MockBridge adapter={adapter} />
          {children}
        </LoginWalletProvider>
      );
    }
    const { result } = renderHook(() => useLoginWalletContext(), { wrapper: FullWrapper });

    let sig: Signature | undefined;
    await act(async () => {
      sig = await result.current.signMessage("test message");
    });

    expect(adapter.signMessage).toHaveBeenCalledWith("test message");
    expect(sig?.scheme).toBe("nep413");
  });

  it("signMessage calls connect() first when adapter is not connected (D-131)", async () => {
    const adapter = makeMockAdapter({
      state: { status: "idle", connection: null, error: null },
    });
    function FullWrapper({ children }: { children: React.ReactNode }) {
      return (
        <LoginWalletProvider>
          <MockBridge adapter={adapter} />
          {children}
        </LoginWalletProvider>
      );
    }
    const { result } = renderHook(() => useLoginWalletContext(), { wrapper: FullWrapper });

    await act(async () => {
      await result.current.signMessage("test");
    });

    expect(adapter.connect).toHaveBeenCalled();
    expect(adapter.signMessage).toHaveBeenCalled();
  });

  it("signs with the freshly-registered adapter after reconnect, not the stale one (5.5)", async () => {
    // Real bridges re-register a fresh adapter (live closures) after connect() via an
    // effect; here connect() re-registers it imperatively to model the same swap without
    // depending on effect-flush timing. The pre-fix code signed with the captured stale
    // adapter; the fix re-reads getAdapter() after connect so the fresh one signs.
    const freshSig: Signature = {
      scheme: "nep413",
      payload: "test",
      signature: "fresh-sig",
      publicKey: "ed25519:fresh",
    };
    const staleSign = vi.fn().mockRejectedValue(new Error("Wallet not connected"));
    const freshSign = vi.fn().mockResolvedValue(freshSig);

    const { result } = renderHook(() => useLoginWalletContext(), { wrapper });

    const freshAdapter = makeMockAdapter({
      state: { status: "connected", connection: { chainKind: "near", address: "alice.near" }, error: null },
      signMessage: freshSign,
    });
    const staleAdapter = makeMockAdapter({
      state: { status: "idle", connection: null, error: null },
      signMessage: staleSign,
      connect: vi.fn().mockImplementation(async () => {
        result.current.registerAdapter(freshAdapter);
      }),
    });

    act(() => {
      result.current.registerAdapter(staleAdapter);
    });

    let sig: Signature | undefined;
    await act(async () => {
      sig = await result.current.signMessage("test");
    });

    expect(staleAdapter.connect).toHaveBeenCalled();
    expect(staleSign).not.toHaveBeenCalled();
    expect(freshSign).toHaveBeenCalledWith("test");
    expect(sig?.signature).toBe("fresh-sig");
  });

  it("signOut clears identity, adapter, and activeFamily", async () => {
    localStorage.setItem("intentfolio.lastUsedWalletFamily", "near");
    localStorage.setItem(
      "intentfolio.identity",
      JSON.stringify({ chainKind: "near", address: "alice.near", intentsAccountId: "id123" }),
    );

    const adapter = makeMockAdapter();
    function FullWrapper({ children }: { children: React.ReactNode }) {
      return (
        <LoginWalletProvider>
          <MockBridge adapter={adapter} />
          {children}
        </LoginWalletProvider>
      );
    }
    const { result } = renderHook(() => useLoginWalletContext(), { wrapper: FullWrapper });

    await act(async () => {
      await result.current.signOut();
    });

    expect(result.current.activeFamily).toBeNull();
    expect(result.current.identity).toBeNull();
    expect(localStorage.getItem("intentfolio.identity")).toBeNull();
    // The family key SURVIVES sign-out: it drives the picker's "Recent" badge, and a
    // returning user should still be offered the wallet they used last.
    expect(localStorage.getItem("intentfolio.lastUsedWalletFamily")).toBe("near");
    expect(result.current.lastUsedFamily).toBe("near");
  });

  it("selectFamily updates lastUsedFamily in state, not only in storage", () => {
    // Previous session ended on EVM; this session switches to NEAR.
    localStorage.setItem("intentfolio.lastUsedWalletFamily", "evm");
    const { result } = renderHook(() => useLoginWalletContext(), { wrapper });
    expect(result.current.lastUsedFamily).toBe("evm");

    act(() => {
      result.current.selectFamily("near");
    });

    // Without setLastUsedFamily in selectFamily this stays "evm", and the picker keeps
    // badging the PREVIOUS session's wallet as "Recent" until the next reload.
    expect(result.current.lastUsedFamily).toBe("near");
  });

  it("does not restore activeFamily when the family outlived a sign-out (no identity)", () => {
    // Exactly the post-sign-out reload: family key present, identity gone.
    localStorage.setItem("intentfolio.lastUsedWalletFamily", "evm");

    const { result } = renderHook(() => useLoginWalletContext(), { wrapper });

    // The badge still knows the wallet...
    expect(result.current.lastUsedFamily).toBe("evm");
    // ...but no adapter is mounted, so an SDK connection that outlived disconnect()
    // cannot report `connected` and sign the user back in.
    expect(result.current.activeFamily).toBeNull();
    expect(result.current.identity).toBeNull();
  });

  it("throws when used outside LoginWalletProvider", () => {
    expect(() => renderHook(() => useLoginWalletContext())).toThrow(
      "useLoginWalletContext must be used inside LoginWalletProvider",
    );
  });
});

// ---------------------------------------------------------------------------
// D-498 — the app is never remounted, nor hidden, by the family's lazy mount
// ---------------------------------------------------------------------------

describe("LoginWalletContext keeps the app mounted (D-498)", () => {
  // A family chunk that never lands: the worst case of the lazy mount's `<Suspense>`. The
  // registry is module-wide, so the D-284 tron case below also mounts it; that is harmless now
  // (the pending chunk only keeps tron's own bridge from registering) and is exactly what used
  // to hang that test with the app inside the boundary.
  registerFamilyLoader("tron", () => new Promise<never>(() => {}));

  let mounts = 0;
  let unmounts = 0;
  function App() {
    React.useEffect(() => {
      mounts++;
      return () => {
        unmounts++;
      };
    }, []);
    const { activeFamily, selectFamily, signOut } = useLoginWalletContext();
    return (
      <>
        <p>app · {activeFamily ?? "none"}</p>
        <button onClick={() => selectFamily("tron")}>pick</button>
        <button onClick={() => void signOut()}>out</button>
      </>
    );
  }

  beforeEach(() => {
    cleanup();
    localStorage.clear();
    mounts = 0;
    unmounts = 0;
  });

  it("restoring a session neither remounts nor hides the app while the family loads", () => {
    localStorage.setItem("intentfolio.lastUsedWalletFamily", "tron");
    localStorage.setItem(
      "intentfolio.identity",
      JSON.stringify({ chainKind: "tron", address: "TXYZ", intentsAccountId: "txyz" }),
    );
    const { getByText } = render(
      <LoginWalletProvider>
        <App />
      </LoginWalletProvider>,
    );
    expect(getByText("app · tron")).toBeTruthy();
    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);
  });

  it("reports `adapterRegistered` only between a bridge registering and the next sign-out", async () => {
    const adapter = makeMockAdapter();
    function FullWrapper({ children }: { children: React.ReactNode }) {
      return (
        <LoginWalletProvider>
          <MockBridge adapter={adapter} />
          {children}
        </LoginWalletProvider>
      );
    }
    const { result } = renderHook(() => useLoginWalletContext(), { wrapper: FullWrapper });
    expect(result.current.adapterRegistered).toBe(true);
    await act(async () => {
      await result.current.signOut();
    });
    expect(result.current.adapterRegistered).toBe(false);
  });

  it("is not registered while the family's chunk is still loading", () => {
    localStorage.setItem("intentfolio.lastUsedWalletFamily", "tron");
    localStorage.setItem(
      "intentfolio.identity",
      JSON.stringify({ chainKind: "tron", address: "TXYZ", intentsAccountId: "txyz" }),
    );
    const { result } = renderHook(() => useLoginWalletContext(), { wrapper });
    expect(result.current.activeFamily).toBe("tron");
    expect(result.current.adapterRegistered).toBe(false);
  });

  it("signing in and out keeps the same app instance", async () => {
    const { getByText } = render(
      <LoginWalletProvider>
        <App />
      </LoginWalletProvider>,
    );
    await act(async () => getByText("pick").click());
    expect(getByText("app · tron")).toBeTruthy();
    await act(async () => getByText("out").click());
    expect(getByText("app · none")).toBeTruthy();
    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// D-280 B4 — what `verifyKey` answers for a family that has no gate
// ---------------------------------------------------------------------------

describe("LoginWalletContext verifyKey fallback (D-280 B4)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("answers `not-required` when the active family publishes no gate", async () => {
    // 🔴 The direction matters and it is the opposite of the usual fail-closed instinct.
    // Only the NEAR family implements `verifyKey`; the other five derive their intents id
    // from the address, so `intents.near` authenticates them alone. B4's money door awaits
    // this whenever the state is `unchecked` — answering `unchecked` here would deny every
    // EVM, Solana, TON, Stellar and Tron user a withdrawal, which is the same fail-closed
    // mistake in a place where it is total.
    const { result } = renderHook(() => useLoginWalletContext(), { wrapper });
    await act(async () => {
      await expect(result.current.verifyKey()).resolves.toEqual({ kind: "not-required" });
    });
  });

  // -------------------------------------------------------------------------
  // D-284 — with no adapter, the answer comes from the PERSISTED identity
  // -------------------------------------------------------------------------

  /**
   * Persists a signed-in session the way `readIdentity` will find it on the next mount.
   *
   * 🔴 `chainKind` is typed `ChainKind`, not `string`, on purpose: with `string` a typo'd
   * family silently persists a record the provider then judges as "not NEAR" — and since a
   * missing identity ALSO answers `not-required`, the pass-direction tests below would stay
   * green while proving nothing. Every one of them asserts `result.current.identity` too, so
   * the record is shown to have been loaded before its verdict is read.
   *
   * `options.omitFamily` reproduces the reachable split where the identity record survives but
   * the family key does not — `clearIdentity()` deliberately leaves the family key behind, so
   * the two localStorage keys are independent.
   */
  function persistIdentity(
    chainKind: ChainKind,
    address: string,
    intentsAccountId: string,
    options?: { omitFamily?: boolean },
  ) {
    if (!options?.omitFamily) {
      localStorage.setItem("intentfolio.lastUsedWalletFamily", chainKind);
    }
    localStorage.setItem(
      "intentfolio.identity",
      JSON.stringify({ chainKind, address, intentsAccountId }),
    );
  }

  it("answers `unchecked` for a persisted NEAR named account with no adapter (D-284)", async () => {
    // 🔴 The pre-fix code answered `not-required` here, which is in `MAY_OPERATE`, so
    // `ensureCanOperate` returned WITHOUT running `verify()` — absence of information read
    // as permission, on the money path. The persisted identity is what
    // `useLoginWallet.connection` falls back to, so this session can still sign.
    persistIdentity("near", "alice.near", "alice.near");
    const { result } = renderHook(() => useLoginWalletContext(), { wrapper });

    expect(result.current.keyVerification).toEqual({ kind: "unchecked" });
    expect(canOperate(result.current.keyVerification)).toBe(false);
    await act(async () => {
      await expect(result.current.verifyKey()).resolves.toEqual({ kind: "unchecked" });
    });
  });

  it("refuses that account at the real `ensureCanOperate`, not just in the context (D-284)", async () => {
    // The assertions above read the context's own return values, which proves what the
    // provider PUBLISHES but not what the four money doors DO with it. This pipes the context
    // output through the actual primitive the doors call, so the two cannot drift apart.
    persistIdentity("near", "alice.near", "alice.near");
    const { result } = renderHook(() => useLoginWalletContext(), { wrapper });

    await act(async () => {
      await expect(
        ensureCanOperate(result.current.keyVerification, result.current.verifyKey),
      ).rejects.toBeInstanceOf(NearKeyNotVerifiedError);
    });
  });

  // 🔴 The PASS direction, and it needs pinning as hard as the deny direction. Over-gating is
  // also a defect here: a "tightening" that answered `unchecked` for these would deny every
  // Solana, TON, Stellar and Tron user a withdrawal, an allocate, an unallocate and a gas
  // purchase. Before this table only `evm` and NEAR-implicit were covered, so four of the six
  // passing cases had nothing holding them.
  const PASSES: ReadonlyArray<[label: string, chainKind: ChainKind, id: string]> = [
    ["evm", "evm", "0xabc"],
    ["solana", "solana", "So11111111111111111111111111111111111111112"],
    ["ton", "ton", "0:abc"],
    ["stellar", "stellar", "GABC"],
    ["tron", "tron", "TABC"],
    // 64 lowercase hex: the intents id is the public key itself, so `intents.near`
    // authenticates it with no registration. Gating it would deny a valid account.
    ["near implicit", "near", "a".repeat(64)],
  ];

  it.each(PASSES)(
    "keeps %s passing with no gate published, and `ensureCanOperate` lets it through (D-284)",
    async (_label, chainKind, id) => {
      persistIdentity(chainKind, id, id);
      const { result } = renderHook(() => useLoginWalletContext(), { wrapper });

      expect(result.current.identity?.chainKind).toBe(chainKind);
      expect(result.current.keyVerification).toEqual({ kind: "not-required" });
      expect(canOperate(result.current.keyVerification)).toBe(true);
      await act(async () => {
        await expect(result.current.verifyKey()).resolves.toEqual({ kind: "not-required" });
        await expect(
          ensureCanOperate(result.current.keyVerification, result.current.verifyKey),
        ).resolves.toBeUndefined();
      });
    },
  );

  it("judges the IDENTITY, not `activeFamily` — they can disagree (D-284)", async () => {
    // 🔴 `clearIdentity()` leaves the family key behind on purpose, so `readIdentity() !== null`
    // with `readLastUsedFamily() === null` is reachable, and the mount effect's `if (fam && id)`
    // then leaves `activeFamily` null. Keying the default off `activeFamily` — which is what
    // the plan originally proposed — answers `not-required` for `alice.near` in that state and
    // `ensureCanOperate` waves it through without checking anything.
    persistIdentity("near", "alice.near", "alice.near", { omitFamily: true });
    const { result } = renderHook(() => useLoginWalletContext(), { wrapper });

    expect(result.current.activeFamily).toBeNull();
    expect(result.current.identity?.intentsAccountId).toBe("alice.near");
    expect(result.current.keyVerification).toEqual({ kind: "unchecked" });
  });

  it("never lets the rendered state and the awaited answer disagree, even in the first commit (D-284)", async () => {
    // 🔴 This is the one assertion `renderHook` alone cannot make. A child's passive effects
    // run BEFORE its parent's, so syncing `identityRef` in a provider effect left the very
    // commit that first publishes `unchecked` answering `not-required` from `verifyKey()`.
    // `ensureCanOperate` then takes the `unchecked` branch, is told `not-required`, and throws
    // `NearKeyJustVerifiedError` even though nothing was verified.
    // Reading the pair from a CHILD's effect is what exposes the ordering; a hook consumer
    // sees only the settled value.
    persistIdentity("near", "alice.near", "alice.near");
    const seen: Array<{ rendered: string; awaited: string }> = [];

    function Probe() {
      const ctx = useLoginWalletContext();
      const rendered = ctx.keyVerification.kind;
      React.useEffect(() => {
        void ctx.verifyKey().then((awaited) => {
          seen.push({ rendered, awaited: awaited.kind });
        });
      }, [ctx, rendered]);
      return null;
    }

    await act(async () => {
      render(
        <LoginWalletProvider>
          <Probe />
        </LoginWalletProvider>,
      );
    });

    expect(seen.length).toBeGreaterThan(0);
    for (const { rendered, awaited } of seen) {
      expect(awaited).toBe(rendered);
    }
  });

  it("applies the same default when an adapter IS registered but publishes no gate (D-284)", async () => {
    // 🔴 "No gate" is wider than "no adapter": `keyVerification`/`verifyKey` are optional on
    // `LoginWalletAdapter` and all five non-NEAR bridges omit them. A NEAR identity left behind
    // by a family switch (`selectFamily` never clears it) must not be waved through just
    // because some adapter registered.
    persistIdentity("near", "alice.near", "alice.near");
    const adapter = makeMockAdapter({});
    function Wrapped({ children }: { children: React.ReactNode }) {
      return (
        <LoginWalletProvider>
          <MockBridge adapter={adapter} />
          {children}
        </LoginWalletProvider>
      );
    }
    const { result } = renderHook(() => useLoginWalletContext(), { wrapper: Wrapped });

    expect(result.current.keyVerification).toEqual({ kind: "unchecked" });
    await act(async () => {
      await expect(result.current.verifyKey()).resolves.toEqual({ kind: "unchecked" });
    });
  });

  it("returns the adapter's own answer when the family does implement it", async () => {
    // Persisted as a NEAR named account so the D-284 default (`unchecked`) is the OPPOSITE of
    // what the adapter reports: a registered wallet must not be pushed back behind the gate.
    persistIdentity("near", "a.near", "a.near");
    const adapter = makeMockAdapter({
      keyVerification: { kind: "registered", accountId: "a.near", publicKey: "ed25519:k" },
      verifyKey: vi.fn().mockResolvedValue({ kind: "not-registered", accountId: "a.near", publicKey: "ed25519:k" }),
    });
    function Wrapped({ children }: { children: React.ReactNode }) {
      return (
        <LoginWalletProvider>
          <MockBridge adapter={adapter} />
          {children}
        </LoginWalletProvider>
      );
    }
    const { result } = renderHook(() => useLoginWalletContext(), { wrapper: Wrapped });
    expect(result.current.keyVerification).toMatchObject({ kind: "registered" });
    await act(async () => {
      await expect(result.current.verifyKey()).resolves.toMatchObject({ kind: "not-registered" });
    });
  });
});

// ---------------------------------------------------------------------------
// D-546 — a connection the user asked for survives a reload, signed or not
// ---------------------------------------------------------------------------

describe("LoginWalletContext persists an unsigned connection (D-546)", () => {
  const EVM_A = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
  const EVM_B = "0x1111111111111111111111111111111111111111";

  function connectedAdapter(chainKind: ChainKind, address: string): LoginWalletAdapter {
    return makeMockAdapter({
      chainKind,
      state: { status: "connected", connection: { chainKind, address }, error: null },
    });
  }

  // Stands in for `LazyFamilyMount`: the bridge exists only while its family is active, so
  // `selectFamily` and `signOut` mount and unmount it the way the real lazy mount does.
  function wrapperWithBridge(family: ChainKind, adapter: LoginWalletAdapter) {
    function GatedBridge() {
      const { activeFamily } = useLoginWalletContext();
      return activeFamily === family ? <MockBridge adapter={adapter} /> : null;
    }
    return function Wrapper({ children }: { children: React.ReactNode }) {
      return (
        <LoginWalletProvider>
          <GatedBridge />
          {children}
        </LoginWalletProvider>
      );
    };
  }

  beforeEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("persists an EVM connection with no signature, and the reload restores the family", async () => {
    const wrapper = wrapperWithBridge("evm", connectedAdapter("evm", EVM_A));
    const { result, unmount } = renderHook(() => useLoginWalletContext(), { wrapper });

    await act(async () => {
      result.current.selectFamily("evm", { autoConnect: true });
    });

    expect(result.current.identity).toMatchObject({ chainKind: "evm", address: EVM_A });
    expect(JSON.parse(localStorage.getItem("intentfolio.identity") ?? "null")).toMatchObject({
      chainKind: "evm",
      address: EVM_A,
    });

    // The reload: a fresh provider reads storage and the mount guard (`fam && id`) passes.
    unmount();
    const reloaded = renderHook(() => useLoginWalletContext(), { wrapper });
    expect(reloaded.result.current.activeFamily).toBe("evm");
    expect(reloaded.result.current.identity?.address).toBe(EVM_A);
  });

  it("never overwrites an existing identity with a different live wallet", () => {
    localStorage.setItem("intentfolio.lastUsedWalletFamily", "evm");
    localStorage.setItem(
      "intentfolio.identity",
      JSON.stringify({ chainKind: "evm", address: EVM_A, intentsAccountId: EVM_A.toLowerCase() }),
    );
    const wrapper = wrapperWithBridge("evm", connectedAdapter("evm", EVM_B));
    const { result } = renderHook(() => useLoginWalletContext(), { wrapper });

    expect(result.current.activeFamily).toBe("evm");
    expect(result.current.identity?.address).toBe(EVM_A);
    expect(JSON.parse(localStorage.getItem("intentfolio.identity") ?? "null").address).toBe(EVM_A);
  });

  it("leaves NEAR to its ownership proof", async () => {
    const wrapper = wrapperWithBridge("near", connectedAdapter("near", "alice.near"));
    const { result } = renderHook(() => useLoginWalletContext(), { wrapper });

    await act(async () => {
      result.current.selectFamily("near", { autoConnect: true });
    });

    expect(result.current.identity).toBeNull();
    expect(localStorage.getItem("intentfolio.identity")).toBeNull();
  });

  it("does not store a wallet whose account cannot be derived (TON without a pubkey)", async () => {
    const wrapper = wrapperWithBridge("ton", connectedAdapter("ton", "not-a-pubkey"));
    const { result } = renderHook(() => useLoginWalletContext(), { wrapper });

    await act(async () => {
      result.current.selectFamily("ton", { autoConnect: true });
    });

    expect(result.current.identity).toBeNull();
    expect(localStorage.getItem("intentfolio.identity")).toBeNull();
  });

  it("keeps sign-out final: nothing is re-persisted, and the reload stays signed out", async () => {
    // The adapter keeps reporting `connected` after sign-out: the SDK connection that outlived
    // `disconnect()` is exactly the case the mount guard exists for.
    const wrapper = wrapperWithBridge("evm", connectedAdapter("evm", EVM_A));
    const { result, unmount } = renderHook(() => useLoginWalletContext(), { wrapper });

    await act(async () => {
      result.current.selectFamily("evm", { autoConnect: true });
    });
    expect(result.current.identity?.address).toBe(EVM_A);

    await act(async () => {
      await result.current.signOut();
    });
    expect(result.current.identity).toBeNull();
    expect(result.current.activeFamily).toBeNull();
    expect(localStorage.getItem("intentfolio.identity")).toBeNull();

    unmount();
    const reloaded = renderHook(() => useLoginWalletContext(), { wrapper });
    expect(reloaded.result.current.activeFamily).toBeNull();
    expect(reloaded.result.current.identity).toBeNull();
    expect(localStorage.getItem("intentfolio.identity")).toBeNull();
  });
});
