// @vitest-environment node
// A portfolio's Performance read (plan 028-3): validation before the database, the valuation of
// spread recorded without a price, the freshness of the answer and how long a CDN may keep it,
// and when a read starts a catch-up pass. Against a stub; the SQL itself runs against the real
// schema in `portfolio-stats-db.integration.test.ts`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Queryable, TransactionalQueryable } from "@/features/vault/lib/ops-records-service";
import type { PassResult } from "./history-recorder";
import {
  CATCH_UP_BUDGET_MS,
  CURSOR_SQL,
  DAILY_SQL,
  UP_TO_DATE_MS,
  catchUpAfterRead,
  handlePortfolioStats,
} from "./portfolio-stats-service";

const VAULT = "intentfolio-vault.near";
const PORTFOLIO = "p_000000000001";
const USDT = "nep141:usdt.tether-token.near";
const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);
const allow = { check: () => true };

type Cursor = { backfill_done: boolean; last_ok_at: Date | null; last_run_at: Date | null };
type Day = { day: string; swaps: number; spread_usd: string; unpriced: Array<{ token: string; qty: string; price: string | null }> };

const UP_TO_DATE: Cursor = {
  backfill_done: true,
  last_ok_at: new Date(NOW - 60_000),
  last_run_at: new Date(NOW - 50_000),
};

function stub(cursor: Cursor | null, days: Day[] | Error = []) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const db: Queryable = {
    async query<R>(text: string, values?: unknown[]) {
      calls.push({ text, values: values ?? [] });
      if (text === CURSOR_SQL) return { rows: (cursor ? [cursor] : []) as R[], rowCount: cursor ? 1 : 0 };
      if (days instanceof Error) throw days;
      return { rows: days as R[], rowCount: days.length };
    },
  };
  return { db, calls };
}

const run = (db: Queryable, over: Partial<Parameters<typeof handlePortfolioStats>[0]> = {}) =>
  handlePortfolioStats({ portfolioId: PORTFOLIO, vaultId: VAULT, callerKey: "k", db, limiter: allow, now: () => NOW, ...over });

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("handlePortfolioStats — before the database", () => {
  it("refuses anything that is not a vault portfolio id, without a query", async () => {
    for (const bad of [null, "", "p_1", "p_00000000000G", "p_0000000000001", "P_000000000001", "p_000000000001 "]) {
      const { db, calls } = stub(UP_TO_DATE);
      const out = await run(db, { portfolioId: bad });
      expect(out).toMatchObject({ status: 400, body: { ok: false, code: "bad-request" }, cacheControl: "no-store", catchUp: false });
      expect(calls).toHaveLength(0);
    }
  });

  it("answers 503 without a configured vault, without a query", async () => {
    const { db, calls } = stub(UP_TO_DATE);
    expect(await run(db, { vaultId: "" })).toMatchObject({ status: 503, body: { code: "not-configured" } });
    expect(calls).toHaveLength(0);
  });

  it("answers 429 past the caller's brake, without a query", async () => {
    const { db, calls } = stub(UP_TO_DATE);
    expect(await run(db, { limiter: { check: () => false } })).toMatchObject({
      status: 429,
      body: { code: "too-many-requests" },
      cacheControl: "no-store",
    });
    expect(calls).toHaveLength(0);
  });
});

describe("handlePortfolioStats — the read", () => {
  it("asks for this vault's cursor and this portfolio's days", async () => {
    const { db, calls } = stub(UP_TO_DATE);
    await run(db);
    expect(calls).toEqual([
      { text: CURSOR_SQL, values: [VAULT] },
      { text: DAILY_SQL, values: [VAULT, PORTFOLIO] },
    ]);
    // The price is the one kept for the swap's own day, never another day's.
    expect(DAILY_SQL).toContain("p.day = d.day AND p.token_id = d.token_id");
  });

  it("sums swaps and the spread frozen when recorded, day by day, oldest first", async () => {
    const { db } = stub(UP_TO_DATE, [
      { day: "2026-10-15", swaps: 3, spread_usd: "0.010000000000", unpriced: [] },
      { day: "2026-10-16", swaps: 2, spread_usd: "0.002500000000", unpriced: [] },
    ]);
    expect((await run(db)).body).toEqual({
      ok: true,
      swaps: 5,
      spreadUsd: 0.0125,
      spreadIsMinimum: false,
      daily: [
        { day: "2026-10-15", swaps: 3, spreadUsd: 0.01 },
        { day: "2026-10-16", swaps: 2, spreadUsd: 0.0025 },
      ],
      recordedUntil: NOW - 60_000,
      upToDate: true,
      loading: false,
    });
  });

  it("values spread recorded without a price at the price kept for that day", async () => {
    // 593 base units of USDT (6 decimals) at $0.5 = $0.0002965.
    const { db } = stub(UP_TO_DATE, [
      { day: "2026-10-16", swaps: 1, spread_usd: "0", unpriced: [{ token: USDT, qty: "593", price: "0.5" }] },
    ]);
    const body = (await run(db)).body;
    expect(body).toMatchObject({ swaps: 1, spreadIsMinimum: false });
    if (body.ok) {
      expect(body.spreadUsd).toBeCloseTo(0.0002965, 12);
      expect(body.daily[0].spreadUsd).toBeCloseTo(0.0002965, 12);
    }
  });

  it("translates the vault's NEAR to the registry's before reading its decimals", async () => {
    // 1e21 base units of wNEAR (24 decimals) = 0.001 NEAR, at $2.
    const { db } = stub(UP_TO_DATE, [
      { day: "2026-10-16", swaps: 1, spread_usd: "0", unpriced: [{ token: "nep141:wrap.near", qty: "1000000000000000000000", price: "2" }] },
    ]);
    const body = (await run(db)).body;
    if (body.ok) expect(body.spreadUsd).toBeCloseTo(0.002, 12);
    expect(body).toMatchObject({ spreadIsMinimum: false });
  });

  it("a spread it cannot value makes the total a floor, never a guess", async () => {
    for (const part of [
      { token: USDT, qty: "593", price: null }, // no price kept that day
      { token: "nep141:not-in-the-registry.near", qty: "593", price: "1" }, // unknown decimals
    ]) {
      const { db } = stub(UP_TO_DATE, [
        { day: "2026-10-16", swaps: 2, spread_usd: "0.01", unpriced: [part] },
      ]);
      expect((await run(db)).body).toMatchObject({ ok: true, swaps: 2, spreadUsd: 0.01, spreadIsMinimum: true });
    }
  });

  it("a portfolio without rebalances is zero, not an error", async () => {
    const { db } = stub(UP_TO_DATE, []);
    expect((await run(db)).body).toMatchObject({ ok: true, swaps: 0, spreadUsd: 0, daily: [], upToDate: true });
  });

  it("a failed read is a 502 that no cache keeps", async () => {
    const { db } = stub(UP_TO_DATE, new Error("connection terminated"));
    expect(await run(db)).toMatchObject({
      status: 502,
      body: { ok: false, code: "read-failed" },
      cacheControl: "no-store",
      catchUp: false,
    });
  });
});

describe("handlePortfolioStats — freshness, cache and catch-up", () => {
  it("up to date: the CDN may keep it 30 s, and no pass is started", async () => {
    const { db } = stub({ ...UP_TO_DATE, last_ok_at: new Date(NOW - UP_TO_DATE_MS) });
    expect(await run(db)).toMatchObject({
      body: { upToDate: true },
      cacheControl: "public, s-maxage=30, stale-while-revalidate=30",
      catchUp: false,
    });
  });

  it("behind: kept 5 s at most, and a pass is started after answering", async () => {
    const { db } = stub({
      backfill_done: true,
      last_ok_at: new Date(NOW - UP_TO_DATE_MS - 1),
      last_run_at: new Date(NOW - 9 * 60 * 60 * 1000),
    });
    expect(await run(db)).toMatchObject({
      body: { upToDate: false, loading: false },
      cacheControl: "public, s-maxage=5",
      catchUp: true,
    });
  });

  it("behind, but a pass is running or just ended: none is started", async () => {
    for (const lastRun of [NOW + 100_000, NOW - 30_000]) {
      const { db } = stub({ backfill_done: true, last_ok_at: new Date(NOW - 3 * UP_TO_DATE_MS), last_run_at: new Date(lastRun) });
      expect(await run(db)).toMatchObject({ body: { upToDate: false }, catchUp: false });
    }
  });

  it("before the recorder ever ran for this vault: loading, nothing recorded, a pass is started", async () => {
    const { db } = stub(null);
    expect(await run(db)).toMatchObject({
      status: 200,
      body: { ok: true, recordedUntil: null, upToDate: false, loading: true },
      catchUp: true,
    });
  });

  it("during the initial load: loading, whatever the age", async () => {
    const { db } = stub({ ...UP_TO_DATE, backfill_done: false });
    expect((await run(db)).body).toMatchObject({ upToDate: true, loading: true });
  });
});

describe("catchUpAfterRead", () => {
  const DB = {} as TransactionalQueryable;
  const RAN: PassResult = {
    ran: true,
    ok: true,
    recordedTxs: 1,
    recordedEvents: 1,
    stuck: [],
    droppedCalls: [],
    accounts: [],
    liveComplete: true,
    backfillDone: true,
    stoppedBy: null,
    pages: 1,
    ms: 300,
  };

  it("runs one short pass for the vault, as the recorder, and logs it", async () => {
    const run = vi.fn(async () => RAN);
    await catchUpAfterRead({ vaultId: VAULT, resolveDb: () => ({ ok: true, db: DB }), run });
    expect(run).toHaveBeenCalledWith({ db: DB, vaultId: VAULT, budgetMs: CATCH_UP_BUDGET_MS });
    expect(console.log).toHaveBeenCalledWith(`[history] ${JSON.stringify(RAN)}`);
  });

  it("a paced pass says nothing", async () => {
    await catchUpAfterRead({
      vaultId: VAULT,
      resolveDb: () => ({ ok: true, db: DB }),
      run: async () => ({ ran: false, reason: "paced" }),
    });
    expect(console.log).not.toHaveBeenCalled();
  });

  it("without the recorder's credential there is no pass, and the read is not affected", async () => {
    const run = vi.fn(async () => RAN);
    await catchUpAfterRead({ vaultId: VAULT, resolveDb: () => ({ ok: false, issues: ["missing X"] }), run });
    expect(run).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith("[history] no catch-up pass: missing X");
  });

  it("never throws: nobody is waiting for it", async () => {
    await expect(
      catchUpAfterRead({
        vaultId: VAULT,
        resolveDb: () => ({ ok: true, db: DB }),
        run: async () => Promise.reject(new Error("boom")),
      })
    ).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith("[history] catch-up pass threw: boom");
  });
});
