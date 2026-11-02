// Geometry for the Overview showcase (D-518). Pure numbers, no React, so the dashboard and the
// landing draw the same rings and the tests can pin them down.

export type RingSegment = {
  tokenId: string;
  /** Painted length along the circle, in SVG user units. 0 for a token with no share here. */
  dash: number;
  /** stroke-dashoffset that starts the dash where the previous token ended (negative). */
  offset: number;
};

/**
 * One dash per token on a circle of radius `r`, in order, starting at 12 o'clock when the circle
 * is rotated −90°. Each dash is shortened by `gap` so neighbours never touch; a share too small to
 * survive the gap paints nothing (it keeps its place, so a morph between two sets of shares — the
 * phone's Now/Target switch — moves every token from its own start, never from a neighbour's).
 * A lone token has no neighbour, so it closes the ring with no gap.
 */
export function ringSegments(
  shares: { tokenId: string; pct: number }[],
  r: number,
  gap: number
): { circumference: number; segments: RingSegment[] } {
  const circumference = 2 * Math.PI * r;
  const total = shares.reduce((sum, s) => sum + Math.max(0, s.pct), 0);
  const painted = shares.filter((s) => s.pct > 0).length;
  const spacing = painted > 1 ? gap : 0;
  let cursor = 0;
  const segments = shares.map(({ tokenId, pct }) => {
    const length = total > 0 ? (Math.max(0, pct) / total) * circumference : 0;
    const dash = Math.max(0, length - spacing);
    const offset = -(cursor + (dash > 0 ? spacing / 2 : 0));
    cursor += length;
    return { tokenId, dash, offset };
  });
  return { circumference, segments };
}

/** CSS conic-gradient stops for a ring's glow, in the same order as its segments. */
export function conicStops(shares: { color: string; pct: number }[]): string {
  const total = shares.reduce((sum, s) => sum + Math.max(0, s.pct), 0);
  if (total <= 0) return "transparent 0% 100%";
  let cursor = 0;
  const stops: string[] = [];
  for (const { color, pct } of shares) {
    if (pct <= 0) continue;
    const from = (cursor / total) * 100;
    cursor += pct;
    stops.push(`${color} ${from.toFixed(2)}% ${((cursor / total) * 100).toFixed(2)}%`);
  }
  return stops.join(", ");
}

export type Point = { x: number; y: number };

export type LeaderLabel = {
  tokenId: string;
  pct: number;
  /** "right": the label starts where its line ends; "left": it ends there. */
  side: "left" | "right";
  /** The dot on the slice. */
  dot: Point;
  /**
   * SVG path of the line: out of the ring along the slice's middle, along the label circle to the
   * label's height (an arc, so a label pushed far from its slice never cuts across the ring), then
   * level.
   */
  path: string;
  /** Where the label's text is anchored (its first line's vertical middle). */
  text: Point;
};

export type LeaderLayout = {
  center: number;
  /** Radius of the ring's middle, where the dot sits. */
  ringRadius: number;
  /** The line starts here, clear of the ring even when a slice is lit and thicker. */
  lineStart: number;
  /** The bend, and the circle the labels sit on. */
  labelRadius: number;
  /** Level stretch between the bend and the text, and the space after it. */
  tail: number;
  textGap: number;
  /** The side facing the other donut, where the move between them sits. */
  innerSide: "left" | "right";
  /** Half the height kept clear on the inner side, around the middle. */
  keepOut: number;
  /** Least vertical distance between two labels on one side. */
  minGap: number;
  /** Shares below this (in %) get no label: too thin to point at, and they are in the legend. */
  minShare: number;
};

/**
 * Labels outside the ring with a line to their slice (D-522), placed in the donut's own box and
 * the space around it so the ring never shrinks. Each label starts level with its slice's middle;
 * on each side they are then pushed apart to `minGap`. On the inner side they also keep out of
 * the band where the move between the donuts is shown, going up from its top edge or down from
 * its bottom one. A label pushed past the top or bottom of the label circle is dropped (there is
 * no room left for it; the legend still has it).
 */
export function leaderLabels(shares: { tokenId: string; pct: number }[], layout: LeaderLayout): LeaderLabel[] {
  const { center: c, ringRadius, lineStart, labelRadius, tail, textGap, innerSide, keepOut, minGap, minShare } = layout;
  const total = shares.reduce((sum, s) => sum + Math.max(0, s.pct), 0);
  if (total <= 0) return [];
  let cursor = 0;
  const placed = shares.flatMap(({ tokenId, pct }) => {
    const share = Math.max(0, pct);
    const middle = cursor + share / 2;
    cursor += share;
    if (share <= 0 || (share / total) * 100 < minShare) return [];
    // From 12 o'clock, clockwise, the same way the ring is drawn.
    const angle = (middle / total) * 2 * Math.PI - Math.PI / 2;
    const side: "left" | "right" = Math.cos(angle) >= 0 ? "right" : "left";
    return [{ tokenId, pct, angle, side, y: c + labelRadius * Math.sin(angle) }];
  });

  for (const side of ["left", "right"] as const) {
    const column = placed.filter((p) => p.side === side);
    if (side === innerSide) {
      let limit = c - keepOut;
      for (const p of column.filter((q) => q.y < c).sort((a, b) => b.y - a.y)) {
        p.y = Math.min(p.y, limit);
        limit = p.y - minGap;
      }
      limit = c + keepOut;
      for (const p of column.filter((q) => q.y >= c).sort((a, b) => a.y - b.y)) {
        p.y = Math.max(p.y, limit);
        limit = p.y + minGap;
      }
    } else {
      let limit = -Infinity;
      for (const p of column.sort((a, b) => a.y - b.y)) {
        p.y = Math.max(p.y, limit);
        limit = p.y + minGap;
      }
    }
  }

  return placed
    .filter((p) => Math.abs(p.y - c) <= labelRadius)
    .map(({ tokenId, pct, angle, side, y }) => {
      const dir = side === "right" ? 1 : -1;
      const at = (r: number): Point => ({ x: c + r * Math.cos(angle), y: c + r * Math.sin(angle) });
      const dy = y - c;
      // The elbow sits on the label circle at the label's height, so the line never cuts the ring.
      const elbow = { x: c + dir * Math.sqrt(Math.max(labelRadius * labelRadius - dy * dy, 0)), y };
      const end = { x: elbow.x + dir * tail, y };
      const start = at(lineStart);
      const bend = at(labelRadius);
      const turn = Math.atan2(Math.sin(Math.atan2(dy, elbow.x - c) - angle), Math.cos(Math.atan2(dy, elbow.x - c) - angle));
      const f = (n: number) => n.toFixed(2);
      const path =
        `M${f(start.x)} ${f(start.y)}L${f(bend.x)} ${f(bend.y)}` +
        `A${labelRadius} ${labelRadius} 0 0 ${turn > 0 ? 1 : 0} ${f(elbow.x)} ${f(elbow.y)}L${f(end.x)} ${f(end.y)}`;
      return { tokenId, pct, side, dot: at(ringRadius), path, text: { x: end.x + dir * textGap, y } };
    });
}

export type DayCount = { day: string; swaps: number; spreadUsd: number };

const DAY_MS = 24 * 60 * 60 * 1000;

function dayIndex(day: string): number {
  return Math.round(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
}

/** "YYYY-MM-DD" in UTC — the same calendar the history database groups its days by. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The last `days` calendar days up to `endDay`, oldest first, each with its swaps (0 on a day
 * with none). Days outside the window are left out: the bars show a fixed stretch, so a portfolio
 * a year old does not shrink them to hairlines.
 */
export function dailyWindow(daily: DayCount[], endDay: string, days: number): { day: string; swaps: number }[] {
  const end = dayIndex(endDay);
  const byIndex = new Map(daily.map((d) => [dayIndex(d.day), d.swaps]));
  return Array.from({ length: days }, (_, i) => {
    const index = end - (days - 1 - i);
    return { day: utcDay(index * DAY_MS), swaps: byIndex.get(index) ?? 0 };
  });
}

/**
 * A cumulative step line through the daily spread, from 0 the day before the first entry to the
 * last entry's total held flat to `endDay`, in a `width` × `height` box with `pad` inside it.
 * `null` with fewer than one entry: there is nothing to draw.
 */
export function cumulativeStepPath(
  daily: DayCount[],
  endDay: string,
  width: number,
  height: number,
  pad = 3
): { line: string; area: string; end: { x: number; y: number } } | null {
  const entries = daily.filter((d) => d.spreadUsd > 0 || d.swaps > 0);
  if (entries.length === 0) return null;
  const first = dayIndex(entries[0].day) - 1;
  const last = Math.max(dayIndex(endDay), dayIndex(entries[entries.length - 1].day) + 1);
  const total = entries.reduce((sum, d) => sum + Math.max(0, d.spreadUsd), 0);
  const x = (index: number) => pad + ((index - first) / Math.max(1, last - first)) * (width - 2 * pad);
  const y = (value: number) => height - pad - (total > 0 ? value / total : 0) * (height - 2 * pad);
  let cumulative = 0;
  let line = `M${x(first).toFixed(1)} ${y(0).toFixed(1)}`;
  for (const d of entries) {
    cumulative += Math.max(0, d.spreadUsd);
    line += ` H${x(dayIndex(d.day)).toFixed(1)} V${y(cumulative).toFixed(1)}`;
  }
  line += ` H${x(last).toFixed(1)}`;
  const area = `${line} V${y(0).toFixed(1)} H${x(first).toFixed(1)} Z`;
  return { line, area, end: { x: x(last), y: y(cumulative) } };
}
