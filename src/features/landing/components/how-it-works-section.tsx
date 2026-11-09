"use client";

import { Coins, RefreshCw, Sliders, Wallet } from "lucide-react";
import { useLanguage } from "@/features/dashboard-shell/context/language-context";
import { WalletIcon } from "@/features/market/lib/token-icons";
import { landingTranslations } from "../lib/translations";
import { WORLD_H2, WORLD_LABEL } from "../lib/world";

// Build first, connect and fund second (D-393): the same order as the signed-out start.
// D-568: the four steps read as one track instead of four cards. Each step carries a segment of it,
// brighter as the portfolio gets closer; step 3 ends on the copper target mark (the hero's bars use
// the same mark), and step 4, the differentiator (every move aims to leave a spread, D-454), runs
// in the gain green of the app's history amounts and of the example chart further down.
// Each step keeps its icon (operator, D-568: without them the track read as a wall of text).
const STEP_ICONS = [Sliders, Wallet, RefreshCw, Coins] as const;
const EARN_STEP = 3;
const TARGET_STEP = 2;
const SEGMENT_FILL = ["bg-bone/25", "bg-bone/45", "bg-bone/75", "bg-emerald-400/80"] as const;

// Wallets a user can sign in with — one or two per supported login family
// (EVM, Solana, NEAR, TON, Stellar, Tron). Mirrors the brand shortcuts and
// family connectors in the login picker. Rendered as a trust strip, each logo with its name under it
// (D-531) because a new user doesn't recognise them all.
const SUPPORTED_WALLETS = [
  { id: "metamask", name: "MetaMask" },
  { id: "walletconnect", name: "WalletConnect" },
  { id: "phantom", name: "Phantom" },
  { id: "meteor", name: "Meteor" },
  { id: "tonkeeper", name: "Tonkeeper" },
  { id: "freighter", name: "Freighter" },
  { id: "tronlink", name: "TronLink" },
] as const;

export function HowItWorksSection() {
  const { lang } = useLanguage();
  const t = landingTranslations[lang].howItWorks;

  return (
    <section aria-label={landingTranslations[lang].a11y.howItWorks} className="py-12 sm:py-20">
      <div className="mx-auto max-w-6xl px-6">
        <h2 className={`${WORLD_H2} text-center`}>{t.title}</h2>

        {/* Each step sits in a faint bordered tile (operator: easier to tell apart), border only, no
            shadow, so the tiles stay quieter than the hero's glass panels; the track runs along their tops. */}
        <ol className="mt-8 grid grid-cols-1 gap-4 sm:mt-12 md:grid-cols-2 lg:grid-cols-4 lg:gap-5">
          {t.steps.map((step, i) => {
            const earn = i === EARN_STEP;
            const Icon = STEP_ICONS[i];
            return (
              <li
                key={step.number}
                className={`rounded-2xl border p-5 md:p-6 ${
                  earn ? "border-emerald-400/25 bg-emerald-400/[0.04]" : "border-bone/[0.1] bg-bone/[0.025]"
                }`}
              >
                <div aria-hidden="true" className="relative">
                  <div className={`h-1.5 rounded-full ${SEGMENT_FILL[i]}`} />
                  {i === TARGET_STEP ? (
                    <span className="absolute -inset-y-1 right-0 w-0.5 rounded-full bg-copper" />
                  ) : null}
                </div>
                {/* Icon beside the title, or above it in the four narrow columns of wide screens. */}
                <div className="mt-5 flex items-center gap-3 lg:flex-col lg:items-start">
                  <span
                    aria-hidden="true"
                    className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border shadow-[inset_0_1px_0_rgb(255_255_255/0.07)] ${
                      earn
                        ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
                        : "border-bone/[0.13] bg-bone/[0.06] text-bone"
                    }`}
                  >
                    <Icon size={22} strokeWidth={1.75} />
                  </span>
                  <div className="min-w-0">
                    <span className={`block text-xs font-semibold tabular-nums ${earn ? "text-emerald-400" : "text-bone-dim"}`}>
                      {step.number}
                    </span>
                    <h3 className="text-lg font-semibold leading-snug text-bone [font-stretch:104%]">{step.title}</h3>
                  </div>
                </div>
                <p className="mt-2 max-w-prose text-sm leading-relaxed text-bone-dim">{step.body}</p>
              </li>
            );
          })}
        </ol>

        <div className="mt-12 flex flex-wrap items-center justify-center gap-x-6 gap-y-4 border-t border-bone/[0.08] pt-8 sm:mt-16">
          <span className={WORLD_LABEL}>{t.worksWith}</span>
          <ul className="flex flex-wrap items-center justify-center gap-4">
            {SUPPORTED_WALLETS.map((wallet) => (
              <li key={wallet.id} className="flex min-w-14 flex-col items-center gap-1.5">
                <span className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-lg" aria-hidden="true">
                  <WalletIcon walletId={wallet.id} size={36} />
                </span>
                <span className="text-xs leading-tight text-bone-dim">{wallet.name}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
