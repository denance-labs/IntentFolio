// Read-only client for the Verifier (`intents.near`). Two reads: the live `current_salt`
// that every ② Allocate nonce must embed (007.plan, Phase 1), and the account's exact
// balances that cap what a signed transfer may move (D-303, at the end of the file).
//
// Why this cannot be a constant: the Verifier ROTATES the salt, and it VALIDATES the salt
// carried in the V1 nonce of an Allocate envelope. (The commit path is different — the
// vault parses but ignores the salt, so buildCommitSignRequest defaults to the fixed
// COMMIT_NONCE_SALT. See vault-envelope.ts.) Signing an Allocate against a stale salt makes
// the Verifier reject the whole envelope — which fails closed: `execute_intents` reverts, so
// the Transfer never settles and no funds orphan. Still, fetch it fresh at signing time.
//
// Verified live against mainnet (2026-07-26): `current_salt` on intents.near returns a JSON
// string of 8 hex chars (e.g. "252812b3") = the 4 salt bytes, matching the Rust helper's
// `"00000000".parse::<Salt>()` width.

import { INTENTS_CONTRACT_ID } from "@/features/wallet/config/network";
import { readFinalHead, viewCall } from "./near-view";

export const SALT_BYTES = 4;

// Pure hex -> bytes for the 4-byte salt. Strict on purpose: this feeds a money-critical
// signed nonce, so a malformed or wrong-width value must throw rather than be padded,
// truncated, or silently zeroed (a zero salt is valid-looking but wrong for Allocate).
export function parseSalt(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]{8}$/.test(hex)) {
    throw new Error(`current_salt: expected 8 hex chars, got ${JSON.stringify(hex)}`);
  }
  const salt = new Uint8Array(SALT_BYTES);
  for (let i = 0; i < SALT_BYTES; i++) {
    salt[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return salt;
}

// The live salt, as the 4 bytes buildAllocateSignRequest expects for its `salt` param.
export async function getCurrentSalt(): Promise<Uint8Array> {
  const raw = await viewCall<string>(INTENTS_CONTRACT_ID, "current_salt");
  return parseSalt(raw);
}

/**
 * The account's exact balances on the Verifier, in base units, in `intentsTokenIds` order.
 * Read right before signing so the amount can be capped against it (`capToHeld`, D-303).
 *
 * Fails CLOSED, because the caller signs on what this returns: a short or malformed answer
 * throws instead of being read as zero or skipped — a missing entry must never become
 * "no cap". Ids must be the Verifier's own (`toIntentsTokenId`), not registry ids.
 */
export async function getIntentsBalances(
  accountId: string,
  intentsTokenIds: string[]
): Promise<bigint[]> {
  const raw = await viewCall<unknown>(INTENTS_CONTRACT_ID, "mt_batch_balance_of", {
    account_id: accountId,
    token_ids: intentsTokenIds,
  });
  if (!Array.isArray(raw) || raw.length !== intentsTokenIds.length) {
    throw new Error(
      `mt_batch_balance_of: expected ${intentsTokenIds.length} balances, got ${JSON.stringify(raw)}`
    );
  }
  return raw.map((value, i) => {
    if (typeof value !== "string" || !/^\d+$/.test(value)) {
      throw new Error(
        `mt_batch_balance_of: unreadable balance for ${intentsTokenIds[i]}: ${JSON.stringify(value)}`
      );
    }
    return BigInt(value);
  });
}

/**
 * Whether `intents.near` has burnt `nonceBase64` for `accountId` — i.e. an envelope signed with
 * it executed — and whether the nonce's salt is still valid (D-312). The pair is read together
 * because neither answers alone: once a salt is invalidated the Verifier may sweep its nonces,
 * and `false` stops being evidence of anything. Same pair the solver's reconciler reads.
 *
 * Head first, then both views pinned to it (D-556, solver `chain-evidence.rpc.ts`), so the two
 * answers and `blockTimestampMs` describe one block. That clock is what makes `false` mean
 * something: a node hours behind answers "not used" for a nonce burnt since, and only the age of
 * the block it read at gives that away. A node without the pinned block answers with an error.
 *
 * Fails CLOSED: anything but two booleans throws, and the caller treats a throw as "cannot
 * tell" — never as "not used".
 *
 * Attribution: see ATTRIBUTIONS.md #25.
 */
export async function readNonceWitness(
  accountId: string,
  nonceBase64: string,
  saltHex: string
): Promise<{ nonceUsed: boolean; saltValid: boolean; blockTimestampMs: number }> {
  const head = await readFinalHead();
  const at = { blockHash: head.hash };
  const [nonceUsed, saltValid] = await Promise.all([
    viewCall<unknown>(INTENTS_CONTRACT_ID, "is_nonce_used", { account_id: accountId, nonce: nonceBase64 }, at),
    viewCall<unknown>(INTENTS_CONTRACT_ID, "is_valid_salt", { salt: saltHex }, at),
  ]);
  if (typeof nonceUsed !== "boolean" || typeof saltValid !== "boolean") {
    throw new Error(
      `nonce witness: expected two booleans, got ${JSON.stringify(nonceUsed)} / ${JSON.stringify(saltValid)}`
    );
  }
  return { nonceUsed, saltValid, blockTimestampMs: head.timestampMs };
}
