"use client";

import Link from "next/link";
import { useLanguage } from "@/features/dashboard-shell/context/language-context";
import { landingTranslations } from "../lib/translations";
import type { Language } from "@/features/portfolio-editor/types";
import { AppCta } from "./app-cta";

const LANGUAGES: Language[] = ["en", "es"];

export function LandingNav({ comingSoon = false }: { comingSoon?: boolean }) {
  const { lang, setLang } = useLanguage();
  const t = landingTranslations[lang].nav;
  const tSoon = landingTranslations[lang].comingSoon;

  return (
    <nav
      className="sticky top-0 z-50 backdrop-blur-md bg-slate-950/80 border-b border-slate-800/60"
      aria-label="Main navigation"
    >
      {/* D-401: under `sm` the row had a fixed minimum of 391 px (ES) — gutter, gaps, the
          wordmark and the CTA's padding all shrink there so it fits 360. */}
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-2 px-4 sm:px-6">
        {/* Wordmark */}
        <Link
          href="/"
          aria-label="IntentFolio home"
          className="flex items-baseline gap-0 rounded-lg transition hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
        >
          <span className="text-lg font-bold text-white tracking-tight sm:text-xl">IntentFolio</span>
          {/* Not `sm:text-base`: `base` is also a theme color, and that class would paint it near-black. */}
          <span className="text-sm text-slate-400 sm:text-[1rem]">.app</span>
        </Link>

        {/* Right side */}
        <div className="flex items-center gap-2 sm:gap-3">
          {/* Guide link — hidden on the smallest screens; the landing teaser card
              keeps the guide discoverable there. */}
          <Link
            href="/learn"
            className="hidden rounded text-sm text-slate-300 transition hover:text-cyan-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 sm:inline-flex"
          >
            {t.learn}
          </Link>

          {/* Language toggle */}
          <div
            role="group"
            aria-label="Language"
            className="flex gap-1 rounded-xl bg-slate-800 p-1"
          >
            {LANGUAGES.map((language) => (
              <button
                key={language}
                type="button"
                aria-pressed={lang === language}
                onClick={() => setLang(language)}
                // D-401: under `sm` the header ran 3 px past a 360 px screen in Spanish.
                className={`rounded-md px-1.5 py-1 text-xs sm:px-2 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 ${
                  lang === language
                    ? "bg-cyan-300 text-black font-semibold"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                {language.toUpperCase()}
              </button>
            ))}
          </div>

          {/* Get started */}
          <AppCta
            href="/dashboard"
            label={t.getStarted}
            comingSoon={comingSoon}
            soonBadge={tSoon.badge}
            soonSrLabel={tSoon.srLabel}
            className="inline-flex items-center whitespace-nowrap rounded-xl bg-cyan-500 px-3 py-2 sm:px-4 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
          />
        </div>
      </div>
    </nav>
  );
}
