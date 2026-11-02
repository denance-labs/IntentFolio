// The vault's panic codes, read out of a failed receipt (017-9b, D-302 f; `011` §8).
//
// The contract panics with the bare code and nothing else (Appendix D.8, "Exact format"), and
// the runtime wraps it as `Smart contract panicked: E_…`. That line is the only thing a client
// can key on: the failure object's shape changes with where the panic happened, so the text is
// searched rather than walked.
//
// Attribution: see ATTRIBUTIONS.md #8 (vault contract error catalog, Appendix D.8 / D.2).

const PANIC_CODE = /Smart contract panicked: (E_[A-Z0-9_]+)/;

/** The `E_*` code inside a failure's text, or null when the text carries none. */
export function parseVaultErrorCode(text: string): string | null {
  return PANIC_CODE.exec(text)?.[1] ?? null;
}

/**
 * A reverted commit the user can be told about in their own terms. The commit reverts cleanly
 * (nothing moved), so each of these is safe to state as final — unlike the two replay codes
 * below.
 */
export type CommitRefusal =
  | "portfolio-not-empty"
  | "portfolio-not-found"
  | "reservoir"
  | "paused"
  | "token-frozen"
  | "insufficient-balance";

const COMMIT_REFUSALS: Readonly<Record<string, CommitRefusal>> = {
  E_PORTFOLIO_NOT_EMPTY: "portfolio-not-empty",
  E_PORTFOLIO_NOT_FOUND: "portfolio-not-found",
  E_INSUFFICIENT_RESERVOIR: "reservoir",
  E_PAUSED: "paused",
  E_TOKEN_FROZEN: "token-frozen",
  E_INSUFFICIENT_PORTFOLIO_BALANCE: "insufficient-balance",
};

/**
 * What a reverted commit's failure text means for the user:
 *
 *  - a `CommitRefusal`: nothing moved, and the reason is one they can understand;
 *  - `"unconfirmed"`: `E_NONCE_CONSUMED` / `E_EXPIRED_DEADLINE`. A replay of a commit that
 *    ALREADY APPLIED answers exactly these (the first while the deadline lives, the second
 *    after it, D-302 j), so "nothing moved" would be a guess in the wrong direction. The caller
 *    reports it as not confirmed and re-reads the chain;
 *  - `null`: any other code, or none — a disagreement between the app and the contract that no
 *    wording makes actionable. Generic copy, and the code is logged for ops.
 */
export function classifyCommitFailure(text: string): CommitRefusal | "unconfirmed" | null {
  const code = parseVaultErrorCode(text);
  if (code === null) return null;
  if (code === "E_NONCE_CONSUMED" || code === "E_EXPIRED_DEADLINE") return "unconfirmed";
  return COMMIT_REFUSALS[code] ?? null;
}
