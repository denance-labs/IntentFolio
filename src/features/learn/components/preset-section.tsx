"use client";

import type { PresetId } from "@/content/portfolio-presets";
import { useLanguage } from "@/features/dashboard-shell/context/language-context";
import { StockIcon } from "@/features/market/lib/stock-marker";
import { MiniDonut } from "./mini-donut";
import { presetDonutsById, type PresetSlice } from "../lib/preset-donuts";
import { learnTranslations } from "../lib/translations";
import { LEARN_H2, LEARN_H3, LEARN_INTRO, LEARN_TILE } from "../lib/styles";

// Preset ids in display order; must match learnTranslations presets.items order. The stock presets
// come first, as on the landing hero (D-568); Stables and Pioneers left the guide for them.
const PRESET_ORDER: PresetId[] = [
  "techTitans",
  "nearStocks",
  "conservative",
  "balanced",
  "aggressive",
  "satoshi",
];

// A preset can hold the same ticker on several chains (USDC/USDT × representations); collapse
// the legend to unique labels so it doesn't read "USDC USDT USDC USDT".
function uniqueLabels(slices: PresetSlice[]): PresetSlice[] {
  const seen = new Set<string>();
  return slices.filter((s) => (seen.has(s.label) ? false : (seen.add(s.label), true)));
}

export function PresetSection() {
  const { lang } = useLanguage();
  const t = learnTranslations[lang].presets;

  return (
    <section id={t.id} className="scroll-mt-24">
      <h2 className={LEARN_H2}>{t.title}</h2>
      <p className={LEARN_INTRO}>{t.intro}</p>

      <ul className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {t.items.map((item, i) => {
          const slices = presetDonutsById[PRESET_ORDER[i]] ?? [];
          const legend = uniqueLabels(slices);

          return (
            <li key={item.title} className={`${LEARN_TILE} flex flex-col gap-3`}>
              <div className="flex items-center gap-4">
                <MiniDonut
                  slices={slices.map((s) => ({ pct: s.pct, color: s.color, label: s.label }))}
                  size={72}
                />
                <div className="min-w-0">
                  <h3 className={LEARN_H3}>{item.title}</h3>
                  <ul className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5">
                    {legend.map((s) => (
                      <li key={s.id} className="flex items-center gap-1 text-xs text-bone-dim">
                        <span
                          className="inline-block h-2 w-2 shrink-0 rounded-full"
                          style={{ background: s.color }}
                          aria-hidden="true"
                        />
                        {s.label}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
              <p className="text-sm leading-relaxed text-bone-dim">{item.body}</p>
            </li>
          );
        })}
      </ul>
      {/* D-569: fixed, with no country check, so the guide stays static. */}
      <p className="mt-4 flex items-center gap-2 text-sm leading-snug text-bone-dim">
        <StockIcon className="h-4 w-4 shrink-0 text-fuchsia-200" />
        {t.stocksUnavailable}
      </p>
    </section>
  );
}
