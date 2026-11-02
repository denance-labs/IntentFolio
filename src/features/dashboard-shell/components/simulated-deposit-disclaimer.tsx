"use client";

import { Modal } from "@/features/portfolio-editor/components/portfolio-primitives";
import { useLanguage } from "../context/language-context";
import { shellTranslations } from "../lib/translations";

export function SimulatedDepositDisclaimer({
  accountId,
  onDismiss,
}: {
  accountId: string | null;
  onDismiss: () => void;
}) {
  const { lang } = useLanguage();
  const t = shellTranslations[lang];

  function handleDismiss() {
    if (accountId && typeof window !== "undefined") {
      localStorage.setItem(`demoDisclaimerDismissed.${accountId}`, "true");
    }
    onDismiss();
  }

  return (
    <Modal titleId="demo-disclaimer-title" onClose={handleDismiss}>
      <h2
        id="demo-disclaimer-title"
        className="text-lg font-semibold text-slate-100"
      >
        {t.demoDisclaimerTitle}
      </h2>
      <p className="mt-3 text-sm leading-relaxed text-slate-300">
        {t.demoDisclaimerBody}
      </p>
      <div className="mt-6 flex justify-end">
        <button
          type="button"
          onClick={handleDismiss}
          className="rounded-xl bg-cyan-300 px-5 py-2 text-sm font-semibold text-black transition hover:bg-cyan-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
        >
          {t.demoDisclaimerDismiss}
        </button>
      </div>
    </Modal>
  );
}
