"use client";

import { useLanguage } from "../context/language-context";
import { useWallet } from "../context/wallet-context";
import { shellTranslations } from "../lib/translations";

export function WalletDisconnectedOverlay() {
  const { lang } = useLanguage();
  const { signIn } = useWallet();
  const t = shellTranslations[lang];

  return (
    <div
      role="region"
      aria-labelledby="wallet-disconnected-title"
      className="flex min-h-[60vh] items-center justify-center px-6"
    >
      <div className="w-full max-w-md rounded-3xl border border-slate-800 bg-slate-900/80 p-8 text-center shadow-2xl shadow-black/30">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-cyan-300/10 text-2xl text-cyan-200">
          ◈
        </div>
        <h2 id="wallet-disconnected-title" className="mt-5 text-xl font-semibold text-white">
          {t.walletDisconnectedTitle}
        </h2>
        <p className="mt-2 text-sm text-slate-400">{t.walletDisconnectedSubcopy}</p>
        <button
          type="button"
          onClick={signIn}
          className="mt-6 w-full rounded-2xl bg-cyan-300 px-6 py-3 text-sm font-semibold text-black transition hover:bg-cyan-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
        >
          {t.walletSignIn}
        </button>
      </div>
    </div>
  );
}
