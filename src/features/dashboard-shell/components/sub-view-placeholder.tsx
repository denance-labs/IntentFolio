"use client";

import { useLanguage } from "../context/language-context";
import { shellTranslations, type ShellTranslations } from "../lib/translations";

type SubViewTitleKey = keyof Pick<
  ShellTranslations,
  "subNavComposition" | "subNavActivity" | "subNavPerformance" | "subNavSettings"
>;

type Props = {
  blockId: string;
  titleKey: SubViewTitleKey;
};

export function SubViewPlaceholder({ blockId, titleKey }: Props) {
  const { lang } = useLanguage();
  const t = shellTranslations[lang];

  return (
    <div className="flex min-h-[40vh] items-center justify-center">
      <div className="max-w-md rounded-3xl border border-slate-800 bg-surface p-8 text-center shadow-lg shadow-black/20">
        <p className="text-xs font-semibold uppercase tracking-wider text-cyan-300">{t.placeholderTitle}</p>
        <h2 className="mt-3 text-xl font-semibold text-white">{t[titleKey]}</h2>
        <p className="mt-2 text-sm text-slate-400">
          {t.placeholderBody} {blockId}.
        </p>
      </div>
    </div>
  );
}
