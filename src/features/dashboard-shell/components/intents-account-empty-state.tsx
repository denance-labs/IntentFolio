"use client";

import { useLanguage } from "../context/language-context";
import { shellTranslations } from "../lib/translations";
import { OnboardingSteps } from "./onboarding-steps";

export function IntentsAccountEmptyState({
  onAddFunds,
  onConnect,
  onBuildFirst,
  hasPortfolios = false,
  secondary = false,
  signedOut = false,
}: {
  onAddFunds?: () => void;
  // Signed out, the deposit step connects first (029 B-19).
  onConnect?: () => void;
  // An empty General Balance next to funded portfolios is not a new account: "start
  // building your portfolio" would be wrong for someone who already has some (D-299).
  hasPortfolios?: boolean;
  // A brand-new account can design its first portfolio before depositing (016 block 2.5).
  // Given, this is a new account's empty state (022-A, D-453): the build-first steps, with
  // building as its one button (D-450: Deposit is the summary's and step 2's).
  onBuildFirst?: () => void;
  // D-353: a New Portfolio Draft card above already leads with its own deposit button; two
  // filled accent buttons would compete, so this one steps down to the outlined style.
  secondary?: boolean;
  // 022-A (D-453): no wallet, so nothing to deposit into, and no step is marked as next.
  signedOut?: boolean;
}) {
  const { lang } = useLanguage();
  const t = shellTranslations[lang];

  return (
    <div
      data-testid="account-empty-state"
      className={onBuildFirst ? "w-full" : "flex flex-1 items-center justify-center px-4 py-16"}
    >
      {/* D-561: a new account's steps lead on their own and take the column's width, under the
          summary. The icon and a "Funding" title over "How it works" named nothing the steps do. */}
      <div className={`flex flex-col items-center gap-6 text-center ${onBuildFirst ? "" : "max-w-sm"}`}>
        {!onBuildFirst && (
          <>
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-800 text-slate-400">
              <svg
                width="32"
                height="32"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="2" y="5" width="20" height="14" rx="2" />
                <path d="M16 12a2 2 0 0 0-4 0 2 2 0 0 0 4 0z" />
                <path d="M22 9H2" />
              </svg>
            </div>
            <div className="flex flex-col gap-2">
              <h2 className="text-xl font-semibold text-slate-100">{t.myAccountTitle}</h2>
              <p className="text-sm text-slate-400">{hasPortfolios ? t.myAccountEmptyBodyWithPortfolios : t.myAccountEmptyBody}</p>
            </div>
          </>
        )}
        {onBuildFirst ? (
          <>
            <OnboardingSteps
              variant="build-first"
              current={signedOut ? undefined : 1}
              onBuild={onBuildFirst}
              onDeposit={signedOut ? onConnect : onAddFunds}
            />
            {/* D-450: building leads alone. The Deposit that used to sit beside it was the third way
                in to the same step — the summary above and step 2 of the list already have one. */}
            <button
              type="button"
              onClick={onBuildFirst}
              // D-360: where the focus lands when a discarded draft leaves for My Account.
              data-focus-landing
              className="rounded-xl bg-accent px-6 py-2.5 text-sm font-medium text-accent-ink transition hover:bg-accent/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              {t.myAccountBuild}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={onAddFunds}
            className={`rounded-xl px-6 py-2.5 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
              secondary
                ? "border border-slate-600 text-slate-100 hover:bg-slate-800"
                : "bg-accent text-accent-ink hover:bg-accent/90"
            }`}
          >
            {t.myAccountAddFunds}
          </button>
        )}
      </div>
    </div>
  );
}
