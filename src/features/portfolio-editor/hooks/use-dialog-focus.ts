"use client";

import { useEffect, useRef, type RefObject } from "react";

// 017-5 (D-309 + D-360): one focus policy for every dialog — `Modal` and the two sheets that
// build their own (`receive-modal`, `withdrawal-modal`).

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Marks an element that can take the focus when the control that had it is gone (D-360): the
 * card that replaces the button that opened a dialog, or the entry that comes back when the card
 * is discarded. The first one in document order that takes the focus wins — a hidden one (the
 * desktop tabs at phone width) does not.
 */
export const FOCUS_LANDING_ATTR = "data-focus-landing";

// Open dialogs, innermost last. Only the top one answers Escape and keeps Tab: a dialog opened
// from another must not close both on one Escape, nor fight it for the focus.
const openDialogs: symbol[] = [];

function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.closest("fieldset:disabled"));
}

function focusLandingNow(): boolean {
  for (const landing of document.querySelectorAll<HTMLElement>(`[${FOCUS_LANDING_ATTR}]`)) {
    landing.focus();
    if (document.activeElement === landing) return true;
  }
  return false;
}

function focusIsLost(): boolean {
  return document.activeElement === null || document.activeElement === document.body;
}

/**
 * Moves the focus to the landing, if it has nowhere else to be. Tried at once, and again on the
 * next frame for a landing that mounts in a later commit than the removal that lost the focus.
 */
export function focusLandingIfLost(): void {
  if (!focusIsLost() || focusLandingNow()) return;
  requestAnimationFrame(() => {
    if (focusIsLost()) focusLandingNow();
  });
}

type DialogFocusOptions = {
  /** False while the dialog is closed, for the dialogs that stay mounted. */
  active?: boolean;
  /** Escape. Pass a no-op to ignore it (a signature in flight). */
  onEscape: () => void;
  /** Where the focus goes on open. Defaults to the first focusable control. */
  initialFocusRef?: RefObject<HTMLElement | null>;
};

/**
 * Focus on open, Tab kept inside, Escape, and the focus handed back on close — to the control
 * that opened the dialog, or to the landing when that control is gone (D-360).
 *
 * Runs once per open, deliberately: tying it to `onEscape` identity would re-focus the top
 * control on every parent re-render (price or deposit polling recreating an inline handler),
 * yanking the scroll back to the top while the user is reading lower content.
 */
export function useDialogFocus(
  dialogRef: RefObject<HTMLElement | null>,
  { active = true, onEscape, initialFocusRef }: DialogFocusOptions
): void {
  // Escape always reads the latest handler, so a guard that flips mid-open (signing) holds.
  const onEscapeRef = useRef(onEscape);
  useEffect(() => {
    onEscapeRef.current = onEscape;
  });

  useEffect(() => {
    if (!active) return;
    const id = Symbol("dialog");
    openDialogs.push(id);
    const previouslyFocused = document.activeElement;

    const dialog = dialogRef.current;
    const initial = initialFocusRef?.current ?? (dialog ? focusableIn(dialog)[0] : undefined);
    initial?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (openDialogs[openDialogs.length - 1] !== id) return;
      if (event.key === "Escape") {
        event.stopPropagation();
        onEscapeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const items = focusableIn(root);
      const current = document.activeElement;
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      // Focus outside the dialog — on `<body>` after the focused button was disabled for a
      // signature, say — comes back in instead of walking the page behind the overlay.
      if (!root.contains(current)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && (current === first || current === root)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      openDialogs.splice(openDialogs.indexOf(id), 1);
      if (previouslyFocused instanceof HTMLElement && previouslyFocused !== document.body && previouslyFocused.isConnected) {
        previouslyFocused.focus();
        if (document.activeElement === previouslyFocused) return;
      }
      // The opener is gone, or was already gone when the dialog opened (a menu item: the menu
      // closes in the same render the dialog opens), or it opened on arrival with nothing focused.
      focusLandingIfLost();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}
