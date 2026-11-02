"use client";

import { useLanguage } from "../context/language-context";
import { shellTranslations } from "../lib/translations";
import type { Language } from "@/features/portfolio-editor/types";

const LANGUAGES: Language[] = ["en", "es"];

/**
 * `compact` (022-J, D-460): one button showing the current language, which switches to the
 * other — for the header under `sm`, where the two-button group does not fit.
 */
export function LanguageToggle({ compact = false }: { compact?: boolean } = {}) {
  const { lang, setLang } = useLanguage();
  const t = shellTranslations[lang];

  if (compact) {
    const other = LANGUAGES.find((language) => language !== lang) ?? lang;
    return (
      <button
        type="button"
        onClick={() => setLang(other)}
        aria-label={`${t.languageLabel}: ${lang.toUpperCase()}`}
        className="rounded-xl bg-slate-800 p-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
      >
        <span className="block rounded-md bg-cyan-300 px-2 py-1 text-xs text-black">{lang.toUpperCase()}</span>
      </button>
    );
  }

  return (
    <div role="group" aria-label={t.languageLabel} className="flex gap-1 rounded-xl bg-slate-800 p-1">
      {LANGUAGES.map((language) => (
        <button
          key={language}
          type="button"
          aria-pressed={lang === language}
          onClick={() => setLang(language)}
          className={`rounded-md px-2 py-1 text-xs transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 ${
            lang === language ? "bg-cyan-300 text-black" : "text-slate-400 hover:text-white"
          }`}
        >
          {language.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
