// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useWithdrawDialog } from "./use-withdraw-dialog";
import { toBaseUnits } from "@/features/vault/lib/base-units";

function setup() {
  const unallocate = vi.fn<(tokenId: string, qty: number) => void>();
  const hook = renderHook(() =>
    useWithdrawDialog({ removeTarget: vi.fn(), unallocate, isReal: true })
  );
  return { ...hook, unallocate };
}

function row(currentQty: number, usdPrice: number) {
  return {
    id: "row-1",
    tokenId: "tok",
    symbol: "TOK",
    hasToken: true,
    currentQty,
    currentUsd: currentQty * usdPrice,
    token: { usdPrice },
  };
}

// D-322 + D-343: Max is the held quantity, not `currentUsd / price`.
describe("useWithdrawDialog — Max is the held quantity (D-322, D-343)", () => {
  it("2.5 USDT at 0.99987 signs 2500000, not 2499999", () => {
    // The premise: the old USD round trip lands below 2.5 and truncates one unit short.
    expect(toBaseUnits((2.5 * 0.99987) / 0.99987, 6)).toBe("2499999");

    const { result, unallocate } = setup();
    act(() => result.current.withdrawTarget(row(2.5, 0.99987)));
    expect(result.current.withdrawDialog?.maxAmount).toBe(2.5);
    expect(result.current.withdrawDialog?.raw).toBe("2.5");

    act(() => result.current.confirmWithdraw());
    const [, qty] = unallocate.mock.calls[0];
    expect(toBaseUnits(qty, 6)).toBe("2500000");
  });

  it.each([
    // 18 decimals: a qty as `fromBaseUnits` would hand it over.
    { decimals: 18, qty: 0.6162737441174942, price: 3.1 },
    // 24 decimals (NEAR).
    { decimals: 24, qty: 12.345678901234567, price: 2.87 },
  ])("$decimals decimals: the field shows the held figure, untouched by the price", ({ decimals, qty, price }) => {
    const { result, unallocate } = setup();
    act(() => result.current.withdrawTarget(row(qty, price)));
    expect(result.current.withdrawDialog?.maxAmount).toBe(qty);
    expect(result.current.withdrawDialog?.raw).toBe(String(qty));

    act(() => result.current.confirmWithdraw());
    expect(toBaseUnits(unallocate.mock.calls[0][1], decimals)).toBe(toBaseUnits(qty, decimals));
  });

  it("a balance whose price is 0 is still withdrawable", () => {
    const { result } = setup();
    act(() => result.current.withdrawTarget(row(4, 0)));
    expect(result.current.withdrawDialog?.maxAmount).toBe(4);
    expect(result.current.removeEmptyDialog).toBeNull();
  });

  it("an empty position goes to the remove dialog instead", () => {
    const { result } = setup();
    act(() => result.current.withdrawTarget(row(0, 1)));
    expect(result.current.withdrawDialog).toBeNull();
    expect(result.current.removeEmptyDialog?.tokenId).toBe("tok");
  });
});
