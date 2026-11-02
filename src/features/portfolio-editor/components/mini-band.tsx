import type { BandState } from "../types";

// D-505: three marks that differ by shape, not only by color, explained once by
// MiniBandLegend in the column header. "Now" is a round dot kept whole at 0 % and 100 % (the
// old square sat half outside a clipped track and read as a half-circle); "target" is a line
// taller than the track; the on-target range is the shaded band. Out of the band, a dotted line
// joins the dot to the band's nearest edge — except below it on a token that can only go down
// (D-491), where it would promise a rise that cannot happen. With nothing held (the draft) there
// is no "now" yet, so no dot.
//
// D-510: the "Current to target composition" card shows the same bar without the range
// (showRange false): the dotted line then joins the dot to the target itself whenever they
// differ, with the same D-491 exception, and ends in an arrowhead at the target so the row
// reads as a move. Below ARROW_MIN_GAP points the line is too short to carry one.
//
// D-525: the edit table's bar (range shown) carries the same arrowhead, at the band's nearest
// edge where the connector ends — the portfolio moves into the band, not to the exact target.

const NOW_DOT = "h-2.5 w-2.5 rounded-full bg-slate-50 ring-1 ring-[#0b1220]";
const TARGET_LINE = "w-0.5 rounded-full bg-[#67e8f9]";
const RANGE = "rounded-sm bg-cyan-300/25";
const ARROW_MIN_GAP = 5;

type MiniBandProps = {
  minPct: number;
  targetPct: number;
  maxPct: number;
  currentPct: number;
  state: BandState;
  /** False for a target with no buy route (D-491): below the band, no connector. */
  canRise: boolean;
  /** The bar's text for screen readers and the hover title, in the active language. */
  label: string;
  /** False drops the on-target range: the connector then runs from the dot to the target. */
  showRange?: boolean;
};

export function MiniBand({ minPct, targetPct, maxPct, currentPct, state, canRise, label, showRange = true }: MiniBandProps) {
  const now = Math.min(100, Math.max(0, currentPct));
  const connector = state === "empty"
    ? null
    : showRange
      ? state === "below" && canRise
        ? { from: now, to: minPct }
        : state === "above"
          ? { from: maxPct, to: now }
          : null
      : now < targetPct && canRise
        ? { from: now, to: targetPct }
        : now > targetPct
          ? { from: targetPct, to: now }
          : null;
  return (
    <div className="py-1" role="img" aria-label={label} title={label}>
      <div className="relative h-2 rounded-full bg-slate-800">
        {showRange ? (
          <div
            className={`absolute top-0 h-full ${RANGE}`}
            style={{ left: `${minPct}%`, width: `${Math.max(1, maxPct - minPct)}%` }}
          />
        ) : null}
        {connector ? (
          <div
            className="absolute top-1/2 -mt-px border-t-2 border-dotted border-violet-400"
            style={{ left: `${connector.from}%`, width: `${Math.max(0, connector.to - connector.from)}%` }}
          />
        ) : null}
        {connector && connector.to - connector.from >= ARROW_MIN_GAP ? (
          <svg
            width="6"
            height="8"
            viewBox="0 0 6 8"
            aria-hidden="true"
            className="absolute top-1/2 -mt-1 fill-violet-400"
            // Tip touches the connector's far end (the target, or the band's edge when the range
            // shows): from the left when rising, from the right when falling.
            style={
              now <= connector.from
                ? { left: `calc(${connector.to}% - 8px)` }
                : { left: `calc(${connector.from}% + 2px)`, transform: "scaleX(-1)" }
            }
          >
            <path d="M0 0 L6 4 L0 8 Z" />
          </svg>
        ) : null}
        <div className={`absolute -top-1 h-4 ${TARGET_LINE}`} style={{ left: `calc(${targetPct}% - 1px)` }} />
        {state !== "empty" ? (
          <div
            className={`absolute top-1/2 -mt-[5px] ${NOW_DOT}`}
            // Slides from flush-left at 0 % to flush-right at 100 % (10 px dot), so it is never clipped.
            style={{ left: `calc(${now}% - ${now / 10}px)` }}
          />
        ) : null}
      </div>
    </div>
  );
}

/** The marks' key, shown once under the column header (D-505). */
export function MiniBandLegend({ now, target, range }: { now: string; target: string; range?: string }) {
  return (
    <span className="mt-1 flex items-center justify-center gap-3 text-[10px] font-normal text-slate-400" aria-hidden="true">
      <span className="flex items-center gap-1">
        <span className={`inline-block ${NOW_DOT}`} />
        {now}
      </span>
      <span className="flex items-center gap-1">
        <span className={`inline-block h-3 ${TARGET_LINE}`} />
        {target}
      </span>
      {range ? (
        <span className="flex items-center gap-1">
          <span className={`inline-block h-2 w-4 ${RANGE}`} />
          {range}
        </span>
      ) : null}
    </span>
  );
}
