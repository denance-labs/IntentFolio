"use client";

import { useEffect, useId, useRef, useState } from "react";
import { BookOpen, Check, ChevronDown, Compass, Copy, ExternalLink, LogOut } from "lucide-react";
import { useLanguage } from "../context/language-context";
import { useLoginWallet, type ChainKind } from "@/features/login-wallet";
import { ChainIcon } from "@/features/market/lib/token-icons";
import { shellTranslations } from "../lib/translations";
import { LanguageToggle } from "./language-toggle";

// Same family marks as the wallet picker's family cards, so the header shows the icon the
// user clicked to sign in.
const FAMILY_ICON_CHAIN: Record<ChainKind, string> = {
  near: "near:mainnet",
  evm: "eth:1",
  solana: "sol:mainnet",
  ton: "ton:mainnet",
  stellar: "stellar:mainnet",
  tron: "tron:mainnet",
};

const FAMILY_NAME: Record<ChainKind, string> = {
  near: "NEAR",
  evm: "EVM",
  solana: "Solana",
  ton: "TON",
  stellar: "Stellar",
  tron: "Tron",
};

function formatAddress(address: string): string {
  if (address.length <= 20) return address;
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

export function WalletStatusIndicator({
  onGettingStarted,
  onConnect,
}: {
  /** Reopens the welcome of a new account (016 block 2.5). Absent ⇒ no menu item. */
  onGettingStarted?: () => void;
  /** Opens the wallet picker (019-1). Absent ⇒ nothing is shown while signed out. */
  onConnect?: () => void;
} = {}) {
  const { lang } = useLanguage();
  const { status, connection, signOut } = useLoginWallet();
  const t = shellTranslations[lang];
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  // Signed out, or a sign-in that failed: the way in. The failure itself is explained inside
  // the picker, which this reopens.
  if (status === "idle" || status === "error") {
    if (!onConnect) return null;
    return (
      <button
        type="button"
        onClick={onConnect}
        className="rounded-xl bg-cyan-500 px-3 py-1.5 text-xs font-medium text-slate-950 transition hover:bg-cyan-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
      >
        {/* D-408: signed out, this row also holds the language toggle and the guide link; at
            375 px the full label cut the wordmark. The accessible name stays the full one. */}
        <span aria-hidden="true" className="sm:hidden">
          {t.walletConnectShort}
        </span>
        <span className="sr-only sm:not-sr-only">{t.walletConnect}</span>
      </button>
    );
  }

  if (status === "restoring" || status === "connecting") {
    return (
      <button
        type="button"
        onClick={() => void signOut()}
        className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-400 transition hover:border-slate-600 hover:text-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
        aria-busy="true"
        title={t.walletSignOut}
      >
        <span
          className="h-3 w-3 rounded-full border-2 border-slate-600 border-t-cyan-300 animate-spin"
          aria-hidden="true"
        />
        <span className="hidden sm:inline">{t.walletConnecting}</span>
      </button>
    );
  }

  if (!connection) return null;

  // status === "connected"
  const { chainKind, address } = connection;
  // TON logins store the wallet's public key, not the user-facing EQ… address (see
  // LoginWalletConnection), so it must not be offered as "your address".
  const addressLabel = chainKind === "ton" ? t.walletMenuPublicKey : t.walletMenuAddress;

  function handleCopy() {
    navigator.clipboard.writeText(address).then(() => setCopied(true));
  }

  const itemClass =
    "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-slate-300 transition hover:bg-slate-800 hover:text-white focus:outline-none focus-visible:bg-slate-800 focus-visible:text-white focus-visible:ring-2 focus-visible:ring-cyan-300/60";

  return (
    <div
      ref={containerRef}
      className="relative"
      // Tabbing past the last item closes the panel instead of leaving it open behind focus.
      onBlur={(e) => {
        if (!containerRef.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-2.5 py-1.5 transition hover:border-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
      >
        <ChainIcon chainId={FAMILY_ICON_CHAIN[chainKind]} size={16} className="shrink-0" />
        <span className="sr-only">{t.walletConnected}: </span>
        <span className="max-w-[120px] truncate text-xs font-medium tracking-wide text-slate-100 sm:max-w-none">
          {formatAddress(address)}
        </span>
        <ChevronDown
          size={12}
          aria-hidden="true"
          className={`shrink-0 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      <div
        id={panelId}
        hidden={!open}
        className="absolute right-0 top-full z-50 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-slate-700 bg-slate-900 p-2 shadow-lg shadow-black/40"
      >
        <div className="flex flex-col gap-2 px-3 pb-3 pt-2">
          <div className="flex items-center gap-2">
            <ChainIcon chainId={FAMILY_ICON_CHAIN[chainKind]} size={20} className="shrink-0" />
            <span className="text-xs font-medium text-slate-400">
              {t.walletMenuFamily.replace("{family}", FAMILY_NAME[chainKind])}
            </span>
          </div>
          <div>
            <p className="text-xs text-slate-400">{addressLabel}</p>
            <p className="mt-0.5 break-all font-mono text-xs text-slate-100">{address}</p>
          </div>
          <button
            type="button"
            onClick={handleCopy}
            className="flex w-fit items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-300 transition hover:border-slate-500 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
          >
            {copied ? (
              <Check size={14} aria-hidden="true" className="text-emerald-300" />
            ) : (
              <Copy size={14} aria-hidden="true" />
            )}
            {copied ? t.walletMenuCopied : t.walletMenuCopy}
          </button>
          <span className="sr-only" role="status">
            {copied ? t.walletMenuCopied : ""}
          </span>
        </div>

        <div className="border-t border-slate-800 pt-2">
          {/* Next to the guide, not instead of it: this reopens the short welcome in the app,
              the guide is the long read in another tab (016 block 2.5). */}
          {onGettingStarted && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                // The welcome hands focus back to whatever had it when it opened; this item
                // is about to be hidden, so that must be the trigger.
                triggerRef.current?.focus();
                onGettingStarted();
              }}
              className={itemClass}
            >
              <Compass size={16} aria-hidden="true" className="shrink-0 text-slate-400" />
              {t.walletMenuGettingStarted}
            </button>
          )}
          {/* New tab: leaving the dashboard would drop an unsaved composition draft. */}
          <a href="/learn" target="_blank" rel="noopener" className={itemClass}>
            <BookOpen size={16} aria-hidden="true" className="shrink-0 text-slate-400" />
            <span className="flex-1">{t.walletMenuGuide}</span>
            <ExternalLink size={14} aria-hidden="true" className="shrink-0 text-slate-500" />
            <span className="sr-only"> ({t.opensInNewTab})</span>
          </a>
          <div className="flex items-center justify-between gap-3 px-3 py-2">
            <span className="text-sm text-slate-300">{t.languageLabel}</span>
            <LanguageToggle />
          </div>
        </div>

        <div className="mt-1 border-t border-slate-800 pt-2">
          <button type="button" onClick={() => void signOut()} className={itemClass}>
            <LogOut size={16} aria-hidden="true" className="shrink-0 text-slate-400" />
            {t.walletSignOut}
          </button>
        </div>
      </div>
    </div>
  );
}
