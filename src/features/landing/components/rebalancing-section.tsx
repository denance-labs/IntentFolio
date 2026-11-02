"use client";

import Image from "next/image";
import { motion } from "framer-motion";
import { useLanguage } from "@/features/dashboard-shell/context/language-context";
import { landingTranslations } from "../lib/translations";

function BrowserFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -inset-6 -z-10 rounded-[2rem] bg-[radial-gradient(ellipse_at_center,_rgb(6_182_212_/_0.14)_0%,_transparent_70%)] blur-2xl"
      />
      <div className="overflow-hidden rounded-xl border border-slate-700/80 bg-slate-900 shadow-2xl shadow-cyan-500/10 ring-1 ring-white/10">
        <div className="flex items-center gap-1.5 border-b border-slate-700/50 bg-slate-800/60 px-3 py-3">
          <span className="h-2 w-2 rounded-full bg-red-500/80" aria-hidden="true" />
          <span className="h-2 w-2 rounded-full bg-yellow-500/80" aria-hidden="true" />
          <span className="h-2 w-2 rounded-full bg-green-500/80" aria-hidden="true" />
        </div>
        {children}
      </div>
    </div>
  );
}

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

export function RebalancingSection() {
  const { lang } = useLanguage();
  const t = landingTranslations[lang].rebalancing;

  return (
    <section aria-label={t.title} className="py-20">
      <motion.div
        className="max-w-6xl mx-auto px-6"
        variants={sectionVariants}
        initial="hidden"
        whileInView="show"
        viewport={{ once: true, margin: "-80px" }}
      >
        {/* Two-column grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
          {/* Left: screenshot */}
          <motion.div variants={itemVariants}>
            <BrowserFrame>
              <Image
                src="/landing/activity-swaps.png"
                alt="IntentFolio activity view: swaps that bring the portfolio closer to its targets, each with the spread it captured"
                width={1280}
                height={560}
                className="w-full h-auto"
              />
            </BrowserFrame>
          </motion.div>

          {/* Right: text */}
          <motion.div variants={itemVariants}>
            <h2 className="text-3xl font-bold text-white">{t.title}</h2>
            <p className="text-slate-300 text-base mt-4">{t.body}</p>
            <p className="text-cyan-400 font-medium text-base mt-4 border-l-2 border-cyan-500/50 pl-3">
              {t.closing}
            </p>
          </motion.div>
        </div>
      </motion.div>
    </section>
  );
}
