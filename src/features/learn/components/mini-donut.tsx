"use client";

import { donutSlicePath } from "@/features/landing/lib/donut-geometry";

type Slice = { pct: number; color: string; label: string };

type MiniDonutProps = {
  slices: Slice[];
  /** Outer radius in SVG user-units (viewBox is 100×100, center 50,50). */
  rOuter?: number;
  rInner?: number;
  size?: number;
};

const GAP_DEG = 1.5;

export function MiniDonut({ slices, rOuter = 44, rInner = 28, size = 96 }: MiniDonutProps) {
  const total = slices.reduce((s, sl) => s + sl.pct, 0) || 100;

  let angle = -90;
  // Keyed by index, not label: some presets repeat a ticker (e.g. stables holds USDC on
  // several chains), so labels aren't unique.
  const paths: { d: string; color: string }[] = [];

  for (const slice of slices) {
    const sweep = (slice.pct / total) * 360 - GAP_DEG;
    if (sweep > 0) {
      paths.push({
        d: donutSlicePath(50, 50, rOuter, rInner, angle, angle + sweep),
        color: slice.color,
      });
    }
    angle += (slice.pct / total) * 360;
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      aria-hidden="true"
      role="img"
      // Fixed-size glyph: in a flex row, a two-line legend would otherwise squeeze it.
      className="shrink-0"
    >
      {paths.map((p, i) => (
        <path key={i} d={p.d} fill={p.color} />
      ))}
    </svg>
  );
}
