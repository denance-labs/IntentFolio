// Observing that bought gas actually landed (008.plan §Fase 4, D-251).
//
// WHY THIS IS A MODULE AND NOT FIVE LINES IN THE SHELL
// It is the last step of a flow that spends money, and its failure mode is silent: if it can
// never see the balance it is watching, it waits out its whole budget and then reports that
// the gas has not arrived — for a purchase that completed perfectly. A user reading that has
// every reason to buy again. Sitting inside a component it had no test; here the read is a
// seam, so the "cannot see it" case is a case that can be written down.
//
// It compares against the balance BEFORE the purchase rather than against the amount expected.
// An increase is unambiguous; "did it reach 0.04" would also be satisfied by gas that was
// already there, and would be defeated by the rounding a human-unit double introduces (D-206).

export type GasArrivalDeps = {
  /** The signer's current balance of the bought asset. `null` means "cannot see it". */
  read: () => number | null;
  /** Forces the balance to be re-read from the network. */
  refresh: () => Promise<unknown>;
  /** Injected so tests do not spend real time. */
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
};

export type GasArrivalOutcome =
  /** The balance went up. The withdrawal can proceed. */
  | { kind: "arrived" }
  /** The budget ran out with no increase. NOT a failure — the purchase already settled. */
  | { kind: "timeout" }
  /**
   * 🔴 The balance could not be read at all, so nothing was observed either way.
   *
   * Distinct from `timeout` because it is a BUG in this app, not a slow bridge: the balance is
   * keyed by asset id and read out of the query cache, and a key that stops matching (or an
   * asset the balance query does not carry) makes every read `null`. Reporting that as
   * "it hasn't arrived" would be this code blaming the network for its own blind spot.
   */
  | { kind: "unobservable" };

export type WaitForGasArrivalParams = {
  pollMs: number;
  budgetMs: number;
  deps: GasArrivalDeps;
};

/**
 * Polls the balance until the bought gas shows up, the budget expires, or it becomes clear
 * the balance cannot be observed at all.
 *
 * Deliberately no `AbortSignal`: the caller is not allowed to stop caring. Whatever it does
 * with the answer, the purchase has already settled by the time this runs.
 */
export async function waitForGasArrival(
  p: WaitForGasArrivalParams
): Promise<GasArrivalOutcome> {
  const now = p.deps.now ?? Date.now;
  const before = p.deps.read();
  if (before === null) return { kind: "unobservable" };

  const deadline = now() + p.budgetMs;
  let everRead = false;
  while (now() < deadline) {
    await p.deps.sleep(p.pollMs);
    await p.deps.refresh();
    const held = p.deps.read();
    if (held === null) continue; // a single failed read is a flake, not a verdict
    everRead = true;
    if (held > before) return { kind: "arrived" };
  }
  // Never once read it after the first look: the asset is not in what we can see, so the
  // honest answer is that nothing was observed rather than that nothing arrived.
  return everRead ? { kind: "timeout" } : { kind: "unobservable" };
}
