"use client";

import { useEffect, useRef } from "react";
import { Check, Loader2 } from "lucide-react";
import { formatCountdown } from "@/features/vault/hooks/use-maturity-countdown";
import { useRelayPaused } from "@/features/vault/hooks/use-relay-paused";
import { RelayPausedNotice } from "@/features/vault/components/relay-paused-notice";
import { useVaultPrecheck } from "@/features/vault/hooks/use-vault-precheck";
import { VaultPrecheckNotice } from "@/features/vault/components/vault-precheck-notice";
import { useTradeInFlight } from "@/features/vault/hooks/use-trade-in-flight";
import { TradeInFlightNotice } from "@/features/vault/components/trade-in-flight-notice";
import type { MaturityStatus } from "@/features/vault/lib/position-maturity";
import type { RealUnallocateStage } from "@/features/vault/lib/run-real-unallocate";
import { inFlightButtonLabel } from "@/features/vault/lib/in-flight-button-label";
import { APP_MAX_TOKENS_PER_PORTFOLIO, appPortfolioCap } from "@/features/vault/lib/change-set-preflight";
import { Modal } from "./portfolio-primitives";
import { colorForSymbol, formatCrypto } from "../lib/format";
import type { translations } from "../lib/translations";
import type { ChangeSummary } from "../lib/changeset";
import type { SignError, VaultNotice } from "../hooks/use-portfolio-targets";

type T = (typeof translations)["en"];

// A commit the vault reverted with a code the user can act on (017-9b, D-302 f).
function refusalHeadline(refusal: NonNullable<SignError["refusal"]>, t: T): string {
  switch (refusal) {
    case "portfolio-not-empty":
      return t.confirmRefusalNotEmpty;
    case "portfolio-not-found":
      return t.confirmRefusalNotFound;
    case "reservoir":
      return t.confirmRefusalReservoir;
    case "paused":
      return t.confirmRefusalPaused;
    case "token-frozen":
      return t.confirmRefusalFrozen;
    case "insufficient-balance":
      return t.confirmRefusalBalance;
  }
}

// Maps a classified sign failure to its headline. The raw wallet text is only worth
// surfacing for an unexpected error — cancel/unavailable already have actionable copy.
function errorHeadline({ kind, refusal }: SignError, t: T): string {
  if (refusal) return refusalHeadline(refusal, t);
  switch (kind) {
    case "cancel":
      return t.confirmErrorCancelled;
    case "unavailable":
      return t.confirmErrorWalletUnavailable;
    case "relay-paused":
      return t.confirmErrorRelayPaused;
    case "relay-busy":
      return t.confirmErrorRelayBusy;
    case "relay-would-fail":
      return t.confirmErrorRelayWouldFail;
    case "relay-check-failed":
      return t.confirmErrorRelayCheckFailed;
    default:
      return t.confirmError;
  }
}

// A pre-flight refusal, in the user's terms. Only the reasons a user can actually cause
// get their own line; the structural ones (caps, duplicates, a token the chain does not
// have) mean the draft disagrees with the chain, which no wording makes actionable.
export function changeSetNoticeCopy(reason: string, t: T): string {
  switch (reason) {
    case "targets-not-100":
      return t.realChangeSetTargetsNot100;
    case "tolerance-out-of-band":
      return t.realChangeSetTolerance;
    case "too-many-tokens":
      return t.realChangeSetTooManyTokens;
    case "app-too-many-tokens":
      return t.appTooManyTokens.replace("{max}", String(APP_MAX_TOKENS_PER_PORTFOLIO));
    case "too-many-portfolios":
      return t.realChangeSetTooManyPortfolios.replace("{max}", String(appPortfolioCap()));
    case "allocation-in-draft":
      return t.realChangeSetAllocationInDraft;
    case "storage-exceeds-amount":
      return t.realChangeSetStorageExceeds;
    case "storage-mismatch":
      return t.realChangeSetStorageMismatch;
    default:
      return t.realChangeSetInvalid;
  }
}

/**
 * Both kinds of commit ride the same `commit_portfolio_changes` and therefore the same
 * stage machine — but only one of them moves money. `movesFunds` splits the two stages
 * whose copy asserts something about funds; the rest describe the transaction itself and
 * read correctly either way.
 *
 * Without this, editing a composition announced "Your funds are back in your balance" over
 * a commit where nothing moved (reported from a mainnet session, 008.plan Phase 2).
 * Composition-only cannot reach `deferred`: maturity gates withdrawal legs, and there are
 * none — but it is mapped anyway rather than left to diverge silently.
 */
function stageCopy(stage: RealUnallocateStage, t: T, movesFunds: boolean): string {
  switch (stage) {
    case "preparing":
      return t.realUnallocatePreparing;
    case "signing":
      return t.realUnallocateSigning;
    case "submitting":
      return t.realUnallocateSubmitting;
    case "awaiting-settlement":
      return movesFunds ? t.realUnallocateAwaiting : t.realCommitAwaiting;
    case "settled":
      return movesFunds ? t.realUnallocateSettled : t.realCommitSettled;
    case "deferred":
      // Surfaced by the notice below (with the exact countdown), not by the spinner.
      return movesFunds ? t.realUnallocateAwaiting : t.realCommitAwaiting;
    case "pending-unconfirmed":
      return movesFunds ? t.realUnallocatePending : t.realCommitPending;
  }
}

// Targets are usually whole numbers but redistribution can yield decimals — show at
// most one decimal and trim a trailing ".0" so the preview stays clean.
function fmtPct(v: number): string {
  return Number.isInteger(v) ? `${v}` : v.toFixed(1);
}

function SymbolChip({ symbol }: { symbol: string }) {
  return (
    <span
      className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
      style={{ backgroundColor: colorForSymbol(symbol).hex }}
      aria-hidden="true"
    />
  );
}

const ignoreClose = () => {};

/**
 * Preview of a changeset before it is signed. Composition sections follow D-093 order
 * (removals → additions → targetChanges), then the balance moves (allocations →
 * unallocations, added in 5.3.2). Cancelling (button or Escape) keeps the draft and
 * returns to edit mode (D-094) — only Confirm signs + commits.
 */
export function ConfirmChangesModal({
  summary,
  portfolioName,
  t,
  isSigning,
  error,
  vaultNotice,
  isLiveRoute = false,
  sendsThroughRelay = false,
  maturity,
  realStage,
  portfolioId = null,
  onTradeSettled,
  onCancel,
  onConfirm,
}: {
  summary: ChangeSummary;
  portfolioName: string;
  t: T;
  isSigning: boolean;
  error: SignError | null;
  /** Live-vault outcome that is not a failure (007.plan Phase 2). */
  vaultNotice?: VaultNotice | null;
  /** True when confirming would move real funds instead of mock ones. */
  isLiveRoute?: boolean;
  /** This login's live commits are sent by the relayer: ask whether it is paused on open (017-2). */
  sendsThroughRelay?: boolean;
  maturity?: MaturityStatus;
  realStage?: RealUnallocateStage | null;
  /** The on-chain id of the portfolio this commit goes to: asked whether a trade is settling in it (D-471). */
  portfolioId?: string | null;
  /** A trade wait just ended: re-read the portfolio, whose balances that trade changed. */
  onTradeSettled?: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // The withdrawal window has not opened yet. A courtesy gate: submitting early is safe
  // (the chain defers), it just costs gas and moves nothing.
  const gated = isLiveRoute && !!maturity && !maturity.matured;
  // Asked on open, never in the click (017-2): a paused relay gets no signature request.
  const relayPaused = useRelayPaused(isLiveRoute && sendsThroughRelay);
  const movesFunds = summary.unallocations.length > 0;
  // The vault would refuse this commit (017-9b, D-302 a): asked on open, like the relay pause.
  const vaultBlock = useVaultPrecheck(
    isLiveRoute ? { kind: "commit", legTokenIds: summary.unallocations.map((u) => u.tokenId) } : null
  );
  // It may have landed: only "Close" remains (see VaultNotice).
  const unconfirmed = vaultNotice?.kind === "unconfirmed" || vaultNotice?.kind === "transfer-failed";
  // D-471: a trade settling in this portfolio holds Confirm until it is booked. Asked while
  // the modal is open, never in the click, and not while signing: once the click went through,
  // nothing may wait between the signature and the send (solver 945 §7).
  const tradeWaitSecs = useTradeInFlight(
    isLiveRoute && !isSigning && !unconfirmed ? portfolioId : null,
    onTradeSettled
  );
  // A vault refusal blocks the retry too (017-9b): the same signature would meet the same
  // answer. Closing and reopening re-reads the vault (the pre-check runs on open).
  const paused = relayPaused || error?.kind === "relay-paused" || !!vaultBlock || !!error?.refusal;
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // D-309: the attempt disabled the button that had the focus, which drops it on `<body>`. Once
  // it answers, the focus goes to the retry, or to the way out when there is none to press.
  useEffect(() => {
    if (isSigning || (!error && !vaultNotice)) return;
    const retry = confirmRef.current;
    (retry && !retry.disabled ? retry : cancelRef.current)?.focus();
  }, [isSigning, error, vaultNotice]);

  return (
    // D-325: not closable while signing. Closed mid-flight, the outcome would never be shown, and
    // reopening would offer a second signature over funds already in transit.
    <Modal titleId="confirm-changes-title" onClose={isSigning ? ignoreClose : onCancel} maxWidth="max-w-lg">
      <h2 id="confirm-changes-title" className="text-lg font-semibold text-slate-100">
        {t.confirmTitle}
      </h2>
      <p className="mt-0.5 text-xs text-slate-400">{portfolioName}</p>
      {/* D-373: paused, there is no signature to promise. */}
      <p className="mt-2 text-sm text-slate-400">{paused ? t.confirmIntroPaused : t.confirmIntro}</p>

      <div className="mt-4 space-y-4">
        {summary.removals.length > 0 ? (
          <section aria-labelledby="confirm-remove-heading">
            <h3 id="confirm-remove-heading" className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-rose-300">
              {t.confirmRemoveHeading}
            </h3>
            <ul className="divide-y divide-slate-800 rounded-2xl border border-rose-400/20 bg-rose-400/5">
              {summary.removals.map((r) => (
                <li key={r.tokenId} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <span className="flex items-center gap-2 text-sm font-medium text-slate-100">
                    <SymbolChip symbol={r.symbol} />
                    {r.symbol}
                  </span>
                  <span className="text-xs text-slate-400 tabular-nums line-through">{fmtPct(r.fromPct)}%</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {summary.additions.length > 0 ? (
          <section aria-labelledby="confirm-add-heading">
            <h3 id="confirm-add-heading" className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-300">
              {t.confirmAddHeading}
            </h3>
            <ul className="divide-y divide-slate-800 rounded-2xl border border-emerald-400/20 bg-emerald-400/5">
              {summary.additions.map((a) => (
                <li key={a.tokenId} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <span className="flex items-center gap-2 text-sm font-medium text-slate-100">
                    <SymbolChip symbol={a.symbol} />
                    {a.symbol}
                  </span>
                  <span className="text-xs text-slate-300 tabular-nums">
                    {fmtPct(a.toPct)}%
                    {/* D-514: a 0% target is sold whole; its tolerance has no range to show. */}
                    {a.toPct > 0 ? <span className="text-slate-400"> · {t.confirmBand} {fmtPct(a.toBand)}%</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {summary.targetChanges.length > 0 ? (
          <section aria-labelledby="confirm-update-heading">
            <h3 id="confirm-update-heading" className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-accent">
              {t.confirmUpdateHeading}
            </h3>
            <ul className="divide-y divide-slate-800 rounded-2xl border border-slate-800 bg-slate-900">
              {summary.targetChanges.map((c) => (
                <li key={c.tokenId} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <span className="flex items-center gap-2 text-sm font-medium text-slate-100">
                    <SymbolChip symbol={c.symbol} />
                    {c.symbol}
                  </span>
                  <span className="text-right text-xs text-slate-300 tabular-nums">
                    <span className="text-slate-400">{fmtPct(c.fromPct)}%</span>
                    {" → "}
                    <span className="font-semibold text-slate-100">{fmtPct(c.toPct)}%</span>
                    {c.toPct === 0 ? null : c.fromBand !== c.toBand ? (
                      <span className="text-slate-400">
                        {" · "}
                        {t.confirmBand} {fmtPct(c.fromBand)}% → {fmtPct(c.toBand)}%
                      </span>
                    ) : (
                      <span className="text-slate-400">
                        {" · "}
                        {t.confirmBand} {fmtPct(c.toBand)}%
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {summary.allocations.length > 0 ? (
          <section aria-labelledby="confirm-allocate-heading">
            <h3 id="confirm-allocate-heading" className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-300">
              {t.confirmAllocateHeading}
            </h3>
            <ul className="divide-y divide-slate-800 rounded-2xl border border-emerald-400/20 bg-emerald-400/5">
              {summary.allocations.map((a) => (
                <li key={a.tokenId} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <span className="flex items-center gap-2 text-sm font-medium text-slate-100">
                    <SymbolChip symbol={a.symbol} />
                    {a.symbol}
                  </span>
                  <span className="text-xs text-emerald-200 tabular-nums">+{formatCrypto(a.qty)}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {summary.unallocations.length > 0 ? (
          <section aria-labelledby="confirm-unallocate-heading">
            <h3 id="confirm-unallocate-heading" className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-amber-300">
              {t.confirmUnallocateHeading}
            </h3>
            <ul className="divide-y divide-slate-800 rounded-2xl border border-amber-400/20 bg-amber-400/5">
              {summary.unallocations.map((u) => (
                <li key={u.tokenId} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <span className="flex items-center gap-2 text-sm font-medium text-slate-100">
                    <SymbolChip symbol={u.symbol} />
                    {u.symbol}
                  </span>
                  <span className="text-xs text-amber-200 tabular-nums">−{formatCrypto(u.qty)}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      {/* Countdown to the withdrawal window. `aria-live` so a screen reader hears it open
          rather than having to re-inspect a disabled button. */}
      {gated && maturity ? (
        <div
          role="status"
          aria-live="polite"
          className="mt-4 rounded-xl border border-amber-400/30 bg-amber-400/5 px-3 py-2"
        >
          <p className="text-[12px] font-medium leading-tight text-amber-200 tabular-nums">
            {t.maturityGate.replace("{time}", formatCountdown(maturity.remainingSecs))}
          </p>
          <p className="mt-0.5 text-[11px] leading-snug text-amber-200/70">{t.maturityGateHint}</p>
        </div>
      ) : null}

      {/* Live-vault progress. Fixed min-height so naming each leg does not shift the
          buttons below as the copy changes length. */}
      {realStage ? (
        <p
          role="status"
          aria-live="polite"
          className="mt-4 flex min-h-[2.5rem] items-center gap-2 rounded-xl border border-accent/30 bg-accent/5 px-3 py-2 text-[12px] leading-tight text-accent"
        >
          {/* D-314: the outcome is not "still working" — no spinner on it. */}
          {realStage === "settled" ? (
            <Check aria-hidden className="h-3.5 w-3.5 shrink-0 text-emerald-300" />
          ) : (
            <Loader2 aria-hidden className="h-3.5 w-3.5 shrink-0 animate-spin" />
          )}
          {stageCopy(realStage, t, movesFunds)}
        </p>
      ) : null}

      {/* Not an error: the chain deliberately did nothing, the pre-flight refused, or the
          commit was sent and not yet seen applied. */}
      {vaultNotice ? (
        <div
          role="status"
          className="mt-4 rounded-xl border border-amber-400/40 bg-amber-400/5 px-3 py-2"
        >
          <p className="text-[12px] leading-snug text-amber-200">
            {vaultNotice.kind === "deferred"
              ? t.maturityDeferred.replace(
                  "{time}",
                  formatCountdown(vaultNotice.nextReleaseAt - Math.floor(Date.now() / 1000))
                )
              : vaultNotice.kind === "transfer-failed"
                ? t.realUnallocateTransferFailed
                : vaultNotice.kind === "unconfirmed"
                ? movesFunds
                  ? t.realUnallocatePending
                  : t.realCommitPending
                : changeSetNoticeCopy(vaultNotice.reason, t)}
          </p>
        </div>
      ) : null}

      {relayPaused && !unconfirmed ? (
        <RelayPausedNotice id="confirm-changes-relay-paused" title={t.relayPausedTitle} body={t.relayPausedBody} />
      ) : vaultBlock && !unconfirmed ? (
        <VaultPrecheckNotice id="confirm-changes-relay-paused" block={vaultBlock} t={t} />
      ) : tradeWaitSecs !== null ? (
        <TradeInFlightNotice
          id="confirm-changes-relay-paused"
          title={t.tradeInFlightTitle}
          body={t.tradeInFlightBody}
          seconds={tradeWaitSecs}
        />
      ) : null}

      {error ? (
        <div role="alert" className="mt-4 rounded-xl border border-rose-400/40 bg-rose-400/5 px-3 py-2">
          <p className="text-[12px] leading-tight text-rose-200">{errorHeadline(error, t)}</p>
          {error.kind === "error" && !error.refusal ? (
            <p className="mt-0.5 break-words text-[11px] leading-tight text-rose-300/60">{error.message}</p>
          ) : null}
        </div>
      ) : null}

      <div className="mt-6 flex justify-end gap-3">
        <button
          ref={cancelRef}
          type="button"
          onClick={onCancel}
          disabled={isSigning}
          className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-300 transition hover:border-slate-500 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          {unconfirmed ? t.confirmClose : t.cancel}
        </button>
        {unconfirmed ? null : (
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            // A pause the click ran into (the firewall brake cannot be seen on open) blocks the
            // retry too: each retry would be another signature for the same refusal.
            disabled={isSigning || gated || paused || tradeWaitSecs !== null}
            aria-describedby={
              relayPaused || vaultBlock || tradeWaitSecs !== null ? "confirm-changes-relay-paused" : undefined
            }
            className="rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            {isSigning
              ? inFlightButtonLabel(realStage, t)
              : gated && maturity
                ? formatCountdown(maturity.remainingSecs)
                : error || vaultNotice
                  ? t.confirmRetry
                  : t.confirmSign}
          </button>
        )}
      </div>
    </Modal>
  );
}
