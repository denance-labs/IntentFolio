"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useTokenPrices } from "@/features/market/hooks/use-token-prices";
import { tokenRegistry } from "@/features/market/lib/token-registry";
import { getTokenById } from "@/features/market/lib/token-registry";
import { CompositionBars, CompositionDonuts } from "@/features/portfolio-editor/components/portfolio-charts";
import { RemoveEmptyModal, SaveBlockedModal } from "@/features/portfolio-editor/components/portfolio-editor-latest";
import { Modal, SumChip } from "@/features/portfolio-editor/components/portfolio-primitives";
import { PortfolioTargetsTable } from "@/features/portfolio-editor/components/portfolio-targets-table";
import { focusLandingIfLost } from "@/features/portfolio-editor/hooks/use-dialog-focus";
import { lockedSpreadPct } from "@/features/portfolio-editor/lib/allocation";
import { computeTargets } from "@/features/portfolio-editor/lib/calculations";
import { buildTokenColorMap, colorForSymbol, formatUsd } from "@/features/portfolio-editor/lib/format";
import { translations as editorTranslations } from "@/features/portfolio-editor/lib/translations";
import type { RuleViolation } from "@/features/portfolio-editor/lib/validation";
import type { ComputedTargetAllocation } from "@/features/portfolio-editor/types";
import { evaluatePortfolioRules } from "@/features/intents-account/mock-contract/rules";
import type { TokenId } from "@/features/intents-account/mock-contract/types";
import { useLanguage } from "../context/language-context";
import type { NewPortfolioDraft, NewPortfolioDraftRow, NewPortfolioDraftValidation } from "../lib/new-portfolio-draft";
import {
  addDraftToken,
  draftDefaultTolerance,
  removeDraftTokenInTable,
  setDraftTokenPct,
  setDraftTokenTolerance,
} from "../lib/new-portfolio-draft-editing";
import { draftBlockerText } from "../lib/new-portfolio-draft-messages";
import { SIMULATION_DEFAULT_USD } from "../lib/new-portfolio-draft-simulation";
import { shellTranslations } from "../lib/translations";
import { DraftTokenPickerContent } from "./draft-token-picker";
import { NewPortfolioDraftSimulation } from "./new-portfolio-draft-simulation";
import { SkeletonBlock } from "./view-states";

const SECONDARY_BUTTON =
  "rounded-xl border border-slate-700 px-4 py-2.5 text-sm text-slate-200 transition hover:border-slate-500 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60";

// Nothing is held, so no row is ever a held token to promote.
const noop = () => {};

type ViewProps = {
  draft: NewPortfolioDraft;
  /** 027 A-10: "Save draft" — the edited rows, saved with the rest of the draft as it is. */
  onSaveRows: (rows: NewPortfolioDraftRow[]) => NewPortfolioDraftValidation;
  /** Whether the table holds edits not saved yet, so leaving the tab can ask first. */
  onUnsavedChange?: (unsaved: boolean) => void;
  onDiscard: () => void;
  /** D-457 — the simulation's amount, stored with the draft as it is typed. */
  onSimulationUsdChange: (amountUsd: number) => void;
} & (
  // The state is decided by the caller (wallet, General Balance); the view only shows it.
  | { variant: "signed-out"; onConnect: () => void }
  | { variant: "waiting"; onDeposit: () => void }
  // D-486: the General Balance is still being read, so neither "waiting" nor "ready" is true yet.
  | { variant: "loading" }
  | { variant: "ready"; onConfirm: () => void; amountUsd: number }
);

// 019-3 (D-393 Q2) — a New Portfolio Draft shown with the shape of a portfolio: the same
// value header, charts and targets table as Composition, all at $0 because nothing is held
// yet, and the D-358 simulation under the table. It is still not a Portfolio, and its main
// action (connect, deposit, confirm) arrives already chosen.
//
// 027 A-10: "Edit targets" edits the table in place, as on a portfolio — the same table,
// lock rules and remove dialog — and "Save draft" keeps the rows in this browser (no
// signature); "Cancel" drops them. The edits live here until saved; the draft editor (the
// "Build your portfolio" dialog) is only for creating the draft.
export function NewPortfolioDraftView(props: ViewProps) {
  const { draft, onSaveRows, onUnsavedChange, onDiscard, onSimulationUsdChange } = props;
  const { lang } = useLanguage();
  const t = shellTranslations[lang];
  const te = editorTranslations[lang];
  const { prices } = useTokenPrices();
  const [confirming, setConfirming] = useState(false);
  const discardRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);

  // The rows being edited, or null while the draft is only shown.
  const [editRows, setEditRows] = useState<NewPortfolioDraftRow[] | null>(null);
  const isEditing = editRows !== null;
  const shownRows = editRows ?? draft.rows;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [removing, setRemoving] = useState<TokenId | null>(null);
  const [blockers, setBlockers] = useState<string[] | null>(null);
  // Composition's toast after a removal locked the rest; here a line under the table.
  const [notice, setNotice] = useState<string | null>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const unsaved = isEditing && JSON.stringify(editRows) !== JSON.stringify(draft.rows);
  useEffect(() => {
    onUnsavedChange?.(unsaved);
  }, [unsaved, onUnsavedChange]);
  useEffect(() => () => onUnsavedChange?.(false), [onUnsavedChange]);

  // The edit buttons swap places; the focus goes to the one that took the slot when the
  // pressed one is gone (a dialog that opened meanwhile keeps it instead).
  const wasEditing = useRef(isEditing);
  useEffect(() => {
    if (wasEditing.current === isEditing) return;
    wasEditing.current = isEditing;
    if (document.activeElement && document.activeElement !== document.body) return;
    (isEditing ? saveRef : editRef).current?.focus();
  }, [isEditing]);

  function beginEdit() {
    setConfirming(false);
    setEditRows((current) => current ?? draft.rows);
  }

  function edit(change: (rows: NewPortfolioDraftRow[]) => NewPortfolioDraftRow[]) {
    setEditRows((current) => (current ? change(current) : current));
    setNotice(null);
  }

  function remove(tokenId: TokenId) {
    if (!editRows) return;
    const result = removeDraftTokenInTable(editRows, tokenId);
    setEditRows(result.rows);
    setNotice(result.autoLocked ? te.autoLockedAfterRemove : null);
  }

  function stopEditing() {
    setEditRows(null);
    setNotice(null);
  }

  function save() {
    if (!editRows) return;
    const result = onSaveRows(editRows);
    if (result.ok) stopEditing();
    else setBlockers([draftBlockerText(result, editRows, t, te)]);
  }

  // Focus follows the question: to its safe answer when asked, back to "Discard" on "No".
  const asked = useRef(false);
  useEffect(() => {
    if (confirming) keepRef.current?.focus();
    else if (asked.current) discardRef.current?.focus();
    asked.current = confirming;
  }, [confirming]);

  // D-360: discarding removes the view with the focus in it; the landing that replaces it
  // takes the focus.
  useEffect(() => focusLandingIfLost, []);

  // Nothing held: every row at $0 and 0%, and no band to be in or out of ("—").
  const rows = useMemo<ComputedTargetAllocation[]>(
    () =>
      computeTargets(
        shownRows.map((r) => ({ id: r.tokenId, ...r })),
        tokenRegistry,
        prices,
        {},
        0
      ).map((row) => ({ ...row, bandState: "empty" })),
    [shownRows, prices]
  );
  // The row checks of the shared rules engine, as Composition shows them. With nothing held, a
  // 0% row says what the draft needs (a % above 0, or remove it), not "…or a balance".
  const rowViolations = useMemo(() => {
    const byTokenId: Record<string, RuleViolation[]> = {};
    if (!editRows) return byTokenId;
    for (const v of evaluatePortfolioRules(editRows, {})) {
      if (v.tokenId) (byTokenId[v.tokenId] ??= []).push(v);
    }
    return byTokenId;
  }, [editRows]);
  const tableT = useMemo(() => ({ ...te, ruleZeroTargetZeroBalance: t.draftTargetNotPositive }), [te, t]);
  const totalPct = shownRows.reduce((sum, r) => sum + r.targetPct, 0);
  const sumOff = Math.abs(totalPct - 100) > 0.001;
  const colorByToken = useMemo(() => buildTokenColorMap(rows.map((r) => r.tokenId)), [rows]);
  const colorOf = (tokenId: string) =>
    colorByToken.get(tokenId) ?? colorForSymbol(rows.find((r) => r.tokenId === tokenId)?.symbol ?? tokenId);

  const title =
    props.variant === "ready"
      ? t.draftReadyTitle.replace("{amount}", formatUsd(props.amountUsd))
      : { waiting: t.draftCardTitle, loading: "{name}", "signed-out": t.draftSignedOutCardTitle }[props.variant];
  const body = { waiting: t.draftCardBody, loading: null, ready: null, "signed-out": t.draftSignedOutCardBody }[props.variant];
  const primary =
    props.variant === "signed-out"
      ? { label: t.walletConnect, onClick: props.onConnect }
      : props.variant === "waiting"
        ? { label: t.draftCardDeposit, onClick: props.onDeposit }
        : props.variant === "loading"
          ? null
          : { label: t.draftReadyConfirm, onClick: props.onConfirm };

  return (
    <section
      aria-labelledby="new-portfolio-draft-view-title"
      className="w-full"
      style={{ animation: "sectionIn 360ms cubic-bezier(.2,.8,.2,1)" }}
    >
      <div
        className={`mb-6 rounded-3xl border bg-surface px-6 py-5 shadow-lg shadow-black/20 ${
          props.variant === "ready" ? "border-cyan-400/40" : "border-slate-800"
        }`}
      >
        <p className="text-xs font-medium uppercase text-slate-400">{te.totalCurrent}</p>
        <p className="mt-3 text-3xl font-semibold tracking-tight text-white tabular-nums">{formatUsd(0)}</p>

        <div className="mt-4 border-t border-slate-800/60 pt-4">
          {/* D-360: the landing for the focus when the control that opened the editor is gone. */}
          <h2
            id="new-portfolio-draft-view-title"
            tabIndex={-1}
            data-focus-landing
            className="rounded font-semibold text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
          >
            {title.replace("{name}", draft.name)}
          </h2>
          {body ? <p className="mt-0.5 text-sm text-slate-400">{body}</p> : null}
          {/* D-486: the body line's place while the balance loads (s283 QA). */}
          {props.variant === "loading" ? (
            <div data-testid="draft-loading-line" className="mt-0.5 flex h-5 items-center">
              <SkeletonBlock className="h-3 w-56 max-w-full" />
            </div>
          ) : null}

          {/* 029 B-13: the main action stays up here too (the first thing seen on a phone);
              deleting the draft is only under the table. */}
          {isEditing || !primary ? null : (
            <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
              <button
                type="button"
                onClick={primary.onClick}
                className="rounded-xl bg-cyan-500 px-5 py-2.5 text-sm font-medium text-slate-950 transition hover:bg-cyan-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
              >
                {primary.label}
              </button>
            </div>
          )}
        </div>
      </div>

      {isEditing ? (
        <div
          role="status"
          className="mb-6 flex items-center gap-2.5 rounded-2xl border border-cyan-300/25 bg-cyan-300/5 px-4 py-3"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0 text-cyan-300">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </svg>
          <p className="text-sm text-cyan-100">{t.draftEditModeBanner}</p>
        </div>
      ) : null}

      <div className="mt-4 grid gap-5 lg:grid-cols-2">
        <CompositionBars rows={rows} currentTotalUsd={0} targetTotalUsd={0} colorByToken={colorByToken} t={te} />
        <div className="rounded-2xl border border-slate-800 bg-surface p-4">
          <CompositionDonuts rows={rows} currentTotalUsd={0} targetTotalUsd={0} colorByToken={colorByToken} t={te} />
        </div>
      </div>

      {/* Composition's row above the table while editing: the sum when it is off, the lock hint. */}
      <div className={isEditing ? "mt-5 flex min-h-[20px] flex-wrap items-center justify-between gap-3" : "mt-2"}>
        {isEditing ? (
          <>
            {sumOff ? <SumChip totalPct={totalPct} t={te} /> : <span />}
            <span className="flex items-center gap-1.5 text-[11px] text-slate-400">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="4" y="11" width="16" height="9" rx="2" />
                <path d="M8 11V7a4 4 0 0 1 8 0v4" />
              </svg>
              {te.lockHint}
            </span>
          </>
        ) : null}
      </div>

      <PortfolioTargetsTable
        t={tableT}
        rows={rows}
        colorByToken={colorByToken}
        isEditing={isEditing}
        allLocked={shownRows.every((r) => r.locked)}
        allUnlocked={shownRows.every((r) => !r.locked)}
        rowViolations={rowViolations}
        onUpdateTarget={(id, patch) => {
          const tolerance = patch.tolerancePct;
          if (typeof tolerance === "number") edit((current) => setDraftTokenTolerance(current, id, tolerance));
        }}
        onUpdateTargetPct={(id, next) => edit((current) => setDraftTokenPct(current, id, Number(next) || 0).rows)}
        onPromoteHeld={noop}
        // The table only lets a lock be pressed when the rule allows it (two free rows).
        onToggleLock={(id) => edit((current) => current.map((r) => (r.tokenId === id ? { ...r, locked: !r.locked } : r)))}
        onLockAll={() => edit((current) => current.map((r) => ({ ...r, locked: true })))}
        onUnlockAll={() => edit((current) => current.map((r) => ({ ...r, locked: false })))}
        // As on a portfolio, "Remove" in read mode starts editing; the dialog asks first.
        onWithdraw={(row) => {
          beginEdit();
          setRemoving(row.tokenId);
        }}
      />
      {notice ? (
        <p role="status" className="mt-2 text-[11px] leading-snug text-amber-300">
          {notice}
        </p>
      ) : null}

      {/* 029 B-13: under the table, next to "Edit targets", the main action again — the title is
          out of view by then — with the balance line over it, and "Delete draft" with its
          question. On a phone they stack, the main action first (`order-*` below `sm`). */}
      {!isEditing && props.variant === "ready" ? (
        <p className="mt-6 text-sm text-slate-400 sm:text-right">
          {t.draftReadyBalanceLine.replace("{amount}", formatUsd(props.amountUsd))}
        </p>
      ) : null}
      <div className={`${!isEditing && props.variant === "ready" ? "mt-3" : "mt-6"} flex flex-wrap items-center gap-3`}>
        <button
          type="button"
          onClick={() => {
            beginEdit();
            setPickerOpen(true);
          }}
          className="order-2 rounded-xl border border-dashed border-cyan-300/30 bg-cyan-300/5 px-4 py-2 text-sm text-cyan-200 transition hover:bg-cyan-300/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 sm:order-none sm:mr-auto"
        >
          + {te.addTarget}
        </button>
        {/* Keyed: without keys React reuses the buttons of one branch for the other, so focus
            would land on whatever button happens to sit in the same place. */}
        {isEditing ? (
          <div key="editing" className="order-3 ml-auto flex flex-wrap items-center gap-3 sm:order-none">
            <button
              type="button"
              onClick={stopEditing}
              className="rounded-2xl border border-slate-700 bg-slate-900 px-5 py-3 text-sm font-medium text-slate-300 transition hover:border-slate-500 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
            >
              {te.cancelEdit}
            </button>
            <button
              ref={saveRef}
              type="button"
              onClick={save}
              className="rounded-2xl bg-cyan-300 px-6 py-3 text-sm font-semibold text-black transition hover:bg-cyan-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
            >
              {t.draftSaveDraft}
            </button>
          </div>
        ) : confirming ? (
          <div
            key="discard-question"
            role="group"
            aria-labelledby="new-portfolio-draft-view-discard-question"
            className="order-1 flex w-full flex-wrap items-center gap-3 sm:order-none sm:w-auto"
          >
            <p id="new-portfolio-draft-view-discard-question" className="text-sm font-medium text-slate-200">
              {props.variant === "ready" ? t.draftReadyDiscardQuestion : t.draftCardDiscardQuestion}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onDiscard}
                className="rounded-xl border border-rose-400/40 bg-rose-400/10 px-4 py-2.5 text-sm font-medium text-rose-200 transition hover:bg-rose-400/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-300/60"
              >
                {t.draftCardDiscardYes}
              </button>
              <button ref={keepRef} type="button" onClick={() => setConfirming(false)} className={SECONDARY_BUTTON}>
                {t.draftCardDiscardNo}
              </button>
            </div>
          </div>
        ) : (
          <Fragment key="actions">
            <button
              ref={discardRef}
              type="button"
              onClick={() => setConfirming(true)}
              className="order-4 w-full rounded-2xl px-4 py-3 text-sm text-slate-400 transition hover:bg-slate-800 hover:text-rose-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 sm:order-none sm:w-auto"
            >
              {t.draftCardDiscard}
            </button>
            <button
              ref={editRef}
              type="button"
              onClick={beginEdit}
              className="order-3 ml-auto rounded-2xl border border-cyan-300/30 bg-cyan-300/10 px-6 py-3 text-sm font-semibold text-cyan-200 transition hover:bg-cyan-300/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 sm:order-none sm:ml-0"
            >
              {te.editPanel}
            </button>
            {primary ? (
              <button
                type="button"
                onClick={primary.onClick}
                className="order-1 w-full rounded-2xl bg-cyan-500 px-6 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 sm:order-none sm:w-auto"
              >
                {primary.label}
              </button>
            ) : null}
          </Fragment>
        )}
      </div>

      {/* Keyed by the last save: the editor, open over this view, may save another amount.
          Typing here does not move `updatedAt`, so the field keeps its text while typed in. */}
      <NewPortfolioDraftSimulation
        key={draft.updatedAt}
        rows={shownRows}
        colorOf={colorOf}
        initialUsd={draft.simulationUsd ?? SIMULATION_DEFAULT_USD}
        onAmountChange={onSimulationUsdChange}
      />

      {pickerOpen && editRows ? (
        <Modal titleId="draft-view-picker-title" onClose={() => setPickerOpen(false)} maxWidth="max-w-2xl" initialFocusRef={searchRef}>
          <DraftTokenPickerContent
            rows={editRows}
            onAdd={(tokenId) => edit((current) => addDraftToken(current, tokenId, draftDefaultTolerance(draft.presetId)))}
            onRemove={remove}
            onBack={() => setPickerOpen(false)}
            titleId="draft-view-picker-title"
            searchRef={searchRef}
          />
        </Modal>
      ) : null}

      {removing && editRows ? (
        <RemoveEmptyModal
          t={te}
          symbol={getTokenById(removing)?.symbol ?? removing}
          tokenId={removing}
          spreadPct={lockedSpreadPct(editRows.map((r) => ({ id: r.tokenId, ...r })), removing)}
          lang={lang}
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            remove(removing);
            setRemoving(null);
          }}
        />
      ) : null}

      {blockers ? <SaveBlockedModal t={te} blockers={blockers} onClose={() => setBlockers(null)} /> : null}
    </section>
  );
}
