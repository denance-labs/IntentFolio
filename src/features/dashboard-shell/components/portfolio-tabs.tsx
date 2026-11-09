"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Plus, Wallet } from "lucide-react";
import { useLanguage } from "../context/language-context";
import { usePortfolio } from "../context/portfolio-context";
import { useFundableGeneralBalance } from "../hooks/use-fundable-general-balance";
import { shellTranslations } from "../lib/translations";
import { portfolioColor } from "../lib/portfolio-color";
import { Modal } from "@/features/portfolio-editor/components/portfolio-primitives";
import { formatUsd } from "@/features/portfolio-editor/lib/format";
import { appPortfolioCap } from "@/features/vault/lib/change-set-preflight";
import { PortfolioTabMenu } from "./portfolio-tab-menu";
import { PortfolioRenameModal } from "./portfolio-rename-modal";
import { PortfolioDeleteModal } from "./portfolio-delete-modal";
import type { ValidationResult } from "../lib/portfolio-validation";

type ModalState =
  | { type: "none" }
  | { type: "new-window" }
  | { type: "rename"; portfolioId: string; currentName: string }
  | { type: "rename-draft" }
  | { type: "delete-draft" }
  | { type: "delete"; portfolioId: string };

// The mobile <select>'s value for the draft's option. Not a portfolio id: those are numeric
// strings from the contract or `mock-…`.
const DRAFT_OPTION = "*new-portfolio-draft";

export function PortfolioTabs({
  miCuentaActive = false,
  miCuentaBadge = false,
  onMiCuentaClick,
  onPortfolioTabSelect,
  draftTab,
  onNewPortfolio,
  signedOut = false,
  values,
}: {
  miCuentaActive?: boolean;
  miCuentaBadge?: boolean;
  onMiCuentaClick?: () => void;
  onPortfolioTabSelect?: (portfolioId: string) => void;
  /**
   * The New Portfolio Draft's tab (019-4), after the portfolios and before "+". `rename` saves a
   * new name in this browser, unsigned (022-G), checked against `existingNames`.
   */
  draftTab?: {
    name: string;
    active: boolean;
    onSelect: () => void;
    rename: (name: string, existingNames: string[]) => ValidationResult;
    /** D-560: "Delete draft" in its menu, after asking. Nothing is signed. */
    discard: () => void;
  };
  /**
   * "+" with nothing in the way. The shell hosts the creation flow, not this strip: the flow can
   * end in a signature, and the shell drops the strip when the wallet status changes, which would
   * take the signature's screen and its "funds in transit" notice with it (D-298, D-397).
   */
  onNewPortfolio?: () => void;
  /** No wallet connected: "+" builds the anonymous draft (D-359). */
  signedOut?: boolean;
  /**
   * 021 R5: the figure under each name — My Account's funding account (029 B-16) and each
   * portfolio's value. None signed out (no account) and none on the draft's tab (nothing in it yet).
   */
  /** `fundingUsd` null: the funding account is not read yet (D-541), shown as "—". */
  values?: { fundingUsd: number | null; byPortfolio: ReadonlyMap<string, number> };
} = {}) {
  const { lang } = useLanguage();
  const { portfolios, activePortfolioId, setActivePortfolioId } = usePortfolio();
  const t = shellTranslations[lang];
  const [modal, setModal] = useState<ModalState>({ type: "none" });

  const existingNames = portfolios.map((p) => p.name);
  // As the draft's editor checks them (create-portfolio-flow): signed out, against none.
  const draftExistingNames = signedOut ? [] : existingNames;
  const activePortfolio = portfolios.find((p) => p.id === activePortfolioId) ?? portfolios[0];
  // D-419: the strip stays with no portfolio and no draft too ("My Account" + "New portfolio"),
  // so deleting the last portfolio does not take the way to make another with it.
  const hasSelectOptions = portfolios.length > 0 || !!draftTab;
  const draftActive = !miCuentaActive && (draftTab?.active ?? false);
  // 022-D (D-455): one draft per account. While one is saved "+" waits: it looks muted and
  // opens a window that says why, with the way to the draft (029 B-22: a disabled button with
  // a title said nothing on a phone, to a keyboard or to a screen reader). D-397: only until
  // there are funds. With them a new portfolio is signed, not saved, so the draft is not in the
  // way and stays as it is: the same window then offers both, the draft or a new one. Signed out
  // there is nothing to sign with, whatever the read says.
  const fundable = useFundableGeneralBalance();
  const canCreateBesideDraft = !signedOut && fundable.status === "known" && fundable.fundable;
  const newBlockedByDraft = !!draftTab && !canCreateBesideDraft;
  // D-476: at the cap "+" waits the same way, so no draft is built that could never be created.
  // The cap names its own reason, ahead of the draft's, and offers no way out (deleting means
  // choosing which). The Setup pre-flight still checks the chain's count before signing, for a
  // portfolio this list has not loaded.
  const portfolioCap = appPortfolioCap();
  const newBlockedByCap = portfolios.length >= portfolioCap;
  const newBlocked = newBlockedByCap || newBlockedByDraft;
  const offersNewBesideDraft = !newBlocked && !!draftTab;
  // What the window says. With a draft it follows the balance while open, so funds arriving add the
  // way to a new portfolio in place, and funds leaving take it away.
  const newWindowMessage = newBlockedByCap
    ? t.addPortfolioCapReached.replace("{max}", String(portfolioCap))
    : offersNewBesideDraft
      ? t.addPortfolioDraftChoice.replace("{name}", () => draftTab.name)
      : !newBlockedByDraft
        ? undefined
        : signedOut || fundable.status === "known"
          ? t.addPortfolioDraftWaiting
          : fundable.status === "loading"
            ? t.draftCheckingBalance
            : t.myAccountBalanceUnreadable;
  // Nothing left to say (the draft discarded elsewhere): a window closes, and does not come back
  // unasked with the next draft.
  const windowNeeded = newWindowMessage !== undefined;
  const windowStale =
    (modal.type === "new-window" && !windowNeeded) || (modal.type === "delete-draft" && !draftTab);
  useEffect(() => {
    if (windowStale) setModal({ type: "none" });
  }, [windowStale]);
  const newButtonProps = {
    onClick: () => (windowNeeded ? setModal({ type: "new-window" }) : onNewPortfolio?.()),
    "aria-haspopup": windowNeeded ? ("dialog" as const) : undefined,
    "aria-describedby": windowNeeded ? "portfolio-tabs-new-blocked" : undefined,
  };
  const accountValue = values ? (values.fundingUsd === null ? "—" : formatUsd(values.fundingUsd)) : null;
  const selectDot = !miCuentaActive && !draftActive && activePortfolio ? portfolioColor(activePortfolio.id).dot : null;
  const selectPortfolio = (portfolioId: string) => {
    if (onPortfolioTabSelect) onPortfolioTabSelect(portfolioId);
    else setActivePortfolioId(portfolioId);
  };

  // D-318: the portfolios scroll in their own strip, between My Account and "+", with our
  // arrows and fades instead of the native bar. Each arrow shows only when there is more
  // on its side.
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ left: false, right: false });
  const measureOverflow = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setOverflow((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    measureOverflow();
    el.addEventListener("scroll", measureOverflow, { passive: true });
    // Width, names, language and how many portfolios all change what overflows.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measureOverflow);
    observer?.observe(el);
    for (const child of Array.from(el.children)) observer?.observe(child);
    return () => {
      el.removeEventListener("scroll", measureOverflow);
      observer?.disconnect();
    };
  }, [measureOverflow, portfolios.length, draftTab?.name]);

  const scrollBehavior = (): ScrollBehavior =>
    // Read here, not in render: branching render on it mismatches the server's HTML.
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  const scrollStrip = (direction: -1 | 1) => {
    const el = scrollerRef.current;
    if (el) el.scrollBy({ left: direction * 0.8 * el.clientWidth, behavior: scrollBehavior() });
  };

  // D-421: the strip's width, so the effect below runs again when the window shrinks after load.
  const [stripWidth, setStripWidth] = useState(0);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setStripWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // The tab on screen is brought into the strip (on load with 16 portfolios it may sit past
  // the edge). By hand, not `scrollIntoView`: that also scrolls the page vertically. The
  // margin keeps it clear of the fade.
  useEffect(() => {
    if (miCuentaActive) return;
    const el = scrollerRef.current;
    const selected = el?.querySelector('[role="tab"][aria-selected="true"]');
    // The whole tab (name + its "···"), which is the strip's direct child.
    const tab = el && selected ? Array.from(el.children).find((child) => child.contains(selected)) : undefined;
    // Zero width: the strip is not laid out (hidden under `sm`, where the select stands in).
    if (!el || !tab || el.clientWidth === 0) return;
    const margin = 56;
    const tabLeft = tab.getBoundingClientRect().left - el.getBoundingClientRect().left + el.scrollLeft;
    const tabRight = tabLeft + tab.getBoundingClientRect().width;
    let target: number | null = null;
    if (tabLeft - margin < el.scrollLeft) target = tabLeft - margin;
    else if (tabRight + margin > el.scrollLeft + el.clientWidth) target = tabRight + margin - el.clientWidth;
    if (target !== null) el.scrollTo({ left: Math.max(0, target), behavior: scrollBehavior() });
  }, [miCuentaActive, activePortfolioId, draftActive, portfolios.length, stripWidth]);

  // The section menu sticks right under this strip (D-562), so it needs the strip's real height:
  // two rows under `sm`, one above, and it changes with the font. Same pattern as the header's.
  const stripRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = stripRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const root = document.documentElement;
    const observer = new ResizeObserver(() => {
      root.style.setProperty("--portfolio-strip-h", `${el.offsetHeight}px`);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--portfolio-strip-h");
    };
  }, []);

  return (
    <>
      {/* Sticky under the header (operator, s224): switching portfolios should not need a
          scroll back up. Below the header's z-40, so its wallet menu still opens over it;
          opaque, so the page scrolling beneath does not show through. No backdrop-blur: a
          filter makes this the containing block of the tab menu's `position: fixed`, and the
          menu would open offset. */}
      <div ref={stripRef} className="sticky top-[var(--dashboard-header-h,0px)] z-30 border-b border-slate-800 bg-slate-950">
        <div className="mx-auto flex max-w-7xl items-center gap-2 overflow-visible px-4 py-2 sm:px-6">
          {/* Desktop: My Account fixed | portfolios that scroll | "+" fixed (D-318) */}
          <div
            role="tablist"
            aria-label={t.portfolioTabsLabel}
            // Not `flex-1`: sized to its tabs, so "+" follows the last one, and shrinks (then
            // scrolls) only when they do not fit — that is when "+" ends up at the right edge.
            className="hidden min-w-0 items-stretch sm:flex"
          >
            {onMiCuentaClick && (
              <>
                {/* D-561: an anchor of its own, told apart from the portfolios by its shape: a solid
                    surface and an icon chip, even when not selected. Cyan is free for it because
                    portfolio colors leave cyan out (portfolio-color.ts). */}
                <button
                  type="button"
                  role="tab"
                  aria-selected={miCuentaActive}
                  // D-360: where the focus lands when the draft's tab it was on is discarded.
                  data-focus-landing={miCuentaActive ? "" : undefined}
                  onClick={onMiCuentaClick}
                  className={`relative flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-2xl border py-1 pl-2 pr-4 text-left text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 ${
                    miCuentaActive
                      ? "border-cyan-400/60 bg-cyan-400/15 text-cyan-200"
                      : "border-slate-700 bg-surface text-slate-100 hover:border-cyan-400/40"
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${
                      miCuentaActive ? "bg-cyan-400/20 text-cyan-200" : "bg-cyan-400/10 text-cyan-300"
                    }`}
                  >
                    <Wallet className="h-4 w-4" />
                  </span>
                  <span className="flex flex-col items-start">
                    <span>{t.myAccountTab}</span>
                    {/* The space keeps a screen reader from hearing "Funding$12.00"; between flex
                        items it takes no room on screen. */}
                    {accountValue !== null && " "}
                    {accountValue !== null && (
                      <span
                        className={`text-xs font-normal tabular-nums ${miCuentaActive ? "text-cyan-100/80" : "text-slate-300"}`}
                      >
                        {accountValue}
                      </span>
                    )}
                  </span>
                  {miCuentaBadge && (
                    <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-cyan-400" />
                  )}
                </button>
                {/* Apart from the portfolios: Funding is not one more of them. With no portfolio on
                    its right, "+" already keeps its own distance from the line. */}
                <div
                  aria-hidden="true"
                  className={`ml-4 h-7 w-px shrink-0 self-center bg-slate-700 ${hasSelectOptions ? "mr-4" : ""}`}
                />
              </>
            )}
            <div className="relative min-w-0">
              {/* Not a tab stop: Tab already walks every tab, and the browser scrolls the
                  focused one into sight (`scroll-px-14` keeps it clear of the fades). */}
              <div ref={scrollerRef} className="scrollbar-none flex scroll-px-14 items-center gap-1 overflow-x-auto">
                {portfolios.map((portfolio) => {
                  // Not on My Account and not on the draft's tab: then no portfolio is on screen.
                  const isActive = !miCuentaActive && !draftActive && portfolio.id === activePortfolioId;
                  const value = values?.byPortfolio.get(portfolio.id);
                  return (
                    <div key={portfolio.id} className="relative flex shrink-0 items-center">
                      {/* 021 R5: the name always in the portfolio's color, so the active tab is
                          told by its card (a level up, with an edge), not by its text. */}
                      <div
                        className={`flex items-center gap-1.5 rounded-xl transition ${
                          isActive ? "bg-card ring-1 ring-inset ring-slate-600" : "hover:bg-surface"
                        }`}
                      >
                        <button
                          type="button"
                          role="tab"
                          aria-selected={isActive}
                          // D-360: a new portfolio replaces the button that opened its creation.
                          data-focus-landing={isActive ? "" : undefined}
                          onClick={() => selectPortfolio(portfolio.id)}
                          title={portfolio.name}
                          className={`flex max-w-[14rem] flex-col items-start pl-3 text-left text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 ${
                            value !== undefined ? "py-1" : "py-1.5"
                          }`}
                        >
                          <span className={`max-w-full truncate font-medium ${portfolioColor(portfolio.id).text}`}>
                            {portfolio.name}
                          </span>
                          {value !== undefined && " "}
                          {value !== undefined && (
                            <span className={`text-xs tabular-nums ${isActive ? "text-slate-200" : "text-slate-400"}`}>
                              {formatUsd(value)}
                            </span>
                          )}
                        </button>
                        <div className="pr-1.5">
                          <PortfolioTabMenu
                            portfolioId={portfolio.id}
                            portfolioName={portfolio.name}
                            onRename={() =>
                              setModal({
                                type: "rename",
                                portfolioId: portfolio.id,
                                currentName: portfolio.name,
                              })
                            }
                            onDelete={() => setModal({ type: "delete", portfolioId: portfolio.id })}
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
                {draftTab && (
                  <div
                    className={`flex shrink-0 items-center gap-1.5 rounded-xl pr-1.5 transition ${
                      draftActive ? "bg-card ring-1 ring-inset ring-slate-600" : "hover:bg-surface"
                    }`}
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={draftActive}
                      // D-360: a saved draft replaces the button that opened the editor.
                      data-focus-landing={draftActive ? "" : undefined}
                      onClick={draftTab.onSelect}
                      title={draftTab.name}
                      className={`max-w-[14rem] truncate whitespace-nowrap py-1.5 pl-3 text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 ${
                        draftActive ? "text-white" : "text-slate-400 hover:text-slate-100"
                      }`}
                    >
                      {draftTab.name}
                    </button>
                    <span className="rounded-md border border-slate-600 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                      {t.draftTabBadge}
                    </span>
                    {/* 022-G (D-458): Rename. D-560: Delete too, as on a portfolio; the view keeps its button. */}
                    <PortfolioTabMenu
                      portfolioId={DRAFT_OPTION}
                      portfolioName={draftTab.name}
                      onRename={() => setModal({ type: "rename-draft" })}
                      onDelete={() => setModal({ type: "delete-draft" })}
                      deleteLabel={t.draftCardDiscard}
                    />
                  </div>
                )}
              </div>
              {overflow.left && (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-0 left-0 flex w-14 items-center bg-gradient-to-r from-slate-950 from-50% to-transparent"
                >
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => scrollStrip(-1)}
                    className="pointer-events-auto inline-flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-800 hover:text-slate-100"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                </div>
              )}
              {overflow.right && (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-0 right-0 flex w-14 items-center justify-end bg-gradient-to-l from-slate-950 from-50% to-transparent"
                >
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => scrollStrip(1)}
                    className="pointer-events-auto inline-flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-800 hover:text-slate-100"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              )}
            </div>
          </div>
          {/* Outside the tablist (it is not a tab) and outside the strip, so it never scrolls
              away. Labelled at every width (D-419). */}
          <button
            type="button"
            {...newButtonProps}
            className={`ml-2 hidden h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-lg border border-dashed border-slate-700 px-2 text-sm text-slate-400 transition hover:border-slate-500 hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 sm:inline-flex ${
              newBlocked ? "opacity-60" : ""
            }`}
          >
            <Plus aria-hidden="true" className="h-4 w-4" />
            {t.addPortfolio}
          </button>

          {/* Mobile (D-419 + 017-8): two rows. One row left the select ~75 px at 360 px next to
              "+ New portfolio", and the active portfolio read «C…». */}
          {/* `min-w-0` here for the same reason as on the <select> below: this column is itself
              a flex item, so without it `flex-1` cannot shrink it under its intrinsic width. */}
          <div className="flex min-w-0 flex-1 flex-col gap-2 sm:hidden">
            <div className="flex items-center gap-2">
              {onMiCuentaClick && (
                <button
                  type="button"
                  aria-pressed={miCuentaActive}
                  data-focus-landing={miCuentaActive ? "" : undefined}
                  onClick={onMiCuentaClick}
                  className={`relative inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-xl border pl-1.5 pr-3 text-xs font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 ${
                    miCuentaActive
                      ? "border-cyan-400/60 bg-cyan-400/15 text-cyan-200"
                      : "border-slate-700 bg-surface text-slate-100 hover:border-cyan-400/40"
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg ${
                      miCuentaActive ? "bg-cyan-400/20 text-cyan-200" : "bg-cyan-400/10 text-cyan-300"
                    }`}
                  >
                    <Wallet className="h-3.5 w-3.5" />
                  </span>
                  {t.myAccountTab}
                  {miCuentaBadge && (
                    <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-cyan-400" />
                  )}
                </button>
              )}
              {/* D-476: no hover on a phone, so at the cap the reason replaces "+" as plain text. */}
              {newBlockedByCap ? (
                <span className="whitespace-nowrap text-xs text-slate-500">
                  {t.addPortfolioCapShort.replace("{max}", String(portfolioCap))}
                </span>
              ) : (
                <button
                  type="button"
                  {...newButtonProps}
                  className={`inline-flex h-9 shrink-0 items-center gap-1 whitespace-nowrap rounded-xl border border-dashed border-slate-700 px-2.5 text-xs text-slate-400 transition hover:border-slate-500 hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 ${
                    newBlocked ? "opacity-60" : ""
                  }`}
                >
                  <span aria-hidden="true">+</span>
                  {t.addPortfolio}
                </button>
              )}
            </div>
            {/* Nothing to pick with no portfolio and no draft: an empty select would only take room. */}
            {hasSelectOptions && (
              <div className="flex min-w-0 items-center gap-2">
                <label htmlFor="portfolio-tabs-select" className="sr-only">
                  {t.selectPortfolio}
                </label>
                {/* D-355: on My Account no portfolio is the one on screen — the desktop strip selects
                    no tab — so the select shows a placeholder and picking ANY portfolio, the active
                    one included, is a change that goes there. With the active one preselected, a
                    native select fires no change for it, and an account with one portfolio had no
                    way back from My Account on mobile. */}
                {/* 021 R5: an <option> takes no color, so on mobile the portfolio's color is only
                    this dot, for the one on screen (the mobile rule: no more than that here). */}
                <div className="relative flex min-w-0 flex-1">
                  {selectDot && (
                    <span
                      aria-hidden="true"
                      className={`pointer-events-none absolute left-3 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full ${selectDot}`}
                    />
                  )}
                  <select
                    id="portfolio-tabs-select"
                    // D-360: the mobile counterpart of the active tab's landing.
                    data-focus-landing={miCuentaActive ? undefined : ""}
                    value={miCuentaActive ? "" : draftActive ? DRAFT_OPTION : (activePortfolioId ?? undefined)}
                    onChange={(event) => {
                      if (event.target.value === DRAFT_OPTION) draftTab?.onSelect();
                      else selectPortfolio(event.target.value);
                    }}
                    // `min-w-0` + `truncate`: a native <select> sizes itself to the WIDEST option,
                    // and a flex item defaults to `min-width: auto`, so `flex-1` alone could not
                    // shrink it. One long portfolio name pushed the header past the viewport and
                    // gave the whole page a horizontal scroll (mobile QA, 008 Fase 2).
                    className={`min-w-0 flex-1 truncate rounded-xl border border-slate-700 bg-slate-900 py-2 pr-3 text-sm text-slate-100 focus:border-cyan-300 focus:outline-none ${
                      selectDot ? "pl-7" : "pl-3"
                    }`}
                  >
                    {miCuentaActive && (
                      <option value="" disabled hidden>
                        {t.choosePortfolio}
                      </option>
                    )}
                    {portfolios.map((portfolio) => (
                      <option key={portfolio.id} value={portfolio.id}>
                        {portfolio.name}
                      </option>
                    ))}
                    {draftTab && (
                      <option value={DRAFT_OPTION}>
                        {`${draftTab.name} · ${t.draftTabBadge}`}
                      </option>
                    )}
                  </select>
                </div>
                {/* The menu acts on what the select shows: on the draft's tab it renames the
                    draft (022-G). On My Account the select shows no portfolio, so there is no menu
                    (D-461): a ⋯ beside "Choose a portfolio" acted on a portfolio not on screen. */}
                {draftActive && draftTab ? (
                  <PortfolioTabMenu
                    portfolioId={DRAFT_OPTION}
                    portfolioName={draftTab.name}
                    onRename={() => setModal({ type: "rename-draft" })}
                    onDelete={() => setModal({ type: "delete-draft" })}
                    deleteLabel={t.draftCardDiscard}
                  />
                ) : !miCuentaActive && activePortfolio && (
                  <PortfolioTabMenu
                    portfolioId={activePortfolio.id}
                    portfolioName={activePortfolio.name}
                    onRename={() =>
                      setModal({
                        type: "rename",
                        portfolioId: activePortfolio.id,
                        currentName: activePortfolio.name,
                      })
                    }
                    onDelete={() => setModal({ type: "delete", portfolioId: activePortfolio.id })}
                  />
                )}
              </div>
            )}
          </div>
        </div>
        {/* What a screen reader hears with "+" while it waits; the window says it again. */}
        {newWindowMessage ? (
          <span id="portfolio-tabs-new-blocked" className="sr-only">
            {newWindowMessage}
          </span>
        ) : null}
      </div>

      {modal.type === "new-window" && newWindowMessage && (
        <Modal titleId="portfolio-tabs-new-blocked-title" onClose={() => setModal({ type: "none" })}>
          <h2 id="portfolio-tabs-new-blocked-title" className="text-lg font-semibold text-slate-100">
            {t.addPortfolio}
          </h2>
          <p className="mt-2 text-sm text-slate-300">{newWindowMessage}</p>
          <div className="mt-6 flex flex-wrap justify-end gap-3">
            <button
              type="button"
              onClick={() => setModal({ type: "none" })}
              className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-200 transition hover:border-slate-500 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
            >
              {t.addPortfolioBlockedClose}
            </button>
            {!newBlockedByCap && draftTab ? (
              <button
                type="button"
                onClick={() => {
                  setModal({ type: "none" });
                  draftTab.onSelect();
                }}
                // The new portfolio is what "+" asked for, so it takes the main button when offered.
                className={
                  offersNewBesideDraft
                    ? "rounded-xl border border-cyan-300/30 bg-cyan-300/5 px-4 py-2 text-sm text-cyan-200 transition hover:bg-cyan-300/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
                    : "rounded-xl bg-cyan-300 px-5 py-2 text-sm font-semibold text-black transition hover:bg-cyan-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
                }
              >
                {t.addPortfolioBlockedGoTo.replace("{name}", () => draftTab.name)}
              </button>
            ) : null}
            {offersNewBesideDraft ? (
              <button
                type="button"
                onClick={() => {
                  setModal({ type: "none" });
                  onNewPortfolio?.();
                }}
                className="rounded-xl bg-cyan-300 px-5 py-2 text-sm font-semibold text-black transition hover:bg-cyan-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
              >
                {t.addPortfolioBuildNew}
              </button>
            ) : null}
          </div>
        </Modal>
      )}
      {modal.type === "rename" && (
        <PortfolioRenameModal
          portfolioId={modal.portfolioId}
          currentName={modal.currentName}
          existingNames={existingNames}
          onClose={() => setModal({ type: "none" })}
        />
      )}
      {modal.type === "delete" && (
        <PortfolioDeleteModal portfolioId={modal.portfolioId} onClose={() => setModal({ type: "none" })} />
      )}
      {modal.type === "delete-draft" && draftTab && (
        <Modal titleId="portfolio-tabs-delete-draft-title" onClose={() => setModal({ type: "none" })}>
          <h2 id="portfolio-tabs-delete-draft-title" className="text-lg font-semibold text-slate-100">
            {t.portfolioDeleteTitle.replace("{name}", () => draftTab.name)}
          </h2>
          {/* The same question as the button in the draft's view. */}
          <p className="mt-2 text-sm text-slate-300">
            {canCreateBesideDraft ? t.draftReadyDiscardQuestion : t.draftCardDiscardQuestion}
          </p>
          <div className="mt-6 flex flex-wrap justify-end gap-3">
            <button
              type="button"
              onClick={() => setModal({ type: "none" })}
              className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-200 transition hover:border-slate-500 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
            >
              {t.cancel}
            </button>
            <button
              type="button"
              onClick={() => {
                setModal({ type: "none" });
                draftTab.discard();
              }}
              className="rounded-xl bg-rose-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-rose-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/60"
            >
              {t.portfolioDeleteConfirmAction}
            </button>
          </div>
        </Modal>
      )}
      {modal.type === "rename-draft" && draftTab && (
        <PortfolioRenameModal
          currentName={draftTab.name}
          existingNames={draftExistingNames}
          onSave={(name) => draftTab.rename(name, draftExistingNames)}
          onClose={() => setModal({ type: "none" })}
        />
      )}
    </>
  );
}
