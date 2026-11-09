"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Route } from "next";
import { useInView } from "framer-motion";
import { PRESET_ENTRY_PARAM } from "@/content/portfolio-presets";
import { useLanguage } from "@/features/dashboard-shell/context/language-context";
import { StockIcon } from "@/features/market/lib/stock-marker";
import { isStockToken } from "@/features/market/lib/stock-tokens";
import { ShowcaseDonut, RING } from "@/features/portfolio-showcase/components/showcase-donut";
import type { ShowcaseToken } from "@/features/portfolio-showcase/types";
import { landingTranslations } from "../lib/translations";
import { buildDemoPresets, HERO_PRESET_ORDER, type DemoPreset } from "../lib/demo-presets";
import { WORLD_CTA, WORLD_LABEL, WORLD_PANEL } from "../lib/world";
import { AppCta } from "./app-cta";
import { DEMO_COPY, mixAt, useProgress } from "./portfolio-build-demo";

// D-568: the hero is the working demo. The headline sits centered over the Overview's own donut
// (ShowcaseDonut, D-518), which moves from 100% USDC to the chosen mix in one continuous motion
// (D-564's 0.7 s hold, then a 3 s move: slower than the 1.8 s of /demo, asked by the operator so
// the mix can be watched coming together); the mix's bars sit on one side, the presets and the way
// into the app on the other. The stock presets lead (D-558). Behind the donut, a faint 0–100 scale.
//
// The donut morphs through its own CSS transitions (mode "current" = the starting point, "target"
// = the mix); the bars and percentages follow the same progress, driven frame by frame. At the
// starting point the donut carries `hero-donut-rest`, so a replay or a preset switch jumps back to
// USDC instead of animating backwards (globals.css).
//
// Without JavaScript (D-566) the live copy is hidden and a still copy of the finished mix shows
// instead; with it, the server HTML already shows the starting point, so nothing jumps on load.

type Mix = ReturnType<typeof mixAt>;

// Keep in step with the `.hero-donut` transition in globals.css.
const MOVE_MS = 3000;

const CTA_CLASS = `${WORLD_CTA} w-full`;

function hasStock(preset: DemoPreset) {
  return preset.allocations.some((a) => isStockToken(a.id));
}

function toShowcaseTokens(mix: Mix, preset: DemoPreset): ShowcaseToken[] {
  return mix.map((m) => ({
    tokenId: m.id,
    label: m.label,
    name: m.name,
    symbol: m.label,
    color: m.color,
    currentPct: m.id === preset.start.id ? preset.start.pct : 0,
    targetPct: m.target,
    currentUsd: 0,
    targetUsd: 0,
    bandState: "inside",
  }));
}

/** A faint 0–100 scale behind the donut: the world's printed-instrument trace, kept quiet. */
function ScaleBackdrop() {
  const at = (r: number, i: number) => {
    const a = ((i * 3.6 - 90) * Math.PI) / 180;
    return { x: r * Math.cos(a), y: r * Math.sin(a) };
  };
  return (
    <svg
      viewBox="-100 -100 200 200"
      aria-hidden="true"
      className="pointer-events-none absolute left-1/2 top-1/2 -z-10 w-[220%] max-w-none -translate-x-1/2 -translate-y-1/2 text-bone opacity-[0.1]"
    >
      <circle r={96} fill="none" stroke="currentColor" strokeWidth={0.4} />
      {Array.from({ length: 100 }, (_, i) => {
        const major = i % 10 === 0;
        const from = at(major ? 84 : 89, i);
        const to = at(94, i);
        return <line key={i} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="currentColor" strokeWidth={major ? 0.8 : 0.35} />;
      })}
      {Array.from({ length: 10 }, (_, k) => {
        const p = at(77, k * 10);
        return (
          <text key={k} x={p.x} y={p.y + 1.6} textAnchor="middle" fontSize={4.5} fill="currentColor">
            {k * 10}
          </text>
        );
      })}
    </svg>
  );
}

/** Copper marks just outside the ring, where each target slice ends. Same geometry as the donut. */
function TargetMarks({ preset }: { preset: DemoPreset }) {
  const { center, ringOuter } = RING;
  let cursor = 0;
  const marks = preset.allocations.map((a) => {
    cursor += a.pct;
    return (cursor / 100) * 360;
  });
  return (
    <svg viewBox="0 0 240 240" aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
      {marks.map((deg) => (
        <path
          key={deg}
          d={`M${center} ${center - ringOuter + 3} l-3.2 -6 h6.4 z`}
          className="fill-copper"
          transform={`rotate(${deg} ${center} ${center})`}
        />
      ))}
    </svg>
  );
}

function MixBars({ preset, mix, title }: { preset: DemoPreset; mix: Mix; title: string }) {
  return (
    <div className={`${WORLD_PANEL} p-4 sm:p-5`}>
      <p className={WORLD_LABEL}>{title}</p>
      <ul className="mt-3 space-y-3">
        {mix
          .filter((m) => preset.allocations.some((a) => a.id === m.id))
          .map((m) => (
            <li key={m.id}>
              <div className="flex items-center gap-2 text-sm">
                <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: m.color }} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate font-semibold text-bone">{m.label}</span>
                <span className="tabular-nums text-bone">{Math.round(m.now)}%</span>
              </div>
              <div className="relative mt-1.5">
                <div className="h-1.5 overflow-hidden rounded-full bg-bone/10">
                  <div className="h-full rounded-full" style={{ width: `${m.now}%`, backgroundColor: m.color }} />
                </div>
                <span
                  aria-hidden="true"
                  className="absolute -inset-y-1 w-0.5 -translate-x-1/2 rounded-full bg-copper"
                  style={{ left: `${m.target}%` }}
                />
              </div>
            </li>
          ))}
      </ul>
    </div>
  );
}

function HeroDonut({
  preset,
  mix,
  moving,
  atStart,
  onTarget,
  copy,
  ariaLabel,
}: {
  preset: DemoPreset;
  mix: Mix;
  moving: boolean;
  atStart: boolean;
  onTarget: boolean;
  copy: (typeof DEMO_COPY)["en"] | (typeof DEMO_COPY)["es"];
  ariaLabel: string;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const tokens = useMemo(() => toShowcaseTokens(mix, preset), [mix, preset]);
  return (
    <div className={`relative w-[min(64vw,16rem)] sm:w-[min(78vw,20rem)] md:w-80 lg:w-[25rem] ${atStart ? "hero-donut hero-donut-rest" : "hero-donut"}`}>
      <ShowcaseDonut
        tokens={tokens}
        mode={moving ? "target" : "current"}
        activeTokenId={activeId}
        onHover={setActiveId}
        onToggle={(id) => setActiveId((cur) => (cur === id ? null : id))}
        ariaLabel={ariaLabel}
        tokenAriaLabel={(t) => `${t.label} ${t.targetPct}%`}
        center={
          <div className="px-6">
            <p className="text-2xl font-bold text-bone [font-stretch:108%] lg:text-3xl">{preset.title}</p>
            <p className={`mt-1 text-sm font-semibold ${onTarget ? "text-copper" : "text-bone-dim"}`}>
              {onTarget ? copy.onTarget : copy.from(preset.start)}
            </p>
          </div>
        }
        centerFor={(t) => (
          <div>
            <p className="text-2xl font-bold text-bone lg:text-3xl">{t.label}</p>
            <p className="mt-1 text-sm tabular-nums text-bone-dim">{t.targetPct}%</p>
          </div>
        )}
      />
      <TargetMarks preset={preset} />
    </div>
  );
}

export function HeroSection({ comingSoon, stocksBlocked = false }: { comingSoon: boolean; stocksBlocked?: boolean }) {
  const { lang } = useLanguage();
  const t = landingTranslations[lang].hero;
  const tDemo = landingTranslations[lang].compositionDemo;
  const tSoon = landingTranslations[lang].comingSoon;
  const copy = DEMO_COPY[lang];
  // D-569: where stocks can't be bought, their presets go last and can't be picked, so the hero opens
  // on the first one that can.
  const presets = useMemo(() => {
    const all = buildDemoPresets(lang, HERO_PRESET_ORDER);
    return stocksBlocked ? [...all.filter((p) => !hasStock(p)), ...all.filter(hasStock)] : all;
  }, [lang, stocksBlocked]);

  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true });
  const [activeIndex, setActiveIndex] = useState(0);
  const [playToken, setPlayToken] = useState(0);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (inView) setPlayToken((n) => (n === 0 ? 1 : n));
  }, [inView]);

  const preset = presets[activeIndex] ?? presets[0];
  // `hydrated` passed as true: the server HTML shows the starting point (see the header comment).
  const progress = useProgress(playToken > 0, playToken, reduced, true, MOVE_MS);
  const mix = mixAt(preset, progress);
  const finalMix = mixAt(preset, 1);
  const donutLabel = `${preset.title}: ${preset.allocations.map((a) => `${a.label} ${a.pct}%`).join(", ")}`;

  function select(index: number) {
    setActiveIndex(index);
    setPlayToken((n) => n + 1);
  }

  return (
    // overflow-x-clip: the scale behind the donut is wider than a phone.
    <section aria-label={landingTranslations[lang].a11y.hero} className="overflow-x-clip">
      <div ref={ref} className="mx-auto max-w-6xl px-6 pb-12 pt-8 sm:pb-16 sm:pt-16">
        {/* Plain h1 (no motion): visible in the server HTML on first paint. */}
        <h1 className="mx-auto max-w-4xl break-words text-center text-4xl font-bold leading-[1.04] tracking-[-0.015em] text-bone [font-stretch:110%] [text-wrap:balance] max-sm:text-[2rem] sm:text-5xl lg:text-[3.5rem]">
          {t.headline}
        </h1>
        <p className="mx-auto mt-4 max-w-2xl text-center text-base text-bone-dim sm:mt-5 sm:text-lg">{t.sub}</p>

        <div className="mt-6 grid grid-cols-1 items-center justify-items-center gap-4 sm:mt-10 sm:gap-6 md:grid-cols-2 lg:mt-8 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] lg:gap-10">
          {/* The donut: first on phones and tablets, in the middle on wide screens. */}
          <div className="relative isolate md:col-span-2 lg:col-span-1 lg:col-start-2 lg:row-start-1">
            <ScaleBackdrop />
            <div data-needs-js>
              <HeroDonut
                preset={preset}
                mix={mix}
                moving={progress > 0}
                atStart={progress === 0}
                onTarget={progress >= 1}
                copy={copy}
                ariaLabel={donutLabel}
              />
            </div>
            <div data-nojs-only>
              <HeroDonut preset={preset} mix={finalMix} moving atStart={false} onTarget copy={copy} ariaLabel={donutLabel} />
            </div>
          </div>

          {/* Presets and the way into the app with the mix on screen (D-561; "Open app" stays in the nav, D-453). */}
          <div className="w-full max-w-sm md:order-2 lg:order-none lg:col-start-3 lg:row-start-1 lg:justify-self-end">
            <div className={`${WORLD_PANEL} p-4 sm:p-5`}>
              {/* Labels wrap rather than cut: "NEAR + Acciones" does not fit one line at every width. */}
              <div data-needs-js className="grid grid-cols-3 gap-2 lg:grid-cols-2">
                {presets.map((p, i) => {
                  const on = i === activeIndex;
                  const unavailable = stocksBlocked && hasStock(p);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => select(i)}
                      disabled={unavailable}
                      aria-pressed={on}
                      className={`inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md border px-1.5 py-1 text-center text-[13px] font-semibold leading-tight transition sm:text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-bone/70 lg:min-h-10 ${
                        on
                          ? "border-bone bg-bone text-graphite"
                          : unavailable
                            ? "cursor-not-allowed border-bone/15 bg-bone/[0.04] text-bone-dim opacity-40"
                            : "border-bone/15 bg-bone/[0.04] text-bone-dim hover:border-bone/30 hover:text-bone"
                      }`}
                    >
                      {hasStock(p) ? (
                        <StockIcon className={`h-3.5 w-3.5 shrink-0 ${on ? "text-fuchsia-800" : "text-fuchsia-200"}`} />
                      ) : null}
                      <span>{p.title}</span>
                    </button>
                  );
                })}
              </div>
              <div className="mt-3 sm:mt-4">
                <AppCta
                  href={`/dashboard?${PRESET_ENTRY_PARAM}=${preset.id}` as Route<string>}
                  label={tDemo.startWithMix}
                  comingSoon={comingSoon}
                  soonBadge={tSoon.badge}
                  soonSrLabel={tSoon.srLabel}
                  className={CTA_CLASS}
                />
              </div>
              {/* D-569: fixed, with no country check, so the landing stays static. */}
              <p className="mt-3 flex items-center justify-center gap-1.5 text-center text-xs leading-snug text-bone-dim">
                <StockIcon className="h-3.5 w-3.5 shrink-0 text-fuchsia-200" />
                {tDemo.stocksUnavailable}
              </p>
            </div>
          </div>

          {/* The mix: each bar travels to the copper mark of its target. */}
          <div className="w-full max-w-sm md:order-1 lg:order-none lg:col-start-1 lg:row-start-1 lg:justify-self-start">
            <div data-needs-js>
              <MixBars preset={preset} mix={mix} title={preset.title} />
            </div>
            <div data-nojs-only>
              <MixBars preset={preset} mix={finalMix} title={preset.title} />
            </div>
          </div>
        </div>

        <div className="mx-auto mt-10 max-w-2xl space-y-2 text-center text-sm text-bone-dim">
          <p>{t.spreadNote}</p>
          {/* D-532: multichain on the first screen. */}
          <p>{t.wallets}</p>
        </div>
      </div>
    </section>
  );
}
