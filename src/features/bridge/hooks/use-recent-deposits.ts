"use client";

// Attribution: see ATTRIBUTIONS.md #4 (polling uses bridge-client adapter over @defuse-protocol/internal-utils)

import { useCallback, useEffect, useRef, useState } from "react";
import { getDepositStatus, type DepositStatusEntry } from "../lib/bridge-client";
import { isDepositCredited } from "../lib/deposit-status";
import {
  hasDepositBaseline,
  loadNotifiedDeposits,
  markDepositBaseline,
  markDepositsNotified,
} from "../lib/credited-deposits-store";

const POLL_INTERVAL_MS = 15_000;

export function useRecentDeposits({
  intentsAccountId,
  onCredited,
}: {
  intentsAccountId: string;
  onCredited: (deposit: DepositStatusEntry) => void;
}): {
  deposits: DepositStatusEntry[];
  isPolling: boolean;
} {
  const [deposits, setDeposits] = useState<DepositStatusEntry[]>([]);
  const [isPolling, setIsPolling] = useState(false);
  const creditedRef = useRef(new Set<string>());
  // D-475: false until this browser has a starting point for the current account. Kept in memory
  // as well as in storage so a browser that cannot write localStorage still announces arrivals
  // after its first read instead of re-baselining on every poll.
  const baselinedRef = useRef(false);
  const isFocusedRef = useRef(typeof document !== "undefined" ? document.hasFocus() : true);
  const onCreditedRef = useRef(onCredited);
  onCreditedRef.current = onCredited;

  // The account this hook is currently showing. Read by in-flight polls on return, so a
  // response for a previous account cannot paint over the current one.
  const accountRef = useRef(intentsAccountId);

  const doPoll = useCallback(async () => {
    const account = intentsAccountId;
    if (!account || !isFocusedRef.current) return;
    try {
      const result = await getDepositStatus(account);
      // The identity can change while this request is in flight (switching accounts inside
      // the wallet extension does it without any click in our UI). Landing this response
      // would show one account's transactions under another account's name.
      if (accountRef.current !== account) return;
      setDeposits(result.deposits);
      // The first successful read for an account this browser never saw is the baseline (D-475):
      // whatever is already COMPLETED is recorded as notified without a toast. Taken only on a
      // successful read, so a failing bridge does not leave a later arrival inside the baseline.
      const isBaseline = !baselinedRef.current;
      const listedKeys: string[] = [];
      for (const deposit of result.deposits) {
        if (isDepositCredited(deposit.status)) {
          const key = `${deposit.tx_hash}:${deposit.chain}`;
          listedKeys.push(key);
          if (!creditedRef.current.has(key)) {
            creditedRef.current.add(key);
            if (!isBaseline) onCreditedRef.current(deposit);
          }
        }
      }
      // Every listed one, not only the new ones: refreshing their time keeps a deposit the bridge
      // still lists from aging out of the store and toasting again a month later.
      markDepositsNotified(account, listedKeys);
      if (isBaseline) {
        baselinedRef.current = true;
        markDepositBaseline(account);
      }
    } catch {
      // polling failures are silent — user already has the deposit address
    }
  }, [intentsAccountId]);

  useEffect(() => {
    // Drop the previous account's data BEFORE anything can render it under the new identity.
    //
    // This used to be missing entirely, and the failure was observed on 2026-08-06 (008.plan
    // F4.2): after switching to a second Backpack account, IntentFolio showed the FIRST
    // account's two deposits under the second account's name. `deposits` is component state
    // that only ever moved forward on a SUCCESSFUL poll, and the catch below is silent — so a
    // failing `deposit_status` (the bridge answered `Internal server error` during that same
    // session) left the other account's history on screen indefinitely, not just briefly.
    //
    // `creditedRef` is reseeded (not just cleared) for the same reason: it suppresses duplicate
    // "credited" toasts by tx hash, and a hash seen under the previous account would silence a
    // real notification for this one. It is reseeded from the persisted per-account store
    // (D-265) rather than reset to empty, because this effect also runs on a plain reload/remount
    // with the SAME account — dashboard-shell.tsx passes `intentsAccountId: loginConnected ?
    // intentsAccountId : ""`, and `loginConnected` starts false and flips true once wallet-session
    // restore resolves, so this identity-change reset fires on basically every page load. An
    // empty in-memory Set at that point made every already-COMPLETED deposit look unseen and
    // re-fire its toast, however old. Seeding from localStorage keeps "notified" durable across
    // reloads. An account this browser has never seen starts from a silent baseline instead of
    // an empty set (D-475, see doPoll).
    accountRef.current = intentsAccountId;
    setDeposits([]);
    creditedRef.current = loadNotifiedDeposits(intentsAccountId);
    baselinedRef.current = hasDepositBaseline(intentsAccountId);

    if (!intentsAccountId) return;

    const handleFocus = () => {
      isFocusedRef.current = true;
      setIsPolling(true);
      void doPoll();
    };
    const handleBlur = () => {
      isFocusedRef.current = false;
      setIsPolling(false);
    };

    window.addEventListener("focus", handleFocus);
    window.addEventListener("blur", handleBlur);

    setIsPolling(true);
    void doPoll();

    const interval = setInterval(() => {
      if (isFocusedRef.current) void doPoll();
    }, POLL_INTERVAL_MS);

    return () => {
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("blur", handleBlur);
      clearInterval(interval);
    };
  }, [intentsAccountId, doPoll]);

  return { deposits, isPolling };
}
