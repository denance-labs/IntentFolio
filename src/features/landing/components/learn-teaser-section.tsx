"use client";

import Link from "next/link";
import { ArrowRight, BookOpen } from "lucide-react";
import { useLanguage } from "@/features/dashboard-shell/context/language-context";
import { landingTranslations } from "../lib/translations";
import { WORLD_PANEL } from "../lib/world";

export function LearnTeaserSection() {
  const { lang } = useLanguage();
  const t = landingTranslations[lang].learnTeaser;

  return (
    <section aria-label={t.title} className="py-12 sm:py-20">
      <div className="mx-auto max-w-4xl px-6">
        <div
          className={`${WORLD_PANEL} flex flex-col items-start gap-5 p-6 sm:flex-row sm:items-center sm:justify-between sm:p-8`}
        >
          <div className="flex items-start gap-4">
            <BookOpen size={22} aria-hidden="true" className="mt-1 shrink-0 text-bone-dim" />
            <div>
              <h2 className="text-xl font-bold text-bone [font-stretch:106%] sm:text-2xl">{t.title}</h2>
              <p className="mt-1.5 text-sm text-bone-dim sm:text-[1rem]">{t.body}</p>
            </div>
          </div>
          <Link
            href="/learn"
            className="inline-flex min-h-11 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-bone/25 px-4 py-2.5 text-sm font-semibold text-bone transition hover:border-bone/50 hover:bg-bone/[0.05] focus:outline-none focus-visible:ring-2 focus-visible:ring-bone/70"
          >
            {t.cta}
            <ArrowRight size={16} aria-hidden="true" />
          </Link>
        </div>
      </div>
    </section>
  );
}
