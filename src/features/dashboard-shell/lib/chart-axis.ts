// Enough decimals to tell one gridline from the next. Rounded to whole dollars, a $4.88
// portfolio drew "$5" on every line (operator, s224); the step between lines sets the precision.
function decimalsForStep(step: number): number {
  if (!(step > 0)) return 2;
  return Math.min(4, Math.max(0, Math.ceil(-Math.log10(step))));
}

export function formatAxisUsd(val: number, step: number): string {
  if (val >= 1000 && step >= 100) return `$${(val / 1000).toFixed(decimalsForStep(step / 1000))}k`;
  const digits = decimalsForStep(step);
  return `$${val.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

// 1, 2 or 5 times a power of ten: the steps a reader can add up at a glance.
function niceStep(raw: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const f = raw / magnitude;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * magnitude;
}

export type YAxis = { min: number; max: number; step: number; ticks: number[] };

/**
 * A y-axis whose gridlines sit on round values covering [lo, hi]. Splitting the range in three
 * equal parts put the lines on $4.83 / $4.85 / $4.86 / $4.88 — distinct, but unevenly
 * labelled once rounded (s224 QA).
 */
export function niceYAxis(lo: number, hi: number, lines = 3): YAxis {
  const span = hi > lo ? hi - lo : Math.abs(hi) * 0.1 || 1;
  const step = niceStep(span / lines);
  // Rounded to the step's own decimals so 0.1 + 0.2 never shows up as a tick.
  const digits = Math.max(0, -Math.floor(Math.log10(step))) + 1;
  const round = (v: number) => Number(v.toFixed(digits));
  const min = round(Math.floor(lo / step) * step);
  let max = round(Math.ceil(hi / step) * step);
  if (max <= min) max = round(min + step);
  const ticks: number[] = [];
  for (let i = 0; min + i * step <= max + step / 2; i++) ticks.push(round(min + i * step));
  return { min, max, step, ticks };
}
