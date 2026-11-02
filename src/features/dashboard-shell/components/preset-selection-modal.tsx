"use client";

import { useRef, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { InfoTooltip, Modal } from "@/features/portfolio-editor/components/portfolio-primitives";
import { getTokenById } from "@/features/market/lib/token-registry";
import {
  portfolioPresets,
  STARTING_POINT_PRESET_ID,
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
};
const DESC_KEY: Record<PresetId, keyof ShellTranslations> = {
  conservative: "presetConservativeDesc",
  balanced: "presetBalancedDesc",
  aggressive: "presetAggressiveDesc",
  stables: "presetStablesDesc",
  satoshi: "presetSatoshiDesc",
  pioneers: "presetPioneersDesc",
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

/** A card of the chooser: a preset, or "start from scratch". */
export type PresetChoice = PresetId | "scratch";

function symbolFor(tokenId: string): string {
  return getTokenById(tokenId)?.symbol ?? tokenId;
}

const CARD_CLASS =
  "flex flex-col gap-2 rounded-2xl border border-slate-700 bg-slate-900 p-4 text-left transition hover:border-cyan-400/60 hover:bg-slate-800/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60";
const CHIP_CLASS = "rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none";

export function PresetSelectionModal({
  onClose,
  onSelectPreset,
  onSelectScratch,
  pendingChoice = null,
}: {
  onClose: () => void;
  onSelectPreset: (presetId: PresetId) => void;
  onSelectScratch: () => void;
  /**
   * A card chosen while the balance is still being read (016 block 2.2): it shows the wait
   * and every card ignores clicks until the flow moves on. `aria-disabled`, not `disabled`,
   * so the focused card keeps focus.
   */
  pendingChoice?: PresetChoice | null;
}) {
  const { lang } = useLanguage();
  const t = shellTranslations[lang];
  // Initial focus goes to the starting-point card (Balanced, 016 block 2), not the tolerance
  // "?" above the grid: focusing that button opens its tooltip over a card every time.
  const startCardRef = useRef<HTMLButtonElement>(null);
  const waiting = pendingChoice !== null;

  const choose = (select: () => void) => () => {
    if (!waiting) select();
  };

  const checking = (choice: PresetChoice): ReactNode =>
    pendingChoice === choice ? (
      <span className="mt-1 flex items-center gap-1.5 text-[11px] text-cyan-200">
        <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />
        {t.draftCheckingBalance}
      </span>
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

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {portfolioPresets.map((preset) => {
          const tagKey = TAG_KEY[preset.id];
          return (
            <button
              key={preset.id}
              ref={preset.id === STARTING_POINT_PRESET_ID ? startCardRef : undefined}
              type="button"
              onClick={choose(() => onSelectPreset(preset.id))}
              aria-disabled={waiting}
              aria-busy={pendingChoice === preset.id}
              className={`${CARD_CLASS} ${waiting && pendingChoice !== preset.id ? "opacity-50" : ""}`}
            >
              <span className="flex items-start justify-between gap-2">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-semibold text-slate-100">{t[PRESET_NAME_KEY[preset.id]]}</span>
                  {preset.id === STARTING_POINT_PRESET_ID ? (
                    <span className={`${CHIP_CLASS} border-cyan-400/40 bg-cyan-400/10 text-cyan-200`}>
                      {t.presetStartingPointBadge}
                    </span>
                  ) : null}
                  {tagKey ? (
                    <span className={`${CHIP_CLASS} border-slate-600 text-slate-300`}>
                      {t[tagKey]}
                    </span>
                  ) : null}
                </span>
                <span className="shrink-0 pt-0.5 text-[11px] text-slate-400">
                  ±{preset.tolerancePct}% {t.presetBandLabel}
                </span>
              </span>
              <RiskBar risk={preset.risk} t={t} />
              <span className="text-xs leading-snug text-slate-400">{t[DESC_KEY[preset.id]]}</span>
              <span className="mt-1 flex flex-wrap gap-1">
                {preset.slots.map((slot) => (
                  <span
                    key={slot.tokenId}
                    className="rounded-md bg-slate-800 px-1.5 py-0.5 text-[11px] tabular-nums text-slate-300"
                  >
                    {symbolFor(slot.tokenId)} {slot.targetPct}%
                  </span>
                ))}
              </span>
              {checking(preset.id)}
            </button>
          );
        })}

        <button
          type="button"
          onClick={choose(onSelectScratch)}
          aria-disabled={waiting}
          aria-busy={pendingChoice === "scratch"}
          className={`${CARD_CLASS} border-dashed ${waiting && pendingChoice !== "scratch" ? "opacity-50" : ""}`}
        >
          <span className="text-sm font-semibold text-slate-100">{t.presetScratchName}</span>
          <span className="text-xs leading-snug text-slate-400">{t.presetScratchDesc}</span>
          {checking("scratch")}
        </button>
      </div>

      <p className="mt-4 text-xs leading-snug text-slate-400">{t.presetSelectNotAdvice}</p>

      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-300 transition hover:bg-slate-800 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
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
