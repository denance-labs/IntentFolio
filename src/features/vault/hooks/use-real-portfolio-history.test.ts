// The browser side of the history route (028-7): one page's fetch, failing loudly, the pages
// joined so that a transaction that came back on a later page counts once, and the asks after
// the user's own operation (d).

import { describe, expect, it, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";
import type { ChainHistoryEvent } from "../lib/vault-history";
import {
  ANNOUNCE_EVERY_MS,
  announceOperation,
  fetchAccountHistoryPage,
  joinPages,
  type AccountHistoryPage,
} from "./use-real-portfolio-history";

vi.mock("../lib/vault-flag", () => ({ VAULT_ROUNDTRIP_ENABLED: true }));

const ev = (txHash: string, index = 0): ChainHistoryEvent => ({
  txHash,
  index,
  ts: 1,
  event: "allocate",
  data: { account_id: "pablofork.near", portfolio_id: "p_000000000001", token: "near", qty: "1" },
});

const page = (events: ChainHistoryEvent[], next: string | null = null): AccountHistoryPage => ({
  ok: true,
  events,
  names: {},
  next,
  recordedUntil: 1,
  upToDate: true,
  loading: false,
  unavailable: false,
});

describe("joinPages", () => {
  it("keeps every event of a transaction, and the transaction only from the first page that brought it", () => {
    const first = page([ev("A", 0), ev("A", 1), ev("B")], "k");
    // B's key moved (an older event of it recorded later): it comes back on the next page.
    const second = page([ev("B"), ev("B", 1), ev("C")]);
    expect(joinPages([first, second]).map((e) => `${e.txHash}:${e.index}`)).toEqual(["A:0", "A:1", "B:0", "C:0"]);
  });
});

describe("fetchAccountHistoryPage", () => {
  it("asks for the account, its portfolio and the page key", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(page([])), { status: 200 }));
    await fetchAccountHistoryPage({ accountId: "pablofork.near", portfolioId: "p_000000000001", before: "123_Tx" }, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith("/api/history/account?account=pablofork.near&portfolio=p_000000000001&before=123_Tx");
  });

  it("throws on anything but a successful answer: never an empty history", async () => {
    const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));
    await expect(fetchAccountHistoryPage({ accountId: "a.near" }, answer(502, { ok: false, code: "read-failed" }))).rejects.toThrow(
      "history answered 502 (read-failed)"
    );
    await expect(fetchAccountHistoryPage({ accountId: "a.near" }, answer(200, { ok: false, code: "x" }))).rejects.toThrow();
    await expect(
      fetchAccountHistoryPage({ accountId: "a.near" }, vi.fn(async () => new Response("<html>", { status: 200 })))
    ).rejects.toThrow();
  });
});

describe("announceOperation", () => {
  const ACCOUNT = "pablofork.near";
  /** A clock the sleeps move, and the route's answers in order (the last one repeats). */
  function harness(answers: Array<{ status?: number; body: unknown } | Error>) {
    let t = 1_000_000;
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      const a = answers[Math.min(urls.length - 1, answers.length - 1)];
      if (a instanceof Error) throw a;
      return new Response(JSON.stringify(a.body), { status: a.status ?? 200 });
    }) as unknown as typeof fetch;
    const invalidateQueries = vi.fn(async () => {});
    const client = { invalidateQueries } as unknown as QueryClient;
    const deps = { fetchImpl, now: () => t, sleep: async (ms: number) => void (t += ms) };
    return { urls, invalidateQueries, client, deps, at: () => t };
  }
  const answer = (extra: Record<string, unknown>) => ({ body: { ...page([]), ...extra } });

  it("with a hash, asks `expect` every 2 s until it is recorded, then refreshes the views once", async () => {
    const h = harness([answer({ expect: "pending" }), answer({ expect: "pending" }), answer({ expect: "recorded" })]);
    await announceOperation(h.client, ACCOUNT, "TX1", h.deps);
    expect(h.urls).toEqual(Array(3).fill("/api/history/account?account=pablofork.near&expect=TX1"));
    expect(h.at()).toBe(1_000_000 + 2 * ANNOUNCE_EVERY_MS);
    expect(h.invalidateQueries).toHaveBeenCalledTimes(1);
    expect(h.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["real-portfolio-history", ACCOUNT] });
  });

  it.each(["not-this-account", "over-cap"])("stops at once when the database says it never will (%s)", async (status) => {
    const h = harness([answer({ expect: status })]);
    await announceOperation(h.client, ACCOUNT, "TX1", h.deps);
    expect(h.urls).toHaveLength(1);
    expect(h.invalidateQueries).toHaveBeenCalledTimes(1);
  });

  it("without a hash, asks `fresh` until the account is recorded up to the moment the operation was seen", async () => {
    const seenAt = 1_000_000;
    const h = harness([answer({ recordedUntil: seenAt - 5_000 }), answer({ recordedUntil: null }), answer({ recordedUntil: seenAt + 900 })]);
    await announceOperation(h.client, ACCOUNT, null, h.deps);
    expect(h.urls).toEqual(Array(3).fill("/api/history/account?account=pablofork.near&fresh=1"));
    expect(h.invalidateQueries).toHaveBeenCalledTimes(1);
  });

  it("gives up after a minute and refreshes the views anyway", async () => {
    const h = harness([answer({ expect: "pending" })]);
    await announceOperation(h.client, ACCOUNT, "TX1", h.deps);
    expect(h.urls).toHaveLength(30);
    expect(h.at() - 1_000_000).toBeLessThan(60_000);
    expect(h.invalidateQueries).toHaveBeenCalledTimes(1);
  });

  it("asks again after a network error or a failed read, not after a refused request", async () => {
    const retried = harness([new TypeError("fetch failed"), { status: 502, body: { ok: false, code: "read-failed" } }, answer({ expect: "recorded" })]);
    await announceOperation(retried.client, ACCOUNT, "TX1", retried.deps);
    expect(retried.urls).toHaveLength(3);

    for (const code of ["bad-request", "not-configured"]) {
      const refused = harness([{ status: code === "bad-request" ? 400 : 503, body: { ok: false, code } }]);
      await announceOperation(refused.client, ACCOUNT, "TX1", refused.deps);
      expect(refused.urls).toHaveLength(1);
      expect(refused.invalidateQueries).toHaveBeenCalledTimes(1);
    }
  });
});
