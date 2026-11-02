// The transport shell of the ingest route. The validation, the SQL and the anti-spam brake are
// covered in `ops-records-service.test.ts` against a stub and in
// `ops-records-db.integration.test.ts` against a real Postgres; what is only reachable HERE is
// the wiring: which env makes the route answer 503, how a caller is identified, and that a
// malformed request body never reaches a connection.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { calls, state, alerts } = vi.hoisted(() => ({
  calls: [] as Array<{ text: string; values: unknown[] }>,
  state: {
    fail: null as Error | null,
    rowCount: 1 as number | null,
    /** What the follow-up existence read answers after an envelope UPDATE matched nothing. */
    existsRowCount: 0,
    /** When set, `send` blocks on it — that is how the ordering test below holds the route. */
    alertGate: null as Promise<void> | null,
  },
  alerts: [] as Array<{ id: string; severity: string; message: string }>,
}));

// `pg` is stubbed rather than dialled: this file is about the shell, and a route test that
// needed a database would not run in CI.
vi.mock("pg", () => ({
  Pool: class MockPool {
    async query(text: string, values?: unknown[]) {
      calls.push({ text, values: values ?? [] });
      if (state.fail) throw state.fail;
      if (text.startsWith("SELECT 1 FROM")) return { rows: [], rowCount: state.existsRowCount };
      return { rows: [{ id: "ok" }], rowCount: state.rowCount };
    }
    async end() {}
    on() {}
  },
}));

// The alerter is captured, not stubbed wholesale: `sanitiseForAlert` stays REAL, because what
// the route puts into a chat message is part of what this file verifies.
vi.mock("@/features/vault/lib/ops-alerts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/vault/lib/ops-alerts")>();
  return {
    ...actual,
    getOpsAlerter: () => ({
      async send(alert: { id: string; severity: string; message: string }) {
        if (state.alertGate) await state.alertGate;
        alerts.push(alert);
      },
    }),
  };
});

const ID = "6f1b3c2a-9d4e-4f7a-8b1c-2e5d7a9c0f31";

function body(over: Record<string, unknown> = {}) {
  return {
    id: ID,
    signerId: "alice.near",
    msg: '{"deadline":1}',
    vaultId: "intentfolio-staging.near",
    portfolioName: "Balanced",
    legs: [{ tokenId: "nep141:wrap.near", amount: "1" }],
    createdAt: 1_760_000_000_000,
    ...over,
  };
}

function request(payload: unknown, init: { method?: string; headers?: Record<string, string> } = {}) {
  return new Request("http://localhost/api/ops/allocate-records", {
    method: init.method ?? "POST",
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

async function loadRoute(env: Record<string, string> = {}) {
  vi.resetModules();
  calls.length = 0;
  alerts.length = 0;
  state.fail = null;
  state.rowCount = 1;
  state.existsRowCount = 0;
  state.alertGate = null;
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

describe("POST /api/ops/allocate-records", () => {
  // The fail-closed consequence ADR-0017 accepts: on a deployment with no database the browser
  // is told the record could not be stored, and it aborts before signing. 503 and not 500 so
  // the cause is legible — "not configured" is an operator problem, not a bug.
  it("answers 503 when the deployment has no database credential", async () => {
    const { POST } = await loadRoute({ INTENTFOLIO_OPS_DB_URL: "" });
    const response = await POST(request(body()));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "not-configured",
      error: expect.stringContaining("INTENTFOLIO_OPS_DB_URL"),
    });
    expect(calls).toHaveLength(0);
  });

  it("stores the record when it is configured", async () => {
    const { POST } = await loadRoute(CONFIGURED);
    const response = await POST(request(body()));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, id: ID, created: true });
    expect(calls[0].text).toContain("INSERT INTO allocate_rescue_record");
  });

  it("answers 400 on a body that is not JSON, without opening a connection", async () => {
    const { POST } = await loadRoute(CONFIGURED);
    const response = await POST(request("not json at all"));
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("answers 400 on a malformed record, without opening a connection", async () => {
    const { POST } = await loadRoute(CONFIGURED);
    const response = await POST(request(body({ id: "nope" })));
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  // The brake is keyed per caller. Two requests with different forwarded addresses must not
  // share a budget — a fail-closed write means a 429 cancels an Allocate rather than slowing
  // it, so one flooder must never be able to spend everyone else's.
  it("separates callers by their forwarded address", async () => {
    const { POST } = await loadRoute(CONFIGURED);
    const a = await POST(request(body(), { headers: { "x-forwarded-for": "1.1.1.1, 10.0.0.1" } }));
    const b = await POST(request(body({ id: "11111111-2222-4333-8444-555555555555" }), {
      headers: { "x-forwarded-for": "2.2.2.2" },
    }));
    expect([a.status, b.status]).toEqual([200, 200]);
  });

  it("survives a request with no forwarded address at all", async () => {
    const { POST } = await loadRoute(CONFIGURED);
    expect((await POST(request(body()))).status).toBe(200);
  });
});

describe("PATCH /api/ops/allocate-records", () => {
  it("updates the lifecycle columns", async () => {
    const { PATCH } = await loadRoute(CONFIGURED);
    const response = await PATCH(
      request({ id: ID, status: "submitted", txHash: "Tx1" }, { method: "PATCH" })
    );
    expect(response.status).toBe(200);
    expect(calls[0].text).toContain("UPDATE allocate_rescue_record");
  });

  it("answers 503 when there is no database, exactly like POST", async () => {
    const { PATCH } = await loadRoute({ INTENTFOLIO_OPS_DB_URL: "" });
    const response = await PATCH(request({ id: ID, status: "credited" }, { method: "PATCH" }));
    expect(response.status).toBe(503);
  });
});

// ── Alerting (ADR-0017 §7, the first of the three failures) ──────────────────────────────
//
// The route owns exactly one of the three alerts: "the frontend's write path is broken". The
// interesting half of this behaviour is what does NOT alert — the endpoint is public and
// unauthenticated, so every condition a stranger can provoke with a request body has to stay
// out of the operator's chat.
describe("alerting", () => {
  const ENABLED = { ...CONFIGURED, NEXT_PUBLIC_OPS_RECORDS: "true" };

  it("alerts when the write fails against a configured database", async () => {
    const { POST } = await loadRoute(ENABLED);
    state.fail = new Error("could not serialize access due to concurrent update");

    const response = await POST(request(body()));

    expect(response.status).toBe(502);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ id: "ops_write_failed", severity: "critical" });
    expect(alerts[0].message).toContain("POST /api/ops/allocate-records");
    expect(alerts[0].message).toContain("Allocates are blocked");
  });

  it("alerts when the deployment is missing its database, and says which variable", async () => {
    const { POST } = await loadRoute({ ...ENABLED, INTENTFOLIO_OPS_DB_URL: "" });

    const response = await POST(request(body()));

    expect(response.status).toBe(503);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ id: "ops_write_not_configured", severity: "critical" });
    expect(alerts[0].message).toContain("INTENTFOLIO_OPS_DB_URL");
  });

  it("alerts on a failed PATCH too, naming the method", async () => {
    const { PATCH } = await loadRoute(ENABLED);
    state.fail = new Error("connection terminated unexpectedly");

    await PATCH(request({ id: ID, status: "credited" }, { method: "PATCH" }));

    expect(alerts).toHaveLength(1);
    expect(alerts[0].id).toBe("ops_write_failed");
    expect(alerts[0].message).toContain("PATCH /api/ops/allocate-records");
  });

  describe("what must never wake anyone up", () => {
    it("stays quiet on a malformed body — a stranger must not reach the operator's phone", async () => {
      const { POST } = await loadRoute(ENABLED);
      expect((await POST(request(body({ id: "nope" })))).status).toBe(400);
      expect((await POST(request("not json"))).status).toBe(400);
      expect(alerts).toEqual([]);
    });

    it("stays quiet on a rate-limited caller", async () => {
      const { POST } = await loadRoute(ENABLED);
      // The default budget is 60 per minute per caller; the 61st is refused.
      let last = 200;
      for (let i = 0; i < 61; i += 1) {
        last = (await POST(request(body(), { headers: { "x-forwarded-for": "9.9.9.9" } }))).status;
      }
      expect(last).toBe(429);
      expect(alerts).toEqual([]);
    });

    it("stays quiet on a PATCH for a record that is not there", async () => {
      // Louder than it looks, and logged as such by the service — but the id comes from the
      // caller, so alerting on it would hand anyone a trigger.
      const { PATCH } = await loadRoute(ENABLED);
      state.rowCount = 0;

      const response = await PATCH(request({ id: ID, status: "credited" }, { method: "PATCH" }));

      expect(response.status).toBe(404);
      expect(alerts).toEqual([]);
    });

    it("stays quiet when a PATCH tries to replace a stored envelope", async () => {
      // D-449: refused with a 409, and the request is exactly what a stranger would send.
      const { PATCH } = await loadRoute(ENABLED);
      state.rowCount = 0;
      state.existsRowCount = 1;

      const response = await PATCH(
        request({ id: ID, signedEnvelope: { standard: "nep413" } }, { method: "PATCH" })
      );

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ ok: false, code: "conflict" });
      expect(alerts).toEqual([]);
    });

    it("stays quiet on a SUCCESSFUL write", async () => {
      const { POST } = await loadRoute(ENABLED);
      expect((await POST(request(body()))).status).toBe(200);
      expect(alerts).toEqual([]);
    });

    // The condition this repo is in TODAY: the flag is off and no database is provisioned, so
    // the route answers 503 to anyone who finds it while every Allocate runs normally — the
    // client never calls this route with the flag off. Alerting there would be a false
    // "Allocates are blocked" fired by the first scanner that walks the URL space.
    it("stays quiet while NEXT_PUBLIC_OPS_RECORDS is off, even on a 503", async () => {
      const { POST } = await loadRoute({ INTENTFOLIO_OPS_DB_URL: "" });

      const response = await POST(request(body()));

      expect(response.status).toBe(503);
      expect(alerts).toEqual([]);
    });

    it("stays quiet on a failed write while the flag is off", async () => {
      const { POST } = await loadRoute(CONFIGURED);
      state.fail = new Error("connection refused");

      expect((await POST(request(body()))).status).toBe(502);
      expect(alerts).toEqual([]);
    });
  });

  it("scrubs credentials out of the database error before it reaches the chat", async () => {
    const { POST } = await loadRoute(ENABLED);
    state.fail = new Error(
      "connect ECONNREFUSED postgres://intentfolio_ops_writer:s3cr3t@db.internal:6432/intentfolio"
    );

    await POST(request(body()));

    expect(alerts[0].message).not.toContain("s3cr3t");
    expect(alerts[0].message).toContain("//***@db.internal");
  });

  it("puts NO user data in the alert — ADR-0017 §8 keeps the row out of third-party channels", async () => {
    const { POST } = await loadRoute(ENABLED);
    state.fail = new Error("insert failed");

    await POST(
      request(
        body({ signerId: "alice.near", portfolioName: "Retirement", legs: [{ tokenId: "nep141:wrap.near", amount: "123456789" }] })
      )
    );

    const message = alerts[0].message;
    expect(message).not.toContain("alice.near");
    expect(message).not.toContain("Retirement");
    expect(message).not.toContain("123456789");
    expect(message).not.toContain(ID);
  });

  // The mutation that survived the first pass, and the reason this test exists: swapping the
  // `await` for a bare call left every other assertion in this file green. It is not cosmetic
  // — a serverless invocation may be frozen the instant the response is returned, so a
  // fire-and-forget alert is dropped exactly during the outage it was meant to report. The
  // route must not answer until the alert has been handed over.
  it("does not answer until the alert has been delivered", async () => {
    const { POST } = await loadRoute(ENABLED);
    state.fail = new Error("connection refused");
    let release: () => void = () => {};
    state.alertGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const pending = POST(request(body()));
    const settled = await Promise.race([
      pending.then(() => "answered" as const),
      new Promise<"still-waiting">((resolve) => setTimeout(() => resolve("still-waiting"), 20)),
    ]);
    expect(settled).toBe("still-waiting");
    expect(alerts).toEqual([]);

    release();
    expect((await pending).status).toBe(502);
    expect(alerts).toHaveLength(1);
  });
});
