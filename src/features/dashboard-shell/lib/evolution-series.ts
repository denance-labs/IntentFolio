import { tokenRegistry } from "@/features/market/lib/token-registry";
import type { CompositionDay } from "@/features/history-recorder/lib/portfolio-composition-service";
import { buildTokenColorMap, type RingColor } from "@/features/portfolio-editor/lib/format";
import type { ChartRow } from "@/features/portfolio-editor/types";

const DAY_MS = 24 * 60 * 60 * 1000;

/** One moment of the portfolio: what each token held was worth, and its share of the total. */
export type EvolutionPoint = {
  ts: number;
  /** The UTC day of a recorded snapshot (00:00 UTC); null for the live "now" point. */
  day: string | null;
  totalUsd: number;
  /** tokenId → USD. Only tokens held then, none at zero. */
  usd: Record<string, number>;
  /** tokenId → % of `totalUsd`; together they make 100. */
  shares: Record<string, number>;
};

/** A token of the curve, in stacking order: the donut's order first, then the ones no longer held. */
export type EvolutionToken = { tokenId: string; color: RingColor };

export type EvolutionSeries = { points: EvolutionPoint[]; tokens: EvolutionToken[] };

export type EvolutionInput = {
  /** The route's snapshots, oldest first (plan 033-A). */
  days: CompositionDay[];
  /** The live portfolio — the same rows as the Current donut — or null while it is not known. */
  nowRows: Pick<ChartRow, "tokenId" | "currentUsd">[] | null;
  now: number;
  /** `usePortfolioComputed`'s map: a token keeps the color it has in the donut. */
  colorByToken: Map<string, RingColor>;
};

/**
 * Evolution's curve (plan 033-B, D-516): one point per recorded UTC day, plus "now" from the same
 * data as the Current donut, so the right edge matches Composition and Overview.
 *
 * Colors: the donut's map, then the tokens the portfolio held and no longer does, in registry
 * order. `buildTokenColorMap` goes by position, so appending them never shifts a donut color.
 */
export function buildEvolutionSeries({ days, nowRows, now, colorByToken }: EvolutionInput): EvolutionSeries {
  const points: EvolutionPoint[] = [];
  for (const { day, tokens } of days) {
    const point = pointOf(Date.parse(`${day}T00:00:00Z`), day, tokens.map((t) => [t.tokenId, t.usd]));
    if (point) points.push(point);
  }
  if (nowRows) {
    const point = pointOf(now, null, nowRows.map((r) => [r.tokenId, r.currentUsd]));
    if (point) points.push(point);
  }

  const registryOrder = new Map(tokenRegistry.map((token, i) => [token.id, i]));
  const at = (tokenId: string) => registryOrder.get(tokenId) ?? Infinity;
  const held = new Set(points.flatMap((p) => Object.keys(p.usd)));
  const gone = [...held].filter((tokenId) => !colorByToken.has(tokenId)).sort((a, b) => at(a) - at(b));
  const colors = buildTokenColorMap([...colorByToken.keys(), ...gone]);

  const tokens: EvolutionToken[] = [];
  for (const [tokenId, color] of colors) {
    if (held.has(tokenId)) tokens.push({ tokenId, color });
  }
  return { points, tokens };
}

/** A point is left out when nothing is held — a share of zero would be a false %. */
function pointOf(ts: number, day: string | null, entries: [string, number][]): EvolutionPoint | null {
  const held = entries.filter(([, usd]) => usd > 0);
  const totalUsd = held.reduce((sum, [, usd]) => sum + usd, 0);
  if (totalUsd <= 0) return null;
  const usd: Record<string, number> = {};
  const shares: Record<string, number> = {};
  for (const [tokenId, value] of held) {
    usd[tokenId] = (usd[tokenId] ?? 0) + value;
    shares[tokenId] = (usd[tokenId] / totalUsd) * 100;
  }
  return { ts, day, totalUsd, usd, shares };
}

/**
 * The points of the last `rangeDays` (null = all), for the 7d / 30d / All selector. Colors stay
 * the whole series'; the legend keeps only the tokens held somewhere in the range.
 */
export function sliceEvolution(series: EvolutionSeries, rangeDays: number | null, now: number): EvolutionSeries {
  if (rangeDays === null) return series;
  const from = now - rangeDays * DAY_MS;
  const points = series.points.filter((p) => p.ts >= from);
  const held = new Set(points.flatMap((p) => Object.keys(p.usd)));
  return { points, tokens: series.tokens.filter((t) => held.has(t.tokenId)) };
}

/** A curve needs two points; with fewer the view says it shows from the second day on. */
export function hasCurve(series: EvolutionSeries): boolean {
  return series.points.length >= 2;
}
