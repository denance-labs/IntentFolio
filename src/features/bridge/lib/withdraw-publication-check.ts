// D-463 — what happened to a withdrawal whose page stopped watching between the publish and the
// settlement.
//
// Measured s254 (023 §1): a `published` record from 2026-09-30 sat "in progress" for nine days
// while the money had arrived two seconds after the publish. Nothing re-checked `publishing` or
// `published` on load, and by then the relay answered `NOT_FOUND_OR_NOT_VALID` for the intent
// hash — it forgets. `intents.near` does not: `is_nonce_used` still answered `true` for that
// withdrawal's nonce (and `false` for a random control).
//
// So the relay is a shortcut — it is the only source of the settlement tx hash, which a bridged
// route needs to wait for delivery — and the nonce is the proof:
//
//   nonce used            → the intent executed: the funds left the General Balance.
//   nonce unused, legacy, past the envelope deadline (+ margin)
//                         → it never executed and never can: the Verifier refuses an expired
//                           intent, so the balance is intact.
//   anything else         → unknown. Asked again on the next load.
//
// WHY "LEGACY" IS PART OF THE PROOF. The withdrawal signs the SDK's random 32-byte nonce
// (`randomDefuseNonce`), which carries no deadline, so the Verifier has no rule to sweep it:
// `cleanup_nonces` (role-gated) only clears a nonce `is_nonce_cleanable` parses as versioned and
// finds expired or with an invalid salt — a legacy one returns false before any check
// (near/intents `contracts/defuse/src/contract/garbage_collector.rs`, read at main 16d04f6,
// 2026-10-07; the deployed wasm was not compared). A versioned nonce past its deadline may be
// swept, and then `false` proves nothing — the caveat `allocate-never-executed.ts` guards
// against. If the withdrawal ever moves to versioned nonces, this degrades to "unknown", never to
// "failed". And the message deadline is enforced for every intent, legacy nonce or not
// (`core/src/engine/mod.rs`), so past it an unused nonce can no longer be burnt.
//
// Never throws: every unreadable answer is "unknown" (fails closed — a failed read must never
// become "the funds are intact").

import { solverRelay } from "@defuse-protocol/internal-utils";
import { viewCall } from "@/features/vault/lib/near-view";
import { VERSIONED_NONCE_MAGIC } from "@/features/vault/lib/vault-envelope";
import { INTENTS_CONTRACT_ID } from "@/features/wallet/config/network";
import type { WithdrawRescueRecord } from "./withdraw-rescue-store";

/**
 * Slack past the envelope deadline before an unused nonce counts. The deadline was stamped by
 * this browser's clock and is compared against the same clock, so a steady skew cancels out;
 * this covers the clock moving between the two and the reads lagging at FINAL.
 */
export const NEVER_EXECUTED_MARGIN_MS = 10 * 60 * 1000;

export type PublicationVerdict =
  /** The relay saw it settle, and named the settlement transaction. */
  | { kind: "settled"; txHash: string }
  /** The nonce is burnt: it executed. The transaction is not known (the relay forgot it). */
  | { kind: "executed" }
  /** Past its deadline with its nonce unused: it never ran and never will. */
  | { kind: "never-executed" }
  | { kind: "unknown"; reason: string };

export type RelayStatus =
  | { status: "PENDING" | "NOT_FOUND_OR_NOT_VALID" }
  | { status: "TX_BROADCASTED" | "SETTLED"; txHash: string };

export type PublicationCheckDeps = {
  getRelayStatus: (intentHash: string) => Promise<RelayStatus>;
  /** Must throw on anything but a boolean answer. */
  isNonceUsed: (accountId: string, nonceBase64: string) => Promise<boolean>;
  now: () => number;
};

/** Standard base64 with padding, as the SDK encodes the nonce it signs. */
export function nonceToBase64(nonce: Uint8Array): string {
  let binary = "";
  for (const byte of nonce) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeNonce(nonceBase64: string): Uint8Array | null {
  try {
    const binary = atob(nonceBase64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

function isVersionedNonce(bytes: Uint8Array): boolean {
  return VERSIONED_NONCE_MAGIC.every((b, i) => bytes[i] === b);
}

async function readIsNonceUsed(accountId: string, nonceBase64: string): Promise<boolean> {
  const used = await viewCall<unknown>(INTENTS_CONTRACT_ID, "is_nonce_used", {
    account_id: accountId,
    nonce: nonceBase64,
  });
  if (typeof used !== "boolean") {
    throw new Error(`is_nonce_used: expected a boolean, got ${JSON.stringify(used)}`);
  }
  return used;
}

export const defaultPublicationCheckDeps: PublicationCheckDeps = {
  getRelayStatus: (intentHash) => solverRelay.getStatus({ intent_hash: intentHash }),
  isNonceUsed: readIsNonceUsed,
  now: () => Date.now(),
};

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** For a `publishing` or `published` record. See the header for what each verdict proves. */
export async function checkPublication(
  record: Pick<WithdrawRescueRecord, "signerId" | "intentHash" | "nonce" | "deadline">,
  deps: PublicationCheckDeps = defaultPublicationCheckDeps
): Promise<PublicationVerdict> {
  if (record.intentHash) {
    try {
      const relay = await deps.getRelayStatus(record.intentHash);
      if (relay.status === "SETTLED") return { kind: "settled", txHash: relay.txHash };
      // Anything else is not proof either way — NOT_FOUND_OR_NOT_VALID is invalid OR forgotten,
      // and a relay still saying PENDING about an old intent must not keep it open forever. The
      // nonce decides; it already says "not yet" while the deadline has not passed.
    } catch {
      // A relay that does not answer must not hide the proof the chain has.
    }
  }

  // `typeof`, not `=== undefined`: a stored `null` (JSON turns NaN into it) would otherwise pass
  // and make every unused nonce look past its deadline.
  if (!record.nonce || typeof record.deadline !== "number" || !Number.isFinite(record.deadline)) {
    return { kind: "unknown", reason: "no nonce recorded (written before D-463)" };
  }
  const bytes = decodeNonce(record.nonce);
  if (!bytes) return { kind: "unknown", reason: "unreadable nonce" };

  let used: boolean;
  try {
    used = await deps.isNonceUsed(record.signerId, record.nonce);
  } catch (e) {
    return { kind: "unknown", reason: `is_nonce_used: ${describeError(e)}` };
  }
  // A burnt nonce is proof whatever its format and whatever the time.
  if (used) return { kind: "executed" };
  if (deps.now() <= record.deadline + NEVER_EXECUTED_MARGIN_MS) {
    return { kind: "unknown", reason: "nonce unused, deadline not passed" };
  }
  if (isVersionedNonce(bytes)) {
    return { kind: "unknown", reason: "nonce unused, but a versioned nonce may have been swept" };
  }
  return { kind: "never-executed" };
}
