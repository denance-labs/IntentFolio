"use client";

import { useCallback, useMemo } from "react";
import { useTokenPrices } from "@/features/market/hooks/use-token-prices";
import { useLanguage } from "@/features/dashboard-shell/context/language-context";
import { usePortfolio } from "@/features/dashboard-shell/context/portfolio-context";
import { useLoginWallet } from "@/features/login-wallet";
import { useRealAllocateSigner } from "@/features/vault/context/real-allocate-context";
import { isLiveVaultRoute } from "@/features/vault/lib/vault-flag";
import { useMaturityCountdown } from "@/features/vault/hooks/use-maturity-countdown";
import { translations } from "../lib/translations";
import { formatCrypto } from "../lib/format";
import { useToast } from "./use-toast";
import { usePortfolioTargets } from "./use-portfolio-targets";
import { useWithdrawDialog } from "./use-withdraw-dialog";
import { usePortfolioComputed } from "./use-portfolio-computed";

export function usePortfolioEditor() {
  const { lang } = useLanguage();
  const { toast, setToast } = useToast();
  const priceState = useTokenPrices(15000);
  const { activePortfolio, realUnallocateStage } = usePortfolio();
  const { family: loginChainKind } = useLoginWallet();
  const realSigner = useRealAllocateSigner();

  // Whether a commit on this portfolio reaches the live vault instead of the mock — the
  // same predicate the router uses. Computed up here because it changes which rules the
  // validation engine applies, not just what the confirm modal renders.
  const isLiveRoute = isLiveVaultRoute({
    hasSigner: !!realSigner,
    loginChain: loginChainKind,
    isRealPortfolio: activePortfolio?.isReal,
  });

  const {
    targets,
    setTargets,
    isEditing,
    hasDraftChanges,
    pendingMarks,
    beginEdit,
    discardDraft,
    requestCommit,
    confirmCommit: confirmCommitOnly,
    cancelPreview,
    preview,
    isSigning,
    signError,
    vaultNotice,
    deposits,
    effectiveCurrentPortfolioQty,
    generalBalanceAvailable,
    updateTarget,
    updateTargetPct,
    promoteHeldTarget,
    toggleLock,
    removeTarget,
    undoRemoveTarget,
    lockAllTargets,
    unlockAllTargets,
    allocateToPortfolio,
    addTargetToken,
    unallocate,
  } = usePortfolioTargets({ lang, setToast, priceMap: priceState.prices });

  const computed = usePortfolioComputed({
    targets,
    effectiveCurrentPortfolioQty,
    priceMap: priceState.prices,
    // The vault keeps an emptied portfolio alive; the mock deletes it. A full withdrawal
    // must not be blocked by the mock's invariant.
    allowEmptyPortfolio: isLiveRoute,
    // The chain requires a token addition to carry target 0 (rule 2, verified in the
    // deployed WASM), and does NOT enforce the mock's dead-row rule. Keeping both on
    // makes adding a token to a real portfolio impossible (D-187).
    allowZeroTargetZeroBalance: isLiveRoute,
    pendingMarks
  });

  // D-314: a live withdrawal that settled closes the modal with nothing on screen to say so.
  // The toast names what came back — the amounts signed — and stays long enough to read. Only
  // on the live route: a mock unallocation is still releasing, which its own banner says.
  const confirmCommit = useCallback(async () => {
    const unallocations = preview?.summary.unallocations ?? [];
    const committed = await confirmCommitOnly();
    if (!committed || !isLiveRoute || unallocations.length === 0) return;
    setToast({
      kind: "neutral",
      // A non-breaking space keeps each "qty SYMBOL" together when it wraps at 390 px.
      text: translations[lang].unallocateSettledToast.replace(
        "{amounts}",
        unallocations.map((u) => `${formatCrypto(u.qty)}\u00a0${u.symbol}`).join(" · ")
      ),
      durationMs: 10_000,
    });
  }, [preview, confirmCommitOnly, isLiveRoute, setToast, lang]);

  const withdrawDialogHook = useWithdrawDialog({
    removeTarget,
    unallocate,
    isReal: activePortfolio?.isReal,
  });

  // Withdrawal maturity gate (007.plan Phase 2).
  // The commit is atomic: one immature token defers every leg, so the gate watches all
  // the tokens the pending withdrawal touches.
  const pendingUnallocationTokens = useMemo(
    () => (preview?.changeset.unallocations ?? []).map((u) => u.tokenId),
    [preview]
  );
  const maturity = useMaturityCountdown(
    activePortfolio?.id ?? null,
    pendingUnallocationTokens,
    isLiveRoute
  );

  return {
    lang,
    priceState,
    toast,
    setToast,
    targets,
    setTargets,
    isEditing,
    hasDraftChanges,
    pendingMarks,
    beginEdit,
    discardDraft,
    requestCommit,
    confirmCommit,
    cancelPreview,
    preview,
    isSigning,
    signError,
    vaultNotice,
    // Live-vault withdrawal state, consumed by the confirm modal.
    isLiveRoute,
    maturity,
    realUnallocateStage,
    deposits,
    effectiveCurrentPortfolioQty,
    generalBalanceAvailable,
    allocateToPortfolio,
    addTargetToken,
    updateTarget,
    updateTargetPct,
    promoteHeldTarget,
    toggleLock,
    removeTarget,
    undoRemoveTarget,
    lockAllTargets,
    unlockAllTargets,
    ...computed,
    ...withdrawDialogHook,
  };
}
