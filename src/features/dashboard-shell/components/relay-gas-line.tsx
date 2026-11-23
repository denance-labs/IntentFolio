"use client";

// The relay's gas on every confirmation that signs for the Verifier (D-589 block 5, 048 §10): the
// quote the screen and the signature share, and its own "Sending cost" line. One module for
// every flow — creating a portfolio, adding funds, withdrawing, converting, stocks — so the line
// reads the same everywhere: a line of its own, or a row where the costs are itemised.

import { useMemo } from "react";
import { useTokenPrices } from "@/features/market/hooks/use-token-prices";
import { toRegistryTokenId } from "@/features/market/lib/intents-token-id";
import { getTokenById } from "@/features/market/lib/token-registry";
import { InfoTooltip } from "@/features/portfolio-editor/components/portfolio-primitives";
import { formatUsd } from "@/features/portfolio-editor/lib/format";
import { quoteRelayGas, type RelayGasCharge, type RelayGasQuote } from "@/features/vault/lib/relay-gas-cost";
import { livePriceOf } from "@/features/vault/lib/storage-cost";
import { useLanguage } from "../context/language-context";
import { shellTranslations, type ShellTranslations } from "../lib/translations";

/** Live USD prices only, as the charge is priced (relay-gas-cost.ts). */
export function useLivePriceOf(): (registryTokenId: string) => number | null {
  const { prices } = useTokenPrices();
  return useMemo(() => (id: string) => livePriceOf(prices, id), [prices]);
}

/** The relay's gas for an operation that moves `tokenId` (a registry id); null before there is one. */
export function useRelayGasQuote(tokenId: string | null): RelayGasQuote | null {
  const priceOf = useLivePriceOf();
  return useMemo(() => (tokenId ? quoteRelayGas({ tokenId, priceOf }) : null), [tokenId, priceOf]);
}

/** Enough significant digits to read a cost of cents in any token (0.006066 USDT, 0.00000008 BTC). */
function formatCostQty(qty: number): string {
  return new Intl.NumberFormat("en-US", { maximumSignificantDigits: 4 }).format(qty);
}

/**
 * The charge in its token, as a phrase for messages ("0.006066 USDT"). `symbol` overrides the
 * registry's, for a screen that names the token its own way (the withdrawal's bare ticker).
 */
export function relayGasCostText(charge: RelayGasCharge, symbol?: string): string {
  const registryId = toRegistryTokenId(charge.tokenId);
  return `${formatCostQty(charge.qty)} ${symbol ?? getTokenById(registryId)?.symbol ?? registryId}`;
}

/** Its own line, after the amounts: the charge in its token and its USD value. */
export function RelayGasLine({ charge, className = "mt-3" }: { charge: RelayGasCharge; className?: string }) {
  const { lang } = useLanguage();
  const t = shellTranslations[lang];
  const priceOf = useLivePriceOf();
  const usdPrice = priceOf(toRegistryTokenId(charge.tokenId));
  return (
    <div
      className={`${className} flex items-start justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-900 px-4 py-2.5`}
    >
      <span className="flex min-w-0 items-start gap-1.5 text-xs leading-snug text-slate-300">
        <span>{t.relayGasLabel}</span>
        <span className="shrink-0 pt-px">
          <InfoTooltip label={t.relayGasLabel} width={240}>
            {t.relayGasInfo}
          </InfoTooltip>
        </span>
      </span>
      <span className="flex shrink-0 flex-col text-right">
        <span className="text-sm tabular-nums text-slate-100">{relayGasCostText(charge)}</span>
        {usdPrice !== null && (
          <span className="text-[11px] tabular-nums text-slate-400">≈ {formatUsd(charge.qty * usdPrice)}</span>
        )}
      </span>
    </div>
  );
}

/**
 * The same line as one row of an itemised costs list (a `<dl>`), for the confirmations that
 * already add up their costs into what arrives (withdrawals, conversions, a stock sale): a box of
 * its own under that total would read as a second charge on top of it, when it is one of the
 * deductions above it. `className` adds to the row, for a list laid out as a grid (`col-span-2`);
 * `labelClassName` sizes the label like the list's other labels (`text-xs` in the withdrawal's
 * details, `text-sm` in the stock sale's).
 */
export function RelayGasRow({
  charge,
  symbol,
  className = "",
  labelClassName = "text-xs",
}: {
  charge: RelayGasCharge;
  symbol?: string;
  className?: string;
  labelClassName?: string;
}) {
  const { lang } = useLanguage();
  const t = shellTranslations[lang];
  const priceOf = useLivePriceOf();
  const usdPrice = priceOf(toRegistryTokenId(charge.tokenId));
  return (
    <div className={`flex items-baseline justify-between gap-4 ${className}`.trim()}>
      <dt className={`flex items-center gap-1.5 ${labelClassName} text-slate-400`}>
        <span>{t.relayGasLabel}</span>
        <InfoTooltip label={t.relayGasLabel} width={240}>
          {t.relayGasInfo}
        </InfoTooltip>
      </dt>
      <dd className="flex flex-col items-end gap-0.5 text-right">
        <span className="text-sm tabular-nums text-slate-200">{relayGasCostText(charge, symbol)}</span>
        {usdPrice !== null && (
          <span className="text-xs tabular-nums text-slate-400">≈ {formatUsd(charge.qty * usdPrice)}</span>
        )}
      </dd>
    </div>
  );
}

/** Why the operation cannot be confirmed for its sending cost, in the user's terms; null when it can. */
export function relayGasQuoteProblem(quote: RelayGasQuote | null, t: ShellTranslations): string | null {
  return quote && !quote.ok ? t.relayGasImplausible : null;
}
