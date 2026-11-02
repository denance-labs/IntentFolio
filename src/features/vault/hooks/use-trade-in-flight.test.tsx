// @vitest-environment jsdom
// The confirm modal's wait for a settling trade (D-471): asks on open and while open, counts
// down between answers, re-reads the portfolio when the wait ends, errs open, and never waits
// more than 90 s per opening however many trades follow (945 §11 A2).

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TRADE_MODAL_WAIT_CAP_MS,
  TRADE_POLL_IDLE_MS,
  TRADE_POLL_WAITING_MS,
  useTradeInFlight,
} from "./use-trade-in-flight";
import type { TradeInFlightAnswer } from "../lib/trade-in-flight-client";

const FREE: TradeInFlightAnswer = { inFlight: false, remainingMs: 0 };
const inFlight = (remainingMs: number): TradeInFlightAnswer => ({ inFlight: true, remainingMs });

/** A read that answers from a queue; the last answer repeats. */
function scripted(...answers: TradeInFlightAnswer[]) {
  const read = vi.fn(async () => (answers.length > 1 ? answers.shift()! : answers[0]));
  return read;
}

/** Lets the pending read resolve and React apply what it set. */
const settle = () => act(async () => {});
const advance = (ms: number) => act(async () => vi.advanceTimersByTime(ms));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useTradeInFlight", () => {
  it("asks nothing without a portfolio (not live, or signing)", async () => {
    const read = scripted(inFlight(30_000));
    const { result } = renderHook(() => useTradeInFlight(null, undefined, read));
    await settle();
    await advance(TRADE_POLL_IDLE_MS * 3);
    expect(read).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });

  it("nothing settling: no wait, and it keeps asking every 5 s", async () => {
    const read = scripted(FREE);
    const { result } = renderHook(() => useTradeInFlight("p_00000000000a", undefined, read));
    await settle();
    expect(result.current).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
    await advance(TRADE_POLL_IDLE_MS);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("a settling trade: counts down locally, asks every 3 s, and re-reads once it closes", async () => {
    const read = scripted(inFlight(25_000), inFlight(22_000), FREE);
    const onSettled = vi.fn();
    const { result } = renderHook(() => useTradeInFlight("p_00000000000a", onSettled, read));
    await settle();
    expect(result.current).toBe(25);

    await advance(1_000);
    expect(result.current).toBe(24);

    await advance(TRADE_POLL_WAITING_MS - 1_000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(result.current).toBe(22);
    expect(onSettled).not.toHaveBeenCalled();

    await advance(TRADE_POLL_WAITING_MS);
    expect(result.current).toBeNull();
    expect(onSettled).toHaveBeenCalledTimes(1);

    // Free again: back to the idle pace, and no second re-read for the same wait.
    await advance(TRADE_POLL_IDLE_MS);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("a failed or unanswered read is a free one (the client already maps it)", async () => {
    const read = vi.fn(async () => FREE);
    const onSettled = vi.fn();
    const { result } = renderHook(() => useTradeInFlight("p_00000000000a", onSettled, read));
    await settle();
    expect(result.current).toBeNull();
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("never waits more than 90 s per opening, even if new trades keep opening", async () => {
    // Every answer is a fresh trade with the server's full 90 s ahead of it.
    const read = scripted(inFlight(90_000));
    const onSettled = vi.fn();
    const { result } = renderHook(() => useTradeInFlight("p_00000000000a", onSettled, read));
    await settle();
    expect(result.current).toBe(90);

    await advance(TRADE_MODAL_WAIT_CAP_MS - 1_000);
    expect(result.current).toBe(1);

    await advance(TRADE_POLL_WAITING_MS);
    expect(result.current).toBeNull();
    expect(onSettled).toHaveBeenCalledTimes(1);

    // It stopped asking: this opening has waited all it will.
    const calls = read.mock.calls.length;
    await advance(TRADE_POLL_IDLE_MS * 4);
    expect(read).toHaveBeenCalledTimes(calls);
    expect(result.current).toBeNull();
  });

  it("stops asking when the modal stops being a candidate (signing or closed)", async () => {
    const read = scripted(inFlight(30_000));
    const { result, rerender } = renderHook(({ id }) => useTradeInFlight(id, undefined, read), {
      initialProps: { id: "p_00000000000a" as string | null },
    });
    await settle();
    expect(result.current).toBe(30);

    rerender({ id: null });
    expect(result.current).toBeNull();
    const calls = read.mock.calls.length;
    await advance(TRADE_POLL_WAITING_MS * 3);
    expect(read).toHaveBeenCalledTimes(calls);
  });
});
