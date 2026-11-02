// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";

const state = vi.hoisted(() => ({
  isLoading: false,
  isError: false,
  failureCount: 0,
  data: undefined as Map<string, number> | undefined,
  refetch: vi.fn(),
}));

vi.mock("@/features/login-wallet", () => ({ useLoginWallet: () => ({ intentsAccountId: "alice.near" }) }));
vi.mock("@/features/wallet", () => ({ useIntentsBalances: () => state }));

import { useGeneralBalanceRead } from "./use-general-balance-read";

afterEach(() => {
  cleanup();
  state.isLoading = false;
  state.isError = false;
  state.failureCount = 0;
  state.data = undefined;
  state.refetch.mockClear();
});

describe("useGeneralBalanceRead (D-541)", () => {
  it("is loading through the first failure, an error from the second while the query still retries", () => {
    state.isLoading = true;
    const { result, rerender } = renderHook(() => useGeneralBalanceRead());
    expect(result.current).toEqual({ status: "loading" });
    state.failureCount = 1;
    rerender();
    expect(result.current).toEqual({ status: "loading" });
    state.failureCount = 2;
    rerender();
    expect(result.current.status).toBe("error");
  });

  it("an error once the retries are spent; Retry re-runs the read, which is loading again", () => {
    state.isError = true;
    state.failureCount = 4;
    const { result, rerender } = renderHook(() => useGeneralBalanceRead());
    if (result.current.status !== "error") throw new Error("expected an error");
    result.current.retry();
    expect(state.refetch).toHaveBeenCalledTimes(1);

    // A refetch without data puts the query back in pending and resets its failure count.
    state.isError = false;
    state.failureCount = 0;
    state.isLoading = true;
    rerender();
    expect(result.current).toEqual({ status: "loading" });

    state.isLoading = false;
    state.data = new Map([["near", 1]]);
    rerender();
    expect(result.current).toEqual({ status: "read" });
  });

  it("stays read when only a refresh failed: the last balance is kept", () => {
    state.isError = true;
    state.failureCount = 4;
    state.data = new Map();
    const { result } = renderHook(() => useGeneralBalanceRead());
    expect(result.current).toEqual({ status: "read" });
  });

  it("is read with the query disabled (no session)", () => {
    const { result } = renderHook(() => useGeneralBalanceRead());
    expect(result.current).toEqual({ status: "read" });
  });
});
