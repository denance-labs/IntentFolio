"use client";

import { useMemo, useRef, useState, type RefObject } from "react";
import { Check, Plus } from "lucide-react";
import { isStockToken } from "@/features/market/lib/stock-tokens";
import { depositableTokens, getTokenById } from "@/features/market/lib/token-registry";
import { TokenIcon } from "@/features/market/lib/token-icons";
import { isPortfolioOfferable } from "@/features/bridge/lib/token-availability";
import { useStocksRegionBlocked } from "@/features/stocks/hooks/use-stocks-region-blocked";
import { APP_MAX_TOKENS_PER_PORTFOLIO } from "@/features/vault/lib/change-set-preflight";
import { Modal } from "./portfolio-primitives";
import { matchesStockSearch, StockRowChip, StockTokenSections } from "./stock-token-sections";
import { colorForSymbol } from "../lib/format";
import type { translations } from "../lib/translations";
import type { CurrentPortfolioQty } from "../types";

type T = (typeof translations)["en"];

type Props = {
  t: T;
  // Token ids of the composition's target rows, a 0% one with no funds included.
  compositionTokenIds: readonly string[];
  // Effective portfolio balances: a token held outside the composition is in the portfolio too.
  existingBalances: CurrentPortfolioQty;
  // Adds one token to the draft composition at a 0% target. No funds move.
  onAddTarget: (tokenId: string) => void;
  onClose: () => void;
};

type Entry = {
  id: string;
  symbol: string;
  name: string;
  category: string;
  inPortfolio: boolean;
  // Outside the catalog (D-396) or with no buy route (D-491): shown, never chosen.
  offerable: boolean;
};

// D-529: "Add tokens" only adds targets; funds come in through "Add funds". The choice is made
// here and applied on confirm, so Cancel leaves no draft behind.
export function AddTargetsModal({ t, compositionTokenIds, existingBalances, onAddTarget, onClose }: Props) {
  const searchRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const regionBlocked = useStocksRegionBlocked();

  const entries = useMemo<Entry[]>(() => {
    const composition = new Set(compositionTokenIds);
    const ids = new Set<string>(depositableTokens.map((token) => token.id));
    for (const id of Object.keys(existingBalances)) ids.add(id);
    for (const id of composition) ids.add(id);

    const out: Entry[] = [];
    for (const id of ids) {
      const token = getTokenById(id);
      if (!token) continue;
      out.push({
        id,
        symbol: token.symbol,
        name: token.name,
        category: token.category,
        inPortfolio: composition.has(id) || (existingBalances[id] ?? 0) > 0,
        offerable: isPortfolioOfferable(id),
      });
    }
    // As the draft's picker: alphabetical (two "ETH" differ by name), the ones that can't be a
    // target last.
    return out.sort(
      (a, b) =>
        Number(!a.offerable) - Number(!b.offerable) ||
        a.symbol.localeCompare(b.symbol) ||
        a.name.localeCompare(b.name)
    );
  }, [compositionTokenIds, existingBalances]);

  const q = search.trim().toLowerCase();
  const visible = q
    ? entries.filter(
        (e) =>
          e.symbol.toLowerCase().includes(q) ||
          e.name.toLowerCase().includes(q) ||
          e.category.toLowerCase().includes(q) ||
          matchesStockSearch(e.id, q, t)
      )
    : entries;

  // The app's cap on a growing composition (D-528): once reached, the rest can't be marked.
  const atMax = compositionTokenIds.length + selected.size >= APP_MAX_TOKENS_PER_PORTFOLIO;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  function handleConfirm() {
    if (selected.size === 0) return;
    for (const id of selected) onAddTarget(id);
    onClose();
  }

  const confirmLabel =
    selected.size === 0
      ? t.addTargetsConfirm
      : selected.size === 1
        ? t.addTargetsConfirmOne
        : t.addTargetsConfirmMany.replace("{n}", String(selected.size));

  return (
    <Modal
      titleId="add-targets-title"
      onClose={onClose}
      initialFocusRef={searchRef as RefObject<HTMLElement>}
      maxWidth="max-w-lg"
    >
      <h2 id="add-targets-title" className="text-lg font-semibold text-slate-100">
        {t.addTokensTitle}
      </h2>
      <p className="mt-1 text-sm text-slate-400">{t.addTargetsSubcopy}</p>

      <input
        ref={searchRef}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={t.searchToken}
        aria-label={t.searchToken}
        className="mt-4 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none transition placeholder:text-slate-400 focus:border-cyan-300"
      />
      {atMax ? (
        <p className="mt-2 text-xs text-amber-200">
          {t.appTooManyTokens.replace("{max}", String(APP_MAX_TOKENS_PER_PORTFOLIO))}
        </p>
      ) : null}

      {visible.length === 0 ? (
        <p className="mt-2 px-3 py-8 text-center text-sm text-slate-400">{t.noTokensFound}</p>
      ) : (
        <StockTokenSections
          items={visible}
          idOf={(e) => e.id}
          t={t}
          className="mt-2 max-h-[min(28rem,55vh)] overflow-y-auto rounded-2xl border border-slate-800 bg-slate-900/70 p-1.5"
          regionBlocked={regionBlocked}
          renderRow={(e) => {
            const isSelected = selected.has(e.id);
            // D-569: a stock the portfolio already has is left as it is; only adding one is blocked.
            const blockedHere = regionBlocked && isStockToken(e.id) && !e.inPortfolio && !isSelected;
            return (
              <li
                key={e.id}
                // D-534: a marked row reads apart from the rest, not only its button. The border is
                // always there, so marking it never changes the row's height.
                className={`flex items-center gap-3 rounded-xl border px-2.5 py-2 transition-colors ${
                  isSelected ? "border-cyan-300/50 bg-cyan-300/[0.08]" : "border-transparent"
                } ${(!e.offerable || blockedHere) && !e.inPortfolio ? "opacity-50" : ""}`}
              >
                <span
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
                  style={{ backgroundColor: `${colorForSymbol(e.symbol).hex}22` }}
                  aria-hidden="true"
                >
                  <TokenIcon symbol={e.symbol} size={22} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="text-sm font-semibold text-slate-100">{e.symbol}</span>
                    <StockRowChip tokenId={e.id} t={t} />
                  </span>
                  <span className="block truncate text-[11px] text-slate-400">{e.name}</span>
                </span>
                {e.inPortfolio ? (
                  // Neutral, so it is never mistaken for a token just marked "Added".
                  <span className="shrink-0 rounded-full border border-slate-700 bg-slate-800 px-2 py-0.5 text-[10px] font-medium text-slate-300">
                    {t.addTokensInPortfolio}
                  </span>
                ) : !e.offerable ? (
                  <span className="shrink-0 text-[11px] text-amber-400">{t.addTokensNotAvailableYet}</span>
                ) : blockedHere ? (
                  <span className="shrink-0 text-[11px] text-amber-400">{t.stockRegionBlockedRow}</span>
                ) : (
                  <button
                    type="button"
                    aria-pressed={isSelected}
                    aria-label={`${t.addTokensAddAction} ${e.symbol} — ${e.name}`}
                    disabled={!isSelected && atMax}
                    onClick={() => toggle(e.id)}
                    className={`inline-flex min-h-[2.75rem] w-24 shrink-0 items-center justify-center gap-1 rounded-xl border px-2.5 text-[11px] font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0 sm:py-1.5 ${
                      isSelected
                        ? "border-cyan-300 bg-cyan-300 text-black hover:bg-cyan-200"
                        : "border-cyan-300/30 text-cyan-200 hover:bg-cyan-300/10"
                    }`}
                  >
                    {isSelected ? (
                      <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0" strokeWidth={3} />
                    ) : (
                      <Plus aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                    )}
                    {isSelected ? t.addTokensAdded : t.addTokensAddAction}
                  </button>
                )}
              </li>
            );
          }}
        />
      )}

      <div className="mt-6 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onClose}
          className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-300 transition hover:border-slate-500 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
        >
          {t.cancel}
        </button>
        <button
          type="button"
          onClick={handleConfirm}
          disabled={selected.size === 0}
          className="rounded-xl bg-cyan-300 px-4 py-2 text-sm font-semibold text-black transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
