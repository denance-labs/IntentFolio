"use client";

import { useId, type ReactNode } from "react";
import { isStockToken, stockKind } from "@/features/market/lib/stock-tokens";
import { STOCK_BAND_CLASS, STOCK_HEADING_CLASS, StockChip, StockIcon } from "@/features/market/lib/stock-marker";
import type { translations } from "../lib/translations";

type T = Pick<
  (typeof translations)["en"],
  | "stockSectionTitle"
  | "stockSectionNote"
  | "stockOtherTokens"
  | "stockChipStock"
  | "stockChipEtf"
  | "stockSearchTerms"
  | "stockRegionBlockedNote"
>;

/** Search by the localized word too: "acciones" finds the stocks, and their category only says "Stocks". */
export function matchesStockSearch(tokenId: string, query: string, t: Pick<T, "stockSearchTerms">): boolean {
  return isStockToken(tokenId) && t.stockSearchTerms.toLowerCase().includes(query);
}

/** The chip beside a stock's symbol, in any row that lists one. */
export function StockRowChip({ tokenId, t }: { tokenId: string; t: Pick<T, "stockChipStock" | "stockChipEtf"> }) {
  if (!isStockToken(tokenId)) return null;
  return <StockChip label={stockKind(tokenId) === "etf" ? t.stockChipEtf : t.stockChipStock} />;
}

// D-558: the list both "Add tokens" pickers share. The stocks go first, in a section of their own
// that holds the note about them once; the rest keep the order they came in. A section with no
// rows is not rendered, and "Tokens" only appears when there is a stock section to set it apart from.
// D-569: where stocks can't be bought, their section goes last, as the pickers already do with
// every token that can't be chosen, and says why in place of the note. Each row shows that too.
export function StockTokenSections<Item>({
  items,
  idOf,
  renderRow,
  t,
  className,
  regionBlocked = false,
}: {
  items: readonly Item[];
  idOf: (item: Item) => string;
  renderRow: (item: Item) => ReactNode;
  t: T;
  className: string;
  regionBlocked?: boolean;
}) {
  const baseId = useId();
  const stocks = items.filter((item) => isStockToken(idOf(item)));
  const others = items.filter((item) => !isStockToken(idOf(item)));
  const stocksId = `${baseId}-stocks`;
  const othersId = `${baseId}-others`;
  const stocksFirst = stocks.length > 0 && !regionBlocked;

  const stockSection =
    stocks.length > 0 ? (
      <div className={`${STOCK_BAND_CLASS} ${regionBlocked && others.length > 0 ? "mt-1.5" : ""}`}>
        <div className="px-2.5 pb-1 pt-2">
          <p id={stocksId} className={STOCK_HEADING_CLASS}>
            <StockIcon className="h-3.5 w-3.5 shrink-0" />
            {t.stockSectionTitle}
          </p>
          {regionBlocked ? (
            <p className="mt-0.5 text-[11px] leading-snug text-amber-200">{t.stockRegionBlockedNote}</p>
          ) : (
            <p className="mt-0.5 text-[11px] leading-snug text-slate-400">{t.stockSectionNote}</p>
          )}
        </div>
        <ul aria-labelledby={stocksId} className="space-y-1">
          {stocks.map(renderRow)}
        </ul>
      </div>
    ) : null;

  return (
    <div className={className}>
      {stocksFirst ? stockSection : null}
      {others.length > 0 ? (
        <>
          {stocksFirst ? (
            <p id={othersId} className="mt-1.5 border-t border-slate-800 px-2.5 pb-1 pt-3 text-xs font-semibold text-slate-400">
              {t.stockOtherTokens}
            </p>
          ) : null}
          <ul aria-labelledby={stocksFirst ? othersId : undefined} className="space-y-1">
            {others.map(renderRow)}
          </ul>
        </>
      ) : null}
      {stocksFirst ? null : stockSection}
    </div>
  );
}
