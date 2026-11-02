import type { DepositStatusEntry } from "./bridge-client";

/**
 * Whether a bridge deposit means "the funds are in the Verifier".
 *
 * Exists because the obvious spelling was wrong and nothing caught it. The code asked for
 * `status === "CREDITED"`, which reads like the right word — but the PoA bridge answers
 * **`"COMPLETED"`**, and the SDK's own type is `"COMPLETED" | "PENDING" | "FAILED" |
 * "CREDITED"`, so both spellings typecheck and TypeScript had no opinion.
 *
 * The consequence was not cosmetic. `use-recent-deposits` fires the credited callback from
 * this test, and that callback is what invalidates the balance query, raises the toast and
 * lights the badge. With the branch permanently dead, `setDeposits` still ran — so the
 * activity feed appeared while the balance sat stale behind its 5-minute `staleTime`, and the
 * only way to see credited funds was a manual reload. Measured with real money on Stellar
 * (2026-08-08): three deposits, all reported `COMPLETED`, balance confirmed present by view
 * call on `intents.near` while the screen kept showing the old number for over three minutes.
 * Since the value does not depend on the chain, the deposit toast had most likely never fired
 * for any family. See D-226.
 *
 * Both spellings are accepted rather than swapping one for the other: `COMPLETED` is what this
 * bridge demonstrably sends, `CREDITED` is what its type still permits, and a deployment that
 * used the other word would silently reintroduce the same dead branch.
 */
export function isDepositCredited(status: DepositStatusEntry["status"]): boolean {
  return status === "COMPLETED" || status === "CREDITED";
}
