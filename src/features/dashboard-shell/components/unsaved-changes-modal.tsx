"use client";

import { Modal } from "@/features/portfolio-editor/components/portfolio-primitives";
import { useLanguage } from "../context/language-context";
import { shellTranslations } from "../lib/translations";

type UnsavedChangesModalProps = {
  /** 027 A-10: the changes are in the New Portfolio Draft's tab, so the body says "draft". */
  draft?: boolean;
  onDiscard: () => void;
  onClose: () => void;
};

export function UnsavedChangesModal({ draft = false, onDiscard, onClose }: UnsavedChangesModalProps) {
  const { lang } = useLanguage();
  const t = shellTranslations[lang];

  return (
    <Modal titleId="unsaved-changes-title" onClose={onClose}>
      <h2 id="unsaved-changes-title" className="mb-3 text-base font-semibold text-slate-100">
        {t.unsavedChangesTitle}
      </h2>
      <p className="mb-6 text-sm leading-relaxed text-slate-300">{draft ? t.unsavedDraftChangesBody : t.unsavedChangesBody}</p>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-300 transition hover:bg-slate-800 hover:text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          {t.cancel}
        </button>
        <button
          type="button"
          onClick={() => { onDiscard(); onClose(); }}
          className="rounded-xl bg-amber-600 px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-amber-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
        >
          {t.unsavedChangesDiscard}
        </button>
      </div>
    </Modal>
  );
}
