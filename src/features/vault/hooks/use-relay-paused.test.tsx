// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRelayPaused } from "./use-relay-paused";

const answer = (paused: boolean) =>
  vi.fn(async () => new Response(JSON.stringify({ paused }), { headers: { "Content-Type": "application/json" } }));

describe("useRelayPaused", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks the relay once when active, and reports a pause", async () => {
    const fetchMock = answer(true);
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useRelayPaused(true));

    expect(result.current).toBe(false); // open until the answer lands
    await waitFor(() => expect(result.current).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("asks nothing when the confirmation does not go through the relay", async () => {
    const fetchMock = answer(true);
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useRelayPaused(false));

    await Promise.resolve();
    expect(result.current).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stays open when the relay is not paused", async () => {
    const fetchMock = answer(false);
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useRelayPaused(true));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });
});
