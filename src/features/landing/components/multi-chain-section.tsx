"use client";

import { motion } from "framer-motion";
import { useLanguage } from "@/features/dashboard-shell/context/language-context";
import { ChainIcon, TokenIcon } from "@/features/market/lib/token-icons";
import { landingTranslations } from "../lib/translations";

// Conservative, verified subset. Every symbol here resolves to a real branded
// icon in token-icons.tsx, and every chainId is present in the attributed
// chain-registry (live PoA bridge catalog). Do not add entries that can't be
// verified against the registry — a missing icon renders nothing and a wrong
// chain misleads. A chain with deposits and withdrawals switched off (XRP
// Ledger, D-195) stays out even though it is still in the registry. So do TON and Stellar (D-533):
// nothing on them can be received or put in a portfolio today (GRAM and XLM have no NEAR version,
// D-396; their stables wait on the gas purchase, D-257), so listing them under "Assets you can
// hold" would promise what the app refuses. Their wallets stay in "Sign in with". Network names
// are shown under each logo (D-531); asset names feed the accessible labels.
const ASSETS = [
  { symbol: "BTC", name: "Bitcoin" },
  { symbol: "ETH", name: "Ethereum" },
  { symbol: "SOL", name: "Solana" },
  { symbol: "NEAR", name: "NEAR" },
  { symbol: "USDC", name: "USD Coin" },
  { symbol: "USDT", name: "Tether" },
  { symbol: "stNEAR", name: "Staked NEAR (Meta Pool)" },
  { symbol: "AURORA", name: "Aurora" },
] as const;

const NETWORKS = [
  { chainId: "near:mainnet", name: "NEAR" },
  { chainId: "eth:1", name: "Ethereum" },
  { chainId: "eth:8453", name: "Base" },
  { chainId: "eth:42161", name: "Arbitrum" },
  { chainId: "sol:mainnet", name: "Solana" },
  { chainId: "btc:mainnet", name: "Bitcoin" },
  { chainId: "tron:mainnet", name: "Tron" },
] as const;

const rowVariants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06 } },
};

const iconVariants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.35, ease: "easeOut" as const } },
};

export function MultiChainSection() {
  const { lang } = useLanguage();
  const t = landingTranslations[lang].multiChain;

  return (
    <section aria-label={t.title} className="py-20">
      <motion.div
        className="mx-auto max-w-5xl px-6"
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-80px" }}
        transition={{ duration: 0.5, ease: "easeOut" }}
      >
        <div className="mx-auto mb-12 max-w-2xl text-center">
          <p className="text-sm font-semibold uppercase tracking-wide text-cyan-400">{t.eyebrow}</p>
          <h2 className="mt-2 text-3xl font-bold text-white">{t.title}</h2>
          <p className="mt-4 text-base text-slate-300">{t.body}</p>
        </div>

        <div className="rounded-3xl border border-slate-800 bg-slate-900/40 p-8 sm:p-10">
          <p className="text-center text-xs font-semibold uppercase tracking-wide text-slate-400">
            {t.assetsLabel}
          </p>
          <motion.ul
            className="mt-4 flex flex-wrap items-center justify-center gap-4 sm:gap-5"
            variants={rowVariants}
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, margin: "-60px" }}
          >
            {ASSETS.map((asset) => (
              <motion.li
                key={asset.symbol}
                variants={iconVariants}
                className="transition hover:scale-110"
                title={asset.name}
                aria-label={asset.name}
              >
                <span aria-hidden="true">
                  <TokenIcon symbol={asset.symbol} variant="branded" size={40} />
                </span>
              </motion.li>
            ))}
            <motion.li variants={iconVariants} className="text-sm text-slate-400">
              {t.assetsMore}
            </motion.li>
          </motion.ul>

          <div className="my-7 h-px bg-slate-800" />

          <p className="text-center text-xs font-semibold uppercase tracking-wide text-slate-400">
            {t.networksLabel}
          </p>
          {/* Seven named networks on phones: 4 + 3, with the short row centred — an 8-column grid
              where each logo spans 2 and the fifth starts at column 2. From `sm` up, one flex row. */}
          <motion.ul
            className="mt-4 grid grid-cols-8 justify-items-center gap-y-4 sm:flex sm:flex-wrap sm:items-center sm:justify-center sm:gap-5"
            variants={rowVariants}
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, margin: "-60px" }}
          >
            {NETWORKS.map((network, i) => (
              <motion.li
                key={network.chainId}
                variants={iconVariants}
                className={`col-span-2 flex min-w-14 flex-col items-center gap-1.5 opacity-90 transition hover:scale-110 hover:opacity-100 ${
                  i === 4 ? "col-start-2" : ""
                }`}
              >
                <span aria-hidden="true">
                  <ChainIcon chainId={network.chainId} variant="background" size={36} />
                </span>
                <span className="text-[11px] leading-tight text-slate-400">{network.name}</span>
              </motion.li>
            ))}
          </motion.ul>
        </div>

        <p className="mt-4 text-center text-xs text-slate-400">{t.footnote}</p>
      </motion.div>
    </section>
  );
}
