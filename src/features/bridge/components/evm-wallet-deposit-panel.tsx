"use client";

// D-445 part 2B: "From your wallet" for an EVM login — the first tab of the deposit step for the
// EVM tokens Receive takes (`EVM_WALLET_TOKENS`). Only mounted behind `isEvmWalletDepositRoute`.
//
// The money rules live in `evm-wallet-deposit.ts`; this renders them, the way the NEAR panel does:
//   - Everything the deposit needs is read when the tab opens — the exact balance, the bridge's
//     deposit address, the gas a native "Max" leaves — so the click goes straight to the wallet.
//   - Where a deposit stands lives in the shared phase store, keyed by (wallet, token): leaving the
//     tab or closing the modal does not turn a deposit in flight into a fresh form.
//   - Only a verdict that proves nothing moved keeps the form; `unconfirmed` takes an explicit
//     "I checked my funding account".

import { useState } from "react";
import { CircleCheck, Info, Loader2, TriangleAlert } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import type { Hex } from "viem";
import type { EvmTransactionRequest } from "@/features/login-wallet/types";
import { useTokenPrices } from "@/features/market/hooks/use-token-prices";
import { getTokenById } from "@/features/market/lib/token-registry";
import { ChainIcon, hasChainIcon } from "@/features/market/lib/token-icons";
import { formatUsd } from "@/features/portfolio-editor/lib/format";
import { sanitizeDecimalInput } from "@/features/portfolio-editor/lib/decimal-input";
import {
  refreshBalancesAfterWalletDeposit,
  useEvmDepositAddress,
  useEvmDepositBalance,
  useEvmNativeDepositFee,
} from "../hooks/use-wallet-deposit-balance";
import {
  getWalletDepositPhase,
  setWalletDepositPhase,
  useWalletDepositPhase,
  walletDepositPhaseKey,
  type EvmWalletDepositPhase,
} from "../hooks/use-wallet-deposit-phase";
import { chainRegistry } from "../lib/chain-registry";
import {
  EVM_RETRYABLE,
  buildEvmDepositTransaction,
  evmWalletDepositToken,
  runEvmWalletDeposit,
  spendableForDeposit,
  type EvmDepositResult,
} from "../lib/evm-wallet-deposit";
import { formatBaseUnits, parseAmountToBaseUnits, type WalletDepositCredit } from "../lib/near-wallet-deposit";
import type { bridgeTranslations } from "../lib/translations";
import {
  STATUS_CLASS,
  SecondaryButton,
  UseAddressButton,
  shortDecimalText,
  type StatusTone,
} from "./wallet-deposit-panel";

type T = (typeof bridgeTranslations)["en"];

/** Fraction digits shown for an amount. Display only — "Max" signs the exact figure. */
const DISPLAY_DECIMALS = 6;

/** Ethereum, Arbitrum and Base — the three chains this path serves — all pay their gas in ETH. */
const NATIVE_SYMBOL = "ETH";

/** The last EVM deposit started, page-wide: each click takes the next one as its `runId`. */
let lastRunId = 0;

export function EvmWalletDepositPanel({
  tokenId,
  owner,
  intentsAccountId,
  send,
  minDepositText,
  t,
  onUseAddress,
  onAgain,
  onContinue,
  onDone,
}: {
  tokenId: string;
  /** The connected wallet's address: who sends. The session's own (`isEvmWalletDepositRoute`). */
  owner: string;
  /** Whose funding account the deposit address credits. */
  intentsAccountId: string;
  send: (tx: EvmTransactionRequest) => Promise<Hex>;
  /** The bridge's minimum for this token on this chain, in human units; null when it could not be read. */
  minDepositText: string | null;
  t: T;
  onUseAddress: () => void;
  onAgain: () => void;
  /** After a credited deposit for the New Portfolio Draft: "Assign funds to this portfolio". */
  onContinue?: (credit: WalletDepositCredit) => void;
  onDone: () => void;
}) {
  const token = evmWalletDepositToken(tokenId);
  const registryToken = getTokenById(tokenId);
  const symbol = registryToken?.assetName ?? registryToken?.symbol ?? tokenId;
  const decimals = registryToken?.decimals ?? 18;
  const network = token ? (chainRegistry[token.chainId]?.displayName ?? token.chainId) : "";
  const queryClient = useQueryClient();
  const enabled = token !== null;
  const balanceQuery = useEvmDepositBalance({ token: token ?? FALLBACK_TOKEN, owner, enabled });
  const addressQuery = useEvmDepositAddress({ intentsAccountId, chainId: token?.chainId ?? "", enabled });
  const feeQuery = useEvmNativeDepositFee({
    token: token ?? FALLBACK_TOKEN,
    owner,
    depositAddress: addressQuery.data,
    enabled,
  });
  const phaseKey = walletDepositPhaseKey(owner.toLowerCase(), tokenId);
  const phase = useWalletDepositPhase<EvmWalletDepositPhase>(phaseKey);
  const [text, setText] = useState("");
  // What "Max" chose, in base units; the field shows it cut to DISPLAY_DECIMALS. Typing drops it.
  const [maxAmount, setMaxAmount] = useState<bigint | null>(null);
  const { prices } = useTokenPrices();

  if (!token) return null;
  const isNative = token.erc20 === null;
  const balance = balanceQuery.data;
  const depositAddress = addressQuery.data;
  const nativeFee = isNative ? feeQuery.data?.fee : BigInt(0);
  const amount = maxAmount ?? parseAmountToBaseUnits(text, decimals);
  const minimum = minDepositText !== null ? parseAmountToBaseUnits(minDepositText, decimals) : null;
  const usdPrice = prices[tokenId]?.usdPrice ?? 0;
  const busy = phase.kind === "waiting" || phase.kind === "confirming" || phase.kind === "arriving";
  const settled = phase.kind === "done" && !EVM_RETRYABLE.has(phase.result.kind);
  const refreshing = balanceQuery.isFetching || feeQuery.isFetching;
  const spendable =
    balance !== undefined && nativeFee !== undefined ? spendableForDeposit(token, balance, nativeFee) : undefined;
  const tooMuch = amount !== null && spendable !== undefined && amount > spendable;
  const belowMin = amount !== null && amount > BigInt(0) && minimum !== null && amount < minimum;
  const canDeposit =
    spendable !== undefined &&
    depositAddress !== undefined &&
    minimum !== null &&
    amount !== null &&
    amount > BigInt(0) &&
    !tooMuch &&
    !belowMin &&
    !busy &&
    !settled &&
    !refreshing;

  /** A phase lands only while no newer deposit of this token owns the store. */
  function setIfCurrent(runId: number, next: EvmWalletDepositPhase) {
    const current = getWalletDepositPhase<EvmWalletDepositPhase>(phaseKey);
    if (current.kind === "form" || current.runId === runId) setWalletDepositPhase(phaseKey, next);
  }

  function handleDeposit() {
    // The store, read synchronously, is the in-flight guard across a second click and a remount.
    const current = getWalletDepositPhase<EvmWalletDepositPhase>(phaseKey).kind;
    if (current === "waiting" || current === "confirming" || current === "arriving") return;
    if (!canDeposit || !token || !depositAddress || amount === null) return;
    const tx = buildEvmDepositTransaction({ token, depositAddress, amount, gasLimit: feeQuery.data?.gasLimit });
    const runId = ++lastRunId;
    setWalletDepositPhase<EvmWalletDepositPhase>(phaseKey, { kind: "waiting", runId });
    void runEvmWalletDeposit({
      token,
      tx,
      amount,
      intentsAccountId,
      send,
      onSent: () => setIfCurrent(runId, { kind: "confirming", runId }),
      onConfirmed: () => {
        setIfCurrent(runId, { kind: "arriving", runId });
        // The funds left the wallet: its balances change now, not when the bridge credits.
        refreshBalancesAfterWalletDeposit(queryClient);
      },
    }).then((result) => {
      setIfCurrent(runId, { kind: "done", result, runId });
      refreshBalancesAfterWalletDeposit(queryClient);
    });
  }

  function resetForm() {
    setText("");
    setMaxAmount(null);
    setWalletDepositPhase<EvmWalletDepositPhase>(phaseKey, { kind: "form" });
  }

  function handleUseAddress() {
    onUseAddress();
    requestAnimationFrame(() => document.getElementById("deposit-tab-address")?.focus());
  }

  // Where the funds leave from: the network's icon and name, then the address in the accent color
  // (D-446's row, generalized). Cut in the middle like the step-1 pill; the full one in the title.
  const header = (
    <div className="flex items-center gap-3 rounded-xl bg-slate-800 px-3 py-2.5">
      {hasChainIcon(token.chainId) && <ChainIcon chainId={token.chainId} size={24} />}
      <div className="min-w-0">
        <p className="text-xs text-slate-400">{t.walletDepositFromNetwork.replace("{network}", network)}</p>
        <p className="truncate text-sm font-medium text-accent" title={owner}>
          {`${owner.slice(0, 6)}…${owner.slice(-4)}`}
        </p>
      </div>
    </div>
  );
  const status = statusText(phase, t, { symbol, network, decimals });
  const tone = statusTone(phase);
  const StatusIcon = tone === "success" ? CircleCheck : tone === "attention" ? TriangleAlert : null;
  const statusLine = (
    <p role="status" aria-live="polite" className={status ? STATUS_CLASS[tone] : "sr-only"}>
      {busy && <Loader2 size={14} className="mr-1.5 inline animate-spin align-[-2px]" aria-hidden="true" />}
      {StatusIcon && <StatusIcon size={16} className="mt-0.5 shrink-0" aria-hidden="true" />}
      {status && <span>{status}</span>}
    </p>
  );
  const primaryClass =
    "rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-accent-ink transition hover:bg-accent/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60";

  // A deposit in flight or finished is shown as such whatever the reads are doing.
  if (busy || settled) {
    const result = phase.kind === "done" ? phase.result : null;
    const credit: WalletDepositCredit | null =
      result?.kind === "credited" && onContinue ? { tokenId, amount: result.amount, txHash: result.txHash } : null;
    return (
      <div className="flex flex-col gap-4 px-5 py-6">
        {header}
        {statusLine}
        {credit && (
          <button
            type="button"
            onClick={() => {
              resetForm();
              onContinue?.(credit);
            }}
            className={primaryClass}
          >
            {t.walletDepositConfirmDraft}
          </button>
        )}
        {result && !credit && (
          <button type="button" onClick={onDone} className={primaryClass}>
            {t.receiveDone}
          </button>
        )}
        {result && (
          <SecondaryButton
            onClick={() => {
              resetForm();
              onAgain();
            }}
          >
            {result.kind === "unconfirmed" ? t.walletDepositUnconfirmedAck : t.walletDepositAgain}
          </SecondaryButton>
        )}
      </div>
    );
  }

  const pending = balanceQuery.isPending || addressQuery.isPending || (isNative && feeQuery.isPending);
  const failed = balanceQuery.isError || addressQuery.isError || (isNative && feeQuery.isError);
  if (failed) {
    return (
      <div className="flex flex-col gap-4 px-5 py-6">
        {header}
        {statusLine}
        <p role="alert" className="text-sm text-slate-300">
          {addressQuery.isError ? t.walletDepositAddressError : t.walletDepositReadError}
        </p>
        <div className="flex flex-wrap gap-2">
          <SecondaryButton
            onClick={() => {
              if (balanceQuery.isError) void balanceQuery.refetch();
              if (addressQuery.isError) void addressQuery.refetch();
              if (feeQuery.isError) void feeQuery.refetch();
            }}
          >
            {t.retry}
          </SecondaryButton>
          <UseAddressButton t={t} onClick={handleUseAddress} />
        </div>
      </div>
    );
  }
  if (pending || !balance || spendable === undefined) {
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

  const feeText = shortDecimalText(formatBaseUnits(nativeFee ?? BigInt(0), 18), DISPLAY_DECIMALS);
  // Fail closed: a deposit under the bridge's minimum may never be credited, so without the
  // minimum there is no form — the QR tab shows the same minimum when it has it.
  const blocker =
    minimum === null
      ? t.walletDepositNoMin
      : balance.available === BigInt(0)
        ? t.walletDepositEmpty.replace("{symbol}", symbol)
        : !isNative && balance.native === BigInt(0)
          ? t.walletDepositEvmNoGas
              .replace("{symbol}", symbol)
              .replaceAll("{network}", network)
              .replace("{native}", NATIVE_SYMBOL)
          : isNative && spendable === BigInt(0)
            ? t.walletDepositEvmEmptyNative.replaceAll("{symbol}", symbol).replace("{reserve}", feeText)
            : null;
  if (blocker) {
    return (
      <div className="flex flex-col gap-4 px-5 py-6">
        {header}
        {statusLine}
        <p className="break-words text-sm text-slate-300">{blocker}</p>
        <UseAddressButton t={t} onClick={handleUseAddress} primary />
      </div>
    );
  }

  const spendableText = shortDecimalText(formatBaseUnits(spendable, decimals), DISPLAY_DECIMALS);
  const minimumText = minDepositText ?? "";
  const fieldError = tooMuch ? t.walletDepositTooMuch : belowMin ? t.walletDepositBelowMin.replace("{min}", minimumText).replace("{symbol}", symbol) : null;

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
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? "wallet-deposit-field-error" : undefined}
            className="min-w-0 flex-1 rounded-xl bg-slate-800 px-3 py-2.5 text-sm tabular-nums text-slate-100 placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-accent/60"
          />
          <button
            type="button"
            disabled={refreshing}
            // Exact: every base unit of what may be spent is what gets signed. Only the text is cut.
            onClick={() => {
              setMaxAmount(spendable);
              setText(shortDecimalText(formatBaseUnits(spendable, decimals), DISPLAY_DECIMALS));
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
        <p className="text-xs tabular-nums text-slate-400">
          {t.walletDepositAvailable.replace("{amount}", spendableText).replace("{symbol}", symbol)}
        </p>
        {fieldError && (
          <p id="wallet-deposit-field-error" role="alert" className="text-xs text-red-400">
            {fieldError}
          </p>
        )}
        {isNative && (
          <p className="mt-1 flex gap-1.5 text-xs text-slate-400">
            <Info size={14} className="mt-px shrink-0 text-slate-500" aria-hidden="true" />
            {t.walletDepositEvmReserveNote.replace("{reserve}", feeText).replace("{symbol}", symbol)}
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
        {amount !== null && amount > BigInt(0)
          ? t.walletDepositButton
              .replace("{amount}", shortDecimalText(formatBaseUnits(amount, decimals), DISPLAY_DECIMALS, true))
              .replace("{symbol}", symbol)
          : t.walletDepositButtonIdle}
      </button>
    </div>
  );
}

/** Keeps the hooks' arguments total while `token` is null (the panel then renders nothing). */
const FALLBACK_TOKEN = { tokenId: "", chainId: "", erc20: null } as const;

function statusText(
  phase: EvmWalletDepositPhase,
  t: T,
  ctx: { symbol: string; network: string; decimals: number },
): string {
  switch (phase.kind) {
    case "form":
      return "";
    case "waiting":
      return t.walletDepositEvmWaiting.replace("{network}", ctx.network);
    case "confirming":
      return t.walletDepositEvmConfirming.replace("{network}", ctx.network);
    case "arriving":
      return t.walletDepositEvmArriving.replace("{network}", ctx.network);
    case "done":
      return resultText(phase.result, t, ctx);
  }
}

function resultText(r: EvmDepositResult, t: T, ctx: { symbol: string; network: string; decimals: number }): string {
  switch (r.kind) {
    case "credited":
      return t.walletDepositCredited
        .replace("{amount}", shortDecimalText(formatBaseUnits(r.amount, ctx.decimals), DISPLAY_DECIMALS))
        .replace("{symbol}", ctx.symbol);
    case "sent":
      return t.walletDepositEvmSent.replace("{network}", ctx.network);
    case "declined":
      return t.walletDepositDeclined;
    case "switch-failed":
      return t.walletDepositEvmSwitchFailed.replaceAll("{network}", ctx.network);
    case "failed":
      switch (r.cause) {
        case "insufficient-funds":
          return t.walletDepositEvmNotEnoughGas.replace("{native}", NATIVE_SYMBOL).replace("{network}", ctx.network);
        case "reverted":
          return t.walletDepositEvmReverted.replace("{network}", ctx.network);
        case "cancelled":
          return t.walletDepositEvmCancelled;
        case "not-sent":
          return t.walletDepositNotConnected;
      }
      return t.walletDepositFailed;
    case "unconfirmed":
      return t.walletDepositUnconfirmed;
  }
}

function statusTone(phase: EvmWalletDepositPhase): StatusTone {
  if (phase.kind !== "done") return "progress";
  // `sent` is good news too: the chain confirmed it and the bridge is on it.
  return phase.result.kind === "credited" || phase.result.kind === "sent" ? "success" : "attention";
}
