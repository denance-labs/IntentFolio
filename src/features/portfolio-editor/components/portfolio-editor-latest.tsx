"use client";

import { useState, useMemo, useSyncExternalStore, useEffect } from "react";
import { Clock, TriangleAlert } from "lucide-react";
import { translations } from "../lib/translations";
import { formatTokenAmount, formatUsd, formatCrypto } from "../lib/format";
import { usePortfolioEditor } from "../hooks/use-portfolio-editor";
import { RULE_MESSAGE_KEYS } from "../lib/validation";
import { getTokenById } from "@/features/market/lib/token-registry";
import { usePortfolio } from "@/features/dashboard-shell/context/portfolio-context";
import { useLoginWallet } from "@/features/login-wallet";
import { mockContract } from "@/features/intents-account/mock-contract";
import { CompositionBars, CompositionDonuts } from "./portfolio-charts";
import { Modal, SumChip } from "./portfolio-primitives";
import { ConfirmChangesModal } from "./confirm-changes-modal";
import { PortfolioTargetsTable } from "./portfolio-targets-table";
import { AddFundsModal } from "./add-funds-modal";
import { AddTargetsModal } from "./add-targets-modal";
import { EmptyState } from "@/features/dashboard-shell/components/view-states";
import { shellTranslations } from "@/features/dashboard-shell/lib/translations";
import { AssignFundsPrompt } from "@/features/dashboard-shell/components/assign-funds-prompt";
import { useAssignFundsPrompt } from "@/features/dashboard-shell/hooks/use-assign-funds-prompt";
import { useFundableGeneralBalance } from "@/features/dashboard-shell/hooks/use-fundable-general-balance";
import { useOpenDeposit } from "@/features/dashboard-shell/context/deposit-action-context";
import { usePendingAllocates } from "@/features/vault/hooks/use-pending-allocates";
import { PortfolioSummaryPanel } from "./portfolio-summary-panel";
import type { Language } from "../types";
import { lockedSpreadPct } from "../lib/allocation";
import {
  subscribeUnconfirmedWithdrawals,
  unconfirmedWithdrawalUntil,
} from "../lib/unconfirmed-withdrawal-mark";

export function PortfolioEditorLatest() {
  const editor = usePortfolioEditor();
  const { activePortfolio, draftWasRestored, dismissRestoredDraft, relaySends, refetchPortfolios } = usePortfolio();
  const t = translations[editor.lang];
  const shellT = shellTranslations[editor.lang];
  const [addModalOpen, setAddModalOpen] = useState(false);
  // D-529: "Add tokens" only adds targets. Its rows join the draft on confirm (`addTargetToken`
  // opens one), so opening and cancelling it never starts an edit.
  const [targetsModalOpen, setTargetsModalOpen] = useState(false);
  // Save is always clickable (5.x): when the draft has blocking errors, clicking surfaces
  // them in a modal instead of leaving a silently-disabled button the user can't diagnose.
  const [saveBlockedOpen, setSaveBlockedOpen] = useState(false);

  // C1: pending unallocations for this portfolio (read-only — the timers are driven once by
  // the dashboard shell that wraps this view). The reserved funds still show in the balance
  // above; this banner explains they are being released to the General Balance.
  const { intentsAccountId } = useLoginWallet();
  const mockVersion = useSyncExternalStore(mockContract.subscribe, mockContract.getVersion, mockContract.getVersion);
  const pendingUnallocations = useMemo(() => {
    void mockVersion;
    if (!intentsAccountId || !activePortfolio) return [];
    return mockContract
      .getPendingUnallocations(intentsAccountId)
      .filter((u) => u.portfolioId === activePortfolio.id);
  }, [intentsAccountId, mockVersion, activePortfolio]);
  // Credits still on their way to this portfolio.
  const { pending: pendingAllocates } = usePendingAllocates(intentsAccountId);
  // D-326: an Add tokens to this portfolio sent and not yet seen credited. The balance above
  // does not include it yet; the strip says so, without blocking anything — a stuck record
  // (D-320) would otherwise hold the editor forever.
  const pendingTopUp =
    !!activePortfolio &&
    (pendingAllocates ?? []).some((a) => a.op === "allocate_into" && a.portfolioId === activePortfolio.id);
  const unconfirmedWithdrawal = useUnconfirmedWithdrawal(activePortfolio?.id ?? null);

  // Edit lifecycle lives in the editor hook (5.0 snapshot→draft, 5.3.1 confirm flow):
  // beginEdit seeds an ephemeral draft; Save (requestCommit) diffs it and opens the
  // signed preview; discardDraft drops it on Cancel. Composition no longer persists
  // per-keystroke and only reaches the contract through the signed changeset.
  const isEditing = editor.isEditing;
  const startEditing = editor.beginEdit;
  // On a real portfolio the Add funds modal signs the funds in right away (D-321, 013.plan
  // P5), so opening it does not start a draft.
  const openAddModal = () => {
    if (!isEditing && !editor.isLiveRoute) startEditing();
    setAddModalOpen(true);
  };
  const saveEditing = editor.requestCommit;
  const cancelEditing = editor.discardDraft;

  // 029 B-23 — a portfolio at $0 (to the cent, as its tab shows it) with funds to assign offers
  // them in a window of its own, once (`useAssignFundsPrompt`). Not while funds are already on
  // their way in or out of it, nor in the middle of an edit.
  const fundable = useFundableGeneralBalance();
  const openDeposit = useOpenDeposit();
  const assignPrompt = useAssignFundsPrompt(
    intentsAccountId,
    activePortfolio?.id ?? null,
    !!activePortfolio &&
      Math.round(editor.currentTotalUsd * 100) === 0 &&
      fundable.status === "known" &&
      fundable.fundable &&
      !pendingTopUp &&
      pendingUnallocations.length === 0 &&
      !isEditing
  );

  if (!activePortfolio) return null;

  // Validation engine (5.0): the editor's gate uses the SAME predicates as the
  // contract, so Save is disabled exactly when a commit would be rejected. Sum is
  // surfaced via SumChip; other global errors render as a summary; per-row errors
  // and warnings render inside the table.
  const validation = editor.validation;
  const sumViolation = isEditing ? validation.global.find((v) => v.code === "sum-not-100") : undefined;
  const globalErrors = isEditing
    ? validation.global.filter((v) => v.severity === "error" && v.code !== "sum-not-100")
    : [];
  const hasErrors = isEditing && validation.hasErrors;
  // Flat list of blocking errors for the Save-blocked modal: globals (incl. sum) first,
  // then per-row errors prefixed with their token symbol so each item is actionable.
  const tMap = t as Record<string, string>;
  const symbolByTokenId = new Map(editor.chartRows.map((row) => [row.tokenId, row.symbol]));
  const saveBlockers: string[] = [];
  for (const v of validation.global) {
    if (v.severity === "error") saveBlockers.push(tMap[RULE_MESSAGE_KEYS[v.code]]);
  }
  for (const [tokenId, rowViolations] of Object.entries(validation.byTokenId)) {
    for (const v of rowViolations) {
      if (v.severity !== "error") continue;
      saveBlockers.push(`${symbolByTokenId.get(tokenId) ?? tokenId}: ${tMap[RULE_MESSAGE_KEYS[v.code]]}`);
    }
  }
  const hasDeposits = editor.currentTotalUsd > 0;
  // D-174: a portfolio that HAS a declared composition must show it, funded or not.
  // Gating on money alone is what built the trap the operator hit: after withdrawing
  // everything, the panel was replaced by an empty state reading "No deposits yet" — false
  // for a portfolio that had funds and still has a strategy — and, because the "Edit"
  // button lives INSIDE this branch, `isEditing` could never become true from that screen.
  // The only way back in was "Add tokens", so seeing the composition required asking to
  // change it. The vault deliberately keeps an emptied portfolio alive with its targets
  // intact (D-R15); the UI now renders that state instead of denying it.
  const hasComposition = editor.chartRows.length > 0;
  // The editing surface must also survive a draft that empties the portfolio. `hasDeposits`
  // reads the EFFECTIVE value (committed balances + draft deltas), so staging a full
  // withdrawal drops it to zero — and unmounting the block below would take the Save
  // button with it, stranding a draft the user can neither see nor confirm. Reachable in
  // the mock too; it became the default path once a full withdrawal on a live-vault
  // portfolio stopped removing the target (D-R11).
  const showComposition = hasDeposits || isEditing || hasComposition;
  // A funded portfolio holding a single asset has nothing to converge to — surface that
  // instead of the "automatically rebalanced" status, which would read as contradictory.
  const singleAsset = hasDeposits && editor.chartRows.length === 1;

  return (
    <section
      className="w-full"
      style={{ animation: "sectionIn 360ms cubic-bezier(.2,.8,.2,1)" }}
    >
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-3xl border border-slate-800 bg-surface px-6 py-5 shadow-lg shadow-black/20">
        <div>
          <p className="text-xs font-medium uppercase text-slate-400">{t.totalCurrent}</p>
          <p className="mt-3 text-3xl font-semibold tracking-tight text-white tabular-nums">{formatUsd(editor.currentTotalUsd)}</p>
          {editor.priceState.error ? <p className="mt-2 text-xs text-amber-200">{t.priceStatusFallback}</p> : null}
        </div>
        <button
          type="button"
          onClick={openAddModal}
          className="rounded-2xl border border-cyan-300/30 bg-cyan-300/10 px-4 py-3 text-sm font-medium text-cyan-200 transition hover:bg-cyan-300/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
        >
          {t.addFundsButton}
        </button>
        <div className="w-full">
          <p className="mb-2 text-xs font-medium uppercase text-slate-400">{t.holdings}</p>
          {/* 027 A-9a: deleting moved to the tab menu; an empty portfolio says so here. */}
          <PortfolioSummaryPanel
            rows={editor.chartRows}
            colorByToken={editor.colorByToken}
            emptyLabel={t.holdingsEmpty}
          />
        </div>
        {hasDeposits && !singleAsset ? (
          <div className="mt-3 flex w-full items-center gap-2 border-t border-slate-800/60 pt-3 text-xs text-emerald-400/70">
            <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-40" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
            <span>{t.managedStatus}</span>
          </div>
        ) : null}
      </div>

      {unconfirmedWithdrawal ? (
        <div
          role="status"
          className="mb-6 flex items-start gap-2.5 rounded-2xl border border-amber-400/40 bg-amber-400/5 px-4 py-3"
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
          <p className="text-sm text-amber-200">{t.unconfirmedWithdrawalStrip}</p>
        </div>
      ) : null}

      {pendingTopUp ? (
        <div
          role="status"
          className="mb-6 flex items-start gap-2.5 rounded-2xl border border-cyan-300/25 bg-cyan-300/5 px-4 py-3"
        >
          <Clock aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" />
          <p className="text-sm text-cyan-100">{t.pendingTopUpStrip}</p>
        </div>
      ) : null}

      {/* C1: a Portfolio Commit applies composition + allocations atomically, but each
          unallocation settles asynchronously (the reserved funds leave for the General Balance
          a few seconds later). This banner makes the in-flight leg legible while the balance
          above still shows the reserved qty. FAILED (rare) means the leg reverted — the funds
          stayed in this portfolio and the user can retry. */}
      {pendingUnallocations.length > 0 ? (
        <div className="mb-6 flex flex-col gap-2">
          {pendingUnallocations.map((u) => {
            const failed = u.status === "FAILED";
            const symbol = getTokenById(u.tokenId)?.symbol ?? u.tokenId;
            return (
              <div
                key={u.unallocationId}
                role="status"
                className={`flex items-center gap-2.5 rounded-2xl border px-4 py-3 ${failed ? "border-red-400/30 bg-red-400/5" : "border-cyan-300/25 bg-cyan-300/5"}`}
              >
                {failed ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0 text-red-300">
                    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                    <line x1="12" y1="9" x2="12" y2="13" />
                    <line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                ) : (
                  <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden="true">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-300 opacity-50" />
                    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-cyan-400" />
                  </span>
                )}
                <p className={`text-sm ${failed ? "text-red-100" : "text-cyan-100"}`}>
                  {failed ? shellT.unallocationStatusFailed : shellT.unallocationReleasingTitle}{" "}
                  <span className="font-medium tabular-nums">{formatCrypto(u.qty)} {symbol}</span>
                  {" — "}
                  {failed ? shellT.unallocationFailedNote : shellT.unallocationArriving}
                </p>
              </div>
            );
          })}
        </div>
      ) : null}

      {singleAsset ? (
        <div
          role="status"
          className="mb-6 flex items-start gap-2 rounded-2xl border border-amber-300/30 bg-amber-300/5 px-4 py-3"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="mt-0.5 shrink-0 text-amber-300">
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <p className="text-sm text-amber-100">{t.singleAssetMessage}</p>
        </div>
      ) : null}

      {/* Return prompt (5.4-B2): non-blocking banner shown when this load's draft was
          restored from storage. The work is already live in edit mode — the user only
          chooses to keep it or discard it. */}
      {isEditing && draftWasRestored ? (
        <div
          role="status"
          className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-300/30 bg-amber-300/5 px-4 py-3"
        >
          <p className="text-sm text-amber-100">{t.draftRestoredMessage}</p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={dismissRestoredDraft}
              className="rounded-xl border border-amber-300/40 bg-amber-300/10 px-3 py-1.5 text-sm font-medium text-amber-100 transition hover:bg-amber-300/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/60"
            >
              {t.draftRestoredKeep}
            </button>
            <button
              type="button"
              onClick={cancelEditing}
              className="rounded-xl px-3 py-1.5 text-sm font-medium text-slate-400 transition hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500/60"
            >
              {t.draftRestoredDiscard}
            </button>
          </div>
        </div>
      ) : null}

      {/* Edit-mode banner: persistent "your changes aren't live yet" reminder while a draft
          is open. Calm cyan styling distinguishes it from the amber restored-draft prompt
          above; suppressed while that prompt is showing to avoid two stacked banners. */}
      {isEditing && !draftWasRestored ? (
        <div
          role="status"
          className="mb-6 flex items-center gap-2.5 rounded-2xl border border-cyan-300/25 bg-cyan-300/5 px-4 py-3"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0 text-cyan-300">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </svg>
          <p className="text-sm text-cyan-100">{t.editModeBanner}</p>
        </div>
      ) : null}

      {showComposition ? (
        <>
          <div className="mt-4 grid gap-5 lg:grid-cols-2">
            <CompositionBars rows={editor.chartRows} currentTotalUsd={editor.currentTotalUsd} targetTotalUsd={editor.targetTotalUsd} colorByToken={editor.colorByToken} t={t} />
            <div className="rounded-2xl border border-slate-800 bg-surface p-4">
              <CompositionDonuts rows={editor.chartRows} currentTotalUsd={editor.currentTotalUsd} targetTotalUsd={editor.targetTotalUsd} colorByToken={editor.colorByToken} t={t} />
            </div>
          </div>

          {/* D-452: this row only holds something while editing. Read-only, it used to keep its
              20 px floor and margin anyway, leaving ~50 px between the donuts and the table;
              now the gap is the table's own margin plus 8 px — the 20 px the grid above uses. */}
          <div
            className={
              isEditing && editor.computedTargets.length > 0
                ? "mt-5 flex min-h-[20px] flex-wrap items-center justify-between gap-3"
                : "mt-2"
            }
          >
            {isEditing && editor.computedTargets.length > 0 ? (
              <>
                {sumViolation ? <SumChip totalPct={editor.targetTotalPct} t={t} /> : <span />}
                <span className="flex items-center gap-1.5 text-[11px] text-slate-400">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="4" y="11" width="16" height="9" rx="2" />
                    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                  </svg>
                  {t.lockHint}
                </span>
              </>
            ) : null}
          </div>

          {globalErrors.length > 0 ? (
            <div role="alert" className="mt-2 rounded-xl border border-rose-400/40 bg-rose-400/5 px-3 py-2">
              {globalErrors.map((v) => (
                <p key={v.code} className="text-[12px] leading-tight text-rose-200">{(t as Record<string, string>)[RULE_MESSAGE_KEYS[v.code]]}</p>
              ))}
            </div>
          ) : null}

          <PortfolioTargetsTable
            t={t}
            rows={editor.chartRows}
            colorByToken={editor.colorByToken}
            isEditing={isEditing}
            allLocked={editor.allLocked}
            allUnlocked={editor.allUnlocked}
            rowViolations={validation.byTokenId}
            pending={editor.pendingMarks}
            onUndoRemove={editor.undoRemoveTarget}
            onUpdateTarget={editor.updateTarget}
            onUpdateTargetPct={editor.updateTargetPct}
            onPromoteHeld={editor.promoteHeldTarget}
            onToggleLock={editor.toggleLock}
            onLockAll={editor.lockAllTargets}
            onUnlockAll={editor.unlockAllTargets}
            // Same lift as "+ add target" above: the Remove button is offered in READ mode
            // too, but everything it does (drop the row, queue an unallocation) is a draft
            // mutation — with no draft open the dialog confirmed, the row came back, and
            // there was nothing to Save. A destructive action that appears to work and
            // silently does nothing is worse than a disabled one, so entering edit mode is
            // part of the gesture rather than a precondition the user has to guess.
            onWithdraw={(target) => {
              if (!isEditing) startEditing();
              editor.withdrawTarget(target);
            }}
          />

          {/* D-529 (operator, 2026-10-28): on desktop the composition's actions sit together on the
              right; a phone keeps the full-width row. "Cancel" drops the draft at a click, so it
              keeps a wider gap from "+ Add tokens". */}
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3 sm:justify-end">
            <button
              type="button"
              onClick={() => setTargetsModalOpen(true)}
              // Same look as "Edit targets" (operator, 2026-10-28): both change the composition.
              className="rounded-2xl border border-cyan-300/30 bg-cyan-300/10 px-6 py-3 text-sm font-semibold text-cyan-200 transition hover:bg-cyan-300/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 sm:mr-3"
            >
              + {t.addTokensButton}
            </button>
            {/* Both sets share one grid cell, as wide as the wider one, so "+ Add tokens" never moves
                when "Edit targets" turns into "Cancel · Save" (operator, 2026-10-28). The set not in
                use stays laid out but hidden, out of the tab order and the accessibility tree. On a phone
                a long label wraps the row, and the cell goes to the right edge of its own line. */}
            <div className="grid max-sm:ml-auto">
              <div
                aria-hidden={!isEditing}
                inert={!isEditing}
                className={`col-start-1 row-start-1 flex items-center justify-end gap-3 ${isEditing ? "" : "invisible"}`}
              >
                <button
                  type="button"
                  onClick={cancelEditing}
                  className="rounded-2xl border border-slate-700 bg-slate-900 px-5 py-3 text-sm font-medium text-slate-300 transition hover:border-slate-500 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
                >
                  {t.cancelEdit}
                </button>
                <button
                  type="button"
                  onClick={() => { if (hasErrors) setSaveBlockedOpen(true); else saveEditing(); }}
                  className="rounded-2xl bg-cyan-300 px-6 py-3 text-sm font-semibold text-black transition hover:bg-cyan-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
                >
                  {t.savePanel}
                </button>
              </div>
              <div
                aria-hidden={isEditing}
                inert={isEditing}
                className={`col-start-1 row-start-1 flex items-center justify-end ${isEditing ? "invisible" : ""}`}
              >
                <button
                  type="button"
                  onClick={() => startEditing()}
                  className="rounded-2xl border border-cyan-300/30 bg-cyan-300/10 px-6 py-3 text-sm font-semibold text-cyan-200 transition hover:bg-cyan-300/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
                >
                  {t.editPanel}
                </button>
              </div>
            </div>
          </div>
        </>
      ) : (
        <EmptyState
          title={shellT.compositionEmptyTitle}
          body={shellT.compositionEmptyBody}
        />
      )}

      {editor.withdrawDialog ? (
        <WithdrawModal
          t={t}
          withdrawDialog={editor.withdrawDialog}
          portfolioName={activePortfolio.name}
          onCancel={() => editor.setWithdrawDialog(null)}
          onAmountChange={editor.setWithdrawAmount}
          onConfirm={editor.confirmWithdraw}
        />
      ) : null}

      {editor.removeEmptyDialog ? (
        <RemoveEmptyModal
          t={t}
          symbol={editor.removeEmptyDialog.symbol}
          tokenId={editor.removeEmptyDialog.tokenId}
          spreadPct={lockedSpreadPct(editor.computedTargets, editor.removeEmptyDialog.id)}
          lang={editor.lang}
          onCancel={editor.cancelRemoveEmpty}
          onConfirm={editor.confirmRemoveEmpty}
        />
      ) : null}

      {editor.toast ? (
        <div role="status" aria-live="polite" className="pointer-events-none fixed bottom-6 left-1/2 z-[60] -translate-x-1/2">
          <div className={`rounded-xl border px-4 py-2.5 text-sm shadow-2xl backdrop-blur ${editor.toast.kind === "warn" ? "border-amber-400/40 bg-amber-400/15 text-amber-100" : "border-slate-700 bg-slate-900/95 text-slate-100"}`} style={{ animation: "toastIn 220ms cubic-bezier(.2,.8,.2,1)" }}>
            {editor.toast.text}
          </div>
        </div>
      ) : null}

      {assignPrompt.open ? (
        <AssignFundsPrompt
          lang={editor.lang}
          message={shellT.assignFundsPortfolioTitle
            .replace("{amount}", formatUsd(fundable.status === "known" ? fundable.usd : 0))
            .replace("{name}", activePortfolio.name)}
          onAssign={() => {
            assignPrompt.markSeen();
            openAddModal();
          }}
          onNotNow={assignPrompt.markSeen}
        />
      ) : null}

      {targetsModalOpen ? (
        <AddTargetsModal
          t={t}
          compositionTokenIds={editor.selectedTokenIds}
          existingBalances={editor.effectiveCurrentPortfolioQty}
          onAddTarget={editor.addTargetToken}
          onClose={() => setTargetsModalOpen(false)}
        />
      ) : null}

      {addModalOpen ? (
        <AddFundsModal
          mode="edit"
          t={t}
          available={editor.generalBalanceAvailable}
          balanceLoading={fundable.status === "loading"}
          onRetryBalance={fundable.status === "error" ? fundable.retry : undefined}
          // One modal at a time: this one closes before the shell's Deposit opens.
          onDeposit={
            openDeposit
              ? () => {
                  setAddModalOpen(false);
                  openDeposit();
                }
              : undefined
          }
          existingBalances={editor.effectiveCurrentPortfolioQty}
          compositionTokenIds={editor.selectedTokenIds}
          prices={editor.priceState.prices}
          onClose={() => setAddModalOpen(false)}
          onAllocate={(tokenId, qty) => {
            editor.allocateToPortfolio(tokenId, qty);
            editor.setToast({ kind: "neutral", text: `+${formatCrypto(qty)}\u00a0${getTokenById(tokenId)?.symbol ?? tokenId}` });
          }}
          realFunding={
            editor.isLiveRoute
              ? {
                  blockedByDraft: editor.hasDraftChanges,
                  defaultTolerancePct: activePortfolio.defaultTolerancePct,
                  onFunded: (credited) => {
                    // Signing is blocked while the draft has changes (P6), so any draft open
                    // here is an empty one seeded from the portfolio as it was BEFORE the
                    // funding. Kept, its next Save would diff against the new composition and
                    // remove the token that just joined.
                    editor.discardDraft();
                    editor.setToast({
                      kind: "neutral",
                      // A non-breaking space keeps each "+qty SYMBOL" together when it wraps at 390 px.
                      text: credited
                        .map((c) => `+${formatCrypto(c.qty)}\u00a0${getTokenById(c.tokenId)?.symbol ?? c.tokenId}`)
                        .join(" · "),
                    });
                  },
                }
              : undefined
          }
        />
      ) : null}

      {saveBlockedOpen ? (
        <SaveBlockedModal t={t} blockers={saveBlockers} onClose={() => setSaveBlockedOpen(false)} />
      ) : null}

      {editor.preview ? (
        <ConfirmChangesModal
          summary={editor.preview.summary}
          portfolioName={activePortfolio.name}
          t={t}
          isSigning={editor.isSigning}
          error={editor.signError}
          vaultNotice={editor.vaultNotice}
          isLiveRoute={editor.isLiveRoute}
          sendsThroughRelay={relaySends}
          maturity={editor.maturity}
          realStage={editor.realUnallocateStage}
          portfolioId={activePortfolio.isReal ? activePortfolio.id : null}
          onTradeSettled={refetchPortfolios}
          onCancel={editor.cancelPreview}
          onConfirm={editor.confirmCommit}
        />
      ) : null}
    </section>
  );
}

type WithdrawDialog = NonNullable<ReturnType<typeof usePortfolioEditor>["withdrawDialog"]>;

function WithdrawModal({
  t,
  withdrawDialog,
  portfolioName,
  onCancel,
  onAmountChange,
  onConfirm
}: {
  t: Record<string, string>;
  withdrawDialog: WithdrawDialog;
  portfolioName: string;
  onCancel: () => void;
  onAmountChange: (amount: number | string) => void;
  onConfirm: () => void;
}) {
  const remaining = withdrawDialog.maxAmount - withdrawDialog.amount;
  const remainingUsd = remaining * withdrawDialog.price;
  const withdrawUsd = withdrawDialog.amount * withdrawDialog.price;
  // Step aligned with formatTokenAmount precision so input and slider don't show excess decimals.
  const decimals = withdrawDialog.price >= 1000 ? 5 : withdrawDialog.price >= 100 ? 4 : withdrawDialog.price >= 1 ? 3 : 2;
  const step = Math.pow(10, -decimals);

  const tokenInfo = getTokenById(withdrawDialog.tokenId);
  return (
    <Modal titleId="withdraw-title" onClose={onCancel}>
      <h2 id="withdraw-title" className="flex flex-wrap items-baseline gap-x-2 text-lg font-semibold text-slate-100">
        <span>{t.unallocateTitle.replace("{symbol}", withdrawDialog.symbol)}</span>
        {tokenInfo?.name ? (
          <span className="text-xs font-normal text-slate-400">{tokenInfo.name}</span>
        ) : null}
      </h2>
      <p className="mt-0.5 text-xs text-slate-400">{t.withdrawPortfolioLabel}: {portfolioName}</p>
      <p className="mt-2 text-sm text-slate-400">{t.withdrawConfirm}</p>

      <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-900 p-4">
        <div className="flex items-baseline justify-between">
          <label htmlFor="withdraw-amount" className="text-xs uppercase text-slate-400">{t.withdrawAmount}</label>
          <span className="text-[11px] text-slate-400 tabular-nums">
            {t.withdrawAvailable}: {formatTokenAmount(withdrawDialog.maxAmount, withdrawDialog.price)} {withdrawDialog.symbol}
          </span>
        </div>
        <div className="mt-2 flex items-center gap-2">
          {/* Text, not `type="number"`: a controlled number input reports "" for anything
              the browser deems invalid mid-typing, and under a comma-decimal locale that
              includes a POINT — which erased the amount on a keystroke. The grammar lives
              in lib/decimal-input.ts and accepts both separators. `inputMode` still brings
              up the numeric keypad on mobile. */}
          <input
            id="withdraw-amount"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={withdrawDialog.raw}
            onChange={(event) => onAmountChange(event.target.value)}
            className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-base text-slate-100 tabular-nums outline-none transition focus:border-cyan-300"
          />
          <span className="text-sm font-semibold text-slate-300">{withdrawDialog.symbol}</span>
          <button
            type="button"
            onClick={() => onAmountChange(withdrawDialog.maxAmount)}
            className="rounded-lg border border-cyan-300/30 bg-cyan-300/10 px-2 py-1.5 text-[11px] font-semibold text-cyan-200 transition hover:bg-cyan-300/20"
          >
            {t.withdrawMax}
          </button>
        </div>
        <input
          type="range"
          min="0"
          max={withdrawDialog.maxAmount}
          step={step}
          value={withdrawDialog.amount}
          onChange={(event) => onAmountChange(event.target.value)}
          className="mt-3 w-full accent-cyan-300"
          aria-label={t.withdrawAmount}
        />
        <div className="mt-1 flex justify-between text-[10px] text-slate-400 tabular-nums">
          <span>0</span>
          <span>{formatTokenAmount(withdrawDialog.maxAmount, withdrawDialog.price)} {withdrawDialog.symbol}</span>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
        <div className="rounded-xl border border-cyan-300/30 bg-cyan-300/10 p-3">
          <p className="text-[10px] uppercase text-cyan-200/80">{t.withdrawSummary}</p>
          <p className="mt-1 text-sm font-semibold text-cyan-200 tabular-nums">
            {formatTokenAmount(withdrawDialog.amount, withdrawDialog.price)} {withdrawDialog.symbol}
          </p>
          <p className="text-[11px] text-cyan-200/70 tabular-nums">≈ {formatUsd(withdrawUsd)}</p>
        </div>
        <div className="rounded-xl border border-slate-700 bg-slate-900 p-3">
          <p className="text-[10px] uppercase text-slate-400">{t.withdrawRemaining}</p>
          <p className="mt-1 text-sm font-semibold text-slate-200 tabular-nums">
            {formatTokenAmount(remaining, withdrawDialog.price)} {withdrawDialog.symbol}
          </p>
          <p className="text-[11px] text-slate-400 tabular-nums">≈ {formatUsd(remainingUsd)}</p>
        </div>
      </div>

      <div className="mt-6 flex justify-end gap-3">
        <button type="button" onClick={onCancel} className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-300 transition hover:border-slate-500 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60">
          {t.cancel}
        </button>
        <button type="button" onClick={onConfirm} disabled={withdrawDialog.amount <= 0} className="rounded-xl bg-cyan-300 px-4 py-2 text-sm font-semibold text-black transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60">
          {t.withdrawSimulateConfirm}
        </button>
      </div>
    </Modal>
  );
}

export function SaveBlockedModal({ t, blockers, onClose }: { t: Record<string, string>; blockers: string[]; onClose: () => void }) {
  return (
    <Modal titleId="save-blocked-title" onClose={onClose}>
      <h2 id="save-blocked-title" className="flex items-center gap-2 text-lg font-semibold text-slate-100">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0 text-rose-300">
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        {t.saveBlockedTitle}
      </h2>
      <p className="mt-2 text-sm text-slate-400">{t.saveBlockedIntro}</p>
      <ul className="mt-4 space-y-2">
        {blockers.map((blocker, index) => (
          <li
            key={index}
            className="flex items-start gap-2 rounded-xl border border-rose-400/30 bg-rose-400/5 px-3 py-2 text-[13px] leading-snug text-rose-100"
          >
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-rose-300" aria-hidden="true" />
            <span>{blocker}</span>
          </li>
        ))}
      </ul>
      <div className="mt-6 flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="rounded-xl bg-cyan-300 px-5 py-2 text-sm font-semibold text-black transition hover:bg-cyan-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
        >
          {t.saveBlockedClose}
        </button>
      </div>
    </Modal>
  );
}

export function RemoveEmptyModal({ t, symbol, tokenId, spreadPct, lang, onCancel, onConfirm }: { t: Record<string, string>; symbol: string; tokenId: string; spreadPct: number | null; lang: Language; onCancel: () => void; onConfirm: () => void }) {
  const tokenInfo = getTokenById(tokenId);
  return (
    <Modal titleId="remove-empty-title" onClose={onCancel}>
      <h2 id="remove-empty-title" className="flex flex-wrap items-baseline gap-x-2 text-lg font-semibold text-slate-100">
        <span>{t.removeEmptyTitle.replace("{symbol}", symbol)}</span>
        {tokenInfo?.name ? (
          <span className="text-xs font-normal text-slate-400">{tokenInfo.name}</span>
        ) : null}
      </h2>
      <p className="mt-3 text-sm text-slate-400">{t.removeEmptyBody}</p>
      {spreadPct !== null ? (
        <p className="mt-3 text-sm text-amber-200">
          {t.removeSpreadsOverLocked.replace(
            "{pct}",
            spreadPct.toLocaleString(lang === "es" ? "es-AR" : "en-US", { maximumFractionDigits: 2 })
          )}
        </p>
      ) : null}
      <div className="mt-6 flex justify-end gap-3">
        <button type="button" onClick={onCancel} className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-300 transition hover:border-slate-500 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60">
          {t.cancel}
        </button>
        <button type="button" onClick={onConfirm} className="rounded-xl border border-rose-400/40 bg-rose-400/10 px-4 py-2 text-sm font-semibold text-rose-200 transition hover:bg-rose-400/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-300/60">
          {t.removeEmptyConfirm}
        </button>
      </div>
    </Modal>
  );
}

// D-369: whether a withdrawal from this portfolio ended unconfirmed and can still execute. The
// snapshot is the expiry itself (a stable number), and a timer drops the strip when it passes.
function useUnconfirmedWithdrawal(portfolioId: string | null): boolean {
  const [, setExpired] = useState(0);
  const until = useSyncExternalStore(
    subscribeUnconfirmedWithdrawals,
    () => (portfolioId ? unconfirmedWithdrawalUntil(portfolioId) : null),
    () => null
  );
  useEffect(() => {
    if (until === null) return;
    const id = setTimeout(() => setExpired((n) => n + 1), Math.max(0, until - Date.now()));
    return () => clearTimeout(id);
  }, [until]);
  return until !== null;
}
