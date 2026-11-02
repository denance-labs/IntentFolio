"use client";

import { useId } from "react";
import { Check, ChevronRight, Coins, ExternalLink, RefreshCw, Sliders, Wallet } from "lucide-react";
import { useLanguage } from "../context/language-context";
import { shellTranslations } from "../lib/translations";

// Same icons as the /learn "Step by step" section and the landing's "How it works" (Coins: its
// card 04, D-454), so the dashboard, the guide and the landing read as one story.
const STEPS = {
  account: [
    { Icon: Wallet, title: "onboardingStep1Title", body: "onboardingStep1Body" },
    { Icon: Sliders, title: "onboardingStep2Title", body: "onboardingStep2Body" },
    { Icon: RefreshCw, title: "onboardingStep3Title", body: "onboardingStep3Body" },
    { Icon: Coins, title: "onboardingStep4Title", body: "onboardingStep4Body" },
  ],
  // The build-first order of D-393: the welcome (D-399) and a new account's My Account, with or
  // without a wallet (022-A, D-453), whose first button builds. The funded account with no
  // portfolio keeps deposit first: there the steps mark the deposit as done. Building says it can
  // come before the deposit only here (022-I, D-459).
  "build-first": [
    { Icon: Sliders, title: "onboardingStep2Title", body: "onboardingBuildFirstBody" },
    { Icon: Wallet, title: "onboardingStep1Title", body: "onboardingStep1Body" },
    { Icon: RefreshCw, title: "onboardingStep3Title", body: "onboardingStep3Body" },
    { Icon: Coins, title: "onboardingStep4Title", body: "onboardingStep4Body" },
  ],
} as const;

/** Where steps 3 and 4 lead in the guide (029 B-19): the section that explains each one. */
const GUIDE_HREF = {
  onboardingStep3Title: "/learn#rebalancing",
  onboardingStep4Title: "/learn#tips",
} as const;

/**
 * The four steps of a new account: deposit → build your portfolio → it moves toward its targets
 * → earn along the way. `current` is the step the user acts on next; earlier ones render as done.
 * Steps 3 and 4 are never current — they happen without the user — and step 4 stays neutral,
 * not the landing's green: here green means done (D-454). Without `current` (the welcome, 016 block
 * 2.5, and My Account signed out) the steps only describe the model: none is marked.
 *
 * 029 B-19: every step is clickable and they all look alike. Building and depositing run the
 * screen's own action (a step marked done still does: depositing again is valid); steps 3 and 4
 * open the guide's section in a new tab, like the header's Guide link, so nothing on screen is lost.
 * A step whose action the screen does not pass stays plain.
 */
export function OnboardingSteps({
  current,
  variant = "account",
  firstPortfolio = true,
  onBuild,
  onDeposit,
}: {
  current?: 1 | 2;
  variant?: keyof typeof STEPS;
  /** Every screen with these steps is about the first portfolio, except the welcome reopened by
   *  someone who already has one (022-A): the build step then drops "first". */
  firstPortfolio?: boolean;
  /** The screen's build action (its "Build" button). */
  onBuild?: () => void;
  /** The screen's deposit action (its "Add funds" button); signed out, connecting first. */
  onDeposit?: () => void;
}) {
  const { lang } = useLanguage();
  const t = shellTranslations[lang];
  // The welcome opens over My Account's empty state, which shows the steps too.
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="w-full text-left">
      <h3
        id={headingId}
        className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400"
      >
        {t.onboardingStepsLabel}
      </h3>
      <ol className="flex flex-col gap-3">
        {STEPS[variant].map(({ Icon, title: stepTitle, body }, i) => {
          const title = !firstPortfolio && stepTitle === "onboardingStep2Title" ? "onboardingStep2TitleAnother" : stepTitle;
          const step = i + 1;
          const done = current !== undefined && step < current;
          const isCurrent = step === current;
          const action =
            stepTitle === "onboardingStep2Title" ? onBuild : stepTitle === "onboardingStep1Title" ? onDeposit : undefined;
          const guideHref =
            stepTitle === "onboardingStep3Title" || stepTitle === "onboardingStep4Title" ? GUIDE_HREF[stepTitle] : undefined;
          const cardClass = `flex w-full gap-3 rounded-xl border px-4 py-3 text-left ${
            isCurrent ? "border-cyan-400/40 bg-cyan-400/5" : "border-slate-800"
          }`;
          const interactiveClass = `${cardClass} transition hover:border-slate-600 hover:bg-slate-800/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60`;
          const content = (
            <>
              <span
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                  done
                    ? "bg-emerald-400/10 text-emerald-300"
                    : isCurrent
                      ? "bg-cyan-400/15 text-cyan-300"
                      : "bg-slate-800 text-slate-400"
                }`}
              >
                {done ? <Check size={16} aria-hidden="true" /> : <Icon size={16} aria-hidden="true" />}
              </span>
              <span className="min-w-0 flex-1">
                <span
                  data-step-title
                  className={`block text-sm font-semibold ${isCurrent ? "text-white" : "text-slate-200"}`}
                >
                  <span className="mr-1.5 text-xs font-bold text-slate-400">{step}.</span>
                  {t[title]}
                  {(done || isCurrent) && (
                    <span className="sr-only"> ({done ? t.onboardingStepDone : t.onboardingStepCurrent})</span>
                  )}
                </span>
                <span className="mt-0.5 block text-sm text-slate-400">{t[body]}</span>
              </span>
            </>
          );
          return (
            <li key={title} aria-current={isCurrent ? "step" : undefined}>
              {action ? (
                <button type="button" onClick={action} className={interactiveClass}>
                  {content}
                  <ChevronRight size={16} aria-hidden="true" className="mt-2 shrink-0 text-slate-500" />
                </button>
              ) : guideHref ? (
                <a href={guideHref} target="_blank" rel="noopener" className={interactiveClass}>
                  {content}
                  <span className="sr-only"> ({t.opensInNewTab})</span>
                  <ExternalLink size={14} aria-hidden="true" className="mt-2 shrink-0 text-slate-500" />
                </a>
              ) : (
                <div className={cardClass}>{content}</div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
