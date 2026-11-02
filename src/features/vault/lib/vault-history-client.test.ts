import { describe, expect, it, vi } from "vitest";
import { FastNearRateLimitError, fetchAccountTxPage, fetchIndexedHeadMs } from "./vault-history-client";

const noSleep = async () => {};

function answering(json: unknown, status = 200) {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return new Response(JSON.stringify(json), { status });
  });
  return { fetchImpl, bodies };
}

const ROW = {
  transaction_hash: "6zuZRUkR1bppdVxtUSLDEmyPAx8iGg3BnqgZyF1fQWe4",
  tx_block_height: 220210867,
  // Above 2^53: read as a string, so the milliseconds are exact.
  tx_block_timestamp: "1792146512291701346",
};

describe("fetchAccountTxPage — one page, for a reader that keeps its own place", () => {
  it("returns the rows with their block, and the token for the next page", async () => {
    const { fetchImpl, bodies } = answering({ account_txs: [ROW, ROW], resume_token: "945826779934744577" });
    const page = await fetchAccountTxPage("intentfolio-vault.near", null, { fetchImpl, sleep: noSleep });
    expect(page).toEqual({
      rows: [{ hash: ROW.transaction_hash, blockHeight: 220210867, blockTsMs: 1792146512291 }],
      resumeToken: "945826779934744577",
    });
    expect(bodies).toEqual([{ account_id: "intentfolio-vault.near" }]);
  });

  it("sends the token it is given and reports the last page as null", async () => {
    const { fetchImpl, bodies } = answering({ account_txs: [] });
    const page = await fetchAccountTxPage("v.near", "123", { fetchImpl, sleep: noSleep });
    expect(page).toEqual({ rows: [], resumeToken: null });
    expect(bodies).toEqual([{ account_id: "v.near", resume_token: "123" }]);
  });

  it("refuses a page with a row it cannot place in time", async () => {
    for (const bad of [{ ...ROW, tx_block_height: "1" }, { ...ROW, tx_block_timestamp: 1792146512291701346 }]) {
      const { fetchImpl } = answering({ account_txs: [bad] });
      await expect(fetchAccountTxPage("v.near", null, { fetchImpl, sleep: noSleep })).rejects.toThrow("without its block");
    }
  });
});

describe("the server-side limits", () => {
  it("an empty resume token is the last page, not 'start again'", async () => {
    const { fetchImpl } = answering({ account_txs: [ROW], resume_token: "" });
    expect((await fetchAccountTxPage("v.near", null, { fetchImpl, sleep: noSleep })).resumeToken).toBeNull();
  });

  it("past the deadline no call is made, retries included", async () => {
    const { fetchImpl } = answering({ account_txs: [] });
    await expect(
      fetchAccountTxPage("v.near", null, { fetchImpl, sleep: noSleep, deadlineAt: Date.now() - 1 })
    ).rejects.toThrow("out of time");
    expect(fetchImpl).not.toHaveBeenCalled();

    // A 500 burst stops retrying once the deadline passes.
    let calls = 0;
    const failing = vi.fn(async () => {
      calls += 1;
      return new Response("Internal server error (Clickhouse)", { status: 500 });
    });
    const sleepPast = async () => {
      deadline.at = Date.now() - 1;
    };
    const deadline = { at: Date.now() + 60_000 };
    await expect(
      fetchAccountTxPage("v.near", null, {
        fetchImpl: failing,
        sleep: sleepPast,
        get deadlineAt() {
          return deadline.at;
        },
      })
    ).rejects.toThrow("out of time");
    expect(calls).toBe(1);
  });

  it("waits out a 429 longer than a 500, and goes on when the limit lifts", async () => {
    const waits: number[] = [];
    const statuses = [429, 429, 200];
    const fetchImpl = vi.fn(async () => {
      const status = statuses.shift()!;
      return new Response(JSON.stringify(status === 200 ? { account_txs: [ROW] } : "Too Many Requests"), {
        status,
        headers: { "retry-after": "0" },
      });
    });
    const page = await fetchAccountTxPage("v.near", null, {
      fetchImpl,
      sleep: async (ms) => void waits.push(ms),
      waitOutRateLimit: true,
    });
    expect(page.rows).toHaveLength(1);
    expect(waits).toEqual([2_000, 4_000]);
  });

  it("the browser does not wait a 429 out: it fails at once, as rate-limited", async () => {
    const always429 = vi.fn(async () => new Response("Too Many Requests", { status: 429 }));
    const err = await fetchAccountTxPage("v.near", null, { fetchImpl: always429, sleep: noSleep }).catch((e) => e);
    expect(err).toBeInstanceOf(FastNearRateLimitError);
    expect(always429).toHaveBeenCalledTimes(1);
  });

  it("a wait never runs past the deadline", async () => {
    const waits: number[] = [];
    const statuses = [429, 200];
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ account_txs: [] }), { status: statuses.shift()! })
    );
    await fetchAccountTxPage("v.near", null, {
      fetchImpl,
      sleep: async (ms) => void waits.push(ms),
      waitOutRateLimit: true,
      deadlineAt: Date.now() + 500,
    });
    expect(waits[0]).toBeLessThanOrEqual(500);
  });

  it("a 429 that does not lift ends in FastNearRateLimitError, not a fatal error", async () => {
    const always429 = vi.fn(async () => new Response("Too Many Requests", { status: 429 }));
    const err = await fetchAccountTxPage("v.near", null, { fetchImpl: always429, sleep: noSleep, waitOutRateLimit: true }).catch(
      (e) => e
    );
    expect(err).toBeInstanceOf(FastNearRateLimitError);
    expect(always429).toHaveBeenCalledTimes(5);

    // Out of time while rate-limited says so too.
    const deadline = { at: Date.now() + 60_000 };
    const once = vi.fn(async () => new Response("Too Many Requests", { status: 429 }));
    const cut = await fetchAccountTxPage("v.near", null, {
      fetchImpl: once,
      waitOutRateLimit: true,
      sleep: async () => {
        deadline.at = Date.now() - 1;
      },
      get deadlineAt() {
        return deadline.at;
      },
    }).catch((e) => e);
    expect(cut).toBeInstanceOf(FastNearRateLimitError);
    expect(once).toHaveBeenCalledTimes(1);
  });

  it("retries the service's 500 bursts and then succeeds", async () => {
    const statuses = [500, 500, 500, 200];
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ account_txs: [ROW] }), { status: statuses.shift()! })
    );
    const page = await fetchAccountTxPage("v.near", null, { fetchImpl, sleep: noSleep });
    expect(page.rows).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("throws when the service keeps failing — an error, never an empty history", async () => {
    const always500 = vi.fn(async () => new Response("Internal server error (Clickhouse)", { status: 500 }));
    await expect(fetchAccountTxPage("v.near", null, { fetchImpl: always500, sleep: noSleep })).rejects.toThrow(/500/);
    expect(always500).toHaveBeenCalledTimes(5);
  });

  it("another 4xx is still fatal at once", async () => {
    const { fetchImpl } = answering({ error: "bad" }, 400);
    const err = await fetchAccountTxPage("v.near", null, { fetchImpl, sleep: noSleep }).catch((e) => e);
    expect(err).not.toBeInstanceOf(FastNearRateLimitError);
    expect(String(err)).toContain("answered 400");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reads the indexed head from /status, exactly", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ latest_block_height: 220247659, latest_block_timestamp: "1792168588496218635" }))
    );
    expect(await fetchIndexedHeadMs({ fetchImpl })).toBe(1792168588496);
    const bad = vi.fn(async () => new Response(JSON.stringify({ status: "ok" })));
    await expect(fetchIndexedHeadMs({ fetchImpl: bad })).rejects.toThrow("latest_block_timestamp");
  });
});
