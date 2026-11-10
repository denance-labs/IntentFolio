"use client";

import { useLanguage } from "@/features/dashboard-shell/context/language-context";
import { landingTranslations } from "../lib/translations";
import { WORLD_H2 } from "@/features/world/world";
import { ExampleSpreadChart } from "./example-spread-chart";

export function PerformanceSection() {
  const { lang } = useLanguage();
  const t = landingTranslations[lang].performance;

  return (
    <section aria-label={t.title} className="py-12 sm:py-24">
      <div className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-10 px-6 lg:grid-cols-12">
        <div className="lg:col-span-5">
          <h2 className={WORLD_H2}>{t.title}</h2>
          <p className="mt-4 text-[1rem] text-bone-dim sm:text-lg">{t.body}</p>
        </div>

        {/* The chart carries its own "Example" mark and caption (D-561). */}
        <div className="lg:col-span-7">
          <ExampleSpreadChart copy={t.chart} />
        </div>
      </div>
    </section>
  );
}
