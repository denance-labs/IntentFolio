// The vault's Allocate idempotency seal, read from the browser (009.plan FE #4, `922` H4).
//
// `apply_allocation` (contract `allocate.rs`) is the ONE funnel every credit goes through —
// `on_auth`, `claim_orphan_transfer` and `credit_pending_allocation` alike — and it ends by
// writing `allocate_idempotency[(signer_id, sha256(msg))] = deadline`. So the seal's presence
// under a record's exact key is the fact "this msg was credited", per record, byte for byte,
// unaffected by later swaps, withdrawals or portfolio deletion. It is the same question the
// solver's orphan resolver asks (`chain.already_sealed`), which keeps the two sides consistent
// by construction: what the FE flips to `credited` is exactly what the resolver would skip.
//
// The ONE dangerous direction is reporting `sealed` for a record that was not credited: it
// leaves the rescue worklist with nobody watching it. Hence the three-way answer below —
// `unreadable` is its own value, and NOTHING collapses into `sealed` except a view answer that
// carries the seal's deadline.
//
// Read through the vault's own view, `get_allocate_seal(signer_id, msg)` (017-9a, D-302 d). It
// takes the raw `msg` and hashes it the way the contract seals, so the client neither hashes
// nor knows the storage layout. `msg` is the RAW record column, byte for byte: a re-serialised
// msg is a different seal (D-160).
//
// Attribution: see ATTRIBUTIONS.md #8.

import { getAllocateSeal, type AllocateSealView } from "./vault-read-client";

/** Base64 of raw bytes. NOT `btoa(string)`, which throws past 0xFF (`922` H9). */
export function toPrefixBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export type SealRead =
  | { kind: "sealed"; deadlineSecs: number | null }
  | { kind: "unsealed" }
  | { kind: "unreadable"; reason: string };

/**
 * Whether the vault holds the seal for `(signerId, msg)`. Never throws.
 *
 * The view answers `null` (no credit route applied this msg) or the seal. Anything else — a
 * failed read, a value without a numeric deadline — is `unreadable`, never `sealed`. The
 * deadline is display only: presence is the fact. The injected view is for tests.
 */
export async function readAllocateSeal(
  signerId: string,
  msg: string,
  view: (signerId: string, msg: string) => Promise<AllocateSealView | null> = getAllocateSeal
): Promise<SealRead> {
  let seal: AllocateSealView | null;
  try {
    seal = await view(signerId, msg);
  } catch (e) {
    return { kind: "unreadable", reason: e instanceof Error ? e.message : String(e) };
  }
  if (seal === null) return { kind: "unsealed" };
  if (typeof seal !== "object" || typeof seal.deadline !== "number") {
    return { kind: "unreadable", reason: "get_allocate_seal answered an unknown shape" };
  }
  return { kind: "sealed", deadlineSecs: seal.deadline };
}
