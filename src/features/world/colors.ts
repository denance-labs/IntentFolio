// D-571: the theme's colors as CSS values, for the few places a Tailwind class cannot reach (SVG
// gradient stops, inline styles, chart marks). They read the same variables as the classes
// (globals.css), so retuning the palette there retunes these too. Use them through `style`, not
// SVG presentation attributes: `var()` is only reliable in CSS. Outside the app the slate steps
// keep Tailwind's own values, so a component shared with the landing keeps its look there.
type Step = 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900 | 950;

export function themeColor(name: "accent" | "target" | `slate-${Step}`, alpha?: number): string {
  return alpha === undefined ? `rgb(var(--${name}))` : `rgb(var(--${name}) / ${alpha})`;
}
