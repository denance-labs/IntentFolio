// Reads whether a NEAR account has authorised a given public key on `intents.near`
// (008.plan D-280, block B1). Read-only: no funds move and nothing is signed here. The
// registration transaction itself is B3.
//
// Why this exists, measured in mainnet (s132) and not inferred: a NEAR account WITH A NAME
// cannot sign intents until its public key is registered. A NEP-413 envelope that is
// cryptographically valid but declares an unregistered key is rejected by the Verifier with
// `public key '…' doesn't exist for account '…'`. The control run — the same envelope with
// an IMPLICIT account as signer — was accepted, which is what draws the line below.
//
// The RPC path is the vault's shared `viewCall` on purpose: it already fails closed (a wasm
// panic, an empty result and an RPC error all throw rather than decode into a value), and a
// fourth private copy of the same POST is exactly what its header asks callers not to add.
//
// Attribution: see ATTRIBUTIONS.md #15 (the `intents.near` key-registration surface).

import { viewCall } from "@/features/vault/lib/near-view";
import { INTENTS_CONTRACT_ID } from "@/features/wallet/config/network";
import type { ChainKind } from "../types";

/**
 * The answer to "can this key sign intents for this account?".
 *
 * 🔴 Four outcomes, and the three RPC ones are NOT two. A read that did not complete is
 * `unknown`: calling it `not-registered` sends the user to sign a transaction they may not
 * need, and calling it `registered` lets them through to the money path on an assumption.
 * `not-required` is the only outcome produced without touching the network.
 */
export type KeyRegistrationStatus =
  | "not-required"
  | "registered"
  | "not-registered"
  | "unknown";

/**
 * A NEAR implicit account id: exactly 64 LOWERCASE hex characters, which are the public key
 * itself. Uppercase is deliberately not accepted — NEAR account ids are lowercase, so an
 * uppercase 64-hex string is not an implicit account, and anything this pattern rejects
 * falls through to the on-chain check. That is the safe direction: the cost of checking an
 * account that did not need it is one view call, the cost of skipping the check on an
 * account that needed it is a rejected intent the user cannot explain.
 */
const NEAR_IMPLICIT_ACCOUNT_ID = /^[0-9a-f]{64}$/;

/**
 * Whether this identity needs a key registered on `intents.near` before it can operate.
 *
 * Pure and synchronous — callers use it BEFORE asking for a signature, which matters
 * because learning which key a NEAR wallet signs with costs a NEP-413 prompt (B0 measured
 * that Meteor and Intear report `publicKey: null` up front, so there is no free source).
 *
 * False for the five non-NEAR families and for NEAR implicit accounts: there the intents id
 * derives from the address or the pubkey itself (`identity.ts`), so the contract can
 * authenticate them on its own.
 */
export function requiresKeyRegistration(chainKind: ChainKind, accountId: string): boolean {
  if (chainKind !== "near") return false;
  return !NEAR_IMPLICIT_ACCOUNT_ID.test(accountId);
}

/**
 * Asks `intents.near` whether `publicKey` is registered for `accountId`.
 *
 * 🔴 THE EXACT KEY, never "is the list empty?" and never "does it have any FullAccess
 * registered?". Registration is additive and per key, and a named account holds a LIST of
 * access keys: `pablofork.near` has three FullAccess keys and exactly one of them
 * registered (measured). An account can hold two registered keys and sign with a third,
 * and be rejected all the same.
 *
 * 🔴 Pass the key you SAW SIGN. A key the wallet merely reported may not be the one it
 * signs with, and believing it fails open in both directions: as a check it waves through a
 * key the Verifier will reject, and as a registration it writes an on-chain authorisation
 * for a key nobody asked to authorise.
 *
 * The RESULT is never cached: every restored session re-runs this view call. The public
 * `(account, wallet, key)` tuple previously observed signing may be persisted so a reload
 * can name the exact pair without another prompt; changing wallet or a connector-reported
 * key invalidates that proof before this function runs.
 */
export async function checkKeyRegistration(input: {
  chainKind: ChainKind;
  accountId: string;
  publicKey: string;
}): Promise<KeyRegistrationStatus> {
  const { chainKind, accountId, publicKey } = input;

  if (!requiresKeyRegistration(chainKind, accountId)) return "not-required";

  // No key, no answer. `unknown` rather than a throw so an unhandled rejection cannot take
  // out the caller's UI, and rather than `not-registered` so a caller that lost the key
  // never offers a registration transaction for a key it cannot name.
  if (!publicKey) return "unknown";

  try {
    const registered = await viewCall<unknown>(INTENTS_CONTRACT_ID, "has_public_key", {
      account_id: accountId,
      public_key: publicKey,
    });
    // A shape we did not expect is not a `false`. `viewCall` JSON-parses whatever the
    // contract returned, so coercing here would turn a changed ABI into a confident answer.
    if (typeof registered !== "boolean") return "unknown";
    return registered ? "registered" : "not-registered";
  } catch (e) {
    // Swallowed into `unknown` by design, but never silently: a tester stuck on this gate
    // leaves no other trace.
    console.warn("[near-key-registration] has_public_key read failed:", e);
    return "unknown";
  }
}
