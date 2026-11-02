// Typed outcomes of the live-vault path that the editor must present differently from a
// wallet failure (007.plan, Phase 2).
//
// Both of these travel as exceptions rather than return values for one reason: the commit
// flow treats "did not throw" as "committed" — it closes the preview and drops the draft.
// Neither of these committed anything, so the draft has to survive for a retry.
//
// They are NOT wallet errors and must not be run through `normalizeWalletError`: nothing
// was rejected, locked or broken, so its cancel/unavailable copy would be misleading.

/** The vault deferred the whole commit: the position has not matured yet (nothing moved). */
export class RealUnallocateDeferredError extends Error {
  constructor(
    /** Unix seconds — the contract's own `next_release_at`. */
    readonly nextReleaseAt: number,
    readonly tokenId: string
  ) {
    super(`Unallocate deferred until ${new Date(nextReleaseAt * 1000).toISOString()}`);
    this.name = "RealUnallocateDeferredError";
  }
}

/**
 * The commit applied (nonce consumed, composition saved) but its batch transfer failed in
 * intents.near; the vault released the locks, so the funds are still in the portfolio (D-385 a).
 */
export class RealUnallocateTransferFailedError extends Error {
  constructor(readonly reason: string) {
    super(`The vault could not send the funds back: ${reason}`);
    this.name = "RealUnallocateTransferFailedError";
  }
}

/**
 * The vault would reject this change set. Raised by the offline pre-flight
 * (`change-set-preflight`) BEFORE the wallet is asked to sign, so the user gets a specific
 * reason instead of the contract's single opaque `E_INVALID_COMPOSITION`.
 */
export class RealChangeSetInvalidError extends Error {
  constructor(
    /** A `PreflightReason` — the editor maps it to localized copy. */
    readonly reason: string,
    readonly detail: string
  ) {
    super(`The vault would reject this change: ${reason} (${detail})`);
    this.name = "RealChangeSetInvalidError";
  }
}

/**
 * `execute_intents` REVERTED the Allocate: the Verifier (or the vault, inside the same
 * receipt) panicked and nothing moved. Not a wallet error — the wallet signed and sent
 * exactly what it was asked to — so it must never be read as a cancel. It carries the word
 * "rejected" in its message, which is precisely the keyword `normalizeWalletError` uses to
 * detect a user cancelling in the wallet; the class, not the text, is what tells them apart
 * (FE #5, `922` §8 #15).
 */
export class VaultRejectedError extends Error {
  constructor(
    /** The chain's own reason (`E_BAD_SALT`, `E_NONCE_CONSUMED`, …). */
    readonly reason: string
  ) {
    super(`The Verifier rejected the allocation: ${reason}`);
    this.name = "VaultRejectedError";
  }
}

/**
 * The chain REVERTED a portfolio commit (`commit_portfolio_changes`): the vault panicked and
 * nothing moved — no withdrawal, no composition change. Same trap as `VaultRejectedError`,
 * on the commit path (D-301): the old plain `Error` said "rejected", `normalizeWalletError`
 * matched the word, and the editor told the user they had cancelled a signature they gave.
 * The class carries the origin, so the classifier can read it before any keyword.
 */
export class VaultCommitRevertedError extends Error {
  constructor(
    /** The chain's own reason, as the failed receipt reports it (`E_NONCE_CONSUMED`, …). */
    readonly reason: string
  ) {
    super(`The vault reverted the change: ${reason}`);
    this.name = "VaultCommitRevertedError";
  }
}
