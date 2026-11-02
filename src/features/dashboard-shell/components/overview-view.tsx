"use client";

import { useMemo } from "react";
import type { Route } from "next";
import { usePortfolio } from "../context/portfolio-context";
import { useLanguage } from "../context/language-context";
import { shellTranslations, type ShellTranslations } from "../lib/translations";
import { usePortfolioEarnings } from "../hooks/use-portfolio-earnings";
import { dayChange } from "../lib/day-change";
import { useDayPrices } from "@/features/vault/hooks/use-day-prices";
import { useLoginWallet } from "@/features/login-wallet";
import { useTokenPrices } from "@/features/market/hooks/use-token-prices";
import { usePortfolioComputed } from "@/features/portfolio-editor/hooks/use-portfolio-computed";
import { translations as editorTranslations } from "@/features/portfolio-editor/lib/translations";
import type { ChartRow, CurrentPortfolioQty, Language, TargetAllocation } from "@/features/portfolio-editor/types";
import type { RingColor } from "@/features/portfolio-editor/lib/format";
import { withdrawalRegistry } from "@/features/bridge/lib/withdrawal-registry";
import { chainRegistry } from "@/features/bridge/lib/chain-registry";
import { PortfolioShowcase } from "@/features/portfolio-showcase/components/portfolio-showcase";
import { utcDay } from "@/features/portfolio-showcase/lib/showcase-geometry";
import type { ShowcaseLabels, ShowcaseNetwork, ShowcaseToken } from "@/features/portfolio-showcase/types";

const NO_TARGETS: TargetAllocation[] = [];
const NO_DEPOSITS: CurrentPortfolioQty = {};

export function overviewLabels(t: ShellTranslations): ShowcaseLabels {
  return {
    value: t.performancePortfolioValue,
    moving: t.overviewMoving,
    onTargetStatus: t.overviewOnTarget,
    since: t.overviewSince,
    sinceToday: t.overviewSinceToday,
    dayOne: t.overviewDayOne,
    dayMany: t.overviewDayMany,
    tokenOne: t.overviewTokenOne,
    tokenMany: t.overviewTokenMany,
    networkOne: t.overviewNetworkOne,
    networkMany: t.overviewNetworkMany,
    inPlace: t.overviewInPlace,
    inPlaceSub: t.overviewInPlaceSub,
    inPlaceEmpty: t.overviewInPlaceEmpty,
    onTargetCount: t.overviewOnTargetCount,
    allOnTarget: t.overviewAllOnTarget,
    oneOnTarget: t.overviewOneOnTarget,
    oneOffTarget: t.overviewOneOffTarget,
    inPlaceLegendIn: t.overviewLegendIn,
    inPlaceLegendRest: t.overviewLegendRest,
    stageTitle: t.overviewStageTitle,
    editTargets: t.overviewEditTargets,
    now: t.overviewNow,
    target: t.overviewTarget,
    yourMix: t.overviewYourMix,
    movesToward: t.overviewMovesToward,
    notInMix: t.overviewNotInMix,
    intoOthers: t.overviewIntoOthers,
    hoverHint: t.overviewHoverHint,
    tapHint: t.overviewTapHint,
    underShare: t.overviewUnderShare,
    alsoInPortfolio: t.overviewAlsoInPortfolio,
    currentMixAria: t.overviewCurrentMixAria,
    targetMixAria: t.overviewTargetMixAria,
    spread: t.historyEventAttributedSpread,
    spreadInfo: t.performanceSpreadInfo,
    spreadNote: t.overviewSpreadNote,
    spreadNone: t.overviewSpreadNone,
    earningsFailed: t.performanceRebalancesError,
    swaps: t.performanceSwapsLabel,
    swapsNote: t.performanceSwapsNote,
    swapsWindow: t.overviewSwapsWindow,
    networks: t.overviewNetworks,
    networksNote: t.overviewNetworksNote,
    networksOther: t.overviewNetworksOther,
    dayChangeToday: t.overviewDayChangeToday,
    dayChangeInfo: t.overviewDayChangeInfo,
  };
}

/**
 * The editor's rows as showcase tokens: only what is held or targeted (a 0/0 row draws nothing),
 * named as the donut legend names them — the registry name when a symbol repeats (D-407).
 */
export function toShowcaseTokens(rows: ChartRow[], colorByToken: Map<string, RingColor>): ShowcaseToken[] {
  const shown = rows.filter((row) => row.symbol && (row.currentPct > 0 || row.targetPct > 0));
  const counts = new Map<string, number>();
  for (const row of shown) counts.set(row.symbol, (counts.get(row.symbol) ?? 0) + 1);
  return shown.map((row) => {
    const name = row.token?.name ?? row.symbol;
    return {
      tokenId: row.tokenId,
      symbol: row.symbol,
      network: networkOf(row.tokenId),
      name,
      label: (counts.get(row.symbol) ?? 0) > 1 ? name : row.symbol,
      color: colorByToken.get(row.tokenId)?.hex ?? "#64748b",
      currentPct: row.currentPct || 0,
      targetPct: row.targetPct || 0,
      currentUsd: row.currentUsd || 0,
      targetUsd: row.targetUsd || 0,
      bandState: row.bandState,
    };
  });
}

/** The network a token withdraws to, by its display name. */
function networkOf(tokenId: string): string | undefined {
  const chainId = withdrawalRegistry[tokenId]?.chainId;
  return chainId ? chainRegistry[chainId]?.displayName : undefined;
}

/** Where the tokens live, by the network each one withdraws to; held ones, or the targets of an empty portfolio. */
export function networksOf(tokens: ShowcaseToken[]): ShowcaseNetwork[] {
  const held = tokens.filter((t) => t.currentPct > 0);
  const base = held.length > 0 ? held : tokens.filter((t) => t.targetPct > 0);
  const byName = new Map<string, ShowcaseNetwork>();
  for (const token of base) {
    const name = networkOf(token.tokenId);
    if (!name) continue;
    const entry = byName.get(name) ?? { name, tokens: 0, usd: 0 };
    entry.tokens += 1;
    entry.usd += token.currentUsd;
    byName.set(name, entry);
  }
  return [...byName.values()].sort((a, b) => b.usd - a.usd || b.tokens - a.tokens);
}

// "Data up to …": Performance's shape, on a 24-hour clock.
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

/** The Overview tab (D-518): the active portfolio as committed — an open edit stays in Composition. */
export function OverviewView({ basePath = "/dashboard" }: { basePath?: string }) {
  const { activePortfolio } = usePortfolio();
  const { lang } = useLanguage();
  const t = shellTranslations[lang];
  const { intentsAccountId } = useLoginWallet();
  const priceState = useTokenPrices(15000);
  const computed = usePortfolioComputed({
    targets: activePortfolio?.targets ?? NO_TARGETS,
    effectiveCurrentPortfolioQty: activePortfolio?.deposits ?? NO_DEPOSITS,
    priceMap: priceState.prices,
  });
  const { earnings, outOfDate, recordedUntil, partial } = usePortfolioEarnings(activePortfolio, intentsAccountId);
  const tokens = useMemo(() => toShowcaseTokens(computed.chartRows, computed.colorByToken), [computed.chartRows, computed.colorByToken]);
  const networks = useMemo(() => networksOf(tokens), [tokens]);
  const labels = useMemo(() => overviewLabels(t), [t]);
  // D-523: real portfolios only — a mock one has no recorded prices to measure against.
  const dayPrices = useDayPrices(activePortfolio?.isReal === true);
  const change = useMemo(
    () =>
      activePortfolio?.isReal
        ? dayChange({
            deposits: activePortfolio.deposits,
            prices: priceState.error || !priceState.lastUpdatedAt ? null : priceState.prices,
            dayPrices,
            createdAt: activePortfolio.createdAt,
            now: Date.now(),
          })
        : null,
    [activePortfolio, priceState.error, priceState.lastUpdatedAt, priceState.prices, dayPrices]
  );

  if (!activePortfolio) return null;

  const earningsNote = partial
    ? t.performanceStatsLoading
    : outOfDate && recordedUntil != null
      ? t.performanceStatsOutOfDate.replace("{date}", formatRecordedUntil(recordedUntil, lang))
      : null;

  return (
    <section aria-label={t.subNavOverview} className="w-full">
      <PortfolioShowcase
        tokens={tokens}
        totalUsd={computed.currentTotalUsd}
        dayChange={change}
        earnings={earnings}
        networks={networks}
        createdAt={activePortfolio.createdAt > 0 ? activePortfolio.createdAt : null}
        todayDay={utcDay(Date.now())}
        lang={lang}
        labels={labels}
        editHref={`${basePath}/composition` as Route}
        valueNote={priceState.error ? editorTranslations[lang].priceStatusFallback : null}
        earningsNote={earningsNote}
        previewKey={activePortfolio.id}
      />
    </section>
  );
}
