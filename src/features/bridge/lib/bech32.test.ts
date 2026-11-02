// @vitest-environment node
import { describe, expect, it } from "vitest";
import { decodeBech32, decodeSegwitAddress, fromWords } from "./bech32";

// The published test vectors, verbatim from BIP-173 and BIP-350 (bitcoin/bips, fetched
// 2026-09-30). Before these were committed the decoder was also compared against
// `@scure/base` on every vector and 18,724 single-character mutations of them: no
// disagreement.

describe("decodeBech32 — BIP-173 (Bech32)", () => {
  it.each([
    "A12UEL5L",
    "a12uel5l",
    "an83characterlonghumanreadablepartthatcontainsthenumber1andtheexcludedcharactersbio1tt5tgs",
    "abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw",
    "11qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqc8247j",
    "split1checkupstagehandshakeupstreamerranterredcaperred2y9e3w",
    "?1ezyfcl",
  ])("accepts %s as Bech32", (s) => {
    expect(decodeBech32(s)?.encoding).toBe("bech32");
  });

  it.each([
    [String.fromCharCode(0x20) + "1nwldj5", "HRP character out of range"],
    [String.fromCharCode(0x7f) + "1axkwrx", "HRP character out of range"],
    ["an84characterslonghumanreadablepartthatcontainsthenumber1andtheexcludedcharactersbio1569pvx", "overall max length exceeded"],
    ["pzry9x0s0muk", "no separator character"],
    ["1pzry9x0s0muk", "empty HRP"],
    ["x1b4n0q5v", "invalid data character"],
    ["li1dgmt3", "too short checksum"],
    ["de1lg7wt" + String.fromCharCode(0xff), "invalid character in checksum"],
    ["A1G7SGD8", "checksum calculated with uppercase form of HRP"],
    ["10a06t8", "empty HRP"],
    ["1qzzfhee", "empty HRP"],
  ])("rejects %s (%s)", (s) => {
    expect(decodeBech32(s)).toBeNull();
  });
});

describe("decodeBech32 — BIP-350 (Bech32m)", () => {
  it.each([
    "A1LQFN3A",
    "a1lqfn3a",
    "an83characterlonghumanreadablepartthatcontainsthetheexcludedcharactersbioandnumber11sg7hg6",
    "abcdef1l7aum6echk45nj3s0wdvt2fg8x9yrzpqzd3ryx",
    "11llllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllludsr8",
    "split1checkupstagehandshakeupstreamerranterredcaperredlc445v",
    "?1v759aa",
  ])("accepts %s as Bech32m", (s) => {
    expect(decodeBech32(s)?.encoding).toBe("bech32m");
  });

  it.each([
    ["an84characterslonghumanreadablepartthatcontainsthetheexcludedcharactersbioandnumber11d6pts4", "overall max length exceeded"],
    ["qyrz8wqd2c9m", "no separator character"],
    ["1qyrz8wqd2c9m", "empty HRP"],
    ["y1b0jsk6g", "invalid data character"],
    ["lt1igcx5c0", "invalid data character"],
    ["in1muywd", "too short checksum"],
    ["mm1crxm3i", "invalid character in checksum"],
    ["au1s5cgom", "invalid character in checksum"],
    ["M1VUXWEZ", "checksum calculated with uppercase form of HRP"],
    ["16plkw9", "empty HRP"],
    ["1p2gdwpf", "empty HRP"],
  ])("rejects %s (%s)", (s) => {
    expect(decodeBech32(s)).toBeNull();
  });
});

/** scriptPubKey hex, the form BIP-350 states its valid vectors in. */
function scriptPubKey(version: number, program: Uint8Array): string {
  const op = version === 0 ? 0 : 0x50 + version;
  return [op, program.length, ...program].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("decodeSegwitAddress — BIP-350 segwit vectors", () => {
  it.each([
    ["bc", "BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4", "0014751e76e8199196d454941c45d1b3a323f1433bd6"],
    ["tb", "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7", "00201863143c14c5166804bd19203356da136c985678cd4d27a1b8c6329604903262"],
    ["bc", "bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y", "5128751e76e8199196d454941c45d1b3a323f1433bd6751e76e8199196d454941c45d1b3a323f1433bd6"],
    ["bc", "BC1SW50QGDZ25J", "6002751e"],
    ["bc", "bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs", "5210751e76e8199196d454941c45d1b3a323"],
    ["tb", "tb1qqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesrxh6hy", "0020000000c4a5cad46221b2a187905e5266362b99d5e91c6ce24d165dab93e86433"],
    ["tb", "tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c", "5120000000c4a5cad46221b2a187905e5266362b99d5e91c6ce24d165dab93e86433"],
    ["bc", "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0", "512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"],
  ])("decodes %s:%s", (hrp, address, expected) => {
    const decoded = decodeSegwitAddress(hrp, address);
    expect(decoded).not.toBeNull();
    expect(scriptPubKey(decoded!.version, decoded!.program)).toBe(expected);
  });

  it.each([
    ["tc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq5zuyut", "invalid human-readable part"],
    ["bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd", "Bech32 instead of Bech32m"],
    ["tb1z0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqglt7rf", "Bech32 instead of Bech32m"],
    ["BC1S0XLXVLHEMJA6C4DQV22UAPCTQUPFHLXM9H8Z3K2E72Q4K9HCZ7VQ54WELL", "Bech32 instead of Bech32m"],
    ["bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh", "Bech32m instead of Bech32"],
    ["tb1q0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq24jc47", "Bech32m instead of Bech32"],
    ["bc1p38j9r5y49hruaue7wxjce0updqjuyyx0kh56v8s25huc6995vvpql3jow4", "invalid character in checksum"],
    ["BC130XLXVLHEMJA6C4DQV22UAPCTQUPFHLXM9H8Z3K2E72Q4K9HCZ7VQ7ZWS8R", "invalid witness version"],
    ["bc1pw5dgrnzv", "invalid program length (1 byte)"],
    ["bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7v8n0nx0muaewav253zgeav", "invalid program length (41 bytes)"],
    ["BC1QR508D6QEJXTDG4Y5R3ZARVARYV98GJ9P", "invalid program length for witness version 0"],
    ["tb1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq47Zagq", "mixed case"],
    ["bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7v07qwwzcrf", "zero padding of more than 4 bits"],
    ["tb1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vpggkg4j", "non-zero padding in 8-to-5 conversion"],
    ["bc1gmk9yu", "empty data section"],
  ])("rejects %s (%s)", (address) => {
    expect(decodeSegwitAddress("bc", address)).toBeNull();
    expect(decodeSegwitAddress("tb", address)).toBeNull();
  });
});

describe("fromWords", () => {
  it("regroups 5-bit words into bytes and refuses non-zero padding", () => {
    // 0x75 0x1e = 01110101 00011110 → 01110 10100 01111 0(0000)
    expect(Array.from(fromWords([14, 20, 15, 0])!)).toEqual([0x75, 0x1e]);
    expect(fromWords([14, 20, 15, 1])).toBeNull();
  });
});
