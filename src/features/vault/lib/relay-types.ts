// Wire contract between the browser and `/api/relay` (008.plan, Phase 0).
//
// The relayer exists because of a hard fact about derived identity: an IntentFolio user who
// arrives with MetaMask has a row in `intents.near`'s ledger, not a NEAR account. No keys,
// no native balance, nothing to send a transaction FROM. For five of the six families the
// relayer is not the best option, it is the only one.
//
// What the relayer is NOT: a delegation mechanism (NEP-366). The signed envelope
// (`MultiPayload`) carries its own authorisation — `execute_intents` and
// `commit_portfolio_changes` are both PERMISSIONLESS, so anyone may submit one. The relayer
// is just "a server that pays the gas", which is why a single one covers all six families
// with zero per-user configuration.
//
// TWO DESTINATIONS, NOT AN ARBITRARY RPC PROXY. This is the security boundary of the whole
// feature: the caller picks a `target` from a closed set, never a receiverId/method/args, so no
// request can make the relayer transfer its balance away or call an unrelated contract. Who
// may spend its GAS is the other boundary: since 017-2 (D-365) there is no shared secret — the
// relay pays only for an envelope signed by the account it names that would pass on-chain
// (relay-gate.ts), and the FunctionCall keys' allowance is the hard ceiling.

import { INTENTS_CONTRACT_ID, VAULT_CONTRACT_ID } from "@/features/wallet/config/network";

/** ② Allocate goes to the Verifier; ③ Unallocate's commit goes to the vault. */
export type RelayTarget = "verifier" | "vault";

// 300 Tgas for both, matching the contract's own integration test. Each call fans out into
// a second contract (the vault's `on_auth`, the Verifier's `mt_batch_transfer`), so it needs
// the full budget. Single source of the number: both submit paths read it from here.
export const RELAY_GAS = "300000000000000";

export type RelayDestination = {
  receiverId: string;
  methodName: string;
  buildArgs: (payload: unknown) => Record<string, unknown>;
};

export const RELAY_DESTINATIONS: Record<RelayTarget, RelayDestination> = {
  verifier: {
    receiverId: INTENTS_CONTRACT_ID,
    methodName: "execute_intents",
    buildArgs: (payload) => ({ signed: [payload] }),
  },
  vault: {
    receiverId: VAULT_CONTRACT_ID,
    methodName: "commit_portfolio_changes",
    buildArgs: (payload) => ({ payload }),
  },
};

export function isRelayTarget(value: unknown): value is RelayTarget {
  return value === "verifier" || value === "vault";
}

export type RelayRequestBody = {
  target: RelayTarget;
  /** The already-signed MultiPayload. The relayer never signs anything on the user's behalf. */
  payload: unknown;
};

export type RelayErrorCode =
  | "bad-request"
  | "destination-mismatch"
  | "cap-exceeded"
  | "not-configured"
  // The operator paused the relay (`RELAY_PAUSED`). Nothing was checked or sent.
  | "paused"
  // The envelope would fail on-chain (relay-gate.ts): signing it again does not help.
  | "would-fail"
  // No node answered the relay's checks. Nothing was sent; signing again may work.
  | "check-failed"
  // Nothing ran: a read or the signing failed before the send, or the node refused the tx at
  // validation (the nonce kept colliding, the key's allowance ran out, …). Safe to sign again.
  | "send-failed"
  // The send went out and its answer proves nothing (cut-off, 5xx, unreadable). The tx may
  // have landed: never shown as a failure (D-329, D-330). `txHash` names it.
  | "unknown-outcome";

export type RelayResponseBody =
  | {
      ok: true;
      txHash: string | null;
      /**
       * The FULL execution outcome, handed back verbatim. Not a summary: the callers parse it
       * with `findExecutionFailure` and the vault's NEP-297 events, and an immature commit is
       * a graceful DEFER that reports SUCCESS while moving nothing. Collapsing this to a
       * boolean would erase exactly the distinction the round-trip depends on.
       */
      outcome: unknown;
      /** What this call actually cost the relayer, in NEAR. Answers "what does family X cost?". */
      gasBurntNear: string;
    }
  | {
      ok: false;
      code: RelayErrorCode;
      error: string;
      /** Only on `unknown-outcome`: the hash was known before the send, so it can be followed. */
      txHash?: string;
    };

/**
 * Sends an already-signed envelope and resolves with the raw execution outcome.
 *
 * Two implementations: the wallet's own `signAndSendTransaction` (NEAR self-submit, kept as
 * the control) and the relayer. Injecting it is what let the send be rerouted without the
 * signing paths changing by a single line.
 */
export type EnvelopeSubmitter = (input: {
  target: RelayTarget;
  payload: unknown;
}) => Promise<unknown>;

/**
 * The `verifying_contract` an envelope was signed for, or null when it cannot be read.
 *
 * Used as a pre-send guard: a bug in the routing that sent an Allocate envelope to the vault
 * (or vice versa) would be rejected on-chain anyway — `check_envelope` asserts
 * `verifying_contract == env::current_account_id()` — but rejected AFTER burning the
 * relayer's gas, and with a signature error that says nothing about the real cause.
 *
 * Deliberately schema-agnostic. The six families produce six MultiPayload shapes: NEP-413
 * nests an object with `recipient`, while ERC-191 and friends carry the payload as a JSON
 * STRING holding `verifying_contract`. Returning null for a shape we do not recognise is the
 * right failure mode — an unknown envelope is forwarded and left for the chain to judge,
 * never blocked by our incomplete knowledge of the wire format.
 */
export function extractEnvelopeRecipient(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const inner = (payload as { payload?: unknown }).payload;

  if (typeof inner === "string") {
    try {
      const parsed = JSON.parse(inner) as { verifying_contract?: unknown };
      return typeof parsed.verifying_contract === "string" ? parsed.verifying_contract : null;
    } catch {
      return null;
    }
  }

  if (inner && typeof inner === "object") {
    const obj = inner as { recipient?: unknown; verifying_contract?: unknown };
    if (typeof obj.recipient === "string") return obj.recipient;
    if (typeof obj.verifying_contract === "string") return obj.verifying_contract;
  }

  return null;
}
