"use client";

import { motion } from "framer-motion";

type BandDiagramProps = {
  targetLabel: string;
  bandLabel: string;
  buildingLabel: string;
  onTargetLabel: string;
  spreadLabel: string;
};

// Illustrative "position meter": a horizontal track where a marker represents one asset's
// share of the portfolio. The shaded zone is the tolerance band, centered on the target.
// Top row: on the way to the target, swaps move the marker toward the band step by step (faded dots
// are earlier positions). Bottom row: once inside, it keeps taking part in swaps and moves
// around without leaving the band. Each "+" is a swap aiming for spread in the user's favor —
// on the way and once there (CONTEXT.md, External-Driven Rebalance). Decorative, not data-driven.
//
// viewBox 0 0 320 220. Track spans X 36→284 (center 160). Band is ±34 around center.
const X1 = 36;
const X2 = 284;
const CX = 160;
const BAND_HALF = 34;
const ROW1_Y = 70;
const ROW2_Y = 156;
const CYAN = "#06b6d4";
const SPREAD = "#34d399";

// Row 1: earlier positions (oldest first), then where the marker is now — still short of the band.
const BUILD_STEPS = [56, 78, 98];
const BUILD_NOW = 116;
// Row 2: earlier positions, all inside the band, then where the marker is now.
const INSIDE_STEPS = [150, 186, 134];
const INSIDE_NOW = 168;

function Track({ y }: { y: number }) {
  return (
    <>
      {/* Tolerance band zone */}
      <rect
        x={CX - BAND_HALF}
        y={y - 14}
        width={BAND_HALF * 2}
        height={28}
        rx={6}
        fill="rgba(6,182,212,0.12)"
      />
      {/* Band edges */}
      <line x1={CX - BAND_HALF} y1={y - 14} x2={CX - BAND_HALF} y2={y + 14} stroke={CYAN} strokeWidth={1} strokeDasharray="3 3" strokeOpacity={0.6} />
      <line x1={CX + BAND_HALF} y1={y - 14} x2={CX + BAND_HALF} y2={y + 14} stroke={CYAN} strokeWidth={1} strokeDasharray="3 3" strokeOpacity={0.6} />
      {/* Base track line */}
      <line x1={X1} y1={y} x2={X2} y2={y} stroke="#334155" strokeWidth={2} strokeLinecap="round" />
      {/* Target tick */}
      <line x1={CX} y1={y - 16} x2={CX} y2={y + 16} stroke={CYAN} strokeWidth={2} strokeLinecap="round" />
    </>
  );
}

// Earlier positions fade with age; the current one is solid with a halo.
function Steps({ y, past, now }: { y: number; past: number[]; now: number }) {
  return (
    <>
      {past.map((x, i) => (
        <circle key={x} cx={x} cy={y} r={5} fill={CYAN} fillOpacity={0.3 + (0.4 * i) / past.length} />
      ))}
      <circle cx={now} cy={y} r={8} fill={CYAN} />
      <circle cx={now} cy={y} r={8} fill="none" stroke={CYAN} strokeWidth={6} strokeOpacity={0.25} />
    </>
  );
}

// A small "+" above each position: that swap aimed for spread in the user's favor.
function SpreadMarks({ y, xs }: { y: number; xs: number[] }) {
  return (
    <>
      {xs.map((x) => (
        <text key={x} x={x} y={y - 18} fontSize={10} fill={SPREAD} textAnchor="middle" fontWeight="700">
          +
        </text>
      ))}
    </>
  );
}

export function BandDiagram({
  targetLabel,
  bandLabel,
  buildingLabel,
  onTargetLabel,
  spreadLabel,
}: BandDiagramProps) {
  return (
    <motion.div
      className="my-6 overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/60 p-4"
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.4, ease: "easeOut" }}
    >
      <svg viewBox="0 0 320 220" aria-hidden="true" className="mx-auto w-full max-w-md">
        <defs>
          <marker id="band-arrow" markerWidth="7" markerHeight="7" refX="5" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" fill={CYAN} />
          </marker>
        </defs>

        {/* Target label, above everything */}
        <text x={CX} y={18} fontSize={10} fill="#67e8f9" textAnchor="middle" fontWeight="600">
          {targetLabel}
        </text>

        {/* ── Row 1: building toward the target ── */}
        <text x={X1} y={ROW1_Y - 30} fontSize={9} fill="#94a3b8" textAnchor="start">
          {buildingLabel}
        </text>
        <Track y={ROW1_Y} />
        <Steps y={ROW1_Y} past={BUILD_STEPS} now={BUILD_NOW} />
        <SpreadMarks y={ROW1_Y} xs={[...BUILD_STEPS, BUILD_NOW]} />
        {/* Where it is heading: into the band */}
        <line
          x1={BUILD_NOW + 12}
          y1={ROW1_Y + 22}
          x2={CX - 4}
          y2={ROW1_Y + 22}
          stroke={CYAN}
          strokeWidth={1.5}
          strokeDasharray="4 3"
          markerEnd="url(#band-arrow)"
        />

        {/* ── Row 2: on target, moving inside the band ── */}
        <text x={X1} y={ROW2_Y - 30} fontSize={9} fill="#94a3b8" textAnchor="start">
          {onTargetLabel}
        </text>
        <Track y={ROW2_Y} />
        <Steps y={ROW2_Y} past={INSIDE_STEPS} now={INSIDE_NOW} />
        <SpreadMarks y={ROW2_Y} xs={[...INSIDE_STEPS, INSIDE_NOW]} />
        {/* Band label, under the band on the bottom row */}
        <text x={CX} y={ROW2_Y + 30} fontSize={9} fill="#64748b" textAnchor="middle">
          {bandLabel}
        </text>

        {/* Legend for the "+" marks */}
        <text x={CX} y={ROW2_Y + 54} fontSize={9} fill="#94a3b8" textAnchor="middle">
          <tspan fill={SPREAD} fontWeight="700">+ </tspan>
          {spreadLabel}
        </text>
      </svg>
    </motion.div>
  );
}
