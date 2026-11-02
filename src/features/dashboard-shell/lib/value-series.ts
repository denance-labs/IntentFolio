import type { CompositionDay } from "@/features/history-recorder/lib/portfolio-composition-service";

const DAY_MS = 24 * 60 * 60 * 1000;

/** One point of Performance's value curve. */
export type ValuePoint = {
  timestamp: number;
  valueUsd: number;
  /**
   * Real portfolios only: the UTC day of a recorded snapshot (00:00 UTC), or null for the live
   * "now" point. Undefined for the mock's browser-local points, which are labelled locally.
   */
  day?: string | null;
};

export type ValueSeriesInput = {
  /** The Evolution read's snapshots, oldest first (`/api/history/portfolio-composition`). */
  days: CompositionDay[];
  /** The live value — the "Portfolio value" card — or null while live prices are not in. */
  nowUsd: number | null;
  now: number;
  /** The 7d / 30d / 60d selector. */
  rangeDays: number;
};

/**
 * Performance's value curve for a real portfolio (D-149 / D-342): one point per recorded UTC day,
 * the sum of what each token held was worth that day, plus "now" from the live value so the
 * right edge matches the card above it. The same snapshots Evolution splits by token.
 *
 * A day the read left out (a token it could not value) stays out: no point is invented for it.
 * A point worth nothing is left out too, like Evolution's — an empty portfolio has no curve.
 */
export function buildValueSeries({ days, nowUsd, now, rangeDays }: ValueSeriesInput): ValuePoint[] {
  const from = now - rangeDays * DAY_MS;
  const points: ValuePoint[] = [];
  for (const { day, tokens } of days) {
    const timestamp = Date.parse(`${day}T00:00:00Z`);
    const valueUsd = tokens.reduce((sum, token) => sum + (token.usd > 0 ? token.usd : 0), 0);
    if (timestamp >= from && valueUsd > 0) points.push({ timestamp, valueUsd, day });
  }
  if (nowUsd !== null && nowUsd > 0) points.push({ timestamp: now, valueUsd: nowUsd, day: null });
  return points;
}
