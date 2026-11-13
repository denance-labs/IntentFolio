"use client";

// Announces deposits the Omni Bridge credits directly (ZEC), which the PoA poller never sees.
// See omni-deposit-watch.ts for why the source is the account history and why it only runs
// while Receive has marked a deposit as expected.

import { useEffect, useRef } from "react";
import { loadNotifiedDeposits, markDepositNotified } from "../lib/credited-deposits-store";
import {
  omniDepositExpectedSince,
  pickNewOmniDeposits,
  type HistoryEventLike,
  type OmniCreditedDeposit,
} from "../lib/omni-deposit-watch";

/** Same cadence as the PoA poller (use-recent-deposits.ts). */
const POLL_INTERVAL_MS = 15_000;

export function useOmniDepositWatch({
  intentsAccountId,
  onCredited,
  fetchImpl,
}: {
  intentsAccountId: string;
  onCredited: (deposit: OmniCreditedDeposit) => void;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}): void {
  const onCreditedRef = useRef(onCredited);
  onCreditedRef.current = onCredited;

  useEffect(() => {
    if (!intentsAccountId) return;
    const doFetch = fetchImpl ?? fetch;
    // Seeded from the durable store so a reload never re-announces (D-265).
    const announced = loadNotifiedDeposits(intentsAccountId);
    let cancelled = false;
    let inFlight = false;

    const tick = async () => {
      if (inFlight || cancelled) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      const since = omniDepositExpectedSince(intentsAccountId);
      if (since === null) return;
      inFlight = true;
      try {
        const res = await doFetch(
          `/api/history/account?account=${encodeURIComponent(intentsAccountId)}`,
          { cache: "no-store" }
        );
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as { events?: HistoryEventLike[] };
        if (cancelled || !Array.isArray(body.events)) return;
        for (const deposit of pickNewOmniDeposits(body.events, since, announced)) {
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
