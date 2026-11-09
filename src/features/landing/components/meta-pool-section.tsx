"use client";

import { ExternalLink } from "lucide-react";
import { useLanguage } from "@/features/dashboard-shell/context/language-context";
import { landingTranslations } from "../lib/translations";
import { WORLD_H2 } from "../lib/world";

export function MetaPoolSection() {
  const { lang } = useLanguage();
  const t = landingTranslations[lang].metaPool;

  return (
    <section aria-label={t.title} className="border-y border-bone/[0.08] bg-bone/[0.025] py-12 sm:py-20">
      <div className="mx-auto max-w-3xl px-6 text-center">
        <h2 className={WORLD_H2}>{t.title}</h2>
        <p className="mt-4 text-[1rem] text-bone-dim sm:text-lg">
          {t.body.split("Meta Pool").map((part, i, arr) =>
            i < arr.length - 1 ? (
              <span key={i}>
                {part}
                <a
                  href="https://metapool.app"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-sm font-semibold text-bone underline decoration-bone/40 underline-offset-4 transition hover:decoration-bone focus:outline-none focus-visible:ring-2 focus-visible:ring-bone/70"
                >
                  Meta Pool
                  <ExternalLink size={12} aria-hidden="true" className="ml-0.5 inline align-baseline" />
                </a>
              </span>
            ) : (
              <span key={i}>{part}</span>
            )
          )}
        </p>
        <ul className="mt-6 flex flex-wrap justify-center gap-2">
          {t.chips.map((chip) => (
            <li key={chip} className="rounded-full border border-bone/15 px-3 py-1 text-xs text-bone-dim">
              {chip}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
