"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { depositableTokens, getTokenById } from "@/features/market/lib/token-registry";
import { isPortfolioOfferable, isReceivable } from "@/features/bridge/lib/token-availability";
import type { TokenPriceMap } from "@/features/market/types";
import { useLanguage } from "@/features/dashboard-shell/context/language-context";
import { usePortfolio } from "@/features/dashboard-shell/context/portfolio-context";
import { useRelayPaused } from "@/features/vault/hooks/use-relay-paused";
import { useVaultPrecheck } from "@/features/vault/hooks/use-vault-precheck";
import { APP_MAX_TOKENS_PER_PORTFOLIO, growsPastAppTokenCap } from "@/features/vault/lib/change-set-preflight";
import { VaultPrecheckNotice } from "@/features/vault/components/vault-precheck-notice";
import { RelayPausedNotice } from "@/features/vault/components/relay-paused-notice";
import { shellTranslations } from "@/features/dashboard-shell/lib/translations";
import { MIN_FUNDED_USD } from "@/features/dashboard-shell/lib/general-balance";
import { normalizeWalletError, type WalletErrorKind } from "@/features/wallet/adapter/normalize-error";
import {
  RealAllocateUnconfirmedError,
  type RealAllocateStage,
  type RealAllocateUnconfirmedReason,
} from "@/features/vault/lib/run-real-allocate";
import { AmountExceedsBalanceError } from "@/features/vault/lib/base-units";
import { RealChangeSetInvalidError } from "@/features/vault/lib/vault-errors";
import { inFlightButtonLabel } from "@/features/vault/lib/in-flight-button-label";
import { usePendingAllocates } from "@/features/vault/hooks/use-pending-allocates";
import { useLoginWallet } from "@/features/login-wallet";
import { changeSetNoticeCopy } from "./confirm-changes-modal";
import { FundAmountRow, FundList, FundUnavailableRow } from "./fund-amount-row";
import { Modal } from "./portfolio-primitives";
import { FundingSummary } from "@/features/dashboard-shell/components/funding-summary";
import {
  relayGasQuoteProblem,
  useLivePriceOf,
  useRelayGasQuote,
} from "@/features/dashboard-shell/components/relay-gas-line";
import { relayGasDeductionOf, relayGasTokenOf } from "@/features/vault/lib/relay-gas-cost";
import { toRegistryTokenId } from "@/features/market/lib/intents-token-id";
import { formatTokenAmount, formatUsd } from "../lib/format";
import type { translations } from "../lib/translations";
import type { CurrentPortfolioQty } from "../types";

type T = (typeof translations)["en"];

// More tokens than this and the list gets its search.
const SEARCH_FROM = 8;

type Props = {
  t: T;
  // Live available General Balance per token, already net of any pending draft moves.
  available: Map<string, number>;
  // Effective portfolio balances — drives the held-amount line + USD-desc order.
  existingBalances: CurrentPortfolioQty;
  // Token ids that are part of the portfolio composition (target rows), even when they
  // hold no funds yet. Drives the "in portfolio" chip so a target-only token (0%, no
  // balance) is flagged just like a funded one.
  compositionTokenIds?: readonly string[];
  prices: TokenPriceMap;
  onClose: () => void;
  // Applies one allocation (token → qty) from General Balance into the draft.
  onAllocate: (tokenId: string, qty: number) => void;
  // The funding account's balance is still being read: an empty list then means nothing yet.
  balanceLoading?: boolean;
  // D-541: the funding account could not be read. An empty list is then unknown, not "empty":
  // say so, with a Retry that re-reads it.
  onRetryBalance?: () => void;
  // Opens the shell's Deposit (D-529): the way in when the funding account is empty, or holds
  // no token the user wants. Omitted outside the shell, and then nothing offers it.
  onDeposit?: () => void;
  // Set on a REAL portfolio (D-321, 013.plan P5): funds are signed in right away through
  // `allocateIntoPortfolio` instead of joining the draft. A selection with no funds (only
  // new targets) is a composition edit and still goes to the draft.
  realFunding?: {
    // P6: an unsaved draft blocks signing — the funding would change the portfolio under it.
    blockedByDraft: boolean;
    // Tolerance for tokens that join the composition in the same signature, at 0%.
    defaultTolerancePct: number;
    onFunded: (credited: Array<{ tokenId: string; qty: number }>) => void;
  };
};

type Entry = {
  id: string;
  symbol: string;
  name: string;
  category: string;
  inPortfolio: boolean;
  existingQty: number;
  existingUsd: number;
  avail: number;
  price: number;
  // Outside the curated catalog (D-396): listed so the gap reads as deliberate, never chosen.
  notAvailable: boolean;
  // D-491: no buy route, so never a target, but its funds can come in at 0% and be sold
  // towards the other targets (BTC, mpDAO). Without funds to add it reads as not available.
  fundsOnly: boolean;
};

const symbolFor = (tokenId: string) => getTokenById(tokenId)?.symbol ?? tokenId;

// "NEAR and USDC" / "NEAR y USDC": one placeholder that reads right for one token or several.
const listSymbols = (tokenIds: string[], lang: string) =>
  new Intl.ListFormat(lang, { style: "long", type: "conjunction" }).format(tokenIds.map(symbolFor));

// While an Allocate is in flight, Escape and the backdrop must not close the modal: a new
// instance would show the balance from before the transfer and offer to sign again over
// funds in transit (D-298) — and a failure would land on nobody. Only the outcome ends it.
const ignoreClose = () => {};

// D-529: "Add funds" only assigns what the funding account holds; new targets come in through
// "Add tokens" (`AddTargetsModal`).
export function AddFundsModal({
  t,
  available,
  existingBalances,
  compositionTokenIds,
  prices,
  onClose,
  onAllocate,
  balanceLoading = false,
  onRetryBalance,
  onDeposit,
  realFunding,
}: Props) {
  const { lang } = useLanguage();
  const shellT = shellTranslations[lang];
  const { allocateIntoPortfolio, realAllocateStage, relaySends, vaultLive } = usePortfolio();
  // Asked on open, never in the click (017-2). An edit without real funding never signs here.
  const relayPaused = useRelayPaused(relaySends && !!realFunding);
  // D-356: an earlier Allocate still in transit may be part of the balance offered here.
  const { intentsAccountId } = useLoginWallet();
  const { pending: pendingAllocates } = usePendingAllocates(realFunding ? intentsAccountId : null);

  const searchRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [search, setSearch] = useState("");
  // Raw allocate input per token (kept as typed; clamped to available at read time).
  const [amounts, setAmounts] = useState<Record<string, string>>({});

  const [isSigning, setIsSigning] = useState(false);
  const [signError, setSignError] = useState<{ kind: WalletErrorKind; message: string } | null>(null);
  // Same terminal state as `preset-review-modal` (D-298): once set, only "Close" remains.
  const [unconfirmedReason, setUnconfirmedReason] = useState<RealAllocateUnconfirmedReason | null>(null);
  // The chain held less than the screen showed (D-304(b)). Nothing was signed: retry is fine.
  const [balanceChanged, setBalanceChanged] = useState(false);
  // The pre-flight refused the funding before signing (a `PreflightReason`). Retry is fine.
  const [changeSetReason, setChangeSetReason] = useState<string | null>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (unconfirmedReason) primaryRef.current?.focus();
  }, [unconfirmedReason]);
  useEffect(() => {
    if (balanceChanged) listRef.current?.querySelector<HTMLInputElement>('input[type="number"]')?.focus();
  }, [balanceChanged]);
  // D-309: the attempt disabled the button that had the focus, which drops it on `<body>`. Once
  // it answers, the focus goes to the retry, or to the way out when there is none to press.
  useEffect(() => {
    if (isSigning || (!signError && !changeSetReason)) return;
    const retry = primaryRef.current;
    (retry && !retry.disabled ? retry : backRef.current)?.focus();
  }, [isSigning, signError, changeSetReason]);

  const priceOf = (id: string) => prices[id]?.usdPrice ?? getTokenById(id)?.fallbackUsdPrice ?? 0;

  // Universe of rows: only tokens the funding account holds (D-529). New targets with no funds
  // are "Add tokens"' job, and an empty portfolio is built purely from funded weights.
  const entries = useMemo<Entry[]>(() => {
    const compositionSet = new Set(compositionTokenIds ?? []);
    const ids = new Set<string>(depositableTokens.map((token) => token.id));
    for (const id of Object.keys(existingBalances)) ids.add(id);
    for (const id of compositionSet) ids.add(id);

    const out: Entry[] = [];
    for (const id of ids) {
      const token = getTokenById(id);
      if (!token) continue;
      const existingQty = existingBalances[id] ?? 0;
      // In-portfolio if it holds funds OR is part of the composition as a target row
      // (a target-only token sits at 0% with no balance yet — still "in portfolio").
      const inPortfolio = existingQty > 0 || compositionSet.has(id);
      const avail = available.get(id) ?? 0;
      const price = priceOf(id);
      if (avail <= 0) continue;
      const fundsOnly = !isPortfolioOfferable(id) && isReceivable(id);
      out.push({
        id,
        symbol: token.symbol,
        name: token.name,
        category: token.category,
        inPortfolio,
        existingQty,
        existingUsd: existingQty * price,
        avail,
        price,
        notAvailable: fundsOnly ? avail <= 0 : !isPortfolioOfferable(id),
        fundsOnly,
      });
    }

    // Order: (1) tokens with avail > 0, by avail*price desc; (2) rest, alphabetical; (3) the
    // ones not offerable (D-396, D-389) last, alphabetical, whatever they hold (as Receive does).
    return out.sort((a, b) => {
      if (a.notAvailable !== b.notAvailable) return a.notAvailable ? 1 : -1;
      if (a.notAvailable) return a.symbol.localeCompare(b.symbol);
      const aHasAvail = a.avail > 0;
      const bHasAvail = b.avail > 0;
      if (aHasAvail !== bHasAvail) return aHasAvail ? -1 : 1;
      if (aHasAvail && bHasAvail) return b.avail * b.price - a.avail * a.price;
      return a.symbol.localeCompare(b.symbol);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- priceOf reads props.prices
  }, [available, existingBalances, compositionTokenIds, prices]);

  const q = search.trim().toLowerCase();
  const visible = q
    ? entries.filter(
        (e) =>
          e.symbol.toLowerCase().includes(q) ||
          e.name.toLowerCase().includes(q) ||
          e.category.toLowerCase().includes(q)
      )
    : entries;

  // Numeric allocation per token, clamped to its available balance (positive only).
  const allocations = useMemo<Record<string, number>>(() => {
    const out: Record<string, number> = {};
    for (const e of entries) {
      if (e.notAvailable) continue;
      const raw = e.id in amounts ? Number(amounts[e.id]) : 0;
      const qty = Number.isFinite(raw) ? Math.max(0, Math.min(raw, e.avail)) : 0;
      if (qty > 0) out[e.id] = qty;
    }
    return out;
  }, [entries, amounts]);

  // D-589 block 5: the relay's gas, in the highest-value leg (`relayGasTokenOf`), deducted from it.
  // Only where this confirm signs: a draft-only edit sends nothing.
  const livePriceOf = useLivePriceOf();
  const relayGasToken = useMemo(
    () => (realFunding ? relayGasTokenOf(allocations, livePriceOf) : null),
    [realFunding, allocations, livePriceOf]
  );
  const relayGasQuote = useRelayGasQuote(relayGasToken);
  const relayGasCharge = relayGasQuote?.ok ? relayGasQuote.charge : null;
  const relayGasOn = (id: string) =>
    relayGasCharge !== null && toRegistryTokenId(relayGasCharge.tokenId) === id ? relayGasCharge.qty : 0;

  // A row whose typed amount would leave the funded line under MIN_FUNDED_USD (only with a known price).
  const rowBelowMin = (e: Entry): boolean => {
    const raw = e.id in amounts ? Number(amounts[e.id]) : 0;
    const amt = Number.isFinite(raw) ? raw : 0;
    if (amt <= 0 || e.price <= 0) return false;
    const after = (existingBalances[e.id] ?? 0) + amt - relayGasOn(e.id);
    const afterCents = Math.round(after * e.price * 100) / 100;
    return afterCents < MIN_FUNDED_USD;
  };
  const rowOverMax = (e: Entry): boolean => {
    const raw = e.id in amounts ? Number(amounts[e.id]) : 0;
    return Number.isFinite(raw) && raw > e.avail;
  };

  const anyRowError = entries.some((e) => rowBelowMin(e) || rowOverMax(e));
  const hasFunds = Object.keys(allocations).length > 0;

  // The app's cap on a growing composition (D-528): the tokens joining, funded from outside the
  // composition, on top of it.
  const capBlocked = useMemo(() => {
    const current = new Set(compositionTokenIds ?? []);
    const joining = Object.keys(allocations).filter((id) => !current.has(id));
    return growsPastAppTokenCap(current.size, current.size + joining.length);
  }, [compositionTokenIds, allocations]);

  // Real portfolio with funds selected: the primary signs (P5).
  const signsNow = !!realFunding && hasFunds;
  const blockedByDraft = !!realFunding?.blockedByDraft;

  // A pause the click ran into (the firewall brake cannot be seen on open) blocks the retry too.
  // The vault would refuse this Allocate (017-9b): asked on open, and only where this confirm signs.
  const vaultBlock = useVaultPrecheck(vaultLive && signsNow ? { kind: "allocate", tokenIds: Object.keys(allocations) } : null);
  const relayBlocked = relayPaused || signError?.kind === "relay-paused" || !!vaultBlock;
  const relayGasProblem = signsNow ? relayGasQuoteProblem(relayGasQuote, shellT) : null;
  const canConfirm =
    hasFunds &&
    !anyRowError &&
    !isSigning &&
    !capBlocked &&
    !(signsNow && (blockedByDraft || relayBlocked || relayGasProblem !== null));
  // Only where this confirm would sign: a draft-only edit stays usable while paused.
  const showRelayPaused = relayPaused && !unconfirmedReason && signsNow;
  const showVaultBlock = !!vaultBlock && !showRelayPaused && !unconfirmedReason;
  // D-356, and D-405 for a top-up: not during or after this modal's own attempt (its record
  // would be the one counted). A top-up says it from the open, so it never pushes the amount
  // chips down mid-tap, and for a pending top-up of this same portfolio too: the D-326 strip on
  // the page sits behind this modal's overlay.
  const showPendingNotice = !!realFunding && !!pendingAllocates?.length && !isSigning && !unconfirmedReason;

  // P3: the credit restarts the withdrawal clock of the WHOLE position of a token the
  // portfolio already holds, not just of the amount being added.
  const restartedTokenIds = realFunding
    ? Object.keys(allocations).filter((id) => (existingBalances[id] ?? 0) > 0)
    : [];
  // A funded token that is not in the composition joins it at a 0% target (P2), so
  // rebalancing can move those funds into the other tokens. Said before signing.
  const zeroTargetTokenIds = realFunding
    ? Object.keys(allocations).filter((id) => !(compositionTokenIds ?? []).includes(id))
    : [];
  // D-491: these can't be given a target later, so the note must not tell the user to.
  const sellOnlyTokenIds = zeroTargetTokenIds.filter((id) => !isPortfolioOfferable(id));
  const keepableTokenIds = zeroTargetTokenIds.filter((id) => isPortfolioOfferable(id));

  function setAmount(id: string, value: string) {
    setAmounts((prev) => ({ ...prev, [id]: value }));
  }

  function handleEditConfirm() {
    if (!canConfirm) return;
    for (const [id, qty] of Object.entries(allocations)) onAllocate(id, qty);
    onClose();
  }

  async function handleRealFundingConfirm() {
    // 🔴 Terminal state, as in `preset-review-modal`: the primary is "Close" and this guard is what
    // keeps a second click from signing the same funds again (D-298).
    if (unconfirmedReason) {
      onClose();
      return;
    }
    if (!realFunding || !canConfirm) return;
    setIsSigning(true);
    setSignError(null);
    setBalanceChanged(false);
    setChangeSetReason(null);
    let credited: Array<{ tokenId: string; qty: number }>;
    try {
      // Every funded token that is not in the composition joins it at 0% in the same
      // signature (P2). The orchestrator drops any the chain already has.
      const inComposition = new Set(compositionTokenIds ?? []);
      const tokenAdditions = Object.keys(allocations)
        .filter((id) => !inComposition.has(id))
        .map((tokenId) => ({ tokenId, tolerancePct: realFunding.defaultTolerancePct }));
      ({ credited } = await allocateIntoPortfolio({
        allocations: Object.entries(allocations).map(([tokenId, qty]) => ({ tokenId, qty })),
        tokenAdditions,
        relayGas: relayGasQuote ? relayGasDeductionOf(relayGasQuote) : null,
      }));
    } catch (e) {
      // Same split as `preset-review-modal`: submitted-but-unconfirmed is not a signature failure.
      if (e instanceof RealAllocateUnconfirmedError) setUnconfirmedReason(e.reason);
      else if (e instanceof AmountExceedsBalanceError) setBalanceChanged(true);
      else if (e instanceof RealChangeSetInvalidError) setChangeSetReason(e.reason);
      else setSignError(normalizeWalletError(e));
      return;
    } finally {
      setIsSigning(false);
    }
    // Past the seal the funds are in. Nothing below may surface as a failed signature and
    // offer "Retry" over credited funds, so the courtesy work cannot keep the modal open.
    try {
      realFunding.onFunded(credited);
    } catch (e) {
      console.error("Add tokens: post-credit update failed", e);
    }
    onClose();
  }

  function realStageCopy(stage: RealAllocateStage): string {
    switch (stage) {
      case "preparing":
        return realFunding ? t.realAddPreparing : shellT.realStagePreparing;
      case "signing":
        return shellT.realStageSigning;
      case "submitting":
        return shellT.realStageSubmitting;
      case "awaiting-credit":
        return shellT.realStageAwaitingCredit;
      case "credited":
        return shellT.realStageCredited;
      case "pending-unconfirmed":
        return realFunding ? t.realAddPendingUnconfirmed : shellT.realStagePendingUnconfirmed;
    }
  }

  function errorHeadline(kind: WalletErrorKind): string {
    if (kind === "cancel") return shellT.signErrorCancelled;
    if (kind === "unavailable") return shellT.signErrorUnavailable;
    if (kind === "relay-paused") return shellT.signErrorRelayPaused;
    if (kind === "relay-busy") return shellT.signErrorRelayBusy;
    if (kind === "relay-would-fail") return shellT.signErrorRelayWouldFail;
    if (kind === "relay-check-failed") return shellT.signErrorRelayCheckFailed;
    return shellT.signErrorGeneric;
  }

  const title = t.addFundsTitle;
  // D-529: nothing to assign, known (not still loading or unread, not emptied by a failed Allocate).
  // Unread (D-541) shares its layout: no search over a list that cannot be filled.
  const fundingEmpty = entries.length === 0 && !balanceLoading && !unconfirmedReason;

  // D-591: a list this short is read at a glance. A search already typed keeps its field.
  const searchable = entries.length > SEARCH_FROM || search !== "";
  // Without a search, the focus opens on the title: an amount field is not where to land unasked.
  const initialFocusRef = searchable ? searchRef : titleRef;

  const portfolioRows = visible.filter((e) => e.inPortfolio);
  const otherRows = visible.filter((e) => !e.inPortfolio);
  // With no mix yet (an empty portfolio), "not in this portfolio's mix" would say nothing.
  const hasMix = (compositionTokenIds ?? []).length > 0;

  const fundRow = (e: Entry) => {
    const held =
      e.existingQty > 0
        ? `${t.addTokensInPortfolio}: ${formatTokenAmount(e.existingQty, e.price)} ≈ ${formatUsd(e.existingUsd)}`
        : undefined;
    // D-415: dust is what could never reach MIN_FUNDED_USD, so it counts what the portfolio
    // already holds — the same total rowBelowMin measures.
    const hasDust = Math.round((e.existingQty + e.avail) * e.price * 100) / 100 < MIN_FUNDED_USD;
    if (e.notAvailable || hasDust) {
      return (
        <FundUnavailableRow
          key={e.id}
          symbol={e.symbol}
          reason={e.notAvailable ? t.addTokensNotAvailableYet : t.addTokensDustInPortfolio}
          muted={!e.notAvailable}
        >
          {held ? <p className="mt-px text-[11px] tabular-nums text-slate-400">{held}</p> : null}
          <p className="mt-px text-[11px] tabular-nums text-slate-400">
            {shellT.presetReviewAvailable}: {formatTokenAmount(e.avail, e.price)} ≈ {formatUsd(e.avail * e.price)}
          </p>
        </FundUnavailableRow>
      );
    }
    return (
      <FundAmountRow
        key={e.id}
        tokenId={e.id}
        symbol={e.symbol}
        available={e.avail}
        price={e.price}
        value={amounts[e.id] ?? ""}
        amount={allocations[e.id] ?? 0}
        onChange={(value) => setAmount(e.id, value)}
        inputLabel={`${e.symbol} ${t.withdrawAmount}`}
        labels={{ available: shellT.presetReviewAvailable, wholeBalance: shellT.amountWholeBalance, max: t.withdrawMax }}
        held={held}
        // D-491: it can't join as a target; its funds come in at 0% and are converted.
        note={e.fundsOnly && !e.inPortfolio ? t.addTokensFundsOnly : undefined}
        error={rowOverMax(e) ? t.allocateErrorMax : rowBelowMin(e) ? t.allocateErrorMinFunded : undefined}
        errorId={`add-funds-error-${e.id}`}
      />
    );
  };

  return (
    <Modal
      titleId="add-tokens-title"
      onClose={isSigning ? ignoreClose : onClose}
      initialFocusRef={fundingEmpty ? undefined : initialFocusRef}
      maxWidth="max-w-lg"
    >
      <h2 ref={titleRef} tabIndex={-1} id="add-tokens-title" className="text-lg font-semibold text-slate-100 focus:outline-none">
        {title}
      </h2>
      <p className="mt-1 text-sm text-slate-400">{t.addFundsSubcopy}</p>

      {showPendingNotice ? (
        <p
          role="status"
          className="mt-3 rounded-xl border border-accent/30 bg-accent/5 px-3 py-2 text-[12px] leading-snug text-accent"
        >
          {shellT.pendingAllocateFundingNotice}
        </p>
      ) : null}

      {blockedByDraft ? (
        <p
          role="status"
          className="mt-3 rounded-xl border border-amber-400/40 bg-amber-400/5 px-3 py-2 text-[12px] leading-snug text-amber-200"
        >
          {t.addTokensDraftBlocked}
        </p>
      ) : null}

      {/* The form. Disabled as one unit once an Allocate is in transit (D-298). */}
      <fieldset
        disabled={unconfirmedReason !== null || (!!realFunding && isSigning)}
        className="m-0 min-w-0 border-0 p-0 disabled:opacity-60"
      >
        {/* Nothing to search in an empty funding account; with no field, the Deposit takes the focus. */}
        {searchable ? (
          <div className="mt-4">
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t.searchToken}
              aria-label={t.searchToken}
              className="w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none transition placeholder:text-slate-400 focus:border-accent"
            />
          </div>
        ) : null}

        <div ref={listRef} className="mt-4 space-y-4">
          {visible.length === 0 ? (
            // After a failed Allocate the refetched balance empties the list; "No tokens found"
            // reads as a search problem there, and the notice below already explains.
            unconfirmedReason ? null : (
              <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-2">
                {entries.length === 0 && balanceLoading ? (
                  <div className="px-3 py-8 text-center text-sm text-slate-400">{t.addFundsLoading}</div>
                ) : fundingEmpty && onRetryBalance ? (
                  <div role="alert" className="flex flex-col items-center gap-3 px-3 py-7 text-center">
                    <p className="max-w-xs text-sm text-amber-200">{t.addFundsUnreadable}</p>
                    <button
                      type="button"
                      onClick={onRetryBalance}
                      className="rounded-xl border border-slate-600 px-4 py-2 text-sm font-semibold text-slate-100 transition hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                    >
                      {t.addFundsRetry}
                    </button>
                  </div>
                ) : fundingEmpty ? (
                  // D-529: nothing to assign. The way in is a Deposit, offered right here.
                  <div className="flex flex-col items-center gap-3 px-3 py-7 text-center">
                    <p className="max-w-xs text-sm text-slate-300">{t.addFundsEmpty}</p>
                    {onDeposit ? (
                      <button
                        type="button"
                        onClick={onDeposit}
                        className="rounded-xl border border-accent/30 bg-accent/10 px-4 py-2 text-sm font-semibold text-accent transition hover:bg-accent/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                      >
                        {t.addFundsDeposit}
                      </button>
                    ) : null}
                  </div>
                ) : (
                  <div className="px-3 py-8 text-center text-sm text-slate-400">{t.noTokensFound}</div>
                )}
              </div>
            )
          ) : (
            <>
              {portfolioRows.length > 0 ? (
                <div>
                  <p className="mb-2 text-xs font-medium text-slate-200">{t.addFundsPortfolioTokens}</p>
                  <FundList label={t.addFundsPortfolioTokens}>{portfolioRows.map(fundRow)}</FundList>
                </div>
              ) : null}
              {otherRows.length > 0 ? (
                hasMix ? (
                  <div>
                    <p className="text-xs font-medium text-slate-200">{shellT.presetReviewOtherTokens}</p>
                    <p className="mb-2 mt-0.5 text-[11px] leading-snug text-slate-400">{shellT.presetReviewOtherTokensNote}</p>
                    <FundList label={shellT.presetReviewOtherTokens}>{otherRows.map(fundRow)}</FundList>
                  </div>
                ) : (
                  <FundList label={title}>{otherRows.map(fundRow)}</FundList>
                )
              ) : null}
            </>
          )}
        </div>
        {onDeposit && entries.length > 0 && !unconfirmedReason ? (
          <button
            type="button"
            onClick={onDeposit}
            className="mt-2 rounded text-[12px] text-accent underline decoration-accent/40 underline-offset-4 transition hover:decoration-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            {t.addFundsDepositOther}
          </button>
        ) : null}
        {capBlocked ? (
          <p className="mt-3 text-[11px] leading-snug text-amber-200">
            {t.appTooManyTokens.replace("{max}", String(APP_MAX_TOKENS_PER_PORTFOLIO))}
          </p>
        ) : null}
      </fieldset>

      {signsNow && relayGasCharge && !unconfirmedReason ? (
        <FundingSummary gross={allocations} priceOf={priceOf} relayGas={relayGasCharge} showNet={relayGasProblem === null} />
      ) : null}
      {relayGasProblem && !unconfirmedReason ? (
        <p className="mt-3 text-[11px] leading-snug text-amber-200">{relayGasProblem}</p>
      ) : null}

      {/* One always-mounted live region, so the outcome is announced when it appears. */}
      <div role="status" aria-live="polite">
        {unconfirmedReason ? (
          <div
            id="add-tokens-unconfirmed"
            className="mt-4 rounded-xl border border-amber-400/40 bg-amber-400/5 px-3 py-2 text-[12px] leading-snug text-amber-200"
          >
            <p className="font-semibold">
              {unconfirmedReason === "portfolio_gone"
                ? t.realAddPortfolioGoneTitle
                : unconfirmedReason === "vault_failed"
                ? realFunding
                  ? t.realAddVaultFailedTitle
                  : shellT.realStageVaultFailedTitle
                : shellT.realStagePendingUnconfirmedTitle}
            </p>
            <p className="mt-0.5">
              {unconfirmedReason === "portfolio_gone"
                ? t.realAddPortfolioGone
                : unconfirmedReason === "vault_failed"
                ? realFunding
                  ? t.realAddVaultFailed
                  : shellT.realStageVaultFailed
                : realFunding
                  ? t.realAddPendingUnconfirmed
                  : shellT.realStagePendingUnconfirmed}
            </p>
            <p className="mt-1.5">{realFunding ? t.realAddSeeMyAccount : shellT.realStageSeeMyAccount}</p>
          </div>
        ) : isSigning && realAllocateStage ? (
          <p className="mt-4 flex min-h-[2.5rem] items-center gap-2 rounded-xl border border-accent/30 bg-accent/5 px-3 py-2 text-[12px] leading-tight text-accent">
            <Loader2 aria-hidden className="h-3.5 w-3.5 shrink-0 animate-spin" />
            {realStageCopy(realAllocateStage)}
          </p>
        ) : null}
      </div>

      {keepableTokenIds.length > 0 && !unconfirmedReason ? (
        <p className="mt-4 text-[11px] leading-snug text-slate-400">
          {t.addTokensZeroTargetNote.replace("{tokens}", listSymbols(keepableTokenIds, lang))}
        </p>
      ) : null}

      {sellOnlyTokenIds.length > 0 && !unconfirmedReason ? (
        <p className="mt-4 text-[11px] leading-snug text-slate-400">
          {t.addTokensSellOnlyNote.replace("{tokens}", listSymbols(sellOnlyTokenIds, lang))}
        </p>
      ) : null}

      {restartedTokenIds.length > 0 && !unconfirmedReason ? (
        <p className="mt-4 text-[11px] leading-snug text-slate-400">
          {t.addTokensMaturityRestartNoTime.replace("{tokens}", listSymbols(restartedTokenIds, lang))}
        </p>
      ) : null}

      {changeSetReason ? (
        <div role="alert" className="mt-4 rounded-xl border border-amber-400/40 bg-amber-400/5 px-3 py-2">
          <p className="text-[12px] leading-snug text-amber-200">{changeSetNoticeCopy(changeSetReason, t)}</p>
        </div>
      ) : null}

      {balanceChanged ? (
        <div role="alert" className="mt-4 rounded-xl border border-rose-400/40 bg-rose-400/5 px-3 py-2">
          <p className="text-[12px] font-semibold leading-tight text-rose-200">{shellT.amountExceedsBalanceTitle}</p>
          <p className="mt-0.5 text-[11px] leading-snug text-rose-300/80">{shellT.amountExceedsBalanceBody}</p>
        </div>
      ) : null}

      {showRelayPaused ? (
        <RelayPausedNotice id="add-tokens-relay-paused" title={shellT.relayPausedTitle} body={shellT.relayPausedBody} />
      ) : showVaultBlock && vaultBlock ? (
        <VaultPrecheckNotice id="add-tokens-relay-paused" block={vaultBlock} t={shellT} />
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
      <div className={`mt-6 flex items-center gap-3 ${unconfirmedReason ? "justify-end" : "justify-between"}`}>
        {unconfirmedReason ? null : (
          <button
            ref={backRef}
            type="button"
            onClick={onClose}
            disabled={isSigning}
            className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-300 transition hover:border-slate-500 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            {t.cancel}
          </button>
        )}
        <button
          ref={primaryRef}
          type="button"
          onClick={signsNow || unconfirmedReason ? handleRealFundingConfirm : handleEditConfirm}
          // "Close" must stay usable even when the refetched balance leaves nothing to submit.
          disabled={unconfirmedReason ? false : !canConfirm}
          aria-describedby={
            unconfirmedReason
              ? "add-tokens-unconfirmed"
              : showRelayPaused || showVaultBlock
                ? "add-tokens-relay-paused"
                : undefined
          }
          className="rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          {unconfirmedReason
            ? t.addTokensClose
            : !signsNow
              ? t.addTokensApply
              : isSigning
                ? inFlightButtonLabel(realAllocateStage, t)
                : signError || balanceChanged || changeSetReason
                  ? t.addTokensRetry
                  : t.addTokensSignAndAdd}
        </button>
      </div>
    </Modal>
  );
}
