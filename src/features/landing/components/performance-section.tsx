"use client";

import Image from "next/image";
import { motion } from "framer-motion";
import { useLanguage } from "@/features/dashboard-shell/context/language-context";
import { landingTranslations } from "../lib/translations";

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

export function PerformanceSection() {
  const { lang } = useLanguage();
  const t = landingTranslations[lang].performance;

  return (
    <section aria-label="Results" className="py-24">
      <motion.div
        className="max-w-6xl mx-auto px-6"
        variants={sectionVariants}
        initial="hidden"
        whileInView="show"
        viewport={{ once: true, margin: "-80px" }}
      >
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-center">
          {/* Left: context */}
          <motion.div variants={itemVariants} className="lg:col-span-5">
            <span className="text-xs font-semibold uppercase tracking-wide text-cyan-400">
              {t.eyebrow}
            </span>
            <h2 className="text-3xl font-bold text-white mt-2">{t.title}</h2>
            <p className="text-slate-300 text-base mt-4">{t.body}</p>
          </motion.div>

          {/* Right: chart card */}
          <motion.div variants={itemVariants} className="lg:col-span-7">
            <div className="rounded-xl border border-slate-800 bg-slate-900/40 overflow-hidden">
              <Image
                src="/landing/cumulative-spread.png"
                alt="Chart of the cumulative spread a portfolio captured from its swaps over time"
                width={1184}
                height={496}
                className="w-full h-auto"
              />
            </div>
            <p className="text-xs text-slate-400 mt-2">{t.caption}</p>
          </motion.div>
        </div>
      </motion.div>
    </section>
  );
}
