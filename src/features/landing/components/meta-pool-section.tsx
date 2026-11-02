"use client";

import { ExternalLink } from "lucide-react";
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

export function MetaPoolSection() {
  const { lang } = useLanguage();
  const t = landingTranslations[lang].metaPool;

  return (
    <section
      aria-label={t.title}
      className="py-20 border-y border-slate-800/50 bg-slate-900/40"
    >
      <motion.div
        className="max-w-4xl mx-auto px-6 text-center"
        variants={sectionVariants}
        initial="hidden"
        whileInView="show"
        viewport={{ once: true, margin: "-80px" }}
      >
        <motion.h2 variants={itemVariants} className="text-3xl font-bold text-white">
          {t.title}
        </motion.h2>
        <motion.p variants={itemVariants} className="text-slate-400 text-base mt-4">
          {t.body.split("Meta Pool").map((part, i, arr) =>
            i < arr.length - 1 ? (
              <span key={i}>
                {part}
                <a
                  href="https://metapool.app"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-cyan-400 hover:text-cyan-300 inline-flex items-center gap-0.5"
                >
                  Meta Pool
                  <ExternalLink size={12} aria-hidden="true" className="inline" />
                </a>
              </span>
            ) : (
              <span key={i}>{part}</span>
            )
          )}
        </motion.p>
        <motion.div variants={itemVariants} className="mt-6 flex flex-wrap justify-center gap-2">
          {t.chips.map((chip) => (
            <span
              key={chip}
              className="rounded-full border border-slate-800 bg-slate-950/60 px-3 py-1 text-xs text-slate-300"
            >
              {chip}
            </span>
          ))}
        </motion.div>
      </motion.div>
    </section>
  );
}
