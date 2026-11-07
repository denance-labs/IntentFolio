"use client";

// Self-contained "watch a portfolio build itself" animation.
//
// Reusable on purpose: it takes its data and language via props (no app context),
// so it can be mounted inside the landing section, on the standalone /demo recording
// route, or anywhere else. The donut assembles slice by slice while the allocation
// rows slide in and their percentages count up.
//
// Motion is driven by a monotonic `playToken`: bumping it remounts the animated
// subtree (via `key`), which re-runs the entrance from scratch — that is how both the
// "replay" button and preset switching restart the build. The first play is triggered
// when the component scrolls into view. In `autoPlayLoop` mode (recording) it loops on
// a fixed cadence with the controls hidden.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { motion, useInView } from "framer-motion";
import { RotateCcw } from "lucide-react";
import { donutSlicePath } from "../lib/donut-geometry";
import type { DemoPreset } from "../lib/demo-presets";

const SIZE = 260;
const CENTER = SIZE / 2;
const R_OUTER = 120;
const R_INNER = 76;

// Timing (seconds). Kept in one place so the recording loop cadence stays in sync.
const SLICE_STAGGER = 0.13;
const SLICE_DELAY = 0.15;
const COUNT_DURATION = 1.1;
const ROW_STAGGER = 0.13;
// One full build + hold before the recording loop restarts (ms).
const LOOP_MS = 6200;

type Orientation = "auto" | "row" | "stack";

type Props = {
  presets: DemoPreset[];
  lang: "en" | "es";
  /** Hide the replay/preset controls (recording mode). Default: show them. */
  showControls?: boolean;
  /** Loop the build on a fixed cadence with no user input (recording mode). */
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
  default: { container: "max-w-3xl", donut: "w-[min(72vw,16rem)]", rows: "max-w-xs", text: "text-sm", bar: "h-1.5", gap: "gap-8" },
  showcase: { container: "max-w-6xl", donut: "w-[clamp(18rem,40vw,34rem)]", rows: "max-w-md", text: "text-xl", bar: "h-2.5", gap: "gap-10 sm:gap-16" },
} as const;

const COPY = {
  en: { replay: "Replay", assets: (n: number) => `${n} assets`, allocated: "allocated" },
  es: { replay: "Repetir", assets: (n: number) => `${n} activos`, allocated: "asignado" },
} as const;

/** Cumulative angle segments (degrees, 0 = top, clockwise) for the donut. */
function useSegments(preset: DemoPreset) {
  return useMemo(() => {
    let cursor = 0;
    return preset.allocations.map((a) => {
      const sweep = (a.pct / 100) * 360;
      const seg = { ...a, startAngle: cursor, endAngle: cursor + sweep };
      cursor += sweep;
      return seg;
    });
  }, [preset]);
}

/** Counts from 0 to `to` once `play` is true, restarting whenever `playKey` changes. */
function CountUp({
  to,
  play,
  playKey,
  delayMs,
  reduced,
}: {
  to: number;
  play: boolean;
  playKey: number;
  delayMs: number;
  reduced: boolean;
}) {
  const [val, setVal] = useState(0);

  useEffect(() => {
    if (!play) {
      setVal(0);
      return;
    }
    if (reduced) {
      setVal(to);
      return;
    }
    let raf = 0;
    const startAt = performance.now() + delayMs;
    const tick = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - startAt) / (COUNT_DURATION * 1000)));
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      setVal(to * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [to, play, playKey, delayMs, reduced]);

  return <>{Math.round(val)}</>;
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
  const copy = COPY[lang];
  const sz = SIZING[variant];
  const containerRef = useRef<HTMLDivElement>(null);
  const inView = useInView(containerRef, { once: false, margin: "-90px" });

  const [activeIndex, setActiveIndex] = useState(
    Math.min(Math.max(initialPresetIndex, 0), Math.max(presets.length - 1, 0))
  );
  // 0 = not yet played (donut empty); >0 = a build is/was running. Bumping replays.
  const [playToken, setPlayToken] = useState(0);
  const started = useRef(false);
  const [reduced, setReduced] = useState(false);

  // Read the OS reduced-motion preference on the client only (avoids SSR hydration
  // mismatch); used to snap the count-up to its final value instead of animating.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // First build kicks off when the component scrolls into view.
  useEffect(() => {
    if (inView && !started.current) {
      started.current = true;
      setPlayToken((t) => t + 1);
    }
  }, [inView]);

  // Recording mode: loop the build on a fixed cadence, no controls.
  useEffect(() => {
    if (!autoPlayLoop || !inView) return;
    const id = setInterval(() => setPlayToken((t) => t + 1), LOOP_MS);
    return () => clearInterval(id);
  }, [autoPlayLoop, inView]);

  const preset = presets[activeIndex] ?? presets[0];
  const segments = useSegments(preset);
  const playing = playToken > 0;

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
          onClick={replay}
          className="absolute right-0 top-0 z-10 inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900/80 px-3 py-1.5 text-xs font-medium text-slate-200 backdrop-blur transition hover:border-cyan-500/50 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
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
            aria-label={`${preset.title}: ${preset.allocations
              .map((a) => `${a.label} ${a.pct}%`)
              .join(", ")}`}
          >
            {/* Track ring */}
            <circle cx={CENTER} cy={CENTER} r={R_OUTER} className="fill-slate-800/50" />
            <circle cx={CENTER} cy={CENTER} r={R_INNER} className="fill-slate-950" />

            <motion.g
              key={playToken}
              initial="hidden"
              animate={playing ? "show" : "hidden"}
              variants={{
                hidden: {},
                show: { transition: { staggerChildren: SLICE_STAGGER, delayChildren: SLICE_DELAY } },
              }}
            >
              {segments.map((seg) => (
                <motion.path
                  key={`${preset.id}-${seg.id}`}
                  d={donutSlicePath(CENTER, CENTER, R_OUTER, R_INNER, seg.startAngle, seg.endAngle)}
                  fill={seg.color}
                  stroke="#020617"
                  strokeWidth={2.5}
                  strokeLinejoin="round"
                  variants={{
                    hidden: { opacity: 0, scale: 0.4 },
                    show: {
                      opacity: 1,
                      scale: 1,
                      transition: { type: "spring", stiffness: 240, damping: 20 },
                    },
                  }}
                  // Bloom each wedge from its own center, not the donut center.
                  style={{ transformBox: "fill-box", transformOrigin: "center" }}
                />
              ))}
            </motion.g>

            {/* Center label */}
            <g pointerEvents="none">
              <motion.text
                key={`title-${playToken}`}
                x={CENTER}
                y={CENTER - 4}
                textAnchor="middle"
                className="fill-slate-100"
                style={{ fontSize: 22, fontWeight: 700 }}
                initial={{ opacity: 0 }}
                animate={{ opacity: playing ? 1 : 0.25 }}
                transition={{ delay: 0.5, duration: 0.4 }}
              >
                {preset.title}
              </motion.text>
              <motion.text
                key={`sub-${playToken}`}
                x={CENTER}
                y={CENTER + 18}
                textAnchor="middle"
                className="fill-cyan-300"
                style={{ fontSize: 12, fontWeight: 500, letterSpacing: 0.4 }}
                initial={{ opacity: 0 }}
                animate={{ opacity: playing ? 1 : 0 }}
                transition={{ delay: 0.7, duration: 0.4 }}
              >
                {copy.assets(preset.allocations.length)}
              </motion.text>
            </g>
          </svg>
        </div>

        {/* Allocation rows */}
        <div className={`w-full ${sz.rows}`}>
          <ul className="space-y-3">
            {preset.allocations.map((a, i) => (
              <motion.li
                key={`${preset.id}-${a.id}-${playToken}`}
                className="grid grid-cols-[auto_1fr_auto] items-center gap-3"
                initial={{ opacity: 0, x: -12 }}
                animate={playing ? { opacity: 1, x: 0 } : { opacity: 0, x: -12 }}
                transition={{ delay: SLICE_DELAY + i * ROW_STAGGER, duration: 0.4, ease: "easeOut" }}
              >
                <span
                  className="h-3 w-3 shrink-0 rounded-sm"
                  style={{ backgroundColor: a.color }}
                  aria-hidden="true"
                />
                <div className="min-w-0">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className={`truncate font-semibold text-slate-100 ${sz.text}`}>{a.label}</span>
                    <span className={`shrink-0 font-semibold tabular-nums text-slate-300 ${sz.text}`}>
                      <CountUp
                        to={a.pct}
                        play={playing}
                        playKey={playToken}
                        delayMs={(SLICE_DELAY + i * ROW_STAGGER) * 1000}
                        reduced={reduced}
                      />
                      %
                    </span>
                  </div>
                  <div className={`mt-1.5 overflow-hidden rounded-full bg-slate-800 ${sz.bar}`}>
                    <motion.div
                      key={`bar-${preset.id}-${a.id}-${playToken}`}
                      className="h-full origin-left rounded-full"
                      style={{ width: `${a.pct}%`, backgroundColor: a.color }}
                      initial={{ scaleX: 0 }}
                      animate={playing ? { scaleX: 1 } : { scaleX: 0 }}
                      transition={{
                        delay: SLICE_DELAY + i * ROW_STAGGER,
                        duration: 0.9,
                        ease: "easeOut",
                      }}
                    />
                  </div>
                </div>
              </motion.li>
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
        <div className="mt-8 flex flex-wrap justify-center gap-1.5">
          {presets.map((p, i) => (
            <button
              key={p.id}
              type="button"
              onClick={() => selectPreset(i)}
              aria-pressed={i === activeIndex}
              className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 ${
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
