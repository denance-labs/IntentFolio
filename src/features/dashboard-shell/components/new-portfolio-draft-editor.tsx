"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Lock, LockOpen, Plus, X } from "lucide-react";
import { InfoTooltip, Modal, SumChip } from "@/features/portfolio-editor/components/portfolio-primitives";
import { StockRowChip } from "@/features/portfolio-editor/components/stock-token-sections";
import { isStockToken } from "@/features/market/lib/stock-tokens";
import { getTokenById } from "@/features/market/lib/token-registry";
import { useStocksRegionBlocked } from "@/features/stocks/hooks/use-stocks-region-blocked";
import { TokenAvatar } from "@/features/market/lib/token-avatar";
import { RULE_MESSAGE_KEYS, type RuleCode } from "@/features/portfolio-editor/lib/validation";
import { translations as editorTranslations } from "@/features/portfolio-editor/lib/translations";
import {
  TOLERANCE_MAX_PCT,
  TOLERANCE_MIN_PCT,
} from "@/features/intents-account/mock-contract/rules";
import type { TokenId } from "@/features/intents-account/mock-contract/types";
import type { PresetId } from "@/content/portfolio-presets";
import { useLanguage } from "../context/language-context";
import { useNewPortfolioDraft } from "../hooks/use-new-portfolio-draft";
import {
  validateNewPortfolioDraft,
  type NewPortfolioDraft,
  type NewPortfolioDraftInput,
  type NewPortfolioDraftRow,
  type NewPortfolioDraftValidation,
} from "../lib/new-portfolio-draft";
import {
  addDraftToken,
  draftDefaultTolerance,
  draftLockState,
  draftRowCeiling,
  draftToleranceViolations,
  normalizeDraftLocks,
  presetDraftRows,
  removeDraftToken,
  sanitizeDraftPctInput,
  setDraftTokenPct,
  setDraftTokenTolerance,
  toggleDraftTokenLock,
  uniqueDefaultName,
} from "../lib/new-portfolio-draft-editing";
import { draftBlockerText, draftValidationMessage } from "../lib/new-portfolio-draft-messages";
import { SIMULATION_DEFAULT_USD } from "../lib/new-portfolio-draft-simulation";
import { PORTFOLIO_NAME_MAX_LENGTH } from "../lib/portfolio-validation";
import { shellTranslations } from "../lib/translations";
import { DraftCompositionBar, useDraftCompositionColors } from "./draft-composition";
import { DraftTokenPickerContent } from "./draft-token-picker";
import { NewPortfolioDraftSimulation } from "./new-portfolio-draft-simulation";
import { PresetReviewModal } from "./preset-review-modal";
import { PRESET_NAME_KEY } from "./preset-selection-modal";

// 016 block 2.2 — the New Portfolio Draft editor: a portfolio designed before any deposit
// (tokens, target %, tolerances, name), saved to this browser and confirmed with one
// signature once funds arrive (2.4). Layout approved in 016 §7 (s184): one row per token,
// two lines below `sm` and one grid line above it; the reason the draft cannot be saved
// repeats in a sticky footer because at 390 px the row at fault is usually off screen.
//
// It is the Composition editor's sibling, not a reuse: the % arithmetic comes from the
// same pure functions (through new-portfolio-draft-editing), but the table, its slider
// and its funded columns stay out (plan B2).
//
// D-397 (plan 041): with funds, a new mix is created from here. "Create portfolio" opens the funds
// screen, the same one a saved draft confirms on, as another view of this dialog, so "Back" finds
// everything as it was. Saving a draft is a separate action, and it never replaces a saved one.

const ROW_GRID = "sm:grid sm:grid-cols-[minmax(0,1fr)_6rem_2.75rem_6.5rem_2.75rem] sm:items-center sm:gap-x-3";
const FIELD_BOX = "flex h-11 items-center rounded-xl border px-3 transition sm:h-9";
const ICON_BUTTON =
  "flex h-11 w-11 shrink-0 items-center justify-center rounded-lg transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 sm:h-9 sm:w-9";
const SECONDARY_BUTTON =
  "rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-300 transition hover:border-slate-500 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60";
// Tinted, so "Save draft" does not read as one more way out next to "Back".
const SAVE_DRAFT_BUTTON =
  "rounded-xl border border-cyan-300/30 bg-cyan-300/5 px-4 py-2 text-sm text-cyan-200 transition hover:bg-cyan-300/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60";

// The rules engine names its messages by key; the editor's translation table holds them.
const ruleMessage = (te: Record<string, string>, code: RuleCode) => te[RULE_MESSAGE_KEYS[code]];

const symbolFor = (tokenId: string) => getTokenById(tokenId)?.symbol ?? tokenId;
const tokenNameFor = (tokenId: string) => getTokenById(tokenId)?.name ?? "";

type View = "editor" | "picker" | "funds";
type Leave = "back" | "close";
type FieldEdit = { tokenId: TokenId; text: string };

export function NewPortfolioDraftEditor({
  presetId,
  draft,
  existingNames,
  onSaved,
  onBack,
  onClose,
  funded = false,
  balanceUnreadable = false,
  signedOut = false,
  savedDraftName = null,
  onCreated,
}: {
  /** The preset to start from, or null for "start from scratch". Ignored with `draft`. */
  presetId: PresetId | null;
  /** A saved draft to resume instead. */
  draft?: NewPortfolioDraft | null;
  existingNames: string[];
  onSaved: () => void;
  /** Back to the preset chooser; without it the secondary button cancels. */
  onBack?: () => void;
  onClose: () => void;
  /**
   * Whether the General Balance can fund it, which picks the footer's actions and follows the
   * balance while the editor is open. null: not known yet, or the read failed.
   */
  funded?: boolean | null;
  /** With `funded` null: the read failed, rather than still being in flight. */
  balanceUnreadable?: boolean;
  /** No wallet connected (D-359): the only action saves the anonymous draft. */
  signedOut?: boolean;
  /** A saved draft this mix is not (it is `draft` when resuming). It is named, and never replaced. */
  savedDraftName?: string | null;
  /** After a portfolio was signed into existence from the funds screen. */
  onCreated?: () => void;
}) {
  const { lang } = useLanguage();
  const t = shellTranslations[lang];
  const te = editorTranslations[lang];
  const { save } = useNewPortfolioDraft();

  // What the editor opened with — the "unsaved changes" reference. Mount-only.
  const [initial] = useState<NewPortfolioDraftInput>(() => {
    if (draft) return { name: draft.name, presetId: draft.presetId, rows: normalizeDraftLocks(draft.rows) };
    const base = presetId ? t[PRESET_NAME_KEY[presetId]] : `Portfolio ${existingNames.length + 1}`;
    return {
      name: uniqueDefaultName(base, savedDraftName ? [...existingNames, savedDraftName] : existingNames),
      presetId,
      rows: presetId ? presetDraftRows(presetId) : [],
    };
  });
  // Fixed on mount like `initial`: a draft discarded from another tab does not turn this into a new mix.
  const [resuming] = useState(() => !!draft);
  const originPresetId = initial.presetId;
  const newTokenTolerance = draftDefaultTolerance(originPresetId);

  const [name, setName] = useState(initial.name);
  const [rows, setRows] = useState<NewPortfolioDraftRow[]>(initial.rows);
  // D-457 — the simulation's amount, saved with the draft and dropped on cancel. It is a
  // reference figure, not the design, so changing it alone is not an unsaved change.
  const [simulationUsd, setSimulationUsd] = useState(draft?.simulationUsd ?? SIMULATION_DEFAULT_USD);
  // The text of the field being typed in; the row value is shown otherwise.
  const [pctEdit, setPctEdit] = useState<FieldEdit | null>(null);
  const [tolEdit, setTolEdit] = useState<FieldEdit | null>(null);
  const [view, setView] = useState<View>("editor");
  // One-line feedback: locks released by a removal (E2), or a lock refused by the cap.
  const [notice, setNotice] = useState<string | null>(null);
  const [lockHint, setLockHint] = useState<TokenId | null>(null);
  const [confirmLeave, setConfirmLeave] = useState<Leave | null>(null);
  const [saveFailure, setSaveFailure] = useState<NewPortfolioDraftValidation | null>(null);
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);

  const titleRef = useRef<HTMLHeadingElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const primaryButtonRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const keepEditingRef = useRef<HTMLButtonElement>(null);

  const input: NewPortfolioDraftInput = { name, presetId: originPresetId, rows, simulationUsd };
  const validation = validateNewPortfolioDraft(input, existingNames);
  const blocker = !validation.ok ? validation : saveFailure;
  const canSave = validation.ok;

  // What the footer offers (plan 041, P1). Signed out and when resuming a draft it only saves. With
  // a wallet it creates unless there are known to be no funds; with a draft saved it creates even
  // then, blocked, because saving is not on offer: that would replace the saved draft.
  const createsPortfolio = !signedOut && !resuming && (funded !== false || savedDraftName !== null);
  const offersSaveDraft = createsPortfolio && savedDraftName === null;
  const createBlockedReason =
    !createsPortfolio || funded === true
      ? null
      : funded === false
        ? t.presetReviewNoFunds
        : balanceUnreadable
          ? t.myAccountBalanceUnreadable
          : t.draftCheckingBalance;
  // D-569: where stocks can't be bought, a mix holding one (a saved draft, the landing's preset) says
  // so from the first screen, and neither saves nor goes on to the funds until they are taken out.
  const regionBlocked = useStocksRegionBlocked();
  const stocksBlocked = regionBlocked && rows.some((r) => isStockToken(r.tokenId));
  const primaryEnabled = canSave && createBlockedReason === null && !stocksBlocked;
  const dirty =
    name.trim() !== initial.name.trim() || JSON.stringify(rows) !== JSON.stringify(initial.rows);

  const toleranceViolations = useMemo(() => draftToleranceViolations(rows), [rows]);
  const colorOf = useDraftCompositionColors(rows);
  const totalPct = rows.reduce((sum, r) => sum + r.targetPct, 0);

  // Focus follows the view: into the search on open, and back to what opened it on return. The
  // funds screen takes the focus itself, as any dialog does.
  const lastView = useRef<View | null>(null);
  useEffect(() => {
    const from = lastView.current;
    lastView.current = view;
    if (from === null) return;
    if (view === "picker") searchRef.current?.focus();
    else if (view === "editor") (from === "funds" ? primaryButtonRef : addButtonRef).current?.focus();
  }, [view]);

  // The leave confirmation takes focus to its safe answer, and gives it back on "keep editing".
  const confirmShown = useRef(false);
  useEffect(() => {
    if (confirmLeave) keepEditingRef.current?.focus();
    else if (confirmShown.current) backButtonRef.current?.focus();
    confirmShown.current = confirmLeave !== null;
  }, [confirmLeave]);

  // After a removal, focus moves to the next row's ✕ (or the previous one, or "+ Add token").
  useEffect(() => {
    if (!pendingFocusId) return;
    const target = pendingFocusId === "add" ? addButtonRef.current : document.getElementById(pendingFocusId);
    target?.focus();
    setPendingFocusId(null);
  }, [pendingFocusId]);

  function commit(next: NewPortfolioDraftRow[], nextNotice: string | null = null) {
    setRows(next);
    setNotice(nextNotice);
    setLockHint(null);
    setSaveFailure(null);
  }

  function handleAdd(tokenId: TokenId) {
    commit(addDraftToken(rows, tokenId, newTokenTolerance));
  }

  function handleRemove(tokenId: TokenId) {
    const index = rows.findIndex((r) => r.tokenId === tokenId);
    const result = removeDraftToken(rows, tokenId);
    commit(result.rows, result.locksReleased ? t.draftLocksReleased : null);
    if (view === "editor") {
      const nextIndex = index < result.rows.length ? index : index - 1;
      setPendingFocusId(nextIndex >= 0 ? `draft-remove-${nextIndex}` : "add");
    }
  }

  function handlePctChange(tokenId: TokenId, raw: string) {
    const text = sanitizeDraftPctInput(raw);
    const result = setDraftTokenPct(rows, tokenId, parseFloat(text) || 0);
    const applied = result.rows.find((r) => r.tokenId === tokenId)?.targetPct ?? 0;
    // A capped value shows the cap at once, as Composition's number field does.
    setPctEdit({ tokenId, text: result.clamped ? String(applied) : text });
    commit(result.rows);
  }

  function setTolerance(tokenId: TokenId, value: number) {
    commit(setDraftTokenTolerance(rows, tokenId, value));
  }

  function handleToleranceChange(tokenId: TokenId, raw: string) {
    // Integers only, like Composition: a fractional band cannot be typed.
    const text = raw.replace(/\D/g, "");
    setTolEdit({ tokenId, text });
    // An out-of-band number is kept so the rules flag it; the save gate blocks it.
    if (text !== "") setTolerance(tokenId, parseInt(text, 10));
  }

  function stepTolerance(tokenId: TokenId, current: number, delta: number) {
    const next = Math.min(TOLERANCE_MAX_PCT, Math.max(TOLERANCE_MIN_PCT, Math.round(current) + delta));
    setTolEdit(null);
    setTolerance(tokenId, next);
  }

  function handleLock(tokenId: TokenId) {
    const state = draftLockState(rows, tokenId);
    if (state.shown && !state.canToggle) {
      setLockHint(tokenId);
      return;
    }
    commit(toggleDraftTokenLock(rows, tokenId));
  }

  function leave(kind: Leave) {
    if (kind === "back" && onBack) onBack();
    else onClose();
  }

  // Every way out (the secondary button, Escape, the backdrop) comes through here.
  function requestLeave(kind: Leave) {
    if (view === "picker") {
      setView("editor");
      return;
    }
    if (confirmLeave) {
      setConfirmLeave(null);
      return;
    }
    if (dirty) setConfirmLeave(kind);
    else leave(kind);
  }

  const reasonMessage = (v: Exclude<NewPortfolioDraftValidation, { ok: true }>) =>
    draftValidationMessage(v, rows, t, te);

  const blockerText =
    blocker && !blocker.ok
      ? draftBlockerText(blocker, rows, t, te)
      : stocksBlocked
        ? te.stockRegionBlockedCreate
        : createBlockedReason;

  // The disabled-looking button stays focusable and, pressed, takes the user to the problem.
  function focusProblem(v: Exclude<NewPortfolioDraftValidation, { ok: true }>) {
    let target: HTMLElement | null = null;
    const index = v.tokenId ? rows.findIndex((r) => r.tokenId === v.tokenId) : -1;
    if (v.reason === "invalid-name") target = nameRef.current;
    else if (v.reason === "no-rows") target = addButtonRef.current;
    else if (index >= 0 && v.reason === "target-not-positive") target = document.getElementById(`draft-pct-${index}`);
    else if (index >= 0 && v.reason.startsWith("tolerance")) target = document.getElementById(`draft-tol-${index}`);
    if (!target) return;
    target.scrollIntoView?.({ block: "center" });
    target.focus({ preventScroll: true });
  }

  function handleSave() {
    if (!validation.ok) {
      focusProblem(validation);
      return;
    }
    if (stocksBlocked) return;
    const result = save(input, existingNames);
    if (result.ok) onSaved();
    else setSaveFailure(result);
  }

  function handleCreate() {
    if (!validation.ok) focusProblem(validation);
    else if (createBlockedReason === null && !stocksBlocked) setView("funds");
  }

  const nameInvalid = name !== "" && !validation.ok && validation.reason === "invalid-name";

  if (view === "funds") {
    return (
      <PresetReviewModal
        source={{ kind: "new", input }}
        existingNames={existingNames}
        onBack={(reviewedName) => {
          setName(reviewedName);
          setView("editor");
        }}
        onClose={onClose}
        onCreated={onCreated}
      />
    );
  }

  if (view === "picker") {
    return (
      <Modal titleId="draft-editor-title" onClose={() => requestLeave("close")} maxWidth="max-w-2xl" initialFocusRef={titleRef}>
        <DraftTokenPickerContent
          rows={rows}
          onAdd={handleAdd}
          onRemove={handleRemove}
          onBack={() => setView("editor")}
          titleId="draft-editor-title"
          titleRef={titleRef}
          searchRef={searchRef}
        />
      </Modal>
    );
  }

  return (
    <Modal titleId="draft-editor-title" onClose={() => requestLeave("close")} maxWidth="max-w-2xl" initialFocusRef={titleRef}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <h2 id="draft-editor-title" ref={titleRef} tabIndex={-1} className="text-lg font-semibold text-slate-100 focus:outline-none">
          {t.draftEditorTitle}
        </h2>
        {originPresetId ? (
          <span className="mt-1 rounded-full border border-slate-600 px-2 py-0.5 text-[11px] font-medium leading-none text-slate-300">
            {t.draftBasedOnPreset.replace("{preset}", t[PRESET_NAME_KEY[originPresetId]])}
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-sm text-slate-400">{funded === true ? t.draftEditorSubtitleFunded : t.draftEditorSubtitle}</p>
      {stocksBlocked ? (
        <p role="status" className="mt-3 rounded-xl border border-amber-300/40 bg-amber-300/10 px-3 py-2 text-xs leading-snug text-amber-200">
          {te.stockRegionBlockedCreate}
        </p>
      ) : null}

      {/* Name */}
      <label htmlFor="draft-editor-name" className="mt-4 mb-1.5 block text-sm font-medium text-slate-300">
        {t.portfolioNameLabel}
      </label>
      <input
        id="draft-editor-name"
        ref={nameRef}
        type="text"
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setSaveFailure(null);
        }}
        maxLength={PORTFOLIO_NAME_MAX_LENGTH}
        placeholder={t.portfolioNamePlaceholder}
        aria-invalid={nameInvalid}
        aria-describedby={nameInvalid ? "draft-editor-name-error" : "draft-editor-name-hint"}
        className={`w-full rounded-xl border bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 ${
          nameInvalid ? "border-rose-500" : "border-slate-700 focus:border-slate-500"
        }`}
      />
      <div className="mt-1 flex items-start justify-between gap-2">
        {nameInvalid && blocker && !blocker.ok ? (
          <p id="draft-editor-name-error" className="text-xs text-rose-400">
            {reasonMessage(blocker)}
          </p>
        ) : (
          <p id="draft-editor-name-hint" className="text-xs text-slate-400">
            {t.portfolioNameHint}
          </p>
        )}
        <span className="shrink-0 text-xs tabular-nums text-slate-400">
          {t.portfolioNameCounter
            .replace("{count}", String(name.length))
            .replace("{max}", String(PORTFOLIO_NAME_MAX_LENGTH))}
        </span>
      </div>

      {/* Target composition */}
      <section className="mt-5" aria-labelledby="draft-editor-composition">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="draft-editor-composition" className="text-[11px] font-semibold uppercase tracking-wide text-cyan-300">
            {t.presetReviewComposition}
          </h3>
          {rows.length > 0 ? <SumChip totalPct={totalPct} t={te} /> : null}
        </div>
        <p className="mt-1 flex items-center gap-1.5 text-xs text-slate-400">
          {t.presetToleranceQuestion}
          <InfoTooltip label={t.presetToleranceQuestion}>{t.presetToleranceTooltip}</InfoTooltip>
        </p>

        {rows.length > 0 ? (
          <div className="mt-3">
            <DraftCompositionBar rows={rows} colorOf={colorOf} />
          </div>
        ) : null}

        <div className="mt-3 rounded-2xl border border-slate-800 bg-slate-900">
          {rows.length > 0 ? (
            <div
              aria-hidden="true"
              className={`hidden border-b border-l-[3px] border-b-slate-800 border-l-transparent px-3 py-2 text-[11px] font-medium text-slate-400 ${ROW_GRID}`}
            >
              <span>{te.token}</span>
              <span>{te.target}</span>
              <span />
              <span>{te.band}</span>
              <span />
            </div>
          ) : null}
          {rows.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-slate-400">{te.ruleEmptyComposition}</p>
          ) : (
            <ul className="divide-y divide-slate-800">
              {rows.map((row, index) => {
                const symbol = symbolFor(row.tokenId);
                const single = rows.length === 1;
                const lock = draftLockState(rows, row.tokenId);
                const pctInvalid = row.targetPct <= 0;
                const tolViolation = toleranceViolations[row.tokenId];
                const tolIsError = tolViolation?.severity === "error";
                const atCeiling =
                  !row.locked && rows.length > 2 && draftRowCeiling(rows, row.tokenId) < 100 &&
                  row.targetPct >= draftRowCeiling(rows, row.tokenId) - 0.01;
                const messages: { text: string; tone: "error" | "warn" }[] = [];
                if (pctInvalid) messages.push({ text: t.draftTargetNotPositive, tone: "error" });
                else if (atCeiling) messages.push({ text: te.maxAtLockedCeiling, tone: "warn" });
                if (tolViolation) {
                  messages.push({ text: ruleMessage(te, tolViolation.code), tone: tolIsError ? "error" : "warn" });
                }
                if (lockHint === row.tokenId) messages.push({ text: t.draftMinTwoUnlocked, tone: "warn" });
                const msgId = `draft-row-${index}-msg`;
                const describedBy = messages.length > 0 ? msgId : undefined;
                const pctText = pctEdit?.tokenId === row.tokenId ? pctEdit.text : String(row.targetPct);
                const tolText = tolEdit?.tokenId === row.tokenId ? tolEdit.text : String(Math.round(row.tolerancePct));

                return (
                  <li
                    key={row.tokenId}
                    className={`border-l-[3px] px-3 py-2.5 ${ROW_GRID}`}
                    style={{ borderLeftColor: colorOf(row.tokenId).hex }}
                  >
                    {/* Line 1 below sm: token · remove. `sm:contents` hands both to the row grid. */}
                    <div className="flex items-center gap-2 sm:contents">
                      <div className="flex min-w-0 flex-1 items-center gap-2 sm:order-1">
                        <TokenAvatar
                          symbol={symbol}
                          size={22}
                          className="rounded-full"
                          style={{ backgroundColor: `${colorOf(row.tokenId).hex}22` }}
                        />
                        <span className="min-w-0">
                          <span className="flex items-center gap-1.5">
                            <span className="text-sm font-semibold text-slate-100">{symbol}</span>
                            <StockRowChip tokenId={row.tokenId} t={te} />
                          </span>
                          <span className="block truncate text-[11px] text-slate-400">{tokenNameFor(row.tokenId)}</span>
                        </span>
                      </div>
                      <button
                        id={`draft-remove-${index}`}
                        type="button"
                        onClick={() => handleRemove(row.tokenId)}
                        aria-label={`${t.presetReviewRemoveToken} ${symbol}`}
                        className={`${ICON_BUTTON} text-rose-400/70 hover:bg-slate-800 hover:text-rose-300 sm:order-5 sm:justify-self-end`}
                      >
                        <X aria-hidden="true" className="h-4 w-4" />
                      </button>
                    </div>

                    {/* Line 2 below sm: target % · lock · tolerance. */}
                    <div className="mt-2 flex items-center gap-2 sm:mt-0 sm:contents">
                      <div className="w-24 sm:order-2 sm:w-full">
                        {single ? (
                          <p className={`${FIELD_BOX} border-transparent px-0 tabular-nums text-slate-300`}>100%</p>
                        ) : (
                          <div
                            className={`${FIELD_BOX} ${
                              row.locked
                                ? "border-slate-800 bg-slate-900/50"
                                : pctInvalid
                                  ? "border-rose-400/60 bg-rose-400/5 focus-within:border-rose-300"
                                  : "border-slate-700 bg-slate-950 focus-within:border-cyan-300"
                            }`}
                          >
                            <input
                              id={`draft-pct-${index}`}
                              type="text"
                              inputMode="decimal"
                              value={pctText}
                              disabled={row.locked}
                              onFocus={() => setPctEdit({ tokenId: row.tokenId, text: String(row.targetPct) })}
                              onChange={(e) => handlePctChange(row.tokenId, e.target.value)}
                              onBlur={() => setPctEdit(null)}
                              aria-label={`${te.target} ${symbol}`}
                              aria-invalid={pctInvalid}
                              aria-describedby={describedBy}
                              className="w-full min-w-0 bg-transparent text-sm tabular-nums text-slate-100 outline-none disabled:cursor-not-allowed disabled:text-slate-500"
                            />
                            <span className="ml-1 text-sm text-slate-400">%</span>
                          </div>
                        )}
                      </div>

                      <div className="h-11 w-11 shrink-0 sm:order-3 sm:h-9 sm:w-9">
                        {lock.shown ? (
                          <button
                            type="button"
                            onClick={() => handleLock(row.tokenId)}
                            aria-label={`${row.locked ? te.locked : te.unlocked} ${symbol}`}
                            aria-pressed={row.locked}
                            aria-disabled={!lock.canToggle}
                            aria-describedby={lockHint === row.tokenId ? msgId : undefined}
                            className={`${ICON_BUTTON} border ${
                              row.locked
                                ? "border-cyan-300/50 bg-cyan-300/10 text-cyan-200"
                                : "border-slate-700 text-slate-400 hover:border-slate-500 hover:text-white"
                            } ${lock.canToggle ? "" : "opacity-40"}`}
                          >
                            {row.locked ? (
                              <Lock aria-hidden="true" className="h-3.5 w-3.5" />
                            ) : (
                              <LockOpen aria-hidden="true" className="h-3.5 w-3.5" />
                            )}
                          </button>
                        ) : null}
                      </div>

                      <div className="w-[6.5rem] sm:order-4 sm:w-full">
                        <div
                          className={`${FIELD_BOX} px-2 focus-within:border-cyan-300 ${
                            tolIsError
                              ? "border-rose-400/60 bg-rose-400/5"
                              : tolViolation
                                ? "border-amber-400/60 bg-amber-400/5"
                                : "border-slate-700 bg-slate-950"
                          }`}
                        >
                          <span className="mr-1 text-sm text-slate-400" aria-hidden="true">±</span>
                          <input
                            id={`draft-tol-${index}`}
                            type="text"
                            inputMode="numeric"
                            value={tolText}
                            onFocus={() => setTolEdit({ tokenId: row.tokenId, text: tolText })}
                            onChange={(e) => handleToleranceChange(row.tokenId, e.target.value)}
                            onBlur={() => setTolEdit(null)}
                            onKeyDown={(e) => {
                              if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                                e.preventDefault();
                                stepTolerance(row.tokenId, row.tolerancePct, e.key === "ArrowUp" ? 1 : -1);
                              }
                            }}
                            aria-label={`${te.band} ${symbol}`}
                            aria-invalid={tolIsError}
                            aria-describedby={describedBy}
                            className="w-full min-w-0 bg-transparent text-sm tabular-nums text-slate-100 outline-none"
                          />
                          <span className="ml-1 text-sm text-slate-400">%</span>
                          {/* Pointer steppers from sm up only: 14 px is no touch target. */}
                          <span className="ml-1 hidden flex-col sm:flex">
                            <button
                              type="button"
                              tabIndex={-1}
                              onClick={() => stepTolerance(row.tokenId, row.tolerancePct, 1)}
                              aria-label={`${te.toleranceIncrease} ${symbol}`}
                              className="flex h-3.5 w-4 items-center justify-center text-slate-500 hover:text-slate-200 focus:outline-none"
                            >
                              <svg width="8" height="5" viewBox="0 0 8 5" fill="currentColor" aria-hidden="true"><path d="M4 0L8 5H0L4 0Z" /></svg>
                            </button>
                            <button
                              type="button"
                              tabIndex={-1}
                              onClick={() => stepTolerance(row.tokenId, row.tolerancePct, -1)}
                              aria-label={`${te.toleranceDecrease} ${symbol}`}
                              className="flex h-3.5 w-4 items-center justify-center text-slate-500 hover:text-slate-200 focus:outline-none"
                            >
                              <svg width="8" height="5" viewBox="0 0 8 5" fill="currentColor" aria-hidden="true"><path d="M4 5L0 0H8L4 5Z" /></svg>
                            </button>
                          </span>
                        </div>
                      </div>
                    </div>

                    {messages.length > 0 ? (
                      <div id={msgId} className="mt-1.5 space-y-0.5 sm:order-6 sm:col-span-4 sm:col-start-2 sm:mt-1">
                        {messages.map((m) => (
                          <p
                            key={m.text}
                            className={`text-[11px] leading-snug ${m.tone === "error" ? "text-rose-300" : "text-amber-300"}`}
                          >
                            {m.text}
                          </p>
                        ))}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <button
          ref={addButtonRef}
          type="button"
          onClick={() => setView("picker")}
          className="mt-3 inline-flex min-h-[2.75rem] w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-slate-600 px-4 text-sm font-medium text-slate-200 transition hover:border-cyan-400/60 hover:text-cyan-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 sm:w-auto sm:min-h-0 sm:py-2"
        >
          <Plus aria-hidden="true" className="h-4 w-4" />
          {t.draftAddToken}
        </button>
        {notice ? <p className="mt-2 text-[11px] leading-snug text-amber-300">{notice}</p> : null}
      </section>

      {rows.length > 0 ? (
        <NewPortfolioDraftSimulation
          rows={rows}
          colorOf={colorOf}
          initialUsd={simulationUsd}
          onAmountChange={setSimulationUsd}
        />
      ) : null}

      {/* One polite region, always mounted: lock feedback is otherwise only visual. */}
      <div role="status" aria-live="polite" className="sr-only">
        {notice ?? (lockHint ? t.draftMinTwoUnlocked : "")}
      </div>

      {/* D-504: no "not financial advice" line here — the Simulation's note under the list says it. */}

      {/* Sticky footer: the save blocker stays visible wherever the row at fault is. The
          negative margins cancel the Modal's p-6 so it sits flush with the dialog edge. */}
      <div className="sticky -bottom-6 z-10 -mx-6 -mb-6 mt-5 border-t border-slate-800 bg-slate-950 px-6 pb-6 pt-3">
        {savedDraftName !== null && !confirmLeave ? (
          <p className="mb-2 text-xs leading-snug text-slate-400">
            {t.draftAlreadySaved.replace("{name}", () => savedDraftName)}
          </p>
        ) : null}
        {blockerText ? (
          <p id="draft-editor-blocker" className="mb-2 text-xs leading-snug text-amber-200">
            {blockerText}
          </p>
        ) : null}
        {confirmLeave ? (
          <div role="group" aria-labelledby="draft-editor-leave" className="flex flex-wrap items-center justify-between gap-3">
            <p id="draft-editor-leave" className="text-sm font-medium text-slate-200">
              {t.unsavedChangesTitle}
            </p>
            <div className="flex gap-2">
              <button type="button" onClick={() => leave(confirmLeave)} className={SECONDARY_BUTTON}>
                {t.unsavedChangesDiscard}
              </button>
              <button
                ref={keepEditingRef}
                type="button"
                onClick={() => setConfirmLeave(null)}
                className="rounded-xl bg-cyan-300 px-4 py-2 text-sm font-semibold text-black transition hover:bg-cyan-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
              >
                {t.draftKeepEditing}
              </button>
            </div>
          </div>
        ) : (
          // Three buttons do not fit in a row at 390 px: there the main one takes its own, on top.
          <div className="flex flex-wrap items-center justify-between gap-3">
            <button
              ref={backButtonRef}
              type="button"
              onClick={() => requestLeave(onBack ? "back" : "close")}
              className={`${SECONDARY_BUTTON} ${offersSaveDraft ? "order-2 sm:order-none sm:mr-auto" : ""}`}
            >
              {onBack ? t.presetReviewBack : t.cancel}
            </button>
            {offersSaveDraft ? (
              <button type="button" onClick={handleSave} className={`${SAVE_DRAFT_BUTTON} order-3 sm:order-none`}>
                {t.draftSaveDraft}
              </button>
            ) : null}
            <button
              ref={primaryButtonRef}
              type="button"
              onClick={createsPortfolio ? handleCreate : handleSave}
              aria-disabled={!primaryEnabled}
              aria-describedby={blockerText ? "draft-editor-blocker" : undefined}
              className={`rounded-xl bg-cyan-300 px-4 py-2 text-sm font-semibold text-black transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 ${
                offersSaveDraft ? "order-1 w-full sm:order-none sm:w-auto" : ""
              } ${primaryEnabled ? "hover:bg-cyan-200" : "cursor-not-allowed opacity-40"}`}
            >
              {createsPortfolio || signedOut ? t.draftCreate : t.draftSaveDraft}
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
