"use client";

// "From your wallet" — the first tab of the deposit step for NEAR-network assets with a NEAR
// login (016 §5.3, block 2a, D-338). Only mounted behind `isWalletDepositRoute`.
//
// The money rules live in `near-wallet-deposit.ts`; this renders them. Three of them shape the
// component itself:
//   - Nothing is read from the network inside the click. The balance is read when the tab opens
//     (`useWalletDepositBalance`), so the click goes straight to the wallet — and no deposit is
//     offered while that balance is being re-read, because until it answers it may be stale.
//   - Where a deposit stands lives in a store keyed by (account, token), not in this component
//     (`use-wallet-deposit-phase.ts`): leaving the tab or closing the modal must not turn a
//     deposit whose wallet popup is still open into a fresh form.
//   - An outcome that proves nothing moved (declined, another account, a failure) keeps the form,
//     because trying again is safe. `unconfirmed` does NOT: the deposit may have landed, so a new
//     one takes an explicit "I checked my general balance".

import { useState, type ReactNode } from "react";
import { CircleCheck, Info, Loader2, TriangleAlert } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useTokenPrices } from "@/features/market/hooks/use-token-prices";
import { getTokenById } from "@/features/market/lib/token-registry";
import { ChainIcon, hasChainIcon } from "@/features/market/lib/token-icons";
import { formatUsd } from "@/features/portfolio-editor/lib/format";
import { sanitizeDecimalInput } from "@/features/portfolio-editor/lib/decimal-input";
import type { SendTransactionAs } from "@/features/vault/context/real-allocate-context";
import {
  POST_DEPOSIT_REFRESH_MS,
  refreshBalancesAfterWalletDeposit,
  useWalletDepositBalance,
} from "../hooks/use-wallet-deposit-balance";
import {
  getWalletDepositPhase,
  getWalletDepositVerdictAt,
  recordWalletDepositVerdict,
  setWalletDepositPhase,
  useWalletDepositPhase,
  useWalletDepositVerdictAt,
  walletDepositPhaseKey,
  type WalletDepositPhase,
} from "../hooks/use-wallet-deposit-phase";
import {
  FT_GAS_RESERVE_YOCTO,
  NEAR_GAS_RESERVE_YOCTO,
  formatBaseUnits,
  hasGasForDeposit,
  parseAmountToBaseUnits,
  readWalletDepositBalance,
  runWalletDeposit,
  walletDepositCredit,
  walletDepositTarget,
  type WalletDepositCredit,
  type WalletDepositResult,
} from "../lib/near-wallet-deposit";
import type { bridgeTranslations } from "../lib/translations";

type T = (typeof bridgeTranslations)["en"];

/** Results after which sending again is safe: each one proves nothing moved. */
const RETRYABLE: ReadonlySet<WalletDepositResult["kind"]> = new Set(["declined", "other-account", "failed"]);

/** The only network this tab deposits from (it is mounted for NEAR-network assets only). */
const NEAR_CHAIN_ID = "near:mainnet";

/** Fraction digits shown for an amount. Display only — "Max" signs the exact figure. */
const DISPLAY_DECIMALS = 6;

/** The last deposit started, page-wide: each click takes the next one as its `runId` (D-376). */
let lastRunId = 0;

/**
 * Cuts decimal text to `max` fraction digits. Truncates, never rounds: an amount is never shown
 * above itself. `markCut` appends "…" when digits were dropped — for the button, which names what
 * gets signed and must not read as a round number it is not.
 */
export function shortDecimalText(text: string, max: number, markCut = false): string {
  const [whole, frac = ""] = text.split(".");
  const significant = frac.replace(/0+$/, "");
  const cut = significant.slice(0, max).replace(/0+$/, "");
  const shown = cut ? `${whole}.${cut}` : whole;
  return markCut && significant.length > max ? `${shown}…` : shown;
}

export function WalletDepositPanel({
  tokenId,
  accountId,
  send,
  t,
  onCredited,
  onUseAddress,
  onAgain,
  onContinue,
  onDone,
}: {
  tokenId: string;
  /** The login's NEAR account: who signs, and whose General Balance is credited. */
  accountId: string;
  send: SendTransactionAs;
  t: T;
  onCredited: (credit: WalletDepositCredit) => void;
  /** Switches to the QR tab. */
  onUseAddress: () => void;
  /** After a finished deposit: start another one, from the asset step. */
  onAgain: () => void;
  /**
   * B1 (016 block 2.4): the deposit was for the account's New Portfolio Draft. After a verdict
   * that credited it (`credited` / `partial`), "Confirm my portfolio" leads, handed the credit.
   */
  onContinue?: (credit: WalletDepositCredit) => void;
  /**
   * 027 A-6: closes the modal after a finished deposit. Leads when "Add funds and confirm" does
   * not, so there are never three buttons: with the draft's, the × is the way out.
   */
  onDone: () => void;
}) {
  const target = walletDepositTarget(tokenId);
  const token = getTokenById(tokenId);
  const symbol = token?.assetName ?? token?.symbol ?? tokenId;
  const queryClient = useQueryClient();
  const balanceQuery = useWalletDepositBalance({ accountId, tokenId, enabled: target !== null });
  const phaseKey = walletDepositPhaseKey(accountId, tokenId);
  const phase = useWalletDepositPhase(phaseKey);
  const verdictAt = useWalletDepositVerdictAt(accountId);
  const [text, setText] = useState("");
  // D-417: what "Max" chose, in base units. The field shows it cut to DISPLAY_DECIMALS (24 raw
  // decimals overflowed it); the signature takes this, every unit. Typing drops it.
  const [maxAmount, setMaxAmount] = useState<bigint | null>(null);
  const { prices } = useTokenPrices();

  if (!target) return null;
  const decimals = target.decimals;
  const balance = balanceQuery.data;
  const amount = maxAmount ?? parseAmountToBaseUnits(text, decimals);
  // Live quote only: the registry fallback can be several times off (s186), and this names money.
  const usdPrice = prices[tokenId]?.usdPrice ?? 0;
  const busy = phase.kind === "waiting" || phase.kind === "confirming";
  const settled = phase.kind === "done" && !RETRYABLE.has(phase.result.kind);
  // A refetch in progress means the figure on screen may predate the last deposit: no Max and no
  // deposit until the chain answers.
  const refreshing = balanceQuery.isFetching;
  // D-377: after a verdict that may have moved funds, a balance read before the last scheduled
  // re-read may predate it — and the next deposit's cancel would read that effect as its own.
  // Opens on its own when that re-read answers (a query update re-renders); if it fails, the
  // panel shows the read error instead of the form, and Retry's answer opens it.
  const settling =
    verdictAt !== undefined && balanceQuery.dataUpdatedAt < verdictAt + Math.max(...POST_DEPOSIT_REFRESH_MS);
  const tooMuch = amount !== null && balance !== undefined && amount > balance.available;
  // D-349: a token deposit pays its gas in NEAR. Without it the network refuses the transaction,
  // so no button is offered for one.
  const noGas = balance !== undefined && !hasGasForDeposit(balance);
  const canDeposit =
    balance !== undefined && amount !== null && !tooMuch && !noGas && !busy && !settled && !refreshing && !settling;

  function handleResult(result: WalletDepositResult, runId: number) {
    // State first, then the credit: a credit that throws must not leave the panel spinning.
    // D-376: only while no newer deposit owns the phase. A stale verdict still counts below — it
    // is real money that moved, so it is recorded, re-read and credited; it is just not shown.
    const current = getWalletDepositPhase(phaseKey);
    if (current.kind === "form" || current.runId === runId) {
      setWalletDepositPhase(phaseKey, { kind: "done", result, runId });
    }
    if (result.kind === "credited" || result.kind === "partial" || result.kind === "unconfirmed") {
      recordWalletDepositVerdict(accountId, Date.now());
    }
    // Every verdict, `declined` included: it is read off the chain now (D-348), and a General
    // Balance cached from before the click must not contradict it.
    refreshBalancesAfterWalletDeposit(queryClient);
    // At most once per deposit: `unconfirmed` never credits, and the late verdict is the only
    // other call a deposit can make.
    const credit = walletDepositCredit(result, tokenId);
    if (!credit) return;
    try {
      onCredited(credit);
    } catch (e) {
      console.error("[wallet-deposit] crediting the deposit failed", e);
    }
  }

  function handleDeposit() {
    // The store, read synchronously, is the in-flight guard: it holds across a second click in
    // the same frame and across a remounted panel. 🔴 No `await` before `runWalletDeposit`: it
    // asks the wallet synchronously, inside the click.
    const current = getWalletDepositPhase(phaseKey).kind;
    if (current === "waiting" || current === "confirming") return;
    if (!canDeposit || !balance || amount === null || !target) return;
    const runId = ++lastRunId;
    setWalletDepositPhase(phaseKey, { kind: "waiting", runId });
    // D-377: a `credited` with no hash is read off the balances (`recheckDeclinedDeposit`). If
    // another deposit's verdict landed meanwhile, the movement may be that one's: say unconfirmed.
    const verdictAtClick = getWalletDepositVerdictAt(accountId);
    const settle = (result: WalletDepositResult) =>
      handleResult(
        result.kind === "credited" && result.txHash === null && getWalletDepositVerdictAt(accountId) !== verdictAtClick
          ? { kind: "unconfirmed", message: "Another deposit settled during this one (D-377)" }
          : result,
        runId,
      );
    void runWalletDeposit({
      target,
      balance,
      amount,
      loginAccountId: accountId,
      send,
      // After a cancel, the chain decides whether it went (D-348): the same read the tab made.
      readBalance: () => readWalletDepositBalance(target, accountId),
      onWalletAnswered: () => {
        const now = getWalletDepositPhase(phaseKey);
        if (now.kind === "waiting" && now.runId === runId) {
          setWalletDepositPhase(phaseKey, { kind: "confirming", runId });
        }
      },
      // Not `settle`: a late `credited` from the balances (D-378 / D-381) is guarded by
      // `isCurrent` instead, and this deposit's own `unconfirmed` already moved `verdictAt`.
      onLateResult: (result) => handleResult(result, runId),
      // A newer deposit, of any token, ends this one's background watch: its movement is its own.
      isCurrent: () => lastRunId === runId,
    }).then(settle);
  }

  function handleAgain() {
    setText("");
    setMaxAmount(null);
    setWalletDepositPhase(phaseKey, { kind: "form" });
    onAgain();
  }

  // Moving on from a verdict that was already shown: the next visit to this token starts clean,
  // exactly as after "Make another deposit".
  function handleContinue(credit: WalletDepositCredit) {
    setText("");
    setMaxAmount(null);
    setWalletDepositPhase(phaseKey, { kind: "form" });
    onContinue?.(credit);
  }

  function handleUseAddress() {
    onUseAddress();
    // The button that had focus leaves with this panel; hand focus to the tab it opened.
    requestAnimationFrame(() => document.getElementById("deposit-tab-address")?.focus());
  }

  // D-446: where the funds leave from, as a row of its own — network icon, then the account in
  // the accent color — instead of a dim line of text. Truncated (an implicit account is 64 hex
  // characters); the full id stays in the title.
  const header = (
    <div className="flex items-center gap-3 rounded-xl bg-slate-800 px-3 py-2.5">
      {hasChainIcon(NEAR_CHAIN_ID) && <ChainIcon chainId={NEAR_CHAIN_ID} size={24} />}
      <div className="min-w-0">
        <p className="text-xs text-slate-400">{t.walletDepositFrom}</p>
        <p className="truncate text-sm font-medium text-accent" title={accountId}>
          {accountId}
        </p>
      </div>
    </div>
  );
  const status = statusText(phase, t, { symbol, accountId, decimals });
  // A verdict is a callout, not a line of body text (operator s181: "Nothing moved" read as easy
  // to miss). Progress stays a plain line with its spinner. The live region is the same element
  // either way, so the announcement does not depend on the styling.
  const tone = statusTone(phase);
  const StatusIcon = tone === "success" ? CircleCheck : tone === "attention" ? TriangleAlert : null;
  const statusLine = (
    <p role="status" aria-live="polite" className={status ? STATUS_CLASS[tone] : "sr-only"}>
      {busy && <Loader2 size={14} className="mr-1.5 inline animate-spin align-[-2px]" aria-hidden="true" />}
      {StatusIcon && <StatusIcon size={16} className="mt-0.5 shrink-0" aria-hidden="true" />}
      {status && <span>{status}</span>}
    </p>
  );

  // A deposit in flight or finished is shown as such whatever the balance read is doing: a
  // failed re-read must never replace "check your general balance" with a way to deposit again.
  if (busy || settled) {
    const result = phase.kind === "done" ? phase.result : null;
    // Only a verdict that credited the login earns one; `unconfirmed` never does.
    const credit = result && onContinue ? walletDepositCredit(result, tokenId) : null;
    return (
      <div className="flex flex-col gap-4 px-5 py-6">
        {header}
        {statusLine}
        {credit && (
          <button
            type="button"
            onClick={() => handleContinue(credit)}
            className="rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-accent-ink transition hover:bg-accent/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            {t.walletDepositConfirmDraft}
          </button>
        )}
        {result && !credit && (
          <button
            type="button"
            onClick={onDone}
            className="rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-accent-ink transition hover:bg-accent/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            {t.receiveDone}
          </button>
        )}
        {result && (
          <SecondaryButton onClick={handleAgain}>
            {result.kind === "unconfirmed" ? t.walletDepositUnconfirmedAck : t.walletDepositAgain}
          </SecondaryButton>
        )}
      </div>
    );
  }

  if (balanceQuery.isPending) {
    return (
      <div className="flex flex-col gap-4 px-5 py-6">
        {header}
        <p role="status" className="flex items-center gap-2 text-sm text-slate-400">
          <Loader2 size={16} className="animate-spin" aria-hidden="true" />
          {t.walletDepositReading}
        </p>
      </div>
    );
  }

  // Fail closed: no balance means no amount field and no button — never a zero, never a "Max".
  if (balanceQuery.isError || !balance) {
    return (
      <div className="flex flex-col gap-4 px-5 py-6">
        {header}
        {statusLine}
        <p role="alert" className="text-sm text-slate-300">{t.walletDepositReadError}</p>
        <div className="flex flex-wrap gap-2">
          <SecondaryButton onClick={() => void balanceQuery.refetch()}>{t.retry}</SecondaryButton>
          <UseAddressButton t={t} onClick={handleUseAddress} />
        </div>
      </div>
    );
  }

  const availableText = shortDecimalText(formatBaseUnits(balance.available, decimals), DISPLAY_DECIMALS);
  const reserveText = formatBaseUnits(NEAR_GAS_RESERVE_YOCTO, 24);

  if (balance.available === BigInt(0)) {
    return (
      <div className="flex flex-col gap-4 px-5 py-6">
        {header}
        {statusLine}
        <p className="text-sm text-slate-300">
          {target.kind === "native"
            ? t.walletDepositEmptyNative.replace("{reserve}", reserveText)
            : t.walletDepositEmpty.replace("{symbol}", symbol)}
        </p>
        <UseAddressButton t={t} onClick={handleUseAddress} primary />
      </div>
    );
  }

  if (noGas) {
    return (
      <div className="flex flex-col gap-4 px-5 py-6">
        {header}
        {statusLine}
        <p className="break-words text-sm text-slate-300">
          {t.walletDepositNoGas
            .replace("{symbol}", symbol)
            .replace("{reserve}", formatBaseUnits(FT_GAS_RESERVE_YOCTO, 24))
            .replace("{account}", accountId)}
        </p>
        <UseAddressButton t={t} onClick={handleUseAddress} primary />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 px-5 py-6">
      {header}

      <div className="flex flex-col gap-1.5">
        <label htmlFor="wallet-deposit-amount" className="text-xs font-medium text-slate-400">
          {t.walletDepositAmountLabel}
        </label>
        <div className="flex gap-2">
          <input
            id="wallet-deposit-amount"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={text}
            onChange={(e) => {
              setMaxAmount(null);
              setText(sanitizeDecimalInput(e.target.value));
            }}
            placeholder="0.00"
            aria-invalid={tooMuch || undefined}
            aria-describedby={tooMuch ? "wallet-deposit-too-much" : undefined}
            className="min-w-0 flex-1 rounded-xl bg-slate-800 px-3 py-2.5 text-sm tabular-nums text-slate-100 placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-accent/60"
          />
          <button
            type="button"
            disabled={refreshing || settling}
            // Exact: every base unit of the balance (24 decimals for NEAR) is what gets signed,
            // so Max can never ask for more than the wallet can send. Only the shown text is cut.
            onClick={() => {
              setMaxAmount(balance.available);
              setText(shortDecimalText(formatBaseUnits(balance.available, decimals), DISPLAY_DECIMALS));
            }}
            className="shrink-0 rounded-xl bg-slate-800 px-3 py-2.5 text-xs font-semibold text-accent transition hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-60"
          >
            {t.walletDepositMax}
          </button>
        </div>
        {amount !== null && usdPrice > 0 && (
          <p className="text-xs tabular-nums text-slate-300">
            ≈ {formatUsd(Number(formatBaseUnits(amount, decimals)) * usdPrice)}
          </p>
        )}
        {/* Under the field, not beside its label: at 390 px the two share a row only by wrapping. */}
        <p className="text-xs tabular-nums text-slate-400">
          {t.walletDepositAvailable.replace("{amount}", availableText).replace("{symbol}", symbol)}
        </p>
        {tooMuch && (
          <p id="wallet-deposit-too-much" role="alert" className="text-xs text-red-400">
            {t.walletDepositTooMuch}
          </p>
        )}
        {target.kind === "native" && (
          <p className="mt-1 flex gap-1.5 text-xs text-slate-400">
            <Info size={14} className="mt-px shrink-0 text-slate-500" aria-hidden="true" />
            {t.walletDepositReserveNote.replace("{reserve}", reserveText)}
          </p>
        )}
      </div>

      {statusLine}

      <button
        type="button"
        onClick={handleDeposit}
        disabled={!canDeposit}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-accent-ink transition hover:bg-accent/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 active:bg-accent/90 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
      >
        {amount !== null
          ? t.walletDepositButton
              .replace("{amount}", shortDecimalText(formatBaseUnits(amount, decimals), DISPLAY_DECIMALS, true))
              .replace("{symbol}", symbol)
          : t.walletDepositButtonIdle}
      </button>
      {settling && <p className="text-center text-xs text-slate-400">{t.walletDepositUpdatingBalances}</p>}

      {phase.kind === "done" && phase.result.kind === "failed" && phase.result.cause === "requires-full-access" && (
        <UseAddressButton t={t} onClick={handleUseAddress} />
      )}
    </div>
  );
}

export function SecondaryButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg bg-slate-800 px-4 py-2.5 text-sm font-medium text-slate-100 transition hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
    >
      {children}
    </button>
  );
}

export function UseAddressButton({ t, onClick, primary = false }: { t: T; onClick: () => void; primary?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        primary
          ? "rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-accent-ink transition hover:bg-accent/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          : "rounded-lg px-4 py-2 text-sm font-medium text-accent underline decoration-accent/40 underline-offset-4 transition hover:decoration-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
      }
    >
      {t.walletDepositUseAddress}
    </button>
  );
}

function statusText(
  phase: WalletDepositPhase,
  t: T,
  ctx: { symbol: string; accountId: string; decimals: number },
): string {
  const amountOf = (raw: bigint) => shortDecimalText(formatBaseUnits(raw, ctx.decimals), DISPLAY_DECIMALS);
  switch (phase.kind) {
    case "form":
      return "";
    case "waiting":
      return t.walletDepositWaiting;
    case "confirming":
      return t.walletDepositConfirming;
    case "done": {
      const r = phase.result;
      switch (r.kind) {
        case "credited":
          return t.walletDepositCredited.replace("{amount}", amountOf(r.amount)).replace("{symbol}", ctx.symbol);
        case "partial":
          return t.walletDepositPartial.replace("{amount}", amountOf(r.credited)).replace("{symbol}", ctx.symbol);
        case "refunded":
          return t.walletDepositRefunded;
        case "failed":
          switch (r.cause) {
            case "requires-full-access":
              return t.walletDepositFullAccess;
            case "not-enough-balance":
              return t.walletDepositNotEnoughGas;
            case "wallet-not-connected":
              return t.walletDepositNotConnected;
            default:
              return t.walletDepositFailed;
          }
        case "declined":
          return t.walletDepositDeclined;
        case "other-account":
          return t.walletDepositOtherAccount.replace("{account}", ctx.accountId);
        case "wrong-signer":
          return t.walletDepositWrongSigner.replace("{signer}", r.signerId).replace("{account}", ctx.accountId);
        // `runWalletDeposit` never returns `unreadable`; if it ever did, "we could not confirm" is
        // the honest reading of it.
        case "unreadable":
        case "unconfirmed":
          return t.walletDepositUnconfirmed;
      }
    }
  }
}

export type StatusTone = "progress" | "success" | "attention";

export const STATUS_CLASS: Record<StatusTone, string> = {
  progress: "text-sm text-slate-300",
  success: "flex gap-2 rounded-lg border border-emerald-500/40 px-3 py-2.5 text-sm text-emerald-200",
  // The amber of the network warning in the QR tab: the same "read this" in the same modal.
  attention: "flex gap-2 rounded-lg border border-amber-500/40 px-3 py-2.5 text-sm text-amber-200",
};

function statusTone(phase: WalletDepositPhase): StatusTone {
  if (phase.kind !== "done") return "progress";
  const kind = phase.result.kind;
  return kind === "credited" || kind === "partial" ? "success" : "attention";
}
