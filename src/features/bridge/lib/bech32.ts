// Bech32 (BIP-173) and Bech32m (BIP-350) decoding, for segwit address validation (D-278).
//
// Written by hand rather than imported: `@scure/base` has it, but only as a transitive
// dependency of the Defuse SDK, and a withdrawal validator must not depend on what another
// package happens to pull in. The algorithm is the reference one from both BIPs, and
// `bech32.test.ts` runs their published test vectors.

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

/** The constant the checksum must equal: 1 for Bech32 (BIP-173), 0x2bc830a3 for Bech32m. */
export type Bech32Encoding = "bech32" | "bech32m";
const ENCODING_CONST: Record<Bech32Encoding, number> = { bech32: 1, bech32m: 0x2bc830a3 };

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >>> i) & 1) chk ^= GENERATOR[i];
    }
  }
  return chk >>> 0;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

export type Bech32Decoded = {
  /** Lowercase human-readable part (`bc`, `ltc`). */
  hrp: string;
  /** 5-bit words between the separator and the checksum. */
  words: number[];
  encoding: Bech32Encoding;
};

/**
 * Decodes a Bech32 or Bech32m string, or returns null when it is not one.
 *
 * Follows the decoding rules shared by both BIPs: printable ASCII only, a single case (an
 * all-uppercase string is valid, mixed case is not), at most 90 characters, a non-empty HRP,
 * and at least the 6 checksum characters after the last `1`. The checksum tells the two
 * encodings apart, which is why the result says which one matched.
 */
export function decodeBech32(input: string): Bech32Decoded | null {
  if (input.length > 90) return null;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    if (c < 33 || c > 126) return null;
  }
  const lower = input.toLowerCase();
  if (input !== lower && input !== input.toUpperCase()) return null;

  const sep = lower.lastIndexOf("1");
  if (sep < 1 || sep + 7 > lower.length) return null;
  const hrp = lower.slice(0, sep);

  const data: number[] = [];
  for (const ch of lower.slice(sep + 1)) {
    const v = CHARSET.indexOf(ch);
    if (v === -1) return null;
    data.push(v);
  }

  const check = polymod([...hrpExpand(hrp), ...data]);
  const encoding =
    check === ENCODING_CONST.bech32 ? "bech32" : check === ENCODING_CONST.bech32m ? "bech32m" : null;
  if (!encoding) return null;
  return { hrp, words: data.slice(0, -6), encoding };
}

/**
 * Regroups 5-bit words into bytes, or returns null if the padding is not what an encoder
 * would have produced: more than 4 bits of it, or any of it non-zero (BIP-173 `convertbits`
 * with `pad = false`).
 */
export function fromWords(words: number[]): Uint8Array | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const w of words) {
    if (w < 0 || w > 31) return null;
    acc = (acc << 5) | w;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
    acc &= (1 << bits) - 1;
  }
  if (bits >= 5 || acc !== 0) return null;
  return Uint8Array.from(out);
}

export type SegwitAddress = { version: number; program: Uint8Array };

/**
 * A segwit address for the given HRP, as BIP-173 and BIP-350 define it, or null.
 *
 * Version 0 must use Bech32 with a 20- or 32-byte program; versions 1–16 must use Bech32m
 * with a 2–40-byte program. What a CHAIN accepts on top of that (Bitcoin: v0 and v1 only,
 * v1 only as 32 bytes) is the caller's rule, not the format's.
 */
export function decodeSegwitAddress(expectedHrp: string, address: string): SegwitAddress | null {
  const decoded = decodeBech32(address);
  if (!decoded || decoded.hrp !== expectedHrp || decoded.words.length < 1) return null;
  const [version, ...rest] = decoded.words;
  if (version > 16) return null;
  const program = fromWords(rest);
  if (!program || program.length < 2 || program.length > 40) return null;
  if (version === 0) {
    if (decoded.encoding !== "bech32") return null;
    if (program.length !== 20 && program.length !== 32) return null;
  } else if (decoded.encoding !== "bech32m") {
    return null;
  }
  return { version, program };
}
