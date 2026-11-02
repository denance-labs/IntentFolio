// The transport shell of the Performance read. Validation, SQL, valuation and freshness are
// covered in `portfolio-stats-service.test.ts`; what is only reachable HERE is the wiring: the
// reader's credential (and the 503 without it), the server's own vault, the cache header, and
// that the catch-up pass is handed to `after()` — never run before answering.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { calls, state, afterTasks } = vi.hoisted(() => ({
  calls: [] as Array<{ conn: string; text: string; values: unknown[] }>,
  state: { lastOkAgoMs: 60_000, lastRunAgoMs: 50_000 },
  afterTasks: [] as Array<() => unknown>,
}));

vi.mock("pg", () => ({
  Pool: class MockPool {
    constructor(private readonly config: { connectionString: string }) {}
    async query(text: string, values?: unknown[]) {
      calls.push({ conn: this.config.connectionString, text, values: values ?? [] });
      if (text.includes("FROM history_cursor")) {
        const now = Date.now();
        return {
          rows: [
            {
              backfill_done: true,
              last_ok_at: new Date(now - state.lastOkAgoMs),
              last_run_at: new Date(now - state.lastRunAgoMs),
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [{ day: "2026-10-16", swaps: 4, spread_usd: "0.03", unpriced: [] }], rowCount: 1 };
    }
    async end() {}
    on() {}
  },
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => unknown) => afterTasks.push(task),
}));

vi.mock("@/features/wallet/config/network", () => ({ VAULT_CONTRACT_ID: "intentfolio-vault.near" }));

const { runPass } = vi.hoisted(() => ({ runPass: vi.fn(async () => ({ ran: false, reason: "paced" })) }));
vi.mock("@/features/history-recorder/lib/history-recorder", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/history-recorder/lib/history-recorder")>()),
  runHistoryPass: runPass,
}));

const READER = "postgres://reader:p@127.0.0.1:5432/intentfolio";
const WRITER = "postgres://writer:p@127.0.0.1:5432/intentfolio";
const ENV_KEYS = ["INTENTFOLIO_HISTORY_READER_DB_URL", "INTENTFOLIO_HISTORY_WRITER_DB_URL", "INTENTFOLIO_OPS_DB_SSL"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  calls.length = 0;
  afterTasks.length = 0;
  runPass.mockClear();
  state.lastOkAgoMs = 60_000;
  state.lastRunAgoMs = 50_000;
  process.env.INTENTFOLIO_HISTORY_READER_DB_URL = READER;
  process.env.INTENTFOLIO_HISTORY_WRITER_DB_URL = WRITER;
  process.env.INTENTFOLIO_OPS_DB_SSL = "false";
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const get = (query: string) => new Request(`http://localhost/api/history/portfolio-stats${query}`);

describe("GET /api/history/portfolio-stats", () => {
  it("answers 503 without the reader's credential, uncached", async () => {
    delete process.env.INTENTFOLIO_HISTORY_READER_DB_URL;
    const { GET } = await import("./route");
    const res = await GET(get("?portfolio=p_000000000001"));
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(calls).toHaveLength(0);
  });

  it("reads the given portfolio in the server's own vault, as the reader, cacheable while up to date", async () => {
    const { GET } = await import("./route");
    const res = await GET(get("?portfolio=p_000000000001&vault=someone-else.near"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, swaps: 4, spreadUsd: 0.03, upToDate: true });
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=30, stale-while-revalidate=30");
    expect(calls.map((c) => c.conn)).toEqual([READER, READER]);
    expect(calls[0].values).toEqual(["intentfolio-vault.near"]);
    expect(calls[1].values).toEqual(["intentfolio-vault.near", "p_000000000001"]);
    expect(afterTasks).toHaveLength(0);
  });

  it("a malformed portfolio is a 400 with no query", async () => {
    const { GET } = await import("./route");
    const res = await GET(get("?portfolio=p_1"));
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("behind: answers first, then a catch-up pass as the recorder, never as the reader", async () => {
    state.lastOkAgoMs = 6 * 60 * 60 * 1000;
    state.lastRunAgoMs = 6 * 60 * 60 * 1000;
    const { GET } = await import("./route");
    const res = await GET(get("?portfolio=p_000000000001"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=5");
    // Nothing ran before the answer.
    expect(runPass).not.toHaveBeenCalled();
    expect(afterTasks).toHaveLength(1);

    await afterTasks[0]();
    expect(runPass).toHaveBeenCalledTimes(1);
    const [deps] = runPass.mock.calls[0] as unknown as [{ vaultId: string; budgetMs: number; db: { config: { connectionString: string } } }];
    expect(deps).toMatchObject({ vaultId: "intentfolio-vault.near", budgetMs: 20_000 });
    expect(deps.db.config.connectionString).toBe(WRITER);
  });
});
