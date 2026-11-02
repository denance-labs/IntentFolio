"use client";

import { motion } from "framer-motion";
import type { PresetId } from "@/content/portfolio-presets";
import { useLanguage } from "@/features/dashboard-shell/context/language-context";
import { MiniDonut } from "./mini-donut";
import { presetDonutsById, type PresetSlice } from "../lib/preset-donuts";
import { learnTranslations } from "../lib/translations";

const containerVariants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08 } },
};

const cardVariants = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" as const } },
};

// Preset ids in display order; must match learnTranslations presets.items order.
const PRESET_ORDER: PresetId[] = [
  "conservative",
  "balanced",
  "aggressive",
  "stables",
  "satoshi",
  "pioneers",
];

// Stables holds the same ticker on several chains (USDC/USDT × representations); collapse
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
      <motion.h2
        className="text-2xl font-bold text-white"
        initial={{ opacity: 0, y: 12 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-80px" }}
        transition={{ duration: 0.4, ease: "easeOut" }}
      >
        {t.title}
      </motion.h2>
      <p className="mt-3 text-base text-slate-400">{t.intro}</p>

      <motion.ul
        className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
        variants={containerVariants}
        initial="hidden"
        whileInView="show"
        viewport={{ once: true, margin: "-80px" }}
      >
        {t.items.map((item, i) => {
          const slices = presetDonutsById[PRESET_ORDER[i]] ?? [];
          const legend = uniqueLabels(slices);

          return (
            <motion.li
              key={item.title}
              variants={cardVariants}
              className="flex flex-col gap-3 rounded-2xl border border-slate-800 bg-slate-900/60 p-5"
            >
              <div className="flex items-center gap-4">
                <MiniDonut
                  slices={slices.map((s) => ({ pct: s.pct, color: s.color, label: s.label }))}
                  size={72}
                />
                <div className="min-w-0">
                  <h3 className="text-base font-semibold text-white">{item.title}</h3>
                  <ul className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5">
                    {legend.map((s) => (
                      <li key={s.id} className="flex items-center gap-1 text-xs text-slate-400">
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
              <p className="text-sm leading-relaxed text-slate-400">{item.body}</p>
            </motion.li>
          );
        })}
      </motion.ul>
    </section>
  );
}
