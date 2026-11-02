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
type Move = { token: string; day: string; delta: string; flow?: string };
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
    const { days } = snapshotsOf(
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
    const { days } = snapshotsOf(
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
    const { days } = snapshotsOf(moves, [
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
      const { days } = snapshotsOf(
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
    const { days } = snapshotsOf(
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
    const { days } = snapshotsOf(
      [
        { token: USDT, day: "2026-10-17", delta: usdt(1) },
        { token: USDT, day: "2026-10-18", delta: `-${usdt(1)}` },
      ],
      [price("2026-10-18", USDT, "1"), price("2026-10-19", USDT, "1")]
    );
    expect(days.map((d) => d.day)).toEqual(["2026-10-18"]);
  });
});

describe("snapshotsOf — what the user moved in or out (D-548)", () => {
  // An allocation's `flow` is its whole delta; a rebalance's is zero.
  const added = (token: string, day: string, qty: string) => ({ token, day, delta: qty, flow: qty });
  const swapped = (token: string, day: string, qty: string) => ({ token, day, delta: qty, flow: "0" });
  const pricesFor = (days: string[], usdt = "1", wnear = "2") =>
    days.flatMap((d) => [price(d, USDT, usdt), price(d, WNEAR, wnear)]);

  it("marks the snapshot after an allocation, at that snapshot's price, never the first one", () => {
    const out = snapshotsOf(
      [added(USDT, "2026-10-17", usdt(10)), added(WNEAR, "2026-10-18", near(3))],
      pricesFor(["2026-10-18", "2026-10-19", "2026-10-20"])
    );
    expect(out.days).toEqual([
      { day: "2026-10-18", tokens: [{ tokenId: USDT, usd: 10 }] },
      { day: "2026-10-19", tokens: [{ tokenId: USDT, usd: 10 }, { tokenId: "near", usd: 6 }], flowUsd: 6 },
      { day: "2026-10-20", tokens: [{ tokenId: USDT, usd: 10 }, { tokenId: "near", usd: 6 }] },
    ]);
    expect(out.nowFlowUsd).toBeUndefined();
  });

  it("a withdrawal is negative, and a rebalance is not a movement of the user's", () => {
    const out = snapshotsOf(
      [
        added(USDT, "2026-10-17", usdt(10)),
        // The 18th: 4 USDT moved out, and a rebalance sold 2 USDT for 1 NEAR — one row per token
        // and day, as MOVES_SQL groups them.
        { token: USDT, day: "2026-10-18", delta: `-${usdt(6)}`, flow: `-${usdt(4)}` },
        swapped(WNEAR, "2026-10-18", near(1)),
      ],
      pricesFor(["2026-10-18", "2026-10-19"])
    );
    expect(out.days[1]).toEqual({
      day: "2026-10-19",
      tokens: [{ tokenId: USDT, usd: 4 }, { tokenId: "near", usd: 2 }],
      flowUsd: -4,
    });
  });

  it("nets the movements of a token: in and out the same amount is no movement", () => {
    const out = snapshotsOf(
      [added(USDT, "2026-10-17", usdt(10)), added(USDT, "2026-10-18", usdt(5)), added(USDT, "2026-10-18", `-${usdt(5)}`)],
      pricesFor(["2026-10-18", "2026-10-19"])
    );
    expect(out.days[1]).not.toHaveProperty("flowUsd");
  });

  it("a day left out passes its movements on to the next snapshot", () => {
    const out = snapshotsOf(
      [added(USDT, "2026-10-17", usdt(1)), added(WNEAR, "2026-10-17", near(1)), added(USDT, "2026-10-18", usdt(3))],
      // No NEAR price on the 19th: that day is left out, and the 18th's 3 USDT show on the 20th.
      [...pricesFor(["2026-10-18"]), price("2026-10-19", USDT, "1"), ...pricesFor(["2026-10-20"], "2")]
    );
    expect(out.days.map((d) => [d.day, d.flowUsd])).toEqual([
      ["2026-10-18", undefined],
      ["2026-10-20", 6],
    ]);
  });

  it("is null when a token moved has no price that day", () => {
    const out = snapshotsOf(
      // The 18th: all the NEAR moved out, so the 19th holds none and has no NEAR price to value it.
      [added(USDT, "2026-10-17", usdt(1)), added(WNEAR, "2026-10-17", near(1)), added(WNEAR, "2026-10-18", `-${near(1)}`)],
      [...pricesFor(["2026-10-18"]), price("2026-10-19", USDT, "1")]
    );
    expect(out.days[1]).toEqual({ day: "2026-10-19", tokens: [{ tokenId: USDT, usd: 1 }], flowUsd: null });
  });

  it("what moved after the last snapshot goes to now, at the last kept price", () => {
    const out = snapshotsOf(
      [added(USDT, "2026-10-17", usdt(10)), added(WNEAR, "2026-10-19", near(2)), added(USDT, "2026-10-20", `-${usdt(1)}`)],
      pricesFor(["2026-10-18", "2026-10-19"], "1", "2.5")
    );
    expect(out.days.map((d) => d.day)).toEqual(["2026-10-18", "2026-10-19"]);
    expect(out.nowFlowUsd).toBe(5 - 1);
  });

  it("an allocation of a token outside the registry is null, not a guess", () => {
    const token = "nep141:not-in-registry.near";
    const out = snapshotsOf(
      [added(USDT, "2026-10-17", usdt(1)), added(token, "2026-10-18", "5"), added(token, "2026-10-18", "-5"), added(token, "2026-10-19", "7")],
      [...pricesFor(["2026-10-18", "2026-10-19"]), price("2026-10-19", token, "1"), price("2026-10-20", USDT, "1")]
    );
    expect(out.days.map((d) => d.day)).toEqual(["2026-10-18", "2026-10-19"]);
    expect(out.nowFlowUsd).toBeNull();
  });
});

