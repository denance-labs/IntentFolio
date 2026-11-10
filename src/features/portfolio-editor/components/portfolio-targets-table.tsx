"use client";

import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { appPortalRoot } from "@/features/world/portal-root";
import type { ComputedTargetAllocation, TargetAllocation } from "../types";
import { getBandStateClass } from "../lib/calculations";
import { colorForSymbol, formatCrypto, formatTokenAmount, formatUsd, type RingColor } from "../lib/format";
import { RULE_MESSAGE_KEYS, type RuleViolation } from "../lib/validation";
import { placeRemovedRows, type PendingMarks, type RemovedRowMark, type RowMark } from "../lib/changeset";
import { getTokenById } from "@/features/market/lib/token-registry";
import { NO_BUY_ROUTE_TOKEN_IDS, isPortfolioOfferable } from "@/features/bridge/lib/token-availability";
import { TOLERANCE_MIN_PCT, TOLERANCE_MAX_PCT } from "@/features/intents-account/mock-contract/rules";
import { MiniBand, MiniBandLegend } from "./mini-band";
import { InfoTooltip } from "./portfolio-primitives";

type PortfolioTargetsTableProps = {
  t: Record<string, string>;
  rows: ComputedTargetAllocation[];
  colorByToken?: Map<string, RingColor>;
  isEditing: boolean;
  allLocked: boolean;
  allUnlocked: boolean;
  // Per-row validation from the shared rules engine, keyed by tokenId.
  rowViolations?: Record<string, RuleViolation[]>;
  // 021 R2: what Save would sign, marked on the rows while a draft is open.
  pending?: PendingMarks | null;
  onUndoRemove?: (tokenId: string) => void;
  onUpdateTarget: (id: string, patch: Partial<TargetAllocation>) => void;
  onUpdateTargetPct: (id: string, nextPct: number | string) => void;
  onPromoteHeld: (tokenId: string, nextPct: number | string) => void;
  onToggleLock: (id: string) => void;
  onLockAll: () => void;
  onUnlockAll: () => void;
  onWithdraw: (target: ComputedTargetAllocation) => void;
};

type TargetRowProps = {
  target: ComputedTargetAllocation;
  t: Record<string, string>;
  rowColor: RingColor;
  isEditing: boolean;
  canToggleLock: boolean;
  lockBlockedReason: string;
  // 027 A-11: why "Remove" is blocked on this row, or "" when it is not.
  removeBlockedReason: string;
  maxAllowedPct: number;
  violations: RuleViolation[];
  mark?: RowMark;
  balanceMove?: number;
  onUpdate: (id: string, patch: Partial<TargetAllocation>) => void;
  onUpdatePct: (id: string, nextPct: number | string) => void;
  onPromoteHeld: (tokenId: string, nextPct: number | string) => void;
  onToggleLock: (id: string) => void;
  onWithdraw: (target: ComputedTargetAllocation) => void;
  // 027 A-1: the row's "can't toggle" balloon opened; the header buttons flash.
  onLockBlockedShown: () => void;
};

function LockIcon({ locked }: { locked: boolean }) {
  if (locked) {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="4" y="11" width="16" height="9" rx="2" />
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </svg>
    );
  }

  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="11" width="16" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 7.5-2" />
    </svg>
  );
}

// One column template for the header, the rows and the removed rows, so they stay aligned.
// D-452: Status is 100 px (was 88) so "On target" / "En objetivo" fits its pill on one line.
// 027 A-8: Lock is 64 px (was 48): the header's two bordered buttons are 60 px and touched
// the column rules.
const COLUMNS = "grid-cols-[152px_80px_88px_84px_185px_110px_100px_64px_minmax(max-content,1fr)]";
// 027 A-8: which columns get a vertical rule on their left. Not the first, and not the
// slider: the target % and its slider are one value under one header, so they stay grouped.
const COLUMN_RULES = [false, true, true, true, false, true, true, true, true];

// D-451: the target % field shows at most two decimals. Redistributing (typing a %, removing,
// undoing) leaves values like 54.5454…, and the 84 px field showed "54.!" — not the % to be
// signed. Display only: the stored value is untouched until the user types one.
function pctFieldText(pct: number): string {
  return String(Math.round(pct * 100) / 100);
}

// 021 R2: a value the draft changes, shown struck under the field that holds the new one.
function PreviousValue({ label, value }: { label: string; value: string }) {
  return (
    <p className="mt-1 truncate text-[10px] leading-3 text-slate-400 tabular-nums">
      <span className="sr-only">{label} </span>
      <s>{value}</s>
    </p>
  );
}

// 021 R2: funds the commit moves for this token, next to what it holds. The amount alone,
// as the confirm modal shows it: the row already names the token, and the column is narrow.
function BalanceMove({ qty, symbol, t }: { qty: number; symbol: string; t: Record<string, string> }) {
  const amount = `${qty > 0 ? "+" : "−"}${formatCrypto(Math.abs(qty))}`;
  return (
    <p className={`mt-1 truncate text-[10px] leading-3 tabular-nums ${qty > 0 ? "text-emerald-300" : "text-amber-300"}`} title={`${amount} ${symbol}`}>
      <span className="sr-only">{qty > 0 ? t.pendingMoveIn : t.pendingMoveOut}: </span>
      {amount}
      <span className="sr-only"> {symbol}</span>
    </p>
  );
}

// 021 R2: a committed token the draft removes stays where it was, struck and dimmed, with
// "Undo" in place of the row action until Save signs the removal.
function RemovedRow({ removed, t, rowColor, balanceMove, onUndo }: {
  removed: RemovedRowMark;
  t: Record<string, string>;
  rowColor: RingColor;
  balanceMove?: number;
  onUndo?: (tokenId: string) => void;
}) {
  const name = getTokenById(removed.tokenId)?.name;
  return (
    <div data-pending="removed" className={`grid ${COLUMNS} items-center gap-4 border-l-2 border-l-transparent px-4 py-2 text-sm [&>div]:min-w-0`}>
      <div className="opacity-60">
        <div className="rounded-xl border border-slate-700 bg-card px-3 py-2" style={{ borderLeftColor: rowColor.hex, borderLeftWidth: "3px" }}>
          <p className="truncate font-semibold text-slate-100"><s>{removed.symbol}</s></p>
          <p className="mt-0.5 truncate text-[11px] text-slate-400">{name}</p>
        </div>
      </div>
      <div>
        <p className="font-semibold tabular-nums text-slate-400 opacity-60">—</p>
        {balanceMove ? <BalanceMove qty={balanceMove} symbol={removed.symbol} t={t} /> : null}
      </div>
      <div className="opacity-60">
        <p className="font-semibold tabular-nums text-slate-400">—</p>
      </div>
      <div className="opacity-60">
        <p className="font-semibold tabular-nums text-slate-300">
          <span className="sr-only">{t.pendingPrevious} </span>
          <s>{removed.fromPct.toFixed(1)}%</s>
        </p>
      </div>
      <div />
      {/* D-514: a 0% target had no range to strike. */}
      <div className="pl-3 opacity-60">
        {removed.fromPct > 0 ? (
          <p className="font-medium tabular-nums text-slate-300">
            <span className="sr-only">{t.pendingPrevious} </span>
            <s>±{Math.round(removed.fromBand)}%</s>
          </p>
        ) : null}
      </div>
      <div>
        <span className="flex w-full items-center justify-center rounded-full border border-rose-400/40 bg-rose-400/10 px-2.5 py-1 text-center text-[11px] font-medium text-rose-200">
          {t.pendingRemoving}
        </span>
      </div>
      <div />
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => onUndo?.(removed.tokenId)}
          aria-label={t.pendingUndoAria.replace("{symbol}", removed.symbol)}
          className="whitespace-nowrap rounded-xl border border-slate-700 px-3 py-2 text-xs text-slate-200 transition hover:border-accent/50 hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          {t.pendingUndo}
        </button>
      </div>
    </div>
  );
}

function TargetRow({ target, t, rowColor, isEditing, canToggleLock, lockBlockedReason, removeBlockedReason, maxAllowedPct, violations, mark, balanceMove, onUpdate, onUpdatePct, onPromoteHeld, onToggleLock, onWithdraw, onLockBlockedShown }: TargetRowProps) {
  // T14: with nothing held the click only drops the target, so the label says so. Quantity,
  // not USD: a priced-at-0 token still holds a balance (D-322).
  const isEmpty = target.currentQty === 0;
  const withdrawLabel = isEmpty ? t.removeEmpty : t.remove;
  const withdrawAriaLabel = isEmpty
    ? `${t.removeEmpty} ${target.symbol}`
    : t.unallocateTitle.replace("{symbol}", target.symbol);
  // D-143(1): held-but-untargeted rows show current X% / target 0%. D-513: they look like a
  // 0% target row (bar, mini-band, status) because they are sold whole like one. Their %
  // field and bar promote the token into a real target as the user types or drags
  // (onPromoteHeld); the row keeps its place until Save (usePortfolioComputed), so nothing
  // moves under the cursor. The lock and the tolerance wait for the promotion: `rowEditing`
  // keeps the `!heldNoTarget` guard while `targetEditable` opens the % field and the bar.
  const heldNoTarget = Boolean(target.heldNoTarget);
  const rowEditing = isEditing && !heldNoTarget;
  // D-477: a held token outside the catalog (D-396/D-389) can't be promoted — the same
  // set "Add tokens to portfolio" shows as "Not available yet".
  const heldNotOfferable = heldNoTarget && !isPortfolioOfferable(target.tokenId);
  const targetEditable = isEditing && !heldNotOfferable;
  // D-491: a real target with no buy route only goes down (allocation.ts `canGrow`).
  const noBuyTarget = !heldNoTarget && NO_BUY_ROUTE_TOKEN_IDS.has(target.tokenId);
  const atLockedCeiling = rowEditing && !target.locked && maxAllowedPct < 100 && Number(target.targetPct) >= maxAllowedPct - 0.01;
  const lockBtnRef = useRef<HTMLButtonElement | null>(null);
  const [lockTooltipPos, setLockTooltipPos] = useState<{ top: number; left: number } | null>(null);
  const showLockTooltip = () => {
    if (!lockBtnRef.current) return;
    const rect = lockBtnRef.current.getBoundingClientRect();
    setLockTooltipPos({ top: rect.top + rect.height / 2, left: rect.right });
    onLockBlockedShown();
  };
  const hideLockTooltip = () => setLockTooltipPos(null);
  const removeBtnRef = useRef<HTMLButtonElement | null>(null);
  const [removeTooltipPos, setRemoveTooltipPos] = useState<{ top: number; left: number } | null>(null);
  const showRemoveTooltip = () => {
    if (!removeBtnRef.current) return;
    const rect = removeBtnRef.current.getBoundingClientRect();
    setRemoveTooltipPos({ top: rect.top - 6, left: rect.right });
  };
  const hideRemoveTooltip = () => setRemoveTooltipPos(null);
  // Tolerance is an integer percentage (no decimals): the draft mirrors the stored value
  // rounded to a whole number, and the input only accepts digits.
  const toleranceStr = typeof target.tolerancePct === "number" ? String(Math.round(target.tolerancePct)) : "";
  const [toleranceDraft, setToleranceDraft] = useState(toleranceStr);
  useEffect(() => { setToleranceDraft(toleranceStr); }, [toleranceStr]);

  // D-451: what the user is typing in the target % field, while they type. It is shown only
  // while it still reads as the stored value ("54." while typing "54.5"); once the editor
  // clamps it (above a locked ceiling) the stored value shows instead, as before.
  const [typedPct, setTypedPct] = useState<string | null>(null);
  const shownPct =
    typedPct !== null && Number(typedPct) === Number(target.targetPct) ? typedPct : pctFieldText(Number(target.targetPct));

  // D-514: a 0% target is sold whole (band [0, 0]), so while it holds anything it is not
  // "Over": it is being sold for the other tokens, said in plain text instead of a pill.
  // A held row without a target is one too (D-513).
  const zeroTarget = target.targetPct === 0;
  const selling = zeroTarget && target.bandState === "above";
  const statusLabel = target.bandState === "below" ? t.belowTarget : target.bandState === "above" ? t.aboveTarget : target.bandState === "empty" ? "—" : t.insideBand;
  const statusIcon = target.bandState === "below" ? "▼" : target.bandState === "above" ? "▲" : target.bandState === "inside" ? "●" : "";
  const isOutOfBand = target.bandState === "below" || target.bandState === "above";
  const isBandClamped = target.hasToken && target.minPct === 0 && target.targetPct < (typeof target.tolerancePct === "number" ? target.tolerancePct : 0);

  const toleranceNum = typeof target.tolerancePct === "number" ? target.tolerancePct : 0;
  const toleranceInt = Math.round(toleranceNum);

  // Per-row feedback comes from the shared rules engine (single source of truth).
  // Tolerance signals sit under the band field; the zero-target/zero-balance error
  // sits under the target field.
  const toleranceViolation = rowEditing
    ? violations.find(
        (v) =>
          v.code === "tolerance-below-min" ||
          v.code === "tolerance-above-max" ||
          v.code === "tolerance-high"
      )
    : undefined;
  const toleranceIsError = toleranceViolation?.severity === "error";
  const toleranceMessage = toleranceViolation ? t[RULE_MESSAGE_KEYS[toleranceViolation.code]] : null;
  const targetError = rowEditing
    ? violations.find((v) => v.code === "zero-target-zero-balance")
    : undefined;
  // A no-buy row can't be given a target or (RHEA, SWEAT) a balance: only "remove it" is honest.
  const targetErrorMessage = targetError
    ? noBuyTarget ? t.ruleZeroTargetNoBuy : t[RULE_MESSAGE_KEYS[targetError.code]]
    : null;
  const previousPct = mark?.kind === "changed" ? mark.fromPct : null;
  const previousBand = mark?.kind === "changed" ? mark.fromBand : null;

  return (
    <div className={`grid ${COLUMNS} items-center gap-4 px-4 py-2 text-sm transition [&>div]:min-w-0 ${
      isOutOfBand ? "bg-slate-400/[0.02] border-l-2 border-l-slate-500/30" : "border-l-2 border-l-transparent"
    }`}>
      <div>
        <div className="group/token relative rounded-xl border border-slate-700 bg-card px-3 py-2" style={{ borderLeftColor: rowColor.hex, borderLeftWidth: "3px" }}>
          <div className="flex items-center gap-1.5 overflow-hidden">
            <p className="truncate font-semibold text-slate-100">{target.symbol}</p>
            {mark?.kind === "added" ? (
              <span className="shrink-0 rounded border border-emerald-400/40 bg-emerald-400/10 px-1 text-[9px] font-semibold uppercase leading-4 tracking-wide text-emerald-200">
                {t.pendingNew}
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 truncate text-[11px] text-slate-400">{target.token?.name}</p>
          <p className="mt-0.5 truncate text-[11px] tabular-nums text-slate-400">{target.hasToken ? formatUsd(target.token?.usdPrice || 0) : "—"}</p>
          <span
            role="tooltip"
            className="pointer-events-none absolute left-full top-1/2 z-30 ml-2 hidden -translate-y-1/2 whitespace-nowrap rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-[11px] text-slate-200 shadow-2xl group-hover/token:block"
          >
            <span className="font-semibold text-slate-100">{target.symbol}</span>
            {target.token?.name ? <span className="ml-1.5 text-slate-400">· {target.token.name}</span> : null}
          </span>
        </div>
      </div>

      <div>
        <p className="font-semibold tabular-nums">{target.hasToken ? formatUsd(target.currentUsd) : "—"}</p>
        {balanceMove ? <BalanceMove qty={balanceMove} symbol={target.symbol} t={t} /> : null}
      </div>

      <div>
        <p className="font-semibold tabular-nums">{target.hasToken ? `${target.currentPct.toFixed(1)}%` : "—"}</p>
        <p className="mt-1 truncate text-[10px] leading-3 text-slate-400 tabular-nums" title={target.hasToken ? `${formatTokenAmount(target.currentUsd / (target.token?.usdPrice || 1), target.token?.usdPrice || 0)} ${target.symbol}` : ""}>
          {target.hasToken ? `${formatTokenAmount(target.currentUsd / (target.token?.usdPrice || 1), target.token?.usdPrice || 0)} ${target.symbol}` : ""}
        </p>
        <p className="truncate text-[10px] leading-3 text-slate-400 tabular-nums" title={target.hasToken ? formatUsd(target.currentUsd) : ""}>
          {target.hasToken ? formatUsd(target.currentUsd) : ""}
        </p>
      </div>

      {/* Target % — editable (incl. held rows → promote) or read-only */}
      <div className="relative">
        {targetEditable ? (
          <div className={`flex items-center rounded-xl border px-3 py-2 transition ${target.locked ? "border-slate-800 bg-slate-900/50" : "border-slate-700 bg-slate-900 focus-within:border-accent"}`}>
            <input
              type="number"
              min="0"
              max="100"
              value={shownPct}
              disabled={target.locked}
              onChange={(event) => {
                setTypedPct(event.target.value);
                if (heldNoTarget) onPromoteHeld(target.tokenId, event.target.value);
                else onUpdatePct(target.id, event.target.value);
              }}
              onBlur={() => setTypedPct(null)}
              aria-label={`${t.target} ${target.symbol}`}
              // D-451: no spin buttons — Chrome reserves their width even hidden, which left
              // ~30 px for the figure. The slider beside it does the stepping.
              className="w-full min-w-0 bg-transparent tabular-nums outline-none [appearance:textfield] disabled:cursor-not-allowed disabled:text-slate-500 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
            <span className="ml-1 text-slate-400">%</span>
          </div>
        ) : (
          <p className="font-semibold tabular-nums text-slate-100">{target.targetPct.toFixed(1)}%</p>
        )}
        {previousPct !== null ? <PreviousValue label={t.pendingPrevious} value={`${previousPct.toFixed(1)}%`} /> : null}
        {targetErrorMessage ? (
          // D-341: the 84 px column wrapped this hint to four lines. It runs under the slider
          // column instead (84 + 16 gap + 185), below the row's centered controls.
          <p className="absolute left-0 top-full mt-1 w-[285px] text-[10px] leading-tight text-rose-300">{targetErrorMessage}</p>
        ) : atLockedCeiling ? (
          <p className="mt-1 text-[10px] leading-3 text-amber-300">{t.maxAtLockedCeiling}</p>
        ) : isEditing && heldNotOfferable ? (
          <p className="mt-1 text-[10px] leading-3 text-amber-400">{t.addTokensNotAvailableYet}</p>
        ) : (
          <>
            <p className="mt-1 truncate text-[10px] leading-3 text-slate-400 tabular-nums">
              {target.hasToken ? `${formatTokenAmount(target.cryptoAmount, target.token?.usdPrice || 0)} ${target.symbol}` : ""}
            </p>
            <p className="truncate text-[10px] leading-3 text-slate-400 tabular-nums">
              {target.hasToken ? formatUsd(target.targetUsd) : ""}
            </p>
            {isEditing && noBuyTarget ? (
              <p className="mt-0.5 text-[10px] leading-3 text-amber-400">{t.targetOnlyGoesDown}</p>
            ) : null}
          </>
        )}
      </div>

      {/* Slider + MiniBand. D-513: on a held row the slider promotes the token as it moves;
          the row keeps its place, so the drag goes on uninterrupted. */}
      <div>
        {targetEditable && (
          <input
            type="range"
            min="0"
            max="100"
            step="1"
            value={target.targetPct || 0}
            onChange={(event) =>
              heldNoTarget
                ? onPromoteHeld(target.tokenId, Number(event.target.value))
                : onUpdatePct(target.id, Number(event.target.value))
            }
            className="w-full accent-accent disabled:opacity-40"
            disabled={target.locked}
            aria-label={`${t.slider} ${target.symbol}`}
          />
        )}
        {target.hasToken ? (
          <MiniBand
            minPct={target.minPct}
            targetPct={target.targetPct}
            maxPct={target.maxPct}
            currentPct={target.currentPct}
            state={target.bandState}
            canRise={!noBuyTarget}
            label={(target.bandState === "empty" ? t.miniBandAriaEmpty : t.miniBandAria)
              .replace("{current}", target.currentPct.toFixed(1))
              .replace("{target}", target.targetPct.toFixed(1))
              .replace("{min}", target.minPct.toFixed(1))
              .replace("{max}", target.maxPct.toFixed(1))}
          />
        ) : null}
      </div>

      {/* Tolerance — editable or read-only. D-514: hidden at a 0% target, which has no range;
          the stored value comes back with the target, and the field shows only for an error
          the Save gate would block on. */}
      <div className="pl-3">
        {zeroTarget && !toleranceIsError ? null : rowEditing ? (
          <>
            <div className={`flex items-center rounded-xl border px-2 py-2 transition focus-within:border-accent ${toleranceIsError ? "border-rose-400/60 bg-rose-400/5" : toleranceViolation ? "border-amber-400/60 bg-amber-400/5" : "border-slate-700 bg-slate-900"}`}>
              <span className="mr-1 text-slate-400" aria-hidden="true">±</span>
              <input
                type="text"
                inputMode="numeric"
                value={toleranceDraft}
                onChange={(event) => {
                  // Integers only — drop anything that isn't a digit (no ',' or '.').
                  const raw = event.target.value.replace(/\D/g, "");
                  setToleranceDraft(raw);
                  // Commit the typed value as-is (no snapping). An out-of-band number is
                  // kept so the rules engine flags it and the Save gate blocks it.
                  if (raw !== "") {
                    const parsed = parseInt(raw, 10);
                    if (!isNaN(parsed)) onUpdate(target.id, { tolerancePct: parsed });
                  }
                }}
                onBlur={(event) => {
                  const parsed = parseInt(event.target.value, 10);
                  if (!isNaN(parsed)) onUpdate(target.id, { tolerancePct: parsed });
                  else setToleranceDraft(toleranceStr);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") { (event.target as HTMLInputElement).blur(); return; }
                  // Block decimal separators outright so a fractional band can't be typed.
                  if (event.key === "." || event.key === ",") { event.preventDefault(); return; }
                  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                    event.preventDefault();
                    const delta = event.key === "ArrowUp" ? 1 : -1;
                    const next = Math.min(TOLERANCE_MAX_PCT, Math.max(TOLERANCE_MIN_PCT, toleranceInt + delta));
                    setToleranceDraft(String(next));
                    onUpdate(target.id, { tolerancePct: next });
                  }
                }}
                aria-label={`${t.band} ${target.symbol}`}
                className="w-full bg-transparent tabular-nums outline-none"
              />
              <span className="ml-1 text-slate-400">%</span>
              <div className="ml-1 flex flex-col">
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => {
                    const next = Math.min(TOLERANCE_MAX_PCT, toleranceInt + 1);
                    setToleranceDraft(String(next));
                    onUpdate(target.id, { tolerancePct: next });
                  }}
                  className="flex h-3.5 w-4 items-center justify-center text-slate-500 hover:text-slate-200 focus:outline-none"
                  aria-label={t.toleranceIncrease}
                >
                  <svg width="8" height="5" viewBox="0 0 8 5" fill="currentColor"><path d="M4 0L8 5H0L4 0Z"/></svg>
                </button>
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => {
                    const next = Math.max(TOLERANCE_MIN_PCT, toleranceInt - 1);
                    setToleranceDraft(String(next));
                    onUpdate(target.id, { tolerancePct: next });
                  }}
                  className="flex h-3.5 w-4 items-center justify-center text-slate-500 hover:text-slate-200 focus:outline-none"
                  aria-label={t.toleranceDecrease}
                >
                  <svg width="8" height="5" viewBox="0 0 8 5" fill="currentColor"><path d="M4 5L0 0H8L4 5Z"/></svg>
                </button>
              </div>
            </div>
            {previousBand !== null ? <PreviousValue label={t.pendingPrevious} value={`±${Math.round(previousBand)}%`} /> : null}
            {toleranceMessage ? (
              <p className={`mt-1 text-[10px] leading-tight ${toleranceIsError ? "text-rose-300" : "text-amber-300"}`}>{toleranceMessage}</p>
            ) : (
              <p className="mt-1 truncate text-[10px] leading-3 text-slate-400 tabular-nums">
                {target.hasToken ? `${target.minPct.toFixed(1)}% – ${target.maxPct.toFixed(1)}%${isBandClamped ? " *" : ""}` : ""}
              </p>
            )}
          </>
        ) : (
          <>
            <p className="font-medium tabular-nums text-slate-200">±{toleranceInt}%</p>
            <p className="mt-1 truncate text-[10px] leading-3 text-slate-400 tabular-nums">
              {target.hasToken ? `${target.minPct.toFixed(1)}% – ${target.maxPct.toFixed(1)}%${isBandClamped ? " *" : ""}` : ""}
            </p>
          </>
        )}
      </div>


      <div>
        {selling ? (
          <p className="text-center text-[11px] font-medium leading-tight text-violet-300" aria-label={`${t.status}: ${t.zeroTargetSelling}`}>
            {t.zeroTargetSelling}
          </p>
        ) : (
          <span className={`flex w-full items-center justify-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-1 text-center text-[11px] font-medium ${getBandStateClass(target.bandState)}`} aria-label={`${t.status}: ${statusLabel}`}>
            {statusIcon ? <span aria-hidden="true">{statusIcon}</span> : null}
            {statusLabel}
          </span>
        )}
      </div>

      {/* Lock — interactive in edit mode only */}
      <div className="flex justify-center">
        {rowEditing ? (
          <span
            onMouseEnter={!canToggleLock ? showLockTooltip : undefined}
            onMouseLeave={!canToggleLock ? hideLockTooltip : undefined}
            className="inline-flex"
          >
            <button
              ref={lockBtnRef}
              onClick={() => onToggleLock(target.id)}
              onFocus={!canToggleLock ? showLockTooltip : undefined}
              onBlur={!canToggleLock ? hideLockTooltip : undefined}
              disabled={!canToggleLock}
              aria-label={`${target.locked ? t.locked : t.unlocked} ${target.symbol}`}
              aria-pressed={target.locked}
              className={`inline-flex h-9 w-9 items-center justify-center rounded-xl border text-xs transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-not-allowed disabled:opacity-40 ${
                target.locked ? "border-accent/40 bg-accent/10 text-accent" : "border-slate-700 text-slate-400 hover:text-slate-100"
              }`}
            >
              <LockIcon locked={target.locked} />
            </button>
          </span>
        ) : null}
        {lockTooltipPos && !canToggleLock && typeof document !== "undefined"
          ? createPortal(
              <span
                role="tooltip"
                className="pointer-events-none fixed z-[100] w-56 -translate-y-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-[11px] leading-relaxed text-slate-200 shadow-2xl"
                style={{ top: lockTooltipPos.top, left: lockTooltipPos.left }}
              >
                {lockBlockedReason}
              </span>,
              appPortalRoot()
            )
          : null}
      </div>

      {/* Withdraw — offered in read mode too. The container opens edit mode as part of the
          click, because the handler's effects are all draft mutations (see the callsite). */}
      <div className="flex justify-end">
        {/* 027 A-11: the vault refuses an empty composition, so the last target with nothing
            held cannot be removed. aria-disabled, not disabled, so focus still reaches the
            reason. A held last row stays enabled: there the button moves its funds out. */}
        <button
          ref={removeBtnRef}
          onClick={removeBlockedReason ? undefined : () => onWithdraw(target)}
          onMouseEnter={removeBlockedReason ? showRemoveTooltip : undefined}
          onMouseLeave={removeBlockedReason ? hideRemoveTooltip : undefined}
          onFocus={removeBlockedReason ? showRemoveTooltip : undefined}
          onBlur={removeBlockedReason ? hideRemoveTooltip : undefined}
          aria-disabled={removeBlockedReason ? true : undefined}
          aria-label={withdrawAriaLabel}
          className={`whitespace-nowrap rounded-xl border border-slate-700 px-3 py-2 text-xs text-slate-300 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-300/60 ${
            removeBlockedReason ? "cursor-not-allowed opacity-40" : "hover:border-rose-400/50 hover:text-rose-200"
          }`}
        >
          {withdrawLabel}
        </button>
        {removeTooltipPos && removeBlockedReason && typeof document !== "undefined"
          ? createPortal(
              <span
                role="tooltip"
                className="pointer-events-none fixed z-[100] w-56 -translate-x-full -translate-y-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-[11px] leading-relaxed text-slate-200 shadow-2xl"
                style={{ top: removeTooltipPos.top, left: removeTooltipPos.left }}
              >
                {removeBlockedReason}
              </span>,
              appPortalRoot()
            )
          : null}
      </div>
    </div>
  );
}

export function PortfolioTargetsTable({
  t,
  rows,
  colorByToken,
  isEditing,
  allLocked,
  allUnlocked,
  rowViolations,
  pending,
  onUndoRemove,
  onUpdateTarget,
  onUpdateTargetPct,
  onPromoteHeld,
  onToggleLock,
  onLockAll,
  onUnlockAll,
  onWithdraw
}: PortfolioTargetsTableProps) {
  const placed = placeRemovedRows(rows, pending);
  // 027 A-1: bumped each time a row's minTwoUnlocked balloon opens; keying the header
  // buttons on it remounts them, which replays the one-shot flash.
  const [lockFlashCount, setLockFlashCount] = useState(0);
  const flashLockAll = () => setLockFlashCount((n) => n + 1);
  const lockAllClass = `inline-flex h-7 w-7 items-center justify-center rounded-lg border border-slate-700 text-slate-400 transition hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-30 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60${lockFlashCount > 0 ? " lock-flash" : ""}`;
  return (
    <div className="mt-3">
      <div className="overflow-x-auto rounded-2xl glass">
        {/* D-340: the action column used to be a bare `1fr` inside a 900px floor, but the fixed
            columns alone need ~1030px, so below that it collapsed to nothing and the row button
            spilled over the lock and status cells. Its floor is now the button's own width and
            the wrapper grows to fit (`w-max`), letting the scroller take the overflow instead. */}
        <div className="relative w-max min-w-full">
          <div className={`grid ${COLUMNS} gap-4 border-b border-slate-800 bg-slate-900 px-4 py-2 text-xs font-semibold text-slate-400`}>
            <div className="flex items-center justify-center text-center">{t.token}</div>
            <div>{t.amount}</div>
            <div>
              <span className="block leading-tight">{t.currentCompositionLine1}</span>
              <span className="block leading-tight">{t.currentCompositionLine2}</span>
            </div>
            {/* One header over both the % field and the slider: they are the same value
                (target composition), adjustable by typing or by dragging the bar. */}
            <div className="col-span-2 flex flex-col items-center justify-center text-center">
              <span>
                {t.targetCompositionLine1} {t.targetCompositionLine2}
              </span>
              <MiniBandLegend now={t.bandLegendNow} target={t.bandLegendTarget} range={t.bandLegendRange} />
            </div>
            <div className="flex items-center gap-1.5 pl-3">
              <span>{t.band}</span>
              <InfoTooltip label={t.bandTooltip}>{t.bandTooltip}</InfoTooltip>
            </div>

            <div className="flex items-center justify-center gap-1.5">
              <span>{t.status}</span>
              <InfoTooltip label={t.status} width={272}>
                <span className="block">{t.statusTooltipWithin}</span>
                <span className="mt-1.5 block">{t.statusTooltipBands}</span>
                <span className="mt-1.5 block">{t.statusTooltipSelling}</span>
              </InfoTooltip>
            </div>
            <div className="flex items-center justify-center gap-1">
              {isEditing ? (
                <>
                  <button
                    key={`lock-all-${lockFlashCount}`}
                    type="button"
                    onClick={onLockAll}
                    disabled={allLocked}
                    title={t.lockAll}
                    aria-label={t.lockAll}
                    className={lockAllClass}
                  >
                    <LockIcon locked />
                  </button>
                  <button
                    key={`unlock-all-${lockFlashCount}`}
                    type="button"
                    onClick={onUnlockAll}
                    disabled={allUnlocked}
                    title={t.unlockAll}
                    aria-label={t.unlockAll}
                    className={lockAllClass}
                  >
                    <LockIcon locked={false} />
                  </button>
                </>
              ) : null}
            </div>
            <div />
          </div>

          {placed.length === 0 ? (
            <div className="px-4 py-12 text-center">
              <p className="text-sm text-slate-300">{t.emptyPortfolio}</p>
              <p className="mt-1 text-xs text-slate-400">{t.emptyPortfolioCta}</p>
            </div>
          ) : (
            <div className="divide-y divide-slate-800">
              {placed.map((item) => {
                if (item.kind === "removed") {
                  const { removed } = item;
                  return (
                    <RemovedRow
                      key={`removed-${removed.tokenId}`}
                      removed={removed}
                      t={t}
                      rowColor={colorByToken?.get(removed.tokenId) ?? colorForSymbol(removed.symbol)}
                      balanceMove={pending?.balanceMoves[removed.tokenId]}
                      onUndo={onUndoRemove}
                    />
                  );
                }
                const target = item.row;
                // Lock/redistribution arithmetic only concerns editable target rows;
                // held-no-target rows (D-143(1)) render read-only and never lock.
                const editableRows = rows.filter((row) => !row.heldNoTarget);
                const unlockedCount = editableRows.filter((row) => !row.locked).length;
                const lockedTotal = editableRows
                  .filter((row) => row.locked)
                  .reduce((sum, row) => sum + (Number(row.targetPct) || 0), 0);
                const maxAllowedPct = Math.max(0, Math.min(100, 100 - lockedTotal));
                let canToggleLock = true;
                let lockBlockedReason = "";

                if (editableRows.length > 1) {
                  if (!target.locked && unlockedCount === 2) {
                    canToggleLock = false;
                    lockBlockedReason = t.minTwoUnlocked;
                  }
                  if (target.locked && unlockedCount === 0) {
                    canToggleLock = false;
                    lockBlockedReason = t.minTwoUnlocked;
                  }
                }

                const removeBlockedReason =
                  target.currentQty === 0 && !target.heldNoTarget && editableRows.length === 1
                    ? t.removeLastTargetBlocked
                    : "";

                return (
                  <TargetRow
                    key={target.id}
                    target={target}
                    t={t}
                    rowColor={colorByToken?.get(target.tokenId) ?? colorForSymbol(target.symbol)}
                    isEditing={isEditing}
                    canToggleLock={canToggleLock}
                    lockBlockedReason={lockBlockedReason}
                    removeBlockedReason={removeBlockedReason}
                    maxAllowedPct={maxAllowedPct}
                    violations={rowViolations?.[target.tokenId] ?? []}
                    mark={pending?.byTokenId[target.tokenId]}
                    balanceMove={pending?.balanceMoves[target.tokenId]}
                    onUpdate={onUpdateTarget}
                    onUpdatePct={onUpdateTargetPct}
                    onPromoteHeld={onPromoteHeld}
                    onToggleLock={onToggleLock}
                    onWithdraw={onWithdraw}
                    onLockBlockedShown={flashLockAll}
                  />
                );
              })}
            </div>
          )}
          {/* 027 A-8: the column rules, drawn once over the header and every row with the same
              grid, so each one sits mid-gap and runs unbroken. border-l-2 matches the rows'. */}
          {placed.length > 0 ? (
            <div aria-hidden="true" className={`pointer-events-none absolute inset-0 grid ${COLUMNS} gap-4 border-l-2 border-l-transparent px-4`}>
              {COLUMN_RULES.map((rule, index) => (
                <div
                  key={index}
                  data-column-rule={rule ? "" : undefined}
                  className={rule ? "relative before:absolute before:inset-y-0 before:-left-2 before:w-px before:bg-slate-800" : undefined}
                />
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
