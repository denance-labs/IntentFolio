"use client";

import { Coins, Wallet, Sliders, RefreshCw } from "lucide-react";
import { motion } from "framer-motion";
import { useLanguage } from "@/features/dashboard-shell/context/language-context";
import { WalletIcon } from "@/features/market/lib/token-icons";
import { landingTranslations } from "../lib/translations";

// Build first, connect and fund second (D-393): the same order as the signed-out start.
// Step 4 is the differentiator — every move aims to leave a spread (D-454) — so it gets its own
// card in the gain green of the app's history amounts, not the cyan of the other steps.
const STEP_ICONS = [Sliders, Wallet, RefreshCw, Coins] as const;
const EARN_STEP = 3;

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

const containerVariants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.1 } },
};

const cardVariants = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" as const } },
};

const cardHover = {
  whileHover: { y: -3, boxShadow: "0 8px 30px rgba(6,182,212,0.12)" },
  transition: { type: "spring" as const, stiffness: 300, damping: 25 },
};

export function HowItWorksSection() {
  const { lang } = useLanguage();
  const t = landingTranslations[lang].howItWorks;

  return (
    <section aria-label="How it works" className="py-20">
      <div className="max-w-5xl mx-auto px-6">
        <motion.h2
          className="text-3xl font-bold text-white text-center mb-12"
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.4, ease: "easeOut" as const }}
        >
          {t.title}
        </motion.h2>

        <motion.div
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6"
          variants={containerVariants}
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, margin: "-80px" }}
        >
          {t.steps.map((step, i) => {
            const Icon = STEP_ICONS[i];
            const earn = i === EARN_STEP;
            return (
              <motion.article
                key={step.number}
                variants={cardVariants}
                {...cardHover}
                className={`border rounded-2xl p-6 ${
                  earn ? "border-emerald-500/30 bg-emerald-500/[0.06]" : "border-slate-800 bg-slate-900/60"
                }`}
              >
                <div
                  className={`w-7 h-7 rounded-full border text-sm font-bold flex items-center justify-center ${
                    earn
                      ? "bg-emerald-500/20 border-emerald-500/40 text-emerald-400"
                      : "bg-cyan-500/20 border-cyan-500/40 text-cyan-400"
                  }`}
                >
                  {step.number}
                </div>
                <Icon size={24} className={`${earn ? "text-emerald-400" : "text-cyan-400"} mt-3`} aria-hidden="true" />
                <h3 className="text-white font-semibold text-base mt-3">{step.title}</h3>
                <p className="text-slate-400 text-sm mt-1">{step.body}</p>
              </motion.article>
            );
          })}
        </motion.div>

        <motion.div
          className="mt-12 flex flex-wrap items-center justify-center gap-x-6 gap-y-4"
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.4, ease: "easeOut" as const }}
        >
          <span className="text-sm font-semibold uppercase tracking-wide text-slate-400">
            {t.worksWith}
          </span>
          <ul className="flex flex-wrap items-center justify-center gap-4">
            {SUPPORTED_WALLETS.map((wallet) => (
              <li
                key={wallet.id}
                className="flex min-w-14 flex-col items-center gap-1.5 opacity-90 transition hover:scale-110 hover:opacity-100"
              >
                <span className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-lg" aria-hidden="true">
                  <WalletIcon walletId={wallet.id} size={36} />
                </span>
                <span className="text-[11px] leading-tight text-slate-400">{wallet.name}</span>
              </li>
            ))}
          </ul>
        </motion.div>
      </div>
    </section>
  );
}
