// @vitest-environment node
// The Overview's reference prices (D-523): the UTC day it asks for, registry ids, what a CDN may
// keep, and the failures that must hide the change rather than feed it. Against a stub: the SQL is
// one SELECT on `token_price_daily`, which migration 008 grants to `intentfolio_history_reader`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Queryable } from "@/features/vault/lib/ops-records-service";
import { DAY_PRICES_SQL, handleDayPrices } from "./day-prices-service";

const USDT = "nep141:usdt.tether-token.near";
// 02:00 UTC on Oct 23 is still Oct 22 in Buenos Aires: the day must be UTC's.
const NOW = Date.UTC(2026, 9, 23, 2, 0, 0);
const AT = new Date(Date.UTC(2026, 9, 23, 0, 5, 12));
const allow = { check: () => true };

type Row = { token_id: string; price_usd: string; recorded_at: Date };

function stub(rows: Row[] | Error) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const db: Queryable = {
    async query<R>(text: string, values?: unknown[]) {
      calls.push({ text, values: values ?? [] });
      if (rows instanceof Error) throw rows;
      return { rows: rows as R[], rowCount: rows.length };
    },
  };
  return { db, calls };
}

const run = (db: Queryable, over: Partial<Parameters<typeof handleDayPrices>[0]> = {}) =>
  handleDayPrices({ callerKey: "k", db, limiter: allow, now: () => NOW, ...over });

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleDayPrices", () => {
  it("reads the current UTC day and keys prices by registry id", async () => {
    const { db, calls } = stub([
      { token_id: USDT, price_usd: "0.9998", recorded_at: AT },
      { token_id: "nep141:wrap.near", price_usd: "2.31", recorded_at: AT },
    ]);
    const out = await run(db);
    expect(calls).toEqual([{ text: DAY_PRICES_SQL, values: ["2026-10-23"] }]);
    expect(out.status).toBe(200);
    expect(out.body).toEqual({
      ok: true,
      day: "2026-10-23",
      prices: {
        [USDT]: { usd: 0.9998, at: AT.getTime() },
        near: { usd: 2.31, at: AT.getTime() },
      },
    });
    expect(out.cacheControl).toContain("s-maxage=300");
  });

  it("answers an empty day with a short cache, so the first pass shows soon", async () => {
    const out = await run(stub([]).db);
    expect(out.body).toEqual({ ok: true, day: "2026-10-23", prices: {} });
    expect(out.cacheControl).toBe("public, s-maxage=30");
  });

  it("drops a price that is not positive instead of passing it on", async () => {
    const out = await run(stub([{ token_id: USDT, price_usd: "NaN", recorded_at: AT }]).db);
    expect(out.body).toMatchObject({ ok: true, prices: {} });
  });

  it("fails closed when the read throws, and is never cached", async () => {
    const out = await run(stub(new Error("connection reset")).db);
    expect(out.status).toBe(502);
    expect(out.body).toMatchObject({ ok: false, code: "read-failed" });
    expect(out.cacheControl).toBe("no-store");
  });

  it("refuses a caller over the brake before touching the database", async () => {
    const { db, calls } = stub([]);
    const out = await run(db, { limiter: { check: () => false } });
    expect(out.status).toBe(429);
    expect(calls).toHaveLength(0);
  });
});
