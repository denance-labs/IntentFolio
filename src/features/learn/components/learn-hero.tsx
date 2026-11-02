"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { motion } from "framer-motion";

type LearnHeroProps = {
  eyebrow: string;
  title: string;
  sub: string;
  backLabel: string;
};

export function LearnHero({ eyebrow, title, sub, backLabel }: LearnHeroProps) {
  return (
    <section aria-label={title} className="border-b border-slate-800/60 py-16">
      <motion.div
        className="mx-auto max-w-6xl px-6"
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: "easeOut" }}
      >
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm text-slate-400 transition hover:text-cyan-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 rounded"
        >
          <ArrowLeft size={14} aria-hidden="true" />
          {backLabel}
        </Link>
        <p className="mt-6 text-sm font-semibold uppercase tracking-wide text-cyan-400">
          {eyebrow}
        </p>
        <h1 className="mt-2 text-4xl font-bold tracking-tight text-white sm:text-5xl">
          {title}
        </h1>
        <p className="mt-4 max-w-2xl text-lg text-slate-400">{sub}</p>
      </motion.div>
    </section>
  );
}
