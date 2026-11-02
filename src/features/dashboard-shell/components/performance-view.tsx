"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { usePortfolio } from "../context/portfolio-context";
import { useLanguage } from "../context/language-context";
import { shellTranslations } from "../lib/translations";
import { formatUsd } from "@/features/portfolio-editor/lib/format";
import { InfoTooltip } from "@/features/portfolio-editor/components/portfolio-primitives";
import { formatAxisUsd, niceYAxis } from "../lib/chart-axis";
import { SkeletonBlock, ErrorState } from "./view-states";
import { useLoginWallet } from "@/features/login-wallet";
import { useTokenPrices } from "@/features/market/hooks/use-token-prices";
import { mockContract } from "@/features/intents-account/mock-contract";
import { getNavSeries, takeSnapshot, type NavPoint } from "../lib/nav-snapshot-store";
import { seedNavFromCurrentValue } from "../lib/nav-seeder";
import { usePortfolioStats } from "@/features/vault/hooks/use-portfolio-stats";
import { usePortfolioComposition } from "@/features/vault/hooks/use-portfolio-composition";
import { buildValueSeries, type ValuePoint } from "../lib/value-series";
import type { TokenId, ContractEvent } from "@/features/intents-account/mock-contract/types";
import type { Language } from "@/features/portfolio-editor/types";

// --- Types ---

type SpreadPoint = { timestamp: number; spreadUsd: number };

// --- Chart constants ---

const W = 560;
const H = 200;
const PAD = { top: 16, right: 20, bottom: 44, left: 60 };
const CW = W - PAD.left - PAD.right;
const CH = H - PAD.top - PAD.bottom;

// --- Helpers ---

function formatChartDate(ts: number): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(ts));
}

// A real portfolio's recorded day is a 00:00 UTC snapshot: labelled in UTC, or west of it it reads as
// the day before (Evolution does the same). The mock's browser-local points keep the local date.
function formatValuePointDate(point: ValuePoint, nowLabel: string): string {
  if (point.day === null) return nowLabel;
  if (point.day === undefined) return formatChartDate(point.timestamp);
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(point.timestamp);
}

// "Data up to …": My Account's date shape (year only when not this one), on a 24-hour clock — the
// sentence ends in a period, and es-AR's "a. m." would end it in two.
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

const DAY_MS = 24 * 60 * 60 * 1000;

function navPointsToChartPoints(points: NavPoint[]): ValuePoint[] {
  return points.map((p) => ({
    timestamp: new Date(p.date).getTime(),
    valueUsd: p.navUsd,
  }));
}

// --- Range selector ---

const RANGES = [7, 30, 60] as const;
type RangeDays = (typeof RANGES)[number];

// --- Chart component ---

type ChartProps = { points: ValuePoint[]; nowLabel: string };

function ValueLineChart({ points, nowLabel }: ChartProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const { minTs, maxTs, axis } = useMemo(() => {
    const vals = points.map((p) => p.valueUsd);
    const tss = points.map((p) => p.timestamp);
    const rawMin = Math.min(...vals);
    const rawMax = Math.max(...vals);
    const pad = (rawMax - rawMin) * 0.15 || rawMax * 0.1 || 50;
    return {
      minTs: Math.min(...tss),
      maxTs: Math.max(...tss),
      axis: niceYAxis(Math.max(0, rawMin - pad), rawMax + pad),
    };
  }, [points]);

  const scaleX = (ts: number): number => {
    if (maxTs === minTs) return PAD.left;
    return PAD.left + ((ts - minTs) / (maxTs - minTs)) * CW;
  };
  const scaleY = (val: number): number =>
    PAD.top + CH - ((val - axis.min) / (axis.max - axis.min)) * CH;

  const polylinePts = points
    .map((p) => `${scaleX(p.timestamp)},${scaleY(p.valueUsd)}`)
    .join(" ");

  const firstX = scaleX(points[0].timestamp);
  const lastX = scaleX(points[points.length - 1].timestamp);
  const baseY = PAD.top + CH;
  const areaPath =
    `M${firstX},${baseY} ` +
    points.map((p) => `L${scaleX(p.timestamp)},${scaleY(p.valueUsd)}`).join(" ") +
    ` L${lastX},${baseY} Z`;

  const xLabelIdxs = Array.from({ length: 4 }, (_, i) =>
    Math.round((i / 3) * (points.length - 1))
  );

  const yLevels = axis.ticks.map((val) => ({ val, y: scaleY(val) }));

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const el = svgRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / rect.width) * W;
    let nearestIdx = 0;
    let nearestDist = Infinity;
    points.forEach((p, i) => {
      const d = Math.abs(scaleX(p.timestamp) - svgX);
      if (d < nearestDist) {
        nearestDist = d;
        nearestIdx = i;
      }
    });
    setHoveredIdx(nearestIdx);
  };

  const hp = hoveredIdx !== null ? points[hoveredIdx] : null;
  const hx = hp ? scaleX(hp.timestamp) : 0;
  const hy = hp ? scaleY(hp.valueUsd) : 0;
  const tooltipLeft = hx > W - 140;

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      aria-label="Managed portfolio value over time"
      role="img"
      className="overflow-visible"
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setHoveredIdx(null)}
    >
      <defs>
        <linearGradient id="perf-area-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.18" />
          <stop offset="100%" stopColor="#22d3ee" stopOpacity="0" />
        </linearGradient>
        <clipPath id="perf-clip">
          <rect x={PAD.left} y={PAD.top} width={CW} height={CH} />
        </clipPath>
      </defs>

      {yLevels.map(({ y }, i) => (
        <line key={i} x1={PAD.left} y1={y} x2={PAD.left + CW} y2={y} className="stroke-slate-800" strokeWidth="1" />
      ))}

      <path d={areaPath} fill="url(#perf-area-grad)" clipPath="url(#perf-clip)" />

      <polyline
        points={polylinePts}
        fill="none"
        stroke="#22d3ee"
        strokeWidth="2"
        strokeLinejoin="round"
        clipPath="url(#perf-clip)"
      />

      {points.map((p, i) => (
        <circle
          key={i}
          cx={scaleX(p.timestamp)}
          cy={scaleY(p.valueUsd)}
          r={hoveredIdx === i ? 4.5 : 2.5}
          fill={hoveredIdx === i ? "#22d3ee" : "#0e7490"}
          className="stroke-slate-900"
          strokeWidth="1.5"
        />
      ))}

      {xLabelIdxs.map((idx, i) => (
        <text key={i} x={scaleX(points[idx].timestamp)} y={H - 8} textAnchor="middle" fontSize="10" className="fill-slate-500">
          {formatValuePointDate(points[idx], nowLabel)}
        </text>
      ))}

      {yLevels.map(({ val, y }, i) => (
        <text key={i} x={PAD.left - 6} y={y + 4} textAnchor="end" fontSize="10" className="fill-slate-500">
          {formatAxisUsd(val, axis.step)}
        </text>
      ))}

      <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={PAD.top + CH} className="stroke-slate-700" strokeWidth="1" />
      <line x1={PAD.left} y1={PAD.top + CH} x2={PAD.left + CW} y2={PAD.top + CH} className="stroke-slate-700" strokeWidth="1" />

      {hp && (
        <line x1={hx} y1={PAD.top} x2={hx} y2={PAD.top + CH} className="stroke-slate-700" strokeWidth="1" strokeDasharray="4 2" />
      )}

      {hp && (
        <>
          <rect
            x={tooltipLeft ? hx - 128 : hx + 10}
            y={hy - 30}
            width={116}
            height={42}
            rx={6}
            className="fill-slate-800 stroke-slate-700"
            strokeWidth="1"
          />
          <text x={tooltipLeft ? hx - 118 : hx + 20} y={hy - 13} fontSize="10" className="fill-slate-400">
            {formatValuePointDate(hp, nowLabel)}
          </text>
          <text x={tooltipLeft ? hx - 118 : hx + 20} y={hy + 5} fontSize="12" fontWeight="600" fill="#e2e8f0">
            {formatUsd(hp.valueUsd)}
          </text>
        </>
      )}
    </svg>
  );
}

// --- Spread chart ---

function SpreadLineChart({ points }: { points: SpreadPoint[] }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const { minTs, maxTs, axis } = useMemo(() => {
    const vals = points.map((p) => p.spreadUsd);
    const tss = points.map((p) => p.timestamp);
    const rawMax = Math.max(...vals);
    const pad = rawMax * 0.1 || 1;
    return {
      minTs: Math.min(...tss),
      maxTs: Math.max(...tss),
      axis: niceYAxis(0, rawMax + pad),
    };
  }, [points]);

  const scaleX = (ts: number): number => {
    if (maxTs === minTs) return PAD.left;
    return PAD.left + ((ts - minTs) / (maxTs - minTs)) * CW;
  };
  const scaleY = (val: number): number =>
    PAD.top + CH - ((val - axis.min) / (axis.max - axis.min)) * CH;

  const polylinePts = points
    .map((p) => `${scaleX(p.timestamp)},${scaleY(p.spreadUsd)}`)
    .join(" ");

  const firstX = scaleX(points[0].timestamp);
  const lastX = scaleX(points[points.length - 1].timestamp);
  const baseY = PAD.top + CH;
  const areaPath =
    `M${firstX},${baseY} ` +
    points.map((p) => `L${scaleX(p.timestamp)},${scaleY(p.spreadUsd)}`).join(" ") +
    ` L${lastX},${baseY} Z`;

  const xLabelIdxs = Array.from({ length: 4 }, (_, i) =>
    Math.round((i / 3) * (points.length - 1))
  );
  const yLevels = axis.ticks.map((val) => ({ val, y: scaleY(val) }));

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const el = svgRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / rect.width) * W;
    let nearestIdx = 0;
    let nearestDist = Infinity;
    points.forEach((p, i) => {
      const d = Math.abs(scaleX(p.timestamp) - svgX);
      if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
    });
    setHoveredIdx(nearestIdx);
  };

  const hp = hoveredIdx !== null ? points[hoveredIdx] : null;
  const hx = hp ? scaleX(hp.timestamp) : 0;
  const hy = hp ? scaleY(hp.spreadUsd) : 0;
  const tooltipLeft = hx > W - 140;

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      aria-label="Cumulative spread earned over time"
      role="img"
      className="overflow-visible"
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setHoveredIdx(null)}
    >
      <defs>
        <linearGradient id="spread-area-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#10b981" stopOpacity="0.18" />
          <stop offset="100%" stopColor="#10b981" stopOpacity="0" />
        </linearGradient>
        <clipPath id="spread-clip">
          <rect x={PAD.left} y={PAD.top} width={CW} height={CH} />
        </clipPath>
      </defs>

      {yLevels.map(({ y }, i) => (
        <line key={i} x1={PAD.left} y1={y} x2={PAD.left + CW} y2={y} className="stroke-slate-800" strokeWidth="1" />
      ))}

      <path d={areaPath} fill="url(#spread-area-grad)" clipPath="url(#spread-clip)" />

      <polyline
        points={polylinePts}
        fill="none"
        stroke="#10b981"
        strokeWidth="2"
        strokeLinejoin="round"
        clipPath="url(#spread-clip)"
      />

      {points.map((p, i) => (
        <circle
          key={i}
          cx={scaleX(p.timestamp)}
          cy={scaleY(p.spreadUsd)}
          r={hoveredIdx === i ? 4.5 : 2.5}
          fill={hoveredIdx === i ? "#10b981" : "#065f46"}
          className="stroke-slate-900"
          strokeWidth="1.5"
        />
      ))}

      {xLabelIdxs.map((idx, i) => (
        <text key={i} x={scaleX(points[idx].timestamp)} y={H - 8} textAnchor="middle" fontSize="10" className="fill-slate-500">
          {formatChartDate(points[idx].timestamp)}
        </text>
      ))}

      {yLevels.map(({ val, y }, i) => (
        <text key={i} x={PAD.left - 6} y={y + 4} textAnchor="end" fontSize="10" className="fill-slate-500">
          {formatAxisUsd(val, axis.step)}
        </text>
      ))}

      <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={PAD.top + CH} className="stroke-slate-700" strokeWidth="1" />
      <line x1={PAD.left} y1={PAD.top + CH} x2={PAD.left + CW} y2={PAD.top + CH} className="stroke-slate-700" strokeWidth="1" />

      {hp && (
        <line x1={hx} y1={PAD.top} x2={hx} y2={PAD.top + CH} className="stroke-slate-700" strokeWidth="1" strokeDasharray="4 2" />
      )}

      {hp && (
        <>
          <rect
            x={tooltipLeft ? hx - 128 : hx + 10}
            y={hy - 30}
            width={116}
            height={42}
            rx={6}
            className="fill-slate-800 stroke-slate-700"
            strokeWidth="1"
          />
          <text x={tooltipLeft ? hx - 118 : hx + 20} y={hy - 13} fontSize="10" className="fill-slate-400">
            {formatChartDate(hp.timestamp)}
          </text>
          <text x={tooltipLeft ? hx - 118 : hx + 20} y={hy + 5} fontSize="12" fontWeight="600" fill="#e2e8f0">
            {formatUsd(hp.spreadUsd)}
          </text>
        </>
      )}
    </svg>
  );
}

// --- Metric value ---

/** A rebalance-derived number: a placeholder while it loads, a dash when it could not be read. */
function RebalanceMetric({
  loading,
  failed,
  value,
  className,
}: {
  loading: boolean;
  failed: boolean;
  value: string;
  className: string;
}) {
  if (loading) return <SkeletonBlock className="h-8 w-20" />;
  return (
    <p className={`text-2xl font-semibold tabular-nums ${failed ? "text-slate-500" : className}`}>
      {failed ? "—" : value}
    </p>
  );
}

// --- Skeleton ---

function PerformanceSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-6 p-4 sm:p-6">
      <SkeletonBlock className="h-6 w-40" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="space-y-3 rounded-2xl border border-slate-800 bg-surface p-4">
            <SkeletonBlock className="h-3 w-28" />
            <SkeletonBlock className="h-8 w-32" />
          </div>
        ))}
      </div>
      <div className="rounded-2xl border border-slate-800 bg-surface p-4">
        <SkeletonBlock className="mb-4 h-4 w-32" />
        <SkeletonBlock className="h-[200px] w-full rounded-xl" />
      </div>
    </div>
  );
}

// --- Main view ---

export function PerformanceView() {
  const { activePortfolio } = usePortfolio();
  const { lang } = useLanguage();
  const t = shellTranslations[lang];
  const { intentsAccountId } = useLoginWallet();
  const { prices, isLoading: pricesLoading, lastUpdatedAt, error: pricesError } = useTokenPrices();

  // Reactive contract version — triggers re-derivation when contract state changes.
  const contractVersion = useSyncExternalStore(mockContract.subscribe, mockContract.getVersion, mockContract.getVersion);

  const [range, setRange] = useState<RangeDays>(30);
  const [navVersion, setNavVersion] = useState(0);

  // Current portfolio value from live balances × token prices.
  //
  // Reads `activePortfolio.deposits` rather than the mock ledger directly (008.plan Phase
  // 1): a real portfolio is no longer mirrored there, so asking the mock for its balance
  // would value it at $0 — and a portfolio holding real funds reporting zero is the exact
  // failure D-R6 exists to remove. The context already resolves both sources.
  const currentValueUsd = useMemo(() => {
    if (!intentsAccountId || !activePortfolio) return 0;
    let total = 0;
    for (const [tokenId, qty] of Object.entries(activePortfolio.deposits)) {
      total += qty * (prices[tokenId as TokenId]?.usdPrice ?? 0);
    }
    return total;
  }, [intentsAccountId, activePortfolio, prices]);

  const isReal = activePortfolio?.isReal === true;

  // Mock portfolios: spread and swaps from the mock's external_rebalance events (spread already
  // frozen in USD).
  const mockStats = useMemo(() => {
    if (!intentsAccountId || !activePortfolio || isReal) return { spreadUsd: 0, swaps: 0 };
    const rebalances = mockContract
      .getEvents(intentsAccountId)
      .filter(
        (e): e is Extract<ContractEvent, { kind: "external_rebalance" }> =>
          e.kind === "external_rebalance" && e.portfolio_id === activePortfolio.id
      );
    return {
      spreadUsd: rebalances.reduce((sum, e) => sum + e.attributed_spread, 0),
      swaps: rebalances.length,
    };
  }, [intentsAccountId, activePortfolio, isReal, contractVersion]);

  // Real portfolios (028-3): swaps and spread from the history database, the spread valued at
  // the price of the day it was recorded (028 decision 5). One point per day on the curve.
  const portfolioStats = usePortfolioStats(isReal ? (activePortfolio?.id ?? null) : null, isReal);
  const realStats = useMemo(() => {
    const data = portfolioStats.data;
    if (!isReal || !data) return null;
    let cum = 0;
    const points: SpreadPoint[] = data.daily.map((d) => {
      cum += d.spreadUsd;
      // Noon UTC: the axis shows the same date from UTC-11 to UTC+11.
      return { timestamp: Date.parse(`${d.day}T12:00:00Z`), spreadUsd: cum };
    });
    // The curve needs two points: a single day starts from zero the day before, or the card
    // would say "no rebalances yet" next to a swap count above zero.
    if (points.length === 1) points.unshift({ timestamp: points[0].timestamp - DAY_MS, spreadUsd: 0 });
    return { ...data, points };
  }, [isReal, portfolioStats.data]);
  const rebalancesLoading = isReal && portfolioStats.isLoading;
  // A failed re-read keeps the numbers it already has: they are true up to "recorded until".
  const rebalancesFailed = isReal && portfolioStats.isError && !portfolioStats.data;

  // Mock portfolios: seed demo NAV anchored to live prices (avoids spike from fallback↔live
  // price mismatch), record today and bump navVersion to refresh the chart. Real portfolios take
  // none of this: their curve comes from the history database (below), and the seed would invent
  // 60 days of growth that did not happen (D-336).
  useEffect(() => {
    if (!activePortfolio || currentValueUsd <= 0 || isReal) return;
    seedNavFromCurrentValue(activePortfolio.id, currentValueUsd);
    takeSnapshot(activePortfolio.id, currentValueUsd);
    setNavVersion((v) => v + 1);
  }, [activePortfolio, currentValueUsd, isReal]);

  // Real portfolios (D-149 / D-342): one point per recorded UTC day from the history database —
  // the same read as Evolution, so the two never disagree — plus "now" from the card's live value.
  // It used to be browser-local snapshots, one per day someone opened the app, in that browser.
  const composition = usePortfolioComposition(isReal ? (activePortfolio?.id ?? null) : null, isReal);
  const livePrices = !!lastUpdatedAt && !pricesError;

  // Cumulative spread series from external_rebalance events for this portfolio.
  const spreadPoints = useMemo((): SpreadPoint[] => {
    if (isReal) return realStats?.points ?? [];
    if (!intentsAccountId || !activePortfolio) return [];
    const rebalances = mockContract
      .getEvents(intentsAccountId)
      .filter(
        (e): e is Extract<ContractEvent, { kind: "external_rebalance" }> =>
          e.kind === "external_rebalance" && e.portfolio_id === activePortfolio.id
      )
      .sort((a, b) => a.ts - b.ts);
    let cum = 0;
    return rebalances.map((e) => {
      cum += e.attributed_spread;
      return { timestamp: e.ts, spreadUsd: cum };
    });
  }, [isReal, realStats, intentsAccountId, activePortfolio, contractVersion]);

  // Mock portfolios: NAV series from the snapshot store, filtered by selected range.
  const navPoints = useMemo(() => {
    if (!activePortfolio || isReal) return [];
    return getNavSeries(activePortfolio.id, range);
  }, [activePortfolio, isReal, range, navVersion]);

  const chartPoints: ValuePoint[] = useMemo(() => {
    if (!isReal) return navPointsToChartPoints(navPoints);
    return buildValueSeries({
      days: composition.data?.days ?? [],
      // Without live prices "now" would be valued at fallback prices: left out until they load.
      nowUsd: livePrices ? currentValueUsd : null,
      now: Date.now(),
      rangeDays: range,
    });
  }, [isReal, navPoints, composition.data, livePrices, currentValueUsd, range]);
  const valueLoading = isReal && composition.isLoading;
  // A failed re-read keeps the days it already has, like the rebalance numbers above.
  const valueFailed = isReal && composition.isError && !composition.data;

  if (!activePortfolio) return null;

  if (pricesLoading && currentValueUsd === 0) {
    return <PerformanceSkeleton />;
  }

  const hasError = false;

  if (hasError) {
    return (
      <div className="flex flex-col gap-6 p-4 sm:p-6">
        <div className="flex items-center gap-3">
          <h1 className="text-base font-semibold text-slate-200">{t.subNavPerformance}</h1>
        </div>
        <ErrorState
          message={t.viewErrorTitle}
          retryLabel={t.viewErrorRetry}
          onRetry={() => window.location.reload()}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <h1 className="text-base font-semibold text-slate-200">{t.subNavPerformance}</h1>
        <span className="rounded-full border border-slate-700/60 bg-card px-2 py-0.5 text-xs text-slate-400">
          {activePortfolio.name}
        </span>
      </div>

      {/* Metric cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-2xl border border-slate-800 bg-surface p-4">
          <p className="mb-1 text-xs text-slate-400">{t.performancePortfolioValue}</p>
          <p className="text-2xl font-semibold tabular-nums text-slate-100">
            {formatUsd(currentValueUsd)}
          </p>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-surface p-4">
          <div className="mb-1 flex items-center gap-1.5">
            <p className="text-xs text-slate-400">{t.historyEventAttributedSpread}</p>
            <InfoTooltip label={t.performanceSpreadInfo}>{t.performanceSpreadInfo}</InfoTooltip>
          </div>
          <RebalanceMetric
            loading={rebalancesLoading}
            failed={rebalancesFailed}
            className="text-cyan-300"
            value={
              isReal
                ? `${realStats?.spreadIsMinimum ? "≥ " : ""}${formatUsd(realStats?.spreadUsd ?? 0)}`
                : formatUsd(mockStats.spreadUsd)
            }
          />
          <p className="mt-1 text-[11px] text-slate-400">
            {isReal ? t.performanceTotalSpreadNoteReal : t.performanceTotalSpreadNote}
          </p>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-surface p-4">
          <p className="mb-1 text-xs text-slate-400">{t.performanceSwapsLabel}</p>
          <RebalanceMetric
            loading={rebalancesLoading}
            failed={rebalancesFailed}
            className="text-slate-100"
            value={String(isReal ? (realStats?.swaps ?? 0) : mockStats.swaps)}
          />
          <p className="mt-1 text-[11px] text-slate-400">{t.performanceSwapsNote}</p>
        </div>
      </div>
      {rebalancesFailed && <p className="-mt-3 text-xs text-slate-400">{t.performanceRebalancesError}</p>}
      {realStats?.loading && <p className="-mt-3 text-xs text-slate-400">{t.performanceStatsLoading}</p>}
      {!realStats?.loading && portfolioStats.outOfDate && realStats?.recordedUntil != null && (
        <p className="-mt-3 text-xs text-slate-400">
          {t.performanceStatsOutOfDate.replace("{date}", formatRecordedUntil(realStats.recordedUntil, lang))}
        </p>
      )}

      {/* Value chart */}
      <div className="rounded-2xl border border-slate-800 bg-surface p-4">
        <div className="mb-4 flex items-start justify-between gap-2">
          <div>
            <p className="text-sm font-medium text-slate-400">{t.performancePortfolioValue}</p>
            {isReal && <p className="mt-0.5 text-[11px] text-slate-400">{t.evolutionChartNote}</p>}
          </div>
          <div className="flex gap-1">
            {RANGES.map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={`rounded px-2 py-0.5 text-xs transition-colors ${
                  range === r
                    ? "bg-slate-700 text-slate-100"
                    : "text-slate-400 hover:text-slate-300"
                }`}
              >
                {r}d
              </button>
            ))}
          </div>
        </div>
        {valueLoading ? (
          <SkeletonBlock className="h-[200px] w-full rounded-xl" />
        ) : valueFailed ? (
          <div className="py-10 text-center">
            <p className="text-2xl font-semibold text-slate-500">—</p>
            <p className="mt-2 text-sm text-slate-400">{t.evolutionError}</p>
          </div>
        ) : chartPoints.length > 1 ? (
          <ValueLineChart points={chartPoints} nowLabel={t.evolutionNow} />
        ) : (
          <p className="py-10 text-center text-sm text-slate-400">
            {isReal ? t.evolutionNoCurve : t.performanceNoData}
          </p>
        )}
      </div>

      {/* Cumulative spread chart */}
      <div className="rounded-2xl border border-slate-800 bg-surface p-4">
        <div className="mb-1">
          <p className="text-sm font-medium text-slate-400">{t.performanceCumulativeSpreadLabel}</p>
          <p className="mt-0.5 text-[11px] text-slate-400">{t.performanceCumulativeSpreadNote}</p>
        </div>
        {spreadPoints.length > 1 ? (
          <div className="mt-3">
            <SpreadLineChart points={spreadPoints} />
          </div>
        ) : (
          <p className="py-10 text-center text-sm text-slate-400">{t.performanceSpreadNoData}</p>
        )}
      </div>
    </div>
  );
}
