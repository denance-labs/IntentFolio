"use client";

import { useEffect, useRef } from "react";
import { BookOpen, Compass } from "lucide-react";
import { useLoginWallet } from "@/features/login-wallet";
import { useLanguage } from "../context/language-context";
import { shellTranslations } from "../lib/translations";
import { HeaderLogo } from "./header-logo";
import { LanguageToggle } from "./language-toggle";
import { WalletStatusIndicator } from "./wallet-status-indicator";

const headerItemClass =
  "flex items-center gap-1.5 rounded-lg px-1.5 py-1.5 sm:px-2 text-sm text-slate-300 transition hover:text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60";

export function DashboardHeader({
  onGettingStarted,
  onConnect,
  inWalletMenuOnly = false,
}: {
  onGettingStarted?: () => void;
  onConnect?: () => void;
  /** 027 A-3: the account has (or may have) a portfolio, so the wallet menu is enough. */
  inWalletMenuOnly?: boolean;
} = {}) {
  const { status } = useLoginWallet();
  const { lang } = useLanguage();
  const t = shellTranslations[lang];
  const signedIn = status === "connected";
  // 027 A-3: an account with a portfolio has them in the wallet menu only. While the session
  // restores nobody knows whose account it is, so they wait: appearing once beats showing up
  // and leaving on every visit of someone with a portfolio.
  const hideExtras = status === "restoring" || (signedIn && inWalletMenuOnly);
  const headerRef = useRef<HTMLElement>(null);

  // The portfolio tab strip sticks right under this header (operator, s224), so it needs the
  // header's real height: it changes with the wallet indicator and the font, never hardcode it.
  useEffect(() => {
    const el = headerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const root = document.documentElement;
    const observer = new ResizeObserver(() => {
      root.style.setProperty("--dashboard-header-h", `${el.offsetHeight}px`);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--dashboard-header-h");
    };
  }, []);

  return (
    <header ref={headerRef} className="sticky top-0 z-40 border-b border-slate-800 bg-slate-950/95 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-2 px-4 py-3 sm:gap-4 sm:px-6">
        <HeaderLogo home={!signedIn} />

        {/* D-401 (b): tighter gaps under `sm`, so at 375 ES the wordmark is not cut to "IntentF…". */}
        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          {/* 022-J (D-460): the language, "Getting started" and the guide stay here with a wallet
              too — also in the wallet menu (operator s247) — until the account has a portfolio
              (027 A-3). Under `sm` with a wallet they live in the menu only: the header has no
              room for them next to the wallet. */}
          {!hideExtras && (
            <div className={signedIn ? "hidden sm:contents" : "contents"}>
              <div className="hidden sm:block">
                <LanguageToggle />
              </div>
              {!signedIn && (
                <div className="sm:hidden">
                  <LanguageToggle compact />
                </div>
              )}
              {/* Opens the welcome, with and without a wallet. Absent while the session restores:
                  until then there is no telling whose welcome it would be. */}
              {onGettingStarted && (
                <button type="button" onClick={onGettingStarted} className={headerItemClass}>
                  <Compass size={16} aria-hidden="true" className="shrink-0" />
                  <span className="sr-only sm:not-sr-only">{t.walletMenuGettingStarted}</span>
                </button>
              )}
              {/* Same link as the wallet menu's, in a new tab for the same reason: leaving would drop
                  a draft open in the editor. Icon-only and tighter under `sm`, where the wordmark
                  needs the room. */}
              <a href="/learn" target="_blank" rel="noopener" className={headerItemClass}>
                <BookOpen size={16} aria-hidden="true" className="shrink-0" />
                <span className="sr-only sm:not-sr-only">{t.walletMenuGuide}</span>
                <span className="sr-only"> ({t.opensInNewTab})</span>
              </a>
            </div>
          )}
          <WalletStatusIndicator onGettingStarted={onGettingStarted} onConnect={onConnect} />
        </div>
      </div>
    </header>
  );
}
