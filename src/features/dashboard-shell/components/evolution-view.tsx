"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { usePortfolio } from "../context/portfolio-context";
import { useLanguage } from "../context/language-context";
import { shellTranslations, type ShellTranslations } from "../lib/translations";
import {
  buildEvolutionSeries,
  hasCurve,
  sliceEvolution,
  type EvolutionPoint,
  type EvolutionSeries,
} from "../lib/evolution-series";
import { SkeletonBlock } from "./view-states";
import { formatUsd } from "@/features/portfolio-editor/lib/format";
import { usePortfolioComputed } from "@/features/portfolio-editor/hooks/use-portfolio-computed";
import { useTokenPrices } from "@/features/market/hooks/use-token-prices";
import { getTokenById, symbolForTokenId } from "@/features/market/lib/token-registry";
import { usePortfolioComposition } from "@/features/vault/hooks/use-portfolio-composition";
import type { CurrentPortfolioQty, Language, TargetAllocation } from "@/features/portfolio-editor/types";

const NO_TARGETS: TargetAllocation[] = [];
const NO_DEPOSITS: CurrentPortfolioQty = {};

// --- Chart constants ---
// Drawn in CSS pixels at the container's width, not in a fixed viewBox like Performance's: scaled,
// that box made the labels ~5 px at 390 px and ~20 px on desktop.

const H = 240;
const PAD = { top: 8, right: 12, bottom: 28, left: 40 };
const CH = H - PAD.top - PAD.bottom;
const Y_TICKS = [0, 25, 50, 75, 100];

// --- Range selector: 7d / 30d / All (033 decision 2), All by default ---

const RANGES = [7, 30, null] as const;
type RangeDays = (typeof RANGES)[number];

// --- Helpers ---

/** A recorded day is a 00:00 UTC snapshot: labelled in UTC, or west of it it reads as the day before. */
function formatPointDate(point: EvolutionPoint, lang: Language, t: ShellTranslations): string {
  if (point.day === null) return t.evolutionNow;
  return new Intl.DateTimeFormat(lang === "es" ? "es-AR" : "en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(point.ts);
}

// "Data up to …": the same shape as Performance's line.
function formatRecordedUntil(ts: number, lang: Language): string {
  const date = new Date(ts);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(lang === "es" ? "es-AR" : "en-US", {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

/** The ticker, or the token's name when two tokens of the curve share it (as the donut does). */
function tokenLabels(tokenIds: string[]): Map<string, string> {
  const symbols = tokenIds.map((id) => symbolForTokenId(id));
  const counts = new Map<string, number>();
  for (const symbol of symbols) counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
  return new Map(
    tokenIds.map((id, i) => [id, (counts.get(symbols[i]) ?? 0) > 1 ? (getTokenById(id)?.name ?? symbols[i]) : symbols[i]])
  );
}

const formatPct = (pct: number) => `${pct.toFixed(1)}%`;

// --- Chart ---

type ChartProps = {
  series: EvolutionSeries;
  selected: number;
  onSelect: (index: number | null) => void;
  ariaLabel: string;
  dateOf: (point: EvolutionPoint) => string;
  /** The token whose band is under the pointer, lit here and in the detail below. */
  litTokenId: string | null;
  onLight: (tokenId: string | null) => void;
  labelOf: (tokenId: string) => string;
};

/**
 * 100 % stacked areas: the first token on top, in the legend's order.
 *
 * D-547 paints each band as the Overview's donut paints a slice (D-521 glass): its own color
 * blurred behind (light seen through), a translucent body that fades downward, a sheen on its top
 * and a hairline inside its edge, clipped to the band so two neighbours' hairlines never overlap.
 */
function StackedShareChart({ series, selected, onSelect, ariaLabel, dateOf, litTokenId, onLight, labelOf }: ChartProps) {
  // Gradient, clip and filter ids must be unique per chart.
  const uid = `ev${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const boxRef = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(0);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setW(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const { points, tokens } = series;
  const CW = Math.max(0, W - PAD.left - PAD.right);
  const minTs = points[0].ts;
  const maxTs = points[points.length - 1].ts;

  const scaleX = (ts: number) => (maxTs === minTs ? PAD.left : PAD.left + ((ts - minTs) / (maxTs - minTs)) * CW);
  const scaleY = (pct: number) => PAD.top + (pct / 100) * CH;

  // Each band runs along its top edge and back along its bottom one: the shares above it, then its own.
  const above = points.map(() => 0);
  const bands = tokens.map(({ tokenId, color }) => {
    const top = points.map((p, i) => `${scaleX(p.ts)},${scaleY(above[i])}`);
    points.forEach((p, i) => (above[i] += p.shares[tokenId] ?? 0));
    const bottom = points.map((p, i) => `${scaleX(p.ts)},${scaleY(above[i])}`).reverse();
    return { tokenId, color: color.hex, d: `M${top.join(" L")} L${bottom.join(" L")} Z` };
  });

  const xLabelIdxs = [...new Set(Array.from({ length: 4 }, (_, i) => Math.round((i / 3) * (points.length - 1))))];

  // Where the pointer is, for the name tag beside it.
  const [tag, setTag] = useState<{ x: number; y: number } | null>(null);

  const pick = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const svgX = e.clientX - rect.left;
    // The band under the pointer names its token; grid, labels and the day line let the pointer through.
    const band = e.target instanceof Element ? e.target.closest("[data-ev-band]")?.getAttribute("data-ev-band") ?? null : null;
    onLight(band);
    setTag(band ? { x: svgX, y: e.clientY - rect.top } : null);
    let nearest = 0;
    points.forEach((p, i) => {
      if (Math.abs(scaleX(p.ts) - svgX) < Math.abs(scaleX(points[nearest].ts) - svgX)) nearest = i;
    });
    onSelect(nearest);
  };

  const sx = scaleX(points[selected].ts);
  const litShare = litTokenId ? (points[selected].shares[litTokenId] ?? 0) : 0;

  return (
    <div ref={boxRef} className="relative" style={{ height: H }}>
      {W > 0 && (
        <svg
          width={W}
          height={H}
          role="img"
          aria-label={ariaLabel}
          className="touch-pan-y select-none"
          onPointerMove={pick}
          onPointerDown={pick}
          // A finger lifting fires `pointerleave` too: a tapped day stays selected.
          onPointerLeave={(e) => {
            if (e.pointerType !== "mouse") return;
            onSelect(null);
            onLight(null);
            setTag(null);
          }}
        >
          <defs>
            <filter id={`${uid}-blur`} x="-5%" y="-10%" width="110%" height="120%">
              <feGaussianBlur stdDeviation="6" />
            </filter>
            {/* Per band, top to bottom of its own box: white on its top, nothing past the middle. */}
            <linearGradient id={`${uid}-sheen`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#fff" stopOpacity="0.3" />
              <stop offset="0.3" stopColor="#fff" stopOpacity="0.07" />
              <stop offset="0.48" stopColor="#fff" stopOpacity="0" />
            </linearGradient>
            {bands.map((band, index) => (
              <g key={band.tokenId}>
                <linearGradient id={`${uid}-glow-${index}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor={band.color} stopOpacity={0.72} />
                  <stop offset="1" stopColor={band.color} stopOpacity={0.26} />
                </linearGradient>
                <clipPath id={`${uid}-clip-${index}`}>
                  <path d={band.d} />
                </clipPath>
              </g>
            ))}
          </defs>
          {/* The light behind the glass: each band's own color, blurred. */}
          <g filter={`url(#${uid}-blur)`} aria-hidden="true" pointerEvents="none">
            {bands.map((band) => (
              <path
                key={band.tokenId}
                d={band.d}
                fill={band.color}
                fillOpacity={0.55}
                data-ev-dim=""
                style={{ opacity: litTokenId !== null && litTokenId !== band.tokenId ? 0.15 : 1, transition: "opacity 180ms" }}
              />
            ))}
          </g>
          {bands.map((band, index) => (
            <g
              key={band.tokenId}
              data-ev-band={band.tokenId}
              data-ev-dim=""
              // As the Overview's lit slice: this one glows, the rest step back.
              style={{
                opacity: litTokenId !== null && litTokenId !== band.tokenId ? 0.2 : 1,
                filter:
                  litTokenId === band.tokenId
                    ? `drop-shadow(0 0 7px ${band.color}aa)`
                    : litTokenId !== null
                      ? "saturate(0.35)"
                      : "none",
                transition: "opacity 180ms, filter 180ms",
              }}
            >
              <path d={band.d} fill={`url(#${uid}-glow-${index})`} />
              <path d={band.d} fill={`url(#${uid}-sheen)`} />
              {/* Twice the hairline's width, half of it clipped away: what is left sits inside the band. */}
              <path
                d={band.d}
                fill="none"
                stroke={band.color}
                strokeOpacity={0.95}
                strokeWidth={2.4}
                strokeLinejoin="round"
                clipPath={`url(#${uid}-clip-${index})`}
              />
            </g>
          ))}

          {Y_TICKS.map((pct) => (
            <g key={pct} pointerEvents="none">
              <line x1={PAD.left} y1={scaleY(pct)} x2={PAD.left + CW} y2={scaleY(pct)} className="stroke-slate-900/40" strokeWidth="1" />
              <text x={PAD.left - 6} y={scaleY(pct) + 4} textAnchor="end" fontSize="11" className="fill-slate-400">
                {100 - pct}%
              </text>
            </g>
          ))}

          {xLabelIdxs.map((idx, i) => (
            <text
              key={idx}
              x={scaleX(points[idx].ts)}
              y={H - 8}
              textAnchor={i === 0 ? "start" : i === xLabelIdxs.length - 1 ? "end" : "middle"}
              fontSize="11"
              className="pointer-events-none fill-slate-400"
            >
              {dateOf(points[idx])}
            </text>
          ))}

          <line x1={sx} y1={PAD.top} x2={sx} y2={PAD.top + CH} stroke="#e2e8f0" strokeWidth="1.5" strokeDasharray="4 2" pointerEvents="none" />
        </svg>
      )}
      {litTokenId && tag ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute whitespace-nowrap rounded-md border border-slate-700 bg-slate-950/90 px-2 py-1 text-[11px] font-medium text-slate-100 shadow-lg"
          // Above the pointer, anchored as far along itself as the pointer is along the chart:
          // its left end at the chart's left edge, its right end at the right one, never outside.
          style={{
            left: tag.x,
            top: Math.max(0, tag.y - 34),
            transform: `translateX(${(-100 * tag.x) / Math.max(W, 1)}%)`,
          }}
        >
          {labelOf(litTokenId)} <span className="tabular-nums text-slate-400">· {formatPct(litShare)}</span>
        </div>
      ) : null}
    </div>
  );
}

// --- Skeleton ---

function EvolutionSkeleton() {
  return (
    <div aria-hidden="true" className="rounded-2xl border border-slate-800 bg-surface p-4">
      <SkeletonBlock className="mb-4 h-4 w-40" />
      <SkeletonBlock className="h-[240px] w-full rounded-xl" />
    </div>
  );
}

// --- Main view ---

/** The Evolution tab (D-516): how a real portfolio's value was split between its tokens over time. */
export function EvolutionView() {
  const { activePortfolio } = usePortfolio();
  const { lang } = useLanguage();
  const t = shellTranslations[lang];
  const priceState = useTokenPrices();
  // The same rows and colors as Overview's donut: the right edge of the curve is that donut.
  const { chartRows, colorByToken } = usePortfolioComputed({
    targets: activePortfolio?.targets ?? NO_TARGETS,
    effectiveCurrentPortfolioQty: activePortfolio?.deposits ?? NO_DEPOSITS,
    priceMap: priceState.prices,
  });

  const isReal = activePortfolio?.isReal === true;
  const composition = usePortfolioComposition(isReal ? (activePortfolio?.id ?? null) : null, isReal);
  const pricesReady = !!priceState.lastUpdatedAt && !priceState.error;

  const [range, setRange] = useState<RangeDays>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [litTokenId, setLitTokenId] = useState<string | null>(null);

  const series = useMemo(() => {
    const now = Date.now();
    const full = buildEvolutionSeries({
      days: composition.data?.days ?? [],
      // Without live prices "now" would be valued at fallback prices: left out until they load.
      nowRows: pricesReady ? chartRows : null,
      now,
      colorByToken,
    });
    return sliceEvolution(full, range, now);
  }, [composition.data, pricesReady, chartRows, colorByToken, range]);

  const labelByToken = useMemo(() => tokenLabels(series.tokens.map((token) => token.tokenId)), [series.tokens]);

  if (!activePortfolio) return null;

  const header = (
    <div className="flex items-center gap-3">
      <h1 className="text-base font-semibold text-slate-200">{t.subNavEvolution}</h1>
      <span className="rounded-full border border-slate-700/60 bg-card px-2 py-0.5 text-xs text-slate-400">
        {activePortfolio.name}
      </span>
    </div>
  );

  // Preview's portfolios have no recorded history, and none is made up for them.
  if (!isReal) {
    return (
      <div className="flex flex-col gap-6 p-4 sm:p-6">
        {header}
        <div className="rounded-2xl border border-slate-800 bg-surface p-4">
          <p className="mx-auto max-w-md py-10 text-center text-sm text-slate-400">{t.evolutionMockEmpty}</p>
        </div>
      </div>
    );
  }

  const failed = composition.isError && !composition.data;
  const data = composition.data;
  const curve = hasCurve(series);
  const last = series.points.length - 1;
  const selected = hovered !== null && hovered <= last ? hovered : last;
  const point = series.points[selected];
  const dateOf = (p: EvolutionPoint) => formatPointDate(p, lang, t);
  const summary =
    curve && series.points[last]
      ? Object.entries(series.points[last].shares)
          .sort(([, a], [, b]) => b - a)
          .map(([tokenId, pct]) => `${labelByToken.get(tokenId) ?? symbolForTokenId(tokenId)} ${formatPct(pct)}`)
          .join(", ")
      : "";

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      {header}

      {composition.isLoading ? (
        <EvolutionSkeleton />
      ) : (
        <div className="rounded-2xl border border-slate-800 bg-surface p-4">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
            <div>
              <p className="text-sm font-medium text-slate-400">{t.evolutionChartTitle}</p>
              <p className="mt-0.5 text-[11px] text-slate-400">{t.evolutionChartNote}</p>
            </div>
            <div className="flex gap-1">
              {RANGES.map((r) => (
                <button
                  key={r ?? "all"}
                  type="button"
                  aria-pressed={range === r}
                  onClick={() => {
                    setRange(r);
                    setHovered(null);
                  }}
                  className={`rounded px-2 py-0.5 text-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 ${
                    range === r ? "bg-slate-700 text-slate-100" : "text-slate-400 hover:text-slate-300"
                  }`}
                >
                  {r === null ? t.evolutionRangeAll : `${r}d`}
                </button>
              ))}
            </div>
          </div>

          {failed ? (
            <div className="py-10 text-center">
              <p className="text-2xl font-semibold text-slate-500">—</p>
              <p className="mt-2 text-sm text-slate-400">{t.evolutionError}</p>
            </div>
          ) : !curve ? (
            <p className="py-10 text-center text-sm text-slate-400">{t.evolutionNoCurve}</p>
          ) : (
            <>
              <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1.5">
                {series.tokens.map(({ tokenId, color }) => (
                  <li key={tokenId} className="flex items-center gap-1.5 text-xs text-slate-300">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: color.hex }} aria-hidden="true" />
                    {labelByToken.get(tokenId)}
                  </li>
                ))}
              </ul>

              <StackedShareChart
                series={series}
                selected={selected}
                onSelect={setHovered}
                ariaLabel={t.evolutionChartLabel.replace("{summary}", summary)}
                dateOf={dateOf}
                litTokenId={litTokenId}
                onLight={setLitTokenId}
                labelOf={(tokenId) => labelByToken.get(tokenId) ?? symbolForTokenId(tokenId)}
              />

              {/* The selected moment: "now" until a day is hovered or tapped. */}
              <div className="mt-3 rounded-xl border border-slate-800 bg-card/40 p-3">
                <div className="mb-2 flex items-baseline justify-between gap-3">
                  <p className="text-sm font-medium text-slate-200">{dateOf(point)}</p>
                  <p className="text-xs text-slate-400">
                    {t.evolutionTotal} <span className="font-medium tabular-nums text-slate-200">{formatUsd(point.totalUsd)}</span>
                  </p>
                </div>
                <ul className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
                  {series.tokens.map(({ tokenId, color }) => {
                    const held = point.usd[tokenId] !== undefined;
                    const lit = litTokenId === tokenId;
                    return (
                      <li
                        key={tokenId}
                        className={`-mx-1.5 flex items-center gap-2 rounded px-1.5 text-xs transition-colors ${lit ? "text-slate-100" : held ? "text-slate-300" : "text-slate-500"}`}
                        // The lit band's row wears its color, as the donut's legend chip does.
                        style={lit ? { backgroundColor: `${color.hex}26` } : undefined}
                      >
                        <span className="h-2 w-2 shrink-0 rounded-sm" style={{ backgroundColor: color.hex }} aria-hidden="true" />
                        <span className="min-w-0 max-w-44 flex-1 truncate" title={labelByToken.get(tokenId)}>{labelByToken.get(tokenId)}</span>
                        <span className="w-12 text-right tabular-nums">{formatPct(point.shares[tokenId] ?? 0)}</span>
                        <span className="w-16 text-right tabular-nums">{formatUsd(point.usd[tokenId] ?? 0)}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
              <p className="mt-2 text-[11px] text-slate-400">{t.evolutionDetailHint}</p>
            </>
          )}
        </div>
      )}

      {data?.loading && <p className="-mt-3 text-xs text-slate-400">{t.performanceStatsLoading}</p>}
      {!data?.loading && composition.outOfDate && data?.recordedUntil != null && (
        <p className="-mt-3 text-xs text-slate-400">
          {t.performanceStatsOutOfDate.replace("{date}", formatRecordedUntil(data.recordedUntil, lang))}
        </p>
      )}
    </div>
  );
}
