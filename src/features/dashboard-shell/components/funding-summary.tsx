"use client";

// What is assigned, what it costs and what reaches the portfolio (D-591): one block under the
// amounts, in the review of a new portfolio and in "Add funds", instead of a box per cost.

import { toRegistryTokenId } from "@/features/market/lib/intents-token-id";
import { getTokenById } from "@/features/market/lib/token-registry";
import { InfoTooltip } from "@/features/portfolio-editor/components/portfolio-primitives";
import { formatTokenAmount, formatUsd } from "@/features/portfolio-editor/lib/format";
import type { RelayGasCharge } from "@/features/vault/lib/relay-gas-cost";
import type { SetupStorageCost } from "@/features/vault/lib/storage-cost";
import { useLanguage } from "../context/language-context";
import { shellTranslations } from "../lib/translations";
import { relayGasCostText } from "./relay-gas-line";
import { storageCostText } from "./storage-cost-line";

const cents = (usd: number): number => Math.round(usd * 100);

function SummaryRow({
  label,
  info,
  usd,
  amount,
  total = false,
}: {
  label: string;
  info?: string;
  usd: number;
  amount?: string;
  total?: boolean;
}) {
  return (
    <div
      className={`flex items-baseline justify-between gap-3 ${
        total ? "mt-1.5 border-t border-slate-800 pt-2 text-sm font-semibold" : "py-0.5 text-xs"
      }`}
    >
      <dt className={`min-w-0 ${total ? "text-slate-100" : "text-slate-400"}`}>
        {/* The label's last line keeps the "?" room (16 px and its gap), and the "?" sits in it: it
            follows the last word and never wraps onto a line of its own. */}
        <span className={info ? "pr-[22px]" : undefined}>{label}</span>
        {info ? (
          <span className="-ml-4 inline-block align-middle">
            <InfoTooltip label={label} width={240}>
              {info}
            </InfoTooltip>
          </span>
        ) : null}
      </dt>
      <dd className="flex shrink-0 flex-col items-end text-right tabular-nums text-slate-100 sm:flex-row sm:items-baseline sm:gap-2">
        <span>{formatUsd(usd)}</span>
        {amount ? <span className="text-[11px] font-normal text-slate-400">{amount}</span> : null}
      </dd>
    </div>
  );
}

/**
 * `gross` is what the user chose, per token; the costs given here are the ones deducted from it.
 * The total appears only with every cost known (`showNet`): less one, it would promise too much.
 */
export function FundingSummary({
  gross,
  priceOf,
  storage = null,
  relayGas,
  showNet,
  remainingUsd = null,
}: {
  gross: Readonly<Record<string, number>>;
  priceOf: (tokenId: string) => number;
  storage?: SetupStorageCost | null;
  relayGas: RelayGasCharge | null;
  showNet: boolean;
  /** What stays in the funding account; null when all of it is assigned or it is not said here. */
  remainingUsd?: number | null;
}) {
  const { lang } = useLanguage();
  const t = shellTranslations[lang];
  const funded = Object.entries(gross).filter(([, qty]) => qty > 0);
  if (funded.length === 0) return null;

  const gasTokenId = relayGas ? toRegistryTokenId(relayGas.tokenId) : null;
  const costOf = (id: string) =>
    (storage?.tokenId === id ? storage.qty : 0) +
    (relayGas && gasTokenId === id ? relayGas.qty : 0);
  const grossUsd = funded.reduce((sum, [id, qty]) => sum + qty * priceOf(id), 0);
  const storageUsd = storage ? storage.qty * priceOf(storage.tokenId) : 0;
  const relayGasUsd = relayGas && gasTokenId ? relayGas.qty * priceOf(gasTokenId) : 0;
  // From the cents on screen, so the column adds up; the exact figure is the one in tokens.
  const netUsd = Math.max(0, cents(grossUsd) - cents(storageUsd) - cents(relayGasUsd)) / 100;
  // With several tokens the figure in tokens would be a list: the rows above already say it.
  const only = funded.length === 1 ? funded[0] : null;
  const inToken = (qty: number, id: string) => `${formatTokenAmount(qty, priceOf(id))} ${getTokenById(id)?.symbol ?? id}`;

  return (
    <div className="mt-3 rounded-2xl border border-slate-800 bg-slate-900 px-3.5 py-2.5">
      <dl>
        <SummaryRow label={t.fundingSummaryAssigned} usd={grossUsd} amount={only ? inToken(only[1], only[0]) : undefined} />
        {storage ? (
          <SummaryRow
            label={t.storageCostLabel}
            info={t.storageCostInfo}
            usd={storageUsd}
            amount={storageCostText(storage)}
          />
        ) : null}
        {relayGas ? (
          <SummaryRow
            label={t.relayGasLabel}
            info={t.relayGasInfo}
            usd={relayGasUsd}
            amount={relayGasCostText(relayGas)}
          />
        ) : null}
        {showNet ? (
          <SummaryRow
            label={t.fundingSummaryNet}
            usd={netUsd}
            amount={only ? inToken(only[1] - costOf(only[0]), only[0]) : undefined}
            total
          />
        ) : null}
      </dl>
      {remainingUsd !== null ? (
        <p className="mt-1 text-[11px] tabular-nums text-slate-400">
          {t.presetReviewRemaining.replace("{amount}", formatUsd(remainingUsd))}
        </p>
      ) : null}
    </div>
  );
}
