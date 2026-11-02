// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrecheckOp } from "../lib/vault-precheck";

// The hook around `runVaultPrecheck` (017-9b): what the modals mock. Pinned here: the reads it
// wires, that a stale answer for another token set is dropped, that a refusal is asked again
// until it clears (D-385 c), and nothing after unmount.

const reads = vi.hoisted(() => ({
  pause: vi.fn(),
  reservoir: vi.fn(),
  freeze: vi.fn(),
}));
const vault = vi.hoisted(() => ({ id: "intentfolio-vault.near" }));
vi.mock("@/features/wallet/config/network", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/wallet/config/network")>()),
  get VAULT_CONTRACT_ID() {
    return vault.id;
  },
}));
vi.mock("../lib/vault-read-client", () => ({
  getPauseState: reads.pause,
  getReservoir: reads.reservoir,
  getTokenFreeze: reads.freeze,
}));

import { PRECHECK_RECHECK_MS, useVaultPrecheck } from "./use-vault-precheck";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const OPEN = { deposits_open: true, withdrawals_open: true };
const NO_PAUSE = { areas: [null, null, null] };

describe("useVaultPrecheck", () => {
  afterEach(() => {
    vi.resetAllMocks();
    vault.id = "intentfolio-vault.near";
  });

  it("reads nothing without an op", async () => {
    const { result } = renderHook(() => useVaultPrecheck(null));
    await act(async () => {});
    expect(result.current).toBeNull();
    expect(reads.pause).not.toHaveBeenCalled();
  });

  it("reads nothing without a configured vault (local and mock builds), and stays open", async () => {
    vault.id = "";
    const { result } = renderHook(() => useVaultPrecheck({ kind: "allocate", tokenIds: ["near"] }));
    await act(async () => {});
    expect(result.current).toBeNull();
    expect(reads.pause).not.toHaveBeenCalled();
    expect(reads.reservoir).not.toHaveBeenCalled();
    expect(reads.freeze).not.toHaveBeenCalled();
  });

  it("starts open, then reports the block; the freeze read gets the registry id it is given", async () => {
    reads.pause.mockResolvedValue(NO_PAUSE);
    reads.reservoir.mockResolvedValue(OPEN);
    reads.freeze.mockImplementation(async (id: string) => (id === "near" ? { reason: "depeg" } : null));
    const { result } = renderHook(() => useVaultPrecheck({ kind: "allocate", tokenIds: ["near"] }));
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toEqual({ reason: "token-frozen", tokenId: "near" }));
    // `getTokenFreeze` translates to the contract id itself (vault-read-client).
    expect(reads.freeze).toHaveBeenCalledWith("near");
  });

  it("drops an answer for a token set that is no longer the current one", async () => {
    reads.pause.mockResolvedValue(NO_PAUSE);
    reads.reservoir.mockResolvedValue(OPEN);
    const first = deferred<{ reason: string } | null>();
    const second = deferred<{ reason: string } | null>();
    reads.freeze.mockImplementation((id: string) => (id === "near" ? first.promise : second.promise));

    const { result, rerender } = renderHook(({ op }: { op: PrecheckOp }) => useVaultPrecheck(op), {
      initialProps: { op: { kind: "allocate", tokenIds: ["near"] } as PrecheckOp },
    });
    rerender({ op: { kind: "allocate", tokenIds: ["usdt"] } });

    await act(async () => second.resolve(null));
    await act(async () => first.resolve({ reason: "depeg" })); // late, for the old set
    expect(result.current).toBeNull();
  });

  it("the same tokens in another order are the same question: no second read", async () => {
    reads.pause.mockResolvedValue(NO_PAUSE);
    reads.reservoir.mockResolvedValue(OPEN);
    reads.freeze.mockResolvedValue(null);
    const { rerender } = renderHook(({ op }: { op: PrecheckOp }) => useVaultPrecheck(op), {
      initialProps: { op: { kind: "allocate", tokenIds: ["near", "usdt"] } as PrecheckOp },
    });
    await act(async () => {});
    rerender({ op: { kind: "allocate", tokenIds: ["usdt", "near"] } });
    await act(async () => {});
    expect(reads.pause).toHaveBeenCalledTimes(1);
  });

  // D-385 (c): a pause lifted with the modal open clears the notice without reopening it.
  it("asks a refusal again until it clears, then stops asking", async () => {
    vi.useFakeTimers();
    try {
      reads.pause.mockResolvedValue(NO_PAUSE);
      reads.reservoir.mockResolvedValue(OPEN);
      reads.freeze.mockResolvedValue({ reason: "depeg" });
      const { result } = renderHook(() => useVaultPrecheck({ kind: "allocate", tokenIds: ["near"] }));
      await act(async () => {});
      expect(result.current).toEqual({ reason: "token-frozen", tokenId: "near" });

      reads.freeze.mockResolvedValue(null);
      await act(async () => vi.advanceTimersByTimeAsync(PRECHECK_RECHECK_MS));
      expect(result.current).toBeNull();
      expect(reads.freeze).toHaveBeenCalledTimes(2);

      await act(async () => vi.advanceTimersByTimeAsync(PRECHECK_RECHECK_MS * 3));
      expect(reads.freeze).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not ask again after unmount", async () => {
    vi.useFakeTimers();
    try {
      reads.pause.mockResolvedValue(NO_PAUSE);
      reads.reservoir.mockResolvedValue(OPEN);
      reads.freeze.mockResolvedValue({ reason: "depeg" });
      const { unmount } = renderHook(() => useVaultPrecheck({ kind: "allocate", tokenIds: ["near"] }));
      await act(async () => {});
      unmount();
      await act(async () => vi.advanceTimersByTimeAsync(PRECHECK_RECHECK_MS * 2));
      expect(reads.freeze).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an answer that lands after unmount is ignored", async () => {
    const pending = deferred<typeof NO_PAUSE>();
    reads.pause.mockReturnValue(pending.promise);
    reads.reservoir.mockResolvedValue(OPEN);
    reads.freeze.mockResolvedValue(null);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { unmount } = renderHook(() => useVaultPrecheck({ kind: "allocate", tokenIds: ["near"] }));
    unmount();
    await act(async () => pending.resolve({ areas: [{ until: null, reason: "x", since: 0, actor: "g" }, null, null] as never }));
    expect(error).not.toHaveBeenCalled();
  });
});
