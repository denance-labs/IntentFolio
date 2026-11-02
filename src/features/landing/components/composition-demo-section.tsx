"use client";

import { useMemo } from "react";
import { motion } from "framer-motion";
import { useLanguage } from "@/features/dashboard-shell/context/language-context";
import { landingTranslations } from "../lib/translations";
import { buildDemoPresets } from "../lib/demo-presets";
import { PortfolioBuildDemo } from "./portfolio-build-demo";

export function CompositionDemoSection() {
  const { lang } = useLanguage();
  const t = landingTranslations[lang].compositionDemo;
  const presets = useMemo(() => buildDemoPresets(lang), [lang]);

  return (
    <section aria-label={t.title} className="py-20">
      <motion.div
        className="mx-auto max-w-5xl px-6"
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-80px" }}
        transition={{ duration: 0.5, ease: "easeOut" }}
      >
        <div className="mx-auto mb-12 max-w-2xl text-center">
          <p className="text-sm font-semibold uppercase tracking-wide text-cyan-400">{t.eyebrow}</p>
          <h2 className="mt-2 text-3xl font-bold text-white">{t.title}</h2>
          <p className="mt-4 text-base text-slate-300">{t.body}</p>
        </div>

        <div className="rounded-3xl border border-slate-800 bg-slate-900/40 p-8 sm:p-12">
          <PortfolioBuildDemo presets={presets} lang={lang} />
        </div>
      </motion.div>
    </section>
  );
}
