"use client";

import Link from "next/link";
import { ArrowRight, BookOpen } from "lucide-react";
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

export function LearnTeaserSection() {
  const { lang } = useLanguage();
  const t = landingTranslations[lang].learnTeaser;

  return (
    <section aria-label={t.title} className="py-20">
      <motion.div
        className="mx-auto max-w-4xl px-6"
        variants={sectionVariants}
        initial="hidden"
        whileInView="show"
        viewport={{ once: true, margin: "-80px" }}
      >
        <motion.div
          variants={itemVariants}
          className="flex flex-col items-start gap-5 rounded-2xl border border-slate-800 bg-slate-900/60 p-8 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex items-start gap-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-cyan-500/40 bg-cyan-500/20 text-cyan-400">
              <BookOpen size={20} aria-hidden="true" />
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-cyan-400">
                {t.eyebrow}
              </p>
              <h2 className="mt-1 text-xl font-bold text-white">{t.title}</h2>
              <p className="mt-1.5 text-sm text-slate-400">{t.body}</p>
            </div>
          </div>
          <Link
            href="/learn"
            className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl border border-slate-700 px-4 py-2.5 text-sm font-semibold text-white transition hover:border-cyan-400/60 hover:text-cyan-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
          >
            {t.cta}
            <ArrowRight size={16} aria-hidden="true" />
          </Link>
        </motion.div>
      </motion.div>
    </section>
  );
}
