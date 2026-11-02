// The transport shell of the health endpoint. The probe, the cache and the SQL are covered in
// `ops-health.test.ts`; what is only reachable HERE is the wiring the solver's watchdog depends
// on — the STATUS CODE, which is the entire contract — and the promise that the database's own
// error never reaches a body served to anyone who finds the URL.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { calls, state } = vi.hoisted(() => ({
  calls: [] as string[],
  state: { fail: null as Error | null },
}));

vi.mock("pg", () => ({
  Pool: class MockPool {
    async query(text: string) {
      calls.push(text);
      if (state.fail) throw state.fail;
      return { rows: [], rowCount: 0 };
    }
    async end() {}
    on() {}
  },
}));

async function loadRoute(env: Record<string, string> = {}) {
  vi.resetModules();
  calls.length = 0;
  state.fail = null;
  vi.stubEnv("INTENTFOLIO_OPS_DB_SSL", "false");
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return import("./route");
}

const CONFIGURED = { INTENTFOLIO_OPS_DB_URL: "postgres://u:p@127.0.0.1:6432/intentfolio" };

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/ops/health", () => {
  it("answers 200 when the database is reachable — the only thing the watchdog reads", async () => {
    const { GET } = await loadRoute(CONFIGURED);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.ok).toBe(true);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("allocate_rescue_record");
  });

  it("answers 503 when this deployment has no database configured", async () => {
    const { GET } = await loadRoute();

    const response = await GET();

    expect(response.status).toBe(503);
    expect(response.ok).toBe(false);
    await expect(response.json()).resolves.toMatchObject({ ok: false, reason: "not-configured" });
    // Nothing was dialled: an unconfigured deployment must not be a way to make the endpoint
    // try to open connections.
    expect(calls).toHaveLength(0);
  });

  it("answers 503 when the statement fails", async () => {
    const { GET } = await loadRoute(CONFIGURED);
    state.fail = new Error("permission denied for table allocate_rescue_record");

    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ ok: false, reason: "query-failed" });
  });

  it("never puts the database's error in the body — this endpoint is public", async () => {
    const { GET } = await loadRoute(CONFIGURED);
    state.fail = new Error(
      "connect ECONNREFUSED: postgres://intentfolio_ops_writer:s3cr3t@db.internal:6432/intentfolio"
    );

    const body = JSON.stringify(await (await GET()).json());

    expect(body).not.toContain("s3cr3t");
    expect(body).not.toContain("db.internal");
    expect(body).not.toContain("ECONNREFUSED");
    expect(Object.keys(JSON.parse(body)).sort()).toEqual(["cached", "checkedAt", "ok", "reason"]);
  });

  it("forbids intermediary caching — a stale verdict answers for a window it does not control", async () => {
    const { GET } = await loadRoute(CONFIGURED);
    expect((await GET()).headers.get("cache-control")).toBe("no-store");
  });

  it("bounds database load by TIME, not by request volume", async () => {
    // The endpoint is unauthenticated and the pool holds 3 connections, while the write path
    // is fail-closed: without the cache, hammering this URL would stop every Allocate.
    const { GET } = await loadRoute(CONFIGURED);

    for (let i = 0; i < 20; i += 1) await GET();

    expect(calls).toHaveLength(1);
  });
});
