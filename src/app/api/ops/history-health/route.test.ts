// The transport shell of the recorder's health endpoint. The threshold, the reasons and the cache
// are covered in `history-health.test.ts`; what is only reachable HERE is the wiring the solver's
// watchdog depends on — the STATUS CODE, which is the entire contract — the reader's credential
// and the server's own vault, and that the database's error never reaches a public body.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { calls, state } = vi.hoisted(() => ({
  calls: [] as Array<{ conn: string; text: string; values: unknown[] }>,
  state: { fail: null as Error | null, lastOkAgoMs: 60_000 as number | null },
}));

vi.mock("pg", () => ({
  Pool: class MockPool {
    constructor(private readonly config: { connectionString: string }) {}
    async query(text: string, values?: unknown[]) {
      calls.push({ conn: this.config.connectionString, text, values: values ?? [] });
      if (state.fail) throw state.fail;
      const rows = state.lastOkAgoMs === null ? [] : [{ last_ok_at: new Date(Date.now() - state.lastOkAgoMs) }];
      return { rows, rowCount: rows.length };
    }
    async end() {}
    on() {}
  },
}));

vi.mock("@/features/wallet/config/network", () => ({ VAULT_CONTRACT_ID: "intentfolio-vault.near" }));

async function loadRoute(env: Record<string, string> = {}) {
  vi.resetModules();
  calls.length = 0;
  state.fail = null;
  state.lastOkAgoMs = 60_000;
  vi.stubEnv("INTENTFOLIO_OPS_DB_SSL", "false");
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return import("./route");
}

const READER = "postgres://reader:p@127.0.0.1:6432/intentfolio";
const CONFIGURED = {
  INTENTFOLIO_HISTORY_READER_DB_URL: READER,
  // Present on purpose: the probe must not borrow the Allocate path's credential.
  INTENTFOLIO_OPS_DB_URL: "postgres://writer:p@127.0.0.1:6432/intentfolio",
};

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/ops/history-health", () => {
  it("answers 200 while the history is recent, reading the server's vault as the reader", async () => {
    const { GET } = await loadRoute(CONFIGURED);

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ conn: READER, values: ["intentfolio-vault.near"] });
    expect(calls[0].text).toContain("history_cursor");
  });

  it("answers 503 when the recorder is behind", async () => {
    const { GET } = await loadRoute(CONFIGURED);
    state.lastOkAgoMs = 4 * 60 * 60 * 1000;

    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ ok: false, reason: "behind" });
  });

  it("answers 503 when nothing was ever recorded", async () => {
    const { GET } = await loadRoute(CONFIGURED);
    state.lastOkAgoMs = null;

    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ ok: false, reason: "never-recorded", recordedUntil: null });
  });

  it("answers 503 without the reader's credential, and dials nothing", async () => {
    const { GET } = await loadRoute({ INTENTFOLIO_OPS_DB_URL: CONFIGURED.INTENTFOLIO_OPS_DB_URL });

    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ ok: false, reason: "not-configured" });
    expect(calls).toHaveLength(0);
  });

  it("never puts the database's error in the body — this endpoint is public", async () => {
    const { GET } = await loadRoute(CONFIGURED);
    state.fail = new Error("connect ECONNREFUSED: postgres://intentfolio_history_reader:s3cr3t@db.internal:6432/x");

    const response = await GET();
    const body = JSON.stringify(await response.json());

    expect(response.status).toBe(503);
    expect(body).not.toContain("s3cr3t");
    expect(body).not.toContain("db.internal");
    expect(body).not.toContain("ECONNREFUSED");
    expect(Object.keys(JSON.parse(body)).sort()).toEqual(["cached", "checkedAt", "ok", "reason", "recordedUntil"]);
  });

  it("forbids intermediary caching and bounds database load by time", async () => {
    const { GET } = await loadRoute(CONFIGURED);

    expect((await GET()).headers.get("cache-control")).toBe("no-store");
    for (let i = 0; i < 20; i += 1) await GET();

    expect(calls).toHaveLength(1);
  });
});
