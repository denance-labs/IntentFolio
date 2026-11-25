"use client";

// One token of the funding account and the amount of it to assign (D-591): the same row in the
// review of a new portfolio and in "Add funds", so both read and measure alike.

import type { ReactNode } from "react";
import { getTokenById } from "@/features/market/lib/token-registry";
import { TokenAvatar } from "@/features/market/lib/token-avatar";
import { formatDecimalForInput, percentChipAmount } from "../lib/decimal-input";
import { colorForSymbol, formatTokenAmount, formatUsd } from "../lib/format";
import { amountChipClass } from "./portfolio-primitives";

function FundToken({ symbol, children }: { symbol: string; children?: ReactNode }) {
  const [, ticker, network] = /^([^(]+)(\(.*)?$/.exec(symbol) ?? [symbol, symbol];
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <TokenAvatar
        symbol={symbol}
        size={22}
        className="shrink-0 rounded-full"
        style={{ backgroundColor: `${colorForSymbol(symbol).hex}22` }}
      />
      <div className="min-w-0 leading-tight">
        {/* "USDT(NEAR)" breaks before its network on the narrowest phones. */}
        <p className="text-sm font-medium text-slate-100 [overflow-wrap:anywhere]">
          {ticker}
          {network ? (
            <>
              <wbr />
              {network}
            </>
          ) : null}
        </p>
        {children}
      </div>
    </div>
  );
}

/** The rows of one group, drawn as a single card with dividers. */
export function FundList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ul aria-label={label} className="divide-y divide-slate-800 overflow-hidden rounded-2xl border border-slate-800 bg-slate-900">
      {children}
    </ul>
  );
}

/** A token that is listed but takes no amount, and why. */
export function FundUnavailableRow({
  symbol,
  reason,
  muted = false,
  children,
}: {
  symbol: string;
  reason: string;
  /** The reason is the size of the balance, not the token: no amber, no dimming. */
  muted?: boolean;
  children?: ReactNode;
}) {
  return (
    <li className={`flex items-center justify-between gap-3 px-3.5 py-2 ${muted ? "" : "opacity-50"}`}>
      <FundToken symbol={symbol}>{children}</FundToken>
      <span className={`w-28 shrink-0 text-right text-[11px] ${muted ? "text-slate-400" : "text-amber-400"}`}>{reason}</span>
    </li>
  );
}

export function FundAmountRow({
  tokenId,
  symbol,
  available,
  price,
  value,
  amount,
  onChange,
  inputLabel,
  labels,
  held,
  note,
  error,
  errorId,
}: {
  tokenId: string;
  symbol: string;
  available: number;
  price: number;
  /** The field as typed. */
  value: string;
  /** Its number, clamped to what is available. */
  amount: number;
  onChange: (value: string) => void;
  inputLabel: string;
  labels: { available: string; wholeBalance: string; max: string };
  /** What the portfolio already holds of it. */
  held?: string;
  note?: string;
  error?: string;
  errorId: string;
}) {
  // D-319: Max writes the whole float, wider than the field (the cut is only visual: the value
  // signed is the field's), so it says it is all of it. In the place of what is available, so
  // pressing Max moves nothing.
  const wholeBalance = value === formatDecimalForInput(available);
  const half = percentChipAmount(available, 50, getTokenById(tokenId)?.decimals ?? 8);
  const halfSelected = !wholeBalance && amount > 0 && value === half;
  return (
    // Phone: token | field, then ≈ USD | chips. From `sm`: token | field | chips, with ≈ USD under
    // the field. The DOM order is the tab order in both.
    <li className="grid grid-cols-[minmax(0,1fr)_clamp(5.25rem,27vw,6.5rem)] items-center gap-x-2 gap-y-1 px-3.5 py-2.5 sm:grid-cols-[minmax(0,1fr)_8rem_auto]">
      <div className="min-w-0 self-start sm:row-span-2">
        <FundToken symbol={symbol}>
          {held ? <p className="mt-px text-[11px] tabular-nums text-slate-400">{held}</p> : null}
          {wholeBalance ? (
            <p className="mt-px text-[11px] text-accent/80">{labels.wholeBalance}</p>
          ) : (
            <p className="mt-px text-[11px] tabular-nums text-slate-400">
              {labels.available}: {formatTokenAmount(available, price)}{" "}
              <span className="whitespace-nowrap">≈ {formatUsd(available * price)}</span>
            </p>
          )}
        </FundToken>
      </div>
      {/* Native spinners hidden: useless at 6+ decimals. */}
      <input
        type="number"
        inputMode="decimal"
        min={0}
        max={available}
        step="any"
        value={value}
        placeholder="0"
        onChange={(e) => onChange(e.target.value)}
        aria-label={inputLabel}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className="w-full self-start text-ellipsis rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-right text-sm tabular-nums text-slate-100 focus:text-clip focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <span className="text-right text-[11px] tabular-nums text-slate-400 sm:col-start-2 sm:row-start-2">
        ≈ {formatUsd(amount * price)}
      </span>
      <div className="flex items-center justify-end gap-1 sm:col-start-3 sm:row-start-1">
        <button type="button" aria-pressed={halfSelected} onClick={() => onChange(half)} className={amountChipClass(halfSelected)}>
          50%
        </button>
        <button
          type="button"
          aria-pressed={wholeBalance}
          onClick={() => onChange(formatDecimalForInput(available))}
          className={amountChipClass(wholeBalance)}
        >
          {labels.max}
        </button>
      </div>
      {note ? <p className="col-span-full text-[11px] leading-snug text-amber-400">{note}</p> : null}
      {error ? (
        <p id={errorId} role="alert" className="col-span-full text-right text-[11px] text-rose-400">
          {error}
        </p>
      ) : null}
    </li>
  );
}
