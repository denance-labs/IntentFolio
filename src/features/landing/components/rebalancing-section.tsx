"use client";

import Image from "next/image";
import { useLanguage } from "@/features/dashboard-shell/context/language-context";
import { landingTranslations } from "../lib/translations";
import { WORLD_H2 } from "../lib/world";

/** A neutral window around the app capture: graphite chrome, no colored glow (D-568). */
function BrowserFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-bone/[0.13] bg-graphite-raised shadow-[0_24px_48px_rgb(0_0_0/0.45)]">
      <div className="flex items-center gap-1.5 border-b border-bone/[0.08] px-3 py-3" aria-hidden="true">
        <span className="h-2 w-2 rounded-full bg-bone/20" />
        <span className="h-2 w-2 rounded-full bg-bone/20" />
        <span className="h-2 w-2 rounded-full bg-bone/20" />
      </div>
      {children}
    </div>
  );
}

export function RebalancingSection() {
  const { lang } = useLanguage();
  const t = landingTranslations[lang].rebalancing;

  return (
    <section aria-label={t.title} className="py-12 sm:py-20">
      <div className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-12 px-6 lg:grid-cols-2">
        {/* Hidden on phones: at 390 px the capture is too small to read (D-567). */}
        <div className="hidden sm:block">
          <BrowserFrame>
            <Image
              src="/landing/activity-swaps.png"
              alt={landingTranslations[lang].a11y.activityAlt}
              width={1280}
              height={560}
              className="h-auto w-full"
            />
          </BrowserFrame>
        </div>

        <div>
          <h2 className={WORLD_H2}>{t.title}</h2>
          <p className="mt-4 text-[1rem] text-bone-dim sm:text-lg">{t.body}</p>
          <p className="mt-5 text-[1rem] font-semibold text-bone sm:text-lg">{t.closing}</p>
        </div>
      </div>
    </section>
  );
}
