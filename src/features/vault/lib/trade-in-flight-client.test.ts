// The browser read of the in-flight trade route (D-471): only a well-formed "in flight" holds
// the user; anything else — an error status, a bad body, a network failure, a slow answer —
// is "go ahead".

import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTradeInFlight, TRADE_IN_FLIGHT_TIMEOUT_MS } from "./trade-in-flight-client";

const json = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

const FREE = { inFlight: false, remainingMs: 0 };

afterEach(() => vi.useRealTimers());

describe("fetchTradeInFlight", () => {
  it("asks for the portfolio, uncached, and passes an in-flight answer through", async () => {
    const fetchImpl = json({ ok: true, inFlight: true, remainingMs: 41_000 });
    expect(await fetchTradeInFlight("p_00000000000a", fetchImpl)).toEqual({ inFlight: true, remainingMs: 41_000 });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/ops/portfolio-trade-in-flight?portfolio=p_00000000000a",
      expect.objectContaining({ method: "GET", cache: "no-store" })
    );
  });

  it("anything that is not a well-formed in-flight answer is go-ahead", async () => {
    const answers = [
      json({ ok: true, inFlight: false, remainingMs: 0 }),
      json({ ok: false, code: "read-failed" }, 502),
      json({ ok: false, code: "not-configured" }, 503),
      json({ ok: true, inFlight: true, remainingMs: "soon" }),
      json({ ok: true, inFlight: true, remainingMs: 0 }),
      json({ inFlight: true, remainingMs: 5_000 }),
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    ];
    for (const fetchImpl of answers) {
      expect(await fetchTradeInFlight("p_00000000000a", fetchImpl as unknown as typeof fetch)).toEqual(FREE);
    }
  });

  it("gives up after 2 s and goes ahead", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        })
    );
    const pending = fetchTradeInFlight("p_00000000000a", fetchImpl as unknown as typeof fetch);
    await vi.advanceTimersByTimeAsync(TRADE_IN_FLIGHT_TIMEOUT_MS);
    expect(await pending).toEqual(FREE);
  });
});
