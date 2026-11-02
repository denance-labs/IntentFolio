"use client";

import { useRef } from "react";
import { Modal } from "@/features/portfolio-editor/components/portfolio-primitives";
import { useLanguage } from "../context/language-context";
import { shellTranslations } from "../lib/translations";
import { OnboardingSteps } from "./onboarding-steps";

/**
 * The welcome of a new account (016 block 2.5): what IntentFolio does in four steps — the
 * first says building can come before any deposit (022-I) — and a way to start. Its line about
 * risk left in 022-E (D-456); the confirmation's "not financial advice" remains.
 * Only "Getting started" in the wallet menu opens it (022-I, D-459). Every way out — the CTA,
 * "Not now", Escape, a click outside — goes through `onClose`; the CTA then also calls
 * `onStart`.
 */
export function WelcomeModal({
  onStart,
  onDeposit,
  onClose,
  hasPortfolios,
  hasDraft = false,
}: {
  onStart: () => void;
  /** The deposit step's action (029 B-19): Add funds, or connecting first without a wallet. */
  onDeposit?: () => void;
  onClose: () => void;
  /** Reopened from the wallet menu by someone who has portfolios: not their "first" one. */
  hasPortfolios: boolean;
  /**
   * Reopened with a New Portfolio Draft saved (022-D, D-455): one draft per account, so the CTA
   * leads to it instead of offering to build. The steps stay, as information.
   */
  hasDraft?: boolean;
}) {
  const { lang } = useLanguage();
  const t = shellTranslations[lang];
  // The title, not the CTA: a screen reader starts at the top, and Enter on arrival must not
  // start anything.
  const titleRef = useRef<HTMLHeadingElement>(null);

  return (
    <Modal titleId="welcome-title" onClose={onClose} maxWidth="max-w-lg" initialFocusRef={titleRef}>
      <h2
        id="welcome-title"
        ref={titleRef}
        tabIndex={-1}
        className="text-lg font-semibold text-slate-100 focus:outline-none"
      >
        {t.welcomeTitle}
      </h2>

      <div className="mt-4">
        {/* 029 B-19: building and depositing close the welcome and run the action, like the CTA;
            steps 3 and 4 open the guide in a new tab and leave it open. */}
        <OnboardingSteps
          variant="build-first"
          firstPortfolio={!hasPortfolios}
          onBuild={() => {
            onClose();
            onStart();
          }}
          onDeposit={
            onDeposit &&
            (() => {
              onClose();
              onDeposit();
            })
          }
        />
      </div>

      <div className="mt-6 border-t border-slate-800 pt-4">
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-300 transition hover:border-slate-500 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
          >
            {t.welcomeNotNow}
          </button>
          <button
            type="button"
            onClick={() => {
              onClose();
              onStart();
            }}
            className="rounded-xl bg-cyan-500 px-5 py-2 text-sm font-medium text-slate-950 transition hover:bg-cyan-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
          >
            {hasDraft ? t.draftCardView : hasPortfolios ? t.welcomeCtaAnother : t.welcomeCta}
          </button>
        </div>
      </div>
    </Modal>
  );
}
