// D-264 — which withdrawals the shell must keep visible from OUTSIDE My Account.
//
// The row for a withdrawal lives in the activity feed, which only exists inside My Account.
// After a reload the user reconnects and lands on a portfolio tab, so the one recovery
// mechanism a withdrawal has — the rehydrated worklist, with no Solver-side backstop behind
// it (D-160) — sat behind a click nobody had a reason to make. This is the rule the strip and
// the tab badge are driven by.
//
// It is a function rather than an inline filter because both of the decisions in it are
// decisions, not details, and each one has a way of being wrong that costs something real.

import type { WithdrawalInFlightRecord } from "@/features/intents-account/mock-contract/types";
import { DISMISS_AFTER_MS } from "@/features/bridge/lib/withdraw-rescue-store";

/** The statuses that END a withdrawal. Everything else is still open. */
const RESOLVED: ReadonlyArray<WithdrawalInFlightRecord["status"]> = ["DELIVERED", "FAILED", "REFUNDED"];

/**
 * How many REAL withdrawals are still open for this account.
 *
 * `isReal` — the mock progression drives its own rows on timers and resolves them within 90
 * seconds by construction, so counting them would put an alarming strip over a demo. Only a
 * withdrawal that actually moved money has anything to recover.
 *
 * `UNCONFIRMED` counts as open, and that is the whole point rather than an edge case: it is
 * the state where the funds have left the General Balance and nobody has observed them
 * landing. If any single status has to be reachable from the portfolio view, it is that one.
 */
export function countWithdrawalsInFlight(
  records: readonly WithdrawalInFlightRecord[]
): number {
  return records.filter((r) => r.isReal && !RESOLVED.includes(r.status)).length;
}

/**
 * D-463 (023-B) — whether the row may offer «Hide»: a REAL withdrawal, still open, older than
 * `DISMISS_AFTER_MS`. The store applies the same rule again on write; this only decides what is
 * shown. A mock row resolves itself within 90 seconds and never qualifies.
 */
export function canDismissWithdrawal(record: WithdrawalInFlightRecord, now: number): boolean {
  return Boolean(record.isReal) && !RESOLVED.includes(record.status) && now - record.ts > DISMISS_AFTER_MS;
}
