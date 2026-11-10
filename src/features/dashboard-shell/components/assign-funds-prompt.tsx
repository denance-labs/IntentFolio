"use client";

import { useRef } from "react";
import { createPortal } from "react-dom";
import { appPortalRoot } from "@/features/world/portal-root";
import { Modal } from "@/features/portfolio-editor/components/portfolio-primitives";
import type { Language } from "@/features/portfolio-editor/types";
import { shellTranslations } from "../lib/translations";

/**
 * 029 B-23 — "you have funds to assign", offered on its own when a draft or a $0 portfolio is
 * on screen (`useAssignFundsPrompt` decides when). Both buttons answer it, and so do Escape and
 * a click outside: `onNotNow` is also the modal's close.
 */
export function AssignFundsPrompt({
  lang,
  message,
  onAssign,
  onNotNow,
}: {
  /** Passed in, not read from the shell's context: the portfolio editor shows it too. */
  lang: Language;
  /** The balance line, amount and name already in. */
  message: string;
  onAssign: () => void;
  onNotNow: () => void;
}) {
  const t = shellTranslations[lang];
  // The message, not "Assign": it opened unasked, so Enter on arrival must not start anything.
  const titleRef = useRef<HTMLHeadingElement>(null);

  // Out of the page's flow: it can open in the same commit as the portfolio editor, whose section
  // is still in its entry animation — a transformed ancestor turns `fixed` into "fixed to the
  // section", and the focus then scrolled the page half a screen down (s8, 390 px). Into the theme
  // root, not <body>, so it keeps the app's face (D-571). Only ever rendered on the client (it
  // opens from an effect), so `document` is there.
  return createPortal(
    <Modal titleId="assign-funds-prompt-title" onClose={onNotNow} initialFocusRef={titleRef}>
      <h2
        id="assign-funds-prompt-title"
        ref={titleRef}
        tabIndex={-1}
        className="text-base font-semibold leading-snug text-slate-100 focus:outline-none"
      >
        {message}
      </h2>
      <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button
          type="button"
          onClick={onNotNow}
          className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-300 transition hover:border-slate-500 hover:text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          {t.assignFundsNotNow}
        </button>
        <button
          type="button"
          onClick={onAssign}
          className="rounded-xl bg-accent px-5 py-2 text-sm font-medium text-accent-ink transition hover:bg-accent/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          {t.draftReadyConfirm}
        </button>
      </div>
    </Modal>,
    appPortalRoot()
  );
}
