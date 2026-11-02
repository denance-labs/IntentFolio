// @vitest-environment jsdom
// The withdrawal maturity gate (017-9a): the deadline comes from
// `get_portfolio_positions`, and the countdown asks the chain again when it runs out.
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMaturityCountdown } from "./use-maturity-countdown";
import type { PortfolioPosition } from "../lib/vault-read-client";

const NOW = 1_900_000_000_000;
const NOW_SECS = NOW / 1000;

const position = (tokenId: string, maturesAtSecs: number): PortfolioPosition => ({
  tokenId,
  qtyHeld: BigInt(10),
  lockedQty: BigInt(0),
  available: BigInt(10),
  maturesAtSecs,
});

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date", "setInterval", "clearInterval"] });
});
afterEach(() => {
  vi.useRealTimers();
});

/** Lets the pending read resolve and React apply its state. */
const flush = () => act(async () => {});

describe("useMaturityCountdown", () => {
  it("counts down to the chain's deadline for the watched tokens", async () => {
    const readPositions = vi.fn().mockResolvedValue([position("usdc", NOW_SECS + 90)]);
    const { result } = renderHook(() =>
      useMaturityCountdown("p_1", ["usdc"], true, { readPositions })
    );
    await flush();
    expect(result.current).toEqual({ matured: false, remainingSecs: 90, known: true });
    expect(readPositions).toHaveBeenCalledWith("p_1");

    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(result.current.remainingSecs).toBe(60);
  });

  it("asks the chain again when it runs out, and follows a deadline a rebalance moved", async () => {
    const readPositions = vi
      .fn()
      .mockResolvedValueOnce([position("usdc", NOW_SECS + 5)])
      .mockResolvedValueOnce([position("usdc", NOW_SECS + 65)])
      .mockResolvedValue([position("usdc", NOW_SECS + 65)]);
    const { result } = renderHook(() =>
      useMaturityCountdown("p_1", ["usdc"], true, { readPositions })
    );
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(6_000);
    });
    await flush();
    expect(readPositions).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual({ matured: false, remainingSecs: 59, known: true });
  });

  it("opens once the chain agrees it matured, with one read per expiry and no loop", async () => {
    const readPositions = vi.fn().mockResolvedValue([position("usdc", NOW_SECS + 3)]);
    const { result } = renderHook(() =>
      useMaturityCountdown("p_1", ["usdc"], true, { readPositions })
    );
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(4_000);
    });
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current.matured).toBe(true);
    expect(readPositions).toHaveBeenCalledTimes(2);
  });

  it("errs open when the read fails", async () => {
    const readPositions = vi.fn().mockRejectedValue(new Error("RPC HTTP 502"));
    const { result } = renderHook(() =>
      useMaturityCountdown("p_1", ["usdc"], true, { readPositions })
    );
    await flush();
    expect(result.current).toEqual({ matured: true, remainingSecs: 0, known: false });
  });

  it("stops ticking and reading after unmount", async () => {
    const readPositions = vi.fn().mockResolvedValue([position("usdc", NOW_SECS + 3)]);
    const { unmount } = renderHook(() =>
      useMaturityCountdown("p_1", ["usdc"], true, { readPositions })
    );
    await flush();
    unmount();
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(readPositions).toHaveBeenCalledTimes(1);
  });

  it("stays out of the way when disabled, without reading", async () => {
    const readPositions = vi.fn();
    const { result } = renderHook(() =>
      useMaturityCountdown("p_1", ["usdc"], false, { readPositions })
    );
    await flush();
    expect(result.current.matured).toBe(true);
    expect(readPositions).not.toHaveBeenCalled();
  });
});
