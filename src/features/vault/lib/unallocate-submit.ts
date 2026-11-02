// `commit_portfolio_changes`: build → sign (NEP-413) → submit to the VAULT.
//
// Two shapes travel through here, and the contract treats them differently:
//   - ③ Unallocate — withdrawal legs, the return leg of the round-trip (007.plan Phase 2);
//   - composition edits — retarget / add / remove, added by 008.plan Phase 2.
// v2 adds two more without legs (017-9c): a rename, which counts as an edit, and a signed
// delete, which must ride alone (see run-real-portfolio-meta.ts).
// They may ride the SAME signature. When they do, the per-leg maturity gate defers the
// WHOLE commit, edits included: nothing is half-applied, and the same payload retries.
// A composition-only commit has no legs, so no maturity gate applies to it — a portfolio
// can be re-targeted during its 300 s window, it just cannot be drained.
//
// Shape verified against the contract's own integration test
// (contract/crates/vault/tests/roundtrip_allocate_unallocate.rs:153):
//   vault.call("commit_portfolio_changes").args_json({"payload": <MultiPayload>}).gas(300 Tgas)
// no attached deposit.
//
// Three things this path does NOT share with Allocate — each verified in source:
//
//   1. NO Verifier. The commit goes straight to the vault, so the envelope's `recipient`
//      (=> `verifying_contract`) must be the VAULT: `check_envelope` asserts
//      `verifying_contract == env::current_account_id()` (crypto.rs:137). Passing
//      `intents.near` — or any vault id other than the one this build talks to — fails the
//      signature check. Always pass `VAULT_CONTRACT_ID`, never a literal.
//   2. NO rescue record. An Allocate can orphan funds (Transfer settles, `on_auth`
//      fails). A commit cannot: every failure mode leaves the money exactly where it is,
//      inside the portfolio. A reverted `mt_batch_transfer` releases the locks
//      (`UnallocateFailed`), and a defer mutates nothing at all.
//   3. The nonce salt is fixed. The vault parses but ignores it (no SaltRegistry in the
//      MVP), so there is no `current_salt` round-trip — see COMMIT_NONCE_SALT.
//
// The outcome must be read from the EVENTS, not the tx status: an immature withdrawal is
// a graceful defer that reports SUCCESS while moving nothing (see vault-events.ts).

import { VAULT_CONTRACT_ID } from "@/features/wallet/config/network";
import { buildCommitSignRequest } from "./vault-envelope";
import {
  buildCommitChangeSet,
  type TokenCompositionInput,
  type UnallocateInput,
} from "./vault-payloads";
import { extractTxHash, logTxHash } from "./allocate-submit";
import { RELAY_GAS, type EnvelopeSubmitter } from "./relay-types";
import { RelayError, relayRefusedBeforeSending } from "./relay-client";
import type { VaultSigner } from "./vault-signer";
import { logSignedEnvelope } from "./vault-debug-log";
import { VaultCommitRevertedError } from "./vault-errors";
import {
  findExecutionFailure,
  findUnallocateDeferred,
  findPendingUnallocationCommitId,
  findUnallocateFailure,
  hasPendingUnallocation,
  type UnallocateDeferred,
} from "./vault-events";

// 300 Tgas, matching the contract's own integration test. The commit fans out into an
// `mt_batch_transfer` on the Verifier plus the settlement callback. Shared with the relayer
// through relay-types, so both send paths declare the same budget.
export const COMMIT_CHANGES_GAS = RELAY_GAS;
// Deliberately ONE deadline here, unlike allocate-submit.ts, which splits its envelope TTL
// from a 72h AuthCallMsg deadline. That split exists to keep an ORPHANED allocate
// rescuable; Unallocate has no equivalent rescue route (the vault keeps a durable
// `PendingUnallocation` and settles through its own callback), so there is nothing for a
// longer inner deadline to buy. Do not widen this one to match. (ADR-0017 §1.)
export const ENVELOPE_TTL_SECS = 600;

export type SubmitUnallocateParams = {
  /** The INTENTS account id that owns the portfolio: `alice.near` or a lowercase `0x…`. */
  signerId: string;
  portfolioId: string; // the REAL on-chain id (D-R6 mirrors it into the read model)
  /** Base units, straight from `get_portfolio_balance` — never re-derived from a float. */
  legs: UnallocateInput[];
  /**
   * Composition edits riding the same signature (008.plan Phase 2). Already in basis
   * points and already pre-flighted by the caller — this function does not re-validate
   * them, it serialises them.
   */
  targetChanges?: TokenCompositionInput[];
  tokenAdditions?: TokenCompositionInput[];
  tokenRemovals?: string[];
  /** v2 rename (017-9c), alone or riding the other edits. Already trimmed and pre-flighted. */
  name?: string;
  /** v2 signed delete (C-9). Must ride alone: no legs, no edits, no rename. */
  delete?: boolean;
  /** Signs in the login family's own scheme (NEP-413 for NEAR, ERC-191 otherwise). */
  signer: VaultSigner;
  /** Who sends the signed envelope. REQUIRED — see SubmitAllocateParams.submit. */
  submit: EnvelopeSubmitter;
  /** Injectable for tests. */
  now?: () => number;
};

export type SubmitUnallocateResult = {
  txHash: string | null;
  /** Set when the vault deferred the whole commit (immature position). Nothing moved. */
  deferred: UnallocateDeferred | null;
  /** The vault locked the legs and fired the transfer — the withdrawal is settling. */
  accepted: boolean;
  /** The batch's id from `pending_unallocation_opened`, when the outcome carries it (D-379). */
  commitId?: string | null;
  /** Set when the batch transfer reverted; the locks were released, funds still held. */
  failure: string | null;
  /**
   * Set when the relayer sent the commit but nothing proves how it ended (D-329, D-330). The
   * caller must confirm it from the chain's state, and must not call it a failure.
   */
  submitUncertain?: string;
};

export async function submitUnallocate(
  p: SubmitUnallocateParams
): Promise<SubmitUnallocateResult> {
  const editsComposition =
    (p.targetChanges?.length ?? 0) > 0 ||
    (p.tokenAdditions?.length ?? 0) > 0 ||
    (p.tokenRemovals?.length ?? 0) > 0;
  const renames = p.name !== undefined;
  // A signed delete carries nothing else: the contract refuses the mix with
  // `E_INVALID_COMPOSITION` (emptying and deleting are two signatures, ADR-0023). Refused here
  // so it never costs a signature.
  if (p.delete === true && (p.legs.length > 0 || editsComposition || renames)) {
    throw new Error("A portfolio delete cannot carry legs, composition changes or a rename");
  }
  // A commit with no effect at all consumes a nonce to do nothing.
  if (p.legs.length === 0 && !editsComposition && !renames && p.delete !== true) {
    throw new Error("Commit needs at least one leg, one composition change, a rename or a delete");
  }
  // The contract rejects a zero-quantity leg outright (composition.rs:107, SB-04): it
  // would seal the nonce and open a pending that moves nothing. Fail before signing.
  for (const leg of p.legs) {
    if (!/^\d+$/.test(leg.amount) || leg.amount === "0") {
      throw new Error(`Invalid unallocate amount for ${leg.tokenId}: ${leg.amount}`);
    }
  }

  const nowSecs = Math.floor((p.now ?? Date.now)() / 1000);
  const deadlineSecs = nowSecs + ENVELOPE_TTL_SECS;

  const changeSet = buildCommitChangeSet({
    portfolioId: p.portfolioId,
    targetChanges: p.targetChanges,
    tokenAdditions: p.tokenAdditions,
    tokenRemovals: p.tokenRemovals,
    unallocations: p.legs,
    name: p.name,
    delete: p.delete,
  });

  const { request, erc191Message } = buildCommitSignRequest({
    signerId: p.signerId,
    deadlineSecs,
    vaultId: VAULT_CONTRACT_ID,
    changeSet,
  });

  const multiPayload = await p.signer.signEnvelope({ nep413: request, erc191Message });

  // The signed authorization, logged before we hand it to the wallet. `commit_portfolio_changes`
  // is PERMISSIONLESS — the signature is the authorization, not the caller — so this payload
  // can be submitted by any account:
  //   near call <vault> commit_portfolio_changes '<this>' --accountId <anyone> --gas 300000000000000
  // That is the operator-as-relayer path the EVM leg needs anyway (D-R1), and it doubles as the
  // escape hatch if the wallet stalls on the submit prompt after having signed. Opt-in only
  // (D-472, `vault-debug-log.ts`): the same text lets anyone submit a change the user cancelled.
  logSignedEnvelope(
    "[vault] commit payload (submittable by any account)",
    JSON.stringify({ payload: multiPayload })
  );

  let outcome: unknown;
  try {
    outcome = await p.submit({ target: "vault", payload: multiPayload });
  } catch (e) {
    // Only the relayer's ambiguous answers are caught: a wallet that throws here keeps its own
    // error (a cancel is the likely one), and a relayer refusal proves nothing was sent.
    if (!(e instanceof RelayError) || relayRefusedBeforeSending(e)) throw e;
    logTxHash("unallocate", e.txHash);
    return {
      txHash: e.txHash,
      deferred: null,
      accepted: false,
      failure: null,
      submitUncertain: e.message,
    };
  }

  // Logged before the revert check, so a rejected commit is traceable too (D-R17).
  const txHash = extractTxHash(outcome);
  logTxHash("unallocate", txHash);

  // A REVERTED transaction, first: a panicking receipt's events are not read (D-324 —
  // `collectLogs` skips failed receipts), so without this the flow would fall through to the
  // settlement poll and spend two minutes before reporting "unconfirmed" — when the chain
  // already said exactly what was wrong and nothing is in flight. Some wallets throw on a
  // failed status and never reach here; this covers the ones that resolve with the outcome
  // instead.
  //
  // Except when the vault's callback reported `unallocate_failed` (D-385 a): then the failed
  // receipt is `intents.near`'s `mt_batch_transfer`, not the vault. The commit itself executed —
  // nonce consumed, composition applied, locks released by the callback — so it is the batch
  // failure, not a revert. A vault commit that panicked opens no callback and has no such event.
  const failure = findUnallocateFailure(outcome);
  const reverted = findExecutionFailure(outcome);
  if (reverted && !failure) throw new VaultCommitRevertedError(reverted);

  return {
    txHash,
    deferred: findUnallocateDeferred(outcome),
    accepted: hasPendingUnallocation(outcome),
    commitId: findPendingUnallocationCommitId(outcome),
    failure,
  };
}
