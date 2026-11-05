// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, cleanup, act } from "@testing-library/react";
import { PRICE_FRESH_MS, resetTokenPriceCache, useTokenPrices } from "./use-token-prices";
import { STOCK_TOKENS } from "../lib/stock-tokens";
import { tokenRegistry } from "../lib/token-registry";

const PROBE = tokenRegistry[0].id;

function priceMap(source: string) {
  return Object.fromEntries(
    tokenRegistry.map((t) => [
      t.id,
      { symbol: t.symbol, usdPrice: 1, updatedAt: "2026-07-29T18:00:00.000Z", source },
    ])
  );
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  resetTokenPriceCache();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useTokenPrices pricesUnavailable", () => {
  it("stays false while real quotes are coming back", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ prices: priceMap("chaindefuser"), updatedAt: "x" }),
    });
    const { result } = renderHook(() => useTokenPrices());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.pricesUnavailable).toBe(false);
  });

  it("stays false when the server serves its one-hour cache", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ prices: priceMap("cached"), updatedAt: "x" }),
    });
    const { result } = renderHook(() => useTokenPrices());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.pricesUnavailable).toBe(false);
  });

  it("turns true when every price is a hardcoded fallback", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ prices: priceMap("fallback"), updatedAt: "x" }),
    });
    const { result } = renderHook(() => useTokenPrices());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.pricesUnavailable).toBe(true);
  });

  it("still turns true with 1Click down and only the stocks priced: they say nothing about the rest", async () => {
    const prices = priceMap("fallback");
    for (const stock of STOCK_TOKENS) prices[stock.id] = { ...prices[stock.id], source: "coingecko" };
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ prices, updatedAt: "x" }) });
    const { result } = renderHook(() => useTokenPrices());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.pricesUnavailable).toBe(true);
    expect(result.current.stockPricesUnavailable).toBe(false);
  });

  it("says apart when only the stock prices are missing", async () => {
    const prices = priceMap("chaindefuser");
    for (const stock of STOCK_TOKENS) prices[stock.id] = { ...prices[stock.id], source: "fallback" };
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ prices, updatedAt: "x" }) });
    const { result } = renderHook(() => useTokenPrices());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.pricesUnavailable).toBe(false);
    expect(result.current.stockPricesUnavailable).toBe(true);
  });

  it("turns true when the price route itself fails", async () => {
    fetchMock.mockRejectedValue(new Error("route down"));
    const { result } = renderHook(() => useTokenPrices());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.pricesUnavailable).toBe(true);
  });

  it("does not flag unavailable during the first load", () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ prices: priceMap("chaindefuser"), updatedAt: "x" }),
    });
    const { result } = renderHook(() => useTokenPrices());
    // Initial state seeds every entry from fallbackUsdPrice; the notice must not flash here.
    expect(result.current.isLoading).toBe(true);
    expect(result.current.prices[PROBE].source).toBe("fallback");
    expect(result.current.pricesUnavailable).toBe(false);
  });
});

// s186: every instance fetched on its own and started from the hardcoded fallbacks, so a
// component mounted later decided on prices several times off until its own answer came back.
describe("useTokenPrices — the shared last answer", () => {
  it("a later instance starts from the last real quote, not the fallbacks", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ prices: priceMap("chaindefuser"), updatedAt: "x" }),
    });
    const first = renderHook(() => useTokenPrices());
    await waitFor(() => expect(first.result.current.isLoading).toBe(false));

    fetchMock.mockReturnValue(new Promise(() => {})); // its own fetch never answers
    const later = renderHook(() => useTokenPrices());
    expect(later.result.current.isLoading).toBe(false);
    expect(later.result.current.prices[PROBE].source).toBe("chaindefuser");
  });

  it("a failed load is not passed off as a real answer: the next instance sees the failure", async () => {
    fetchMock.mockRejectedValue(new Error("route down"));
    const first = renderHook(() => useTokenPrices());
    await waitFor(() => expect(first.result.current.isLoading).toBe(false));

    const later = renderHook(() => useTokenPrices());
    expect(later.result.current.prices[PROBE].source).toBe("fallback");
    expect(later.result.current.error).toBe("route down");
    expect(later.result.current.pricesUnavailable).toBe(true);
  });
});

// D-411: one fetch per instance on mount plus one interval per instance — ~10 callers on a
// dashboard — tripped Vercel's DDoS rule (a Challenge a fetch cannot solve) against a real user.
describe("useTokenPrices — one request for every caller", () => {
  const ok = () =>
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ prices: priceMap("chaindefuser"), updatedAt: "x" }),
    });
  const flush = () => act(() => vi.advanceTimersByTimeAsync(0));
  const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

  function setVisibility(value: "visible" | "hidden") {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
    document.dispatchEvent(new Event("visibilitychange"));
  }

  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility("visible");
  });

  it("instances mounted together share one request, and all of them get its answer", async () => {
    ok();
    const hooks = Array.from({ length: 10 }, () => renderHook(() => useTokenPrices()));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const h of hooks) expect(h.result.current.prices[PROBE].source).toBe("chaindefuser");
  });

  it("an instance mounted soon after a load reuses it; after the freshness window it asks again", async () => {
    ok();
    renderHook(() => useTokenPrices());
    await flush();
    renderHook(() => useTokenPrices());
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await advance(PRICE_FRESH_MS);
    renderHook(() => useTokenPrices());
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("many instances refresh on one interval: one request per period, not one each", async () => {
    ok();
    Array.from({ length: 5 }, () => renderHook(() => useTokenPrices()));
    await flush();
    await advance(60000 * 3);
    expect(fetchMock).toHaveBeenCalledTimes(1 + 3);
  });

  it("refreshes at the shortest cadence mounted, and goes back when that caller leaves", async () => {
    ok();
    renderHook(() => useTokenPrices());
    const editor = renderHook(() => useTokenPrices(15000));
    await flush();
    await advance(60000);
    expect(fetchMock).toHaveBeenCalledTimes(1 + 4);

    editor.unmount();
    await advance(60000);
    expect(fetchMock).toHaveBeenCalledTimes(1 + 4 + 1);
  });

  it("does not ask while the tab is hidden, and catches up when it comes back", async () => {
    ok();
    renderHook(() => useTokenPrices());
    await flush();
    setVisibility("hidden");
    await advance(60000 * 5);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    setVisibility("visible");
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops asking once nobody is mounted", async () => {
    ok();
    const only = renderHook(() => useTokenPrices());
    await flush();
    only.unmount();
    await advance(60000 * 5);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a request that never answers is given up, so the next period can still refresh", async () => {
    fetchMock.mockReturnValueOnce(new Promise(() => {}));
    const { result } = renderHook(() => useTokenPrices());
    await advance(15000);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBe("Price API timed out");

    ok();
    await advance(60000 - 15000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.prices[PROBE].source).toBe("chaindefuser");
    expect(result.current.error).toBeNull();
  });

  it("a later failure keeps the last real prices and reports the error", async () => {
    ok();
    const { result } = renderHook(() => useTokenPrices());
    await flush();
    fetchMock.mockResolvedValue({ ok: false, status: 429 });
    await advance(60000);
    expect(result.current.prices[PROBE].source).toBe("chaindefuser");
    expect(result.current.error).toBe("Price API returned 429");
    expect(result.current.pricesUnavailable).toBe(false);
  });
});
