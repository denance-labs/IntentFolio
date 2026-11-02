"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccountHistory } from "@/features/vault/hooks/use-real-portfolio-history";
import {
  getAssignFundsPromptSeenAt,
  latestDepositTs,
  markAssignFundsPromptSeen,
  shouldOfferAssignFunds,
} from "../lib/assign-funds-prompt";

/**
 * 029 B-23 — whether the "you have funds to assign" window is open for `subject` (the draft, or
 * a portfolio id) while it is on screen and `eligible`. The caller decides eligibility; this
 * keeps it to once per subject, back only after a new deposit (`assign-funds-prompt.ts`).
 *
 * It opens when the offer becomes true — on arriving, or when new data arrives (the history and
 * the balance are read again when the browser window regains focus, so a deposit made on another
 * device brings it without a reload). If another window is open at that instant it stays shut:
 * it never waits to pop up after the user closes something else.
 */
export function useAssignFundsPrompt(accountId: string | null, subject: string | null, eligible: boolean) {
  // Bumped on every answer, so the stored mark is read again.
  const [answers, setAnswers] = useState(0);
  const seenAt = useMemo(() => {
    void answers;
    return accountId && subject ? getAssignFundsPromptSeenAt(accountId, subject) : null;
  }, [accountId, subject, answers]);

  // Only with an answer stored: a first offer needs no history. The same query as My Account's
  // recent activity, so the two share one read.
  const history = useAccountHistory(accountId, eligible && seenAt !== null);
  const latest = history.data ? latestDepositTs(history.data.events) : null;
  let latestDeposit: number | null | "pending" = null;
  if (history.data) {
    const settled = (history.data.upToDate && !history.data.loading) || history.outOfDate;
    // A newer deposit is enough at once; its absence only counts once the history caught up.
    latestDeposit = settled || (latest !== null && seenAt !== null && latest > seenAt) ? latest : "pending";
  } else if (history.isLoading) {
    latestDeposit = "pending";
  }
  const offer = shouldOfferAssignFunds({ eligible, seenAt, latestDeposit });

  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!offer) {
      setOpen(false);
      return;
    }
    if (document.querySelector('[role="dialog"]')) return;
    setOpen(true);
  }, [offer, accountId, subject]);

  /** Either button, Escape or a click outside: answered, until the next deposit. */
  const markSeen = useCallback(() => {
    if (!accountId || !subject) return;
    // Never before a deposit already known: a browser clock behind the chain's would read it as new.
    markAssignFundsPromptSeen(accountId, subject, Math.max(Date.now(), latest ?? 0));
    setAnswers((n) => n + 1);
    setOpen(false);
  }, [accountId, subject, latest]);

  return { open, markSeen };
}
