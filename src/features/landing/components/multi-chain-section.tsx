"use client";

import { useLanguage } from "@/features/dashboard-shell/context/language-context";
import { ChainIcon, TokenIcon } from "@/features/market/lib/token-icons";
import { landingTranslations } from "../lib/translations";
import { WORLD_H2, WORLD_LABEL, WORLD_PANEL } from "@/features/world/world";

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
  // D-580: received, held and withdrawn to Zcash, tested with real money (2026-11-13).
  { symbol: "ZEC", name: "Zcash" },
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
  { chainId: "zec:mainnet", name: "Zcash" },
  { chainId: "tron:mainnet", name: "Tron" },
] as const;

export function MultiChainSection() {
  const { lang } = useLanguage();
  const t = landingTranslations[lang].multiChain;

  return (
    <section aria-label={t.title} className="py-12 sm:py-20">
      <div className="mx-auto max-w-5xl px-6">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className={WORLD_H2}>{t.title}</h2>
          <p className="mt-4 text-[1rem] text-bone-dim sm:text-lg">{t.body}</p>
        </div>

        <div className={`${WORLD_PANEL} mt-10 p-6 sm:mt-12 sm:p-10`}>
          <p className={`${WORLD_LABEL} text-center`}>{t.assetsLabel}</p>
          <ul className="mt-4 flex flex-wrap items-center justify-center gap-4 sm:gap-5">
            {ASSETS.map((asset) => (
              <li key={asset.symbol} title={asset.name} aria-label={asset.name}>
                <span aria-hidden="true">
                  <TokenIcon symbol={asset.symbol} variant="branded" size={40} />
                </span>
              </li>
            ))}
            <li className="text-sm text-bone-dim">{t.assetsMore}</li>
          </ul>

          <div className="my-7 h-px bg-bone/10" />

          <p className={`${WORLD_LABEL} text-center`}>{t.networksLabel}</p>
          {/* Eight named networks on phones: two rows of 4 — an 8-column grid where each logo spans 2
              (with seven, the fifth started at column 2 to centre the short row; Zcash, D-580, filled
              it). From `sm` up, one flex row. */}
          <ul className="mt-4 grid grid-cols-8 justify-items-center gap-y-4 sm:flex sm:flex-wrap sm:items-center sm:justify-center sm:gap-5">
            {NETWORKS.map((network) => (
              <li key={network.chainId} className="col-span-2 flex min-w-14 flex-col items-center gap-1.5">
                <span aria-hidden="true">
                  <ChainIcon chainId={network.chainId} variant="background" size={36} />
                </span>
                <span className="text-xs leading-tight text-bone-dim">{network.name}</span>
              </li>
            ))}
          </ul>
        </div>

        <p className="mt-4 text-center text-xs text-bone-dim">{t.footnote}</p>
      </div>
    </section>
  );
}
