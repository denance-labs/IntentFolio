// Donut arc geometry — pure SVG path math, self-contained so the landing demo
// stays decoupled from the dashboard editor's chart component. The dashboard has
// an equivalent helper in portfolio-editor/components/portfolio-charts.tsx; if a
// third consumer appears, promote this to a shared module (tracked as future debt).

export function polarToCartesian(cx: number, cy: number, radius: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + radius * Math.cos(rad), y: cy + radius * Math.sin(rad) };
}

/**
 * SVG path for a donut slice (annular sector) between two angles, drawn clockwise
 * from `startAngle` to `endAngle` (degrees, 0 = 12 o'clock). A full ring is drawn
 * as two stacked semicircles so the even-odd hole renders correctly.
 */
export function donutSlicePath(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  startAngle: number,
  endAngle: number
) {
  const sweep = endAngle - startAngle;

  if (sweep >= 359.999) {
    const top = polarToCartesian(cx, cy, rOuter, 0);
    const bottom = polarToCartesian(cx, cy, rOuter, 180);
    const topInner = polarToCartesian(cx, cy, rInner, 0);
    const bottomInner = polarToCartesian(cx, cy, rInner, 180);

    return [
      `M ${top.x} ${top.y}`,
      `A ${rOuter} ${rOuter} 0 1 1 ${bottom.x} ${bottom.y}`,
      `A ${rOuter} ${rOuter} 0 1 1 ${top.x} ${top.y}`,
      `M ${topInner.x} ${topInner.y}`,
      `A ${rInner} ${rInner} 0 1 0 ${bottomInner.x} ${bottomInner.y}`,
      `A ${rInner} ${rInner} 0 1 0 ${topInner.x} ${topInner.y}`,
      "Z",
    ].join(" ");
  }

  const startOuter = polarToCartesian(cx, cy, rOuter, endAngle);
  const endOuter = polarToCartesian(cx, cy, rOuter, startAngle);
  const startInner = polarToCartesian(cx, cy, rInner, startAngle);
  const endInner = polarToCartesian(cx, cy, rInner, endAngle);
  const largeArc = sweep <= 180 ? "0" : "1";

  return [
    `M ${startOuter.x} ${startOuter.y}`,
    `A ${rOuter} ${rOuter} 0 ${largeArc} 0 ${endOuter.x} ${endOuter.y}`,
    `L ${startInner.x} ${startInner.y}`,
    `A ${rInner} ${rInner} 0 ${largeArc} 1 ${endInner.x} ${endInner.y}`,
    "Z",
  ].join(" ");
}

/** Centroid angle (deg) of a slice — used to anchor labels / connector lines. */
export function sliceMidAngle(startAngle: number, endAngle: number) {
  return (startAngle + endAngle) / 2;
}
