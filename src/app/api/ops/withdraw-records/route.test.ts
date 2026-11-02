// The transport shell of the withdrawal-record ingest. Validation and SQL are covered in
// `withdraw-records-service.test.ts`; what is only reachable HERE is the wiring — the 503
// without a database, and the alert: WARN (never critical, ADR-0025 §2), gated on the flag,
// and free of user data.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { calls, state, alerts } = vi.hoisted(() => ({
  calls: [] as Array<{ text: string; values: unknown[] }>,
  state: { fail: null as Error | null, rowCount: 1 as number | null },
  alerts: [] as Array<{ id: string; severity: string; message: string }>,
}));

vi.mock("pg", () => ({
  Pool: class MockPool {
    async query(text: string, values?: unknown[]) {
      calls.push({ text, values: values ?? [] });
      if (state.fail) throw state.fail;
      return { rows: [{ id: "ok" }], rowCount: state.rowCount };
    }
    async end() {}
    on() {}
  },
}));

vi.mock("@/features/vault/lib/ops-alerts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/vault/lib/ops-alerts")>();
  return {
    ...actual,
    getOpsAlerter: () => ({
      async send(alert: { id: string; severity: string; message: string }) {
        alerts.push(alert);
      },
    }),
  };
});

const ID = "2f1c8a4e-6b3d-4c2a-9e1f-0a1b2c3d4e5f";

function body(over: Record<string, unknown> = {}) {
  return {
    id: ID,
    kind: "direct",
    signerId: "alice.near",
    tokenId: "nep141:wrap.near",
    amount: "1000000",
    chainId: "near:mainnet",
    route: "near-unwrap",
    destinationAddress: "bob.near",
    nonce: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
    deadline: 1_760_011_800_000,
    signedPayload: { standard: "nep413", payload: { message: "{}" }, signature: "ed25519:sig" },
    createdAt: 1_760_011_200_000,
    ...over,
  };
}

function request(payload: unknown, method = "POST") {
  return new Request("http://localhost/api/ops/withdraw-records", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function loadRoute(env: Record<string, string> = {}) {
  vi.resetModules();
  calls.length = 0;
  alerts.length = 0;
  state.fail = null;
  state.rowCount = 1;
  vi.stubEnv("INTENTFOLIO_OPS_DB_SSL", "false");
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return import("./route");
}

const CONFIGURED = { INTENTFOLIO_OPS_DB_URL: "postgres://u:p@127.0.0.1:6432/intentfolio" };
const ENABLED = { ...CONFIGURED, NEXT_PUBLIC_WITHDRAW_RECORDS: "true" };

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("/api/ops/withdraw-records", () => {
  it("answers 503 without a database, before any connection", async () => {
    const { POST } = await loadRoute({ INTENTFOLIO_OPS_DB_URL: "" });
    const response = await POST(request(body()));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ ok: false, code: "not-configured" });
    expect(calls).toHaveLength(0);
  });

  it("stores the record, and updates its hints", async () => {
    const { POST, PATCH } = await loadRoute(CONFIGURED);
    expect((await POST(request(body()))).status).toBe(200);
    expect((await PATCH(request({ id: ID, status: "settled", txHash: "Gx1" }, "PATCH"))).status).toBe(200);
    expect(calls.map((c) => c.text.split(" ").slice(0, 2).join(" "))).toEqual([
      "INSERT INTO",
      "UPDATE withdraw_record",
    ]);
  });

  it("alerts a failed write at WARN — withdrawals still go out", async () => {
    const { POST } = await loadRoute(ENABLED);
    state.fail = new Error("relation \"withdraw_record\" does not exist");

    expect((await POST(request(body()))).status).toBe(502);
    expect(alerts).toEqual([
      expect.objectContaining({ id: "withdraw_write_failed", severity: "warn" }),
    ]);
  });

  it("alerts a missing database at WARN too, under its own id", async () => {
    const { POST } = await loadRoute({ INTENTFOLIO_OPS_DB_URL: "", NEXT_PUBLIC_WITHDRAW_RECORDS: "true" });
    await POST(request(body()));
    expect(alerts).toEqual([
      expect.objectContaining({ id: "withdraw_write_not_configured", severity: "warn" }),
    ]);
  });

  it("puts no user data in the alert", async () => {
    const { POST } = await loadRoute(ENABLED);
    state.fail = new Error("boom");
    await POST(request(body()));
    const message = alerts.map((a) => a.message).join("\n");
    for (const secret of ["alice.near", "bob.near", "1000000"]) expect(message).not.toContain(secret);
  });

  it("stays quiet while the flag is off, and on anything a stranger can provoke", async () => {
    const off = await loadRoute(CONFIGURED);
    state.fail = new Error("boom");
    await off.POST(request(body()));
    expect(alerts).toEqual([]);

    const on = await loadRoute(ENABLED);
    await on.POST(request(body({ amount: "nope" })));
    state.rowCount = 0;
    await on.PATCH(request({ id: ID, status: "settled" }, "PATCH"));
    expect(alerts).toEqual([]);
  });
});
