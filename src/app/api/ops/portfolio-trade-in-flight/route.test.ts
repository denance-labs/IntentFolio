// The transport shell of the in-flight trade read. Validation, SQL and mapping are covered in
// `trade-in-flight-service.test.ts`; what is only reachable HERE is the wiring: the 503 without
// a database, the query string, the server's own vault, and that no cache may keep the answer.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { calls, state } = vi.hoisted(() => ({
  calls: [] as Array<{ text: string; values: unknown[] }>,
  state: { rows: [] as Array<{ remaining_ms: number }> },
}));

vi.mock("pg", () => ({
  Pool: class MockPool {
    async query(text: string, values?: unknown[]) {
      calls.push({ text, values: values ?? [] });
      return { rows: state.rows, rowCount: state.rows.length };
    }
    async end() {}
    on() {}
  },
}));

vi.mock("@/features/wallet/config/network", () => ({ VAULT_CONTRACT_ID: "intentfolio-vault.near" }));

const ENV_KEYS = ["INTENTFOLIO_OPS_DB_URL", "INTENTFOLIO_OPS_DB_SSL"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  calls.length = 0;
  state.rows = [];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function configure() {
  process.env.INTENTFOLIO_OPS_DB_URL = "postgres://u:p@127.0.0.1:6432/intentfolio";
  process.env.INTENTFOLIO_OPS_DB_SSL = "false";
}

const get = (query: string) => new Request(`http://localhost/api/ops/portfolio-trade-in-flight${query}`);

describe("GET /api/ops/portfolio-trade-in-flight", () => {
  it("answers 503 without a database, and the browser goes ahead", async () => {
    delete process.env.INTENTFOLIO_OPS_DB_URL;
    const { GET } = await import("./route");
    const res = await GET(get("?portfolio=p_00000000000a"));
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it("reads the given portfolio in the server's own vault, uncached", async () => {
    configure();
    state.rows = [{ remaining_ms: 42_000 }];
    const { GET } = await import("./route");
    const res = await GET(get("?portfolio=p_00000000000a&vault=someone-else.near"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, inFlight: true, remainingMs: 42_000 });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(calls[0].values).toEqual(["intentfolio-vault.near", "p_00000000000a"]);
  });

  it("a missing portfolio is a 400", async () => {
    configure();
    const { GET } = await import("./route");
    expect((await GET(get(""))).status).toBe(400);
  });
});
