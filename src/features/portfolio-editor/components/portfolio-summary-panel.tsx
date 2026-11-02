"use client";

import { colorForSymbol, formatTokenAmount, formatUsd, type RingColor } from "../lib/format";
import type { ChartRow } from "../types";

type Props = {
  rows: ChartRow[];
  colorByToken?: Map<string, RingColor>;
  /** Shown when nothing has a balance; without it the panel renders nothing. */
  emptyLabel?: string;
};

export function PortfolioSummaryPanel({ rows, colorByToken, emptyLabel }: Props) {
  const tokensWithBalance = rows.filter((row) => row.currentUsd > 0);
  if (tokensWithBalance.length === 0) {
    return emptyLabel ? (
      <p className="mt-4 w-full border-t border-slate-800 pt-4 text-sm text-slate-400">{emptyLabel}</p>
    ) : null;
  }

  return (
    <div className="mt-4 w-full flex flex-wrap gap-2 border-t border-slate-800 pt-4">
      {tokensWithBalance.map((row) => {
        const usdPrice = row.token?.usdPrice ?? 0;
        const qty = usdPrice > 0 ? row.currentUsd / usdPrice : 0;
        return (
          <div
            key={row.id}
            className="flex items-center gap-1.5 rounded-xl border border-slate-700/60 bg-card px-2.5 py-1.5 text-xs"
          >
            {/* 027 A-7: the token's own colour, the one the donut and the targets table use,
                so the three read as one legend. */}
            <span
              className="h-2 w-2 shrink-0 rounded-sm"
              style={{ backgroundColor: (colorByToken?.get(row.tokenId) ?? colorForSymbol(row.symbol)).hex }}
              aria-hidden="true"
            />
            <span className="font-semibold text-slate-200">{row.symbol}</span>
            <span className="text-slate-400 tabular-nums">{formatTokenAmount(qty, usdPrice)}</span>
            <span className="text-slate-400 tabular-nums">≈ {formatUsd(row.currentUsd)}</span>
          </div>
        );
      })}
    </div>
  );
}
