// The relay's own note of a withdrawal's transaction (ADR-0025, D-593). SERVER ONLY.
//
// The browser PATCHes `tx_hash` once the relay answers; a tab that dies in between loses it, and
// the solver then has to find the transaction itself — or, on near-*, close on the nonce alone.
// `/api/relay` knows the hash, so it writes it too. Best-effort, as everything in this table: a
// failure is logged and nothing waits for it. A record whose INSERT lands later is missed.
//
// What is worth writing, agreed with the solver's judge:
//   - the Verifier's event names this signer and nonce in a successful receipt → PROVED: replaces
//     whatever is there, since another instance may have sent the same envelope and noted a hash
//     that never landed. A LATER receipt failing (a token's `ft_transfer`) does not change this:
//     without the hash the solver would call that withdrawal delivered. Never decide this with
//     `findExecutionFailure`, which counts any failed receipt;
//   - `unknown-outcome` → a candidate: written only where there is no hash yet;
//   - a reverted `execute_intents`, or any refusal → nothing.

import type { Queryable } from "@/features/vault/lib/ops-records-service";
import type { RelayResponseBody } from "@/features/vault/lib/relay-types";
import { executedIntentHash, readSignerAndNonce } from "./own-relay-publish";

export type RelayedTxHash = { signerId: string; nonce: string; txHash: string; proved: boolean };

/** The hash worth noting in what the relay answered for this envelope, or null. */
export function relayedTxHash(payload: unknown, response: RelayResponseBody): RelayedTxHash | null {
  const txHash = response.txHash;
  if (!txHash) return null;
  // The texts as signed, not normalised: the solver compares the record's columns exactly.
  const signed = readSignerAndNonce(payload);
  if (!signed) return null;
  if (response.ok) {
    return executedIntentHash(response.outcome, signed) === null ? null : { ...signed, txHash, proved: true };
  }
  return response.code === "unknown-outcome" ? { ...signed, txHash, proved: false } : null;
}

const UPDATE_SQL = "UPDATE withdraw_record SET tx_hash = $3 WHERE signer_id = $1 AND nonce = $2";
/** Skips the row that already holds this hash (the browser's PATCH got there first). */
const PROVED_SQL = `${UPDATE_SQL} AND tx_hash IS DISTINCT FROM $3`;
const CANDIDATE_SQL = `${UPDATE_SQL} AND tx_hash IS NULL`;

export type NoteRelayedTxHashInput = {
  payload: unknown;
  response: RelayResponseBody;
  resolveDb: () => { ok: true; db: Queryable } | { ok: false; issues: string[] };
  log?: (message: string) => void;
};

/**
 * Writes it. Never throws. No row is normal, not an alarm: an Allocate, a gas purchase and a stock
 * swap use the same target with no withdrawal record, and the record's POST is best-effort.
 */
export async function noteRelayedTxHash(input: NoteRelayedTxHashInput): Promise<void> {
  const log = input.log ?? ((m: string) => console.log(m));
  try {
    const found = relayedTxHash(input.payload, input.response);
    if (!found) return;
    const db = input.resolveDb();
    if (!db.ok) {
      log(`[ops] withdraw-record relay tx not noted, database not configured: ${db.issues.join(", ")}`);
      return;
    }
    const { rowCount } = await db.db.query(found.proved ? PROVED_SQL : CANDIDATE_SQL, [
      found.signerId,
      found.nonce,
      found.txHash,
    ]);
    if ((rowCount ?? 0) > 0) log(`[ops] withdraw-record relay tx noted tx=${found.txHash} proved=${found.proved}`);
  } catch (e) {
    // The message may name a column; it never carries the row (ADR-0025 §7).
    log(`[ops] withdraw-record relay tx NOT noted: ${e instanceof Error ? e.message : String(e)}`);
  }
}
