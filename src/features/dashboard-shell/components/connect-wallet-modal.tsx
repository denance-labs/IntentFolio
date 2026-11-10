"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { useLoginWallet, WalletPicker } from "@/features/login-wallet";
import { Modal } from "@/features/portfolio-editor/components/portfolio-primitives";
import { useLanguage } from "../context/language-context";
import { shellTranslations } from "../lib/translations";

/**
 * The wallet picker as a dialog, opened from the header's Connect Wallet (019-1, D-393).
 *
 * Choosing a family that is not the active one closes this dialog and hands over to that
 * wallet's own modal (near-connect, Reown, the Solana adapter, TonConnect…) (D-498). Three of
 * them (Solana, TON, Reown) report `idle`, not `connecting`, while their modal is up, so a
 * dialog left open behind them kept its focus trap and took Tab and Escape away from the
 * wallet's list. It used to close by accident — mounting the family remounted the whole app.
 * With the same family already active (a retry), the dialog stays: it lets go of Tab and
 * Escape while `connecting`, shows the picker's error banner and its "Try again" on failure,
 * and closes on a connection.
 */
export function ConnectWalletModal({ onClose }: { onClose: () => void }) {
  const { lang } = useLanguage();
  const { status, family } = useLoginWallet();
  const t = shellTranslations[lang];
  const openedWithFamily = useRef(family);

  useEffect(() => {
    if (status === "connected" || family !== openedWithFamily.current) onClose();
  }, [status, family, onClose]);

  return (
    <Modal titleId="connect-wallet-title" onClose={onClose} trapFocus={status !== "connecting"}>
      <div className="relative flex justify-center">
        <button
          type="button"
          onClick={onClose}
          aria-label={t.walletConnectClose}
          className="absolute -right-2 -top-2 flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-800 hover:text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <X aria-hidden="true" className="h-4 w-4" />
        </button>
        <WalletPicker lang={lang} titleId="connect-wallet-title" />
      </div>
    </Modal>
  );
}
