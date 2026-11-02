// @vitest-environment jsdom
// The Performance read in the browser (plan 028-3): a failed answer is an error, never a zero;
// an answer that is behind is read again a few times — the pass it started is done by then — and
// only after the last re-read is it "out of date".

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/features/wallet/config/network", () => ({ VAULT_CONTRACT_ID: "intentfolio-vault.near" }));
vi.mock("../lib/vault-flag", () => ({ VAULT_ROUNDTRIP_ENABLED: true }));

import {
  CATCH_UP_REREAD_MS,
  CATCH_UP_REREADS,
  fetchPortfolioStats,
  usePortfolioStats,
  type PortfolioStats,
} from "./use-portfolio-stats";

const PORTFOLIO = "p_000000000001";
const RECORDED = Date.UTC(2026, 9, 17, 3, 24);

const stats = (over: Partial<PortfolioStats> = {}): PortfolioStats => ({
  ok: true,
  swaps: 25,
  spreadUsd: 0.0192,
  spreadIsMinimum: false,
  daily: [{ day: "2026-10-16", swaps: 25, spreadUsd: 0.0192 }],
  recordedUntil: RECORDED,
  upToDate: true,
  loading: false,
  ...over,
});

const answer = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("fetchPortfolioStats", () => {
  it("asks the route for this portfolio and hands back the answer", async () => {
    fetchMock.mockResolvedValue(answer(stats()));
    expect(await fetchPortfolioStats(PORTFOLIO)).toEqual(stats());
    expect(fetchMock).toHaveBeenCalledWith(`/api/history/portfolio-stats?portfolio=${PORTFOLIO}`);
  });

  it("throws on a refusal or a body it cannot read, never returns zeros", async () => {
    fetchMock.mockResolvedValueOnce(answer({ ok: false, code: "read-failed", error: "x" }, 502));
    await expect(fetchPortfolioStats(PORTFOLIO)).rejects.toThrow("portfolio-stats answered 502 (read-failed)");
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => Promise.reject(new Error("html")) } as unknown as Response);
    await expect(fetchPortfolioStats(PORTFOLIO)).rejects.toThrow("portfolio-stats answered 200");
  });
});

describe("usePortfolioStats", () => {
  it("does not read for a mock portfolio", async () => {
    const { result } = renderHook(() => usePortfolioStats(PORTFOLIO, false), { wrapper });
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
  });

  it("up to date: one read, no re-read, not out of date", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchMock.mockResolvedValue(answer(stats()));
    const { result } = renderHook(() => usePortfolioStats(PORTFOLIO, true), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * CATCH_UP_REREAD_MS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.outOfDate).toBe(false);
  });

  it("behind, then caught up by the pass: re-reads once and never says out of date", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchMock
      .mockResolvedValueOnce(answer(stats({ upToDate: false })))
      .mockResolvedValue(answer(stats({ recordedUntil: RECORDED + 9 * 60 * 60 * 1000 })));
    const { result } = renderHook(() => usePortfolioStats(PORTFOLIO, true), { wrapper });
    await waitFor(() => expect(result.current.data?.upToDate).toBe(false));
    expect(result.current.outOfDate).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CATCH_UP_REREAD_MS);
    });
    await waitFor(() => expect(result.current.data?.upToDate).toBe(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * CATCH_UP_REREAD_MS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.outOfDate).toBe(false);
  });

  it("still behind after every re-read: out of date, and the re-reads stop", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchMock.mockResolvedValue(answer(stats({ upToDate: false })));
    const { result } = renderHook(() => usePortfolioStats(PORTFOLIO, true), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());

    for (let i = 1; i < CATCH_UP_REREADS; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CATCH_UP_REREAD_MS);
      });
      expect(result.current.outOfDate).toBe(false);
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CATCH_UP_REREAD_MS);
    });
    await waitFor(() => expect(result.current.outOfDate).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(1 + CATCH_UP_REREADS);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * CATCH_UP_REREAD_MS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1 + CATCH_UP_REREADS);
  });

  it("data that moves but stays behind does not restart the count: out of date, and the re-reads stop", async () => {
    // FastNEAR's index lagging: every pass advances "recorded until" a minute, never to within 5 min.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let reads = 0;
    fetchMock.mockImplementation(async () => answer(stats({ upToDate: false, recordedUntil: RECORDED + 60_000 * reads++ })));
    const { result } = renderHook(() => usePortfolioStats(PORTFOLIO, true), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());

    for (let i = 0; i < CATCH_UP_REREADS; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CATCH_UP_REREAD_MS);
      });
    }
    await waitFor(() => expect(result.current.outOfDate).toBe(true));
    for (let i = 0; i < 20; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CATCH_UP_REREAD_MS);
      });
    }
    expect(fetchMock).toHaveBeenCalledTimes(1 + CATCH_UP_REREADS);
  });

  it("an up-to-date answer in between starts the count again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Three behind (the first read and two re-reads), one up to date, then behind for good.
    const sequence = [false, false, false, true];
    let reads = 0;
    fetchMock.mockImplementation(async () => answer(stats({ upToDate: sequence[reads++] ?? false })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const own = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => usePortfolioStats(PORTFOLIO, true), { wrapper: own });
    await waitFor(() => expect(result.current.data?.upToDate).toBe(false));

    // One interval per act: React applies the re-read count when the act ends, and only then
    // schedules the next one.
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CATCH_UP_REREAD_MS);
      });
    }
    await waitFor(() => expect(result.current.data?.upToDate).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(4);

    // A later read (a refocus, a stale refetch) is behind again: a whole new set of re-reads
    // before the note, not the one left over from before.
    await act(async () => {
      await client.refetchQueries();
    });
    await waitFor(() => expect(result.current.data?.upToDate).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(5);
    for (let i = 1; i < CATCH_UP_REREADS; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CATCH_UP_REREAD_MS);
      });
      expect(result.current.outOfDate).toBe(false);
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CATCH_UP_REREAD_MS);
    });
    await waitFor(() => expect(result.current.outOfDate).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(5 + CATCH_UP_REREADS);
  });
});
