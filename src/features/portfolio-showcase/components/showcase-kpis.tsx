"use client";

import { InfoTooltip } from "@/features/portfolio-editor/components/portfolio-primitives";
import { formatUsd } from "@/features/portfolio-editor/lib/format";
import type { Language } from "@/features/portfolio-editor/types";
import { themeColor } from "@/features/world/colors";
import { cumulativeStepPath, dailyWindow } from "../lib/showcase-geometry";
import type { ShowcaseEarnings, ShowcaseLabels, ShowcaseNetwork } from "../types";

const SWAP_DAYS = 30;
const SPARK_W = 320;
const SPARK_H = 56;
// Networks are a part-to-whole of a handful of places, not a token identity: a neutral ramp, so
// they never borrow a token's color. Past four, the rest folds into one "other" row.
const NETWORK_SHADES = [themeColor("slate-200"), themeColor("slate-400"), themeColor("slate-600"), themeColor("slate-700")];

const CARD = "ov-rise glass rounded-[20px] px-5 pb-4 pt-5";

function formatDay(day: string, lang: Language): string {
  return new Intl.DateTimeFormat(lang === "es" ? "es-AR" : "en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(
    new Date(`${day}T12:00:00Z`)
  );
}

/** Spread too small to show in cents still reads as earned, not as zero. */
function formatSpread(usd: number): string {
  return usd > 0 && usd < 0.005 ? "< $0.01" : formatUsd(usd);
}

function Skeleton({ className }: { className: string }) {
  return <span aria-hidden="true" className={`block animate-pulse rounded-lg bg-white/[0.06] ${className}`} />;
}

type Props = {
  earnings: ShowcaseEarnings;
  networks: ShowcaseNetwork[];
  tokenCount: number;
  todayDay: string;
  lang: Language;
  labels: ShowcaseLabels;
  /** A line under the earnings when they are partial or behind, already in the user's language. */
  earningsNote?: string | null;
  className?: string;
};

export function ShowcaseKpis({ earnings, networks, tokenCount, todayDay, lang, labels, earningsNote, className = "" }: Props) {
  const ready = earnings.status === "ready" ? earnings : null;
  const spark = ready ? cumulativeStepPath(ready.daily, todayDay, SPARK_W, SPARK_H) : null;
  const firstDay = ready?.daily.find((d) => d.swaps > 0 || d.spreadUsd > 0)?.day ?? null;
  const bars = ready ? dailyWindow(ready.daily, todayDay, SWAP_DAYS) : [];
  const busiest = bars.reduce((max, d) => Math.max(max, d.swaps), 0);

  const totalUsd = networks.reduce((sum, n) => sum + n.usd, 0);
  const shown = networks.length > NETWORK_SHADES.length ? networks.slice(0, NETWORK_SHADES.length - 1) : networks;
  const rest = networks.slice(shown.length);
  const rows = rest.length
    ? [
        ...shown,
        {
          name: labels.networksOther,
          tokens: rest.reduce((sum, n) => sum + n.tokens, 0),
          usd: rest.reduce((sum, n) => sum + n.usd, 0),
        },
      ]
    : shown;
  const networkWord = (networks.length === 1 ? labels.networkOne : labels.networkMany.replace("{n}", String(networks.length)))
    .replace(/^\S+\s*/, "");

  return (
    <section className={`mt-6 grid grid-cols-2 gap-3.5 md:grid-cols-3 md:gap-5 ${className}`}>
      <div className={`${CARD} col-span-2 md:col-span-1`} style={{ animationDelay: "450ms" }}>
        <div className="flex items-center gap-1.5">
          <p className="text-[13px] text-slate-400">{labels.spread}</p>
          <InfoTooltip label={labels.spreadInfo}>{labels.spreadInfo}</InfoTooltip>
        </div>
        {earnings.status === "loading" ? (
          <Skeleton className="mt-2 h-[34px] w-24" />
        ) : (
          <p className={`mt-2 text-[34px] font-semibold leading-none ${ready ? "text-accent" : "text-slate-500"}`}>
            {ready ? `${ready.spreadIsMinimum ? "≥ " : ""}${formatSpread(ready.spreadUsd)}` : "—"}
          </p>
        )}
        <p className="mt-2 text-xs text-slate-400">
          {earnings.status === "failed"
            ? labels.earningsFailed
            : ready
              ? ready.swaps > 0
                ? labels.spreadNote.replace("{n}", String(ready.swaps))
                : labels.spreadNone
              : " "}
        </p>
        {spark ? (
          <>
            <div className="relative mt-3 h-14">
              <svg
                viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
                preserveAspectRatio="none"
                role="img"
                aria-label={`${labels.spread}: ${formatSpread(ready?.spreadUsd ?? 0)}`}
                className="block h-full w-full"
              >
                <path d={spark.area} className="fill-accent/10" />
                <path d={spark.line} fill="none" className="stroke-accent" strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
              </svg>
              <span
                aria-hidden="true"
                className="absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent ring-2 ring-slate-900"
                style={{ left: `${(spark.end.x / SPARK_W) * 100}%`, top: `${(spark.end.y / SPARK_H) * 100}%` }}
              />
            </div>
            <div className="mt-1.5 flex justify-between text-[10.5px] tabular-nums text-slate-500">
              <span>{firstDay ? formatDay(firstDay, lang) : ""}</span>
              <span>{formatDay(todayDay, lang)}</span>
            </div>
          </>
        ) : null}
        {earningsNote ? <p className="mt-2 text-[11px] text-slate-400">{earningsNote}</p> : null}
      </div>

      <div className={`${CARD} col-span-2 md:col-span-1`} style={{ animationDelay: "500ms" }}>
        <p className="text-[13px] text-slate-400">{labels.swaps}</p>
        {earnings.status === "loading" ? (
          <Skeleton className="mt-2 h-[34px] w-14" />
        ) : (
          <p className={`mt-2 text-[34px] font-semibold leading-none ${ready ? "text-slate-100" : "text-slate-500"}`}>
            {ready ? ready.swaps : "—"}
          </p>
        )}
        <p className="mt-2 text-xs text-slate-400">{labels.swapsNote}</p>
        {ready ? (
          <>
            <div
              role="img"
              aria-label={`${labels.swapsWindow}: ${bars.reduce((sum, d) => sum + d.swaps, 0)}`}
              className="mt-3 flex h-14 items-end gap-[3px]"
            >
              {bars.map((d) => (
                <span
                  key={d.day}
                  title={`${formatDay(d.day, lang)}: ${d.swaps}`}
                  className={`flex-1 ${d.swaps > 0 ? "rounded-t-[3px]" : "bg-slate-800"}`}
                  style={
                    d.swaps > 0
                      ? {
                          height: `${Math.max(12, (d.swaps / busiest) * 100)}%`,
                          backgroundColor: themeColor("accent", d.swaps === busiest ? 0.85 : 0.5),
                        }
                      : { height: "2px" }
                  }
                />
              ))}
            </div>
            <p className="mt-1.5 text-[10.5px] text-slate-500">{labels.swapsWindow}</p>
          </>
        ) : null}
      </div>

      <div className={`${CARD} col-span-2 md:col-span-1`} style={{ animationDelay: "550ms" }}>
        <p className="text-[13px] text-slate-400">{labels.networks}</p>
        <p className="mt-2 text-[34px] font-semibold leading-none text-slate-100">
          {networks.length} <span className="text-[17px] font-normal text-slate-300">{networkWord}</span>
        </p>
        <p className="mt-2 text-xs text-slate-400">
          {labels.networksNote.replace("{tokens}", tokenCount === 1 ? labels.tokenOne : labels.tokenMany.replace("{n}", String(tokenCount)))}
        </p>
        {totalUsd > 0 ? (
          <div className="mt-4 flex h-2.5 gap-0.5 overflow-hidden rounded-full" aria-hidden="true">
            {rows.map((n, i) => (
              <span key={n.name} className="h-full" style={{ width: `${(n.usd / totalUsd) * 100}%`, backgroundColor: NETWORK_SHADES[i] }} />
            ))}
          </div>
        ) : null}
        <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-3.5 gap-y-1.5 text-xs text-slate-300">
          {rows.map((n, i) => (
            <div key={n.name} className="contents">
              <span className="flex min-w-0 items-center gap-2">
                <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ backgroundColor: NETWORK_SHADES[i] }} aria-hidden="true" />
                <span className="truncate">{n.name}</span>
              </span>
              <span className="text-slate-400">{n.tokens === 1 ? labels.tokenOne : labels.tokenMany.replace("{n}", String(n.tokens))}</span>
              <span className="text-right tabular-nums">{totalUsd > 0 ? formatUsd(n.usd) : ""}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
