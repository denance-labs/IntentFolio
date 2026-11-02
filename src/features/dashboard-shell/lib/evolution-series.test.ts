import { describe, expect, it } from "vitest";
import { buildTokenColorMap } from "@/features/portfolio-editor/lib/format";
import { buildEvolutionSeries, hasCurve, sliceEvolution, type EvolutionInput } from "./evolution-series";

// Registry order: NEAR, USDC (NEAR), USDC (Ethereum), … SOL (6th), … USDT (NEAR).
const NEAR = "near";
const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const USDC_ETH = "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near";
const SOL = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";
const USDT = "nep141:usdt.tether-token.near";

const NOW = Date.UTC(2026, 9, 30, 15, 0, 0);

// The donut's map: USDT first (a target row), then NEAR — not registry order.
const DONUT = buildTokenColorMap([USDT, NEAR]);

const base: EvolutionInput = {
  days: [
    { day: "2026-10-28", tokens: [{ tokenId: NEAR, usd: 30 }, { tokenId: USDT, usd: 70 }] },
    { day: "2026-10-29", tokens: [{ tokenId: NEAR, usd: 50 }, { tokenId: USDT, usd: 50 }] },
  ],
  nowRows: [
    { tokenId: USDT, currentUsd: 60 },
    { tokenId: NEAR, currentUsd: 40 },
  ],
  now: NOW,
  colorByToken: DONUT,
};

const sum = (shares: Record<string, number>) => Object.values(shares).reduce((a, b) => a + b, 0);

describe("buildEvolutionSeries", () => {
  it("one point per recorded day at 00:00 UTC, then now from the donut's rows", () => {
    const { points } = buildEvolutionSeries(base);
    expect(points.map((p) => [p.ts, p.day])).toEqual([
      [Date.UTC(2026, 9, 28), "2026-10-28"],
      [Date.UTC(2026, 9, 29), "2026-10-29"],
      [NOW, null],
    ]);
    expect(points[2]).toMatchObject({ totalUsd: 100, usd: { [USDT]: 60, [NEAR]: 40 } });
    expect(points[2].shares[USDT]).toBeCloseTo(60);
  });

  it("every point's shares add up to 100", () => {
    const { points } = buildEvolutionSeries({
      ...base,
      days: [{ day: "2026-10-29", tokens: [{ tokenId: NEAR, usd: 1 / 3 }, { tokenId: USDT, usd: 2 / 7 }, { tokenId: SOL, usd: 0.1 }] }],
    });
    for (const p of points) expect(sum(p.shares)).toBeCloseTo(100, 9);
  });

  it("tokens keep the donut's order and colors", () => {
    const { tokens } = buildEvolutionSeries(base);
    expect(tokens).toEqual([
      { tokenId: USDT, color: DONUT.get(USDT) },
      { tokenId: NEAR, color: DONUT.get(NEAR) },
    ]);
  });

  it("a token no longer held goes after the donut's, in registry order, without shifting a donut color", () => {
    const { tokens } = buildEvolutionSeries({
      ...base,
      days: [
        { day: "2026-10-27", tokens: [{ tokenId: SOL, usd: 10 }, { tokenId: USDC, usd: 10 }, { tokenId: NEAR, usd: 10 }] },
        ...base.days,
      ],
    });
    const all = buildTokenColorMap([USDT, NEAR, USDC, SOL]);
    expect(tokens.map((t) => t.tokenId)).toEqual([USDT, NEAR, USDC, SOL]);
    expect(tokens.map((t) => t.color)).toEqual([USDT, NEAR, USDC, SOL].map((id) => all.get(id)));
    expect(tokens[0].color).toBe(DONUT.get(USDT));
    expect(tokens[1].color).toBe(DONUT.get(NEAR));
  });

  it("a donut token at zero all along keeps its color slot but stays out of the curve", () => {
    const donut = buildTokenColorMap([USDC_ETH, USDT, NEAR]);
    const { tokens } = buildEvolutionSeries({ ...base, colorByToken: donut });
    expect(tokens).toEqual([
      { tokenId: USDT, color: donut.get(USDT) },
      { tokenId: NEAR, color: donut.get(NEAR) },
    ]);
  });

  it("leaves out a moment worth nothing, and tokens at zero", () => {
    const { points } = buildEvolutionSeries({
      ...base,
      nowRows: [
        { tokenId: USDT, currentUsd: 0 },
        { tokenId: NEAR, currentUsd: 0 },
      ],
      days: [{ day: "2026-10-29", tokens: [{ tokenId: NEAR, usd: 50 }, { tokenId: USDT, usd: 0 }] }],
    });
    expect(points).toHaveLength(1);
    expect(points[0].usd).toEqual({ [NEAR]: 50 });
    expect(points[0].shares).toEqual({ [NEAR]: 100 });
  });

  it("without the live portfolio, only the recorded days", () => {
    expect(buildEvolutionSeries({ ...base, nowRows: null }).points.map((p) => p.day)).toEqual(["2026-10-28", "2026-10-29"]);
  });
});

describe("hasCurve", () => {
  it("needs two points: a new portfolio with only now has none", () => {
    expect(hasCurve(buildEvolutionSeries({ ...base, days: [] }))).toBe(false);
    expect(hasCurve(buildEvolutionSeries({ ...base, days: base.days.slice(1) }))).toBe(true);
  });
});

describe("sliceEvolution", () => {
  const long = buildEvolutionSeries({
    ...base,
    days: [
      { day: "2026-10-17", tokens: [{ tokenId: SOL, usd: 100 }] },
      { day: "2026-10-23", tokens: [{ tokenId: NEAR, usd: 100 }] },
      { day: "2026-10-24", tokens: [{ tokenId: NEAR, usd: 100 }] },
      ...base.days,
    ],
  });

  it("All is the whole series", () => {
    expect(sliceEvolution(long, null, NOW)).toBe(long);
  });

  it("7d keeps the points of the last 7 days, and the legend only the tokens held in them", () => {
    const week = sliceEvolution(long, 7, NOW);
    expect(week.points.map((p) => p.day)).toEqual(["2026-10-24", "2026-10-28", "2026-10-29", null]);
    expect(week.tokens.map((t) => t.tokenId)).toEqual([USDT, NEAR]);
    // Colors are the whole series': SOL leaving the legend shifts no one.
    expect(week.tokens).toEqual(long.tokens.filter((t) => t.tokenId !== SOL));
  });

  it("30d here is everything since the first priced day", () => {
    expect(sliceEvolution(long, 30, NOW).points).toEqual(long.points);
  });
});
