// @vitest-environment node
// The in-flight trade read (D-471): validation, the 007 query's parameters and how its answer
// maps to `{inFlight, remainingMs}`. Against a stub; the SQL itself is proven by
// `trade-in-flight-db.integration.test.ts`.

import { describe, expect, it, vi } from "vitest";
import type { Queryable } from "./ops-records-service";
import { handleTradeInFlight, TRADE_IN_FLIGHT_CAP_MS, TRADE_IN_FLIGHT_SQL } from "./trade-in-flight-service";

const VAULT = "intentfolio-vault.near";
const PORTFOLIO = "p_00000000000a";
const allow = { check: () => true };

function stub(result: Array<{ remaining_ms: unknown }> | Error) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const db: Queryable = {
    async query<R>(text: string, values?: unknown[]) {
      calls.push({ text, values: values ?? [] });
      if (result instanceof Error) throw result;
      return { rows: result as R[], rowCount: result.length };
    },
  };
  return { db, calls };
}

const run = (db: Queryable, over: Partial<Parameters<typeof handleTradeInFlight>[0]> = {}) =>
  handleTradeInFlight({ portfolioId: PORTFOLIO, vaultId: VAULT, callerKey: "k", db, limiter: allow, ...over });

describe("handleTradeInFlight", () => {
  it("asks for this vault and this portfolio, with the 007 rule", async () => {
    const { db, calls } = stub([]);
    await run(db);
    expect(calls).toEqual([{ text: TRADE_IN_FLIGHT_SQL, values: [VAULT, PORTFOLIO] }]);
    // The closed is matched per (quote, portfolio), and both clocks are the database's.
    expect(TRADE_IN_FLIGHT_SQL).toContain("c.quote_hash = o.quote_hash AND c.portfolio_id = o.portfolio_id");
    expect(TRADE_IN_FLIGHT_SQL).toContain("now() - interval '90 seconds'");
    expect(TRADE_IN_FLIGHT_SQL).toContain("90000 - EXTRACT(EPOCH FROM now() - o.at) * 1000");
  });

  it("no row ⇒ go ahead", async () => {
    const { db } = stub([]);
    expect(await run(db)).toEqual({ status: 200, body: { ok: true, inFlight: false, remainingMs: 0 } });
  });

  it("an open trade ⇒ in flight, with the database's remaining time", async () => {
    const { db } = stub([{ remaining_ms: 61_250 }]);
    expect(await run(db)).toEqual({ status: 200, body: { ok: true, inFlight: true, remainingMs: 61_250 } });
  });

  it("never reports more than the cap, nor a negative or unreadable wait", async () => {
    expect((await run(stub([{ remaining_ms: 500_000 }]).db)).body).toMatchObject({
      inFlight: true,
      remainingMs: TRADE_IN_FLIGHT_CAP_MS,
    });
    for (const odd of [0, -5, "x", null]) {
      expect((await run(stub([{ remaining_ms: odd }]).db)).body).toEqual({ ok: true, inFlight: false, remainingMs: 0 });
    }
  });

  it("refuses anything that is not a vault portfolio id, before touching the database", async () => {
    for (const bad of [null, "", "p_1", "p_00000000000A", "p_00000000000a ", "x_00000000000a", "p_00000000000a'--"]) {
      const { db, calls } = stub([]);
      const result = await run(db, { portfolioId: bad });
      expect(result.status).toBe(400);
      expect(calls).toHaveLength(0);
    }
  });

  it("without a configured vault it answers 503 and reads nothing", async () => {
    const { db, calls } = stub([]);
    expect((await run(db, { vaultId: "" })).status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it("a caller over the brake gets 429 and reads nothing", async () => {
    const { db, calls } = stub([]);
    expect((await run(db, { limiter: { check: () => false } })).status).toBe(429);
    expect(calls).toHaveLength(0);
  });

  it("a failed read is a 502 the browser treats as go-ahead, logged without its parameters", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await run(stub(new Error("Query read timeout")).db);
    expect(result).toEqual({
      status: 502,
      body: { ok: false, code: "read-failed", error: "Could not read the in-flight trade state" },
    });
    expect(warn).toHaveBeenCalledWith(`[ops] trade-in-flight read failed for ${PORTFOLIO}: Query read timeout`);
    warn.mockRestore();
  });
});
