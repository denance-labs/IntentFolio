// ② Allocate: build → persist rescue record → sign (NEP-413) → persist envelope → submit.
// The first FE path that moves real funds (007.plan, Phase 1). Both AllocateOps go through
// here — `Setup` (create a portfolio) and `AllocateInto` (fund one the signer owns, D-321) —
// because the envelope, the two gates and the outcome verdict are the same for both; only
// the AuthCallMsg body differs.
//
// Shape verified against the contract's own integration test
// (contract/crates/vault/tests/roundtrip_allocate_unallocate.rs), not assumed:
//   verifier.call("execute_intents").args_json({"signed": [signed]}).gas(300 Tgas)
// no attached deposit. THREE independent deadlines (the test shares one value for the
// first two; this path deliberately does not):
//   - envelope deadline (now + 600s): the NEP-413 payload's own `deadline`, i.e. how long
//     the Verifier will accept the submission;
//   - nonce deadline (AuthCall deadline + 7d): embedded in the salted V1 nonce, bounds how
//     long the Verifier keeps the used nonce as the rescue's proof of execution. See
//     NONCE_WITNESS_WINDOW_SECS;
//   - AuthCallMsg.deadline is INDEPENDENT and lives inside the msg — now + 72h, because it
//     is what bounds the rescue window for an orphan (ADR-0017 §1). See AUTH_CALL_TTL_SECS.
// AuthCallMsg.nonce is not replay-checked by the vault, but it must be unique: it is what
// keeps sha256(msg) unique, and that hash is the key of the orphan rescue.
//
// ORDERING IS A SAFETY PROPERTY, and there are TWO gates, not one:
//   1. the rescue record is persisted BEFORE the wallet is asked to sign, because a submitted
//      Allocate whose raw msg we did not keep is a potentially unrecoverable orphan;
//   2. the SIGNED ENVELOPE is persisted before the envelope is submitted, because a record
//      without it cannot attribute the stranded funds to their signer and the solver's rescue
//      tool will not sign a credit on it (ADR-0017 §5 as amended, D-289).
// Both abort instead of continuing, and each sits at the last instant where aborting is still
// free: before the signature exists, and before anything has been sent. Since ADR-0017 both
// gates have TWO fail-closed channels — the user's localStorage and the ops database. See
// allocate-record-sink.ts for the ordering rationale and allocate-rescue-store.ts for why the
// raw bytes may never be rebuilt.
//
// Wallet capabilities are injected (NearSigner) rather than imported from the HOT Connect
// hook, so the whole money path is unit-testable without a wallet or a network.

import { VAULT_CONTRACT_ID } from "@/features/wallet/config/network";
import { AUTH_CALL_TTL_SECS, buildAllocateSignRequest } from "./vault-envelope";
import { RELAY_GAS, type EnvelopeSubmitter } from "./relay-types";
import type { VaultSigner } from "./vault-signer";
import {
  buildAuthCallAllocateIntoMsg,
  buildAuthCallSetupMsg,
  type AllocationInput,
  type TokenCompositionInput,
  type VaultChainKind,
} from "./vault-payloads";
import { getCurrentSalt } from "./intents-read-client";
import {
  persistAllocateRecord,
  persistSignedEnvelope,
  updateAllocateRecordEverywhere,
} from "./allocate-record-sink";
import { classifyAllocateOutcome } from "./vault-events";
import { VaultRejectedError } from "./vault-errors";
import { RelayError, relayRefusedBeforeSending } from "./relay-client";
import { readAllocateSeal, toPrefixBase64, type SealRead } from "./allocate-seal";

// 300 Tgas, matching the contract's own integration test. execute_intents fans out into
// the vault's on_auth, so it needs the full budget. Defined once in relay-types, where both
// submit destinations live, so the wallet and the relayer cannot drift apart on it.
export const EXECUTE_INTENTS_GAS = RELAY_GAS;
const ENVELOPE_TTL_SECS = 600;
// The second deadline, the AuthCallMsg's (`AUTH_CALL_TTL_SECS`, 72h), is explained and defined
// in vault-envelope.ts, because the relay bounds it from the same value (D-371).
// The nonce deadline is the third one, and it is the one that was silently wrong: the
// nonce used to expire with the envelope. The Verifier may sweep a *used* V1 nonce any
// time after its deadline (solver `921` §3 #3), after which `is_nonce_used` answers
// `false` for an Allocate that DID execute — the exact reading the orphan resolver treats
// as "never executed" before it credits. With a 600s nonce that proof could vanish ten
// minutes into the 72h rescue window. So the nonce outlives the AuthCall deadline by the
// same 7-day witness window the solver's reconciler uses (`921` §7 Q2): it covers a long
// weekend of a downed resolver, and widens no replay window — replay is bounded by the
// envelope, not the nonce. ADR-0017 §5 as amended; solver `922` §3.4 #1.
const NONCE_WITNESS_WINDOW_SECS = 7 * 24 * 60 * 60;

// Re-exported so the existing importers of these two keep one import site; they are
// defined next to the signer implementations now (vault-signer.ts).
export type { SignedMessageResult, NearSigner } from "./vault-signer";

/** Which AllocateOp the AuthCallMsg carries. */
export type AllocateOpInput =
  | {
      kind: "setup";
      loginWalletChain: VaultChainKind;
      loginWalletAddress: string;
      composition: TokenCompositionInput[];
      /**
       * The Storage Cost (D-528): an intents token id and base units, sent to the ops account in
       * the same envelope. Only a Setup carries one; the relay refuses a Setup without it.
       */
      storage: { tokenId: string; amount: string };
    }
  | {
      kind: "allocate_into";
      /** The on-chain id of a portfolio the signer owns. */
      portfolioId: string;
      /** Tokens joining the composition, at 0% (rule 2, §7.1). */
      tokenAdditions?: TokenCompositionInput[];
    };

export type SubmitAllocateParams = {
  /** The INTENTS account id that owns the funds: `alice.near` or a lowercase `0x…`. */
  signerId: string;
  /**
   * The name the rescue record and the pending notice show: the portfolio being created
   * (Setup, which also signs it) or the one being funded (AllocateInto, which does not).
   */
  portfolioName: string;
  op: AllocateOpInput;
  /** The funded legs. One Transfer carries all of them (008.plan Phase 2). */
  allocations: AllocationInput[];
  /** Signs in the login family's own scheme (NEP-413 for NEAR, ERC-191 otherwise). */
  signer: VaultSigner;
  /**
   * Who sends the signed envelope. REQUIRED: with the signer abstracted per family there
   * is no longer a NEAR wallet here to fall back to, and silently self-submitting would be
   * impossible for the five families that have no account to send from.
   */
  submit: EnvelopeSubmitter;
  /** Injectable for tests. */
  now?: () => number;
  /** The vault's seal for `(signerId, msg)`, read before declaring an orphan (D-328). Injectable for tests. */
  readSeal?: (signerId: string, msg: string) => Promise<SealRead>;
  /** Wait before the one re-read of an `unsealed` answer (final-finality lag). Injectable for tests. */
  sealRecheckMs?: number;
};

export type SubmitAllocateResult = {
  /** Rescue-store id — the handle for a manual credit_pending_allocation. */
  recordId: string;
  txHash: string | null;
  authCallMsg: string;
  /**
   * Set when the Transfer settled but the vault's `on_auth` receipt failed: the funds are in
   * the vault, credited to nobody, and the record is already `suspected_orphan`. The caller
   * must NOT wait for a credit that `on_auth` has just refused (FE #5).
   */
  vaultFailure?: string;
  /**
   * Set when the submit threw without proof that nothing was sent (D-311): the envelope may
   * have landed. The record is `submitted`; the caller polls for the credit as usual.
   */
  submitUncertain?: string;
};

/** Shared with the Unallocate submit path: both get the same wallet outcome shape. */
export function extractTxHash(outcome: unknown): string | null {
  const o = outcome as
    | { transaction_outcome?: { id?: string }; transaction?: { hash?: string } }
    | null
    | undefined;
  return o?.transaction_outcome?.id ?? o?.transaction?.hash ?? null;
}

/**
 * Logs the tx hash and its explorer URL (D-R17).
 *
 * The hash is propagated all the way up but no view renders it, so during the wet tests it
 * had to be hunted down in the explorer by hand. Logging it HERE — at the submit, not at
 * the end of the flow — is deliberate: it survives the paths where the flow does not reach
 * a final state (a credit-poll timeout, an unconfirmed settlement), which are exactly the
 * ones where the hash matters most.
 */
export function logTxHash(kind: "allocate" | "unallocate", txHash: string | null): void {
  if (!txHash) return;
  console.log(`[vault] ${kind} tx ${txHash} — https://nearblocks.io/txns/${txHash}`);
}

/**
 * Runs the full Allocate. Throws on any failure; the rescue record is already persisted by
 * then, so a throw AFTER submit still leaves the funds recoverable.
 */
export async function submitAllocate(p: SubmitAllocateParams): Promise<SubmitAllocateResult> {
  const nowMs = (p.now ?? Date.now)();
  const nowSecs = Math.floor(nowMs / 1000);
  const envelopeDeadlineSecs = nowSecs + ENVELOPE_TTL_SECS;
  const authCallDeadlineSecs = nowSecs + AUTH_CALL_TTL_SECS;
  const nonceDeadlineSecs = authCallDeadlineSecs + NONCE_WITNESS_WINDOW_SECS;

  // Live salt: the Verifier rotates and validates it. A stale salt fails closed (the whole
  // envelope is rejected, the Transfer never settles), but fetch it fresh regardless.
  const salt = await getCurrentSalt();

  const authCallNonce = Array.from(crypto.getRandomValues(new Uint8Array(32)));
  const authCallMsg =
    p.op.kind === "setup"
      ? buildAuthCallSetupMsg({
          deadline: authCallDeadlineSecs,
          nonce: authCallNonce,
          chain: p.op.loginWalletChain,
          address: p.op.loginWalletAddress,
          portfolioName: p.portfolioName,
          composition: p.op.composition,
          allocations: p.allocations,
        })
      : buildAuthCallAllocateIntoMsg({
          deadline: authCallDeadlineSecs,
          nonce: authCallNonce,
          portfolioId: p.op.portfolioId,
          tokenAdditions: p.op.tokenAdditions,
          allocations: p.allocations,
        });

  // Built before the record, not after: it is pure (nothing is signed or sent), and the record
  // keeps its nonce and deadline — the witness that later tells an envelope that never ran
  // from money in transit (D-312). The gate below still sits before the signature.
  const { request, erc191Message } = buildAllocateSignRequest({
    signerId: p.signerId,
    deadlineSecs: envelopeDeadlineSecs,
    nonceDeadlineSecs,
    salt,
    vaultId: VAULT_CONTRACT_ID,
    transfers: p.allocations,
    authCallMsg,
    ...(p.op.kind === "setup" ? { storage: p.op.storage } : {}),
  });

  // ── First safety gate: persist the raw msg BEFORE signing, or do not sign at all. ──
  // Two channels since ADR-0017: the user's localStorage AND the ops database. Both are
  // fail-closed, so a throw here means nothing was signed and nothing can be stranded.
  const recordId = await persistAllocateRecord({
    signerId: p.signerId,
    msg: authCallMsg,
    vaultId: VAULT_CONTRACT_ID,
    portfolioName: p.portfolioName,
    legs: p.allocations.map((a) => ({ tokenId: a.tokenId, amount: a.amount })),
    verifierNonce: toPrefixBase64(request.nonce),
    envelopeDeadlineSecs,
  });

  // The signer picks its scheme and assembles the canonical MultiPayload; both envelope
  // forms are handed over together so the two can never be paired with the wrong one.
  let multiPayload;
  try {
    multiPayload = await p.signer.signEnvelope({ nep413: request, erc191Message });
  } catch (e) {
    // Nothing was submitted, so nothing can be stranded.
    await updateAllocateRecordEverywhere(recordId, { status: "failed", error: describeError(e) });
    throw e;
  }

  // ── Second safety gate: persist the SIGNED ENVELOPE before submitting, or do not submit. ──
  // ADR-0017 §5 was amended on 2026-08-18 (D-289): this write is load-bearing, not
  // best-effort. Without a stored envelope there is no signed `Transfer` naming the vault and
  // no nonce, so nothing distinguishes this signer's stranded funds from anyone else's — the
  // solver's rescue tool reports `signature: 'absent'` and REFUSES to sign a credit, leaving
  // only `claim_orphan_transfer`, which covers implicit accounts.
  //
  // It sits HERE, and nowhere else, because this is the last instant at which failing closed
  // still protects anything: the envelope exists but has not been sent, so a throw costs the
  // user a signature and can strand nothing. One line later the funds may already be in the
  // vault and an abort would only be theatre.
  //
  // Storing an envelope that is then never submitted is safe by construction on the reading
  // side: the rescue checks `is_nonce_used` on intents.near, and an envelope that never ran
  // has an unburnt nonce, which blocks the credit.
  //
  // Attribution: see ATTRIBUTIONS.md #18 (what the stored envelope must contain).
  try {
    await persistSignedEnvelope(recordId, multiPayload);
  } catch (e) {
    // Nothing was submitted, so — exactly as with a rejected signature — nothing can be
    // stranded, and the record must not sit on the rescue worklist looking unresolved.
    await updateAllocateRecordEverywhere(recordId, { status: "failed", error: describeError(e) });
    throw e;
  }

  let outcome: unknown;
  try {
    outcome = await p.submit({ target: "verifier", payload: multiPayload });
  } catch (e) {
    // Two kinds of throw, and they must not share a fate (D-311, D-312):
    //   - the relayer PROVED nothing was sent (a refusal, or `send-failed`): nothing reached
    //     the chain, so the record is `failed` and a retry is safe;
    //   - anything else — `unknown-outcome`, an unreadable answer, a network error, a wallet
    //     that threw while sending — is AMBIGUOUS: the tx may have landed. The record stays
    //     `submitted` (on the worklist) and this does NOT throw: the caller waits for the
    //     credit like any other submit, so a timeout ends in the terminal "unconfirmed" state
    //     instead of a "Retry" button over funds that may already be in the vault. The relayer
    //     knows the hash before it sends (D-329), so the record keeps it when it has one.
    if (relayRefusedBeforeSending(e)) {
      await updateAllocateRecordEverywhere(recordId, { status: "failed", error: describeError(e) });
      throw e;
    }
    const txHash = e instanceof RelayError ? e.txHash : null;
    logTxHash("allocate", txHash);
    await updateAllocateRecordEverywhere(recordId, {
      status: "submitted",
      ...(txHash ? { txHash } : {}),
      error: describeError(e),
    });
    return { recordId, txHash, authCallMsg, submitUncertain: describeError(e) };
  }

  // Logged before the verdict, so a reverted or orphaned Allocate is traceable too (D-R17).
  const txHash = extractTxHash(outcome);
  logTxHash("allocate", txHash);

  // Three outcomes, not two (FE #5, `922` §8 #15). The payload is `[Transfer, AuthCall]` and
  // the two settle in different receipts, so "the tx failed somewhere" is not one thing:
  //
  //   - REVERTED (top-level Failure): execute_intents rolled back, nothing moved (D-R12).
  //     Marked `failed` — OFF the rescue worklist, because a "submitted" record for a
  //     reverted tx is an orphan that can never be resolved. Checked before the poll so an
  //     explicit revert does not spend 120s to report "submitted, not confirmed", which is
  //     misleading in the WRONG direction.
  //   - VAULT FAILED (top-level success, the vault's receipt failed): the Transfer SETTLED
  //     and `on_auth` panicked. That is the orphan. Marked `suspected_orphan` with the tx
  //     hash — ON the worklist — and the caller skips the poll: no credit is coming until a
  //     rescue replays the msg. Until this branch existed the record was written `failed`
  //     and no orphan ever reached the solver (seen twice in `922` F4).
  //   - EXECUTED: `submitted`, deliberately NOT "credited". Only an observed balance credit
  //     (see the poll) may mark this record credited.
  //   - UNDECIDED (a receipt failed, but no top-level status and no vault executor to say
  //     what it means): `submitted` with the error, and the poll decides — the same
  //     treatment as a submit that threw. Never `failed` on a guess.
  const verdict = classifyAllocateOutcome(outcome, VAULT_CONTRACT_ID);
  if (verdict.kind === "reverted") {
    await updateAllocateRecordEverywhere(recordId, { status: "failed", error: verdict.error });
    throw new VaultRejectedError(verdict.error);
  }
  // A failed receipt is not proof the credit failed (D-328): a receipt that is not the vault's
  // can fail after `on_auth` credited. The seal is the vault's own word that this exact `msg`
  // was applied, so it is read before the orphan is declared. Only `sealed` overrides:
  // unsealed or unreadable keeps the conservative verdict, and the seal cleanup moves a record
  // that did credit to `credited` later. Not read when the vault's own receipt failed: `on_auth`
  // opens no promises, so a panic there reverted the seal with everything else.
  if (verdict.kind === "vault_failed" && !verdict.byVault && (await sealedAfterFailure(p, authCallMsg))) {
    await updateAllocateRecordEverywhere(recordId, {
      status: "submitted",
      txHash: txHash ?? undefined,
      error: verdict.error,
    });
    return { recordId, txHash, authCallMsg };
  }
  if (verdict.kind === "vault_failed") {
    await updateAllocateRecordEverywhere(recordId, {
      status: "suspected_orphan",
      txHash: txHash ?? undefined,
      error: verdict.error,
    });
    return { recordId, txHash, authCallMsg, vaultFailure: verdict.error };
  }

  await updateAllocateRecordEverywhere(recordId, {
    status: "submitted",
    txHash: txHash ?? undefined,
    ...(verdict.kind === "undecided" ? { error: verdict.error } : {}),
  });

  return { recordId, txHash, authCallMsg };
}

const SEAL_RECHECK_MS = 3_000;

/**
 * The seal reads at final finality, which can trail the outcome the relayer hands back by a block
 * or two: an `unsealed` answer right after the outcome is re-read once. `unreadable` is not —
 * a failing read would only fail again.
 */
async function sealedAfterFailure(p: SubmitAllocateParams, msg: string): Promise<boolean> {
  const read = p.readSeal ?? readAllocateSeal;
  try {
    const first = await read(p.signerId, msg);
    if (first.kind !== "unsealed") return first.kind === "sealed";
    await new Promise((r) => setTimeout(r, p.sealRecheckMs ?? SEAL_RECHECK_MS));
    return (await read(p.signerId, msg)).kind === "sealed";
  } catch {
    return false;
  }
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
