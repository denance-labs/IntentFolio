"use client";

import { useMemo } from "react";
import { getTokenById } from "@/features/market/lib/token-registry";
import { TokenAvatar } from "@/features/market/lib/token-avatar";
import { buildTokenColorMap, colorForSymbol } from "@/features/portfolio-editor/lib/format";
import { translations as editorTranslations } from "@/features/portfolio-editor/lib/translations";
import { useLanguage } from "../context/language-context";

// 019-5 (D-393 Q4) — the New Portfolio Draft editor's composition, shared: the colour bar
// both draw, and its table read-only for the confirmation that signs the draft, so what is
// signed looks like what was built.

type CompositionRow = { tokenId: string; targetPct: number; tolerancePct: number };
type Color = { hex: string };

const symbolFor = (tokenId: string) => getTokenById(tokenId)?.symbol ?? tokenId;
const tokenNameFor = (tokenId: string) => getTokenById(tokenId)?.name ?? "";

const READ_ONLY_GRID = "grid grid-cols-[minmax(0,1fr)_4.5rem_5rem] items-center gap-x-3";

/** The editor's colours: one per symbol over the whole mix, so a token keeps its colour across the two. */
export function useDraftCompositionColors(rows: readonly CompositionRow[]): (tokenId: string) => Color {
  const colors = useMemo(() => buildTokenColorMap(rows.map((r) => r.tokenId)), [rows]);
  return (tokenId) => colors.get(tokenId) ?? colorForSymbol(symbolFor(tokenId));
}

export function DraftCompositionBar({
  rows,
  colorOf,
}: {
  rows: readonly CompositionRow[];
  colorOf: (tokenId: string) => Color;
}) {
  if (rows.length === 0) return null;
  return (
    <div aria-hidden="true" className="flex h-2 w-full overflow-hidden rounded-full bg-slate-800">
      {rows.map((r) => (
        <span
          key={r.tokenId}
          className="h-full motion-safe:transition-[width] motion-safe:duration-200"
          style={{ width: `${Math.max(0, r.targetPct)}%`, backgroundColor: colorOf(r.tokenId).hex }}
        />
      ))}
    </div>
  );
}

export function DraftCompositionTable({ rows }: { rows: readonly CompositionRow[] }) {
  const { lang } = useLanguage();
  const te = editorTranslations[lang];
  const colorOf = useDraftCompositionColors(rows);
  const targetLabel = te.target.replace(/\s*%$/, "");

  return (
    <>
      <DraftCompositionBar rows={rows} colorOf={colorOf} />
      <div className="mt-3 rounded-2xl border border-slate-800 bg-slate-900">
        <div
          aria-hidden="true"
          className={`border-b border-l-[3px] border-b-slate-800 border-l-transparent px-3 py-2 text-[11px] font-medium text-slate-400 ${READ_ONLY_GRID}`}
        >
          <span>{te.token}</span>
          <span className="text-right">{te.target}</span>
          <span className="text-right">{te.band}</span>
        </div>
        <ul className="divide-y divide-slate-800">
          {rows.map((row) => {
            const symbol = symbolFor(row.tokenId);
            const color = colorOf(row.tokenId).hex;
            return (
              <li
                key={row.tokenId}
                className={`border-l-[3px] px-3 py-2.5 ${READ_ONLY_GRID}`}
                style={{ borderLeftColor: color }}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <TokenAvatar symbol={symbol} size={22} className="rounded-full" style={{ backgroundColor: `${color}22` }} />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-slate-100">{symbol}</span>
                    <span className="block truncate text-[11px] text-slate-400">{tokenNameFor(row.tokenId)}</span>
                  </span>
                </span>
                {/* The header is hidden from assistive tech, so each value carries its label —
                    without the header's "%", which the value already says. */}
                <span className="text-right text-sm tabular-nums text-slate-100">
                  <span className="sr-only">{targetLabel} </span>
                  {row.targetPct}%
                </span>
                <span className="text-right text-sm tabular-nums text-slate-300">
                  <span className="sr-only">{te.band} </span>±{row.tolerancePct}%
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}
