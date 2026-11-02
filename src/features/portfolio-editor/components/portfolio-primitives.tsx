"use client";

import { useRef, useState, type ReactNode, type RefObject } from "react";
import { useDialogFocus } from "../hooks/use-dialog-focus";

type ModalProps = {
  titleId: string;
  onClose: () => void;
  children: ReactNode;
  maxWidth?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
  /**
   * False hands Tab and Escape to a dialog this one does not own — a wallet's own modal,
   * opened over this one while it connects (019-1). The dialog stays on screen behind it.
   */
  trapFocus?: boolean;
};

export function Modal({
  titleId,
  onClose,
  children,
  maxWidth = "max-w-md",
  initialFocusRef,
  trapFocus = true,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, { active: trapFocus, onEscape: onClose, initialFocusRef });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal={trapFocus}
        aria-labelledby={titleId}
        className={`max-h-[calc(100vh-2rem)] w-full overflow-y-auto ${maxWidth} rounded-3xl border border-slate-700 bg-slate-950 p-6 shadow-2xl`}
        style={{ animation: "modalIn 180ms cubic-bezier(.2,.8,.2,1)" }}
      >
        {children}
      </div>
    </div>
  );
}

export function InfoTooltip({ label, children, width = 256 }: { label: string; children: ReactNode; width?: number }) {
  const [open, setOpen] = useState(false);

  return (
    <span className="relative inline-block">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-slate-700 text-[9px] text-slate-400 transition hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
      >
        ?
      </button>
      <span
        role="tooltip"
        style={{ width }}
        className={`pointer-events-none absolute left-1/2 top-6 z-30 -translate-x-1/2 rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-[11px] leading-relaxed text-slate-200 shadow-2xl transition-opacity duration-150 ${open ? "opacity-100" : "opacity-0"}`}
      >
        {children}
      </span>
    </span>
  );
}

export function SumChip({ totalPct, t }: { totalPct: number; t: Record<string, string> }) {
  const rounded = Math.round(totalPct * 10) / 10;

  if (Math.abs(rounded - 100) < 0.05) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/40 bg-emerald-400/15 px-2.5 py-1 text-[11px] font-medium text-emerald-100">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" />
        {t.sumOk}
      </span>
    );
  }

  if (rounded > 100) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-rose-400/40 bg-rose-400/15 px-2.5 py-1 text-[11px] font-medium text-rose-100">
        <span className="h-1.5 w-1.5 rounded-full bg-rose-300" />
        {t.sumOver} {(rounded - 100).toFixed(1)}%
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/40 bg-amber-400/15 px-2.5 py-1 text-[11px] font-medium text-amber-100">
      <span className="h-1.5 w-1.5 rounded-full bg-amber-300" />
      {t.sumUnder} {(100 - rounded).toFixed(1)}%
    </span>
  );
}

// The quick-fill chips of an amount field (25/50/75 %, Max), in the creation review and in
// "Add tokens" (027-13): outlined so they read as buttons, all four alike. `selected` while the
// field holds exactly that chip's amount — derived on every render, never stored, so typing
// another number or a changed balance clears it instead of leaving a chip that no longer holds.
export function amountChipClass(selected: boolean): string {
  return `h-8 rounded-md border px-2 text-[11px] font-medium tabular-nums transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 sm:h-7 sm:px-1.5 ${
    selected
      ? "border-cyan-300/60 bg-cyan-300/10 text-cyan-200"
      : "border-slate-700 text-slate-300 hover:border-slate-500 hover:text-white"
  }`;
}
