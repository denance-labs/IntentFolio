"use client";

import { useRef } from "react";
import { InfoTooltip, Modal } from "@/features/portfolio-editor/components/portfolio-primitives";
import { STOCK_HEADING_CLASS, StockChip, StockIcon, StockSlot } from "@/features/market/lib/stock-marker";
import { isStockToken, stockKind } from "@/features/market/lib/stock-tokens";
import { getTokenById } from "@/features/market/lib/token-registry";
import { translations as editorTranslations } from "@/features/portfolio-editor/lib/translations";
import { useStocksRegionBlocked } from "@/features/stocks/hooks/use-stocks-region-blocked";
import {
  portfolioPresets,
  STARTING_POINT_PRESET_ID,
  type PortfolioPreset,
  type PresetId,
  type PresetRisk,
} from "@/content/portfolio-presets";
import { useLanguage } from "../context/language-context";
import { shellTranslations, type ShellTranslations } from "../lib/translations";

// Display name / descriptor keys per preset id (5.6). The structural preset data is
// copy-free (src/content/portfolio-presets.ts); the localized labels live here.
export const PRESET_NAME_KEY: Record<PresetId, keyof ShellTranslations> = {
  conservative: "presetConservativeName",
  balanced: "presetBalancedName",
  aggressive: "presetAggressiveName",
  stables: "presetStablesName",
  satoshi: "presetSatoshiName",
  pioneers: "presetPioneersName",
  techTitans: "presetTechTitansName",
  nearStocks: "presetNearStocksName",
  aiLeaders: "presetAiLeadersName",
  everydayTech: "presetEverydayTechName",
};
const DESC_KEY: Record<PresetId, keyof ShellTranslations> = {
  conservative: "presetConservativeDesc",
  balanced: "presetBalancedDesc",
  aggressive: "presetAggressiveDesc",
  stables: "presetStablesDesc",
  satoshi: "presetSatoshiDesc",
  pioneers: "presetPioneersDesc",
  techTitans: "presetTechTitansDesc",
  nearStocks: "presetNearStocksDesc",
  aiLeaders: "presetAiLeadersDesc",
  everydayTech: "presetEverydayTechDesc",
};
// Neutral descriptor chip for presets whose name alone says little about the mix (T6).
const TAG_KEY: Partial<Record<PresetId, keyof ShellTranslations>> = {
  satoshi: "presetSatoshiTag",
  pioneers: "presetPioneersTag",
};

// Risk bar per level (021 R6): green for the two low ones, yellow for medium, orange above.
// The length carries the order too, so the bar never relies on color alone. Widths stop
// short of full: "very high" is the highest of these presets, not a ceiling.
const RISK_BAR: Record<PresetRisk, { width: string; color: string; label: keyof ShellTranslations }> = {
  veryLow: { width: "12%", color: "bg-emerald-400", label: "presetRiskVeryLow" },
  low: { width: "25%", color: "bg-emerald-400", label: "presetRiskLow" },
  medium: { width: "45%", color: "bg-amber-400", label: "presetRiskMedium" },
  high: { width: "65%", color: "bg-orange-400", label: "presetRiskHigh" },
  veryHigh: { width: "80%", color: "bg-orange-400", label: "presetRiskVeryHigh" },
};

function symbolFor(tokenId: string): string {
  return getTokenById(tokenId)?.symbol ?? tokenId;
}

// D-558: the presets holding a stock lead the chooser, in a block of their own.
const holdsStock = (preset: PortfolioPreset) => preset.slots.some((slot) => isStockToken(slot.tokenId));
const STOCK_PRESETS = portfolioPresets.filter(holdsStock);
const OTHER_PRESETS = portfolioPresets.filter((preset) => !holdsStock(preset));
// Opens on the first one: focusing a card further down would scroll the stocks away at 390 px.
const INITIAL_FOCUS_PRESET_ID = STOCK_PRESETS[0]?.id ?? STARTING_POINT_PRESET_ID;

/** D-569: whether this preset holds a stock, so it can't be started where stocks can't be bought. */
export function presetHoldsStock(presetId: PresetId): boolean {
  return STOCK_PRESETS.some((preset) => preset.id === presetId);
}

// The border color is left to each card: two of them on one element resolve by stylesheet order.
// The hover is apart so a card that can't be chosen (D-569) doesn't light up.
const CARD_CLASS =
  "flex flex-col gap-2 rounded-2xl border bg-slate-900 p-4 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60";
const CARD_HOVER_CLASS = "hover:border-accent/60 hover:bg-slate-800/60";
const CHIP_CLASS = "rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none";

export function PresetSelectionModal({
  onClose,
  onSelectPreset,
  onSelectScratch,
}: {
  onClose: () => void;
  onSelectPreset: (presetId: PresetId) => void;
  onSelectScratch: () => void;
}) {
  const { lang } = useLanguage();
  const t = shellTranslations[lang];
  const te = editorTranslations[lang];
  // Initial focus goes to a card, not the tolerance "?" above the grid: focusing that button
  // opens its tooltip over a card every time.
  const startCardRef = useRef<HTMLButtonElement>(null);
  // D-569: where stocks can't be bought, their presets go last, shown but not selectable, and the
  // chooser opens on the good starting point instead (a disabled card can't take focus).
  const regionBlocked = useStocksRegionBlocked();
  const initialFocusPresetId = regionBlocked ? STARTING_POINT_PRESET_ID : INITIAL_FOCUS_PRESET_ID;

  const presetCard = (preset: PortfolioPreset) => {
    const tagKey = TAG_KEY[preset.id];
    const isStockPreset = holdsStock(preset);
    const blockedHere = regionBlocked && isStockPreset;
    // Stable: the stocks first, each group in the preset's own order.
    const slots = [...preset.slots].sort(
      (a, b) => Number(isStockToken(b.tokenId)) - Number(isStockToken(a.tokenId))
    );
    return (
      <button
        key={preset.id}
        ref={preset.id === initialFocusPresetId ? startCardRef : undefined}
        type="button"
        disabled={blockedHere}
        onClick={() => onSelectPreset(preset.id)}
        className={`${CARD_CLASS} ${blockedHere ? "cursor-not-allowed opacity-50" : CARD_HOVER_CLASS} ${
          isStockPreset ? "border-fuchsia-300/60" : "border-slate-700"
        }`}
      >
        <span className="flex items-start justify-between gap-2">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-semibold text-slate-100">{t[PRESET_NAME_KEY[preset.id]]}</span>
            {isStockPreset ? <StockChip label={t.presetStocksChip} /> : null}
            {preset.id === STARTING_POINT_PRESET_ID ? (
              <span className={`${CHIP_CLASS} border-accent/40 bg-accent/10 text-accent`}>
                {t.presetStartingPointBadge}
              </span>
            ) : null}
            {tagKey ? <span className={`${CHIP_CLASS} border-slate-600 text-slate-300`}>{t[tagKey]}</span> : null}
          </span>
          <span className="shrink-0 pt-0.5 text-[11px] text-slate-400">
            ±{preset.tolerancePct}% {t.presetBandLabel}
          </span>
        </span>
        <RiskBar risk={preset.risk} t={t} />
        <span className="text-xs leading-snug text-slate-400">{t[DESC_KEY[preset.id]]}</span>
        <span className="mt-1 flex flex-wrap gap-1">
          {slots.map((slot) =>
            isStockToken(slot.tokenId) ? (
              <StockSlot
                key={slot.tokenId}
                symbol={symbolFor(slot.tokenId)}
                pct={slot.targetPct}
                label={stockKind(slot.tokenId) === "etf" ? te.stockChipEtf : te.stockChipStock}
              />
            ) : (
              <span
                key={slot.tokenId}
                className="rounded-md bg-slate-800 px-1.5 py-0.5 text-[11px] tabular-nums text-slate-300"
              >
                {symbolFor(slot.tokenId)} {slot.targetPct}%
              </span>
            )
          )}
        </span>
      </button>
    );
  };

  const stockSection =
    STOCK_PRESETS.length > 0 ? (
      <section aria-labelledby="preset-stocks-title" className="mt-4">
        <h3 id="preset-stocks-title" className={STOCK_HEADING_CLASS}>
          <StockIcon className="h-3.5 w-3.5 shrink-0" />
          {t.presetStocksTitle}
        </h3>
        {regionBlocked ? (
          <p className="mt-0.5 text-[11px] leading-snug text-amber-200">{te.stockRegionBlockedNote}</p>
        ) : (
          <p className="mt-0.5 text-[11px] leading-snug text-slate-400">{te.stockSectionNote}</p>
        )}
        <div className="mt-2 grid gap-3 sm:grid-cols-2">{STOCK_PRESETS.map(presetCard)}</div>
      </section>
    ) : null;

  return (
    <Modal
      titleId="preset-select-title"
      onClose={onClose}
      maxWidth="max-w-2xl"
      initialFocusRef={startCardRef}
    >
      <h2 id="preset-select-title" className="text-lg font-semibold text-slate-100">
        {t.presetSelectTitle}
      </h2>
      <p className="mt-1 text-sm text-slate-400">{t.presetSelectSubtitle}</p>
      {/* One explanation for every card's "±N% tolerance": a tooltip button cannot live
          inside the card, which is itself a button. */}
      <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-400">
        {t.presetToleranceQuestion}
        <InfoTooltip label={t.presetToleranceQuestion}>{t.presetToleranceTooltip}</InfoTooltip>
      </p>

      {regionBlocked ? null : stockSection}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {OTHER_PRESETS.map(presetCard)}

        <button
          type="button"
          onClick={onSelectScratch}
          className={`${CARD_CLASS} ${CARD_HOVER_CLASS} border-dashed border-slate-700`}
        >
          <span className="text-sm font-semibold text-slate-100">{t.presetScratchName}</span>
          <span className="text-xs leading-snug text-slate-400">{t.presetScratchDesc}</span>
        </button>
      </div>

      {regionBlocked ? stockSection : null}

      <p className="mt-4 text-xs leading-snug text-slate-400">{t.presetSelectNotAdvice}</p>

      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-300 transition hover:bg-slate-800 hover:text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          {t.cancel}
        </button>
      </div>
    </Modal>
  );
}

// The visible row is decoration; screen readers get the level as words ("Risk: medium").
// Inside a button, so no meter role: a button's children are presentational.
function RiskBar({ risk, t }: { risk: PresetRisk; t: ShellTranslations }) {
  const bar = RISK_BAR[risk];
  return (
    <span className="flex items-center gap-3" data-risk={risk}>
      <span aria-hidden="true" className="text-[10px] font-medium uppercase tracking-wider text-slate-400">
        {t.presetRiskLabel}
      </span>
      <span aria-hidden="true" className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-700/70">
        <span className={`block h-full rounded-full ${bar.color}`} style={{ width: bar.width }} />
      </span>
      <span className="sr-only">
        {t.presetRiskLabel}: {t[bar.label]}
      </span>
    </span>
  );
}
