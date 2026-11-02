"use client";

import { useEffect, useRef, useState } from "react";
import { useLoginWallet } from "../hooks/use-login-wallet";
import { NEAR_NETWORK_MISMATCH_ERROR } from "../adapters/near/near-bridge";
import type { ChainKind } from "../types";
import { ChainIcon, WalletIcon } from "@/features/market/lib/token-icons";

// ---------------------------------------------------------------------------
// Card definitions
// ---------------------------------------------------------------------------

type PickerCard = {
  id: string;
  label: string;
  family: ChainKind;
  chainId?: string;
};

// Top brand shortcuts — each fires selectFamily for the corresponding chain.
const BRAND_CARDS: PickerCard[] = [
  { id: "metamask", label: "MetaMask",  family: "evm" },
  { id: "phantom",  label: "Phantom",   family: "solana" },
  { id: "meteor",   label: "Meteor",    family: "near" },
];

// Family cards shown in the grid below the divider. The marks come from the
// existing, bundled @web3icons/react catalog; attribution: ATTRIBUTIONS.md #7.
const CARDS: PickerCard[] = [
  {
    id: "near",
    label: "NEAR Wallets",
    family: "near",
    chainId: "near:mainnet",
  },
  {
    id: "evm",
    label: "EVM Wallets",
    family: "evm",
    chainId: "eth:1",
  },
  {
    id: "solana",
    label: "Solana Wallets",
    family: "solana",
    chainId: "sol:mainnet",
  },
  {
    id: "ton",
    label: "TON Wallets",
    family: "ton",
    chainId: "ton:mainnet",
  },
  {
    id: "stellar",
    label: "Stellar Wallets",
    family: "stellar",
    chainId: "stellar:mainnet",
  },
  {
    id: "tron",
    label: "Tron",
    family: "tron",
    chainId: "tron:mainnet",
  },
];

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

const copy = {
  en: {
    title: "Connect Wallet",
    subtitle: "Choose your wallet to get started.",
    divider: "Web3 wallets",
    recent: "Recent",
    connecting: "Connecting…",
    errorTitle: "Connection error",
    networkMismatch: "IntentFolio runs on NEAR mainnet. Switch your NEAR wallet to mainnet and try again.",
    errorRetry: "Try again",
  },
  es: {
    title: "Conectar wallet",
    subtitle: "Elige tu wallet para empezar.",
    divider: "Wallets Web3",
    recent: "Reciente",
    connecting: "Conectando…",
    errorTitle: "Error de conexión",
    networkMismatch: "IntentFolio opera en NEAR mainnet. Cambia tu wallet NEAR a mainnet y reintenta.",
    errorRetry: "Reintentar",
  },
} as const;

// ---------------------------------------------------------------------------
// Sub-component
// ---------------------------------------------------------------------------

function WalletCard({
  card,
  onClick,
  disabled,
  showSpinner,
  showRecent,
  recentLabel,
  brandIcon,
}: {
  card: PickerCard;
  onClick: () => void;
  disabled: boolean;
  showSpinner: boolean;
  showRecent: boolean;
  recentLabel: string;
  brandIcon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`
        group relative flex w-full items-center gap-3 rounded-2xl border bg-slate-900 px-4 py-3.5
        text-left transition
        focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60
        disabled:cursor-not-allowed disabled:opacity-50
        ${disabled && !showSpinner ? "opacity-50" : ""}
        ${!disabled ? "border-slate-800 hover:border-slate-600 hover:bg-slate-800" : "border-slate-800"}
        ${showSpinner ? "border-cyan-500/40 bg-slate-800" : ""}
      `}
      aria-label={card.label}
      aria-busy={showSpinner}
    >
      {/* Icon — real wallet or network mark. */}
      {brandIcon && (
        <span className="flex h-10 w-10 shrink-0 items-center justify-center" aria-hidden="true">
          {brandIcon}
        </span>
      )}

      {/* Label */}
      <span className="flex-1 text-sm font-medium text-white">{card.label}</span>

      {/* Recent badge */}
      {showRecent && !showSpinner && (
        <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-xs font-medium text-emerald-400">
          {recentLabel}
        </span>
      )}

      {/* Spinner */}
      {showSpinner && (
        <span
          className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-slate-700 border-t-cyan-400"
          aria-hidden="true"
        />
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

type Props = {
  lang?: "en" | "es";
  /** The heading's id, for the dialog that wraps the picker to be labelled by it. */
  titleId?: string;
};

/**
 * The wallet choices, as the body of the Connect Wallet dialog (019-1, D-393). Renders nothing
 * once connected: the dialog closes itself.
 */
export function WalletPicker({ lang = "en", titleId = "wallet-picker-title" }: Props) {
  const { selectFamily, lastUsedFamily, status, error, clearError, connect, family } =
    useLoginWallet();
  const t = copy[lang];

  // The card whose spinner a retry should light up: `family` is what is actually mounted.
  const activeCardId = family ? (CARDS.find((c) => c.family === family)?.id ?? null) : null;
  const isNearMismatch = error === NEAR_NETWORK_MISMATCH_ERROR;

  const [connectingId, setConnectingId] = useState<string | null>(null);
  const prevStatusRef = useRef(status);

  // Clear spinner once the connection attempt ends (cancel → idle, or error).
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = status;
    if (prev === "connecting" && (status === "idle" || status === "error")) {
      setConnectingId(null);
    }
  }, [status]);

  // Fallback: clear spinner after 8 s in case the adapter never registers.
  useEffect(() => {
    if (connectingId === null) return;
    const timer = setTimeout(() => setConnectingId(null), 8000);
    return () => clearTimeout(timer);
  }, [connectingId]);

  const handleClick = (card: PickerCard) => {
    if (connectingId !== null) return;
    setConnectingId(card.id);
    selectFamily(card.family, { autoConnect: true });
  };

  // The button says "Try again", so it tries again. It used to only clear the banner, which
  // left the user with a control that could not do the one thing its label promised — a dead
  // retry is worse than no retry, because it reads as "I tried and nothing is wrong".
  const handleRetry = () => {
    clearError();
    setConnectingId(activeCardId);
    // Rejected by the wallet or locked at the time: retrying is exactly the right move and
    // costs one prompt. Failures that a retry cannot fix (no extension installed) simply
    // return the same message, which is now visible.
    void connect().catch(() => undefined);
  };

  // "Recent" badge: `lastUsedFamily` is a FAMILY, so only a family card can carry it.
  //
  // It used to prefer a brand card, which claimed more than the state knows: a family has
  // many brands, so `BRAND_CARDS.find(c => c.family === lastUsedFamily)` just returns the
  // first one listed for that family. Measured with the operator on 2026-08-06 (D-215): he
  // chose "Solana Wallets", connected Backpack, and the badge lit up **Phantom** — a wallet
  // he does not have installed and never picked. During a real-money run that reads as
  // "IntentFolio thinks I am on the wrong wallet", which is the last thing you want a user
  // wondering while holding funds.
  //
  // Which brand actually connected is decided inside the chain-specific modal and lives in
  // that adapter's own storage (`walletName` for solana-wallet-adapter). The neutral picker
  // never sees it, so badging a brand here cannot be made correct — only quieter.
  const recentFamilyId = lastUsedFamily
    ? (CARDS.find((c) => c.family === lastUsedFamily)?.id ?? null)
    : null;

  const isBlocked = connectingId !== null;

  if (status === "connected") return null;

  return (
    <div className="w-full max-w-sm">
      {/* Header */}
      <div className="mb-6 text-center">
        <h2
          id={titleId}
          className="text-lg font-semibold text-white"
        >
          {t.title}
        </h2>
        <p className="mt-1 text-sm text-slate-400">{t.subtitle}</p>
      </div>

      {/* Error banner */}
      {status === "error" && (
        <div
          role="alert"
          className="mb-4 flex items-start gap-3 rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3"
        >
          <span className="mt-0.5 h-4 w-4 shrink-0 text-red-400" aria-hidden="true">⚠</span>
          <div className="flex-1">
            <p className="text-sm text-red-300">
              {isNearMismatch ? t.networkMismatch : t.errorTitle}
            </p>
            {/* The adapter's own message, which this banner used to discard.
                Every family writes a specific one — "Freighter wallet not found. Install
                Freighter and reload the page.", "TronLink not available", "Wallet does not
                support signMessage" — and rendering only the generic title collapsed all of
                them into "Connection error". Found in a browser during 4.5's pre-flight,
                where it would have made every distinct failure of a real-money run look
                identical.
                Kept as a SECOND line rather than replacing the title: adapter messages are
                English-only while this component is bilingual, so the translated title still
                carries the meaning and this adds the detail. Same tension as D-224.
                The NEAR mismatch is excluded because it already has a full translated
                sentence of its own — showing both would say it twice. */}
            {!isNearMismatch && error !== null && error !== "" && (
              <p className="mt-1 break-words text-xs text-red-300/80">{error}</p>
            )}
          </div>
          <button
            type="button"
            onClick={handleRetry}
            className="shrink-0 text-xs font-medium text-red-300 underline hover:text-red-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400/50"
          >
            {t.errorRetry}
          </button>
        </div>
      )}

      {/* Brand row: MetaMask / Phantom / Meteor */}
      <div className="space-y-2">
        {BRAND_CARDS.map((card) => (
          <WalletCard
            key={card.id}
            card={card}
            onClick={() => handleClick(card)}
            disabled={isBlocked}
            showSpinner={connectingId === card.id}
            // Never on a brand card — see the `recentFamilyId` note above (D-215).
            showRecent={false}
            recentLabel={t.recent}
            brandIcon={
              <WalletIcon walletId={card.id} size={40} />
            }
          />
        ))}
      </div>

      {/* Divider */}
      <div className="my-4 flex items-center gap-3">
        <div className="h-px flex-1 bg-slate-800" />
        <span className="text-xs text-slate-400">{t.divider}</span>
        <div className="h-px flex-1 bg-slate-800" />
      </div>

      {/* 2-column family grid */}
      <div className="grid grid-cols-2 gap-3">
        {CARDS.map((card) => (
          <WalletCard
            key={card.id}
            card={card}
            onClick={() => handleClick(card)}
            disabled={isBlocked}
            showSpinner={connectingId === card.id}
            showRecent={recentFamilyId === card.id}
            recentLabel={t.recent}
            brandIcon={
              card.chainId ? <ChainIcon chainId={card.chainId} size={40} /> : undefined
            }
          />
        ))}
      </div>
    </div>
  );
}
