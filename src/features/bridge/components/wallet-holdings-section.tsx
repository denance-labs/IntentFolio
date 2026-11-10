"use client";

// D-445: Receive's first step, "From your connected wallet" — what the connected wallet holds of the
// tokens Receive takes, above the full asset list. A row opens the network step with its own
// network marked (operator, 2026-10-25: the same for every wallet, NEAR included); from there the
// deposit goes on as usual. Amounts here are display only: the amount step re-reads the exact
// figure before anything is signed.

import { Loader2 } from "lucide-react";
import { useTokenPrices } from "@/features/market/hooks/use-token-prices";
import { ChainIcon, TokenIcon, hasChainIcon, hasTokenIcon } from "@/features/market/lib/token-icons";
import { colorForSymbol, formatUsd } from "@/features/portfolio-editor/lib/format";
import { chainRegistry } from "../lib/chain-registry";
import type { DepositGroup } from "../lib/deposit-registry";
import { formatBaseUnits, type WalletHolding } from "../lib/near-wallet-deposit";
import type { bridgeTranslations } from "../lib/translations";
import { shortDecimalText } from "./wallet-deposit-panel";

type T = (typeof bridgeTranslations)["en"];

/** Fraction digits in the list: a glance at what is there, not the figure that gets signed. */
const LIST_DECIMALS = 4;
const SMALLEST_LISTED = `0.${"0".repeat(LIST_DECIMALS - 1)}1`;

export type WalletHoldingEntry = { holding: WalletHolding; group: DepositGroup; chainId: string };

/** Which wallet the section reads: NEAR lists one network, EVM several. */
export type WalletHoldingsFamily = "near" | "evm";

/**
 * The pill's text. An EVM address is cut in the middle, shorter than the header's wallet chip: the
 * pill shares its row with the title, and at 390 px the chip's 8 + 6 lost its tail to the CSS cut.
 */
function accountLabel(accountId: string, family: WalletHoldingsFamily): string {
  return family === "evm" ? `${accountId.slice(0, 6)}…${accountId.slice(-4)}` : accountId;
}

export function WalletHoldingsSection({
  accountId,
  family,
  pending,
  entries,
  t,
  onSelect,
}: {
  accountId: string;
  family: WalletHoldingsFamily;
  /** The first read has not answered yet. */
  pending: boolean;
  entries: WalletHoldingEntry[];
  t: T;
  onSelect: (entry: WalletHoldingEntry) => void;
}) {
  const { prices } = useTokenPrices();
  if (!pending && entries.length === 0) return null;

  // Live quotes only, like the amount step: the registry fallback can be several times off.
  const rows = entries
    .map((entry) => {
      const amount = Number(formatBaseUnits(entry.holding.available, entry.holding.decimals));
      const price = prices[entry.holding.tokenId]?.usdPrice ?? 0;
      return { entry, usd: price > 0 ? amount * price : null };
    })
    // Most valuable first; a token with no quote goes last rather than reading as zero.
    .sort(
      (a, b) =>
        (b.usd ?? -1) - (a.usd ?? -1) ||
        a.entry.group.ticker.localeCompare(b.entry.group.ticker) ||
        a.entry.chainId.localeCompare(b.entry.chainId)
    );
  // NEAR lists one network, so it goes unsaid; on EVM the same token sits on several and each
  // row names its own.
  const showNetwork = family !== "near";

  return (
    // A box of its own (operator, D-445 review): the wallet's tokens read as a separate block from
    // "From another wallet" below, not as the top of one long list.
    <section
      aria-labelledby="wallet-holdings-title"
      className="mb-4 rounded-xl border border-slate-700 bg-slate-800/40 py-1"
    >
      {/* Wraps instead of cutting: at 390 px the Spanish title leaves the pill a few pixels short
          of an EVM address, so the pill drops below the title rather than lose the address's tail. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-3 pb-1.5 pt-2">
        <p id="wallet-holdings-title" className="shrink-0 text-xs font-semibold uppercase tracking-wide text-slate-400">
          {t.walletHoldingsTitle}
        </p>
        {/* The connected account as a pill, its dot saying it is live: the section only renders
            with the wallet actually plugged in (`liveConnection`). */}
        <p
          className="flex min-w-0 max-w-full items-center gap-1.5 rounded-full bg-accent/10 py-0.5 pl-2 pr-2.5 text-xs font-semibold text-accent ring-1 ring-inset ring-accent/10"
          title={accountId}
        >
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400 ring-[3px] ring-emerald-400/20" aria-hidden="true" />
          <span className="truncate">{accountLabel(accountId, family)}</span>
        </p>
      </div>
      {pending ? (
        <p role="status" className="flex items-center gap-2 px-3 py-3 text-sm text-slate-400">
          <Loader2 size={16} className="animate-spin" aria-hidden="true" />
          {t.walletDepositReading}
        </p>
      ) : (
        <ul role="list">
          {rows.map(({ entry, usd }) => {
            const { holding, group, chainId } = entry;
            const cutText = shortDecimalText(formatBaseUnits(holding.available, holding.decimals), LIST_DECIMALS);
            // A balance below the list's precision is not "0": it sat next to its USD value ($0.12).
            const amountText = cutText === "0" ? `< ${SMALLEST_LISTED}` : cutText;
            return (
              <li key={holding.tokenId}>
                <button
                  type="button"
                  onClick={() => onSelect(entry)}
                  className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition hover:bg-slate-700/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60 active:bg-slate-700"
                >
                  {hasTokenIcon(group.ticker) ? (
                    <div
                      className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-slate-800"
                      aria-hidden="true"
                    >
                      <TokenIcon symbol={group.ticker} size={36} />
                    </div>
                  ) : (
                    <div
                      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold text-slate-950 ${colorForSymbol(group.ticker).bg}`}
                      aria-hidden="true"
                    >
                      {group.ticker.slice(0, 2)}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="flex min-w-0 items-center gap-2 text-sm font-medium text-slate-100">
                      {group.ticker}
                      {/* The network as a chip, like step 3's: it is what tells two USDC apart. */}
                      {showNetwork && (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-slate-700/70 px-2 py-0.5 text-[11px] font-semibold text-slate-200">
                          {hasChainIcon(chainId) && <ChainIcon chainId={chainId} size={12} />}
                          {chainRegistry[chainId]?.displayName ?? chainId}
                        </span>
                      )}
                    </p>
                    <p className="truncate text-xs tabular-nums text-slate-400">
                      {amountText} {group.ticker}
                    </p>
                  </div>
                  {usd !== null && (
                    <span className="shrink-0 text-sm tabular-nums text-slate-200">{formatUsd(usd)}</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
