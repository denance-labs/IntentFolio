"use client";

import { useId, useMemo, type ReactNode } from "react";
import { conicStops, ringSegments } from "../lib/showcase-geometry";
import { clickPins } from "../lib/pin";
import { ShowcaseLeaders, type RingGeometry } from "./showcase-leaders";
import type { ShowcaseToken } from "../types";

const CENTER = 120;
// D-520 widened the ring (24 → 40), D-537 again (→ 46) inward: the outer edge stays at 114.
const RADIUS = 91;
const STROKE = 46;
// D-537: the lit slice thickens outward only (its inner edge stays put), up to the 240 view box's edge.
const GROW = 6;
// The dark disc behind the center text, just inside the ring.
const DISC = RADIUS - STROKE / 2 - 4;
// Surface gap between neighbours, in view-box units along the ring (~3 px at 240 px).
const GAP = 3.2;
// D-521 glass: the hairline sits this far inside each slice's edge, so it is drawn on the slice.
const EDGE_INSET = 0.6;
/** The ring as the labels beside it (D-522) see it. */
export const RING: RingGeometry = { center: CENTER, ringRadius: RADIUS, ringOuter: RADIUS + STROKE / 2 + GROW };

type Props = {
  tokens: ShowcaseToken[];
  mode: "current" | "target";
  /** Lit token (hovered, focused or tapped), shared with everything else on the showcase. */
  activeTokenId: string | null;
  onHover: (tokenId: string | null) => void;
  onToggle: (tokenId: string) => void;
  ariaLabel: string;
  tokenAriaLabel: (token: ShowcaseToken) => string;
  center: ReactNode;
  centerFor: (token: ShowcaseToken) => ReactNode;
  /** Entry animation delay; the ring comes in as a whole so the slices stay free for hover. */
  enterDelayMs?: number;
  /** Labels with lines outside the ring (D-522, wide screens), keeping clear of this side. */
  leaders?: "left" | "right";
  className?: string;
};

/**
 * The Overview's donut (D-518). Each token is one dashed circle rather than a sector path: the
 * dashes move with a CSS transition, which is how the phone's Now/Target switch morphs one mix
 * into the other. Chrome hit-tests only the painted dash, so each slice still answers its own
 * pointer (measured 2026-10-22 on the mockups).
 *
 * D-521 paints each slice as glass, every layer built from dashes so the morph still carries it:
 * a blurred copy behind (light seen through), a translucent body whose glow fades from where the
 * slice starts, a sheen on the top half, and a hairline on all four sides (two dashed edges plus
 * two end caps that rotate with the slice).
 *
 * D-537: every dashed circle is measured on the base ring (`pathLength`), so its dashes keep their
 * angle when its radius moves. Without it the lit slice's hairlines drifted along the ring while
 * their radius and their dashes caught up at different speeds.
 */
export function ShowcaseDonut({
  tokens,
  mode,
  activeTokenId,
  onHover,
  onToggle,
  ariaLabel,
  tokenAriaLabel,
  center,
  centerFor,
  enterDelayMs = 0,
  leaders,
  className = "",
}: Props) {
  const shares = useMemo(
    () => tokens.map((t) => ({ tokenId: t.tokenId, pct: mode === "current" ? t.currentPct : t.targetPct })),
    [tokens, mode]
  );
  const { circumference, segments } = useMemo(() => ringSegments(shares, RADIUS, GAP), [shares]);
  const glow = useMemo(
    () => conicStops(tokens.map((t) => ({ color: t.color, pct: mode === "current" ? t.currentPct : t.targetPct }))),
    [tokens, mode]
  );
  const byId = useMemo(() => new Map(tokens.map((t) => [t.tokenId, t])), [tokens]);
  const active = activeTokenId ? byId.get(activeTokenId) ?? null : null;
  // Gradient and filter ids must be unique per donut: the desktop pair and the phone one coexist.
  const uid = `ov${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  return (
    <div className={`relative aspect-square ${className}`}>
      {/* The halo is the ring's own colors, blurred: light that comes from the data. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-[15%] rounded-full opacity-30 blur-[44px]"
        style={{ background: `conic-gradient(${glow})` }}
      />
      <svg viewBox="0 0 240 240" role="group" aria-label={ariaLabel} className="relative block h-full w-full overflow-visible">
        {/* D-571: track and disc read the slate steps, so they turn graphite in the app; outside it
            (the landing's hero) those keep Tailwind's values and these look as before. */}
        <circle cx={CENTER} cy={CENTER} r={RADIUS} fill="none" className="stroke-slate-400/[0.07]" strokeWidth={STROKE} />
        <circle cx={CENTER} cy={CENTER} r={DISC} className="fill-slate-950/55" />
        <defs>
          <filter id={`${uid}-blur`} x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="6" />
          </filter>
          {/* Inside the ring's −90° turn the view's top is local +x: white there, nothing past the middle. */}
          <linearGradient id={`${uid}-sheen`} gradientUnits="userSpaceOnUse" x1={CENTER + RADIUS + STROKE / 2} y1={CENTER} x2={CENTER - RADIUS - STROKE / 2} y2={CENTER}>
            <stop offset="0" stopColor="#fff" stopOpacity="0.3" />
            <stop offset="0.3" stopColor="#fff" stopOpacity="0.07" />
            <stop offset="0.48" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
          {segments.map((segment, index) => {
            const token = byId.get(segment.tokenId);
            if (!token) return null;
            // The glow runs from the slice's start toward its end (at most half the ring away).
            const from = -segment.offset / RADIUS;
            const to = from + Math.min(segment.dash / RADIUS, Math.PI);
            const strong = activeTokenId === token.tokenId;
            return (
              <linearGradient
                key={token.tokenId}
                id={`${uid}-glow-${index}`}
                gradientUnits="userSpaceOnUse"
                x1={CENTER + RADIUS * Math.cos(from)}
                y1={CENTER + RADIUS * Math.sin(from)}
                x2={CENTER + RADIUS * Math.cos(to)}
                y2={CENTER + RADIUS * Math.sin(to)}
              >
                <stop offset="0" stopColor={token.color} stopOpacity={strong ? 0.85 : 0.72} />
                <stop offset="1" stopColor={token.color} stopOpacity={strong ? 0.5 : 0.26} />
              </linearGradient>
            );
          })}
        </defs>
        <g className="ov-donut-in" style={{ animationDelay: `${enterDelayMs}ms` }}>
          <g transform={`rotate(-90 ${CENTER} ${CENTER})`}>
            {/* The light behind the glass: each slice's own color, blurred, seen through its body. */}
            <g filter={`url(#${uid}-blur)`} aria-hidden="true" className="pointer-events-none">
              {segments.map((segment) => {
                const token = byId.get(segment.tokenId);
                if (!token) return null;
                const isActive = activeTokenId === token.tokenId;
                const isDimmed = activeTokenId !== null && !isActive;
                return (
                  <circle
                    key={token.tokenId}
                    cx={CENTER}
                    cy={CENTER}
                    r={RADIUS}
                    pathLength={circumference}
                    fill="none"
                    stroke={token.color}
                    strokeOpacity={0.55}
                    className="ov-slice"
                    style={{
                      r: isActive ? RADIUS + GROW / 2 : RADIUS,
                      strokeWidth: (isActive ? STROKE + GROW : STROKE) - 10,
                      strokeDasharray: `${segment.dash} ${circumference - segment.dash}`,
                      strokeDashoffset: segment.offset,
                      opacity: isDimmed ? 0.15 : 1,
                    }}
                  />
                );
              })}
            </g>
            {segments.map((segment, index) => {
              const token = byId.get(segment.tokenId);
              if (!token) return null;
              const painted = segment.dash > 0;
              const isActive = activeTokenId === token.tokenId;
              const isDimmed = activeTokenId !== null && !isActive;
              const width = isActive ? STROKE + GROW : STROKE;
              const r = isActive ? RADIUS + GROW / 2 : RADIUS;
              const dashes = { r, strokeDasharray: `${segment.dash} ${circumference - segment.dash}`, strokeDashoffset: segment.offset };
              const inner = r - width / 2 + EDGE_INSET;
              const outer = r + width / 2 - EDGE_INSET;
              // Edges are dashes on their own circles; `pathLength` keeps them on the slice's angle.
              const edge = (edgeR: number) => (
                <circle
                  cx={CENTER}
                  cy={CENTER}
                  r={edgeR}
                  pathLength={circumference}
                  fill="none"
                  stroke={token.color}
                  strokeOpacity={0.95}
                  strokeWidth={1.2}
                  className="ov-slice pointer-events-none"
                  style={{ ...dashes, r: edgeR }}
                />
              );
              const startDeg = (-segment.offset / RADIUS) * (180 / Math.PI);
              const endDeg = startDeg + (segment.dash / RADIUS) * (180 / Math.PI);
              const cap = (deg: number) => (
                <line
                  x1={CENTER + inner}
                  y1={CENTER}
                  x2={CENTER + outer}
                  y2={CENTER}
                  stroke={token.color}
                  strokeOpacity={0.95}
                  strokeWidth={1.2}
                  strokeLinecap="round"
                  className="ov-cap pointer-events-none"
                  style={{ transform: `rotate(${deg}deg)`, opacity: painted ? 1 : 0 }}
                />
              );
              return (
                <g
                  key={token.tokenId}
                  className="ov-slice"
                  style={{
                    opacity: isDimmed ? 0.2 : 1,
                    filter: isActive ? `drop-shadow(0 0 7px ${token.color}aa)` : isDimmed ? "saturate(0.35)" : "none",
                  }}
                >
                  <circle
                    cx={CENTER}
                    cy={CENTER}
                    r={RADIUS}
                    pathLength={circumference}
                    fill="none"
                    stroke={`url(#${uid}-glow-${index})`}
                    className="ov-slice cursor-pointer outline-none"
                    style={{ strokeWidth: width, ...dashes }}
                    role={painted ? "button" : undefined}
                    tabIndex={painted ? 0 : -1}
                    aria-hidden={painted ? undefined : true}
                    aria-label={painted ? tokenAriaLabel(token) : undefined}
                    aria-pressed={painted ? isActive : undefined}
                    // Hover only follows a mouse: a tap must not leave a token lit on touch.
                    onPointerEnter={(e) => {
                      if (e.pointerType === "mouse") onHover(token.tokenId);
                    }}
                    onPointerLeave={(e) => {
                      if (e.pointerType === "mouse") onHover(null);
                    }}
                    onFocus={() => onHover(token.tokenId)}
                    onBlur={() => onHover(null)}
                    onClick={(e) => {
                      if (clickPins(e)) onToggle(token.tokenId);
                    }}
                    data-showcase-token=""
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onToggle(token.tokenId);
                      }
                    }}
                  />
                  {/* Mounted even with no dash (D-568): a slice growing from zero then grows its sheen and
                      edges and turns its caps from where it starts, instead of showing them at their final
                      place from the first frame. With no dash they draw nothing, and the caps are hidden. */}
                  <g aria-hidden="true">
                    <circle
                      cx={CENTER}
                      cy={CENTER}
                      r={RADIUS}
                      pathLength={circumference}
                      fill="none"
                      stroke={`url(#${uid}-sheen)`}
                      className="ov-slice pointer-events-none"
                      style={{ strokeWidth: width, ...dashes }}
                    />
                    {edge(inner)}
                    {edge(outer)}
                    {cap(startDeg)}
                    {cap(endDeg)}
                  </g>
                </g>
              );
            })}
          </g>
        </g>
        {leaders ? (
          <ShowcaseLeaders
            tokens={tokens}
            mode={mode}
            activeTokenId={activeTokenId}
            innerSide={leaders}
            ring={RING}
            onHover={onHover}
            onToggle={onToggle}
          />
        ) : null}
      </svg>
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-center">
        {active ? centerFor(active) : center}
      </div>
    </div>
  );
}
