"use client";

import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  PencilLine,
  Plus,
  PieChart,
  Trash2,
  Undo2,
  TriangleAlert,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { getTokenById, getTokenByNearTokenId } from "@/features/market/lib/token-registry";
import { TokenAvatar } from "@/features/market/lib/token-avatar";
import { useTokenPrices } from "@/features/market/hooks/use-token-prices";
import { isStockToken } from "@/features/market/lib/stock-tokens";
import type { TokenDefinition } from "@/features/market/types";
import { formatUsd, formatTokenAmount, formatCrypto } from "@/features/portfolio-editor/lib/format";
import { chainRegistry, dismissedWithdrawTxHashes, isDepositCredited, type DepositStatusEntry } from "@/features/bridge";
import { nearTokenArrival } from "@/features/bridge/lib/withdrawal-registry";
import type { ContractEvent, WithdrawalInFlightRecord, PendingUnallocationRecord } from "@/features/intents-account/mock-contract/types";
import { mockContract } from "@/features/intents-account/mock-contract";
import { useLoginWallet } from "@/features/login-wallet";
import { PendingAllocatesBanner } from "@/features/vault/components/pending-allocates-banner";
import { ScheduledReturnsNotice } from "@/features/vault/components/scheduled-returns-notice";
import { usePendingAllocates } from "@/features/vault/hooks/use-pending-allocates";
import { useAccountHistory } from "@/features/vault/hooks/use-real-portfolio-history";
import { VAULT_ROUNDTRIP_ENABLED } from "@/features/vault/lib/vault-flag";
import { usePortfolio } from "../context/portfolio-context";
import { useLanguage } from "../context/language-context";
import type { Language } from "@/features/portfolio-editor/types";
import { useAvailableGeneralBalance } from "../hooks/use-available-general-balance";
import { useFundableGeneralBalance } from "../hooks/use-fundable-general-balance";
import { useGeneralBalanceRead, type GeneralBalanceRead } from "../hooks/use-general-balance-read";
import { useNewPortfolioDraft } from "../hooks/use-new-portfolio-draft";
import { shellTranslations } from "../lib/translations";
import {
  ACTIVITY_PAGE_SIZE,
  finishedTimeline,
  isFinishedConversion,
  isHistoryConversion,
  joinActivity,
  toCompletedActivity,
  toHistoryConversions,
  withHistoryConversions,
  type CompletedActivity,
  type PortfolioAction,
} from "../lib/account-activity";
import { computeAccountTotals, hasMovementsInProgress, sumBalanceUsd, sumPortfoliosUsd } from "../lib/account-totals";
import { canDismissWithdrawal } from "../lib/withdrawals-in-flight";
import { IntentsAccountEmptyState } from "./intents-account-empty-state";
import { NewPortfolioDraftCard } from "./new-portfolio-draft-card";
import { OnboardingSteps } from "./onboarding-steps";

type BalanceRow = {
  tokenId: string;
  qty: number;
  token: TokenDefinition | null;
  usd: number;
  price: number;
};

function TokenRow({ row, onSell, sellLabel }: { row: BalanceRow; onSell?: (tokenId: string) => void; sellLabel?: string }) {
  const symbol = row.token?.symbol ?? "?";
  const name = row.token?.name ?? row.tokenId;
  const price = row.price;

  return (
    <div className="flex items-center justify-between py-3">
      <div className="flex items-center gap-3">
        {/* Branded token logo on a neutral chip — the icon carries the identity, so the
            chip itself stays colour-free and never implies a mapping that would clash with
            the editor donut. Falls back to a monogram only for tokens without an icon. */}
        <TokenAvatar symbol={symbol} size={32} className="rounded-lg bg-slate-800" />

        <div>
          <p className="text-sm font-medium text-slate-100">{symbol}</p>
          <p className="max-w-[140px] truncate text-xs text-slate-400 sm:max-w-none">{name}</p>
          {/* D-524: the price of one token, as the edit table shows it under the name; on every
              row, stablecoins too. Hidden without a price rather than reading "$0.00". */}
          {price > 0 ? <p className="text-[11px] tabular-nums text-slate-400">{formatUsd(price)}</p> : null}
        </div>
      </div>
      <div className="text-right">
        <p className="text-sm font-medium text-slate-100">{formatUsd(row.usd)}</p>
        <p className="text-xs text-slate-400">
          {formatTokenAmount(row.qty, price)} {symbol}
        </p>
        {/* A stock has no withdrawal route: selling it here is the way out (plan 039). */}
        {onSell && isStockToken(row.tokenId) ? (
          <button
            type="button"
            onClick={() => onSell(row.tokenId)}
            aria-label={`${sellLabel} ${symbol}`}
            className="mt-1 rounded-lg border border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-200 transition hover:border-slate-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
          >
            {sellLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}

// Every USD figure on this screen is a hardcoded fallback right now (D-179). Say so rather than
// letting the numbers pass as real. Amber, not red: the balances are exact, the conversion isn't.
function PricesUnavailableNotice({ t }: { t: typeof shellTranslations.en }) {
  return (
    <div
      role="status"
      className="flex items-start gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-5 py-4"
    >
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
      <div>
        <p className="font-semibold text-amber-200">{t.pricesUnavailable}</p>
        <p className="mt-0.5 text-sm text-amber-300/70">{t.pricesUnavailableDetail}</p>
      </div>
    </div>
  );
}

function CreatePortfolioBanner({
  onCreatePortfolio,
  t,
}: {
  onCreatePortfolio: () => void;
  t: typeof shellTranslations.en;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-cyan-500/30 bg-cyan-500/10 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="font-semibold text-cyan-200">{t.createPortfolioCta}</p>
        <p className="mt-0.5 text-sm text-cyan-300/70">{t.createPortfolioCtaBody}</p>
      </div>
      <button
        type="button"
        onClick={onCreatePortfolio}
        // D-360: where the focus lands when the draft card that replaced this is discarded.
        data-focus-landing
        className="shrink-0 rounded-xl bg-cyan-500 px-5 py-2.5 text-sm font-medium text-slate-950 transition hover:bg-cyan-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
      >
        {t.createPortfolioCta}
      </button>
    </div>
  );
}

// D-299: Total value = General balance + In portfolios. No "portfolios still loading" or
// "read failed" state here, on purpose: the shell renders its own loading and error screens
// in place of this view (`dashboard-shell.tsx`), so by the time this mounts the portfolio
// read has succeeded and the total is complete.
function BalanceUnreadNotice({
  read,
  t,
}: {
  read: Exclude<GeneralBalanceRead, { status: "read" }>;
  t: typeof shellTranslations.en;
}) {
  if (read.status === "loading") {
    return (
      <p role="status" className="py-6 text-center text-sm text-slate-400">
        {t.myAccountBalanceChecking}
      </p>
    );
  }
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/5 px-4 py-3"
    >
      <p className="min-w-0 flex-1 text-sm text-amber-200">{t.myAccountBalanceUnreadable}</p>
      <button
        type="button"
        onClick={read.retry}
        className="shrink-0 rounded-lg border border-slate-600 px-3 py-1.5 text-xs font-medium text-slate-100 transition hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
      >
        {t.myAccountBalanceRetry}
      </button>
    </div>
  );
}

function AccountTotals({
  generalUsd,
  portfoliosUsd,
  portfolioCount,
  totalUsd,
  showInTransitNote,
  showSignedOutNote,
  totalSpreadUsd,
  t,
}: {
  /** null: the funding account is not read yet (D-541) — its figure and the total are unknown. */
  generalUsd: number | null;
  portfoliosUsd: number;
  /** Portfolios that exist; a New Portfolio Draft is not one (021 R4). */
  portfolioCount: number;
  totalUsd: number;
  showInTransitNote: boolean;
  /** 022-A (D-453): with no wallet the figures are $0 by construction, not a balance. */
  showSignedOutNote: boolean;
  totalSpreadUsd: number;
  t: typeof shellTranslations.en;
}) {
  return (
    // A subtle card, like Performance's metric cards: on the bare page the totals blended
    // into the buttons and the feed around them (operator, s224).
    <div className="rounded-2xl border border-slate-800 bg-surface px-4 py-3">
      {/* The two parts sit on their own lines. On one line with a "·" separator they wrapped
          next to the action buttons on desktop, leaving the dot at the start of line two. */}
      <dl className="text-sm text-slate-400">
        <div>
          <dt className="text-xs">{t.myAccountTotalValue}</dt>
          <dd className="mt-0.5 text-2xl font-semibold tabular-nums text-slate-100">
            {generalUsd === null ? "—" : formatUsd(totalUsd)}
          </dd>
        </div>
        <div className="mt-1 flex gap-1.5">
          <dt>{t.myAccountGeneralBalance}</dt>
          <dd className="tabular-nums text-slate-200">{generalUsd === null ? "—" : formatUsd(generalUsd)}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt>
            {t.myAccountInPortfolios} <span className="tabular-nums">({portfolioCount})</span>
          </dt>
          <dd className="tabular-nums text-slate-200">{formatUsd(portfoliosUsd)}</dd>
        </div>
      </dl>
      {showInTransitNote && (
        <p className="mt-1.5 text-xs text-slate-400">{t.myAccountInTransitNote}</p>
      )}
      {/* In line with the figures it explains, never a banner or an overlay (D-453): it must
          not cover or push the buttons. A shade lighter than the note above so it reads first. */}
      {showSignedOutNote && (
        <p className="mt-1.5 text-xs text-slate-300">{t.myAccountSignedOutNote}</p>
      )}
      {totalSpreadUsd > 0 && (
        <p className="mt-1.5 text-sm font-medium text-cyan-300">
          {t.myAccountTotalSpreadLabel}:{" "}
          <span className="tabular-nums">{formatUsd(totalSpreadUsd)}</span>
          {/* Own line: inline, the card's width left one word of the note alone on line two. */}
          <span className="block text-xs font-normal text-slate-400">{t.myAccountTotalSpreadNote}</span>
        </p>
      )}
    </div>
  );
}

const DEPOSIT_STATUS_STYLES: Record<string, string> = {
  PENDING:   "border-amber-500/40 bg-amber-500/10 text-amber-300",
  COMPLETED: "border-blue-500/40 bg-blue-500/10 text-blue-300",
  CREDITED:  "border-cyan-500/40 bg-cyan-500/10 text-cyan-300",
};

const WITHDRAWAL_STATUS_STYLES: Record<string, string> = {
  PENDING:        "border-amber-500/40 bg-amber-500/10 text-amber-300",
  TX_BROADCASTED: "border-cyan-500/40 bg-cyan-500/10 text-cyan-300",
  SETTLED:        "border-cyan-400/60 bg-cyan-400/15 text-cyan-200",
  DELIVERED:      "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  // Amber, never red: "not confirmed" is an open question, not a failure (005.plan §8 5.4).
  UNCONFIRMED:    "border-amber-400/50 bg-amber-400/10 text-amber-200",
  // FAILED only ever means the funds never left (`fundsState: "untouched"`), so it is told as where
  // the money is, in REFUNDED's neutral — red read as a loss that did not happen (operator s255).
  FAILED:         "border-slate-400/40 bg-slate-400/10 text-slate-200",
  // A conversion 1Click sent back (plan 020 §5.4): resolved and safe, so neither red nor the
  // green of a delivery — the withdrawal did not happen, and nothing was lost.
  REFUNDED:       "border-slate-400/40 bg-slate-400/10 text-slate-200",
};

function truncateHash(hash: string): string {
  if (hash.length <= 12) return hash;
  return `${hash.slice(0, 6)}…${hash.slice(-4)}`;
}

// 027 A-5 (D-444): a finished row says how it ended too, but not as a chip — text and a 12 px icon
// at the start of its date line, so it reads apart from the rows in progress (chip, on the right).
// Never red: nothing that reaches this list is a loss.
type DoneTone = "success" | "neutral" | "muted";

const DONE_TONES: Record<DoneTone, string> = {
  success: "text-emerald-300",
  neutral: "text-slate-300",
  muted:   "text-slate-400",
};

function DoneLabel({ label, tone, Icon = Check }: { label: string; tone: DoneTone; Icon?: LucideIcon }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 font-medium ${DONE_TONES[tone]}`}>
      <Icon aria-hidden="true" className="h-3 w-3" />
      {label}
    </span>
  );
}

// Every row of the feed carries its date (D-364, operator s200). The year only when it is not
// this one: the feed is recent by definition, and the row has little room on a phone.
function formatActivityDate(ts: number, lang: Language): string {
  const date = new Date(ts);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(lang === "es" ? "es-AR" : "en-US", {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

const NEAR_EXPLORER = chainRegistry["near:mainnet"];

// 027 A-4: the account's sections read alike when they shared the small uppercase eyebrow and
// the same filled card. Each now has its own treatment — the summary the one filled block,
// General balance an outlined, narrower card, Recent activity an open list — under a real title.
const SECTION_HEADING = "text-sm font-semibold text-slate-200";

// C1: a pending unallocation in flight (funds reserved in the portfolio, arriving to the
// General Balance). PENDING shows the calm "releasing" chip; FAILED is rare (the async leg
// reverted) — the funds stayed safely in the portfolio.
const UNALLOCATION_STATUS_STYLES: Record<string, string> = {
  PENDING: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  FAILED:  "border-red-500/40 bg-red-500/10 text-red-300",
};

type ActivityFeedItem =
  | { kind: "deposit"; ts: number; deposit: DepositStatusEntry }
  | { kind: "withdrawal"; ts: number; withdrawal: WithdrawalInFlightRecord }
  | { kind: "unallocation"; ts: number; unallocation: PendingUnallocationRecord };

/** What the feed knows about the account's finished history (017-7; from the history database, 028-7). */
export type ActivityHistoryState =
  /** No history read for this account (mock portfolios, Preview): the feed is today's lists. */
  | { status: "off" }
  | { status: "loading" }
  | { status: "error"; onRetry: () => void }
  /** Past the cap of transactions per account (028 decision 8): its rows would be incomplete. */
  | { status: "unavailable" }
  | {
      status: "ready";
      completed: CompletedActivity[];
      /** Converting Withdrawals on the pages read (028-8): every device sees them, not only the one that made them. */
      conversions: WithdrawalInFlightRecord[];
      /** The account's initial load has not finished: older rows may still be missing. */
      loading?: boolean;
      /** Still behind after the view's re-reads. */
      outOfDate?: boolean;
      /** More pages to read on the server. */
      more?: { fetching: boolean; fetch: () => void };
    };

// The feed's rows told their type only by a text arrow on money rows, and not at all on
// portfolio rows (operator, s224). A tinted tile per type lets the list be scanned without
// reading it. Decorative: the row's own text still names the action.
type ActivityIconKind = "deposit" | "withdrawal" | "returning" | PortfolioAction;

const ACTIVITY_ICONS: Record<ActivityIconKind, { Icon: LucideIcon; tone: string }> = {
  deposit:     { Icon: ArrowDownLeft, tone: "bg-emerald-500/10 text-emerald-300" },
  withdrawal:  { Icon: ArrowUpRight,  tone: "bg-sky-500/10 text-sky-300" },
  returning:   { Icon: Undo2,         tone: "bg-slate-700/40 text-slate-300" },
  moved:       { Icon: Undo2,         tone: "bg-slate-700/40 text-slate-300" },
  created:     { Icon: Plus,          tone: "bg-cyan-500/10 text-cyan-300" },
  added:       { Icon: Plus,          tone: "bg-cyan-500/10 text-cyan-300" },
  composition: { Icon: PieChart,      tone: "bg-violet-500/10 text-violet-300" },
  edited:      { Icon: PieChart,      tone: "bg-violet-500/10 text-violet-300" },
  renamed:     { Icon: PencilLine,    tone: "bg-violet-500/10 text-violet-300" },
  // Rose, not red: the user deleted it on purpose — red stays for failures.
  deleted:     { Icon: Trash2,        tone: "bg-rose-500/10 text-rose-300" },
};

function ActivityIcon({ kind }: { kind: ActivityIconKind }) {
  const { Icon, tone } = ACTIVITY_ICONS[kind];
  return (
    <span aria-hidden="true" className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${tone}`}>
      <Icon className="h-4 w-4" />
    </span>
  );
}

function DepositRow({ deposit, t }: { deposit: DepositStatusEntry; t: typeof shellTranslations.en }) {
  const token = getTokenByNearTokenId(deposit.near_token_id);
  const chain = chainRegistry[deposit.chain];
  const explorerUrl = chain ? chain.explorerTxUrl(deposit.tx_hash) : null;
  const statusStyle = DEPOSIT_STATUS_STYLES[deposit.status] ?? DEPOSIT_STATUS_STYLES.PENDING;
  const statusLabel =
    deposit.status === "CREDITED"
      ? t.depositStatusCredited
      : deposit.status === "COMPLETED"
        ? t.depositStatusCompleted
        : t.depositStatusPending;

  const qty = deposit.amount / Math.pow(10, deposit.decimals);
  const symbol = token?.symbol ?? truncateHash(deposit.near_token_id);

  return (
    <div className="flex items-center justify-between gap-3 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <ActivityIcon kind="deposit" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="truncate text-sm font-medium text-slate-100">
            <span className="mr-1.5 text-slate-400">{t.historyEventDeposit}</span>
            {formatCrypto(qty)} {symbol}
          </p>
          <p className="text-xs text-slate-400">
            {chain?.displayName ?? deposit.chain}
            {" · "}
            {explorerUrl ? (
              <a
                href={explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
                title={t.depositViewOnExplorer}
                className="font-mono text-slate-400 underline-offset-2 hover:text-cyan-400 hover:underline"
              >
                {truncateHash(deposit.tx_hash)}
              </a>
            ) : (
              <span className="font-mono">{truncateHash(deposit.tx_hash)}</span>
            )}
          </p>
        </div>
      </div>
      <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-medium ${statusStyle}`}>
        {statusLabel}
      </span>
    </div>
  );
}

function WithdrawalRow({
  withdrawal,
  when,
  t,
  onDismiss,
}: {
  withdrawal: WithdrawalInFlightRecord;
  when: string;
  t: typeof shellTranslations.en;
  /** D-463 (023-B): shown only once the row qualifies (`canDismissWithdrawal`). */
  onDismiss?: (intentId: string) => void;
}) {
  const token = getTokenById(withdrawal.tokenId);
  const symbol = token?.symbol ?? withdrawal.tokenId;
  const chain = chainRegistry[withdrawal.chainId];
  const statusStyle = WITHDRAWAL_STATUS_STYLES[withdrawal.status] ?? WITHDRAWAL_STATUS_STYLES.PENDING;

  // D-392: a Converting Withdrawal names what arrives, and its SETTLED is 1Click converting.
  const deliveryTicker = withdrawal.deliveryTokenId
    ? (getTokenById(withdrawal.deliveryTokenId)?.symbol ?? withdrawal.deliveryTokenId).split("(")[0].trim()
    : null;
  // D-386 (a): an `omft` row sent to NEAR lands as its NEAR token (sol.omft.near), not native.
  const arrivesAs = deliveryTicker ?? nearTokenArrival(withdrawal.tokenId, withdrawal.chainId);
  // Only while unconfirmed: it is what the user quotes if the money neither arrives nor returns.
  const conversionCode =
    withdrawal.status === "UNCONFIRMED" && withdrawal.depositAddress
      ? truncateHash(withdrawal.depositAddress)
      : null;

  const statusLabel =
    withdrawal.status === "TX_BROADCASTED" ? t.withdrawalStatusBroadcasted :
    withdrawal.status === "SETTLED"        ? (deliveryTicker ? t.withdrawalStatusConverting : t.withdrawalStatusSettled) :
    withdrawal.status === "REFUNDED"       ? t.withdrawalStatusRefunded :
    withdrawal.status === "DELIVERED"      ? t.withdrawalStatusDelivered :
    withdrawal.status === "UNCONFIRMED"    ? t.withdrawalStatusUnconfirmed :
    withdrawal.status === "FAILED"         ? t.withdrawalStatusFailed :
    t.withdrawalStatusPending;

  // `txHash` is the NEAR SETTLEMENT transaction and `destinationTxHash` is the one on the
  // destination chain — two different explorers. Sending both through `chain` (the
  // destination) was harmless while the mock never set `txHash`; block 5.4 wires the real
  // one, and it would have linked a NEAR hash into e.g. Arbiscan.
  const txLink = withdrawal.txHash
    ? chainRegistry["near:mainnet"]?.explorerTxUrl(withdrawal.txHash) ?? null
    : null;
  const destTxLink = withdrawal.destinationTxHash && chain
    ? chain.explorerTxUrl(withdrawal.destinationTxHash)
    : null;
  // While unconfirmed, the code replaces the hash: it is what support looks 1Click up by, and both
  // together broke the date line into 2-3 lines at 390 px (020-3 QA). The hash stays in the record.
  const shownHash = conversionCode ? undefined : (withdrawal.destinationTxHash ?? withdrawal.txHash);
  const shownLink = destTxLink ?? txLink;

  // D-463 (023-B): open for over a day and nothing could close it. Say what is known — out of the
  // balance or not even that — and where it was headed, so hiding it is an informed choice.
  const dismissable = onDismiss !== undefined && canDismissWithdrawal(withdrawal, Date.now());
  const stuckNote = (withdrawal.leftBalance || withdrawal.txHash
    ? t.withdrawalStuckLeftBalance
    : t.withdrawalStuckUnknown
  ).split("{address}");

  // D-440: a conversion that is over sits among the finished rows, and reads like them (A-5).
  const finished = isFinishedConversion(withdrawal);
  const details = (
    <>
      {when} · {chain?.displayName ?? withdrawal.chainId}
      {arrivesAs && (
        <>
          {" · "}
          <span className="whitespace-nowrap">{t.withdrawalArrivesAs.replace("{symbol}", arrivesAs)}</span>
        </>
      )}
      {conversionCode && (
        <>
          {" · "}
          <span className="font-mono">{t.withdrawalConversionCode.replace("{code}", conversionCode)}</span>
        </>
      )}
      {shownHash && (
        <>
          {" · "}
          {shownLink ? (
            <a
              href={shownLink}
              target="_blank"
              rel="noopener noreferrer"
              title={t.depositViewOnExplorer}
              className="font-mono text-slate-400 underline-offset-2 hover:text-cyan-400 hover:underline"
            >
              {truncateHash(shownHash)}
            </a>
          ) : (
            <span className="font-mono">{truncateHash(shownHash)}</span>
          )}
        </>
      )}
    </>
  );

  return (
    <div className="flex items-center justify-between gap-3 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <ActivityIcon kind="withdrawal" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="truncate text-sm font-medium text-slate-100">
            {/* s217: said only "↑", next to deposits that said "↓ Deposit"; s224: the arrow is the tile. */}
            <span className="mr-1.5 text-slate-400">{t.historyEventWithdrawal}</span>
            {formatCrypto(withdrawal.qty)} {symbol}
          </p>
          {finished ? (
            <p className="flex min-w-0 items-center gap-1.5 text-xs text-slate-400">
              {withdrawal.status === "DELIVERED" ? (
                <DoneLabel label={t.withdrawalStatusDelivered} tone="success" />
              ) : (
                <DoneLabel label={t.withdrawalStatusRefunded} tone="neutral" Icon={Undo2} />
              )}
              <span aria-hidden="true">·</span>
              {/* One line: what does not fit is the end — the hash — never the date (A-5). */}
              <span className="min-w-0 truncate">{details}</span>
            </p>
          ) : (
            <p className="text-xs text-slate-400">{details}</p>
          )}
          {dismissable && (
            <p className="text-xs text-amber-200/90">
              {stuckNote[0]}
              <span className="font-mono">{truncateHash(withdrawal.destinationAddress)}</span>
              {stuckNote[1]}{" "}
              <button
                type="button"
                onClick={() => onDismiss(withdrawal.intentId)}
                className="rounded font-medium text-slate-200 underline underline-offset-2 transition hover:text-cyan-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
              >
                {t.withdrawalHide}
              </button>
            </p>
          )}
        </div>
      </div>
      {!finished && (
        <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-medium ${statusStyle}`}>
          {statusLabel}
        </span>
      )}
    </div>
  );
}

function UnallocationRow({ unallocation, when, t }: { unallocation: PendingUnallocationRecord; when: string; t: typeof shellTranslations.en }) {
  const token = getTokenById(unallocation.tokenId);
  const symbol = token?.symbol ?? unallocation.tokenId;
  const failed = unallocation.status === "FAILED";
  const statusStyle = UNALLOCATION_STATUS_STYLES[unallocation.status] ?? UNALLOCATION_STATUS_STYLES.PENDING;
  const statusLabel = failed ? t.unallocationStatusFailed : t.unallocationStatusPending;

  return (
    <div className="flex items-center justify-between gap-3 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <ActivityIcon kind="returning" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="truncate text-sm font-medium text-slate-100">
            {formatCrypto(unallocation.qty)} {symbol}
          </p>
          <p className="text-xs text-slate-400">
            {when} · {failed ? t.unallocationFailedNote : t.unallocationArriving}
          </p>
        </div>
      </div>
      <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-medium ${statusStyle}`}>
        {statusLabel}
      </span>
    </div>
  );
}

function portfolioActivityLabel(
  row: Extract<CompletedActivity, { kind: "portfolio" }>,
  name: string,
  t: typeof shellTranslations.en
): string {
  const quoted = name || t.activityPortfolioUnnamed;
  switch (row.action) {
    case "created": return t.activityPortfolioCreated.replace("{name}", quoted);
    case "added": return t.activityPortfolioAdded.replace("{name}", quoted);
    case "moved": return t.activityPortfolioMoved.replace("{name}", quoted);
    case "edited": return t.activityPortfolioEdited.replace("{name}", quoted);
    case "composition": return t.activityPortfolioComposition.replace("{name}", quoted);
    case "deleted":
      return (row.byOperator ? t.activityPortfolioRemoved : t.activityPortfolioDeleted).replace("{name}", quoted);
    case "renamed":
      return t.activityPortfolioRenamed
        .replace("{from}", row.renamedFrom || t.activityPortfolioUnnamed)
        .replace("{to}", row.renamedTo || quoted);
  }
}

// What a portfolio row moved, in tokens (D-431). On the date line and one line whatever the
// count, so every row of the feed keeps the same height (operator, s224): on the right they
// squeezed the label into 2-4 lines at 390 px. What does not fit fades out at the right edge,
// and the portfolio's History has the full list. Screen readers still get every amount.
function TokenAmountChips({ amounts }: { amounts: { tokenId: string; qty: number }[] }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setOverflowing(el.scrollWidth > el.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [amounts]);

  const fade = "linear-gradient(to right, black 70%, transparent)";
  return (
    <span
      ref={ref}
      className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden"
      style={overflowing ? { maskImage: fade, WebkitMaskImage: fade } : undefined}
    >
      {amounts.map(({ tokenId, qty }) => {
        const symbol = getTokenById(tokenId)?.symbol ?? tokenId;
        return (
          <span
            key={tokenId}
            // Compact (16 px tall, like the date's line) so a row with chips is no taller.
            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-slate-700/60 bg-card pl-0.5 pr-1.5 text-[11px] leading-[14px] tabular-nums text-slate-300"
          >
            <TokenAvatar symbol={symbol} size={12} className="rounded-full" />
            {formatCrypto(qty)} {symbol}
          </span>
        );
      })}
    </span>
  );
}

// A finished portfolio row (D-364): what the user did, and a way into the portfolio while it
// still exists. A deleted portfolio has no tab to open. Amounts are nominal (D-431).
function CompletedPortfolioRow({
  row,
  liveName,
  when,
  onOpen,
  t,
}: {
  row: Extract<CompletedActivity, { kind: "portfolio" }>;
  liveName: string | undefined;
  when: string;
  onOpen?: () => void;
  t: typeof shellTranslations.en;
}) {
  const label = portfolioActivityLabel(row, liveName ?? row.name, t);
  // The date goes under the label, as on the rows in progress: beside it, it cut «…to your
  // general balance» off at 390 px (017-8). The label wraps rather than lose its end.
  const content = (
    <>
      <ActivityIcon kind={row.action} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="break-words text-sm font-medium text-slate-100">{label}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-slate-400">
          <DoneLabel label={t.activityDoneConfirmed} tone="muted" />
          <span aria-hidden="true">·</span>
          <span className="shrink-0">{when}</span>
          {row.amounts.length > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <TokenAmountChips amounts={row.amounts} />
            </>
          )}
        </span>
      </span>
    </>
  );
  return onOpen ? (
    // The wrapper carries the list's divider; the button bleeds past it only for its hover,
    // or the divider would bleed (and round) with it.
    <div>
      <button
        type="button"
        onClick={onOpen}
        className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-lg px-2 py-3 text-left transition hover:bg-slate-800/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-300/60"
      >
        {content}
      </button>
    </div>
  ) : (
    <div className="flex items-center gap-3 py-3">{content}</div>
  );
}

// A finished deposit or withdrawal read from the chain. The symbol already names the network
// ("USDT(NEAR)"), and the hash is the NEAR transaction, so it links to the NEAR explorer.
function CompletedMovementRow({
  row,
  when,
  t,
}: {
  row: Extract<CompletedActivity, { kind: "deposit" | "withdrawal" }>;
  when: string;
  t: typeof shellTranslations.en;
}) {
  const symbol = getTokenById(row.tokenId)?.symbol ?? row.tokenId;
  const deposit = row.kind === "deposit";
  return (
    // Date on the second line, as on the rows in progress (017-8): beside the label it cut
    // the symbol at 390 px.
    <div className="flex items-center gap-3 py-3">
      <ActivityIcon kind={deposit ? "deposit" : "withdrawal"} />
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="break-words text-sm font-medium text-slate-100">
          <span className="mr-1.5 text-slate-400">
            {deposit ? t.historyEventDeposit : t.historyEventWithdrawal}
          </span>
          {formatCrypto(row.qty)} {symbol}
        </p>
        <p className="flex min-w-0 items-center gap-1.5 text-xs text-slate-400">
          {/* A direct withdrawal is only "Sent": the chain confirms it left, not that it arrived. */}
          {deposit ? (
            <DoneLabel label={t.depositStatusCredited} tone="success" />
          ) : (
            <DoneLabel label={t.activityDoneSent} tone="neutral" />
          )}
          <span aria-hidden="true">·</span>
          <span className="shrink-0">{when}</span>
          <span aria-hidden="true">·</span>
          <a
            href={NEAR_EXPLORER.explorerTxUrl(row.txHash)}
            target="_blank"
            rel="noopener noreferrer"
            title={t.depositViewOnExplorer}
            className="min-w-0 truncate font-mono text-slate-400 underline-offset-2 hover:text-cyan-400 hover:underline"
          >
            {truncateHash(row.txHash)}
          </a>
        </p>
      </div>
    </div>
  );
}

function RecentActivityFeed({
  deposits,
  withdrawals,
  unallocations,
  history,
  livePortfolioNames,
  onOpenPortfolio,
  onDismissWithdrawal,
  lang,
  t,
}: {
  deposits: DepositStatusEntry[];
  withdrawals: WithdrawalInFlightRecord[];
  unallocations: PendingUnallocationRecord[];
  history: ActivityHistoryState;
  /** The account's portfolios now, by id: their names win, and only they can be opened. */
  livePortfolioNames: ReadonlyMap<string, string>;
  onOpenPortfolio?: (portfolioId: string) => void;
  onDismissWithdrawal?: (intentId: string) => void;
  lang: Language;
  t: typeof shellTranslations.en;
}) {
  // Only the finished rows page; what is in progress is always on screen (D-364 5).
  const [shown, setShown] = useState(ACTIVITY_PAGE_SIZE);

  const joined = joinActivity({
    completed: history.status === "ready" ? history.completed : [],
    historyRead: history.status === "ready",
    withdrawals: history.status === "ready" ? withHistoryConversions(withdrawals, history.conversions) : withdrawals,
    bridgeDeposits: deposits.map((d) => ({ credited: isDepositCredited(d.status), entry: d })),
  });
  // D-440: a conversion that is over is a finished row too, filed by date with the chain's.
  const finished = finishedTimeline(joined.completed, joined.withdrawals.filter(isFinishedConversion));
  const inProgress = joined.withdrawals.filter((w) => !isFinishedConversion(w));

  const items: ActivityFeedItem[] = [
    ...unallocations.map((u) => ({ kind: "unallocation" as const, ts: u.ts, unallocation: u })),
    ...inProgress.map((w) => ({ kind: "withdrawal" as const, ts: w.ts, withdrawal: w })),
    ...joined.bridgeDeposits.map((d) => ({ kind: "deposit" as const, ts: 0, deposit: d.entry })),
  ];

  const ready = history.status === "ready" ? history : null;
  if (items.length === 0 && finished.length === 0 && (history.status === "off" || (ready && !ready.loading))) {
    return null;
  }

  const when = (ts: number) => formatActivityDate(ts, lang);
  const visibleFinished = finished.slice(0, shown);
  // "Show more" (D-364 5) shows the next rows already read and, past them, reads the next page
  // (028-7). Conversions this browser tracks sit among them by date, so they count too.
  const showMore = () => {
    setShown((n) => n + ACTIVITY_PAGE_SIZE);
    if (ready?.more && finished.length <= shown + ACTIVITY_PAGE_SIZE) ready.more.fetch();
  };

  return (
    <section aria-labelledby="recent-activity-heading">
      <h2 id="recent-activity-heading" className={`mb-3 ${SECTION_HEADING}`}>
        {t.recentActivityHeading}
      </h2>
      {/* An open list, no card (A-4): it also gives each row the card's 32 px back on a phone. */}
      <div className="divide-y divide-slate-800 border-y border-slate-800">
        {/* In progress first, each with its status chip; then what is finished, with its date
            where the chip would be — the two stay told apart (D-364 1). */}
        {items.map((item) =>
          item.kind === "deposit" ? (
            <DepositRow
              key={`deposit:${item.deposit.tx_hash}:${item.deposit.chain}`}
              deposit={item.deposit}
              t={t}
            />
          ) : item.kind === "unallocation" ? (
            <UnallocationRow
              key={`unallocation:${item.unallocation.unallocationId}`}
              unallocation={item.unallocation}
              when={when(item.ts)}
              t={t}
            />
          ) : (
            <WithdrawalRow
              key={`withdrawal:${item.withdrawal.intentId}`}
              withdrawal={item.withdrawal}
              when={when(item.ts)}
              t={t}
              // The history's rows have no record here to hide (028-8).
              onDismiss={isHistoryConversion(item.withdrawal) ? undefined : onDismissWithdrawal}
            />
          )
        )}
        {visibleFinished.map((item) => {
          if (item.kind === "conversion") {
            return (
              <WithdrawalRow
                key={`withdrawal:${item.withdrawal.intentId}`}
                withdrawal={item.withdrawal}
                when={when(item.ts)}
                t={t}
              />
            );
          }
          const { row } = item;
          return row.kind === "portfolio" ? (
            <CompletedPortfolioRow
              key={`done:${row.id}`}
              row={row}
              liveName={livePortfolioNames.get(row.portfolioId)}
              when={when(row.ts)}
              onOpen={
                onOpenPortfolio && livePortfolioNames.has(row.portfolioId)
                  ? () => onOpenPortfolio(row.portfolioId)
                  : undefined
              }
              t={t}
            />
          ) : (
            <CompletedMovementRow key={`done:${row.id}`} row={row} when={when(row.ts)} t={t} />
          );
        })}
        {(history.status === "loading" || ready?.loading) && (
          <p role="status" className="py-3 text-xs text-slate-400">
            {t.activityHistoryLoading}
          </p>
        )}
        {ready?.outOfDate && !ready.loading && (
          <p role="status" className="py-3 text-xs text-slate-400">
            {t.historyMayBeBehind}
          </p>
        )}
        {history.status === "unavailable" && (
          <p role="status" className="py-3 text-xs text-amber-200">
            {t.historyUnavailable}
          </p>
        )}
        {history.status === "error" && (
          // Never an empty history on a failed read: "nothing finished" would be a claim about
          // the chain. What this browser tracks is still listed above.
          <div role="status" className="flex flex-wrap items-center justify-between gap-2 py-3">
            <p className="min-w-0 flex-1 text-xs text-amber-200">{t.activityHistoryError}</p>
            <button
              type="button"
              onClick={history.onRetry}
              className="shrink-0 rounded-lg border border-slate-600 px-3 py-1.5 text-xs font-medium text-slate-100 transition hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
            >
              {t.activityHistoryRetry}
            </button>
          </div>
        )}
      </div>
      {(finished.length > shown || !!ready?.more) && (
        <button
          type="button"
          onClick={showMore}
          disabled={ready?.more?.fetching}
          className="mt-2 w-full rounded-xl border border-slate-700 py-2 text-sm font-medium text-slate-200 transition hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 disabled:opacity-60"
        >
          {t.activityShowMore}
        </button>
      )}
    </section>
  );
}

function BalanceSection({
  headingId,
  label,
  hint,
  rows,
  otherRows = [],
  otherLabel,
  onSell,
  sellLabel,
}: {
  headingId: string;
  label: string;
  hint?: string;
  rows: BalanceRow[];
  /**
   * D-335: the General Balance's tokens outside the curated list, as a subsection of the SAME
   * section — the totals' "General balance" figure counts them, so the list under that title
   * has to as well, or summing it by hand never reaches the figure.
   */
  otherRows?: BalanceRow[];
  otherLabel?: string;
  onSell?: (tokenId: string) => void;
  sellLabel?: string;
}) {
  return (
    // Narrower than the column (operator, A-4), left-aligned: full width left a ~400 px gap
    // between a token and its value. On a phone there is no room to spare, so it fills it.
    <section aria-labelledby={headingId} className="w-full sm:max-w-md">
      <h2 id={headingId} className={`${hint ? "mb-0.5" : "mb-3"} ${SECTION_HEADING}`}>
        {label}
      </h2>
      {hint && <p className="mb-3 text-xs text-slate-400">{hint}</p>}
      <div className="divide-y divide-slate-800 rounded-2xl border border-slate-800 px-4">
        {rows.map((row) => (
          <TokenRow key={row.tokenId} row={row} onSell={onSell} sellLabel={sellLabel} />
        ))}
        {otherRows.length > 0 && (
          <>
            <h3
              id={`${headingId}-other`}
              className="pb-1 pt-3 text-xs font-medium text-slate-400"
            >
              {otherLabel}
            </h3>
            {otherRows.map((row) => (
              <TokenRow key={row.tokenId} row={row} />
            ))}
          </>
        )}
      </div>
    </section>
  );
}

export function IntentsAccountView({
  onAddFunds,
  onWithdraw,
  onCreatePortfolio,
  onDepositForDraft,
  onViewDraft,
  onConfirmDraft,
  onOpenPortfolio,
  signedOut = false,
  onConnect,
  deposits = [],
  pendingWithdrawals = [],
  pendingUnallocations = [],
  onDismissWithdrawal,
  onSellStock,
}: {
  onAddFunds?: () => void;
  onWithdraw?: () => void;
  onCreatePortfolio?: () => void;
  /** Opens the deposit framed around the New Portfolio Draft (016 block 2.3). */
  onDepositForDraft?: () => void;
  /** Goes to the New Portfolio Draft's tab (019-4). */
  onViewDraft?: () => void;
  /** Opens the confirmation of a funded New Portfolio Draft (016 block 2.4). */
  onConfirmDraft?: () => void;
  /** Goes to a portfolio's tab, from its row in the recent activity (D-364). */
  onOpenPortfolio?: (portfolioId: string) => void;
  /**
   * 022-A (D-453): no wallet connected. The view keeps its shape at $0, says why, and its only
   * money action is connecting: no deposit, and withdraw disabled.
   */
  signedOut?: boolean;
  onConnect?: () => void;
  deposits?: DepositStatusEntry[];
  pendingWithdrawals?: WithdrawalInFlightRecord[];
  pendingUnallocations?: PendingUnallocationRecord[];
  /** D-463 (023-B): «Hide» on a withdrawal open for over a day that nothing could close. */
  onDismissWithdrawal?: (intentId: string) => void;
  /** Plan 039: "Sell" on a stock. The shell hosts the dialog: a sale can empty this view's balance. */
  onSellStock?: (tokenId: string) => void;
}) {
  const { lang } = useLanguage();
  const t = shellTranslations[lang];
  const { prices, pricesUnavailable, stockPricesUnavailable } = useTokenPrices();
  const { intentsAccountId } = useLoginWallet();
  const contractVersion = useSyncExternalStore(mockContract.subscribe, mockContract.getVersion, mockContract.getVersion);
  // D-142 (Opción A): available = real on-chain − Σ mock portfolio allocations (mock
  // generalBalance fallback while the on-chain query loads). Shared with the editor's
  // allocate flow so display and allocate source can't drift (5.3.2).
  const displayBalance = useAvailableGeneralBalance();
  const { portfolios } = usePortfolio();
  const { pending: pendingAllocates } = usePendingAllocates(intentsAccountId);
  const { draft } = useNewPortfolioDraft();
  const fundable = useFundableGeneralBalance();
  const balanceRead = useGeneralBalanceRead();

  // 017-7: the account's finished history — since 028-7 from the history database, a page at
  // a time, on every device. Off with the vault round-trip off (mock portfolios, Preview).
  const accountHistory = useAccountHistory(intentsAccountId, true);
  const completedActivity = useMemo(
    () => (accountHistory.data ? toCompletedActivity(accountHistory.data.events, accountHistory.data.names) : []),
    [accountHistory.data]
  );
  // 028-8: what this browser hid (D-463) stays hidden, though the history lists it on every device.
  const historyConversions = useMemo(() => {
    if (!accountHistory.data || !intentsAccountId) return [];
    const dismissed = dismissedWithdrawTxHashes(intentsAccountId);
    return toHistoryConversions(accountHistory.data.events).filter((w) => !dismissed.has(w.txHash ?? ""));
    // `pendingWithdrawals` changes when a record is dismissed: the store is read again then.
  }, [accountHistory.data, intentsAccountId, pendingWithdrawals]);
  const history: ActivityHistoryState =
    !VAULT_ROUNDTRIP_ENABLED || !intentsAccountId
      ? { status: "off" }
      : accountHistory.data?.unavailable
        ? { status: "unavailable" }
        : accountHistory.data
          ? {
              status: "ready",
              completed: completedActivity,
              conversions: historyConversions,
              loading: accountHistory.data.loading,
              outOfDate: accountHistory.outOfDate,
              ...(accountHistory.hasNextPage && {
                more: { fetching: accountHistory.isFetchingNextPage, fetch: () => void accountHistory.fetchNextPage() },
              }),
            }
          : accountHistory.isError
            ? { status: "error", onRetry: () => void accountHistory.refetch() }
            : { status: "loading" };
  const livePortfolioNames = useMemo(
    () => new Map(portfolios.filter((p) => p.isReal).map((p) => [p.id, p.name])),
    [portfolios]
  );

  const totalSpreadUsd = useMemo(() => {
    if (!intentsAccountId) return 0;
    return mockContract
      .getEvents(intentsAccountId)
      .filter(
        (e): e is Extract<ContractEvent, { kind: "external_rebalance" }> =>
          e.kind === "external_rebalance"
      )
      .reduce((sum, e) => sum + e.attributed_spread, 0);
  }, [intentsAccountId, contractVersion]);

  // Split: depositable tokens → "General balance"; others → "Other tokens"
  const curatedRows: BalanceRow[] = [];
  const otherRows: BalanceRow[] = [];

  for (const [tokenId, qty] of displayBalance) {
    if (qty <= 0) continue;
    const token = getTokenById(tokenId);
    const price = prices[tokenId]?.usdPrice ?? token?.fallbackUsdPrice ?? 0;
    const usd = qty * price;
    const row: BalanceRow = { tokenId, qty, token, usd, price };
    if (token?.depositable) {
      curatedRows.push(row);
    } else {
      otherRows.push(row);
    }
  }

  // A held stock's USD figures are hand-written while its price read is down: say so, as D-179 does.
  const holdsStock =
    [...displayBalance].some(([id, qty]) => qty > 0 && isStockToken(id)) ||
    portfolios.some((portfolio) => Object.entries(portfolio.deposits).some(([id, qty]) => qty > 0 && isStockToken(id)));

  // The tab strip's My Account figure sums the same way (computeTabValues).
  const totals = computeAccountTotals(sumBalanceUsd(displayBalance, prices), sumPortfoliosUsd(portfolios, prices));
  // D-299 / D3: the totals count only what the chain confirms, so while anything is still
  // moving they may not show it yet — say so, and only then.
  const showInTransitNote = hasMovementsInProgress({
    pendingAllocates: pendingAllocates?.length ?? 0,
    deposits,
    unallocations: pendingUnallocations,
  });
  const activityFeed = (
    <RecentActivityFeed
      deposits={deposits}
      withdrawals={pendingWithdrawals}
      unallocations={pendingUnallocations}
      history={history}
      livePortfolioNames={livePortfolioNames}
      onOpenPortfolio={onOpenPortfolio}
      onDismissWithdrawal={onDismissWithdrawal}
      lang={lang}
      t={t}
    />
  );
  const hasGeneralBalance = curatedRows.length > 0 || otherRows.length > 0;
  // D-541: an empty balance before the first on-chain read is the mock fallback, not a fact.
  // The figure shows "—" and the empty state gives way to the read's own state.
  const balanceUnread = !signedOut && !hasGeneralBalance && balanceRead.status !== "read" ? balanceRead : null;
  // 016 block 2.3: a saved New Portfolio Draft with nothing to fund it yet. While the first
  // balance read is in flight it counts as waiting — the view shows the fallback balance
  // meanwhile, and a draft is saved precisely when there were no funds. Once there are
  // (≥ $1), block 2.4's "ready" variant: the same card, now asking for the signature.
  // 022-B: signed out there is no balance to read — connecting comes first.
  const draftReady = fundable.status === "known" && fundable.fundable;
  const draftCard = !draft || !onViewDraft ? null : signedOut ? (
    onConnect ? <NewPortfolioDraftCard variant="signed-out" draft={draft} onConnect={onConnect} onView={onViewDraft} /> : null
  ) : fundable.status === "loading" || fundable.status === "error" ? (
    // D-486: the card stays, but "waiting for funds" would be a guess until the balance is read.
    <NewPortfolioDraftCard variant="loading" draft={draft} onView={onViewDraft} />
  ) : draftReady ? (
    onConfirmDraft ? (
      <NewPortfolioDraftCard
        variant="ready"
        draft={draft}
        amountUsd={fundable.usd}
        onConfirm={onConfirmDraft}
        onView={onViewDraft}
      />
    ) : null
  ) : onDepositForDraft ? (
    <NewPortfolioDraftCard variant="waiting" draft={draft} onDeposit={onDepositForDraft} onView={onViewDraft} />
  ) : null;
  const hasDraftCard = draftCard !== null;
  // 021 R3: the same summary in every state, an empty account included — at $0 it still
  // shows the three figures and both buttons, so the screen does not change shape the
  // moment the first deposit lands. Withdraw only moves the General Balance, so with none
  // it is disabled rather than opening a form with nothing to send.
  const accountSummary = (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <AccountTotals
        generalUsd={balanceUnread ? null : totals.generalUsd}
        portfoliosUsd={totals.portfoliosUsd}
        portfolioCount={portfolios.length}
        totalUsd={totals.totalUsd}
        showInTransitNote={showInTransitNote}
        showSignedOutNote={signedOut}
        totalSpreadUsd={totalSpreadUsd}
        t={t}
      />
      {/* shrink-0: next to the totals column the buttons lost the width race and broke
          "Add tokens" onto two lines. */}
      <div className="flex shrink-0 gap-3">
        {/* D-406: with a draft card on screen its button is the one primary (D-353's rule),
            so the summary's deposit steps down to outlined, like Withdraw beside it. Signed
            out, connecting takes its place, outlined: the empty state's "Build" leads. */}
        {signedOut ? (
          <button
            type="button"
            onClick={onConnect}
            className="flex items-center gap-2 rounded-xl border border-slate-600 px-5 py-2.5 text-sm font-medium text-slate-100 transition hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
          >
            <Wallet size={16} aria-hidden="true" />
            {t.walletConnect}
          </button>
        ) : (
          <button
            type="button"
            onClick={onAddFunds}
            className={`flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 ${
              hasDraftCard
                ? "border border-slate-600 text-slate-100 hover:bg-slate-800"
                : "bg-cyan-500 text-slate-950 hover:bg-cyan-400"
            }`}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5"/><path d="m5 12 7 7 7-7"/><path d="M5 21h14"/></svg>
            {t.myAccountAddFunds}
          </button>
        )}
        <button
          type="button"
          onClick={onWithdraw}
          disabled={signedOut || !hasGeneralBalance}
          title={signedOut ? t.myAccountWithdrawSignedOutHint : undefined}
          className="flex items-center gap-2 rounded-xl border border-slate-600 px-5 py-2.5 text-sm font-medium text-slate-100 transition hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 5v14"/><path d="m19 12-7-7-7 7"/><path d="M5 3h14"/></svg>
          {t.myAccountWithdraw}
        </button>
      </div>
    </div>
  );

  // The draft card takes the invitation's place: with a draft saved, every way into creation
  // resumes it (one per account), so "Create your first portfolio" would only compete with it.
  // D-412: read from the balance only. A credited deposit in the history stays there after a
  // full withdrawal, and the banner then said "your funds have arrived" over an empty balance.
  const showCreatePortfolioCta = !!onCreatePortfolio && !hasDraftCard && displayBalance.size > 0;
  // `onCreatePortfolio` only arrives while the account has no portfolio yet (the shell's
  // no-portfolios branch), which is exactly when the four steps orient a new user.
  const onboardingStep = !onCreatePortfolio ? null : showCreatePortfolioCta ? 2 : 1;
  // D-307: with an Allocate still unconfirmed, "Your funds are ready…" reads as "the first one
  // failed". Only the banner hides; the onboarding step above keeps following the balance.
  const showCreatePortfolioBanner = showCreatePortfolioCta && (pendingAllocates?.length ?? 0) === 0;

  if (!hasGeneralBalance) {
    return (
      // Same column width as the funded branch below. Without the cap this branch inherits
      // the `max-w-7xl` <main>, so an account whose balance is empty — the state right after
      // a full withdrawal — renders the activity feed at ~1230px: content pinned left, status
      // badge pinned right, a dead gap between them.
      <div className="mx-auto flex w-full max-w-xl flex-col gap-8">
        {/* First in both branches: an Allocate of the whole balance lands here (D-293).
            A-4: notices sit closer to each other than sections do; `empty:hidden` so a
            group with nothing to show adds no gap. */}
        <div className="flex flex-col gap-4 empty:hidden">
          <PendingAllocatesBanner signerId={intentsAccountId} />
          <ScheduledReturnsNotice accountId={intentsAccountId} />
          {draftCard}
        </div>
        {/* D-299 / D2: an empty General Balance is not an empty account when portfolios
            hold funds — the totals still lead, the invitation to add tokens follows. Since
            021 R3 they lead a new account too, at $0. */}
        {accountSummary}
        {/* A new account's empty state is the draft card's to replace: both invite the same
            deposit, and the card says what it is for. Next to portfolios the empty state
            stays — a deposit can also go to the ones there are. */}
        {balanceUnread ? (
          <BalanceUnreadNotice read={balanceUnread} t={t} />
        ) : !(hasDraftCard && portfolios.length === 0) && (
          <IntentsAccountEmptyState
            signedOut={signedOut}
            onAddFunds={onAddFunds}
            onConnect={onConnect}
            onBuildFirst={onboardingStep === 1 ? onCreatePortfolio : undefined}
            hasPortfolios={portfolios.length > 0}
            secondary={hasDraftCard}
          />
        )}
        {showCreatePortfolioBanner && (
          <CreatePortfolioBanner onCreatePortfolio={onCreatePortfolio!} t={t} />
        )}
        {onboardingStep === 2 && <OnboardingSteps current={2} onBuild={onCreatePortfolio} onDeposit={onAddFunds} />}
        {activityFeed}
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-8">
      <div className="flex flex-col gap-4 empty:hidden">
        <PendingAllocatesBanner signerId={intentsAccountId} />
        <ScheduledReturnsNotice accountId={intentsAccountId} />
        {draftCard}
        {showCreatePortfolioBanner && (
          <CreatePortfolioBanner onCreatePortfolio={onCreatePortfolio!} t={t} />
        )}
        {onboardingStep === 2 && <OnboardingSteps current={2} onBuild={onCreatePortfolio} onDeposit={onAddFunds} />}
        {(pricesUnavailable || (stockPricesUnavailable && holdsStock)) && <PricesUnavailableNotice t={t} />}
      </div>

      {/* D-439 (c): under the onboarding, a rule marks where "your account" starts — without
          it the steps, the totals and the balance ran together for a new user. */}
      {onboardingStep === 2 ? (
        <div className="border-t border-slate-800 pt-8">{accountSummary}</div>
      ) : (
        accountSummary
      )}

      <BalanceSection
        headingId="general-balance-heading"
        label={t.myAccountGeneralBalance}
        hint={t.myAccountGeneralBalanceHint}
        rows={curatedRows}
        otherRows={otherRows}
        otherLabel={t.myAccountOtherBalances}
        onSell={onSellStock}
        sellLabel={t.stockSellAction}
      />

      {activityFeed}
    </div>
  );
}
