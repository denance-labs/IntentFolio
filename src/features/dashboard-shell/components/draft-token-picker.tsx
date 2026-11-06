"use client";

import { useState, type RefObject } from "react";
import { Check, Plus } from "lucide-react";
import { isPortfolioOfferable } from "@/features/bridge/lib/token-availability";
import { depositableTokens } from "@/features/market/lib/token-registry";
import { TokenAvatar } from "@/features/market/lib/token-avatar";
import {
  matchesStockSearch,
  StockRowChip,
  StockTokenSections,
} from "@/features/portfolio-editor/components/stock-token-sections";
import { colorForSymbol } from "@/features/portfolio-editor/lib/format";
import { translations as editorTranslations } from "@/features/portfolio-editor/lib/translations";
import type { TokenId } from "@/features/intents-account/mock-contract/types";
import { APP_MAX_TOKENS_PER_PORTFOLIO } from "@/features/vault/lib/change-set-preflight";
import { useLanguage } from "../context/language-context";
import { useFundableGeneralBalance } from "../hooks/use-fundable-general-balance";
import type { NewPortfolioDraftRow } from "../lib/new-portfolio-draft";
import { draftHasToken } from "../lib/new-portfolio-draft-editing";
import { shellTranslations } from "../lib/translations";

const SECONDARY_BUTTON =
  "rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-300 transition hover:border-slate-500 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60";

// The picker's list: every depositable token, alphabetical (two "ETH" differ by name), with
// the ones not offerable (outside the catalog, D-396, or not withdrawable yet, D-389) last —
// shown, not selectable, as in "Add to portfolio" and Receive.
const PICKER_TOKENS = [...depositableTokens].sort(
  (a, b) =>
    Number(!isPortfolioOfferable(a.id)) - Number(!isPortfolioOfferable(b.id)) ||
    a.symbol.localeCompare(b.symbol) ||
    a.name.localeCompare(b.name)
);

// The draft's token picker: a search over the depositable tokens, each one added to or taken
// out of the draft at a click. The content of a Modal, not the Modal: the draft editor shows
// it as a view of its own dialog, and the draft's tab (027 A-10) in a dialog of its own.
export function DraftTokenPickerContent({
  rows,
  onAdd,
  onRemove,
  onBack,
  titleId,
  titleRef,
  searchRef,
}: {
  rows: NewPortfolioDraftRow[];
  onAdd: (tokenId: TokenId) => void;
  onRemove: (tokenId: TokenId) => void;
  onBack: () => void;
  titleId: string;
  titleRef?: RefObject<HTMLHeadingElement | null>;
  searchRef?: RefObject<HTMLInputElement | null>;
}) {
  const { lang } = useLanguage();
  const t = shellTranslations[lang];
  const te = editorTranslations[lang];
  const [search, setSearch] = useState("");
  // D-397 (plan 041, P4): what the funding account holds, by the rule of what the funds screen
  // offers, so a token is not marked and then missing there. Nothing while it is not read.
  const fundable = useFundableGeneralBalance();
  const inFundingAccount = new Set<string>(fundable.status === "known" ? fundable.tokenIds : []);

  const q = search.trim().toLowerCase();
  const visible = q
    ? PICKER_TOKENS.filter(
        (tk) =>
          tk.symbol.toLowerCase().includes(q) ||
          tk.name.toLowerCase().includes(q) ||
          tk.category.toLowerCase().includes(q) ||
          matchesStockSearch(tk.id, q, te)
      )
    : PICKER_TOKENS;
  const atMax = rows.length >= APP_MAX_TOKENS_PER_PORTFOLIO;

  return (
    <>
      <h2 id={titleId} ref={titleRef} tabIndex={-1} className="text-lg font-semibold text-slate-100 focus:outline-none">
        {t.draftAddToken}
      </h2>
      <input
        ref={searchRef}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={te.searchToken}
        aria-label={te.searchToken}
        className="mt-4 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none transition placeholder:text-slate-400 focus:border-cyan-300"
      />
      {atMax ? (
        <p className="mt-2 text-xs text-amber-200">{te.appTooManyTokens.replace("{max}", String(APP_MAX_TOKENS_PER_PORTFOLIO))}</p>
      ) : null}
      {visible.length === 0 ? (
        <p className="mt-2 px-3 py-8 text-center text-sm text-slate-400">{te.noTokensFound}</p>
      ) : (
        <StockTokenSections
          items={visible}
          idOf={(tk) => tk.id}
          t={te}
          className="mt-2 rounded-2xl border border-slate-800 bg-slate-900/70 p-1.5"
          renderRow={(tk) => {
            const inDraft = draftHasToken(rows, tk.id);
            const unavailable = !inDraft && atMax;
            const outOfCatalog = !isPortfolioOfferable(tk.id);
            return (
              <li
                key={tk.id}
                // D-534, as in a portfolio's "Add tokens": a token in the draft reads apart from the
                // rest, not only its button. The border is always there, so the row keeps its height.
                className={`flex items-center gap-3 rounded-xl border px-2.5 py-2 transition-colors ${
                  inDraft ? "border-cyan-300/50 bg-cyan-300/[0.08]" : "border-transparent"
                } ${outOfCatalog ? "opacity-50" : ""}`}
              >
                <TokenAvatar
                  symbol={tk.symbol}
                  size={28}
                  className="rounded-full"
                  style={{ backgroundColor: `${colorForSymbol(tk.symbol).hex}22` }}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="text-sm font-semibold text-slate-100">{tk.symbol}</span>
                    <StockRowChip tokenId={tk.id} t={te} />
                  </span>
                  <span className="block truncate text-[11px] text-slate-400">{tk.name}</span>
                  {inFundingAccount.has(tk.id) ? (
                    <span className="block text-[11px] leading-snug text-emerald-300">{t.draftPickerInFundingAccount}</span>
                  ) : null}
                </span>
                {outOfCatalog ? (
                  <span className="shrink-0 text-[11px] text-amber-400">{te.addTokensNotAvailableYet}</span>
                ) : (
                  <button
                    type="button"
                    aria-pressed={inDraft}
                    aria-label={`${te.addTokensAddAction} ${tk.symbol} — ${tk.name}`}
                    disabled={unavailable}
                    onClick={() => (inDraft ? onRemove(tk.id) : onAdd(tk.id))}
                    className={`inline-flex min-h-[2.75rem] w-24 shrink-0 items-center justify-center gap-1 rounded-xl border px-2.5 text-[11px] font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0 sm:py-1.5 ${
                      inDraft
                        ? "border-cyan-300 bg-cyan-300 text-black hover:bg-cyan-200"
                        : "border-cyan-300/30 text-cyan-200 hover:bg-cyan-300/10"
                    }`}
                  >
                    {inDraft ? (
                      <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0" strokeWidth={3} />
                    ) : (
                      <Plus aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                    )}
                    {inDraft ? te.addTokensAdded : te.addTokensAddAction}
                  </button>
                )}
              </li>
            );
          }}
        />
      )}
      <div className="sticky -bottom-6 z-10 -mx-6 -mb-6 mt-5 border-t border-slate-800 bg-slate-950 px-6 pb-6 pt-3">
        <button type="button" onClick={onBack} className={SECONDARY_BUTTON}>
          {t.presetReviewBack}
        </button>
      </div>
    </>
  );
}
