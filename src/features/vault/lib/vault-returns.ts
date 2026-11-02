// Scheduled Returns addressed to one account, for the My Account notice (D-302 h2, 017-9c).
//
// A Return is the vault sending funds back to a General Balance after its timelock — a credit
// that landed on a deleted portfolio, for instance. The contract has no "Returns for account"
// view: `get_config().return_counter` is the next id to be issued, ids run from 0 and are
// never reused, and `get_return(id)` answers `null` once one is executed or cancelled. So the
// only way to find this account's is to walk every id below the counter and keep the ones
// whose `to` is it. Returns are rare (a counter in the tens, not thousands), which is what
// makes a full walk acceptable; the concurrency bound keeps it from bursting the RPC proxy.
//
// The reads are injected; whether a build reads Returns at all is the hook's call
// (`useScheduledReturns`: round-trip on and a vault configured).
//
// Two rules, both about what this must NOT do:
//
//  - **No silent empty.** A read failure REJECTS, never resolves to `[]`. An empty list
//    renders as "nothing on its way", which hides funds the user is owed; a rejection lets
//    react-query keep the last good answer on screen instead.
//  - **`executing` is still shown.** It is the Return being sent right now — the funds have
//    not reached the General Balance yet, so dropping it would make them vanish for the
//    length of the callback chain.

//
// Attribution: see ATTRIBUTIONS.md #8 (vault `get_return` / `return_counter`, views.rs).

import type { ReturnView, VaultConfig } from "./vault-read-client";

export const DEFAULT_RETURN_READ_CONCURRENCY = 4;

export async function findScheduledReturns(params: {
  accountId: string;
  readConfig: () => Promise<Pick<VaultConfig, "return_counter">>;
  readReturn: (id: number) => Promise<ReturnView | null>;
  concurrency?: number;
}): Promise<ReturnView[]> {
  const { accountId, readConfig, readReturn } = params;
  const { return_counter: counter } = await readConfig();
  // A malformed counter is a read failure, not "no Returns": the same no-silent-empty rule.
  if (!Number.isSafeInteger(counter) || counter < 0) {
    throw new Error(`vault-returns: unreadable return_counter ${String(counter)}`);
  }
  if (counter === 0) return [];

  const concurrency = Math.max(1, Math.floor(params.concurrency ?? DEFAULT_RETURN_READ_CONCURRENCY));
  const found: ReturnView[] = [];
  let next = 0;
  // Set by the first failure so the other workers stop issuing reads whose answer is moot.
  let failed = false;

  async function worker(): Promise<void> {
    while (!failed && next < counter) {
      const id = next++;
      try {
        const view = await readReturn(id);
        if (view && view.to === accountId) found.push(view);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, counter) }, worker));
  // Earliest arrival first; the id breaks ties so the order is stable across refetches.
  return found.sort((a, b) => a.eta - b.eta || a.id - b.id);
}
