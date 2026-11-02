// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { deriveStatus, RESTORE_TIMEOUT_MS } from "./use-login-wallet";

// ---------------------------------------------------------------------------
// Pure-function tests — no React rendering needed
// ---------------------------------------------------------------------------

describe("deriveStatus", () => {
  const identity = { chainKind: "evm" as const, address: "0xABC", intentsAccountId: "" };

  it("returns idle when adapter is idle and no identity", () => {
    expect(deriveStatus("idle", null, null, false)).toBe("idle");
  });

  it("returns restoring when identity present, adapter idle, not timed out", () => {
    expect(deriveStatus("idle", identity, "evm", false)).toBe("restoring");
  });

  it("returns connected when identity present, adapter idle, timed out", () => {
    expect(deriveStatus("idle", identity, "evm", true)).toBe("connected");
  });

  it("returns connected when adapter status is connected", () => {
    expect(deriveStatus("connected", null, null, false)).toBe("connected");
  });

  it("returns connecting when adapter status is connecting", () => {
    expect(deriveStatus("connecting", null, null, false)).toBe("connecting");
  });

  it("returns error when adapter status is error", () => {
    expect(deriveStatus("error", null, null, false)).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// Hook integration tests — verifies timeout behaviour and context reading
// ---------------------------------------------------------------------------

vi.mock("../context/login-wallet-context", () => ({
  useLoginWalletContext: vi.fn(),
}));

vi.mock("../lib/identity", () => ({
  deriveIntentsAccountId: vi.fn((address: string) => address.toLowerCase()),
  // Same derivation rule as the mock above, so a test only has to think in addresses.
  walletMatchesAccount: vi.fn(
    (address: string, _chainKind: string, expected: string) =>
      address.toLowerCase() === expected.toLowerCase(),
  ),
}));

import { useLoginWalletContext } from "../context/login-wallet-context";
import { useLoginWallet } from "./use-login-wallet";

const mockedCtx = vi.mocked(useLoginWalletContext);

function makeContext(overrides: Partial<ReturnType<typeof useLoginWalletContext>> = {}) {
  return {
    activeFamily: null,
    lastUsedFamily: null,
    state: { status: "idle" as const, connection: null, error: null },
    identity: null,
    hydrated: true,
    adapterRegistered: true,
    restoreSettled: false,
    selectFamily: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    signMessage: vi.fn(),
    signOut: vi.fn(),
    clearError: vi.fn(),
    keyVerification: { kind: "not-required" as const },
    verifyKey: vi.fn(),
    registerKey: vi.fn(),
    cancelRegistration: vi.fn(),
    sendEvmTransaction: null,
    registerAdapter: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("useLoginWallet", () => {
  it("returns idle when no identity and adapter idle", () => {
    mockedCtx.mockReturnValue(makeContext());
    const { result } = renderHook(() => useLoginWallet());
    expect(result.current.status).toBe("idle");
    expect(result.current.connection).toBeNull();
    expect(result.current.intentsAccountId).toBe("");
  });

  it("reports restoring until the provider has hydrated (D-137)", () => {
    // Even with no identity, before localStorage is read the status must be
    // "restoring" (neutral skeleton) so SSR and first client render match.
    mockedCtx.mockReturnValue(makeContext({ hydrated: false }));
    const { result } = renderHook(() => useLoginWallet());
    expect(result.current.status).toBe("restoring");
  });

  it("returns restoring immediately when identity present and adapter idle", () => {
    const identity = { chainKind: "evm" as const, address: "0xDEAD", intentsAccountId: "" };
    mockedCtx.mockReturnValue(makeContext({ identity, activeFamily: "evm" }));
    vi.useFakeTimers();
    const { result } = renderHook(() => useLoginWallet());
    expect(result.current.status).toBe("restoring");
    expect(result.current.connection).toEqual({ chainKind: "evm", address: "0xDEAD" });
  });

  it("transitions restoring → connected after RESTORE_TIMEOUT_MS", () => {
    const identity = { chainKind: "solana" as const, address: "So1abc", intentsAccountId: "" };
    mockedCtx.mockReturnValue(makeContext({ identity, activeFamily: "solana" }));
    vi.useFakeTimers();
    const { result } = renderHook(() => useLoginWallet());
    expect(result.current.status).toBe("restoring");
    act(() => { vi.advanceTimersByTime(RESTORE_TIMEOUT_MS); });
    expect(result.current.status).toBe("connected");
    expect(result.current.connection).toEqual({ chainKind: "solana", address: "So1abc" });
  });

  it("keeps restoring past RESTORE_TIMEOUT_MS while the family's adapter has not registered (D-498)", () => {
    const identity = { chainKind: "solana" as const, address: "So1abc", intentsAccountId: "" };
    mockedCtx.mockReturnValue(
      makeContext({ identity, activeFamily: "solana", adapterRegistered: false }),
    );
    vi.useFakeTimers();
    const { result, rerender } = renderHook(() => useLoginWallet());
    act(() => { vi.advanceTimersByTime(RESTORE_TIMEOUT_MS * 4); });
    expect(result.current.status).toBe("restoring");
    // The adapter lands: only now does the 1.5 s clock start.
    mockedCtx.mockReturnValue(makeContext({ identity, activeFamily: "solana" }));
    rerender();
    expect(result.current.status).toBe("restoring");
    act(() => { vi.advanceTimersByTime(RESTORE_TIMEOUT_MS); });
    expect(result.current.status).toBe("connected");
  });

  it("stops restoring as soon as the adapter says its restore has settled (D-545)", () => {
    const identity = { chainKind: "near" as const, address: "alice.near", intentsAccountId: "" };
    mockedCtx.mockReturnValue(makeContext({ identity, activeFamily: "near" }));
    vi.useFakeTimers();
    const { result, rerender } = renderHook(() => useLoginWallet());
    expect(result.current.status).toBe("restoring");
    // HOT Connect answered "no live session": no clock left to wait out.
    mockedCtx.mockReturnValue(makeContext({ identity, activeFamily: "near", restoreSettled: true }));
    rerender();
    expect(result.current.status).toBe("connected");
    expect(result.current.connection).toEqual({ chainKind: "near", address: "alice.near" });
  });

  it("keeps restoring on a settled restore while the family's adapter has not registered (D-498)", () => {
    const identity = { chainKind: "near" as const, address: "alice.near", intentsAccountId: "" };
    mockedCtx.mockReturnValue(
      makeContext({ identity, activeFamily: "near", adapterRegistered: false, restoreSettled: true }),
    );
    const { result } = renderHook(() => useLoginWallet());
    expect(result.current.status).toBe("restoring");
  });

  it("still reports connecting while a settled adapter is busy, not connected (D-545)", () => {
    const identity = { chainKind: "near" as const, address: "alice.near", intentsAccountId: "" };
    mockedCtx.mockReturnValue(makeContext({
      identity,
      activeFamily: "near",
      restoreSettled: true,
      state: { status: "connecting", connection: null, error: null },
    }));
    const { result } = renderHook(() => useLoginWallet());
    expect(result.current.status).toBe("connecting");
  });

  it("returns connected with live adapter connection when adapter is connected", () => {
    const liveConnection = { chainKind: "near" as const, address: "alice.near" };
    const identity = { chainKind: "near" as const, address: "alice.near", intentsAccountId: "" };
    mockedCtx.mockReturnValue(makeContext({
      identity,
      activeFamily: "near",
      state: { status: "connected", connection: liveConnection, error: null },
    }));
    const { result } = renderHook(() => useLoginWallet());
    expect(result.current.status).toBe("connected");
    expect(result.current.connection).toEqual(liveConnection);
    // intentsAccountId derived from connection via mocked deriveIntentsAccountId
    expect(result.current.intentsAccountId).toBe("alice.near");
  });
});

// Regression for the silent identity swap observed on 2026-08-06 (008.plan F4.2): switching
// the active account inside the Backpack extension moved the whole app — chip,
// `intentsAccountId`, every query keyed off it — onto an account the user had never signed in
// with. The live connection used to win unconditionally over the persisted session.
describe("useLoginWallet — live wallet vs the session's account", () => {
  const SESSION = {
    chainKind: "solana" as const,
    address: "Wallet1Address",
    intentsAccountId: "wallet1address",
  };

  it("keeps the session's account when the wallet switches to a different one", () => {
    mockedCtx.mockReturnValue(makeContext({
      identity: SESSION,
      activeFamily: "solana",
      state: {
        status: "connected",
        connection: { chainKind: "solana", address: "Wallet2Address" },
        error: null,
      },
    }));
    const { result } = renderHook(() => useLoginWallet());
    expect(result.current.connection).toEqual({
      chainKind: "solana",
      address: "Wallet1Address",
    });
    // The one that actually matters: every balance/history query is keyed off this.
    expect(result.current.intentsAccountId).toBe("wallet1address");
  });

  // `liveConnection` is what makes the pre-prompt guard in portfolio-context work at all:
  // once `connection` started hiding a foreign wallet, that guard was comparing a value
  // against itself. The two must therefore DISAGREE in exactly this case.
  it("still reports the foreign wallet through liveConnection", () => {
    mockedCtx.mockReturnValue(makeContext({
      identity: SESSION,
      activeFamily: "solana",
      state: {
        status: "connected",
        connection: { chainKind: "solana", address: "Wallet2Address" },
        error: null,
      },
    }));
    const { result } = renderHook(() => useLoginWallet());
    expect(result.current.liveConnection).toEqual({
      chainKind: "solana",
      address: "Wallet2Address",
    });
    expect(result.current.connection).not.toEqual(result.current.liveConnection);
  });

  it("reports no liveConnection while the adapter is not connected", () => {
    mockedCtx.mockReturnValue(makeContext({ identity: SESSION, activeFamily: "solana" }));
    const { result } = renderHook(() => useLoginWallet());
    expect(result.current.liveConnection).toBeNull();
    // …but the session is still known, so the app keeps working.
    expect(result.current.connection).toEqual({
      chainKind: "solana",
      address: "Wallet1Address",
    });
  });

  it("still adopts the live wallet when it IS the session's account", () => {
    mockedCtx.mockReturnValue(makeContext({
      identity: SESSION,
      activeFamily: "solana",
      state: {
        status: "connected",
        connection: { chainKind: "solana", address: "Wallet1Address" },
        error: null,
      },
    }));
    const { result } = renderHook(() => useLoginWallet());
    expect(result.current.connection).toEqual({
      chainKind: "solana",
      address: "Wallet1Address",
    });
  });

  it("adopts any live wallet when there is no session yet (fresh sign-in)", () => {
    mockedCtx.mockReturnValue(makeContext({
      identity: null,
      activeFamily: "solana",
      state: {
        status: "connected",
        connection: { chainKind: "solana", address: "Wallet2Address" },
        error: null,
      },
    }));
    const { result } = renderHook(() => useLoginWallet());
    expect(result.current.connection).toEqual({
      chainKind: "solana",
      address: "Wallet2Address",
    });
  });

  // A stored `intentsAccountId` of "" means derivation failed for that family (TON without a
  // pubkey — login-wallet-context.tsx:259-264). Comparing against "" would call every wallet a
  // mismatch and pin those sessions to the persisted address for good.
  it("does not treat an underivable stored identity as a mismatch", () => {
    mockedCtx.mockReturnValue(makeContext({
      identity: { chainKind: "ton" as const, address: "EQsomething", intentsAccountId: "" },
      activeFamily: "ton",
      state: {
        status: "connected",
        connection: { chainKind: "ton", address: "abcdef0123" },
        error: null,
      },
    }));
    const { result } = renderHook(() => useLoginWallet());
    expect(result.current.connection).toEqual({ chainKind: "ton", address: "abcdef0123" });
  });
});
