import type { BandState } from "@/features/portfolio-editor/types";

export type ClosenessRow = {
  tokenId: string;
  currentPct: number;
  targetPct: number;
  bandState: BandState;
};

export type Closeness =
  // Nothing held: there is no mix yet to compare with the targets.
  | { state: "empty" }
  | {
      state: "ready";
      /** Share of the value already in its target mix, 0–100 (unrounded). */
      inPlacePct: number;
      /** Tokens with a target above 0 that sit inside their range. */
      onTarget: number;
      /** Tokens with a target above 0. */
      targeted: number;
      /** Per token, the part of its current share that is already in place (min of both). */
      overlap: { tokenId: string; pct: number }[];
    };

/**
 * How close a portfolio is to its targets (D-518): Σ min(current %, target %) over every token,
 * i.e. the part where the Current and Target donuts overlap. It equals 100 − ½·Σ|current − target|,
 * so it reaches 100 only when the mix is exactly the target. A token held with no target counts
 * with a target of 0, and a target not held yet counts with a current of 0.
 */
export function closeness(rows: ClosenessRow[], currentTotalUsd: number): Closeness {
  if (!(currentTotalUsd > 0)) return { state: "empty" };
  const overlap: { tokenId: string; pct: number }[] = [];
  let inPlacePct = 0;
  let onTarget = 0;
  let targeted = 0;
  for (const row of rows) {
    const pct = Math.max(0, Math.min(row.currentPct || 0, row.targetPct || 0));
    if (pct > 0) overlap.push({ tokenId: row.tokenId, pct });
    inPlacePct += pct;
    if ((row.targetPct || 0) > 0) {
      targeted += 1;
      if (row.bandState === "inside") onTarget += 1;
    }
  }
  return { state: "ready", inPlacePct: Math.min(100, inPlacePct), onTarget, targeted, overlap };
}

/**
 * The whole percent shown for `inPlacePct`, rounded down so "100%" is never shown for a mix that
 * is not on target yet — the float sum of an exact mix lands a hair under 100, hence the slack.
 */
export function displayInPlacePct(inPlacePct: number): number {
  return inPlacePct >= 99.95 ? 100 : Math.floor(inPlacePct);
}
