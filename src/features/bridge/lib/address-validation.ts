import { isAddress, sha256 } from "viem";
import bs58 from "bs58";
import { StrKey } from "@stellar/stellar-base";
import { Address as TonAddress } from "@ton/core";
import { decodeBech32, decodeSegwitAddress } from "./bech32";

export type AddressValidationResult = {
  valid: boolean;
  errorKey?: "addressInvalid" | "addressChecksumError";
  warningKey?: "addressChecksumWarning";
};

function isAllSameCase(hex: string): boolean {
  return hex === hex.toLowerCase() || hex === hex.toUpperCase();
}

function validateEvm(address: string): AddressValidationResult {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return { valid: false, errorKey: "addressInvalid" };
  }
  const hex = address.slice(2);
  if (isAllSameCase(hex)) {
    return { valid: true, warningKey: "addressChecksumWarning" };
  }
  if (!isAddress(address)) {
    return { valid: false, errorKey: "addressChecksumError" };
  }
  return { valid: true };
}

// The protocol's account-id grammar: labels of [a-z0-9] joined by single `-`/`_`, split by dots.
const NEAR_ACCOUNT_ID = /^(?:[a-z0-9]+[-_])*[a-z0-9]+(?:\.(?:[a-z0-9]+[-_])*[a-z0-9]+)+$/;
// An ETH-implicit account (NEP-518) is also a valid-looking id, but it is what a pasted EVM
// address looks like, so it stays out of this field (`detectWrongChain` calls it "EVM", D-507).
const ETH_IMPLICIT = /^0x[a-f0-9]{40}$/;

function validateNear(address: string): AddressValidationResult {
  if (
    /^[a-z0-9._-]{2,64}\.near$/.test(address) ||
    // Implicit accounts are lowercase hex; the uppercase form is no NEAR account (D-386).
    /^[a-f0-9]{64}$/.test(address) ||
    // Other top-level accounts (HOT/Telegram `*.tg`, ...). Needs a dot so a lowercase Bitcoin or
    // Solana address cannot pass; `.near` keeps its own rule above. Whether the account exists is
    // the pre-flight's job (D-507).
    (address.length <= 64 &&
      !address.endsWith(".near") &&
      NEAR_ACCOUNT_ID.test(address) &&
      !ETH_IMPLICIT.test(address))
  ) {
    return { valid: true };
  }
  return { valid: false, errorKey: "addressInvalid" };
}

function validateSolana(address: string): AddressValidationResult {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
    return { valid: false, errorKey: "addressInvalid" };
  }
  try {
    const decoded = bs58.decode(address);
    if (decoded.length !== 32) {
      return { valid: false, errorKey: "addressInvalid" };
    }
    return { valid: true };
  } catch {
    return { valid: false, errorKey: "addressInvalid" };
  }
}

/**
 * Tron addresses are base58**check**, and the check digits are the whole point.
 *
 * The shape alone (`T` + 33 base58 chars) accepts a ONE-CHARACTER TYPO of a real address:
 * `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` and `…Lj6u` both match the pattern, and only the
 * second is not an address anybody holds. A withdrawal to it is a silent, permanent loss —
 * there is nothing downstream that catches it, because the bridge signs whatever it is given.
 *
 * So the checksum is verified the way upstream does it (`intents-sdk@0.78.0`
 * `lib/validateAddress.js:228-240`): decode, split the trailing 4 bytes, compare against
 * `sha256(sha256(payload))[0..4]`, and require the `0x41` mainnet version byte. The hex form
 * upstream also accepts is deliberately NOT accepted here — every Tron wallet in the login
 * set hands out the `T…` form (006.h8.1: `tronWeb.defaultAddress.base58`), and widening the
 * field to a shape no wallet produces would only widen what a paste error can look like.
 *
 * Attribution: see ATTRIBUTIONS.md #12.
 */
function validateTron(address: string): AddressValidationResult {
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) {
    return { valid: false, errorKey: "addressInvalid" };
  }
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(address);
  } catch {
    return { valid: false, errorKey: "addressInvalid" };
  }
  // 21 payload bytes (version + 20 address bytes) + 4 checksum bytes.
  if (decoded.length !== 25 || decoded[0] !== 0x41) {
    return { valid: false, errorKey: "addressInvalid" };
  }
  const expected = sha256(sha256(decoded.slice(0, 21), "bytes"), "bytes").slice(0, 4);
  for (let i = 0; i < 4; i++) {
    // A failed checksum is its own error, not a generic "invalid": the address is the right
    // shape, so what the user needs to hear is "re-copy it", the same as EVM's EIP-55 case.
    if (decoded[21 + i] !== expected[i]) {
      return { valid: false, errorKey: "addressChecksumError" };
    }
  }
  return { valid: true };
}

/**
 * Stellar account ids are StrKeys: base32 with a version byte and a CRC16, so a single
 * mistyped character is detectable rather than a different valid account. `StrKey` is the
 * same check `Address.fromString` runs inside `encodeHotReceiver`, hoisted here so the user
 * is told at the input instead of at signing time.
 *
 * Deliberately accepts ONLY `G…` (ed25519 account ids). A muxed `M…` address carries its own
 * memo, which would collide with the memo field this chain already requires, and a contract
 * `C…` is not a payment destination. Both are the right shape and the wrong thing.
 *
 * ⚠️ STRICTER THAN UPSTREAM, ON PURPOSE. `intents-sdk@0.76.0` `lib/validateAddress.js:257` is
 * `/^G[A-Z0-9]{55}$/` — shape only, no checksum, and an alphabet that admits `0` and `1`,
 * which base32 does not. That accepts a one-character typo of a real account: exactly the
 * failure D-214 found in our own Tron validator, still live upstream for Stellar. Following
 * it here would reintroduce the bug this project already paid to find.
 *
 * Attribution: see ATTRIBUTIONS.md #12.
 */
function validateStellar(address: string): AddressValidationResult {
  if (!StrKey.isValidEd25519PublicKey(address)) {
    return { valid: false, errorKey: "addressInvalid" };
  }
  return { valid: true };
}

/**
 * TON addresses in their friendly form: 36 bytes as 48 base64 chars — tag, workchain, the
 * 32-byte hash, and a CRC16 over all of it. The checksum is what makes a typo detectable, so
 * it is verified rather than assumed, the same as Tron's.
 *
 * Two things are rejected here that `Address.parse` accepts, and both mirror
 * `encodeHotReceiver` (hot-envelope.ts) — the encoder re-checks instead of trusting this, but
 * the two must agree or the modal would clear an address that then throws at signing time:
 *
 *   - the RAW form (`0:abcd…`). `Address.parseRaw` runs NO checksum, so it is the one TON
 *     shape where a one-character typo is undetectable, and no wallet in the login set hands
 *     it out (Tonkeeper copies `UQ…`). Same call as Tron's hex form.
 *   - TESTNET addresses (`kQ…`/`0Q…`). They are the right shape and the wrong network, and
 *     the encoded receiver keeps only workchain and hash — the test flag vanishes, leaving a
 *     valid mainnet destination for an account nobody controls.
 *
 * Attribution: see ATTRIBUTIONS.md #11 (block 4.5, where both rejections are argued).
 */
function validateTon(address: string): AddressValidationResult {
  if (!/^[A-Za-z0-9+/_-]{48}$/.test(address)) {
    return { valid: false, errorKey: "addressInvalid" };
  }
  let parsed: ReturnType<typeof TonAddress.parseFriendly>;
  try {
    parsed = TonAddress.parseFriendly(address);
  } catch {
    // The shape is right, so what the user needs to hear is "re-copy it" — the same call as
    // EVM's EIP-55 case and Tron's base58check.
    return { valid: false, errorKey: "addressChecksumError" };
  }
  if (parsed.isTestOnly) {
    return { valid: false, errorKey: "addressInvalid" };
  }
  return { valid: true };
}

/**
 * Base58check (the legacy address format of Bitcoin and its forks): 25 bytes — a version
 * byte, a 20-byte hash, and 4 bytes that must equal `sha256(sha256(first 21))[0..4]`. The
 * version byte says both the chain and the kind of script, which is why it is checked
 * against an explicit list rather than read off the first character.
 *
 * Same split of errors as Tron's: a right-shaped address whose check digits are wrong is a
 * typo ("re-copy it"), anything else is simply not an address of this chain.
 */
function validateBase58Check(address: string, versions: readonly number[]): AddressValidationResult {
  if (!/^[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(address)) {
    return { valid: false, errorKey: "addressInvalid" };
  }
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(address);
  } catch {
    return { valid: false, errorKey: "addressInvalid" };
  }
  if (decoded.length !== 25) return { valid: false, errorKey: "addressInvalid" };
  // Version before checksum (D-387 d): a mistyped address of ANOTHER chain is not this chain's
  // address, whatever its check digits say — "re-copy it" would send the user to re-copy the
  // wrong thing.
  if (!versions.includes(decoded[0])) return { valid: false, errorKey: "addressInvalid" };
  const expected = sha256(sha256(decoded.slice(0, 21), "bytes"), "bytes").slice(0, 4);
  for (let i = 0; i < 4; i++) {
    if (decoded[21 + i] !== expected[i]) return { valid: false, errorKey: "addressChecksumError" };
  }
  return { valid: true };
}

/**
 * A native segwit address: v0 (P2WPKH 20 bytes, P2WSH 32 bytes, Bech32) or v1 (Taproot, 32
 * bytes, Bech32m). Later witness versions are valid FORMAT (BIP-350) but not something either
 * chain spends today, so, like upstream, they are refused rather than sent to.
 *
 * Only lowercase. The all-uppercase form BIP-173 also allows (for QR codes) is lowercased by
 * `normalizeAddress` before it gets here (D-387 b); refusing it here keeps an uppercase string
 * that skipped that step from being signed as typed. Mixed case is never valid bech32.
 */
function validateSegwit(
  address: string,
  hrp: string,
  allowTaproot: boolean
): AddressValidationResult {
  if (address !== address.toLowerCase()) return { valid: false, errorKey: "addressInvalid" };
  const segwit = decodeSegwitAddress(hrp, address);
  if (segwit) {
    const ok =
      (segwit.version === 0 && (segwit.program.length === 20 || segwit.program.length === 32)) ||
      (allowTaproot && segwit.version === 1 && segwit.program.length === 32);
    return ok ? { valid: true } : { valid: false, errorKey: "addressInvalid" };
  }
  // Right prefix and alphabet, and the checksum is what failed: a typo, not another chain.
  const shaped = new RegExp(`^${hrp}1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{6,}$`).test(address);
  return shaped && decodeBech32(address) === null
    ? { valid: false, errorKey: "addressChecksumError" }
    : { valid: false, errorKey: "addressInvalid" };
}

/**
 * Bitcoin (D-278): `1…` P2PKH (version 0x00), `3…` P2SH (0x05), and `bc1…` segwit v0/v1.
 * Derived from upstream's `validateBtcAddress`, which checks the same versions and witness
 * rules.
 *
 * Attribution: see ATTRIBUTIONS.md #12.
 */
function validateBtc(address: string): AddressValidationResult {
  if (address.toLowerCase().startsWith("bc1")) return validateSegwit(address, "bc", true);
  return validateBase58Check(address, [0x00, 0x05]);
}

/**
 * Litecoin (D-278): `L…` P2PKH (0x30), `M…` P2SH (0x32), and `ltc1q…` segwit v0.
 *
 * Taproot (`ltc1p…`) is refused although upstream takes it: almost no Litecoin wallet hands
 * one out, and nothing shows the bridge's Litecoin sender can pay one. A refused address is a
 * message; a withdrawal the bridge cannot deliver is funds in limbo.
 *
 * ⚠️ STRICTER THAN UPSTREAM: `3…` (0x05, Litecoin's old P2SH version) is refused. It is the
 * same version byte as a Bitcoin P2SH, so a Bitcoin address pasted into a Litecoin withdrawal
 * would pass — and land on a script hash on the wrong chain. Litecoin replaced it with `M…`
 * in 2018; no current wallet hands one out.
 *
 * Attribution: see ATTRIBUTIONS.md #12.
 */
function validateLtc(address: string): AddressValidationResult {
  if (address.toLowerCase().startsWith("ltc1")) return validateSegwit(address, "ltc", false);
  return validateBase58Check(address, [0x30, 0x32]);
}

/**
 * Dogecoin (D-278): `D…` P2PKH (0x1e) and P2SH (0x16, which reads `9…` or `A…`). No segwit.
 *
 * ⚠️ STRICTER THAN UPSTREAM, ON PURPOSE: `validateDogeAddress` upstream is the regex
 * `^[DA][1-9A-HJ-NP-Za-km-z]{25,33}$` — shape only, so it accepts a one-character typo of a
 * real address (the Tron defect of D-214 again), and it refuses the `9…` P2SH addresses the
 * same version byte also produces.
 */
function validateDoge(address: string): AddressValidationResult {
  return validateBase58Check(address, [0x1e, 0x16]);
}

export function validateAddress(address: string, chainId: string): AddressValidationResult {
  if (!address.trim()) return { valid: false };

  if (chainId.startsWith("eth:")) return validateEvm(address);
  if (chainId === "near:mainnet") return validateNear(address);
  if (chainId === "sol:mainnet") return validateSolana(address);
  if (chainId === "tron:mainnet") return validateTron(address);
  if (chainId === "stellar:mainnet") return validateStellar(address);
  if (chainId === "ton:mainnet") return validateTon(address);
  if (chainId === "btc:mainnet") return validateBtc(address);
  if (chainId === "ltc:mainnet") return validateLtc(address);
  if (chainId === "doge:mainnet") return validateDoge(address);

  // Fail CLOSED. A chain with no validator above cannot have its destination checked at all,
  // and a withdrawal is irreversible: accepting "any non-empty string" (what this returned
  // until 2026-08-13) meant a typo on BTC/DOGE/LTC was forwarded straight to the bridge. The
  // day-1 allowlist (`token-availability.ts`) only enables chains that ARE validated above, so
  // this branch is unreachable from the picker — but the picker is built from the user's
  // balance, not from the catalogue (D-279), so a token acquired outside IntentFolio can still
  // reach here. This is the check that actually closes that hole; the allowlist only closes
  // the deposit side of it.
  //
  // `addressInvalid` rather than a new "chain not supported" key on purpose: the state is
  // unreachable by design, and a third errorKey would need copy in both locales to say
  // something no user is meant to read. If a chain ever needs to ship before its validator
  // does, that is the moment to add the key — and the reason to think twice instead.
  return { valid: false, errorKey: "addressInvalid" };
}

/**
 * The form of `address` that is validated, shown and signed (D-387 b). Only an ALL-uppercase
 * bech32 address on Bitcoin/Litecoin changes — BIP-173's QR form, lowercased the way upstream
 * Omni does. Anything else, mixed case included, is returned as typed for the validator to
 * judge.
 */
export function normalizeAddress(address: string, chainId: string): string {
  const prefix = chainId === "btc:mainnet" ? "bc1" : chainId === "ltc:mainnet" ? "ltc1" : null;
  const lower = address.toLowerCase();
  return prefix && address === address.toUpperCase() && lower.startsWith(prefix) ? lower : address;
}

/**
 * The base58check version bytes `validateBtc`, `validateLtc` and `validateDoge` accept, with
 * the chain each belongs to.
 */
const BASE58CHECK_OWNERS: ReadonlyArray<{ chainId: string; name: string; versions: readonly number[] }> = [
  { chainId: "btc:mainnet", name: "Bitcoin", versions: [0x00, 0x05] },
  { chainId: "ltc:mainnet", name: "Litecoin", versions: [0x30, 0x32] },
  { chainId: "doge:mainnet", name: "Dogecoin", versions: [0x1e, 0x16] },
];

/**
 * The version byte of a 25-byte base58check payload, checksum NOT verified (D-387 d): like the
 * other shape tests in `detectWrongChain`, a mistyped address still says which chain it is.
 * The 25 bytes are what keep this off Solana's shape, which decodes to 32.
 */
function base58CheckVersion(address: string): number | null {
  if (!/^[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(address)) return null;
  try {
    const decoded = bs58.decode(address);
    return decoded.length === 25 ? decoded[0] : null;
  } catch {
    return null;
  }
}

// Returns the suspected chain display name if the address shape belongs to a different chain.
export function detectWrongChain(address: string, chainId: string): string | null {
  if (!address) return null;

  const looksEvm = /^0x[a-fA-F0-9]{40}$/.test(address);
  // `.tg` (HOT/Telegram) by name rather than any dotted id: ENS `vitalik.eth` or SNS `alice.sol`
  // fit the same grammar and are not NEAR accounts (D-507).
  const looksNear =
    /^[a-z0-9._-]{2,64}\.near$/.test(address) ||
    /^[a-f0-9]{64}$/.test(address) ||
    (address.length <= 64 && address.endsWith(".tg") && NEAR_ACCOUNT_ID.test(address));
  const looksTron = /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address);
  // Shape only, like its neighbours — the CRC16 is `validateStellar`'s job, and a checksum
  // failure should read as "re-copy this", not as "this belongs to another chain".
  const looksStellar = /^G[A-Z2-7]{55}$/.test(address);
  // The two mainnet tags only (`EQ` bounceable, `UQ` not). A testnet `kQ…`/`0Q…` is a wrong
  // NETWORK rather than a wrong chain, which is `validateTon`'s call to make.
  const looksTon = /^[EU]Q[A-Za-z0-9+/_-]{46}$/.test(address);

  if (!chainId.startsWith("eth:") && looksEvm) return "EVM";
  if (chainId !== "near:mainnet" && looksNear) return "NEAR";
  if (chainId !== "tron:mainnet" && looksTron) return "Tron";
  if (chainId !== "stellar:mainnet" && looksStellar) return "Stellar";
  if (chainId !== "ton:mainnet" && looksTon) return "TON";
  // Segwit by prefix. The legacy base58 forms share Solana's alphabet, so they are told apart
  // by decoded length and version byte below instead.
  if (chainId !== "btc:mainnet" && /^bc1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{8,}$/.test(address)) {
    return "Bitcoin";
  }
  if (chainId !== "ltc:mainnet" && /^ltc1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{8,}$/.test(address)) {
    return "Litecoin";
  }
  const version = base58CheckVersion(address);
  const owner = version === null ? undefined : BASE58CHECK_OWNERS.find((o) => o.versions.includes(version));
  if (owner && owner.chainId !== chainId) return owner.name;

  return null;
}
