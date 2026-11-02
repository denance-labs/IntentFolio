"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Route } from "next";
import { CalendarDays, Check, Globe, Layers } from "lucide-react";
import { InfoTooltip } from "@/features/portfolio-editor/components/portfolio-primitives";
import { formatUsd } from "@/features/portfolio-editor/lib/format";
import type { Language } from "@/features/portfolio-editor/types";
import { closeness, displayInPlacePct } from "../lib/closeness";
import { clickPins, isOutsideTap } from "../lib/pin";
import { ShowcaseKpis } from "./showcase-kpis";
import { ShowcaseStage } from "./showcase-stage";
import type { ShowcaseDayChange, ShowcaseEarnings, ShowcaseLabels, ShowcaseNetwork, ShowcaseToken } from "../types";

const DAY_MS = 24 * 60 * 60 * 1000;
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

type Props = {
  tokens: ShowcaseToken[];
  totalUsd: number;
  /** How much the prices of what it holds moved today (D-523); null hides it. */
  dayChange?: ShowcaseDayChange | null;
  earnings: ShowcaseEarnings;
  networks: ShowcaseNetwork[];
  /** When the portfolio was created (ms); null hides "Since". */
  createdAt: number | null;
  /** Today as a UTC "YYYY-MM-DD", the right edge of the charts. */
  todayDay: string;
  lang: Language;
  labels: ShowcaseLabels;
  editHref?: Route;
  /** Under the value, e.g. when prices are a fallback. */
  valueNote?: string | null;
  earningsNote?: string | null;
  /** Keys the phone's one-time Now → Target preview (per portfolio). */
  previewKey?: string;
};

/**
 * Overview (D-518): a portfolio to look at, not to edit — its value, how much of it is already in
 * its target mix, both mixes side by side and what it earned on the way. Fed only by props, so the
 * landing can mount the same piece with an example portfolio.
 */
export function PortfolioShowcase({
  tokens,
  totalUsd,
  dayChange,
  earnings,
  networks,
  createdAt,
  todayDay,
  lang,
  labels,
  editHref,
  valueNote,
  earningsNote,
  previewKey,
}: Props) {
  const [hovered, setHovered] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const activeTokenId = hovered ?? pinned;
  const toggle = useCallback((tokenId: string) => setPinned((current) => (current === tokenId ? null : tokenId)), []);

  // A tap off every token lets the pinned one go. `click`, not `pointerdown`: a scroll swipe fires no click.
  useEffect(() => {
    if (pinned === null) return;
    const release = (e: MouseEvent) => {
      if (isOutsideTap(e.target)) setPinned(null);
    };
    document.addEventListener("click", release);
    return () => document.removeEventListener("click", release);
  }, [pinned]);

  const close = useMemo(() => closeness(tokens, totalUsd), [tokens, totalUsd]);
  // Tokens held; an empty portfolio counts the ones it targets, as its networks do.
  const tokenCount = tokens.filter((t) => t.currentPct > 0).length || tokens.filter((t) => t.targetPct > 0).length;
  const allOnTarget = close.state === "ready" && close.targeted > 0 && close.onTarget === close.targeted;
  const colorById = useMemo(() => new Map(tokens.map((t) => [t.tokenId, t.color])), [tokens]);

  const locale = lang === "es" ? "es-AR" : "en-US";
  const since = useMemo(() => {
    if (!createdAt) return null;
    const days = Math.max(0, Math.floor((Date.now() - createdAt) / DAY_MS));
    if (days === 0) return labels.sinceToday;
    const date = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(new Date(createdAt));
    const count = days === 1 ? labels.dayOne : labels.dayMany.replace("{n}", String(days));
    return labels.since.replace("{date}", date).replace("{days}", count);
  }, [createdAt, labels, locale]);

  return (
    <div
      className="flex flex-col"
      onKeyDown={(e) => {
        if (e.key === "Escape") setPinned(null);
      }}
    >
      {/* D-526: on a desktop the donuts lead and the value comes under them; on a phone the
          value stays on top, where the first screen has room for it. */}
      <div className="grid gap-5 lg:order-2 lg:mt-7 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-7">
        <div className="ov-rise flex flex-col justify-center">
          <p className="text-xs uppercase tracking-[0.08em] text-slate-400">{labels.value}</p>
          <p className="mt-2.5 text-5xl font-semibold leading-none tracking-tight text-white sm:text-6xl">{formatUsd(totalUsd)}</p>
          {dayChange ? <DayChangeLine change={dayChange} locale={locale} labels={labels} /> : null}
          {valueNote ? <p className="mt-2 text-xs text-amber-200">{valueNote}</p> : null}
          {totalUsd > 0 ? (
            <p className="mt-4 flex items-center gap-2.5 text-[13px] text-emerald-400/85">
              <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-40 motion-reduce:animate-none" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              {allOnTarget ? labels.onTargetStatus : labels.moving}
            </p>
          ) : null}
          <div className="mt-5 flex flex-wrap gap-2">
            {since ? (
              <Chip icon={<CalendarDays className="h-3.5 w-3.5" />}>{since}</Chip>
            ) : null}
            <Chip icon={<Layers className="h-3.5 w-3.5" />}>
              {tokenCount === 1 ? labels.tokenOne : labels.tokenMany.replace("{n}", String(tokenCount))}
            </Chip>
            {networks.length > 0 ? (
              <Chip icon={<Globe className="h-3.5 w-3.5" />}>
                {networks.length === 1 ? labels.networkOne : labels.networkMany.replace("{n}", String(networks.length))}
              </Chip>
            ) : null}
          </div>
        </div>

        <InPlaceCard
          close={close}
          allOnTarget={allOnTarget}
          labels={labels}
          colorById={colorById}
          activeTokenId={activeTokenId}
          onHover={setHovered}
          onToggle={toggle}
        />
      </div>

      <ShowcaseStage
        tokens={tokens}
        totalUsd={totalUsd}
        labels={labels}
        activeTokenId={activeTokenId}
        onHover={setHovered}
        onToggle={toggle}
        editHref={editHref}
        previewKey={previewKey}
        className="lg:order-1 lg:mt-0"
      />

      <ShowcaseKpis
        earnings={earnings}
        networks={networks}
        tokenCount={tokenCount}
        todayDay={todayDay}
        lang={lang}
        labels={labels}
        earningsNote={earningsNote}
        className="lg:order-3"
      />
    </div>
  );
}

/** "▲ +$0.42 (+3.21%) today": green up, red down, grey when it rounds to nothing. */
function DayChangeLine({ change, locale, labels }: { change: ShowcaseDayChange; locale: string; labels: ShowcaseLabels }) {
  const pct = Math.abs(change.pct).toFixed(2);
  const direction = pct === "0.00" ? 0 : Math.sign(change.pct);
  const sign = direction > 0 ? "+" : direction < 0 ? "−" : "";
  const tone = direction > 0 ? "text-emerald-400" : direction < 0 ? "text-rose-400" : "text-slate-400";
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(change.since));
  const info = labels.dayChangeInfo.replace("{time}", time);
  return (
    <p className="mt-3 flex items-center gap-2 text-sm">
      <span className={`font-medium tabular-nums ${tone}`}>
        {direction !== 0 ? (
          <span aria-hidden="true" className="mr-1 text-[11px]">
            {direction > 0 ? "▲" : "▼"}
          </span>
        ) : null}
        {sign}
        {formatUsd(Math.abs(change.usd))} ({sign}
        {pct}%)
      </span>
      <span className="text-slate-400">{labels.dayChangeToday}</span>
      <InfoTooltip label={info}>{info}</InfoTooltip>
    </p>
  );
}

function Chip({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-surface/60 px-3 py-1.5 text-[12.5px] text-slate-300">
      <span className="text-slate-500" aria-hidden="true">
        {icon}
      </span>
      {children}
    </span>
  );
}

/** Counts up to `target` once per mount, after `delayMs`; straight to it with reduced motion. */
function useCountUp(target: number, delayMs: number, durationMs: number): number {
  const [value, setValue] = useState(target);
  const played = useRef(false);
  useIsoLayoutEffect(() => {
    if (played.current || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setValue(target);
      return;
    }
    played.current = true;
    setValue(0);
    const start = performance.now() + delayMs;
    let frame = 0;
    const tick = (now: number) => {
      const progress = Math.min(1, Math.max(0, (now - start) / durationMs));
      setValue(target * (1 - Math.pow(1 - progress, 3)));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, delayMs, durationMs]);
  return value;
}

function InPlaceCard({
  close,
  allOnTarget,
  labels,
  colorById,
  activeTokenId,
  onHover,
  onToggle,
}: {
  close: ReturnType<typeof closeness>;
  allOnTarget: boolean;
  labels: ShowcaseLabels;
  colorById: Map<string, string>;
  activeTokenId: string | null;
  onHover: (tokenId: string | null) => void;
  onToggle: (tokenId: string) => void;
}) {
  const ready = close.state === "ready" ? close : null;
  const shown = ready ? displayInPlacePct(ready.inPlacePct) : 0;
  const counted = useCountUp(shown, 650, 900);

  return (
    <div
      className="ov-rise rounded-3xl border border-white/[0.07] px-6 pb-5 pt-6 shadow-[inset_0_1px_0_rgb(255_255_255/0.05),0_18px_70px_rgb(0_0_0/0.28)] sm:px-7"
      style={{ background: "linear-gradient(180deg, rgb(var(--slate-900) / 0.72), rgb(var(--slate-900) / 0.45))" }}
    >
      {ready ? (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="flex items-baseline gap-2.5">
                <span aria-hidden="true" className="text-5xl font-semibold leading-none text-white">
                  {Math.floor(counted)}%
                </span>
                <span className="sr-only">{shown}%</span>
                <span className="text-[17px] text-slate-300">{labels.inPlace}</span>
              </p>
              <p className="mt-2 text-[13px] text-slate-400">{labels.inPlaceSub}</p>
            </div>
            {ready.targeted > 0 ? (
              <span className="inline-flex items-center gap-2 whitespace-nowrap rounded-full border border-emerald-400/30 bg-emerald-500/[0.08] px-3 py-1.5 text-[12.5px] text-emerald-50">
                {allOnTarget ? (
                  <Check aria-hidden="true" className="h-3.5 w-3.5 text-emerald-400" />
                ) : (
                  <span aria-hidden="true" className="h-[7px] w-[7px] rounded-full bg-emerald-500" />
                )}
                {ready.targeted === 1
                  ? allOnTarget
                    ? labels.oneOnTarget
                    : labels.oneOffTarget
                  : (allOnTarget ? labels.allOnTarget : labels.onTargetCount)
                      .replace("{n}", String(ready.onTarget))
                      .replace("{m}", String(ready.targeted))}
              </span>
            ) : null}
          </div>
          <div className="ov-bar-in mt-5 flex h-3.5 gap-0.5 overflow-hidden rounded-full" role="img" aria-label={`${shown}% ${labels.inPlace}`}>
            {ready.overlap.map((o) => {
              const isDimmed = activeTokenId !== null && activeTokenId !== o.tokenId;
              return (
                <span
                  key={o.tokenId}
                  className="h-full shrink-0 cursor-pointer transition-[opacity,filter] duration-200"
                  style={{
                    width: `${o.pct}%`,
                    backgroundColor: colorById.get(o.tokenId),
                    opacity: isDimmed ? 0.16 : 1,
                    filter: isDimmed ? "saturate(0.35)" : "none",
                  }}
                  onPointerEnter={(e) => {
                    if (e.pointerType === "mouse") onHover(o.tokenId);
                  }}
                  onPointerLeave={(e) => {
                    if (e.pointerType === "mouse") onHover(null);
                  }}
                  onClick={(e) => {
                    if (clickPins(e)) onToggle(o.tokenId);
                  }}
                  data-showcase-token=""
                />
              );
            })}
            <span className="ov-hatch h-full min-w-0 flex-1" />
          </div>
          <div className="mt-2.5 flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs text-slate-400">
            <span>
              {labels.inPlaceLegendIn} <span className="tabular-nums text-slate-100">{shown}%</span>
            </span>
            {shown < 100 ? (
              <span>
                {labels.inPlaceLegendRest} <span className="tabular-nums text-slate-100">{100 - shown}%</span>
              </span>
            ) : null}
          </div>
        </>
      ) : (
        <>
          <p className="flex items-baseline gap-2.5">
            <span className="text-5xl font-semibold leading-none text-slate-500">—</span>
            <span className="text-[17px] text-slate-300">{labels.inPlace}</span>
          </p>
          <p className="mt-2 text-[13px] text-slate-400">{labels.inPlaceEmpty}</p>
        </>
      )}
    </div>
  );
}
