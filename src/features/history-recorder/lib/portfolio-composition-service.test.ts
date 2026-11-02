// @vitest-environment node
// A portfolio's Evolution read (plan 033-A): validation before the database, the fold of daily
// changes into one snapshot per priced day, the days left out rather than shown wrong, and the
// freshness shared with Performance. Against a stub; the SQL itself runs against the real schema
// in `portfolio-composition-db.integration.test.ts`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Queryable } from "@/features/vault/lib/ops-records-service";
import { CURSOR_SQL, UP_TO_DATE_MS } from "./portfolio-stats-service";
import {
  MOVES_SQL,
  PRICES_SQL,
  handlePortfolioComposition,
  snapshotsOf,
} from "./portfolio-composition-service";

const VAULT = "intentfolio-vault.near";
const PORTFOLIO = "p_000000000001";
const USDT = "nep141:usdt.tether-token.near";
const WNEAR = "nep141:wrap.near";
const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const allow = { check: () => true };

type Cursor = { backfill_done: boolean; last_ok_at: Date | null; last_run_at: Date | null };
type Move = { token: string; day: string; delta: string };
type Price = { day: string; token_id: string; price_usd: string };

const UP_TO_DATE: Cursor = { backfill_done: true, last_ok_at: new Date(NOW - 60_000), last_run_at: new Date(NOW - 50_000) };

const usdt = (units: number) => String(units * 1e6);
const near = (units: number) => `${units}${"0".repeat(24)}`;
const price = (day: string, token_id: string, price_usd: string): Price => ({ day, token_id, price_usd });

function stub(cursor: Cursor | null, moves: Move[] | Error = [], prices: Price[] = []) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const db: Queryable = {
    async query<R>(text: string, values?: unknown[]) {
      calls.push({ text, values: values ?? [] });
      if (text === CURSOR_SQL) return { rows: (cursor ? [cursor] : []) as R[], rowCount: cursor ? 1 : 0 };
      if (moves instanceof Error) throw moves;
      if (text === MOVES_SQL) return { rows: moves as R[], rowCount: moves.length };
      if (text === PRICES_SQL) return { rows: prices as R[], rowCount: prices.length };
      throw new Error(`unexpected query: ${text}`);
    },
  };
  return { db, calls };
}

const run = (db: Queryable, over: Partial<Parameters<typeof handlePortfolioComposition>[0]> = {}) =>
  handlePortfolioComposition({ portfolioId: PORTFOLIO, vaultId: VAULT, callerKey: "k", db, limiter: allow, now: () => NOW, ...over });

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("handlePortfolioComposition — before the database", () => {
  it("refuses anything that is not a vault portfolio id, without a query", async () => {
    for (const bad of [null, "", "p_1", "p_00000000000G", "P_000000000001"]) {
      const { db, calls } = stub(UP_TO_DATE);
      expect(await run(db, { portfolioId: bad })).toMatchObject({ status: 400, body: { code: "bad-request" }, cacheControl: "no-store" });
      expect(calls).toHaveLength(0);
    }
  });

  it("answers 503 without a configured vault and 429 past the brake, without a query", async () => {
    const { db, calls } = stub(UP_TO_DATE);
    expect(await run(db, { vaultId: "" })).toMatchObject({ status: 503, body: { code: "not-configured" } });
    expect(await run(db, { limiter: { check: () => false } })).toMatchObject({ status: 429, body: { code: "too-many-requests" } });
    expect(calls).toHaveLength(0);
  });
});

describe("handlePortfolioComposition — the read", () => {
  it("asks prices only for the tokens moved, from the day after the first movement", async () => {
    const { db, calls } = stub(UP_TO_DATE, [
      { token: USDT, day: "2026-10-17", delta: usdt(10) },
      { token: WNEAR, day: "2026-10-18", delta: near(2) },
    ]);
    await run(db);
    expect(calls.map((c) => c.text)).toEqual([CURSOR_SQL, MOVES_SQL, PRICES_SQL]);
    expect(calls[1].values).toEqual([VAULT, PORTFOLIO]);
    expect(calls[2].values).toEqual([[USDT, WNEAR], "2026-10-17"]);
  });

  it("skips the price query for a portfolio that never moved anything", async () => {
    const { db, calls } = stub(UP_TO_DATE, []);
    const out = await run(db);
    expect(out.body).toMatchObject({ ok: true, days: [] });
    expect(calls).toHaveLength(2);
  });

  it("answers 502 when the database fails, and never caches it", async () => {
    const { db } = stub(UP_TO_DATE, new Error("connection reset"));
    expect(await run(db)).toMatchObject({ status: 502, body: { code: "read-failed" }, cacheControl: "no-store", catchUp: false });
  });

  it("shares Performance's freshness: behind ⇒ short cache and a catch-up pass", async () => {
    const behind: Cursor = { backfill_done: true, last_ok_at: new Date(NOW - UP_TO_DATE_MS - 1), last_run_at: new Date(NOW - 10 * 60_000) };
    const out = await run(stub(behind).db);
    expect(out).toMatchObject({ body: { ok: true, upToDate: false, loading: false }, cacheControl: "public, s-maxage=5", catchUp: true });
    const fresh = await run(stub(UP_TO_DATE).db);
    expect(fresh).toMatchObject({ body: { upToDate: true, recordedUntil: NOW - 60_000 }, catchUp: false });
  });
});

describe("snapshotsOf — one snapshot per priced day, at 00:00 UTC", () => {
  it("counts a day's movements from the next day on, valued at that day's price", () => {
    const days = snapshotsOf(
      [
        { token: USDT, day: "2026-10-17", delta: usdt(10) },
        { token: WNEAR, day: "2026-10-18", delta: near(4) },
      ],
      [
        price("2026-10-18", USDT, "1"),
        price("2026-10-18", WNEAR, "2.5"),
        price("2026-10-19", USDT, "1"),
        price("2026-10-19", WNEAR, "2.5"),
      ]
    );
    expect(days).toEqual([
      { day: "2026-10-18", tokens: [{ tokenId: USDT, usd: 10 }] },
      { day: "2026-10-19", tokens: [{ tokenId: USDT, usd: 10 }, { tokenId: "near", usd: 10 }] },
    ]);
  });

  it("folds a rebalance's two legs and a token that goes to zero drops out", () => {
    const days = snapshotsOf(
      [
        { token: USDT, day: "2026-10-17", delta: usdt(10) },
        // The 18th: a rebalance sold all the USDT for NEAR.
        { token: USDT, day: "2026-10-18", delta: `-${usdt(10)}` },
        { token: WNEAR, day: "2026-10-18", delta: near(5) },
      ],
      [price("2026-10-19", USDT, "1"), price("2026-10-19", WNEAR, "2")]
    );
    expect(days).toEqual([{ day: "2026-10-19", tokens: [{ tokenId: "near", usd: 10 }] }]);
  });

  it("leaves out a day when a token held then has no price, and keeps the days around it", () => {
    const moves = [
      { token: USDT, day: "2026-10-17", delta: usdt(1) },
      { token: WNEAR, day: "2026-10-17", delta: near(1) },
    ];
    const days = snapshotsOf(moves, [
      price("2026-10-18", USDT, "1"),
      price("2026-10-18", WNEAR, "2"),
      price("2026-10-19", USDT, "1"),
      price("2026-10-20", USDT, "1"),
      price("2026-10-20", WNEAR, "2"),
    ]);
    expect(days.map((d) => d.day)).toEqual(["2026-10-18", "2026-10-20"]);
  });

  it("leaves out days holding a token outside the registry, or the line did not name", () => {
    for (const token of ["nep141:not-in-registry.near", ""]) {
      const days = snapshotsOf(
        [
          { token: USDT, day: "2026-10-17", delta: usdt(1) },
          { token, day: "2026-10-17", delta: "5" },
        ],
        [price("2026-10-18", USDT, "1"), price("2026-10-18", token, "1")]
      );
      expect(days).toEqual([]);
    }
  });

  it("leaves out days with a running balance below zero (a gap in the data), not a negative share", () => {
    const days = snapshotsOf(
      [
        { token: USDT, day: "2026-10-17", delta: usdt(1) },
        { token: WNEAR, day: "2026-10-17", delta: `-${near(1)}` },
        { token: WNEAR, day: "2026-10-18", delta: near(2) },
      ],
      [
        price("2026-10-18", USDT, "1"),
        price("2026-10-18", WNEAR, "2"),
        price("2026-10-19", USDT, "1"),
        price("2026-10-19", WNEAR, "2"),
      ]
    );
    expect(days).toEqual([{ day: "2026-10-19", tokens: [{ tokenId: USDT, usd: 1 }, { tokenId: "near", usd: 2 }] }]);
  });

  it("leaves out the days after everything was withdrawn", () => {
    const days = snapshotsOf(
      [
        { token: USDT, day: "2026-10-17", delta: usdt(1) },
        { token: USDT, day: "2026-10-18", delta: `-${usdt(1)}` },
      ],
      [price("2026-10-18", USDT, "1"), price("2026-10-19", USDT, "1")]
    );
    expect(days.map((d) => d.day)).toEqual(["2026-10-18"]);
  });
});
