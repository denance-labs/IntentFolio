"use client";

import { useLanguage } from "@/features/dashboard-shell/context/language-context";
import { landingTranslations } from "../lib/translations";
import { WORLD_CTA, WORLD_H2 } from "@/features/world/world";
import { AppCta } from "./app-cta";

// Shared with /learn, which ends on the same call to action.
export function ClosingCta({ comingSoon = false }: { comingSoon?: boolean }) {
  const { lang } = useLanguage();
  const t = landingTranslations[lang].closingCta;
  const tSoon = landingTranslations[lang].comingSoon;

  return (
    <section aria-label={landingTranslations[lang].a11y.cta} className="py-16 sm:py-24">
      <div className="mx-auto max-w-2xl px-6 text-center">
        <h2 className={WORLD_H2}>{t.headline}</h2>
        <div className="mt-8 flex justify-center">
          <AppCta
            href="/dashboard"
            label={t.getStarted}
            comingSoon={comingSoon}
            soonBadge={tSoon.badge}
            soonSrLabel={tSoon.srLabel}
            className={`${WORLD_CTA} min-w-48`}
          />
        </div>
      </div>
    </section>
  );
}
