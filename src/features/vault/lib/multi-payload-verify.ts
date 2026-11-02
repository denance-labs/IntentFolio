// Server-side mirror of the Verifier's MultiPayload checks (017-2, D-365): who signed an
// envelope, and what the envelope says. SERVER ONLY (node:crypto).
//
// The relayer uses this to decide whether to pay the gas for a vault commit — the one
// destination with no free dry run (`intents.near` has `simulate_intents`; the vault does
// not). It is a GAS GUARD, not the authority: the contract re-verifies everything, so a
// disagreement between this file and the chain costs gas or refuses a user, never funds.
// That asymmetry sets the failure mode: anything this file does not recognise is `null`
// (refused), and the families the app does not produce (webauthn) are refused outright.
//
// Each scheme mirrors its defuse crate at the rev the vault pins (`6cfce73`):
//   nep413      sha256(borsh(u32 2^31+413, {message, nonce[32], recipient, callbackUrl?})), ed25519
//   erc191      keccak256("\x19Ethereum Signed Message:\n" + len + payload), secp256k1 recover
//   tip191      keccak256("\x19TRON Signed Message:\n" + len + payload),     secp256k1 recover
//   raw_ed25519 ed25519 over the payload bytes themselves
//   sep53       sha256("Stellar Signed Message:\n" + payload), ed25519
//   ton_connect sha256(0xffff‖"ton-connect/sign-data/"‖wc‖addr‖len‖domain‖ts‖"txt"‖len‖text), ed25519
// secp256k1 follows NEAR's `ecrecover(…, malleability_flag = true)`: the recovery byte is 0/1
// and a high-s signature is refused. The SDK normalises v to 0/1 before it reaches the wire
// (`transformERC191Signature`), so a 27/28 here was not produced by the app.
//
// Attribution: see ATTRIBUTIONS.md #8 (defuse-core MultiPayload schemes @ 6cfce73).

import { createHash } from "node:crypto";
import bs58 from "bs58";
import { Address } from "@ton/core";
import { PublicKey } from "near-api-js";
import { keccak256, recoverPublicKey, toHex } from "viem";

export type SignerKey = { curve: "ed25519" | "secp256k1"; bytes: Uint8Array };

/** The envelope fields every scheme carries, plus the application message around them. */
export type DefuseEnvelope = {
  signerId: string;
  verifyingContract: string;
  /** Raw, as signed: an ISO string today; the legacy `{timestamp}` form is not interpreted. */
  deadline: unknown;
  /** The 32-byte nonce. */
  nonce: Uint8Array;
  /** Everything else in the signed message: `{intents}` for the Verifier, the change set for a commit. */
  message: Record<string, unknown>;
};

const ED25519_KEY_LEN = 32;
const ED25519_SIG_LEN = 64;
const SECP256K1_SIG_LEN = 65;
// secp256k1 group order n, and n/2: NEAR's malleability flag refuses s > n/2.
const SECP256K1_N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
const SECP256K1_HALF_N = SECP256K1_N / BigInt(2);

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(...parts: Uint8Array[]): Uint8Array {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return new Uint8Array(hash.digest());
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

function u32(value: number, littleEndian: boolean): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, littleEndian);
  return out;
}

function borshString(s: string): Uint8Array[] {
  const bytes = utf8(s);
  return [u32(bytes.length, true), bytes];
}

/**
 * `curve:base58` (or bare base58, which the contract also accepts) of an exact length.
 * Case-insensitive curve name, like defuse-crypto's `parse_base58`.
 */
function parseCurveBytes(value: unknown, curve: SignerKey["curve"], length: number): Uint8Array | null {
  if (typeof value !== "string") return null;
  const colon = value.indexOf(":");
  let data = value;
  if (colon !== -1) {
    if (value.slice(0, colon).toLowerCase() !== curve) return null;
    data = value.slice(colon + 1);
  }
  try {
    const bytes = bs58.decode(data);
    return bytes.length === length ? bytes : null;
  } catch {
    return null;
  }
}

function verifyEd25519(message: Uint8Array, signature: unknown, publicKey: unknown): SignerKey | null {
  const key = parseCurveBytes(publicKey, "ed25519", ED25519_KEY_LEN);
  const sig = parseCurveBytes(signature, "ed25519", ED25519_SIG_LEN);
  if (!key || !sig) return null;
  try {
    const ok = PublicKey.fromString(`ed25519:${bs58.encode(key)}`).verify(message, sig);
    return ok ? { curve: "ed25519", bytes: key } : null;
  } catch {
    return null;
  }
}

async function recoverSecp256k1(hash: Uint8Array, signature: unknown): Promise<SignerKey | null> {
  const sig = parseCurveBytes(signature, "secp256k1", SECP256K1_SIG_LEN);
  if (!sig) return null;
  const v = sig[64];
  if (v !== 0 && v !== 1) return null;
  const s = BigInt(toHex(sig.subarray(32, 64)));
  if (s === BigInt(0) || s > SECP256K1_HALF_N) return null;
  try {
    const uncompressed = await recoverPublicKey({ hash: toHex(hash), signature: toHex(sig) });
    // "0x04" + 64 bytes: the contract's key is the 64 bytes without the prefix.
    const bytes = Uint8Array.from(Buffer.from(uncompressed.slice(4), "hex"));
    return bytes.length === 64 ? { curve: "secp256k1", bytes } : null;
  } catch {
    return null;
  }
}

function eip191Hash(prefix: string, payload: string): Uint8Array {
  const body = utf8(payload);
  return Uint8Array.from(
    Buffer.from(keccak256(new Uint8Array([...utf8(`${prefix}${body.length}`), ...body])).slice(2), "hex")
  );
}

function nep413Hash(payload: Json): Uint8Array | null {
  const { message, nonce, recipient, callbackUrl } = payload;
  if (typeof message !== "string" || typeof recipient !== "string") return null;
  const nonceBytes = decodeNonce(nonce);
  if (!nonceBytes) return null;
  if (callbackUrl !== undefined && callbackUrl !== null && typeof callbackUrl !== "string") return null;
  const option = typeof callbackUrl === "string" ? [Uint8Array.of(1), ...borshString(callbackUrl)] : [Uint8Array.of(0)];
  return sha256(u32(2 ** 31 + 413, true), ...borshString(message), nonceBytes, ...borshString(recipient), ...option);
}

function tonTextHash(mp: Json): Uint8Array | null {
  const { address, domain, timestamp, payload } = mp;
  if (typeof address !== "string" || typeof domain !== "string") return null;
  if (!isObject(payload) || payload.type !== "text" || typeof payload.text !== "string") return null;
  const seconds = tonTimestamp(timestamp);
  if (seconds === null) return null;
  let parsed: Address;
  try {
    parsed = Address.parse(address);
  } catch {
    return null;
  }
  const wc = new Uint8Array(4);
  new DataView(wc.buffer).setInt32(0, parsed.workChain, false);
  const ts = new Uint8Array(8);
  new DataView(ts.buffer).setBigUint64(0, seconds, false);
  const domainBytes = utf8(domain);
  const textBytes = utf8(payload.text);
  return sha256(
    Uint8Array.of(0xff, 0xff),
    utf8("ton-connect/sign-data/"),
    wc,
    new Uint8Array(parsed.hash),
    u32(domainBytes.length, false),
    domainBytes,
    ts,
    utf8("txt"),
    u32(textBytes.length, false),
    textBytes
  );
}

/** UNIX seconds, as a number or a digit string (the two forms the contract takes that the SDK emits). */
function tonTimestamp(value: unknown): bigint | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return null;
}

function decodeNonce(value: unknown): Uint8Array | null {
  if (typeof value !== "string") return null;
  try {
    const bytes = Uint8Array.from(Buffer.from(value, "base64"));
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * Who signed this MultiPayload, or null when the signature does not verify, the shape is not
 * one of the six the app produces, or anything about it is unreadable.
 */
export async function verifyMultiPayload(mp: unknown): Promise<SignerKey | null> {
  if (!isObject(mp)) return null;
  switch (mp.standard) {
    case "nep413": {
      if (!isObject(mp.payload)) return null;
      const hash = nep413Hash(mp.payload);
      return hash ? verifyEd25519(hash, mp.signature, mp.public_key) : null;
    }
    case "erc191":
      return typeof mp.payload === "string"
        ? recoverSecp256k1(eip191Hash("\x19Ethereum Signed Message:\n", mp.payload), mp.signature)
        : null;
    case "tip191":
      return typeof mp.payload === "string"
        ? recoverSecp256k1(eip191Hash("\x19TRON Signed Message:\n", mp.payload), mp.signature)
        : null;
    case "raw_ed25519":
      return typeof mp.payload === "string" ? verifyEd25519(utf8(mp.payload), mp.signature, mp.public_key) : null;
    case "sep53":
      return typeof mp.payload === "string"
        ? verifyEd25519(sha256(utf8("Stellar Signed Message:\n"), utf8(mp.payload)), mp.signature, mp.public_key)
        : null;
    case "ton_connect": {
      const hash = tonTextHash(mp);
      return hash ? verifyEd25519(hash, mp.signature, mp.public_key) : null;
    }
    default:
      return null;
  }
}

function parseJsonObject(text: unknown): Json | null {
  if (typeof text !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The envelope a MultiPayload carries, read the way defuse-core's `extract_defuse_payload`
 * reads it. Does NOT verify the signature — pair it with `verifyMultiPayload`.
 *
 * NEP-413 is the one scheme whose envelope is split: `nonce` and `recipient` (which becomes
 * `verifying_contract`) sit next to the signed message instead of inside it.
 */
export function extractDefuseEnvelope(mp: unknown): DefuseEnvelope | null {
  if (!isObject(mp)) return null;
  let fields: Json | null;
  let verifyingContract: unknown;
  let nonce: unknown;
  switch (mp.standard) {
    case "nep413": {
      if (!isObject(mp.payload)) return null;
      fields = parseJsonObject(mp.payload.message);
      verifyingContract = mp.payload.recipient;
      nonce = mp.payload.nonce;
      break;
    }
    case "erc191":
    case "tip191":
    case "raw_ed25519":
    case "sep53":
      fields = parseJsonObject(mp.payload);
      verifyingContract = fields?.verifying_contract;
      nonce = fields?.nonce;
      break;
    case "ton_connect":
      fields = isObject(mp.payload) && mp.payload.type === "text" ? parseJsonObject(mp.payload.text) : null;
      verifyingContract = fields?.verifying_contract;
      nonce = fields?.nonce;
      break;
    default:
      return null;
  }
  if (!fields) return null;
  const nonceBytes = decodeNonce(nonce);
  if (typeof fields.signer_id !== "string" || typeof verifyingContract !== "string" || !nonceBytes) return null;

  const message: Json = { ...fields };
  for (const key of ["signer_id", "verifying_contract", "deadline", "nonce"]) delete message[key];
  return {
    signerId: fields.signer_id,
    verifyingContract,
    deadline: fields.deadline,
    nonce: nonceBytes,
    message,
  };
}

/** `ed25519:…` / `secp256k1:…` — the form `has_public_key` takes. */
export function formatSignerKey(key: SignerKey): string {
  return `${key.curve}:${bs58.encode(key.bytes)}`;
}

/**
 * The implicit account a key controls: hex of the key (NEAR-implicit, every ed25519 family)
 * or `0x` + the last 20 bytes of keccak256(key) (ETH-implicit, EVM and Tron). Same rule as
 * defuse-core's `to_implicit_account_id`, which the vault uses to bind a signer.
 */
export function implicitAccountId(key: SignerKey): string {
  if (key.curve === "ed25519") return Buffer.from(key.bytes).toString("hex");
  return `0x${keccak256(key.bytes).slice(-40)}`;
}

/**
 * Whether an account id is one of the two implicit forms — the only ones whose key is fixed
 * by the id itself. Anything else (a named account) needs the Verifier's key registry.
 */
export function isImplicitAccountId(accountId: string): boolean {
  return /^[0-9a-f]{64}$/.test(accountId) || /^0x[0-9a-f]{40}$/.test(accountId);
}
