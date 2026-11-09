"use client";

// Self-contained "watch a portfolio move toward its mix" animation (D-564).
//
// Reusable on purpose: it takes its data and language via props (no app context),
// so it can be mounted inside the landing section, on the standalone /demo recording
// route, or anywhere else. The donut starts at the preset's starting point (100% of
// one asset), holds there for a beat, and then morphs in ONE continuous motion into
// the target mix: slices grow and shrink, none pops in. Each row's bar travels to a
// tick on its target and its percentage follows. The motion must not read as slow or
// as buying in steps (brand copy rules), so there are no pauses mid-way.
//
// Motion is driven by a monotonic `playToken`: bumping it restarts the move from the
// starting point — that is how both the "replay" button and preset switching work.
// The first play is triggered when the component scrolls into view. Once hydrated, the
// starting point is what shows before that, never an empty donut. The server-rendered HTML
// (what a visitor without JS gets, D-566) shows the target mix instead: without JS nothing
// could ever move it, and a demo stuck at 100% USDC would not show what it promises. In `autoPlayLoop`
// mode (recording) it loops on a fixed cadence with the controls hidden.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useInView } from "framer-motion";
import { RotateCcw } from "lucide-react";
import { donutSlicePath } from "../lib/donut-geometry";
import type { DemoAllocation, DemoPreset } from "../lib/demo-presets";

const SIZE = 260;
const CENTER = SIZE / 2;
const R_OUTER = 120;
const R_INNER = 76;

// Timing (ms). Kept in one place so the recording loop cadence stays in sync.
export const HOLD_MS = 700;
const MOVE_MS = 1800;
// One full move + hold on target before the recording loop restarts.
const LOOP_MS = 6200;

type Orientation = "auto" | "row" | "stack";

type Props = {
  presets: DemoPreset[];
  lang: "en" | "es";
  /** Hide the replay/preset controls (recording mode). Default: show them. */
  showControls?: boolean;
  /** Loop the move on a fixed cadence with no user input (recording mode). */
  autoPlayLoop?: boolean;
  /** Which preset to start on / lock to. Default 0. */
  initialPresetIndex?: number;
  /** Layout: "auto" is responsive (stack on mobile, row on lg). */
  orientation?: Orientation;
  /** "showcase" enlarges donut/rows for full-screen video capture. */
  variant?: "default" | "showcase";
  className?: string;
  /** What leads out of the demo, for the preset on screen. Absent on the recording route. */
  renderAction?: (preset: DemoPreset) => ReactNode;
};

// Per-variant sizing. SVG center-label text lives in viewBox units so it scales with
// the donut automatically; only the HTML rows need explicit size bumps for showcase.
const SIZING = {
  default: { container: "max-w-3xl", donut: "w-[min(72vw,16rem)]", rows: "max-w-xs", text: "text-sm", bar: "h-1.5", tick: "-inset-y-1", gap: "gap-8" },
  showcase: { container: "max-w-6xl", donut: "w-[clamp(18rem,40vw,34rem)]", rows: "max-w-md", text: "text-xl", bar: "h-2.5", tick: "-inset-y-1.5", gap: "gap-10 sm:gap-16" },
} as const;

export const DEMO_COPY = {
  en: {
    replay: "Replay",
    from: (a: DemoAllocation) => `From ${a.pct}% ${a.label}`,
    onTarget: "✓ On target",
  },
  es: {
    replay: "Repetir",
    from: (a: DemoAllocation) => `Desde ${a.pct}% ${a.label}`,
    onTarget: "✓ En objetivo",
  },
} as const;

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * Progress of the move from the starting point (0) to the target mix (1). Restarts at 0
 * whenever `playKey` changes; stays at 0 until `play`; jumps to 1 under reduced motion.
 */
export function useProgress(play: boolean, playKey: number, reduced: boolean, hydrated: boolean, moveMs = MOVE_MS) {
  // Tagged with the play it belongs to, so a replay or preset switch never shows one frame of
  // the previous play's progress before the effect resets it.
  const [state, setState] = useState({ key: playKey, value: 0 });

  useEffect(() => {
    if (!play || reduced) return;
    let raf = 0;
    const startAt = performance.now() + HOLD_MS;
    const tick = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - startAt) / moveMs));
      setState({ key: playKey, value: easeInOutCubic(t) });
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [play, playKey, reduced, moveMs]);

  if (reduced || !hydrated) return 1;
  if (!play) return 0;
  return state.key === playKey ? state.value : 0;
}

/**
 * Every asset that is on screen at some point of the move — the targets in their order,
 * then the starting asset if it is not one of them — with its share at `progress`.
 */
export function mixAt(preset: DemoPreset, progress: number) {
  const startPct = (id: string) => (id === preset.start.id ? preset.start.pct : 0);
  const rows = preset.allocations.map((a) => ({
    ...a,
    target: a.pct,
    now: startPct(a.id) + (a.pct - startPct(a.id)) * progress,
  }));
  if (!rows.some((r) => r.id === preset.start.id)) {
    rows.push({ ...preset.start, target: 0, now: preset.start.pct * (1 - progress) });
  }
  return rows;
}

export function PortfolioBuildDemo({
  presets,
  lang,
  showControls = true,
  autoPlayLoop = false,
  initialPresetIndex = 0,
  orientation = "auto",
  variant = "default",
  className = "",
  renderAction,
}: Props) {
  const copy = DEMO_COPY[lang];
  const sz = SIZING[variant];
  const containerRef = useRef<HTMLDivElement>(null);
  const inView = useInView(containerRef, { once: false, margin: "-90px" });

  const [activeIndex, setActiveIndex] = useState(
    Math.min(Math.max(initialPresetIndex, 0), Math.max(presets.length - 1, 0))
  );
  // 0 = not yet played (starting point on screen); >0 = a move is/was running. Bumping replays.
  const [playToken, setPlayToken] = useState(0);
  const started = useRef(false);
  const [reduced, setReduced] = useState(false);
  // False in the server HTML and on the hydration render; see the header comment (D-566).
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  // Read the OS reduced-motion preference on the client only (avoids SSR hydration
  // mismatch); used to show the target mix straight away instead of moving to it.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // First move kicks off when the component scrolls into view.
  useEffect(() => {
    if (inView && !started.current) {
      started.current = true;
      setPlayToken((t) => t + 1);
    }
  }, [inView]);

  // Recording mode: loop the move on a fixed cadence, no controls.
  useEffect(() => {
    if (!autoPlayLoop || !inView) return;
    const id = setInterval(() => setPlayToken((t) => t + 1), LOOP_MS);
    return () => clearInterval(id);
  }, [autoPlayLoop, inView]);

  const preset = presets[activeIndex] ?? presets[0];
  const progress = useProgress(playToken > 0, playToken, reduced, hydrated);
  const mix = mixAt(preset, progress);
  const onTarget = progress >= 1;

  // Cumulative angle segments (degrees, 0 = top, clockwise) for the donut at `progress`.
  let cursor = 0;
  const segments = mix.map((m) => {
    const sweep = (m.now / 100) * 360;
    const seg = { ...m, startAngle: cursor, endAngle: cursor + sweep };
    cursor += sweep;
    return seg;
  });

  // Reserve height for the tallest preset's row list so the container doesn't resize
  // when switching between presets that hold a different number of assets.
  const maxRows = useMemo(
    () => presets.reduce((max, p) => Math.max(max, p.allocations.length), 0),
    [presets]
  );

  function replay() {
    setPlayToken((t) => t + 1);
  }
  function selectPreset(index: number) {
    setActiveIndex(index);
    setPlayToken((t) => t + 1);
  }

  const stackClass =
    orientation === "stack"
      ? "flex-col items-center"
      : orientation === "row"
        ? "flex-row items-center"
        : "flex-col items-center lg:flex-row";

  return (
    <div ref={containerRef} className={`relative flex w-full flex-col items-center ${className}`}>
      {showControls && (
        <button
          type="button"
          data-needs-js
          onClick={replay}
          // Under `sm` it sits in the flow above the donut, which it used to cover at 390 px, at a 44 px touch height.
          className="z-10 mb-3 inline-flex min-h-11 items-center self-end sm:absolute sm:right-0 sm:top-0 sm:mb-0 sm:min-h-0 gap-1.5 rounded-lg border border-slate-700 bg-slate-900/80 px-3 py-1.5 text-xs font-medium text-slate-200 backdrop-blur transition hover:border-cyan-500/50 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
        >
          <RotateCcw size={14} aria-hidden="true" />
          {copy.replay}
        </button>
      )}
      <div className={`flex w-full justify-center ${sz.container} ${sz.gap} ${stackClass}`}>
        {/* Donut */}
        <div className="relative shrink-0">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-2 rounded-full bg-cyan-400/10 blur-2xl"
          />
          <svg
            width="100%"
            viewBox={`0 0 ${SIZE} ${SIZE}`}
            className={`relative block h-auto ${sz.donut}`}
            role="img"
            aria-label={`${preset.title} (${copy.from(preset.start)}): ${preset.allocations
              .map((a) => `${a.label} ${a.pct}%`)
              .join(", ")}`}
          >
            {/* Track ring */}
            <circle cx={CENTER} cy={CENTER} r={R_OUTER} className="fill-slate-800/50" />
            <circle cx={CENTER} cy={CENTER} r={R_INNER} className="fill-slate-950" />

            {segments
              .filter((seg) => seg.endAngle - seg.startAngle > 0.05)
              .map((seg) => (
                <path
                  key={`${preset.id}-${seg.id}`}
                  d={donutSlicePath(CENTER, CENTER, R_OUTER, R_INNER, seg.startAngle, seg.endAngle)}
                  fill={seg.color}
                  stroke="#020617"
                  strokeWidth={2.5}
                  strokeLinejoin="round"
                />
              ))}

            {/* Center label: the preset, and where it stands — from its starting point, then on target. */}
            <g pointerEvents="none">
              <text
                x={CENTER}
                y={CENTER - 4}
                textAnchor="middle"
                className="fill-slate-100"
                style={{ fontSize: 22, fontWeight: 700 }}
              >
                {preset.title}
              </text>
              <text
                x={CENTER}
                y={CENTER + 18}
                textAnchor="middle"
                className={onTarget ? "fill-emerald-300" : "fill-slate-400"}
                style={{ fontSize: 12, fontWeight: 500, letterSpacing: 0.4, transition: "fill 300ms ease" }}
              >
                {onTarget ? copy.onTarget : copy.from(preset.start)}
              </text>
            </g>
          </svg>
        </div>

        {/* Allocation rows: each bar travels to the tick that marks its target. */}
        <div className={`w-full ${sz.rows}`}>
          <ul className="space-y-3">
            {mix
              .filter((m) => preset.allocations.some((a) => a.id === m.id))
              .map((m) => (
                <li key={`${preset.id}-${m.id}`} className="grid grid-cols-[auto_1fr_auto] items-center gap-3">
                  <span
                    className="h-3 w-3 shrink-0 rounded-sm"
                    style={{ backgroundColor: m.color }}
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className={`truncate font-semibold text-slate-100 ${sz.text}`}>{m.label}</span>
                      <span className={`shrink-0 font-semibold tabular-nums text-slate-300 ${sz.text}`}>
                        {Math.round(m.now)}%
                      </span>
                    </div>
                    <div className="relative mt-1.5">
                      <div className={`overflow-hidden rounded-full bg-slate-800 ${sz.bar}`}>
                        <div
                          className="h-full rounded-full"
                          style={{ width: `${m.now}%`, backgroundColor: m.color }}
                        />
                      </div>
                      <span
                        aria-hidden="true"
                        className={`absolute ${sz.tick} w-0.5 -translate-x-1/2 rounded-full bg-slate-200`}
                        style={{ left: `${m.target}%` }}
                      />
                    </div>
                  </div>
                </li>
              ))}
            {/* Invisible filler rows keep the list height fixed across presets. */}
            {Array.from({ length: Math.max(0, maxRows - preset.allocations.length) }).map((_, i) => (
              <li
                key={`spacer-${i}`}
                aria-hidden="true"
                className="invisible grid grid-cols-[auto_1fr_auto] items-center gap-3"
              >
                <span className="h-3 w-3 shrink-0 rounded-sm" />
                <div className="min-w-0">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className={`font-semibold ${sz.text}`}>&nbsp;</span>
                  </div>
                  <div className={`mt-1.5 rounded-full ${sz.bar}`} />
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {showControls && (
        <div data-needs-js className="mt-8 flex flex-wrap justify-center gap-1.5">
          {presets.map((p, i) => (
            <button
              key={p.id}
              type="button"
              onClick={() => selectPreset(i)}
              aria-pressed={i === activeIndex}
              // 44 px touch height under `sm`.
              className={`inline-flex min-h-11 items-center rounded-lg border px-2.5 py-1.5 text-xs font-medium transition sm:min-h-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 ${
                i === activeIndex
                  ? "border-cyan-500/60 bg-cyan-500/10 text-cyan-300"
                  : "border-slate-800 bg-slate-900 text-slate-400 hover:border-slate-700 hover:text-slate-200"
              }`}
            >
              {p.title}
            </button>
          ))}
        </div>
      )}

      {renderAction && <div className="mt-8 flex justify-center">{renderAction(preset)}</div>}
    </div>
  );
}
