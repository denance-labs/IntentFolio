// @vitest-environment node
// The isolation ADR-0025 claims: the public withdrawal-record route gets its OWN small pool, so
// a flood on it cannot take the connections the fail-closed Allocate write needs.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { created } = vi.hoisted(() => ({
  created: [] as Array<{ connectionString?: string; max: number; connectionTimeoutMillis: number; query_timeout: number }>,
}));

vi.mock("pg", () => ({
  Pool: class MockPool {
    constructor(config: { max: number; connectionTimeoutMillis: number; query_timeout: number }) {
      created.push(config);
    }
    async end() {}
    on() {}
  },
}));

const ENV = {
  INTENTFOLIO_OPS_DB_URL: "postgres://u:p@127.0.0.1:6432/intentfolio",
  INTENTFOLIO_OPS_DB_SSL: "false",
};

beforeEach(() => {
  vi.resetModules();
  created.length = 0;
});

describe("resolveOpsDb — one pool per slot", () => {
  it("gives the withdrawal route its own one-connection pool, apart from the Allocate one", async () => {
    const { resolveOpsDb } = await import("./ops-db-pool");

    const allocate = resolveOpsDb(ENV);
    const withdraw = resolveOpsDb(ENV, "withdraw");

    expect(allocate.ok && withdraw.ok).toBe(true);
    if (allocate.ok && withdraw.ok) expect(allocate.db).not.toBe(withdraw.db);
    expect(created.map((c) => c.max)).toEqual([3, 1]);
  });

  it("gives the in-flight trade read its own one-connection pool that gives up before the browser does", async () => {
    const { resolveOpsDb } = await import("./ops-db-pool");

    const allocate = resolveOpsDb(ENV);
    const trade = resolveOpsDb(ENV, "trade");

    if (allocate.ok && trade.ok) expect(allocate.db).not.toBe(trade.db);
    expect(created[1]).toMatchObject({ max: 1, connectionTimeoutMillis: 1_500, query_timeout: 1_500 });
    // The Allocate pool keeps its own, longer budget.
    expect(created[0]).toMatchObject({ max: 3, connectionTimeoutMillis: 5_000, query_timeout: 5_000 });
  });

  it("gives the history read its own one-connection pool, as the reader, with time to wake the database", async () => {
    const { resolveHistoryReaderDb, resolveHistoryWriterDb } = await import("./ops-db-pool");
    const env = {
      INTENTFOLIO_HISTORY_READER_DB_URL: "postgres://reader:p@127.0.0.1:5432/intentfolio",
      INTENTFOLIO_HISTORY_WRITER_DB_URL: "postgres://writer:p@127.0.0.1:5432/intentfolio",
      INTENTFOLIO_OPS_DB_SSL: "false",
    };

    const reader = resolveHistoryReaderDb(env);
    const writer = resolveHistoryWriterDb(env);

    if (reader.ok && writer.ok) expect(reader.db).not.toBe(writer.db);
    expect(created[0]).toMatchObject({
      connectionString: env.INTENTFOLIO_HISTORY_READER_DB_URL,
      max: 1,
      connectionTimeoutMillis: 5_000,
      query_timeout: 3_000,
    });
    expect(created[1]).toMatchObject({ connectionString: env.INTENTFOLIO_HISTORY_WRITER_DB_URL, max: 2 });
    expect(resolveHistoryReaderDb({})).toEqual({ ok: false, issues: ["missing INTENTFOLIO_HISTORY_READER_DB_URL"] });
  });

  it("reuses each slot's pool across calls", async () => {
    const { resolveOpsDb } = await import("./ops-db-pool");

    resolveOpsDb(ENV, "withdraw");
    resolveOpsDb(ENV, "withdraw");
    resolveOpsDb(ENV);
    resolveOpsDb(ENV);

    expect(created).toHaveLength(2);
  });
});
