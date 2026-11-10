"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChartRow } from "../types";
import { NO_BUY_ROUTE_TOKEN_IDS } from "@/features/bridge/lib/token-availability";
import { colorForSymbol, formatUsd, type RingColor } from "../lib/format";
import { MiniBand, MiniBandLegend } from "./mini-band";
import { ShowcaseDonut } from "@/features/portfolio-showcase/components/showcase-donut";
import { isOutsideTap } from "@/features/portfolio-showcase/lib/pin";
import type { ShowcaseToken } from "@/features/portfolio-showcase/types";

type CompositionProps = {
  rows: ChartRow[];
  currentTotalUsd: number;
  targetTotalUsd: number;
  t: Record<string, string>;
};

/**
 * Names for the legend and the donut center, keyed by token id. A symbol is not unique
 * (ETH on Ethereum and ETH on NEAR): when one repeats in the set, those tokens go by their
 * registry name instead, which says where each one is (D-407).
 */
function tokenLabels(rows: ChartRow[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.symbol, (counts.get(row.symbol) ?? 0) + 1);
  return new Map(
    rows.map((row) => [row.tokenId, (counts.get(row.symbol) ?? 0) > 1 ? (row.token?.name ?? row.symbol) : row.symbol])
  );
}

/** Resolve a token color from the shared per-set map, falling back to the symbol hash. */
function resolveColor(colorByToken: Map<string, RingColor> | undefined, row: Pick<ChartRow, "tokenId" | "symbol">): RingColor {
  return colorByToken?.get(row.tokenId) ?? colorForSymbol(row.symbol);
}

export function CompositionBars({ rows, currentTotalUsd, colorByToken, t }: CompositionProps & { colorByToken?: Map<string, RingColor> }) {
  const visibleRows = rows.filter((row) => row.symbol);

  return (
    <div className="rounded-2xl glass p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h2 className="text-sm font-semibold text-slate-200">{t.comparison}</h2>
        <MiniBandLegend now={t.bandLegendNow} target={t.bandLegendTarget} />
      </div>

      {visibleRows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-700 bg-card/40 px-4 py-8 text-center text-xs text-slate-400">
          {t.emptyPortfolio}
        </div>
      ) : (
        <div className="space-y-2.5">
          {visibleRows.map((row) => {
            const currentPct = row.currentPct || 0;
            const targetPct = row.targetPct || 0;
            // D-510: one MiniBand per token (the editor's marks: dot = now, line = target) instead
            // of two look-alike bars; no range here, the dotted line runs to the target. D-513: a
            // token held with no target is sold whole, so its line runs to 0 like a 0% target's.
            const state = row.bandState;

            return (
              <div key={`chart-${row.id}`} className="grid grid-cols-[112px_1fr_60px] items-center gap-2.5 text-xs sm:grid-cols-[132px_1fr_120px] sm:gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: resolveColor(colorByToken, row).hex }} aria-hidden="true" />
                  <div className="flex min-w-0 flex-col leading-tight">
                    <span className="font-semibold text-slate-100">{row.symbol}</span>
                    <span className="truncate text-[10px] text-slate-400">{row.token?.name}</span>
                  </div>
                </div>
                <MiniBand
                  minPct={row.minPct}
                  targetPct={targetPct}
                  maxPct={row.maxPct}
                  currentPct={currentPct}
                  state={state}
                  canRise={!NO_BUY_ROUTE_TOKEN_IDS.has(row.tokenId)}
                  showRange={false}
                  label={(state === "empty" ? t.miniBandAriaNoRangeEmpty : t.miniBandAriaNoRange)
                    .replace("{current}", currentPct.toFixed(1))
                    .replace("{target}", targetPct.toFixed(1))}
                />
                <div className="text-right text-slate-400 tabular-nums">
                  {currentTotalUsd > 0 ? currentPct.toFixed(1) : "0.0"}% → {targetPct.toFixed(1)}%
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * One of Composition's donuts, drawn by the Overview's (D-547): the same glass slices, halo and
 * Now/Target morph, with Composition's own center (the side's name, or the lit token's share and USD).
 */
function Donut({
  tokens,
  mode,
  totalUsd,
  activeTokenId,
  onHoverToken,
  onToggleToken,
  label,
  labelByToken,
}: {
  tokens: ShowcaseToken[];
  mode: "current" | "target";
  totalUsd: number;
  // Keyed by token id: two tokens can share a symbol (ETH on Ethereum / on NEAR).
  activeTokenId: string | null;
  onHoverToken: (tokenId: string | null) => void;
  onToggleToken: (tokenId: string) => void;
  label: string;
  labelByToken: Map<string, string>;
}) {
  const shareOf = (token: ShowcaseToken) => (mode === "current" ? token.currentPct : token.targetPct);
  const usdOf = (token: ShowcaseToken) => (mode === "current" ? token.currentUsd : token.targetUsd);

  // A token can be lit here while it has no slice in this donut (0% current, or a 0% target):
  // the center still names it, with its 0, so both donuts answer the same hover.
  const centerFor = (token: ShowcaseToken) => {
    const name = labelByToken.get(token.tokenId) ?? token.symbol;
    // A registry name ("Ethereum (on NEAR)") is too wide for the hole in uppercase: it wraps instead.
    const long = name.length > 10;
    return (
      <div className="max-w-[50%]">
        <p className={`line-clamp-2 leading-tight text-slate-400 ${long ? "text-[10px]" : "text-[11px] uppercase"}`}>{name}</p>
        <p className="mt-0.5 text-[19px] font-semibold leading-tight tabular-nums text-slate-100">{shareOf(token).toFixed(1)}%</p>
        <p className="text-[11px] tabular-nums text-accent">{formatUsd(usdOf(token))}</p>
      </div>
    );
  };

  return (
    <ShowcaseDonut
      tokens={tokens}
      mode={mode}
      activeTokenId={activeTokenId}
      onHover={onHoverToken}
      onToggle={onToggleToken}
      ariaLabel={`${label}: ${formatUsd(totalUsd)}`}
      tokenAriaLabel={(token) => `${labelByToken.get(token.tokenId) ?? token.symbol}: ${shareOf(token).toFixed(1)}%, ${formatUsd(usdOf(token))}`}
      center={<p className="text-[13px] font-semibold uppercase text-slate-400">{label}</p>}
      centerFor={centerFor}
      className="w-full max-w-[200px]"
    />
  );
}

/** The rows as the Overview's donut takes them; only id, color and the two shares and USD are drawn. */
function toDonutTokens(rows: ChartRow[], colorByToken: Map<string, RingColor> | undefined, labelByToken: Map<string, string>): ShowcaseToken[] {
  return rows.map((row) => ({
    tokenId: row.tokenId,
    symbol: row.symbol,
    name: row.token?.name ?? row.symbol,
    label: labelByToken.get(row.tokenId) ?? row.symbol,
    color: resolveColor(colorByToken, row).hex,
    currentPct: row.currentPct || 0,
    targetPct: row.targetPct || 0,
    currentUsd: row.currentUsd || 0,
    targetUsd: row.targetUsd || 0,
    bandState: row.bandState,
  }));
}

export function CompositionDonuts({ rows, currentTotalUsd, targetTotalUsd, colorByToken, t }: CompositionProps & { colorByToken?: Map<string, RingColor> }) {
  const [hovered, setHovered] = useState<string | null>(null);
  // A tapped slice stays lit, as on the Overview, until it is tapped again or a tap lands elsewhere.
  const [pinned, setPinned] = useState<string | null>(null);
  const hoveredTokenId = hovered ?? pinned;
  const togglePinned = useCallback((tokenId: string) => setPinned((current) => (current === tokenId ? null : tokenId)), []);
  useEffect(() => {
    if (pinned === null) return;
    const release = (e: MouseEvent) => {
      if (isOutsideTap(e.target)) setPinned(null);
    };
    document.addEventListener("click", release);
    return () => document.removeEventListener("click", release);
  }, [pinned]);
  const [mobileMode, setMobileMode] = useState<"current" | "target">("current");
  const legendRows = useMemo(() => rows.filter((row) => row.symbol), [rows]);
  const sortedLegend = useMemo(() => [...legendRows].sort((a, b) => (b.currentUsd || 0) - (a.currentUsd || 0)), [legendRows]);
  const labelByToken = useMemo(() => tokenLabels(legendRows), [legendRows]);
  const donutTokens = useMemo(() => toDonutTokens(legendRows, colorByToken, labelByToken), [legendRows, colorByToken, labelByToken]);

  const legendButtons = (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {sortedLegend.map((row) => {
        const color = resolveColor(colorByToken, row);
        const isHovered = hoveredTokenId === row.tokenId;
        const isDimmed = hoveredTokenId && !isHovered;

        return (
          <button
            key={`legend-${row.tokenId}`}
            onMouseEnter={() => setHovered(row.tokenId)}
            onMouseLeave={() => setHovered(null)}
            onFocus={() => setHovered(row.tokenId)}
            onBlur={() => setHovered(null)}
            type="button"
            aria-label={`Highlight ${labelByToken.get(row.tokenId) ?? row.symbol}`}
            className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium tabular-nums transition ${
              isHovered
                ? "text-slate-100"
                : isDimmed
                  ? "border-slate-800 bg-slate-900 text-slate-500 opacity-40"
                  : "border-slate-800 bg-slate-900 text-slate-300 hover:border-slate-700 hover:text-slate-100"
            }`}
            // D-508: the hovered chip wears its token's color, so it matches the lit slice.
            style={isHovered ? { borderColor: color.hex, backgroundColor: `${color.hex}26` } : undefined}
          >
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: color.hex }} />
            <span>{labelByToken.get(row.tokenId) ?? row.symbol}</span>
          </button>
        );
      })}
    </div>
  );

  return (
    <div>
      {/* Mobile: single donut with current/target toggle */}
      <div className="lg:hidden">
        <div className="mb-3 flex justify-center gap-1 rounded-xl bg-slate-900 p-1">
          <button
            type="button"
            onClick={() => setMobileMode("current")}
            aria-pressed={mobileMode === "current"}
            className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
              mobileMode === "current"
                ? "bg-slate-700 text-slate-100 shadow"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            {t.currentPortfolio}
          </button>
          <button
            type="button"
            onClick={() => setMobileMode("target")}
            aria-pressed={mobileMode === "target"}
            className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
              mobileMode === "target"
                ? "bg-slate-700 text-slate-100 shadow"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            {t.targetPortfolio}
          </button>
        </div>
        <div className="flex justify-center rounded-2xl border border-slate-800 bg-card p-3">
          <Donut
            tokens={donutTokens}
            mode={mobileMode}
            totalUsd={mobileMode === "current" ? currentTotalUsd : targetTotalUsd}
            activeTokenId={hoveredTokenId}
            onHoverToken={setHovered}
            onToggleToken={togglePinned}
            label={mobileMode === "current" ? t.currentPortfolio : t.targetPortfolio}
            labelByToken={labelByToken}
          />
        </div>
        {legendButtons}
      </div>

      {/* Desktop: side-by-side donuts */}
      <div className="hidden lg:block">
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-slate-800 bg-card p-3">
            <Donut tokens={donutTokens} mode="current" totalUsd={currentTotalUsd} activeTokenId={hoveredTokenId} onHoverToken={setHovered} onToggleToken={togglePinned} label={t.currentPortfolio} labelByToken={labelByToken} />
          </div>
          <div className="flex flex-col items-center text-slate-600" aria-hidden="true">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
              <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-slate-800 bg-card p-3">
            <Donut tokens={donutTokens} mode="target" totalUsd={targetTotalUsd} activeTokenId={hoveredTokenId} onHoverToken={setHovered} onToggleToken={togglePinned} label={t.targetPortfolio} labelByToken={labelByToken} />
          </div>
        </div>
        {legendButtons}
      </div>
    </div>
  );
}
