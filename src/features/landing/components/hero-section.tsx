"use client";

import Image from "next/image";
import { motion } from "framer-motion";
import { useLanguage } from "@/features/dashboard-shell/context/language-context";
import { landingTranslations } from "../lib/translations";
import { AppCta } from "./app-cta";

function BrowserFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative">
      {/* Cyan glow so the product screenshot reads as the hero focal point */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -inset-6 -z-10 rounded-[2rem] bg-[radial-gradient(ellipse_at_center,_rgb(6_182_212_/_0.18)_0%,_transparent_70%)] blur-2xl"
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

const container = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.08, delayChildren: 0.05 },
  },
};

const item = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" as const } },
};

export function HeroSection({ comingSoon }: { comingSoon: boolean }) {
  const { lang } = useLanguage();
  const t = landingTranslations[lang].hero;
  const tSoon = landingTranslations[lang].comingSoon;

  return (
    <section
      className="relative bg-[radial-gradient(ellipse_at_top_right,_rgb(6_182_212_/_0.07)_0%,_transparent_60%)]"
      aria-label="Hero"
    >
      <div className="pt-24 pb-20 max-w-6xl mx-auto px-6">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
          {/* Left column — staggered children */}
          <motion.div variants={container} initial="hidden" animate="show">
            <motion.span
              variants={item}
              className="inline-block border border-cyan-500/30 bg-cyan-500/10 text-cyan-400 text-xs font-medium rounded-full px-3 py-1"
            >
              {t.badge}
            </motion.span>
            {/* Plain h1 (no variant): it must be visible in the server HTML on first paint,
                not wait for hydration behind opacity:0. Its siblings keep the stagger. */}
            <h1 className="text-4xl sm:text-5xl font-bold tracking-tight text-white leading-tight mt-4 break-words">
              {t.headline}
            </h1>
            <motion.p variants={item} className="text-xl text-slate-300 mt-4 max-w-sm">
              {t.sub}
            </motion.p>
            <motion.p variants={item} className="text-sm text-slate-400 mt-3 max-w-md">
              {t.spreadNote}
            </motion.p>
            {/* D-532: multichain on the first screen, not halfway down the page. */}
            <motion.p variants={item} className="text-sm text-slate-400 mt-4 max-w-md">
              {t.wallets}
            </motion.p>
            <motion.div variants={item} className="mt-8 flex gap-3 flex-wrap">
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

          {/* Right column — desktop only */}
          <motion.div
            className="hidden lg:block"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: "easeOut" as const, delay: 0.2 }}
          >
            <BrowserFrame>
              <Image
                src="/landing/hero-overview.png"
                alt="IntentFolio overview: a portfolio's current mix next to its BTC, ETH and NEAR targets, with its value and how much of it is already in place"
                width={1280}
                height={940}
                priority
                className="w-full h-auto"
              />
            </BrowserFrame>
          </motion.div>

          {/* Mobile frame — below text */}
          <motion.div
            className="lg:hidden mt-8"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: "easeOut" as const, delay: 0.25 }}
          >
            <BrowserFrame>
              <Image
                src="/landing/hero-overview-mobile.png"
                alt="IntentFolio overview on mobile"
                width={390}
                height={844}
                priority
                className="w-full object-cover object-top"
                style={{ height: 320 }}
              />
            </BrowserFrame>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
