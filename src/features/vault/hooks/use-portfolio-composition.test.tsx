// @vitest-environment jsdom
// Evolution's read in the browser (plan 033-B): a failed answer is an error, never an empty split;
// an answer that is behind is read again like Performance's (the re-reads are tested there).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/features/wallet/config/network", () => ({ VAULT_CONTRACT_ID: "intentfolio-vault.near" }));
vi.mock("../lib/vault-flag", () => ({ VAULT_ROUNDTRIP_ENABLED: true }));

import {
  fetchPortfolioComposition,
  usePortfolioComposition,
  type PortfolioComposition,
} from "./use-portfolio-composition";
import { CATCH_UP_REREAD_MS, CATCH_UP_REREADS } from "./use-portfolio-stats";

const PORTFOLIO = "p_000000000001";

const composition = (over: Partial<PortfolioComposition> = {}): PortfolioComposition => ({
  ok: true,
  days: [{ day: "2026-10-29", tokens: [{ tokenId: "near", usd: 12.5 }] }],
  recordedUntil: Date.UTC(2026, 9, 30, 6, 5),
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

describe("fetchPortfolioComposition", () => {
  it("asks the route for this portfolio and hands back the answer", async () => {
    fetchMock.mockResolvedValue(answer(composition()));
    expect(await fetchPortfolioComposition(PORTFOLIO)).toEqual(composition());
    expect(fetchMock).toHaveBeenCalledWith(`/api/history/portfolio-composition?portfolio=${PORTFOLIO}`);
  });

  it("throws on a refusal or a body it cannot read, never returns an empty split", async () => {
    fetchMock.mockResolvedValueOnce(answer({ ok: false, code: "read-failed", error: "x" }, 502));
    await expect(fetchPortfolioComposition(PORTFOLIO)).rejects.toThrow("portfolio-composition answered 502 (read-failed)");
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => Promise.reject(new Error("html")) } as unknown as Response);
    await expect(fetchPortfolioComposition(PORTFOLIO)).rejects.toThrow("portfolio-composition answered 200");
  });
});

describe("usePortfolioComposition", () => {
  it("does not read for a mock portfolio", async () => {
    const { result } = renderHook(() => usePortfolioComposition(PORTFOLIO, false), { wrapper });
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
  });

  it("a failed read is an error with no data", async () => {
    fetchMock.mockResolvedValue(answer({ ok: false, code: "read-failed", error: "x" }, 502));
    const { result } = renderHook(() => usePortfolioComposition(PORTFOLIO, true), { wrapper });
    // The hook's own `retry: 1` waits ~1 s before the second try.
    await waitFor(() => expect(result.current.isError).toBe(true), { timeout: 3000 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.data).toBeUndefined();
  });

  it("still behind after every re-read: out of date, and the re-reads stop", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchMock.mockResolvedValue(answer(composition({ upToDate: false })));
    const { result } = renderHook(() => usePortfolioComposition(PORTFOLIO, true), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());

    for (let i = 0; i < CATCH_UP_REREADS; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CATCH_UP_REREAD_MS);
      });
    }
    await waitFor(() => expect(result.current.outOfDate).toBe(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * CATCH_UP_REREAD_MS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1 + CATCH_UP_REREADS);
  });
});
