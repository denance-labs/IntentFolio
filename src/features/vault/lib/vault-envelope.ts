// NEP-413 envelope builders that wrap the money-critical vault bodies (vault-payloads.ts)
// into the exact signed structures the on-chain flows verify (007.plan, Phase 0). These
// produce the pre-signing artifact a NEAR wallet signs; the canonical MultiPayload is then
// assembled from the wallet's signature by `prepareSwapSignedData` (internal-utils) — see
// the sibling test for the offline assembly + validation against contract-types validators.
//
// Ground truth mirrored byte-for-byte: contract/crates/vault/tests/common/mod.rs
// (`sign_transfer_and_authcall` = Allocate, `sign_commit` = Unallocate) and the nonce layout
// in defuse-core nonce/{versioned,salted,expirable}.rs @ rev 6cfce73. A single wrong field
// here orphans or bricks funds, so every shape below is pinned to a live contract source.
//
// Two things the 007.plan's first sketch got wrong and this module corrects (both verified
// in source, not assumed):
//   1. BOTH paths sign a *versioned* permit2 nonce (VersionedNonce::V1), NOT the SDK's
//      `randomDefuseNonce()` (32 random bytes). Commit REQUIRES it — the vault rejects a
//      legacy nonce with E_UNSUPPORTED_NONCE_FORMAT (crypto.rs check_v1_deadline).
//   2. The commit envelope's `recipient` (=> DefusePayload.verifying_contract) is the VAULT,
//      not `intents.near`; there is no Verifier in the commit loop (crypto.rs check_envelope
//      asserts verifying_contract == current_account_id). So `makeSwapMessage`, which hardcodes
//      `config.env.contractID`, cannot be reused for commit — we assemble the inner message here.

// Attribution: see ATTRIBUTIONS.md #8 (vault contract source + defuse-core nonce layout +
// contract-types / internal-utils canonical envelope).
import type { Intent } from "@defuse-protocol/contract-types";
import { INTENTS_CONTRACT_ID } from "@/features/wallet/config/network";
import { STORAGE_COST_MEMO, STORAGE_COST_RECEIVER } from "./storage-cost";

// ── Versioned V1 permit2 nonce ───────────────────────────────────────────────
// Layout (defuse-core nonce/versioned.rs, borsh, little-endian ints):
//   MAGIC(4) || VERSION(1)=0x00 || SALT(4) || DEADLINE(8, i64 LE nanoseconds) || RANDOM(15)
// = 32 bytes. The vault parses SALT but ignores it (no SaltRegistry in the MVP), so a fixed
// zero salt is valid for commit; the Verifier (Allocate) DOES validate it, so Allocate must
// pass its live `current_salt`.
export const VERSIONED_NONCE_MAGIC = Uint8Array.of(0x56, 0x28, 0xf6, 0xc6);
const V1_DISCRIMINANT = 0x00;

// Fixed salt for the commit path: the vault does not validate it (crypto.rs note). Mirrors
// the Rust helper's `"00000000".parse::<Salt>()`.
export const COMMIT_NONCE_SALT = Uint8Array.of(0, 0, 0, 0);

export type BuildV1NonceParams = {
  deadlineSecs: number; // embedded deadline; the vault compares it to block time (commit)
  salt?: Uint8Array; // 4 bytes; defaults to COMMIT_NONCE_SALT
  tail?: Uint8Array; // 15 random bytes; injectable for deterministic tests
};

export function buildVersionedV1Nonce(params: BuildV1NonceParams): Uint8Array {
  const salt = params.salt ?? COMMIT_NONCE_SALT;
  if (salt.length !== 4) throw new Error(`V1 nonce salt must be 4 bytes, got ${salt.length}`);
  const tail = params.tail ?? crypto.getRandomValues(new Uint8Array(15));
  if (tail.length !== 15) throw new Error(`V1 nonce tail must be 15 bytes, got ${tail.length}`);

  const nonce = new Uint8Array(32);
  nonce.set(VERSIONED_NONCE_MAGIC, 0); // [0, 4)
  nonce[4] = V1_DISCRIMINANT; // [4] — borsh enum discriminant for V1
  nonce.set(salt, 5); // [5, 9)
  // Deadline: i64 nanoseconds, little-endian (borsh). Written at [9, 17).
  new DataView(nonce.buffer).setBigInt64(9, BigInt(params.deadlineSecs) * BigInt(1_000_000_000), true);
  nonce.set(tail, 17); // [17, 32)
  return nonce;
}

/**
 * The inverse of `buildVersionedV1Nonce`, for reading a stored nonce back (D-312): its salt as
 * the 8 hex chars `is_valid_salt` takes, and its embedded deadline in seconds. `null` for
 * anything that is not a 32-byte V1 nonce — a caller must then treat the nonce as no witness.
 */
export function decodeV1Nonce(nonceBase64: string): { saltHex: string; deadlineSecs: number } | null {
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(nonceBase64), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  if (bytes.length !== 32) return null;
  if (!VERSIONED_NONCE_MAGIC.every((b, i) => bytes[i] === b) || bytes[4] !== V1_DISCRIMINANT) {
    return null;
  }
  const saltHex = Array.from(bytes.slice(5, 9), (b) => b.toString(16).padStart(2, "0")).join("");
  const deadlineNs = new DataView(bytes.buffer).getBigInt64(9, true);
  return { saltHex, deadlineSecs: Number(deadlineNs / BigInt(1_000_000_000)) };
}

// ── Inner NEP-413 message (the string a wallet signs) ────────────────────────
// Mirrors defuse-core's `Nep413DefuseMessage { signer_id, deadline, #[serde(flatten)] message }`.
// `recipient` becomes `DefusePayload.verifying_contract` on-chain; `nonce` is the 32-byte
// versioned nonce (base64-encoded only at MultiPayload assembly time, by the SDK).
export type Nep413SignRequest = {
  message: string; // JSON string of the inner message — signed verbatim, re-parsed by serde
  recipient: string; // => verifying_contract: intents.near for Allocate, the vault for commit
  nonce: Uint8Array; // 32-byte versioned V1 nonce
};

// Deadline crosses as an ISO-8601 string (contract-types `Deadline = string`; the SDK's
// messageFactory emits the same). The object form `{timestamp}` is rejected by the schema.
function deadlineIso(deadlineSecs: number): string {
  return new Date(deadlineSecs * 1000).toISOString();
}

// ── The SAME envelope, in ERC-191 form ───────────────────────────────────────
// NOT a cosmetic variant of the NEP-413 request: the two schemes sign DIFFERENT STRINGS.
//
// A MultiPayloadNep413 carries `nonce` and `recipient` as sibling fields next to the
// signed `message`, so the NEP-413 message only needs {signer_id, deadline, ...body}.
// The erc191 MultiPayload has no such fields — `prepareSwapSignedData` emits exactly
// `{standard, payload, signature}` and passes the signed string through verbatim
// (prepareBroadcastRequest.ts, case "ERC191"). So for erc191 the nonce and the
// verifying_contract MUST live INSIDE the signed JSON, or they never reach the contract.
//
// That flattened object is `DefusePayload` — the same struct the contract extracts for
// every scheme (defuse-core payload/mod.rs). Mirrors the SDK's own `makeSwapMessage`
// (internal-utils messageFactory.ts), including its 2-space pretty-print: what a wallet
// shows the user and what goes on the wire must be byte-identical, so the formatting is
// part of the contract with the signer, not a style choice.
//
// Used by every non-NEAR family, not just EVM: erc191 is the scheme our EVM adapter
// produces, and the vault verifies all 7 schemes through `recover_signer` (crypto.rs).
export type BuildErc191Params = {
  signerId: string; // the INTENTS account id (0x… lowercase for EVM), not the raw address
  verifyingContract: string; // intents.near for Allocate, the vault for commit
  deadlineSecs: number;
  nonce: Uint8Array; // the same 32-byte versioned V1 nonce the NEP-413 path builds
  /** `{ intents }` for Allocate; the flattened PortfolioChangeSet for commit. */
  body: Record<string, unknown>;
};

/** Standard base64 with padding — what `@scure/base`'s `base64.encode` (used by the SDK
 *  on the NEP-413 path) produces, so both schemes put the same bytes on the wire. */
function base64FromBytes(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

export function buildErc191Payload(p: BuildErc191Params): string {
  // Key order mirrors the SDK's makeSwapMessage payload. JSON objects are unordered by
  // spec, but the signed bytes are not: whatever order this emits is what gets signed and
  // what the wallet displays, so it is pinned here rather than left to call-site spread.
  return JSON.stringify(
    {
      signer_id: p.signerId,
      verifying_contract: p.verifyingContract,
      deadline: deadlineIso(p.deadlineSecs),
      nonce: base64FromBytes(p.nonce),
      ...p.body,
    },
    null,
    2
  );
}

export type BuildAllocateParams = {
  signerId: string;
  /** Envelope deadline: the Verifier's submission window (NEP-413 `deadline`). */
  deadlineSecs: number;
  /** Deadline embedded in the V1 nonce. NOT the envelope's — see the note on the builder.
   *  Must be >= `deadlineSecs`, or the Verifier rejects the payload. */
  nonceDeadlineSecs: number;
  salt: Uint8Array; // intents.near `current_salt` (live) — the Verifier validates it
  vaultId: string; // Transfer receiver + AuthCall callee
  /** One entry per funded token; base units as decimal strings. */
  transfers: Array<{ tokenId: string; amount: string }>;
  authCallMsg: string; // from buildAuthCallSetupMsg / buildAuthCallAllocateIntoMsg (golden-pinned)
  /**
   * A Setup's Storage Cost (D-528): one token, in base units, sent to the ops account in the
   * SAME envelope. Absent for an AllocateInto, which never charges it.
   */
  storage?: { tokenId: string; amount: string };
  nonceTail?: Uint8Array;
};

/**
 * `min_gas` of the Allocate's `auth_call` (D-302 m): the gas the Verifier reserves for the
 * vault's `on_auth`, on top of a share of what is left over. Without it the Verifier's default
 * is 10 TGas, which covers a one-token portfolio (≈ 4 TGas) and nothing bigger — it works today
 * only because the relayer attaches 300 TGas and the leftover reaches `on_auth`, which the
 * Verifier does not promise. 65 TGas = the worst case measured by the contract's step 1.9
 * (a maximal AllocateInto, 47.7 TGas) plus a third, rounded to 5; unused gas is refunded.
 * v1 and v2 alike: it is a Verifier field, and staging proves it against the live Verifier
 * before the cut-over. A string, as `NearGas` serialises (it also parses a number).
 */
export const AUTH_CALL_MIN_GAS = "65000000000000";

// The AuthCallMsg deadline is NOT the envelope's, and the gap is deliberate (ADR-0017 §1).
// The envelope's 600s is a submission window: it bounds how long a signed payload may sit
// before the Verifier takes it. This one is the vault's own gate on the *rescue* routes
// (`apply_allocation` panics with E_EXPIRED_DEADLINE once `deadline < now`,
// `allocate.rs:99`), so it bounds how long an ORPHANED allocate stays recoverable. Sharing
// one value made every orphan unrescuable ten minutes after signing.
//
// 72h covers a full weekend. The contract sets no upper bound on it (the relay does, from
// this same value: relay-gate.ts, D-371); the cost is that the ~70-byte idempotency seal
// stays until the deadline passes and `gc_allocate_idempotency` can purge it
// (`allocate.rs:505-515`), i.e. three days instead of ten minutes. Defined here, not in
// allocate-submit.ts, because the relay reads it too.
export const AUTH_CALL_TTL_SECS = 72 * 60 * 60;

// ② Allocate: a `[Transfer, AuthCall]` executed by intents.near's execute_intents, whose
// AuthCall fires the vault's on_auth. The Transfer moves the General Balance into the vault;
// the AuthCall carries the Setup body; a Setup adds a third intent, its Storage Cost (D-528).
// Returns the sign-request plus the raw intents (for offline per-intent validation).
//
// ONE Transfer carries EVERY token (008.plan Phase 2): `TransferIntent.tokens` is a
// `token_id → amount` map, so multi-token funding needs no second intent and no second
// signature. Splitting it into one Transfer per token would also be wrong — the vault reads
// the credited legs from a single settled Transfer.
//
// TWO deadlines, deliberately decoupled (ADR-0017 §5 as amended; solver `922` §3.4 #1):
//   - `deadlineSecs` goes into the signed envelope and bounds SUBMISSION (10 min);
//   - `nonceDeadlineSecs` goes into the V1 nonce bytes and bounds how long the Verifier
//     keeps the nonce as a *used* one. `is_nonce_used` is the rescue's proof that an
//     orphaned Allocate did execute, and the Verifier may sweep a used V1 nonce any time
//     after ITS deadline — so a nonce that expired with the envelope stopped proving
//     anything ten minutes into a 72h rescue window. It must outlive the rescue window
//     plus the solver's witness window.
// The Verifier enforces `nonce deadline >= envelope deadline` (`deadline is greater than
// nonce`, probed on mainnet in `921` §2) and does not require them to be equal.
export function buildAllocateSignRequest(p: BuildAllocateParams): {
  request: Nep413SignRequest;
  /** The same envelope for non-NEAR families. Built here, next to its NEP-413 twin, so
   *  the two can never drift into signing different intents or different deadlines. */
  erc191Message: string;
  intents: Intent[];
} {
  if (p.transfers.length === 0) throw new Error("Allocate envelope needs at least one transfer");
  // Fail here, not at the Verifier: a rejected envelope is harmless, but a caller that
  // silently fed the envelope deadline to the nonce would re-open the ten-minute hole.
  if (p.nonceDeadlineSecs < p.deadlineSecs) {
    throw new Error(
      `Allocate nonce deadline (${p.nonceDeadlineSecs}) must not precede the envelope deadline (${p.deadlineSecs})`
    );
  }
  // A duplicate token id would SILENTLY COLLAPSE in the object literal below — the last
  // entry wins and the user signs an amount they never asked for. Money-critical, so it is
  // a throw and not a merge: two legs for one token is a caller bug, not an intent.
  const tokens: Record<string, string> = {};
  for (const t of p.transfers) {
    if (tokens[t.tokenId] !== undefined) {
      throw new Error(`Duplicate token in allocate transfer: ${t.tokenId}`);
    }
    tokens[t.tokenId] = t.amount;
  }

  const intents: Intent[] = [
    { intent: "transfer", receiver_id: p.vaultId, tokens },
    { intent: "auth_call", contract_id: p.vaultId, msg: p.authCallMsg, min_gas: AUTH_CALL_MIN_GAS },
  ];
  // The Storage Cost goes LAST, so the auth_call stays at index 1 for every reader that expects
  // it there. Its position changes nothing on-chain: `execute_intents` runs the intents in order
  // in one receipt and reverts them all if any fails, and the auth_call's promise is dispatched
  // only if that receipt succeeds — a storage transfer that cannot be paid can strand nothing.
  // No `msg`: it would call `mt_on_transfer` on an account without a contract.
  if (p.storage) {
    if (!/^[1-9]\d*$/.test(p.storage.amount)) {
      throw new Error(`Storage cost must be a positive amount of base units, got ${p.storage.amount}`);
    }
    intents.push({
      intent: "transfer",
      receiver_id: STORAGE_COST_RECEIVER,
      tokens: { [p.storage.tokenId]: p.storage.amount },
      memo: STORAGE_COST_MEMO,
    });
  }
  const inner = {
    signer_id: p.signerId,
    deadline: deadlineIso(p.deadlineSecs),
    intents,
  };
  const nonce = buildVersionedV1Nonce({
    deadlineSecs: p.nonceDeadlineSecs,
    salt: p.salt,
    tail: p.nonceTail,
  });
  return {
    request: { message: JSON.stringify(inner), recipient: INTENTS_CONTRACT_ID, nonce },
    erc191Message: buildErc191Payload({
      signerId: p.signerId,
      verifyingContract: INTENTS_CONTRACT_ID,
      deadlineSecs: p.deadlineSecs,
      nonce,
      body: { intents },
    }),
    intents,
  };
}

export type BuildCommitParams = {
  signerId: string;
  deadlineSecs: number;
  vaultId: string; // recipient => verifying_contract must be the vault
  changeSet: Record<string, unknown>; // from buildUnallocateChangeSet
  salt?: Uint8Array; // defaults to COMMIT_NONCE_SALT (vault ignores it)
  nonceTail?: Uint8Array;
};

// ③ Unallocate: a `commit_portfolio_changes` submitted straight to the vault (no Verifier).
// The PortfolioChangeSet is flattened next to signer_id + deadline, exactly as defuse-core's
// `Nep413DefuseMessage` `#[serde(flatten)]` does on the Rust side (tests/common `sign_commit`).
export function buildCommitSignRequest(p: BuildCommitParams): {
  request: Nep413SignRequest;
  /** Non-NEAR form. `verifying_contract` is the VAULT here, not intents.near — the commit
   *  has no Verifier in the loop and `check_envelope` asserts it (crypto.rs:137). */
  erc191Message: string;
} {
  const inner = {
    signer_id: p.signerId,
    deadline: deadlineIso(p.deadlineSecs),
    ...p.changeSet,
  };
  const nonce = buildVersionedV1Nonce({
    deadlineSecs: p.deadlineSecs,
    salt: p.salt ?? COMMIT_NONCE_SALT,
    tail: p.nonceTail,
  });
  return {
    request: { message: JSON.stringify(inner), recipient: p.vaultId, nonce },
    erc191Message: buildErc191Payload({
      signerId: p.signerId,
      verifyingContract: p.vaultId,
      deadlineSecs: p.deadlineSecs,
      nonce,
      body: p.changeSet,
    }),
  };
}
