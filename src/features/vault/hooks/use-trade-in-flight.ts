"use client";

// Whether the solver is settling a trade in this portfolio, asked while the confirm-changes
// modal is open (D-471, solver 945 §7). Between a trade's settlement and its reconcile the
// vault has moved the tokens but not booked them to the portfolio; a commit signed then carries
// balances about to change and can hold the reconcile for hours.
//
// Asked on open and while the modal stays open, never in the click: the wallet popup must open
// inside the click's activation window, and nothing may wait between signing and sending.
// Errs open like `useRelayPaused`: no answer, a slow one or an error all read as "go ahead".
//
// Two ceilings keep a wait finite. The server's: 90 s from the trade's `opened`, by the
// database's clock. And this modal's own: 90 s from the first trade it saw, whatever comes
// after — so rows written with the solver's credential cannot hold a portfolio indefinitely by
// opening a new trade every 90 s (945 §11 A2). Reopening the modal starts that count again.

import { useEffect, useRef, useState } from "react";
import { fetchTradeInFlight, type TradeInFlightAnswer } from "../lib/trade-in-flight-client";

/** How often an open modal asks while nothing is settling. */
export const TRADE_POLL_IDLE_MS = 5_000;
/** How often it asks while a trade is settling, so Confirm comes back soon after it closes. */
export const TRADE_POLL_WAITING_MS = 3_000;
/** The longest one modal opening waits, counted from the first trade it saw. */
export const TRADE_MODAL_WAIT_CAP_MS = 90_000;

type Read = (portfolioId: string) => Promise<TradeInFlightAnswer>;

/**
 * Seconds left to wait (≥ 1) while a trade is settling in `portfolioId`, else null.
 *
 * `portfolioId`: the on-chain id of the portfolio this modal would commit to, or null when it
 * would sign nothing on the live vault (or is already signing) — then nothing is asked.
 * `onSettled`: called once each time a wait ends, so the caller re-reads the balances the trade
 * just changed before the user confirms over them.
 */
export function useTradeInFlight(
  portfolioId: string | null,
  onSettled?: () => void,
  read: Read = fetchTradeInFlight
): number | null {
  const [waitUntil, setWaitUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;
  const readRef = useRef(read);
  readRef.current = read;

  useEffect(() => {
    setWaitUntil(null);
    if (portfolioId === null) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let firstSeen: number | null = null;
    let waiting = false;

    const release = () => {
      setWaitUntil(null);
      if (waiting) {
        waiting = false;
        onSettledRef.current?.();
      }
    };

    const poll = async () => {
      const answer = await readRef.current(portfolioId);
      if (cancelled) return;
      const t = Date.now();
      if (!answer.inFlight) {
        release();
        timer = setTimeout(poll, TRADE_POLL_IDLE_MS);
        return;
      }
      firstSeen ??= t;
      const capAt = firstSeen + TRADE_MODAL_WAIT_CAP_MS;
      if (t >= capAt) {
        // This opening has waited all it will: stop asking, let the user go ahead.
        release();
        return;
      }
      waiting = true;
      setNow(t);
      setWaitUntil(Math.min(t + answer.remainingMs, capAt));
      timer = setTimeout(poll, TRADE_POLL_WAITING_MS);
    };

    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [portfolioId]);

  // The countdown ticks locally between answers; the next answer corrects it.
  useEffect(() => {
    if (waitUntil === null) return;
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(tick);
  }, [waitUntil]);

  if (portfolioId === null || waitUntil === null || now >= waitUntil) return null;
  return Math.max(1, Math.ceil((waitUntil - now) / 1_000));
}
