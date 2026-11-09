import {
  EXAMPLE_CUMULATIVE_SPREAD_USD as SERIES,
  EXAMPLE_SPREAD_AXIS_TICKS_USD as TICKS,
} from "@/content/example-spread";
import { formatUsd } from "@/features/portfolio-editor/lib/format";
import { WORLD_PANEL } from "../lib/world";

type Copy = {
  title: string;
  mark: string;
  base: string;
  /** "{n}" is the move's number. */
  move: string;
  /** "{first}", "{last}" and "{count}" come from the series. */
  summary: string;
  caption: string;
};

// The gain green of the app's history amounts: this line is spread earned, not a target.
const LINE = "#34d399";
const AXIS_MAX = TICKS[TICKS.length - 1];
const xPct = (index: number) => (index / (SERIES.length - 1)) * 100;
const yPct = (usd: number) => (1 - usd / AXIS_MAX) * 100;

const LAST = SERIES.length - 1;
const linePoints = SERIES.map((usd, i) => `${xPct(i)},${yPct(usd)}`).join(" ");
const areaPoints = `0,100 ${linePoints} 100,100`;

/**
 * The cumulative spread of an example portfolio. Drawn here rather than shipped as an image so
 * its text translates and stays legible at any width: the plot stretches, while the labels and
 * the dots are HTML laid over it by percentage.
 */
export function ExampleSpreadChart({ copy }: { copy: Copy }) {
  const summary = copy.summary
    .replace("{first}", formatUsd(SERIES[0]))
    .replace("{last}", formatUsd(SERIES[LAST]))
    .replace("{count}", String(SERIES.length));

  return (
    <figure className={`${WORLD_PANEL} p-4 sm:p-5`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-bone">{copy.title}</p>
          <p className="mt-0.5 text-xs text-bone-dim">{copy.base}</p>
        </div>
        <span className="shrink-0 rounded-full border border-bone/20 px-2.5 py-0.5 text-xs font-medium text-bone-dim">
          {copy.mark}
        </span>
      </div>

      <div role="img" aria-label={summary} className="mt-5 grid grid-cols-[2.25rem_1fr]">
        <div aria-hidden="true" className="relative">
          {TICKS.map((tick) => (
            <span
              key={tick}
              className="absolute left-0 -translate-y-1/2 text-xs tabular-nums text-bone-dim"
              style={{ top: `${yPct(tick)}%` }}
            >
              ${tick}
            </span>
          ))}
        </div>

        <div aria-hidden="true" className="relative h-44 sm:h-56">
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="absolute inset-0 h-full w-full overflow-visible"
          >
            <defs>
              <linearGradient id="example-spread-area" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={LINE} stopOpacity="0.18" />
                <stop offset="100%" stopColor={LINE} stopOpacity="0" />
              </linearGradient>
            </defs>
            {TICKS.map((tick) => (
              <line
                key={tick}
                x1="0"
                x2="100"
                y1={yPct(tick)}
                y2={yPct(tick)}
                vectorEffect="non-scaling-stroke"
                className={tick === 0 ? "stroke-bone/20" : "stroke-bone/[0.08]"}
                strokeWidth="1"
              />
            ))}
            <polygon points={areaPoints} fill="url(#example-spread-area)" />
            <polyline
              points={linePoints}
              fill="none"
              stroke={LINE}
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>

          {SERIES.map((usd, i) => (
            <span
              key={i}
              className="absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-emerald-400 ring-2 ring-graphite-raised"
              style={{ left: `${xPct(i)}%`, top: `${yPct(usd)}%` }}
            />
          ))}

          {/* Above the last dot: the line arrives from the lower left, so nothing crosses it there. */}
          <span
            className="absolute right-0 text-sm font-semibold tabular-nums text-bone"
            style={{ bottom: `calc(${100 - yPct(SERIES[LAST])}% + 0.5rem)` }}
          >
            {formatUsd(SERIES[LAST])}
          </span>
        </div>

        <div aria-hidden="true" />
        <div aria-hidden="true" className="mt-2 flex justify-between text-xs text-bone-dim">
          <span>{copy.move.replace("{n}", "1")}</span>
          <span>{copy.move.replace("{n}", String(SERIES.length))}</span>
        </div>
      </div>

      <figcaption className="mt-4 text-xs text-bone-dim">{copy.caption}</figcaption>
    </figure>
  );
}
