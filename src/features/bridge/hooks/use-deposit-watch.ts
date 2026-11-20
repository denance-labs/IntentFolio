"use client";

// Announces a deposit made through Receive once the account's history shows it. See
// deposit-watch.ts for why the source is the history and why it only runs while Receive has marked
// a deposit as expected.

import { useEffect, useRef } from "react";
import { loadNotifiedDeposits, markDepositNotified } from "../lib/credited-deposits-store";
import { depositExpectedSince, fetchHistoryEvents, pickNewDeposits, type CreditedDeposit } from "../lib/deposit-watch";

const POLL_INTERVAL_MS = 15_000;

export function useDepositWatch({
  intentsAccountId,
  onCredited,
  fetchImpl,
}: {
  intentsAccountId: string;
  onCredited: (deposit: CreditedDeposit) => void;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}): void {
  const onCreditedRef = useRef(onCredited);
  onCreditedRef.current = onCredited;

  useEffect(() => {
    if (!intentsAccountId) return;
    // Seeded from the durable store so a reload never re-announces (D-265).
    const announced = loadNotifiedDeposits(intentsAccountId);
    let cancelled = false;
    let inFlight = false;

    const tick = async () => {
      if (inFlight || cancelled) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      const since = depositExpectedSince(intentsAccountId);
      if (since === null) return;
      inFlight = true;
      try {
        const events = await fetchHistoryEvents(intentsAccountId, fetchImpl ?? fetch);
        if (cancelled || events === null) return;
        for (const deposit of pickNewDeposits(events, since, announced)) {
          announced.add(deposit.key);
          markDepositNotified(intentsAccountId, deposit.key);
          onCreditedRef.current(deposit);
        }
      } catch {
        // A failed read is a missed tick; the next one asks again.
      } finally {
        inFlight = false;
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [intentsAccountId, fetchImpl]);
}
