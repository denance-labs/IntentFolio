// D-575: where each asset's logo sits on the hero donut, and how visible it is.
//
// Pure numbers so the tests can pin them down. The positions follow the same shares the bars use
// (`mixAt`), which move on the same curve and timing as the ring's CSS transition, so a logo stays
// on its slice while the donut spreads from the starting asset to the mix.

/** A logo shows only on a slice that has room for it: none under 7 %, fully from 10 %. */
export const LOGO_FADE_FROM_PCT = 7;
export const LOGO_FULL_AT_PCT = 10;

export function logoOpacity(pct: number): number {
  const t = (pct - LOGO_FADE_FROM_PCT) / (LOGO_FULL_AT_PCT - LOGO_FADE_FROM_PCT);
  return Math.min(1, Math.max(0, t));
}

export type SliceLogo = {
  id: string;
  symbol: string;
  /** Center of the logo, in percent of the donut's box (0–100). */
  left: number;
  top: number;
  opacity: number;
};

/**
 * One logo per visible slice, at the middle of its arc on the ring's center line. Slices go
 * clockwise from 12 o'clock in mix order, as `ringSegments` draws them; the gap between slices is
 * split evenly on both ends, so it does not move a slice's middle.
 *
 * `ringRadius` and `center` are in the donut's view-box units (`RING` in showcase-donut).
 */
export function sliceLogos(
  mix: readonly { id: string; symbol: string; now: number }[],
  ring: { center: number; ringRadius: number }
): SliceLogo[] {
  const total = mix.reduce((sum, m) => sum + Math.max(0, m.now), 0);
  if (total <= 0) return [];
  const box = ring.center * 2;
  let cursor = 0;
  const logos: SliceLogo[] = [];
  for (const m of mix) {
    const share = (Math.max(0, m.now) / total) * 100;
    const mid = ((cursor + share / 2) / 100) * 2 * Math.PI;
    cursor += share;
    const opacity = logoOpacity(share);
    if (opacity <= 0) continue;
    logos.push({
      id: m.id,
      symbol: m.symbol,
      left: ((ring.center + ring.ringRadius * Math.sin(mid)) / box) * 100,
      top: ((ring.center - ring.ringRadius * Math.cos(mid)) / box) * 100,
      opacity,
    });
  }
  return logos;
}
