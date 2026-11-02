// The transport shell of the rescue-verdict read. Validation, SQL and folding are covered in
// `allocate-verdicts-service.test.ts`; what is only reachable HERE is the wiring: the 503
// without a database, the JSON body, and that no cache may keep the answer.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { calls, state } = vi.hoisted(() => ({
  calls: [] as Array<{ text: string; values: unknown[] }>,
  state: { rows: [] as Array<{ record_id: string; verdict: string }> },
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

const ID = "6f1c2a0e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
const post = (body: string) =>
  new Request("http://localhost/api/ops/allocate-verdicts", { method: "POST", body });

describe("POST /api/ops/allocate-verdicts", () => {
  it("answers 503 without a database, and the browser keeps its own reads", async () => {
    delete process.env.INTENTFOLIO_OPS_DB_URL;
    const { POST } = await import("./route");
    const res = await POST(post(JSON.stringify({ ids: [ID] })));
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it("refuses a body that is not JSON", async () => {
    configure();
    const { POST } = await import("./route");
    const res = await POST(post("{"));
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("reads the ids in the body and answers uncached, verdict only", async () => {
    configure();
    state.rows = [{ record_id: ID, verdict: "credited" }];
    const { POST } = await import("./route");
    const res = await POST(post(JSON.stringify({ ids: [ID] })));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, verdicts: { [ID]: "credited" } });
    expect(calls[0].values).toEqual([[ID]]);
  });
});
