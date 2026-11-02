"use client";

import { motion } from "framer-motion";
import { useLanguage } from "@/features/dashboard-shell/context/language-context";
import { landingTranslations } from "../lib/translations";
import { AppCta } from "./app-cta";

const sectionVariants = {
  hidden: { opacity: 0, y: 20 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.5, ease: "easeOut" as const, staggerChildren: 0.1 },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" as const } },
};

export function ClosingCta({ comingSoon = false }: { comingSoon?: boolean }) {
  const { lang } = useLanguage();
  const t = landingTranslations[lang].closingCta;
  const tSoon = landingTranslations[lang].comingSoon;

  return (
    <section aria-label="Call to action" className="py-20">
      <motion.div
        className="max-w-xl mx-auto px-6 text-center"
        variants={sectionVariants}
        initial="hidden"
        whileInView="show"
        viewport={{ once: true, margin: "-80px" }}
      >
        <motion.h2 variants={itemVariants} className="text-2xl font-bold text-white">
          {t.headline}
        </motion.h2>
        <motion.div variants={itemVariants} className="mt-6 flex gap-3 justify-center flex-wrap">
          <AppCta
            href="/dashboard"
            label={t.getStarted}
            comingSoon={comingSoon}
            soonBadge={tSoon.badge}
            soonSrLabel={tSoon.srLabel}
            animated
            className="inline-flex items-center rounded-xl bg-cyan-500 px-6 py-3 font-semibold text-slate-950 transition hover:bg-cyan-400 hover:shadow-[0_0_18px_0_rgba(6,182,212,0.4)] focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
          />
        </motion.div>
      </motion.div>
    </section>
  );
}
