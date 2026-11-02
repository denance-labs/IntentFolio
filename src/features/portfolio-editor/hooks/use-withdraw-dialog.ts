"use client";

import { useState } from "react";
import type { WithdrawDialogState } from "../types";
import {
  formatDecimalForInput,
  parseDecimalInput,
  sanitizeDecimalInput,
} from "../lib/decimal-input";

type Params = {
  removeTarget: (id: string) => void;
  unallocate: (tokenId: string, qty: number) => void;
  /** Mirrored live-vault portfolio (007.plan Phase 2) — changes what a full withdraw does. */
  isReal?: boolean;
};

export function useWithdrawDialog({ removeTarget, unallocate, isReal }: Params) {
  const [withdrawDialog, setWithdrawDialog] = useState<WithdrawDialogState>(null);
  const [removeEmptyDialog, setRemoveEmptyDialog] = useState<{ id: string; symbol: string; tokenId: string } | null>(null);

  function withdrawTarget(target: {
    id: string;
    tokenId: string;
    symbol: string;
    hasToken?: boolean;
    currentUsd?: number;
    currentQty?: number;
    token?: { usdPrice: number } | null;
  }) {
    if (!target.hasToken) {
      setRemoveEmptyDialog({ id: target.id, symbol: target.symbol, tokenId: target.tokenId });
      return;
    }
    const price = target.token?.usdPrice ?? 0;
    // The held quantity itself, never `currentUsd / price` (D-322, D-343): `qty × p ÷ p` does
    // not always come back to `qty`, and on a 6-decimal token the round trip truncates one base
    // unit short — 2.5 USDT at 0.99987 signed 2499999 and left 0.000001 in the portfolio.
    const maxAmount = target.currentQty ?? 0;
    if (maxAmount === 0) {
      setRemoveEmptyDialog({ id: target.id, symbol: target.symbol, tokenId: target.tokenId });
      return;
    }
    setWithdrawDialog({
      id: target.id,
      tokenId: target.tokenId,
      symbol: target.symbol,
      maxAmount,
      maxUsd: target.currentUsd || 0,
      price,
      amount: maxAmount,
      raw: formatDecimalForInput(maxAmount)
    });
  }

  function setWithdrawAmount(rawAmount: number | string) {
    setWithdrawDialog((current) => {
      if (!current) return current;
      const sanitized = sanitizeDecimalInput(String(rawAmount));
      const amount = parseDecimalInput(sanitized, current.maxAmount);
      // The field keeps what was typed; only a value ABOVE the balance is rewritten, since
      // leaving it would let the user confirm a withdrawal the vault cannot honour.
      const raw =
        amount < Number.parseFloat(sanitized) ? formatDecimalForInput(amount) : sanitized;
      return { ...current, amount, raw };
    });
  }

  function confirmWithdraw() {
    if (!withdrawDialog) return;
    // Unallocate moves the qty back to General Balance as a draft delta (signed +
    // committed on Save). A full withdraw also drops the composition target.
    //
    // Except on a live-vault portfolio (007.plan Phase 2), where dropping the target
    // would turn a pure withdrawal into a withdrawal + a `token_removals` composition
    // edit — an edit with no on-chain path in this phase, so the whole commit would be
    // refused. The target stays and the position simply goes to zero, which is exactly
    // what the vault will hold: composition intact, `qty_held` drained.
    const isFullWithdraw = withdrawDialog.amount >= withdrawDialog.maxAmount - 1e-9;
    unallocate(withdrawDialog.tokenId, withdrawDialog.amount);
    if (isFullWithdraw && !isReal) {
      removeTarget(withdrawDialog.id);
    }
    setWithdrawDialog(null);
  }

  return {
    withdrawDialog,
    setWithdrawDialog,
    withdrawTarget,
    setWithdrawAmount,
    confirmWithdraw,
    cancelWithdraw: () => setWithdrawDialog(null),
    removeEmptyDialog,
    confirmRemoveEmpty: () => {
      if (!removeEmptyDialog) return;
      removeTarget(removeEmptyDialog.id);
      setRemoveEmptyDialog(null);
    },
    cancelRemoveEmpty: () => setRemoveEmptyDialog(null),
  };
}
