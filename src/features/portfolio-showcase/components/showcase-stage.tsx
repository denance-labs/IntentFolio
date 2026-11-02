"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { ArrowRight } from "lucide-react";
import { formatUsd } from "@/features/portfolio-editor/lib/format";
import { RING, ShowcaseDonut } from "./showcase-donut";
import { LABEL_MIN_SHARE, placeLeaders } from "./showcase-leaders";
import { clickPins } from "../lib/pin";
import { formatShare } from "../lib/format";
import type { ShowcaseLabels, ShowcaseToken } from "../types";

type Mode = "current" | "target";

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many.replace("{n}", String(n));
}

type Props = {
  tokens: ShowcaseToken[];
  totalUsd: number;
  labels: ShowcaseLabels;
  activeTokenId: string | null;
  onHover: (tokenId: string | null) => void;
  onToggle: (tokenId: string) => void;
  editHref?: Route;
  /** Plays the phone's Now → Target → Now preview once per session under this key; none, never. */
  previewKey?: string;
  className?: string;
};

/** Current → Target: two donuts side by side, or one that morphs between both on a phone. */
export function ShowcaseStage({ tokens, totalUsd, labels, activeTokenId, onHover, onToggle, editHref, previewKey, className = "" }: Props) {
  // null until the switch or the preview picks one: then a portfolio holding nothing yet opens on
  // its target, the one donut with something in it.
  const [chosenMode, setChosenMode] = useState<Mode | null>(null);
  const touched = useRef(false);
  const heldCount = tokens.filter((t) => t.currentPct > 0).length;
  const phoneMode = chosenMode ?? (heldCount > 0 ? "current" : "target");
  const targetCount = tokens.filter((t) => t.targetPct > 0).length;
  const legend = [...tokens].sort((a, b) => b.currentUsd - a.currentUsd || b.targetPct - a.targetPct);
  // From xl the labels beside the donuts are the legend; a token neither donut could label (too
  // thin, or no room) keeps its chip there, so every token is still named somewhere.
  const labeled = new Set(
    [...placeLeaders(tokens, "current", "right", RING), ...placeLeaders(tokens, "target", "left", RING)].map((l) => l.tokenId),
  );
  const unlabeled = legend.filter((t) => !labeled.has(t.tokenId));
  // Named by why they have no label; a token big enough that only room ran out gets the plain name.
  const unlabeledTitle = unlabeled.every((t) => t.currentPct < LABEL_MIN_SHARE && t.targetPct < LABEL_MIN_SHARE)
    ? labels.underShare.replace("{pct}", String(LABEL_MIN_SHARE))
    : labels.alsoInPortfolio;
  const active = activeTokenId ? tokens.find((t) => t.tokenId === activeTokenId) ?? null : null;

  // The phone shows one donut, so it plays the move once — to the target and back — the first
  // time this portfolio is opened in the session. A tap on the switch takes over at once.
  useEffect(() => {
    if (!previewKey || totalUsd <= 0) return;
    if (!window.matchMedia("(max-width: 767px)").matches) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    try {
      const key = `intentfolio.overview-preview.${previewKey}`;
      if (window.sessionStorage.getItem(key)) return;
      window.sessionStorage.setItem(key, "1");
    } catch {
      return;
    }
    const toTarget = window.setTimeout(() => !touched.current && setChosenMode("target"), 1400);
    const back = window.setTimeout(() => !touched.current && setChosenMode("current"), 3800);
    return () => {
      window.clearTimeout(toTarget);
      window.clearTimeout(back);
    };
  }, [previewKey, totalUsd]);

  const choose = (mode: Mode) => {
    touched.current = true;
    setChosenMode(mode);
  };

  const center = (mode: Mode) => (
    <div>
      <p className="text-[11px] uppercase tracking-[0.16em] text-slate-400">{mode === "current" ? labels.now : labels.target}</p>
      <p className="mt-1.5 text-[26px] font-semibold leading-none text-white">
        {mode === "current" ? formatUsd(totalUsd) : plural(targetCount, labels.tokenOne, labels.tokenMany)}
      </p>
      <p className="mt-1.5 text-xs text-slate-400">
        {mode === "current" ? plural(heldCount, labels.tokenOne, labels.tokenMany) : labels.yourMix}
      </p>
    </div>
  );

  const centerFor = (mode: Mode) => function TokenCenter(token: ShowcaseToken) {
    const pct = mode === "current" ? token.currentPct : token.targetPct;
    const usd = mode === "current" ? token.currentUsd : token.targetUsd;
    return (
      <div className="max-w-[62%]">
        <p className="truncate text-[11px] text-slate-400">{token.label}</p>
        <p className="mt-1.5 text-[26px] font-semibold leading-none tabular-nums text-white">{formatShare(pct)}</p>
        {mode === "target" && token.targetPct === 0 ? (
          <p className="mt-1.5 text-xs text-slate-400">{labels.notInMix}</p>
        ) : (
          <p className="mt-1.5 text-xs tabular-nums text-cyan-300">{formatUsd(usd)}</p>
        )}
      </div>
    );
  };

  const chip = (token: ShowcaseToken) => {
    const isActive = activeTokenId === token.tokenId;
    const isDimmed = activeTokenId !== null && !isActive;
    return (
      <button
        key={token.tokenId}
        type="button"
        aria-pressed={isActive}
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
        className={`inline-flex items-center gap-2 rounded-[10px] border px-3 py-1.5 text-[12.5px] text-slate-200 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 ${
          isDimmed ? "border-slate-800 bg-slate-900 opacity-40" : "border-slate-800 bg-slate-900"
        }`}
        style={isActive ? { borderColor: token.color, backgroundColor: `${token.color}24` } : undefined}
      >
        <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ backgroundColor: token.color }} aria-hidden="true" />
        {token.label}
        <span className="tabular-nums text-slate-400">
          {formatShare(token.currentPct)} → {formatShare(token.targetPct)}
        </span>
      </button>
    );
  };

  const tokenAria = (mode: Mode) => (token: ShowcaseToken) =>
    `${token.label}: ${formatShare(mode === "current" ? token.currentPct : token.targetPct)}`;

  const donut = (mode: Mode, className: string, enterDelayMs: number, leaders?: "left" | "right") => (
    <ShowcaseDonut
      tokens={tokens}
      mode={mode}
      activeTokenId={activeTokenId}
      onHover={onHover}
      onToggle={onToggle}
      ariaLabel={mode === "current" ? labels.currentMixAria.replace("{value}", formatUsd(totalUsd)) : labels.targetMixAria}
      tokenAriaLabel={tokenAria(mode)}
      center={center(mode)}
      centerFor={centerFor(mode)}
      enterDelayMs={enterDelayMs}
      leaders={leaders}
      className={className}
    />
  );

  return (
    <section
      aria-labelledby="overview-stage-title"
      className={`ov-rise mt-7 rounded-[2rem] border border-white/[0.06] px-4 pb-6 pt-5 sm:px-8 sm:pb-7 sm:pt-6 ${className}`}
      style={{
        animationDelay: "300ms",
        background:
          "radial-gradient(120% 90% at 50% 0%, rgb(103 232 249 / 0.045), rgb(103 232 249 / 0) 60%), rgb(255 255 255 / 0.018)",
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="overview-stage-title" className="text-[15px] font-semibold text-slate-200">
          {labels.stageTitle}
        </h2>
        {editHref ? (
          <Link
            href={editHref}
            className="hidden items-center gap-1.5 rounded text-[13px] text-cyan-200 transition hover:text-cyan-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 md:inline-flex"
          >
            {labels.editTargets}
            <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
          </Link>
        ) : null}
      </div>

      {/* Tablet and up: both mixes at once, the move between them in the middle. From xl the
          labels with lines (D-522) show around each donut, facing away from the middle; the extra
          margin is the room they take above and below the ring. */}
      <div className="mt-2 hidden items-center justify-center md:grid md:grid-cols-[minmax(0,340px)_minmax(110px,180px)_minmax(0,340px)] lg:grid-cols-[minmax(0,380px)_minmax(150px,230px)_minmax(0,380px)] xl:my-6">
        {donut("current", "w-full", 120, "right")}
        <MoveChip token={active} labels={labels} />
        {donut("target", "w-full", 280, "left")}
      </div>

      {/* Phone: one donut and a switch; the slices travel from one mix to the other. */}
      <div className="md:hidden">
        <div role="group" aria-label={labels.stageTitle} className="relative mt-3 grid grid-cols-2 rounded-xl border border-slate-800 bg-slate-900 p-1">
          <span
            aria-hidden="true"
            className={`absolute bottom-1 left-1 top-1 w-[calc(50%-4px)] rounded-[9px] bg-card shadow-md shadow-black/30 transition-transform duration-500 ease-in-out motion-reduce:transition-none ${
              phoneMode === "target" ? "translate-x-full" : ""
            }`}
          />
          {(["current", "target"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={phoneMode === mode}
              onClick={() => choose(mode)}
              className={`relative h-9 rounded-[9px] text-[13px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 ${
                phoneMode === mode ? "text-white" : "text-slate-400"
              }`}
            >
              {mode === "current" ? labels.now : labels.target}
            </button>
          ))}
        </div>
        {donut(phoneMode, "mx-auto mt-4 w-full max-w-[320px]", 120)}
      </div>

      {/* Tablet and small desktop legend; from xl the labels beside the donuts take its place. */}
      <div className="mt-5 hidden flex-wrap justify-center gap-2 md:flex xl:hidden">{legend.map(chip)}</div>
      {unlabeled.length > 0 ? (
        // The labels under the ring reach ~9 px past the donuts' margin: keep the chips below them
        // (padding, as a margin here would collapse into that one).
        <div className="hidden flex-col items-center gap-1.5 pt-3 xl:flex" data-unlabeled-legend="">
          <p className="text-[12px] text-slate-400">{unlabeledTitle}</p>
          <div className="flex flex-wrap justify-center gap-2">{unlabeled.map(chip)}</div>
        </div>
      ) : null}

      <div className="mt-4 flex flex-col gap-1.5 md:hidden">
        {legend.map((token) => {
          const isActive = activeTokenId === token.tokenId;
          return (
            <button
              key={token.tokenId}
              type="button"
              aria-pressed={isActive}
              onClick={(e) => {
                if (clickPins(e)) onToggle(token.tokenId);
              }}
              data-showcase-token=""
              className="grid grid-cols-[12px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-xl border border-slate-800 bg-slate-900 px-3 py-2 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
              style={isActive ? { borderColor: token.color, backgroundColor: `${token.color}1f` } : undefined}
            >
              <span className="h-2.5 w-2.5 rounded-[3px]" style={{ backgroundColor: token.color }} aria-hidden="true" />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-[13px] font-semibold text-slate-100">{token.symbol}</span>
                <span className="truncate text-[10.5px] text-slate-400">{token.name}</span>
              </span>
              <span className="text-[12.5px] tabular-nums text-slate-300">
                {formatShare(token.currentPct)} → {formatShare(token.targetPct)}
              </span>
            </button>
          );
        })}
      </div>

      {/* A lone token is already the whole ring: there is nothing to follow. */}
      {legend.length > 1 ? (
        <p className="mt-3.5 text-center text-[11.5px] text-slate-400">
          <span className="hidden md:inline">{labels.hoverHint}</span>
          <span className="md:hidden">{labels.tapHint}</span>
        </p>
      ) : null}
    </section>
  );
}

/** Between the donuts: an arrow at rest, the lit token's move while one is lit. */
function MoveChip({ token, labels }: { token: ShowcaseToken | null; labels: ShowcaseLabels }) {
  return (
    <div className="flex h-28 items-center justify-center px-2 text-center">
      {token ? (
        <div key={token.tokenId} className="ov-fade">
          <p className="flex items-center justify-center gap-1.5 text-xs text-slate-300">
            <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ backgroundColor: token.color }} aria-hidden="true" />
            <span className="truncate">{token.label}</span>
          </p>
          <p className="mt-1.5 whitespace-nowrap text-[17px] font-semibold tabular-nums text-white">
            {formatShare(token.currentPct)} → {formatShare(token.targetPct)}
          </p>
          {token.targetPct === 0 ? <p className="mt-1 text-[11px] text-slate-400">{labels.intoOthers}</p> : null}
        </div>
      ) : (
        <div className="ov-fade flex flex-col items-center gap-2.5">
          <svg width="150" height="16" viewBox="0 0 150 16" aria-hidden="true" className="max-w-full">
            <defs>
              <linearGradient id="overview-move-arrow" x1="0" x2="1" y1="0" y2="0">
                <stop offset="0" stopColor="#3a475b" />
                <stop offset="1" stopColor="#67e8f9" />
              </linearGradient>
            </defs>
            <path
              d="M2 8h142M136 2l8 6-8 6"
              fill="none"
              stroke="url(#overview-move-arrow)"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span className="text-[11.5px] text-slate-400">{labels.movesToward}</span>
        </div>
      )}
    </div>
  );
}
