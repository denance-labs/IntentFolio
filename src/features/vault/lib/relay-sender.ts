// The relayer's sender (D-329, D-330, 017-1): sign one transaction, send it ONCE, and say what
// the answer proves. SERVER ONLY — it holds the relayer's FunctionCall keys.
//
// The contract with `handleRelayRequest` (relay-service.ts) lives in the throws:
//   - resolves with the execution outcome — the chain ran the tx (a revert is still an answer);
//   - throws `RelayOutcomeUnknownError` once the tx may have left and the answer proves nothing;
//   - throws anything else only when nothing ran: a read or the signing failed before the send,
//     or the node refused the tx at validation (every attempt refused for its nonce, or any other
//     refusal — an exhausted allowance, an expired block hash; relay-rpc-provider.ts).
//
// The one retry left is a RE-SIGN on InvalidNonce, and it is bounded. That refusal proves the
// tx never ran: another relay request on the same key took the nonce first (two users at once).
// With a single POST per signed tx there is no earlier copy of THIS tx that could have taken it,
// which is exactly what made near-api-js's own re-sign unsafe (it re-posted first, D-329).
//
// The key pool (D-367) makes the collision rare instead of serial: each target holds several
// keys, each with its own nonce. A send starts on a random one — instances share no memory, so
// there is nothing to coordinate — and a re-sign moves to the NEXT key, off the one that just
// lost the race. A pool of one behaves exactly as before.

import { createHash } from "node:crypto";
import { Account, actions, baseEncode, encodeTransaction, type KeyPairString } from "near-api-js";
import { RelayOutcomeUnknownError, type RelaySender } from "./relay-service";
import type { RelayRpc } from "./relay-rpc-provider";
import type { RelayTarget } from "./relay-types";

/** Re-signs allowed after an InvalidNonce refusal, on top of the first attempt. */
export const RELAY_MAX_RESIGNS = 2;

export function createRelaySender({
  accountId,
  privateKeys,
  rpc,
  log = (line) => console.warn(line),
  random = Math.random,
}: {
  accountId: string;
  privateKeys: Record<RelayTarget, string[]>;
  rpc: RelayRpc;
  log?: (line: string) => void;
  /** Picks the starting key; injected in tests. */
  random?: () => number;
}): RelaySender {
  return async ({ target, receiverId, methodName, args, gas }) => {
    const pool = privateKeys[target];
    const start = Math.floor(random() * pool.length);
    for (let attempt = 0; ; attempt++) {
      // A fresh Account per attempt: its nonce cache must not survive an InvalidNonce.
      // NEAR FunctionCall permissions carry one receiver, so each target has its own keys.
      // Attribution: see ATTRIBUTIONS.md #16.
      const key = pool[(start + attempt) % pool.length] as KeyPairString;
      const account = new Account(accountId, rpc.provider, key);
      const signed = await account.createSignedTransaction({
        receiverId,
        actions: [actions.functionCall(methodName, args, BigInt(gas), BigInt(0))],
      });
      // The hash the signer signed (signer.js: sha256 of the borsh transaction), known before
      // anything is sent — so even an unanswered send can be followed on the explorer.
      const txHash = baseEncode(createHash("sha256").update(encodeTransaction(signed.transaction)).digest());

      const result = await rpc.sendOnce(Buffer.from(encodeTransaction(signed)).toString("base64"));
      if (result.kind === "outcome") return result.outcome;
      if (result.kind === "unknown") throw new RelayOutcomeUnknownError(result.error, txHash);
      // Refused before running, and a new nonce would not change the reason.
      if (result.kind === "rejected") throw new Error(result.error);

      if (attempt >= RELAY_MAX_RESIGNS) {
        // Every attempt was refused before running: nothing moved, signing again is safe.
        throw new Error(`${result.error} (${attempt + 1} attempts)`);
      }
      log(`[relay] ${target} tx=${txHash} refused for its nonce — re-signing (${attempt + 1}/${RELAY_MAX_RESIGNS})`);
    }
  };
}
