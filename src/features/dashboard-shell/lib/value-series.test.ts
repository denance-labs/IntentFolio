import { describe, expect, it } from "vitest";
import { buildValueSeries, type ValueSeriesInput } from "./value-series";

const NEAR = "near";
const USDT = "nep141:usdt.tether-token.near";
const NOW = Date.UTC(2026, 9, 31, 15, 0, 0);

const base: ValueSeriesInput = {
  days: [
    { day: "2026-10-29", tokens: [{ tokenId: NEAR, usd: 30 }, { tokenId: USDT, usd: 70 }] },
    { day: "2026-10-30", tokens: [{ tokenId: NEAR, usd: 50 }, { tokenId: USDT, usd: 55 }] },
  ],
  nowUsd: 110,
  now: NOW,
  rangeDays: 30,
};

describe("buildValueSeries", () => {
  it("sums each recorded day at 00:00 UTC, then adds now from the live value", () => {
    expect(buildValueSeries(base)).toEqual([
      { timestamp: Date.UTC(2026, 9, 29), valueUsd: 100, day: "2026-10-29" },
      { timestamp: Date.UTC(2026, 9, 30), valueUsd: 105, day: "2026-10-30" },
      { timestamp: NOW, valueUsd: 110, day: null },
    ]);
  });

  it("leaves now out until live prices are in, rather than valuing it at fallback prices", () => {
    expect(buildValueSeries({ ...base, nowUsd: null }).map((p) => p.day)).toEqual(["2026-10-29", "2026-10-30"]);
  });

  it("keeps a day the read left out absent — no point is invented for it", () => {
    const days = [base.days[0], { day: "2026-10-31", tokens: [{ tokenId: NEAR, usd: 40 }] }];
    expect(buildValueSeries({ ...base, days, nowUsd: null }).map((p) => p.day)).toEqual(["2026-10-29", "2026-10-31"]);
  });

  it("drops days older than the range", () => {
    const old = { day: "2026-10-20", tokens: [{ tokenId: NEAR, usd: 10 }] };
    const points = buildValueSeries({ ...base, days: [old, ...base.days], rangeDays: 7 });
    expect(points.map((p) => p.day)).toEqual(["2026-10-29", "2026-10-30", null]);
  });

  it("has no point for a portfolio worth nothing", () => {
    const days = [{ day: "2026-10-30", tokens: [] }];
    expect(buildValueSeries({ ...base, days, nowUsd: 0 })).toEqual([]);
  });
});
