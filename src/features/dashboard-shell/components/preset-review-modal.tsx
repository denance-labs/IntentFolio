"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { amountChipClass, Modal } from "@/features/portfolio-editor/components/portfolio-primitives";
import { isPortfolioOfferable, isReceivable } from "@/features/bridge/lib/token-availability";
import { isStockToken } from "@/features/market/lib/stock-tokens";
import { getTokenById, tokenRegistry } from "@/features/market/lib/token-registry";
import { TokenAvatar } from "@/features/market/lib/token-avatar";
import { useTokenPrices } from "@/features/market/hooks/use-token-prices";
import {
  buildHeldNoTargetRows,
  computeTargets,
} from "@/features/portfolio-editor/lib/calculations";
import { colorForSymbol, formatTokenAmount, formatUsd } from "@/features/portfolio-editor/lib/format";
import {
  buildChangeSet,
  changeSummaryToSignatureText,
  summarizeChangeSet,
} from "@/features/portfolio-editor/lib/changeset";
import type { ComputedTargetAllocation, TargetAllocation } from "@/features/portfolio-editor/types";
import { normalizeWalletError, type WalletErrorKind } from "@/features/wallet/adapter/normalize-error";
import {
  RealAllocateUnconfirmedError,
  type RealAllocateStage,
  type RealAllocateUnconfirmedReason,
} from "@/features/vault/lib/run-real-allocate";
import { AmountExceedsBalanceError } from "@/features/vault/lib/base-units";
import { RealChangeSetInvalidError } from "@/features/vault/lib/vault-errors";
import { changeSetNoticeCopy } from "@/features/portfolio-editor/components/confirm-changes-modal";
import { formatDecimalForInput, percentChipAmount } from "@/features/portfolio-editor/lib/decimal-input";
import { translations as editorTranslations } from "@/features/portfolio-editor/lib/translations";
import { useLanguage } from "../context/language-context";
import { usePortfolio } from "../context/portfolio-context";
import { useStocksRegionBlocked } from "@/features/stocks/hooks/use-stocks-region-blocked";
import { useRelayPaused } from "@/features/vault/hooks/use-relay-paused";
import { RelayPausedNotice } from "@/features/vault/components/relay-paused-notice";
import { useVaultPrecheck } from "@/features/vault/hooks/use-vault-precheck";
import { VaultPrecheckNotice } from "@/features/vault/components/vault-precheck-notice";
import { StorageCostLine, storageQuoteProblem, useSetupStorageQuote } from "./storage-cost-line";
import { APP_MAX_TOKENS_PER_PORTFOLIO, growsPastAppTokenCap } from "@/features/vault/lib/change-set-preflight";
import { usePendingAllocates } from "@/features/vault/hooks/use-pending-allocates";
import { inFlightButtonLabel } from "@/features/vault/lib/in-flight-button-label";
import { useLoginWallet } from "@/features/login-wallet";
import { useAvailableGeneralBalance } from "../hooks/use-available-general-balance";
import { useNewPortfolioDraft } from "../hooks/use-new-portfolio-draft";
import { MIN_FUNDED_USD, fundableTokenIds } from "../lib/general-balance";
import { draftToTargets, type NewPortfolioDraft, type NewPortfolioDraftInput } from "../lib/new-portfolio-draft";
import { PORTFOLIO_NAME_MAX_LENGTH, validatePortfolioName } from "../lib/portfolio-validation";
import { shellTranslations } from "../lib/translations";
import { DraftCompositionTable } from "./draft-composition";

function symbolFor(tokenId: string): string {
  return getTokenById(tokenId)?.symbol ?? tokenId;
}

// While a signature is in flight the modal cannot be dismissed (Escape, backdrop): closing it
// would leave the Allocate running with nothing on screen, and — for a draft — the draft still
// saved, so its card, strip and "+" would offer to sign the same funds again (D-298). The
// buttons are already disabled then; this closes the two exits the dialog shell owns.
const IGNORE_CLOSE = () => {};

// The rule of a portfolio's "Add funds" (D-396, D-389, D-491): a token that can be a target, or one
// with no buy route whose funds can still come in to be converted. Any other is shown, never signed.
const canFundWith = (id: string) => isPortfolioOfferable(id) || isReceivable(id);

// Quick-fill chips for the allocate inputs. 100% (Max) is rendered separately with
// its own accent so it reads as the primary action.
const PERCENT_CHIPS = [25, 50, 75] as const;

/**
 * Where the new portfolio's mix comes from: what the editor holds now (D-397), never saved, or
 * the account's New Portfolio Draft (016 block 2.4). The draft is a snapshot taken when the
 * confirmation opened, so what is signed is what is on screen even if another tab edits the
 * stored draft meanwhile.
 */
export type ReviewSource =
  | { kind: "new"; input: NewPortfolioDraftInput }
  | { kind: "draft"; draft: NewPortfolioDraft };

// The funds screen of a new portfolio (5.6): the signature of a mix just built in the editor
// (D-397) and of a saved New Portfolio Draft (016 block 2.4). The source only decides the mix, the
// prefilled name and whether a draft is retired afterwards; the funds, the signature and its
// failure handling are one path.
export function PresetReviewModal({
  source,
  existingNames,
  onClose,
  onBack,
  onCreated,
}: {
  source: ReviewSource;
  existingNames: string[];
  onClose: () => void;
  /**
   * The editor this came from, handed the name as it stands here. Without it the secondary button
   * cancels. Escape and the backdrop take the same way, so what was built is not lost by a stray
   * click.
   */
  onBack?: (name: string) => void;
  /** After a successful signature: the shell lands on the new portfolio. */
  onCreated?: () => void;
}) {
  const { lang } = useLanguage();
  const t = shellTranslations[lang];
  const { createPortfolioWithChangeSet, realAllocateStage, relaySends, vaultLive } = usePortfolio();
  // Asked on open, never in the click (017-2): a paused relay gets no signature request.
  const relayPaused = useRelayPaused(relaySends);
  // D-356: an earlier Allocate still in transit may be part of the balance offered here.
  const { intentsAccountId } = useLoginWallet();
  const { pending: pendingAllocates } = usePendingAllocates(intentsAccountId);
  const available = useAvailableGeneralBalance();
  const { prices, isLoading: pricesLoading } = useTokenPrices();
  const { discard: discardDraft, discardIfUnchanged: retireSignedDraft } = useNewPortfolioDraft();

  const draft = source.kind === "draft" ? source.draft : null;
  const mix = source.kind === "draft" ? source.draft : source.input;
  const mixRows = mix.rows;

  const [name, setName] = useState(mix.name);
  // D-553: every field starts empty. A token enters only with an amount the user set, so
  // nothing is signed by not noticing it, whether or not it is part of the composition.
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [isSigning, setIsSigning] = useState(false);
  const [signError, setSignError] = useState<{ kind: WalletErrorKind; message: string } | null>(null);
  // Live-vault Allocate submitted but not observed as credited (007.plan Phase 1). Once set,
  // the modal is terminal: the funds are in transit, and a second signature over them is how
  // a second stranded Allocate happens (D-298). Only "Close" remains.
  const [unconfirmedReason, setUnconfirmedReason] = useState<RealAllocateUnconfirmedReason | null>(null);
  // The chain held less than the screen showed (D-304(b)). Nothing was signed: retry is fine.
  const [balanceChanged, setBalanceChanged] = useState(false);
  // The pre-flight refused the Setup before signing (a `PreflightReason`, e.g. D-361's cap).
  const [changeSetReason, setChangeSetReason] = useState<string | null>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const amountsRef = useRef<HTMLDivElement>(null);

  // The notice replaces the form's purpose, so focus goes to the one action left.
  useEffect(() => {
    if (unconfirmedReason) primaryRef.current?.focus();
  }, [unconfirmedReason]);
  // The amounts are what the user has to fix.
  useEffect(() => {
    if (balanceChanged) amountsRef.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, [balanceChanged]);
  // D-309: the attempt disabled the button that had the focus, which drops it on `<body>`. Once
  // it answers, the focus goes to the retry, or to the way out when there is none to press.
  useEffect(() => {
    if (isSigning || (!signError && !changeSetReason)) return;
    const retry = primaryRef.current;
    (retry && !retry.disabled ? retry : backRef.current)?.focus();
  }, [isSigning, signError, changeSetReason]);

  const priceOf = (id: string): number => prices[id]?.usdPrice ?? getTokenById(id)?.fallbackUsdPrice ?? 0;

  // C2 (016 §7): only tokens worth MIN_FUNDED_USD (one cent, 027 A-2) are offered — dust would
  // fund a line below it. The cut trims what is OFFERED, never what is already on screen: a token
  // stays once shown, even if its price dips under the floor meanwhile (the per-row check below
  // then speaks up).
  // Accumulated during render (React's "information from previous renders" pattern). Nothing is
  // offered before the first price answer: every price is a fallback then (s186), and an offer
  // made on it would stick.
  const fundableNow = useMemo(
    () => fundableTokenIds(available, (id) => prices[id]?.usdPrice ?? getTokenById(id)?.fallbackUsdPrice ?? 0),
    [available, prices]
  );
  const [offered, setOffered] = useState<ReadonlySet<string>>(() => new Set(pricesLoading ? [] : fundableNow));
  if (!pricesLoading && fundableNow.some((id) => !offered.has(id))) {
    setOffered(new Set([...offered, ...fundableNow]));
  }

  const fundTokens = useMemo(
    () =>
      [...offered]
        .filter((id) => (available.get(id) ?? 0) > 0)
        .sort((a, b) => symbolFor(a).localeCompare(symbolFor(b))),
    [offered, available]
  );

  const amountStr = (id: string): string => overrides[id] ?? "";

  // Chosen allocations, clamped to the available balance (positive entries only).
  const allocations = useMemo(() => {
    const out: Record<string, number> = {};
    for (const id of fundTokens) {
      if (!canFundWith(id)) continue;
      const avail = available.get(id) ?? 0;
      const raw = Number(overrides[id] ?? 0);
      const qty = Number.isFinite(raw) ? Math.max(0, Math.min(raw, avail)) : 0;
      if (qty > 0) out[id] = qty;
    }
    return out;
  }, [fundTokens, overrides, available]);

  const targets = useMemo<TargetAllocation[]>(() => draftToTargets({ rows: mixRows }), [mixRows]);

  // The composition as shown. Both sources hold numbers; `""` is only the editor's empty input.
  const compositionRows = useMemo(
    () => targets.map((r) => ({ tokenId: r.tokenId, targetPct: Number(r.targetPct) || 0, tolerancePct: Number(r.tolerancePct) || 0 })),
    [targets]
  );

  // GROSS: what the user chose. The Storage Cost is deducted downstream, once (D-528).
  const changeset = useMemo(
    () => buildChangeSet([], targets, allocations),
    [targets, allocations]
  );

  // D-528: the Setup's Storage Cost, priced from exactly what it signs.
  const compositionTokenIds = useMemo(() => (changeset.tokenAdditions ?? []).map((a) => a.tokenId), [changeset]);
  const storageQuote = useSetupStorageQuote({ portfolioName: name.trim(), compositionTokenIds, grossAllocations: allocations });
  const storageProblem = storageQuoteProblem(storageQuote, t);
  // A draft saved before the app's 10-token cap (D-528) can hold more: trimmed in the editor first.
  const overTokenCap = growsPastAppTokenCap(0, compositionTokenIds.length);
  // D-569: the one door every new portfolio goes through, so a mix with stocks that reached here
  // another way (a draft saved before the block, the landing's preset) is not signed where stocks
  // can't be bought. The pickers and the chooser already keep new ones out.
  const regionBlocked = useStocksRegionBlocked();
  const stocksBlocked = regionBlocked && targets.some((row) => isStockToken(row.tokenId));
  // What the portfolio starts with: the chosen amounts, less the cost in the token it is charged in.
  const netAllocations = useMemo(
    () =>
      storageQuote?.ok
        ? { ...allocations, [storageQuote.tokenId]: (allocations[storageQuote.tokenId] ?? 0) - storageQuote.qty }
        : allocations,
    [allocations, storageQuote]
  );

  // Projected initial state: treat the net allocations as the new portfolio's balances
  // and run them through the same engine the editor uses, so the preview's current% and
  // band states match what the dashboard will show after creation.
  const currentTotalUsd = useMemo(
    () =>
      tokenRegistry.reduce((sum, token) => {
        const qty = netAllocations[token.id] ?? 0;
        const price = prices[token.id]?.usdPrice ?? token.fallbackUsdPrice;
        return sum + qty * price;
      }, 0),
    [netAllocations, prices]
  );

  const initialRows = useMemo<ComputedTargetAllocation[]>(() => {
    const targeted = computeTargets(targets, tokenRegistry, prices, netAllocations, currentTotalUsd);
    const held = buildHeldNoTargetRows(targeted, tokenRegistry, prices, netAllocations, currentTotalUsd);
    return [...targeted, ...held];
  }, [targets, prices, netAllocations, currentTotalUsd]);

  // D-553: the composition's tokens first; the rest below, with what adding them means.
  const compositionIds = new Set(compositionRows.map((r) => r.tokenId));
  const compositionFunds = fundTokens.filter((id) => compositionIds.has(id));
  const otherFunds = fundTokens.filter((id) => !compositionIds.has(id));

  // Per line: an amount lowered below MIN_FUNDED_USD (rounded cents, like `fundableTokenIds`).
  const belowMin = (id: string): boolean => {
    const qty = allocations[id] ?? 0;
    if (qty <= 0) return false;
    // A line whose price is unknown (a live quote of 0 or NaN) cannot be shown to reach the floor:
    // blocked, as `fundableTokenIds` never offers such a token in the first place.
    const price = priceOf(id);
    if (!(price > 0)) return true;
    return Math.round(qty * price * 100) / 100 < MIN_FUNDED_USD;
  };
  const anyBelowMin = fundTokens.some(belowMin);

  // G2: what stays behind. The whole General Balance — dust included — since that is what My
  // Account will show afterwards; only said once the user chose an amount (`hasFunds` below).
  const lowered = fundTokens.some((id) => (allocations[id] ?? 0) < (available.get(id) ?? 0));
  const remainingUsd = [...available].reduce(
    (sum, [id, qty]) => sum + Math.max(0, qty - (allocations[id] ?? 0)) * priceOf(id),
    0
  );

  const nameValidation = validatePortfolioName(name, existingNames);
  const hasFunds = Object.keys(allocations).length > 0;
  const anythingToFundWith = fundTokens.some(canFundWith);
  const needsAmount = !hasFunds && anythingToFundWith && unconfirmedReason === null;
  const outOfBand =
    hasFunds &&
    initialRows.some((r) => r.bandState === "below" || r.bandState === "above" || r.heldNoTarget);
  // A pause the click ran into (the firewall brake cannot be seen on open) blocks the retry too:
  // each retry would be another signature for the same refusal.
  const relayBlocked = relayPaused || signError?.kind === "relay-paused";
  // Asked on open like the relay pause (017-9b): the vault would bounce this Allocate after the
  // Transfer settled — an orphan — so no signature is asked for.
  const vaultBlock = useVaultPrecheck(vaultLive && hasFunds ? { kind: "allocate", tokenIds: Object.keys(allocations) } : null);
  const canSubmit =
    nameValidation.ok &&
    hasFunds &&
    !anyBelowMin &&
    !isSigning &&
    targets.length > 0 &&
    !relayBlocked &&
    !vaultBlock &&
    !overTokenCap &&
    !stocksBlocked &&
    storageQuote?.ok === true;

  function nameError(): string | null {
    if (nameValidation.ok) return null;
    if (nameValidation.error === "nameEmpty") return t.portfolioNameEmpty;
    if (nameValidation.error === "nameTooLong") return t.portfolioNameTooLong.replace("{max}", String(PORTFOLIO_NAME_MAX_LENGTH));
    if (nameValidation.error === "nameDuplicate") return t.portfolioNameDuplicate;
    return null;
  }

  function errorHeadline(kind: WalletErrorKind): string {
    if (kind === "cancel") return t.signErrorCancelled;
    if (kind === "unavailable") return t.signErrorUnavailable;
    if (kind === "relay-paused") return t.signErrorRelayPaused;
    if (kind === "relay-busy") return t.signErrorRelayBusy;
    if (kind === "relay-would-fail") return t.signErrorRelayWouldFail;
    if (kind === "relay-check-failed") return t.signErrorRelayCheckFailed;
    return t.signErrorGeneric;
  }

  function stageCopy(stage: RealAllocateStage): string {
    switch (stage) {
      case "preparing":
        return t.realStagePreparing;
      case "signing":
        return t.realStageSigning;
      case "submitting":
        return t.realStageSubmitting;
      case "awaiting-credit":
        return t.realStageAwaitingCredit;
      case "credited":
        return t.realStageCredited;
      case "pending-unconfirmed":
        return t.realStagePendingUnconfirmed;
    }
  }

  async function handleConfirm() {
    // 🔴 Terminal state: the primary is "Close" here. This guard — not the button label — is
    // what keeps a second click from signing the same funds again.
    if (unconfirmedReason) {
      onClose();
      return;
    }
    if (!canSubmit || !storageQuote?.ok) return;
    setIsSigning(true);
    setSignError(null);
    setBalanceChanged(false);
    setChangeSetReason(null);
    try {
      const summary = summarizeChangeSet(changeset, [], symbolFor);
      const text = changeSummaryToSignatureText(summary, name.trim());
      await createPortfolioWithChangeSet(name.trim(), changeset, text, storageQuote);
      // The draft became this portfolio — unless another tab replaced it meanwhile (F2, s186).
      if (draft) retireSignedDraft(draft.updatedAt);
      onCreated?.();
      onClose();
    } catch (e) {
      // A submitted-but-unconfirmed live Allocate is NOT a signature failure: the funds may
      // still settle and are recoverable. It gets its own, non-alarming copy. The draft being
      // confirmed goes too: its funds are in transit, and a draft still inviting "Confirm" would
      // be an invitation to sign over them a second time (D-298).
      //
      // D-397: a mix created straight from the editor leaves a saved draft alone, on success and
      // here: that draft is another design, never the one signed, and "+" reaches this same screen
      // with no draft at all. Against D-298 stand the notice of an earlier Allocate in transit
      // (D-356), and the assign prompt staying shut meanwhile (dashboard-shell).
      if (e instanceof RealAllocateUnconfirmedError) {
        if (draft) discardDraft();
        setUnconfirmedReason(e.reason);
      }
      // Before `normalizeWalletError`, which would show "Couldn't complete the signature" plus
      // a message in base units — for something that was never signed.
      else if (e instanceof AmountExceedsBalanceError) setBalanceChanged(true);
      else if (e instanceof RealChangeSetInvalidError) setChangeSetReason(e.reason);
      else setSignError(normalizeWalletError(e));
    } finally {
      setIsSigning(false);
    }
  }

  if (targets.length === 0) return null;

  const goBack = onBack ? () => onBack(name) : onClose;

  // One token's amount: its field, 25/50/75/Max, and what the amount means.
  const fundRow = (id: string) => {
    if (!canFundWith(id)) {
      return (
        <li key={id} className="flex items-center gap-2 rounded-2xl border border-slate-800 bg-slate-900 px-4 py-2.5 opacity-50">
          <TokenAvatar
            symbol={symbolFor(id)}
            size={22}
            className="rounded-full"
            style={{ backgroundColor: `${colorForSymbol(symbolFor(id)).hex}22` }}
          />
          <span className="text-sm font-medium text-slate-100">{symbolFor(id)}</span>
          <span className="ml-auto text-right text-[11px] text-amber-400">{editorTranslations[lang].addTokensNotAvailableYet}</span>
        </li>
      );
    }
    const avail = available.get(id) ?? 0;
    const rawAmt = Number(amountStr(id));
    const amt = Number.isFinite(rawAmt) ? Math.max(0, Math.min(rawAmt, avail)) : 0;
    const price = priceOf(id);
    const rowBelowMin = belowMin(id);
    // D-319: Max writes the whole float, wider than the field, so it says it is all of it.
    const wholeBalance = overrides[id] === formatDecimalForInput(avail);
    return (
      <li key={id} className="rounded-2xl border border-slate-800 bg-slate-900 px-4 py-2.5">
        {/* One row on desktop: name, amount input (narrow, not full-width),
            quick-fill chips. The USD equivalent of the typed amount sits
            right-aligned directly under the input (the input + ≈USD share a column).
            What is available sits below it, or "whole balance" once Max took it all. On narrow
            widths the chips wrap to a second line so the input never
            collapses. Native spinners hidden: useless at 6+ decimals. */}
        <div className="flex flex-wrap items-start gap-2">
          <span className="flex shrink-0 items-center gap-2 pt-1">
            <TokenAvatar
              symbol={symbolFor(id)}
              size={22}
              className="rounded-full"
              style={{ backgroundColor: `${colorForSymbol(symbolFor(id)).hex}22` }}
            />
            <span className="text-sm font-medium text-slate-100">{symbolFor(id)}</span>
          </span>
          <div className="flex min-w-[6rem] flex-1 flex-col">
            <input
              type="number"
              inputMode="decimal"
              min={0}
              max={avail}
              step="any"
              value={amountStr(id)}
              placeholder="0"
              onChange={(e) => setOverrides((o) => ({ ...o, [id]: e.target.value }))}
              aria-label={`${symbolFor(id)} ${t.presetReviewAllocate}`}
              aria-invalid={rowBelowMin || undefined}
              aria-describedby={rowBelowMin ? `preset-review-min-${id}` : undefined}
              className="w-full text-ellipsis rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-right text-sm tabular-nums text-slate-100 focus:text-clip focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
            <span className="mt-1 text-right text-[11px] tabular-nums text-slate-400">≈ {formatUsd(amt * price)}</span>
            {/* D-528: the token the Storage Cost is charged in says what reaches the portfolio. */}
            {storageQuote?.ok && storageQuote.tokenId === id ? (
              <span className="mt-0.5 text-right text-[11px] tabular-nums text-slate-300">
                {t.storageCostNet.replace(
                  "{amount}",
                  `${formatTokenAmount(netAllocations[id] ?? 0, price)} ${symbolFor(id)}`
                )}
              </span>
            ) : null}
            {/* D-319: the ellipsis cut is only visual (the value signed does not change). One line
                either way, so pressing Max does not move the chips. */}
            {wholeBalance ? (
              <span className="mt-0.5 text-right text-[11px] text-accent/80">{t.amountWholeBalance}</span>
            ) : (
              <span className="mt-0.5 text-right text-[11px] tabular-nums text-slate-400">
                {t.presetReviewAvailable}: {formatTokenAmount(avail, price)} <span className="whitespace-nowrap">≈ {formatUsd(avail * price)}</span>
              </span>
            )}
            {rowBelowMin ? (
              <p id={`preset-review-min-${id}`} role="alert" className="mt-1 text-right text-[11px] text-rose-400">
                {editorTranslations[lang].allocateErrorMinFunded}
              </p>
            ) : null}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1 pt-1">
            {PERCENT_CHIPS.map((pct) => {
              const chipAmount = percentChipAmount(avail, pct, getTokenById(id)?.decimals ?? 8);
              const selected = !wholeBalance && amt > 0 && amountStr(id) === chipAmount;
              return (
                <button
                  key={pct}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setOverrides((o) => ({ ...o, [id]: chipAmount }))}
                  className={amountChipClass(selected)}
                >
                  {pct}%
                </button>
              );
            })}
            <button
              type="button"
              aria-pressed={wholeBalance}
              onClick={() => setOverrides((o) => ({ ...o, [id]: formatDecimalForInput(avail) }))}
              className={amountChipClass(wholeBalance)}
            >
              {t.depositAmountMax}
            </button>
          </div>
        </div>
      </li>
    );
  };

  return (
    <Modal
      titleId="preset-review-title"
      onClose={isSigning ? IGNORE_CLOSE : unconfirmedReason ? onClose : goBack}
      maxWidth="max-w-lg"
    >
      <h2 id="preset-review-title" className="text-lg font-semibold text-slate-100">
        {t.presetReviewTitle}
      </h2>

      {/* Not during or after this modal's own attempt: its record would be the one counted. */}
      {pendingAllocates && pendingAllocates.length > 0 && !isSigning && !unconfirmedReason ? (
        <p
          role="status"
          className="mt-3 rounded-xl border border-accent/30 bg-accent/5 px-3 py-2 text-[12px] leading-snug text-accent"
        >
          {t.pendingAllocateFundingNotice}
        </p>
      ) : null}

      {/* The form. Disabled as one unit while signing — an edit then changes nothing already
          signed, it only confuses (D-309) — and once an Allocate is in transit (D-298). */}
      <fieldset
        disabled={unconfirmedReason !== null || isSigning}
        className="m-0 min-w-0 border-0 p-0 disabled:opacity-60"
      >
        {/* Name */}
        <label htmlFor="preset-review-name" className="mt-4 mb-1.5 block text-sm font-medium text-slate-300">
          {t.portfolioNameLabel}
        </label>
        <input
          id="preset-review-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={PORTFOLIO_NAME_MAX_LENGTH}
          placeholder={t.portfolioNamePlaceholder}
          aria-describedby={name !== "" && nameError() ? undefined : "preset-review-name-hint"}
          className={`w-full rounded-xl border bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
            name !== "" && !nameValidation.ok ? "border-rose-500" : "border-slate-700 focus:border-slate-500"
          }`}
        />
        <div className="mt-1 flex items-start justify-between gap-2">
          {name !== "" && nameError() ? (
            <p role="alert" className="text-xs text-rose-400">
              {nameError()}
            </p>
          ) : (
            <p id="preset-review-name-hint" className="text-xs text-slate-400">
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
        <section className="mt-5" aria-labelledby="preset-review-composition">
          <h3
            id="preset-review-composition"
            className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-accent"
          >
            {t.presetReviewComposition}
          </h3>
          {/* 019-5: the draft editor's table, read-only — the mix is signed as it was built. */}
          <DraftCompositionTable rows={compositionRows} />
          {overTokenCap ? (
            <p className="mt-2 text-[11px] leading-snug text-amber-200">
              {editorTranslations[lang].appTooManyTokens.replace("{max}", String(APP_MAX_TOKENS_PER_PORTFOLIO))}
            </p>
          ) : null}
          {stocksBlocked ? (
            <p className="mt-2 text-[11px] leading-snug text-amber-200">{editorTranslations[lang].stockRegionBlockedCreate}</p>
          ) : null}
        </section>

        {/* Funds to allocate */}
        <section className="mt-5" aria-labelledby="preset-review-allocate">
          <h3
            id="preset-review-allocate"
            className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-300"
          >
            {t.presetReviewAllocate}
          </h3>
          {!anythingToFundWith ? (
            <p className="rounded-2xl border border-slate-800 bg-slate-900 px-4 py-3 text-xs text-slate-400">
              {t.presetReviewNoFunds}
            </p>
          ) : (
            <>
              <div ref={amountsRef}>
                {compositionFunds.length > 0 ? <ul className="space-y-2">{compositionFunds.map(fundRow)}</ul> : null}
                {otherFunds.length > 0 ? (
                  <div className={compositionFunds.length > 0 ? "mt-4" : undefined}>
                    <p className="text-xs font-medium text-slate-200">{t.presetReviewOtherTokens}</p>
                    <p className="mb-2 mt-0.5 text-[11px] leading-snug text-slate-400">{t.presetReviewOtherTokensNote}</p>
                    <ul className="space-y-2">{otherFunds.map(fundRow)}</ul>
                  </div>
                ) : null}
              </div>
              {storageQuote?.ok ? (
                <StorageCostLine quote={storageQuote} usdPrice={priceOf(storageQuote.tokenId)} t={t} />
              ) : storageProblem ? (
                <p className="mt-3 text-[11px] leading-snug text-amber-200">
                  {storageProblem}
                </p>
              ) : null}
              {lowered && hasFunds ? (
                <p className="mt-2 text-[11px] tabular-nums text-slate-400">
                  {t.presetReviewRemaining.replace("{amount}", formatUsd(remainingUsd))}
                </p>
              ) : null}
            </>
          )}
        </section>
      </fieldset>

      {/* D-553: why the button is off while no amount is set. A Setup cannot be signed empty (ADR-0013). */}
      {needsAmount ? (
        <p
          id="preset-review-needs-amount"
          className="mt-5 rounded-xl border border-amber-400/40 bg-amber-400/5 px-3 py-2 text-[11px] leading-snug text-amber-200"
        >
          {t.presetReviewEnterAmount}
        </p>
      ) : null}

      {hasFunds && outOfBand ? (
        <p className="mt-5 rounded-xl border border-violet-400/30 bg-violet-400/5 px-3 py-2 text-[11px] leading-snug text-violet-200">
          {t.presetReviewOutOfBand}
        </p>
      ) : null}

      {/* "Just a starting point you can edit" is said of a preset; a mix built from scratch is the user's own. */}
      {mix.presetId ? (
        <p className="mt-4 text-[11px] leading-snug text-slate-400">{t.presetReviewNotAdvice}</p>
      ) : null}

      {/* Live-vault progress, then its outcome, in ONE always-mounted live region so a screen
          reader hears the transition. Fixed min-height on the stage line so naming each leg
          does not shift the buttons below as the copy changes length. */}
      <div role="status" aria-live="polite">
        {unconfirmedReason ? (
          <div
            id="preset-review-unconfirmed"
            className="mt-4 rounded-xl border border-amber-400/40 bg-amber-400/5 px-3 py-2 text-[12px] leading-snug text-amber-200"
          >
            <p className="font-semibold">
              {unconfirmedReason === "vault_failed"
                ? t.realStageVaultFailedTitle
                : t.realStagePendingUnconfirmedTitle}
            </p>
            <p className="mt-0.5">
              {unconfirmedReason === "vault_failed" ? t.realStageVaultFailed : t.realStagePendingUnconfirmed}
            </p>
            <p className="mt-1.5">{t.realStageSeeMyAccount}</p>
          </div>
        ) : realAllocateStage ? (
          <p className="mt-4 flex min-h-[2.5rem] items-center gap-2 rounded-xl border border-accent/30 bg-accent/5 px-3 py-2 text-[12px] leading-tight text-accent">
            <Loader2 aria-hidden className="h-3.5 w-3.5 shrink-0 animate-spin" />
            {stageCopy(realAllocateStage)}
          </p>
        ) : null}
      </div>

      {balanceChanged ? (
        <div role="alert" className="mt-4 rounded-xl border border-rose-400/40 bg-rose-400/5 px-3 py-2">
          <p className="text-[12px] font-semibold leading-tight text-rose-200">{t.amountExceedsBalanceTitle}</p>
          <p className="mt-0.5 text-[11px] leading-snug text-rose-300/80">{t.amountExceedsBalanceBody}</p>
        </div>
      ) : null}

      {changeSetReason ? (
        <div role="alert" className="mt-4 rounded-xl border border-amber-400/40 bg-amber-400/5 px-3 py-2">
          <p className="text-[12px] leading-snug text-amber-200">
            {changeSetNoticeCopy(changeSetReason, editorTranslations[lang])}
          </p>
        </div>
      ) : null}

      {relayPaused && !unconfirmedReason ? (
        <RelayPausedNotice id="preset-review-relay-paused" title={t.relayPausedTitle} body={t.relayPausedBody} />
      ) : vaultBlock && !unconfirmedReason ? (
        <VaultPrecheckNotice id="preset-review-relay-paused" block={vaultBlock} t={t} />
      ) : null}

      {signError ? (
        <div role="alert" className="mt-4 rounded-xl border border-rose-400/40 bg-rose-400/5 px-3 py-2">
          <p className="text-[12px] leading-tight text-rose-200">{errorHeadline(signError.kind)}</p>
          {signError.kind === "error" ? (
            <p className="mt-0.5 break-words text-[11px] leading-tight text-rose-300/60">{signError.message}</p>
          ) : null}
        </div>
      ) : null}

      {/* `justify-end` keeps "Close" on the right once "Back" is gone. */}
      <div className={`mt-6 flex gap-3 ${unconfirmedReason ? "justify-end" : "justify-between"}`}>
        {unconfirmedReason ? null : (
          <button
            ref={backRef}
            type="button"
            onClick={goBack}
            disabled={isSigning}
            className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-300 transition hover:border-slate-500 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            {onBack ? t.presetReviewBack : t.cancel}
          </button>
        )}
        <button
          ref={primaryRef}
          type="button"
          onClick={handleConfirm}
          // "Close" must stay usable even when the refetched balance leaves nothing to submit.
          disabled={unconfirmedReason ? false : !canSubmit}
          aria-describedby={
            unconfirmedReason
              ? "preset-review-unconfirmed"
              : relayPaused || vaultBlock
                ? "preset-review-relay-paused"
                : needsAmount
                  ? "preset-review-needs-amount"
                  : undefined
          }
          className="rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          {unconfirmedReason
            ? t.realAllocateClose
            : isSigning
              ? inFlightButtonLabel(realAllocateStage, editorTranslations[lang])
              : signError || balanceChanged || changeSetReason
                ? t.presetReviewRetry
                : t.presetReviewCreate}
        </button>
      </div>
    </Modal>
  );
}
