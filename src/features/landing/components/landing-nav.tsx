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
    // D-568: frosted over the graphite ground, so what scrolls under it shows through.
    <nav
      className="sticky top-0 z-50 border-b border-bone/[0.08] bg-graphite/60 backdrop-blur-md"
      aria-label={landingTranslations[lang].a11y.mainNav}
    >
      {/* D-401: under `sm` the row had a fixed minimum of 391 px (ES) — gutter, gaps, the
          wordmark and the CTA's padding all shrink there so it fits 360.
          D-563: under 360 it still ran 17 px (EN) and 35 px (ES) past a 320 px screen, so there
          the gutter, gaps and CTA padding shrink again and the wordmark drops ".app". */}
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-2 px-4 max-[359px]:px-3 sm:px-6">
        {/* Wordmark */}
        <Link
          href="/"
          aria-label={landingTranslations[lang].a11y.home}
          className="flex items-baseline gap-0 rounded-md transition hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-bone/70"
        >
          {/* D-568: the wordmark is set wide, like the name on a device. Normal width under 360 px. */}
          <span className="text-lg font-bold tracking-tight text-bone [font-stretch:118%] max-[359px]:text-[1rem] max-[359px]:[font-stretch:100%] sm:text-xl">IntentFolio</span>
          {/* Not `sm:text-base`: `base` is also a theme color, and that class would paint it near-black. */}
          <span className="text-sm text-bone-dim max-[359px]:hidden sm:text-[1rem]">.app</span>
        </Link>

        {/* Right side */}
        <div className="flex items-center gap-2 max-[359px]:gap-1.5 sm:gap-3">
          {/* Guide link — hidden on the smallest screens; the landing teaser card
              keeps the guide discoverable there. */}
          <Link
            href="/learn"
            className="hidden rounded text-sm text-bone-dim transition hover:text-bone focus:outline-none focus-visible:ring-2 focus-visible:ring-bone/70 sm:inline-flex"
          >
            {t.learn}
          </Link>

          {/* Language toggle */}
          <div
            role="group"
            data-needs-js
            aria-label={landingTranslations[lang].a11y.language}
            className="flex gap-0.5 rounded-md border border-bone/15 p-0.5"
          >
            {LANGUAGES.map((language) => (
              <button
                key={language}
                type="button"
                aria-pressed={lang === language}
                onClick={() => setLang(language)}
                // D-401: under `sm` the header ran 3 px past a 360 px screen in Spanish.
                // The `after` box stretches the touch area to 44 px tall without changing the look.
                className={`relative rounded after:absolute after:inset-x-0 after:-inset-y-2.5 after:content-[''] px-1.5 py-1 text-xs sm:px-2 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-bone/70 ${
                  lang === language
                    ? "bg-bone text-graphite font-semibold"
                    : "text-bone-dim hover:text-bone"
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
            // D-568: a bone key with a pressed lower edge, the world's one action style.
            className="inline-flex items-center whitespace-nowrap rounded-md bg-bone px-3 py-2 max-[359px]:px-2.5 sm:px-4 text-sm font-semibold text-graphite shadow-[inset_0_-3px_0_rgb(185_177_156)] transition hover:bg-[#f3eddf] focus:outline-none focus-visible:ring-2 focus-visible:ring-bone/70 focus-visible:ring-offset-2 focus-visible:ring-offset-graphite"
          />
        </div>
      </div>
    </nav>
  );
}
