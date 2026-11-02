"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTokenPrices } from "@/features/market/hooks/use-token-prices";
import { getTokenById } from "@/features/market/lib/token-registry";
import { formatTokenAmount, formatUsd } from "@/features/portfolio-editor/lib/format";
import { useLanguage } from "../context/language-context";
import type { NewPortfolioDraftRow } from "../lib/new-portfolio-draft";
import {
  formatSimulationAmountInput,
  parseSimulationAmountInput,
  simulateDraftHoldings,
  simulationAmountText,
} from "../lib/new-portfolio-draft-simulation";
import { shellTranslations } from "../lib/translations";

const symbolFor = (tokenId: string) => getTokenById(tokenId)?.symbol ?? tokenId;

// D-358 — the "Allocation preview" block (D-504: "This is how $10,000 would be split…"), in the
// editor and on the draft's tab (019-4). Never on My Account's card (operator, s188): the card
// stays a summary with actions — and once funds arrived, a made-up amount there would read as
// the real one. Until funds arrive nothing is confirmed, so the copy is conditional and
// approximate, and one note under the list says so (D-504 reverses D-456's "no note"; in the
// editor it replaces the "not financial advice" line). The amount is kept with the draft
// (D-457): the field opens on `initialUsd` and reports every usable amount it takes, which the
// caller stores — at once on the draft's tab, on save in the editor. Clearing the field reports
// nothing, so the last usable amount is the one kept.
export function NewPortfolioDraftSimulation({
  rows,
  colorOf,
  initialUsd,
  onAmountChange,
}: {
  rows: readonly NewPortfolioDraftRow[];
  colorOf: (tokenId: string) => { hex: string };
  initialUsd: number;
  onAmountChange: (amountUsd: number) => void;
}) {
  const { lang } = useLanguage();
  const t = shellTranslations[lang];
  const { prices, isLoading } = useTokenPrices();
  const [text, setText] = useState(() => simulationAmountText(initialUsd));
  // D-503: the commas are re-laid on every keystroke, so the caret is put back after the same
  // number of digits it followed — otherwise React's rewrite of the value throws it to the end.
  const inputRef = useRef<HTMLInputElement>(null);
  const caretDigits = useRef<number | null>(null);
  useLayoutEffect(() => {
    const input = inputRef.current;
    const digits = caretDigits.current;
    if (!input || digits === null || document.activeElement !== input) return;
    caretDigits.current = null;
    let pos = 0;
    for (let seen = 0; pos < text.length && seen < digits; pos++) if (/\d/.test(text[pos])) seen++;
    input.setSelectionRange(pos, pos);
  }, [text]);

  const amountUsd = parseSimulationAmountInput(text);
  const holdings = simulateDraftHoldings(rows, amountUsd, prices);
  const nonePriced = holdings.every((h) => h.amount === null);

  let body: ReactNode;
  if (isLoading) {
    body = <p className="mt-3 text-sm text-slate-400">{t.draftSimLoading}</p>;
  } else if (nonePriced) {
    body = <p className="mt-3 text-sm text-amber-200">{t.draftSimNoPrices}</p>;
  } else if (amountUsd <= 0) {
    body = <p className="mt-3 text-sm text-slate-400">{t.draftSimEnterAmount}</p>;
  } else {
    body = (
      <ul aria-label={t.draftSimListLabel} className="mt-3 divide-y divide-slate-800/70">
        {holdings.map((h) => (
          <li key={h.tokenId} className="flex items-center gap-2 py-1.5 text-sm">
            <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: colorOf(h.tokenId).hex }} />
            <span className="min-w-0 flex-1 truncate font-medium text-slate-200">{symbolFor(h.tokenId)}</span>
            {h.amount !== null && h.price !== null ? (
              <span className="tabular-nums text-slate-100">{formatTokenAmount(h.amount, h.price)}</span>
            ) : (
              <span className="text-xs text-slate-500">{t.draftSimNoPrice}</span>
            )}
            <span className="w-24 shrink-0 text-right text-xs tabular-nums text-slate-400">≈ {formatUsd(h.usd)}</span>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <section className="mt-5 rounded-2xl border border-slate-800 bg-surface px-4 py-3" aria-labelledby="draft-sim-title">
      <h3 id="draft-sim-title" className="text-[11px] font-semibold uppercase tracking-wide text-cyan-300">
        {t.draftSimTitle}
      </h3>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-300">
        <span aria-hidden="true">{t.draftSimWith}</span>
        <div className="flex h-11 w-32 items-center rounded-xl border border-slate-700 bg-slate-950 px-3 transition focus-within:border-cyan-300 sm:h-9">
          <span aria-hidden="true" className="mr-1 text-slate-400">$</span>
          <input
            ref={inputRef}
            id="draft-sim-amount"
            type="text"
            inputMode="numeric"
            value={text}
            onChange={(e) => {
              const raw = e.target.value;
              const caret = e.target.selectionStart ?? raw.length;
              caretDigits.current = raw.slice(0, caret).split(".")[0].replace(/\D/g, "").replace(/^0+(?=\d)/, "").length;
              const next = formatSimulationAmountInput(raw);
              setText(next);
              const usd = parseSimulationAmountInput(next);
              if (usd > 0) onAmountChange(usd);
            }}
            aria-label={t.draftSimAmountLabel}
            className="w-full min-w-0 bg-transparent tabular-nums text-slate-100 outline-none"
          />
        </div>
        <span aria-hidden="true">{t.draftSimWouldHold}</span>
      </div>
      {body}
      <p className="mt-3 text-[11px] leading-snug text-slate-400">{t.draftSimNote}</p>
    </section>
  );
}
