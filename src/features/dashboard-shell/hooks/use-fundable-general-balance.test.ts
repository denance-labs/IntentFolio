// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import { getTokenById } from "@/features/market/lib/token-registry";
import type { GeneralBalanceRead } from "./use-general-balance-read";

const USDT = "nep141:usdt.tether-token.near";
const BTC = "nep141:btc.omft.near";

const state = vi.hoisted(() => ({
  isLoading: false,
  read: null as GeneralBalanceRead | null,
  available: new Map<string, number>(),
  prices: {} as Record<string, { usdPrice: number }>,
  pricesLoading: false,
}));

vi.mock("./use-general-balance-read", () => ({
  useGeneralBalanceRead: () => state.read ?? { status: state.isLoading ? "loading" : "read" },
}));
vi.mock("./use-available-general-balance", () => ({ useAvailableGeneralBalance: () => state.available }));
vi.mock("@/features/market/hooks/use-token-prices", () => ({
  useTokenPrices: () => ({ prices: state.prices, isLoading: state.pricesLoading }),
}));

import { useFundableGeneralBalance } from "./use-fundable-general-balance";

afterEach(() => {
  cleanup();
  state.isLoading = false;
  state.read = null;
  state.available = new Map();
  state.prices = {};
  state.pricesLoading = false;
});

describe("useFundableGeneralBalance", () => {
  // s186: before the first price answer every price is the registry fallback (NEAR $1.58 while it
  // traded near $5), and 0.3 NEAR read as not enough — a funded draft went to the editor.
  it("is unknown until prices have their first answer", () => {
    state.pricesLoading = true;
    state.available = new Map([["near", 0.3]]);
    const { result, rerender } = renderHook(() => useFundableGeneralBalance());
    expect(result.current).toEqual({ status: "loading" });

    state.pricesLoading = false;
    state.prices = { near: { usdPrice: 4.9 } };
    rerender();
    expect(result.current).toEqual({ status: "known", fundable: true, tokenIds: ["near"], usd: expect.closeTo(1.47, 6) });
  });

  it("is unknown while the first on-chain read is in flight — even if the fallback shows funds", () => {
    state.isLoading = true;
    state.available = new Map([[USDT, 50]]);
    const { result } = renderHook(() => useFundableGeneralBalance());
    expect(result.current).toEqual({ status: "loading" });
  });

  // D-541: a failed first read is not "no funds" — the empty fallback would send a funded draft
  // to a deposit it does not need.
  it("is an error, with the read's retry, when the first read failed — even if the fallback shows funds", () => {
    const retry = vi.fn();
    state.read = { status: "error", retry };
    state.available = new Map([[USDT, 50]]);
    const { result } = renderHook(() => useFundableGeneralBalance());
    expect(result.current).toEqual({ status: "error", retry });
  });

  it("is known and fundable with a token worth the floor at its live price", () => {
    state.available = new Map([[USDT, 5]]);
    state.prices = { [USDT]: { usdPrice: 1 } };
    const { result } = renderHook(() => useFundableGeneralBalance());
    expect(result.current).toEqual({ status: "known", fundable: true, tokenIds: [USDT], usd: 5 });
  });

  it("falls back to the registry price when there is no live quote", () => {
    // BTC fallbackUsdPrice is in the tens of thousands: 0.001 BTC is well over the floor.
    state.available = new Map([[BTC, 0.001]]);
    const { result } = renderHook(() => useFundableGeneralBalance());
    expect(result.current).toEqual({ status: "known", fundable: true, tokenIds: [BTC], usd: expect.closeTo(0.001 * getTokenById(BTC)!.fallbackUsdPrice, 6) });
  });

  // 027 A-2: dust is what shows as $0.00 — $0.50 used to be dust under the $1 floor.
  it("is known and not fundable with only dust", () => {
    state.available = new Map([[USDT, 0.004]]);
    state.prices = { [USDT]: { usdPrice: 1 } };
    const { result } = renderHook(() => useFundableGeneralBalance());
    expect(result.current).toEqual({ status: "known", fundable: false, tokenIds: [], usd: 0 });
  });

  it("is known and not fundable with an empty balance", () => {
    const { result } = renderHook(() => useFundableGeneralBalance());
    expect(result.current).toEqual({ status: "known", fundable: false, tokenIds: [], usd: 0 });
  });

  it("follows the balance when funds arrive", () => {
    state.prices = { [USDT]: { usdPrice: 1 } };
    const { result, rerender } = renderHook(() => useFundableGeneralBalance());
    expect(result.current).toMatchObject({ status: "known", fundable: false });
    state.available = new Map([[USDT, 3]]);
    rerender();
    expect(result.current).toEqual({ status: "known", fundable: true, tokenIds: [USDT], usd: 3 });
  });
});
