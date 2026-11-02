"use client";

import { useMemo } from "react";
import { leaderLabels, type LeaderLabel } from "../lib/showcase-geometry";
import { clickPins } from "../lib/pin";
import { formatShare } from "../lib/format";
import type { ShowcaseToken } from "../types";

// View-box units; the donut is 380 px wide where these show, so 1 unit ≈ 1.6 px.
const LABEL_RADIUS = 128;
const PCT_SIZE = 7.6; // ~12 px
const SYMBOL_SIZE = 6.6; // ~10.5 px
/** Shares below this (in %) get no label: too thin to point at. */
export const LABEL_MIN_SHARE = 3;

export type RingGeometry = {
  center: number;
  ringRadius: number;
  /** Outer edge of a lit (thicker) slice: the lines start just past it. */
  ringOuter: number;
};

/**
 * Where each label of one donut goes, or none for a token too thin to label or left without room.
 * Shared with the stage, which shows a chip for any token neither donut could label.
 */
export function placeLeaders(
  tokens: ShowcaseToken[],
  mode: "current" | "target",
  innerSide: "left" | "right",
  ring: RingGeometry,
): LeaderLabel[] {
  return leaderLabels(
    tokens.map((t) => ({ tokenId: t.tokenId, pct: mode === "current" ? t.currentPct : t.targetPct })),
    {
      center: ring.center,
      ringRadius: ring.ringRadius,
      lineStart: ring.ringOuter + 2,
      labelRadius: LABEL_RADIUS,
      tail: 6,
      textGap: 2.5,
      innerSide,
      keepOut: 42,
      minGap: 17,
      minShare: LABEL_MIN_SHARE,
    },
  );
}

type Props = {
  tokens: ShowcaseToken[];
  mode: "current" | "target";
  activeTokenId: string | null;
  /** The side facing the other donut: its labels keep clear of the move shown between them. */
  innerSide: "left" | "right";
  ring: RingGeometry;
  onHover: (tokenId: string | null) => void;
  onToggle: (tokenId: string) => void;
};

/**
 * Labels outside the donut, each with a thin line to its slice (D-522): the share on top, the
 * symbol under it. Two short lines instead of one long one, so the widest (USDT(NEAR), ~66 px)
 * fits both the 89 px beside the pair and half the gap between the donuts. Wide screens only (the
 * caller hides it below xl), where they take the legend chips' place; the slices already name
 * every token to a screen reader, so this is hidden from it. Hovering or tapping a label lights
 * its token like a chip does.
 */
export function ShowcaseLeaders({ tokens, mode, activeTokenId, innerSide, ring, onHover, onToggle }: Props) {
  const labels = useMemo(() => placeLeaders(tokens, mode, innerSide, ring), [tokens, mode, innerSide, ring]);
  const byId = useMemo(() => new Map(tokens.map((t) => [t.tokenId, t])), [tokens]);
  // The second line: the symbol, plus the network when another token shares it ("ETH · NEAR"), as
  // the long registry name the chips use does not fit beside the ring.
  const names = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of tokens) counts.set(t.symbol, (counts.get(t.symbol) ?? 0) + 1);
    return new Map(
      tokens.map((t) => [t.tokenId, (counts.get(t.symbol) ?? 0) > 1 && t.network ? `${t.symbol} · ${t.network}` : t.symbol]),
    );
  }, [tokens]);

  return (
    <g aria-hidden="true" className="ov-fade hidden xl:inline">
      {labels.map((label) => {
        const token = byId.get(label.tokenId);
        if (!token) return null;
        const isActive = activeTokenId === token.tokenId;
        const isDimmed = activeTokenId !== null && !isActive;
        const anchor = label.side === "right" ? "start" : "end";
        // A transparent box over the text, so the gaps between letters still count as the label.
        const name = names.get(token.tokenId) ?? token.symbol;
        const width = Math.max(formatShare(label.pct).length * PCT_SIZE * 0.6, name.length * SYMBOL_SIZE * 0.6);
        const boxX = label.side === "right" ? label.text.x : label.text.x - width;
        return (
          <g
            key={token.tokenId}
            className="cursor-pointer transition-opacity duration-200"
            style={{ opacity: isDimmed ? 0.22 : 1 }}
            data-showcase-token=""
            onPointerEnter={(e) => {
              if (e.pointerType === "mouse") onHover(token.tokenId);
            }}
            onPointerLeave={(e) => {
              if (e.pointerType === "mouse") onHover(null);
            }}
            onClick={(e) => {
              if (clickPins(e)) onToggle(token.tokenId);
            }}
          >
            <path
              d={label.path}
              fill="none"
              stroke={token.color}
              strokeOpacity={isActive ? 1 : 0.75}
              strokeWidth={isActive ? 0.9 : 0.6}
              strokeLinejoin="round"
            />
            <circle cx={label.dot.x} cy={label.dot.y} r={1.7} fill="#fff" stroke={token.color} strokeWidth={0.8} />
            <rect x={boxX} y={label.text.y - PCT_SIZE * 0.7} width={width} height={PCT_SIZE * 0.7 + SYMBOL_SIZE * 1.6} fill="transparent" />
            <text x={label.text.x} y={label.text.y + PCT_SIZE * 0.35} textAnchor={anchor} fontSize={PCT_SIZE} fontWeight={600} fill="#fff" className="tabular-nums">
              {formatShare(label.pct)}
            </text>
            <text
              x={label.text.x}
              y={label.text.y + PCT_SIZE * 0.35 + SYMBOL_SIZE * 1.25}
              textAnchor={anchor}
              fontSize={SYMBOL_SIZE}
              fill={isActive ? "#e2e8f0" : "#94a3b8"}
            >
              {name}
            </text>
          </g>
        );
      })}
    </g>
  );
}
