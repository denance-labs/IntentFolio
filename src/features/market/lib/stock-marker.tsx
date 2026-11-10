import { ChartCandlestick } from "lucide-react";

// D-558: what marks a stock next to an ordinary token. Fuchsia because the app's other accents
// already mean something (bone `accent`: action; amber, rose, emerald: state; violet: out of band). Always
// an icon and a word too, so the mark never depends on color alone. To change the accent, change
// this file.

export const STOCK_HEADING_CLASS = "flex items-center gap-1.5 text-xs font-semibold text-fuchsia-200";
export const STOCK_BAND_CLASS = "rounded-xl bg-fuchsia-300/[0.05] pb-1";

export function StockIcon({ className }: { className: string }) {
  return <ChartCandlestick aria-hidden="true" className={className} />;
}

/** A stock's share inside a preset card. The word is for screen readers: the card already says it. */
export function StockSlot({ symbol, pct, label }: { symbol: string; pct: number; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-fuchsia-300/10 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-fuchsia-200 ring-1 ring-inset ring-fuchsia-300/40">
      <StockIcon className="h-2.5 w-2.5" />
      <span className="sr-only">{label}: </span>
      {symbol} {pct}%
    </span>
  );
}

export function StockChip({ label }: { label: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-fuchsia-300/60 bg-fuchsia-300/10 px-1.5 py-0.5 text-[10px] font-medium leading-none text-fuchsia-200">
      <StockIcon className="h-2.5 w-2.5" />
      {label}
    </span>
  );
}
