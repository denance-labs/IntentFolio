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
      <div className="max-w-md rounded-3xl glass p-8 text-center">
        <p className="text-xs font-semibold uppercase tracking-wider text-accent">{t.placeholderTitle}</p>
        <h2 className="mt-3 text-xl font-semibold text-slate-100">{t[titleKey]}</h2>
        <p className="mt-2 text-sm text-slate-400">
          {t.placeholderBody} {blockId}.
        </p>
      </div>
    </div>
  );
}
