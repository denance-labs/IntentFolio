"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLanguage } from "../context/language-context";
import { shellTranslations } from "../lib/translations";

type PortfolioTabMenuProps = {
  portfolioId: string;
  portfolioName: string;
  disabled?: boolean;
  disabledTitle?: string;
  onRename: () => void;
  /** 027 A-9a for a portfolio; D-560 for the New Portfolio Draft, which also keeps the button in its view. */
  onDelete?: () => void;
  /** What the delete item says. By default, a portfolio's. */
  deleteLabel?: string;
};

export function PortfolioTabMenu({
  portfolioId: _portfolioId, // eslint-disable-line @typescript-eslint/no-unused-vars
  portfolioName,
  disabled = false,
  disabledTitle,
  onRename,
  onDelete,
  deleteLabel,
}: PortfolioTabMenuProps) {
  const { lang } = useLanguage();
  const t = shellTranslations[lang];
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Calculate fixed position when opening.
  useLayoutEffect(() => {
    if (isOpen && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 4, left: rect.right });
    }
  }, [isOpen]);

  // Close on click outside or Escape.
  useEffect(() => {
    if (!isOpen) return;
    function handleClick(e: MouseEvent) {
      const insideTrigger = triggerRef.current?.contains(e.target as Node);
      const insideMenu = menuRef.current?.contains(e.target as Node);
      if (!insideTrigger && !insideMenu) setIsOpen(false);
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setIsOpen(false);
    }
    // D-318: the menu is placed once, on open. Scrolling the tab strip or the page (or a
    // resize) would leave it floating away from its tab, so it closes instead. Capture
    // catches the strip's own scroll, which does not bubble to window.
    function handleMove() {
      setIsOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    window.addEventListener("scroll", handleMove, { capture: true, passive: true });
    window.addEventListener("resize", handleMove);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
      window.removeEventListener("scroll", handleMove, { capture: true });
      window.removeEventListener("resize", handleMove);
    };
  }, [isOpen]);

  function handleRename() {
    setIsOpen(false);
    onRename();
  }

  function handleDelete() {
    setIsOpen(false);
    onDelete?.();
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={`${t.portfolioMenuLabel} ${portfolioName}`}
        aria-expanded={disabled ? undefined : isOpen}
        aria-haspopup={disabled ? undefined : "menu"}
        aria-disabled={disabled || undefined}
        title={disabled ? disabledTitle : undefined}
        onClick={(e) => {
          e.stopPropagation();
          if (!disabled) setIsOpen((prev) => !prev);
        }}
        className={`flex h-5 w-5 items-center justify-center rounded text-slate-400 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 ${
          disabled ? "cursor-not-allowed opacity-30" : "cursor-pointer hover:bg-slate-700 hover:text-slate-100"
        }`}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
        >
          <circle cx="5" cy="12" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="19" cy="12" r="2" />
        </svg>
      </button>

      {isOpen && pos && (
        <div
          role="menu"
          style={{ position: "fixed", top: pos.top, left: pos.left, transform: "translateX(-100%)" }}
          ref={menuRef}
          className="z-[200] min-w-[140px] rounded-xl border border-slate-700 bg-slate-900 py-1 shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={handleRename}
            className="w-full px-3 py-2 text-left text-sm text-slate-200 transition hover:bg-slate-800 hover:text-white focus:outline-none focus-visible:bg-slate-800"
          >
            {t.portfolioRenameMenuItem}
          </button>
          {onDelete && (
            <button
              type="button"
              role="menuitem"
              onClick={handleDelete}
              className="w-full whitespace-nowrap px-3 py-2 text-left text-sm text-rose-300 transition hover:bg-slate-800 hover:text-rose-200 focus:outline-none focus-visible:bg-slate-800"
            >
              {deleteLabel ?? t.portfolioDelete}
            </button>
          )}
        </div>
      )}
    </>
  );
}
