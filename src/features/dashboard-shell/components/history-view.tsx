"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import { usePortfolio } from "../context/portfolio-context";
import { useLanguage } from "../context/language-context";
import { shellTranslations, type ShellTranslations } from "../lib/translations";
import { toHistoryRows, type HistoryRow, type HistoryRowType } from "../lib/history-mapper";
import { ACTIVITY_PAGE_SIZE } from "../lib/account-activity";
import type { ContractEvent } from "@/features/intents-account/mock-contract";
import { mockContract } from "@/features/intents-account/mock-contract";
import { useLoginWallet } from "@/features/login-wallet";
import { useTokenPrices } from "@/features/market/hooks/use-token-prices";
import { symbolForTokenId } from "@/features/market/lib/token-registry";
import { formatUsd, colorForSymbol } from "@/features/portfolio-editor/lib/format";
import { usePortfolioComputed } from "@/features/portfolio-editor/hooks/use-portfolio-computed";
import type { CurrentPortfolioQty, Language, TargetAllocation } from "@/features/portfolio-editor/types";
import { useRealPortfolioHistory } from "@/features/vault/hooks/use-real-portfolio-history";
import { ErrorState, SkeletonBlock } from "./view-states";

type CompositionEntry = { symbol: string; pct: number };

/** A token's dot color, by symbol (rows carry symbols, not token ids). */
type ColorOf = (symbol: string) => string;

const NO_TARGETS: TargetAllocation[] = [];
const NO_DEPOSITS: CurrentPortfolioQty = {};

type EventTypeConfig = {
  labelKey: keyof ShellTranslations;
  badgeClass: string;
};

const EVENT_TYPE_CONFIG: Record<HistoryRowType, EventTypeConfig> = {
  deposit: {
    labelKey: "historyEventDeposit",
    badgeClass: "bg-emerald-400/15 border-emerald-400/30 text-emerald-200",
  },
  withdrawal: {
    labelKey: "historyEventWithdrawal",
    badgeClass: "bg-amber-400/15 border-amber-400/30 text-amber-200",
  },
  external_rebalance: {
    labelKey: "historyEventExternalRebalance",
    badgeClass: "bg-accent/15 border-accent/30 text-accent",
  },
  internal_rebalance: {
    labelKey: "historyEventInternalRebalance",
    badgeClass: "bg-violet-400/15 border-violet-400/30 text-violet-200",
  },
  portfolio_created: {
    labelKey: "historyEventPortfolioCreated",
    badgeClass: "bg-sky-400/15 border-sky-400/30 text-sky-200",
  },
  add_to_portfolio: {
    labelKey: "historyEventAddToPortfolio",
    badgeClass: "bg-emerald-400/15 border-emerald-400/30 text-emerald-200",
  },
  move_to_general_balance: {
    labelKey: "historyEventMoveToGeneralBalance",
    badgeClass: "bg-amber-400/15 border-amber-400/30 text-amber-200",
  },
  composition_edit: {
    labelKey: "historyEventCompositionEdit",
    badgeClass: "bg-rose-400/15 border-rose-400/30 text-rose-200",
  },
  portfolio_edit: {
    labelKey: "historyEventPortfolioEdit",
    badgeClass: "bg-rose-400/15 border-rose-400/30 text-rose-200",
  },
};

function sym(tokenId: string): string {
  return symbolForTokenId(tokenId);
}

function formatEventDate(timestamp: number, lang: Language): string {
  return new Intl.DateTimeFormat(lang === "es" ? "es-AR" : "en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function formatDayLabel(timestamp: number, lang: Language): string {
  return new Intl.DateTimeFormat(lang === "es" ? "es-AR" : "en-US", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(timestamp));
}

function formatTokenQty(qty: number): string {
  if (qty >= 1000) return qty.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (qty >= 1) return qty.toLocaleString("en-US", { maximumFractionDigits: 3 });
  return qty.toLocaleString("en-US", { maximumFractionDigits: 5 });
}

/** A target in %, as the user reads numbers: "39,5%" in Spanish, "39.5%" in English. */
function formatPct(pct: number, lang: Language): string {
  return `${pct.toLocaleString(lang === "es" ? "es-AR" : "en-US", { maximumFractionDigits: 2 })}%`;
}

function childEventDescription(e: ContractEvent, lang: Language): string {
  const es = lang === "es";
  switch (e.kind) {
    case "portfolio_created":
      return es ? "Portfolio creado" : "Portfolio created";
    case "portfolio_deleted":
      return es ? "Portfolio eliminado" : "Portfolio deleted";
    case "token_added":
      return es
        ? `${sym(e.token)} agregado · objetivo ${formatPct(e.initial_target_pct, lang)}`
        : `${sym(e.token)} added · target ${formatPct(e.initial_target_pct, lang)}`;
    case "token_removed":
      return es ? `${sym(e.token)} quitado` : `${sym(e.token)} removed`;
    case "composition_changed":
      return es ? "Composición editada" : "Composition edited";
    case "target_set":
      return es
        ? `${sym(e.token)} · nuevo objetivo ${formatPct(e.target_pct, lang)}`
        : `${sym(e.token)} · new target ${formatPct(e.target_pct, lang)}`;
    case "target_change": {
      // Only what moved (D-530); a change with neither moved still names its target.
      const toleranceMoved = e.old_tolerance_pct !== e.new_tolerance_pct;
      const parts: string[] = [];
      if (e.old_target_pct !== e.new_target_pct || !toleranceMoved) {
        parts.push(`${es ? "objetivo" : "target"} ${formatPct(e.old_target_pct, lang)} → ${formatPct(e.new_target_pct, lang)}`);
      }
      if (toleranceMoved) {
        parts.push(`${es ? "tolerancia" : "tolerance"} ${formatPct(e.old_tolerance_pct, lang)} → ${formatPct(e.new_tolerance_pct, lang)}`);
      }
      return `${sym(e.token)} · ${parts.join(", ")}`;
    }
    case "allocate":
      return es
        ? `+${formatTokenQty(e.qty)} ${sym(e.token)} asignado al portfolio`
        : `+${formatTokenQty(e.qty)} ${sym(e.token)} added to portfolio`;
    case "unallocate":
      return es
        ? `−${formatTokenQty(e.qty)} ${sym(e.token)} pasado a la cuenta de fondos`
        : `−${formatTokenQty(e.qty)} ${sym(e.token)} moved to funding account`;
    case "storage_cost":
      return es
        ? `Costo de almacenamiento · ${formatTokenQty(e.qty)} ${sym(e.token)}`
        : `Storage cost · ${formatTokenQty(e.qty)} ${sym(e.token)}`;
    case "register_user":
      return es ? "Cuenta registrada" : "Account registered";
    default:
      return e.kind;
  }
}

function childDotStyle(e: ContractEvent, colorOf: ColorOf): { bg: string; inline?: React.CSSProperties } {
  // The Storage Cost never reaches the portfolio: no token color.
  if (e.kind !== "storage_cost" && "token" in e && typeof e.token === "string") {
    return { bg: "", inline: { backgroundColor: colorOf(sym(e.token)) } };
  }
  return { bg: "bg-slate-600", inline: undefined };
}

function TokenMoveSummary({
  tokens,
  colorOf,
}: {
  tokens: HistoryRow["tokens"];
  colorOf: ColorOf;
}) {
  return (
    <span className="flex flex-wrap gap-x-2 gap-y-0.5">
      {tokens.map((move) => (
        <span
          key={move.symbol + move.direction}
          className={move.direction === "in" ? "text-emerald-300" : "text-amber-300"}
        >
          <span
            className="mr-0.5 inline-block h-2 w-2 shrink-0 rounded-sm align-middle"
            style={{ backgroundColor: colorOf(move.symbol) }}
            aria-hidden="true"
          />
          {move.direction === "in" ? "+" : "−"}
          {formatTokenQty(move.qty)}{" "}
          <span className="inline-block max-w-[100px] truncate align-bottom">{move.symbol}</span>
        </span>
      ))}
    </span>
  );
}

function CompositionTable({
  before,
  after,
  labelBefore,
  labelAfter,
  tokenLabel,
  colorOf,
}: {
  before: CompositionEntry[];
  after: CompositionEntry[];
  labelBefore: string;
  labelAfter: string;
  tokenLabel: string;
  colorOf: ColorOf;
}) {
  const symbols = Array.from(
    new Set([...before.map((r) => r.symbol), ...after.map((r) => r.symbol)])
  );
  const beforeMap = Object.fromEntries(before.map((r) => [r.symbol, r.pct]));
  const afterMap = Object.fromEntries(after.map((r) => [r.symbol, r.pct]));

  return (
    <table className="w-full table-fixed text-sm">
      <thead>
        <tr>
          <th className="w-[44%] pb-1.5 text-left text-[10px] font-medium uppercase tracking-wider text-slate-400">
            {tokenLabel}
          </th>
          <th className="w-[24%] pb-1.5 text-right text-[10px] font-medium uppercase tracking-wider text-slate-400">
            {labelBefore}
          </th>
          <th className="w-8 pb-1.5 text-center text-slate-600" aria-hidden="true">
            →
          </th>
          <th className="w-[24%] pb-1.5 text-right text-[10px] font-medium uppercase tracking-wider text-slate-400">
            {labelAfter}
          </th>
        </tr>
      </thead>
      <tbody>
        {symbols.map((symbol) => {
          const bPct = beforeMap[symbol];
          const aPct = afterMap[symbol];
          const changed =
            bPct !== undefined &&
            aPct !== undefined &&
            Math.abs(bPct - aPct) >= 0.1;
          return (
            <tr key={symbol}>
              <td className="max-w-0 py-0.5">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    className="inline-block h-2 w-2 shrink-0 rounded-sm"
                    style={{ backgroundColor: colorOf(symbol) }}
                    aria-hidden="true"
                  />
                  <span className="truncate font-medium text-slate-200">{symbol}</span>
                </span>
              </td>
              <td className="py-0.5 text-right tabular-nums text-slate-400">
                {bPct !== undefined ? `${bPct.toFixed(1)}%` : "—"}
              </td>
              <td className="py-0.5 text-center text-slate-700" aria-hidden="true">
                →
              </td>
              <td
                className={`py-0.5 text-right tabular-nums ${
                  changed ? "font-medium text-accent" : "text-slate-400"
                }`}
              >
                {aPct !== undefined ? `${aPct.toFixed(1)}%` : "—"}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function hasMeaningfulComposition(
  before?: CompositionEntry[],
  after?: CompositionEntry[]
): boolean {
  if (!before || !after || before.length === 0 || after.length === 0) return false;
  const beforeMap = Object.fromEntries(before.map((r) => [r.symbol, r.pct]));
  return after.some((r) => {
    const b = beforeMap[r.symbol];
    return b === undefined || Math.abs(b - r.pct) >= 0.1;
  });
}

function ChildEventList({
  events,
  lang,
  colorOf,
}: {
  events: ContractEvent[];
  lang: Language;
  colorOf: ColorOf;
}) {
  return (
    <ul className="space-y-1.5">
      {events.map((e) => {
        const dot = childDotStyle(e, colorOf);
        return (
          <li key={e.event_id} className="flex items-center gap-2 text-xs text-slate-400">
            <span
              className={`inline-block h-2 w-2 shrink-0 rounded-sm ${dot.bg}`}
              style={dot.inline}
              aria-hidden="true"
            />
            <span>{childEventDescription(e, lang)}</span>
          </li>
        );
      })}
    </ul>
  );
}

function HistoryEventCard({
  row,
  lang,
  t,
  attribution,
  portfolioName,
  colorOf,
}: {
  row: HistoryRow;
  lang: Language;
  t: ShellTranslations;
  attribution: string;
  portfolioName: string;
  colorOf: ColorOf;
}) {
  const [expanded, setExpanded] = useState(false);
  const typeConfig = EVENT_TYPE_CONFIG[row.type];
  const date = formatEventDate(row.timestamp, lang);
  const reason = row.reason[lang];

  // A lone chain composition edit (D-422) carries no detail: its only child line would repeat
  // the reason above it.
  const hasChildren = (row.children ?? []).some((e) => e.kind !== "composition_changed");
  const hasComposition = hasMeaningfulComposition(row.before, row.after);
  const canExpand = hasChildren || hasComposition;

  return (
    <article className="rounded-2xl glass">
      {/* Collapsed header */}
      <div className="flex items-start gap-3 px-4 py-3.5 sm:px-5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${typeConfig.badgeClass}`}
            >
              {t[typeConfig.labelKey] as string}
            </span>
            <time
              dateTime={new Date(row.timestamp).toISOString()}
              className="text-xs text-slate-400"
            >
              {date}
            </time>
          </div>
          <div className="mt-1.5 text-sm">
            {row.tokens.length > 0 ? (
              <TokenMoveSummary tokens={row.tokens} colorOf={colorOf} />
            ) : (
              <span className="text-xs text-slate-400">{reason}</span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5 pt-0.5">
          {row.attributedSpreadUsd != null && (
            <span
              className="text-[11px] font-semibold tabular-nums text-emerald-300"
              title={t.historyEventAttributedSpread}
            >
              +{formatUsd(row.attributedSpreadUsd)}
            </span>
          )}
          {canExpand && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className="text-[11px] text-slate-400 underline-offset-2 transition hover:text-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              {expanded ? t.historyEventHideDetails : t.historyEventShowDetails}
            </button>
          )}
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-slate-800 px-4 pb-5 pt-4 sm:px-5">
          {/* Reason */}
          <div className="mb-4">
            <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-slate-400">
              {t.historyEventReason}
            </p>
            <p className="text-sm leading-relaxed text-slate-300">{reason}</p>
          </div>

          {/* Attributed spread */}
          {row.attributedSpreadUsd != null && (
            <div className="mb-4 flex items-center gap-2">
              <p className="text-[10px] font-medium uppercase tracking-wider text-slate-400">
                {t.historyEventAttributedSpread}
              </p>
              <p className="text-sm font-semibold tabular-nums text-emerald-300">
                +{formatUsd(row.attributedSpreadUsd)}
              </p>
            </div>
          )}

          {/* Child events list (commit rows) */}
          {hasChildren && (
            <div className="mb-4">
              <ChildEventList events={row.children!} lang={lang} colorOf={colorOf} />
            </div>
          )}

          {/* Before / after composition */}
          {hasComposition && (
            <div className="mb-4 rounded-xl border border-slate-800 bg-card px-3 py-3">
              <CompositionTable
                before={row.before!}
                after={row.after!}
                labelBefore={t.historyEventBefore}
                labelAfter={t.historyEventAfter}
                tokenLabel={t.historyTokenColumn}
                colorOf={colorOf}
              />
            </div>
          )}

          {/* Attribution */}
          {/* A 64-hex account would run past the card at 390 px: both truncate, the name keeps up to half. */}
          <div className="flex min-w-0 items-center gap-2">
            <p className="shrink-0 text-[10px] font-medium uppercase tracking-wider text-slate-400">
              {t.historyAttribution}
            </p>
            <p className="min-w-0 truncate text-xs text-slate-400" title={attribution}>{attribution}</p>
            <span className="text-[10px] text-slate-600">·</span>
            <p className="max-w-[50%] shrink-0 truncate text-xs text-slate-400">{portfolioName}</p>
          </div>
        </div>
      )}
    </article>
  );
}

function DaySeparator({ timestamp, lang }: { timestamp: number; lang: Language }) {
  return (
    <div className="pb-2 pt-5 first:pt-0">
      <span className="text-[10px] font-medium uppercase tracking-wider text-slate-400">
        {formatDayLabel(timestamp, lang)}
      </span>
    </div>
  );
}

function groupByDay(rows: HistoryRow[]): Array<{ dayKey: string; rows: HistoryRow[] }> {
  const groups: Array<{ dayKey: string; rows: HistoryRow[] }> = [];
  let currentKey: string | null = null;
  let currentGroup: HistoryRow[] = [];

  for (const row of rows) {
    const key = new Date(row.timestamp).toDateString();
    if (key !== currentKey) {
      if (currentKey !== null) groups.push({ dayKey: currentKey, rows: currentGroup });
      currentKey = key;
      currentGroup = [row];
    } else {
      currentGroup.push(row);
    }
  }
  if (currentKey !== null && currentGroup.length > 0) {
    groups.push({ dayKey: currentKey, rows: currentGroup });
  }
  return groups;
}

function HistorySkeleton() {
  return (
    <div aria-hidden="true" className="space-y-3">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="rounded-2xl glass px-4 py-3.5 sm:px-5"
        >
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex items-center gap-2">
                <SkeletonBlock className="h-5 w-24 rounded-full" />
                <SkeletonBlock className="h-4 w-28" />
              </div>
              <div className="flex gap-2">
                <SkeletonBlock className="h-4 w-20 rounded-full" />
                <SkeletonBlock className="h-4 w-16 rounded-full" />
              </div>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-2">
              <SkeletonBlock className="h-4 w-16" />
              <SkeletonBlock className="h-3 w-20" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

const ALL_TYPES = Object.keys(EVENT_TYPE_CONFIG) as HistoryRowType[];

export function HistoryView() {
  const { activePortfolio } = usePortfolio();
  const { lang } = useLanguage();
  const { intentsAccountId } = useLoginWallet();
  const { prices, isLoading: pricesLoading } = useTokenPrices();
  const t = shellTranslations[lang];

  // The portfolio's own token colors, so a token's dot here matches its arc in Overview and
  // Composition; tokens no longer in the portfolio fall back to the symbol hash.
  const { colorByToken } = usePortfolioComputed({
    targets: activePortfolio?.targets ?? NO_TARGETS,
    effectiveCurrentPortfolioQty: activePortfolio?.deposits ?? NO_DEPOSITS,
    priceMap: prices,
  });
  const colorOf = useMemo<ColorOf>(() => {
    const bySymbol = new Map<string, string>();
    for (const [tokenId, color] of colorByToken) {
      const symbol = symbolForTokenId(tokenId);
      if (!bySymbol.has(symbol)) bySymbol.set(symbol, color.hex);
    }
    return (symbol) => bySymbol.get(symbol) ?? colorForSymbol(symbol).hex;
  }, [colorByToken]);

  const [selectedTypes, setSelectedTypes] = useState<Set<HistoryRowType>>(new Set());
  const [activeToken, setActiveToken] = useState<string>("");

  const contractVersion = useSyncExternalStore(
    mockContract.subscribe,
    mockContract.getVersion,
    mockContract.getVersion
  );

  // A real portfolio's History comes from the history database, a page at a time (028-7,
  // D-492); a mock one from the mock ledger, as before.
  const isReal = !!activePortfolio?.isReal;
  const realHistory = useRealPortfolioHistory(intentsAccountId, activePortfolio?.id ?? null, isReal);
  const moreToRead = isReal && realHistory.hasNextPage;

  const allRows = useMemo(() => {
    if (!intentsAccountId) return [];
    const events = isReal ? (realHistory.data?.events ?? []) : mockContract.getEvents(intentsAccountId);
    return toHistoryRows(events, prices);
  }, [intentsAccountId, prices, contractVersion, isReal, realHistory.data]);

  // Strict per-portfolio filter (D-337 a): account-level events (deposits, withdrawals)
  // carry no portfolioId and used to show up in every portfolio as if they were its own.
  const rows = useMemo(() => {
    if (!activePortfolio) return allRows;
    return allRows.filter((r) => r.portfolioId === activePortfolio.id);
  }, [allRows, activePortfolio]);

  // Only the types this portfolio actually has, and no chips at all for a single type: a
  // chip that can match nothing, or everything, is noise.
  const typeChips = useMemo(() => {
    const present = ALL_TYPES.filter((type) => rows.some((r) => r.type === type));
    return present.length > 1 ? present : [];
  }, [rows]);

  const availableTokens = useMemo(() => {
    const symbols = new Set<string>();
    rows.forEach((r) => r.tokens.forEach((tk) => symbols.add(tk.symbol)));
    return Array.from(symbols).sort();
  }, [rows]);

  const filteredRows = useMemo(() => {
    let result = rows;
    // Only selections with a visible chip apply: switching to a portfolio whose chips are hidden
    // must not keep filtering by a type the user can no longer see or clear.
    const activeTypes = typeChips.filter((type) => selectedTypes.has(type));
    if (activeTypes.length > 0) {
      result = result.filter((r) => activeTypes.includes(r.type));
    }
    if (activeToken) {
      result = result.filter((r) => r.tokens.some((tk) => tk.symbol === activeToken));
    }
    return result;
  }, [rows, selectedTypes, activeToken, typeChips]);

  // "Show more" (D-364 5) shows the next rows already read and, past them, reads the next page
  // (028-7). Back to the first page whenever the list itself changes — another portfolio,
  // another filter.
  const pageKey = `${activePortfolio?.id ?? ""}|${[...selectedTypes].sort().join(",")}|${activeToken}`;
  const [page, setPage] = useState({ key: pageKey, shown: ACTIVITY_PAGE_SIZE });
  const shown = page.key === pageKey ? page.shown : ACTIVITY_PAGE_SIZE;

  const dayGroups = useMemo(() => groupByDay(filteredRows.slice(0, shown)), [filteredRows, shown]);

  if (!activePortfolio) return null;

  const attribution = intentsAccountId ?? "demo.near";
  // More pages to read: what is counted is what is loaded, so it says "at least".
  const countLabel =
    filteredRows.length === 1 && !moreToRead
      ? t.historyEventsCountOne
      : t.historyEventsCount.replace("{count}", `${filteredRows.length}${moreToRead ? "+" : ""}`);
  const statusNote = !isReal
    ? null
    : realHistory.data?.loading
      ? t.historyLoadingAccount
      : realHistory.outOfDate
        ? t.historyMayBeBehind
        : null;

  function showMore() {
    setPage({ key: pageKey, shown: shown + ACTIVITY_PAGE_SIZE });
    if (moreToRead && filteredRows.length <= shown + ACTIVITY_PAGE_SIZE) void realHistory.fetchNextPage();
  }

  function toggleType(type: HistoryRowType) {
    setSelectedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  if ((pricesLoading && rows.length === 0) || (isReal && realHistory.isLoading)) {
    return (
      <section aria-label={t.subNavActivity} aria-busy="true">
        <div className="mb-6">
          <SkeletonBlock className="h-7 w-24" />
          <SkeletonBlock className="mt-2 h-4 w-48" />
        </div>
        <HistorySkeleton />
      </section>
    );
  }

  // Never an empty list on a failed read: "no movements" would be a claim about the chain.
  if (isReal && realHistory.isError) {
    return (
      <section aria-label={t.subNavActivity}>
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-slate-100">{t.subNavActivity}</h1>
          <p className="mt-1 text-sm text-slate-400">{activePortfolio.name}</p>
        </div>
        <ErrorState
          message={t.historyLoadError}
          retryLabel={t.historyLoadRetry}
          onRetry={() => void realHistory.refetch()}
        />
      </section>
    );
  }

  if (rows.length === 0) {
    return (
      <section aria-label={t.subNavActivity}>
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-slate-100">{t.subNavActivity}</h1>
          <p className="mt-1 text-sm text-slate-400">{activePortfolio.name}</p>
        </div>
        <div className="flex min-h-[40vh] items-center justify-center">
          <p role={statusNote ? "status" : undefined} className="max-w-md text-center text-sm text-slate-400">
            {statusNote ?? (isReal ? t.historyEmptyReal : t.historyEmpty)}
          </p>
        </div>
      </section>
    );
  }

  return (
    <section aria-label={t.subNavActivity} className="mx-auto max-w-3xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-slate-100">{t.subNavActivity}</h1>
        <p className="mt-1 text-sm text-slate-400">
          {activePortfolio.name}
          <span className="mx-2 text-slate-600">·</span>
          {countLabel}
        </p>
        {statusNote && (
          <p role="status" className="mt-1 text-xs text-slate-400">
            {statusNote}
          </p>
        )}
      </div>

      {/* Filter bar */}
      <div className="mb-5 flex flex-wrap items-center gap-2">
        {typeChips.length > 0 && (
          <button
            type="button"
            onClick={() => setSelectedTypes(new Set())}
            className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
              selectedTypes.size === 0
                ? "border-slate-500 bg-slate-700 text-slate-100"
                : "border-slate-700 bg-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            {t.historyFilterAll}
          </button>
        )}
        {typeChips.map((type) => {
          const cfg = EVENT_TYPE_CONFIG[type];
          const active = selectedTypes.has(type);
          return (
            <button
              key={type}
              type="button"
              onClick={() => toggleType(type)}
              className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
                active ? cfg.badgeClass : "border-slate-700 bg-transparent text-slate-400 hover:text-slate-300"
              }`}
            >
              {t[cfg.labelKey] as string}
            </button>
          );
        })}
        {availableTokens.length > 0 && (
          <select
            value={activeToken}
            onChange={(e) => setActiveToken(e.target.value)}
            className="rounded-full border border-slate-700 bg-slate-900 px-2.5 py-0.5 text-[11px] font-medium text-slate-400 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 hover:border-slate-500 hover:text-slate-200"
          >
            <option value="">{t.historyFilterAllTokens}</option>
            {availableTokens.map((sym) => (
              <option key={sym} value={sym}>
                {sym}
              </option>
            ))}
          </select>
        )}
      </div>

      {filteredRows.length === 0 && (
        <p className="py-12 text-center text-sm text-slate-400">{t.historyEmptyFiltered}</p>
      )}

      <div>
        {dayGroups.map((group, groupIdx) => (
          <div key={group.dayKey}>
            <DaySeparator
              timestamp={group.rows[0].timestamp}
              lang={lang}
            />
            <div className={`space-y-3 ${groupIdx < dayGroups.length - 1 ? "mb-0" : ""}`}>
              {group.rows.map((row) => (
                <HistoryEventCard
                  key={row.id}
                  row={row}
                  lang={lang}
                  t={t}
                  attribution={attribution}
                  portfolioName={activePortfolio.name}
                  colorOf={colorOf}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {(filteredRows.length > shown || moreToRead) && (
        <button
          type="button"
          onClick={showMore}
          disabled={realHistory.isFetchingNextPage}
          className="mt-4 w-full rounded-xl border border-slate-700 py-2 text-sm font-medium text-slate-200 transition hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-60"
        >
          {t.activityShowMore}
        </button>
      )}
    </section>
  );
}
