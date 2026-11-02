import { describe, expect, it } from "vitest";
import { Address as TonAddress } from "@ton/core";
import { validateAddress, detectWrongChain, normalizeAddress } from "./address-validation";
import { decodeSegwitAddress } from "./bech32";

describe("validateAddress — EVM chains", () => {
  it("accepts a valid all-lowercase EVM address with a warning", () => {
    const result = validateAddress("0xd8da6bf26964af9d7eed9e03e53415d37aa96045", "eth:1");
    expect(result.valid).toBe(true);
    expect(result.warningKey).toBe("addressChecksumWarning");
    expect(result.errorKey).toBeUndefined();
  });

  it("accepts a valid EIP-55 checksummed address without warning", () => {
    const result = validateAddress("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "eth:1");
    expect(result.valid).toBe(true);
    expect(result.warningKey).toBeUndefined();
    expect(result.errorKey).toBeUndefined();
  });

  it("rejects mixed-case address with bad checksum", () => {
    // Swap a few chars to break the checksum
    const result = validateAddress("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96046", "eth:1");
    expect(result.valid).toBe(false);
    expect(result.errorKey).toBe("addressChecksumError");
  });

  it("rejects address with wrong length", () => {
    const result = validateAddress("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA960", "eth:1");
    expect(result.valid).toBe(false);
    expect(result.errorKey).toBe("addressInvalid");
  });

  it("rejects address without 0x prefix", () => {
    const result = validateAddress("d8da6bf26964af9d7eed9e03e53415d37aa96045", "eth:1");
    expect(result.valid).toBe(false);
    expect(result.errorKey).toBe("addressInvalid");
  });

  it("applies same rules to eth:8453 (Base)", () => {
    const result = validateAddress("0xd8da6bf26964af9d7eed9e03e53415d37aa96045", "eth:8453");
    expect(result.valid).toBe(true);
    expect(result.warningKey).toBe("addressChecksumWarning");
  });
});

describe("validateAddress — NEAR", () => {
  it("accepts a .near account", () => {
    expect(validateAddress("alice.near", "near:mainnet").valid).toBe(true);
  });

  it("accepts a 64-char hex implicit account", () => {
    const hex = "a".repeat(64);
    expect(validateAddress(hex, "near:mainnet").valid).toBe(true);
  });

  // D-386 (c): implicit accounts are lowercase hex; the uppercase form is no NEAR account.
  it("rejects a 64-char hex implicit account in uppercase", () => {
    expect(validateAddress("A".repeat(64), "near:mainnet").valid).toBe(false);
  });

  // D-507: real accounts that do not end in `.near`.
  it("accepts accounts under other top-level accounts", () => {
    expect(validateAddress("alice.tg", "near:mainnet").valid).toBe(true);
    expect(validateAddress("sub.alice_1.tg", "near:mainnet").valid).toBe(true);
  });

  it("rejects an ETH-implicit account and an EVM address in the NEAR field", () => {
    expect(validateAddress("0x" + "a".repeat(40), "near:mainnet").valid).toBe(false);
    expect(validateAddress("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "near:mainnet").valid).toBe(false);
  });

  it("rejects ids that break the account grammar or have no dot", () => {
    for (const bad of ["alice", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", "-a.tg", "a..tg", "a.tg.", "A.tg", "a b.tg", "a".repeat(63) + ".tg"]) {
      expect(validateAddress(bad, "near:mainnet").valid, bad).toBe(false);
    }
  });

  it("rejects an account too short to have .near suffix", () => {
    expect(validateAddress("x.near", "near:mainnet").valid).toBe(false);
  });

  it("rejects a plain string without .near and wrong length", () => {
    expect(validateAddress("notanaddress", "near:mainnet").valid).toBe(false);
  });
});

describe("validateAddress — Solana", () => {
  it("accepts a valid 44-char base58 address", () => {
    // A known valid Solana address
    const result = validateAddress("So11111111111111111111111111111111111111112", "sol:mainnet");
    expect(result.valid).toBe(true);
  });

  it("rejects an address with invalid base58 characters (0, O, I, l)", () => {
    const result = validateAddress("0l11111111111111111111111111111111111111111", "sol:mainnet");
    expect(result.valid).toBe(false);
  });

  it("rejects an address that decodes to != 32 bytes", () => {
    // Too short (less than 32 bytes when decoded)
    const result = validateAddress("1111111111111111111111111111111", "sol:mainnet");
    expect(result.valid).toBe(false);
  });
});

// Real mainnet contract addresses, not fixtures: the checksum has to come from somewhere
// that is not this file, or the test only proves the validator agrees with itself. The
// previous fixture here ("TQn9Y2khDD3tHF35MgJKjHkEQBrqVy7qxe") was invented and does NOT
// checksum — which is exactly what the shape-only validator could not tell us.
const TRON_USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const TRON_WIN = "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7";
const TRON_WTRX = "TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR";

describe("validateAddress — Tron", () => {
  it("accepts real Tron addresses", () => {
    for (const address of [TRON_USDT, TRON_WIN, TRON_WTRX]) {
      expect(validateAddress(address, "tron:mainnet").valid).toBe(true);
    }
  });

  // The one this validator exists for: right shape, wrong address, permanent loss.
  it("rejects a one-character typo of a real address", () => {
    const typo = TRON_USDT.slice(0, -1) + "u"; // trailing "t" -> "u"
    expect(typo).toMatch(/^T[1-9A-HJ-NP-Za-km-z]{33}$/); // shape alone still passes
    const result = validateAddress(typo, "tron:mainnet");
    expect(result.valid).toBe(false);
    expect(result.errorKey).toBe("addressChecksumError");
  });

  it("rejects every single-character substitution of a real address", () => {
    const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let accepted = 0;
    for (let i = 1; i < TRON_WTRX.length; i++) {
      for (const c of alphabet) {
        if (c === TRON_WTRX[i]) continue;
        const mutated = TRON_WTRX.slice(0, i) + c + TRON_WTRX.slice(i + 1);
        if (validateAddress(mutated, "tron:mainnet").valid) accepted++;
      }
    }
    // 4 checksum bytes ⇒ a collision is a ~1-in-4-billion event per mutation, and there are
    // fewer than 2000 here. Anything above zero means the checksum is not being read.
    expect(accepted).toBe(0);
  });

  it("rejects an address not starting with T", () => {
    expect(validateAddress("AQn9Y2khDD3tHF35MgJKjHkEQBrqVy7qxe", "tron:mainnet").valid).toBe(false);
  });

  it("rejects an address that is too short", () => {
    expect(validateAddress("TShort", "tron:mainnet").valid).toBe(false);
  });

  // Upstream (intents-sdk `validateAddress.js:241`) also accepts the 21-byte hex form. We do
  // not, deliberately: no Tron wallet in the login set hands one out.
  it("rejects the hex form upstream accepts", () => {
    expect(validateAddress("41a614f803b6fd780986a42c78ec9c7f77e6ded13c", "tron:mainnet").valid)
      .toBe(false);
  });
});

// Block 4.4. Until Stellar was curated this chain fell through to "accept any non-empty
// string", which is the fallback below — fine while nothing could be sent there, and a
// money-loss path the moment it could.
const XLM_USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const XLM_OTHER = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";

describe("validateAddress — Stellar", () => {
  it("accepts real mainnet account ids", () => {
    for (const address of [XLM_USDC_ISSUER, XLM_OTHER]) {
      expect(validateAddress(address, "stellar:mainnet").valid, address).toBe(true);
    }
  });

  it("rejects every single-character substitution of a real address", () => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let accepted = 0;
    for (let i = 1; i < XLM_USDC_ISSUER.length; i++) {
      for (const c of alphabet) {
        if (c === XLM_USDC_ISSUER[i]) continue;
        const mutated = XLM_USDC_ISSUER.slice(0, i) + c + XLM_USDC_ISSUER.slice(i + 1);
        if (validateAddress(mutated, "stellar:mainnet").valid) accepted++;
      }
    }
    // CRC16 ⇒ ~1-in-65536 per mutation over ~1700 mutations. Zero is the only reading that
    // means the checksum is actually being verified rather than the shape being matched.
    expect(accepted).toBe(0);
  });

  it("rejects a muxed M… address, which carries a memo this chain already needs", () => {
    const muxed = "MA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVNAAAAAAAAAAAAA";
    expect(validateAddress(muxed, "stellar:mainnet").valid).toBe(false);
  });

  it("rejects a lowercased address, which StrKey is not", () => {
    expect(validateAddress(XLM_USDC_ISSUER.toLowerCase(), "stellar:mainnet").valid).toBe(false);
  });

  it("no longer falls through to the accept-anything fallback", () => {
    expect(validateAddress("anythinghere", "stellar:mainnet").valid).toBe(false);
  });
});

describe("validateAddress — TON", () => {
  // Real mainnet addresses: the PoA bridge's own `ton:mainnet` deposit addresses for two
  // probe accounts, which is the exact form the product deals in.
  const TON_UQ = "UQCv4mTYxbLOKZBDL_b_jckLV3ev0SLA-demExEBdbkivm0W";
  const TON_UQ_2 = "UQBYnafjv-idE8sjy0qMl1A_ca-eduw7dV1M5FHR45NALFUv";

  it("accepts the UQ… form every wallet copies, and the EQ… form of the same account", () => {
    expect(validateAddress(TON_UQ, "ton:mainnet").valid).toBe(true);
    expect(validateAddress(TON_UQ_2, "ton:mainnet").valid).toBe(true);
    // Bounceable tag: a different string, the same account, its own CRC.
    expect(validateAddress(TonAddress.parse(TON_UQ).toString({ bounceable: true }), "ton:mainnet").valid).toBe(true);
  });

  it("rejects every single-character substitution of a real address", () => {
    // The same sweep Stellar and Tron get, and the reason `Address.parseFriendly` is used
    // instead of a shape test: at 48 base64 chars, a typo is otherwise undetectable.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let accepted = 0;
    for (let i = 0; i < TON_UQ.length; i++) {
      for (const c of alphabet) {
        if (c === TON_UQ[i]) continue;
        const mutated = TON_UQ.slice(0, i) + c + TON_UQ.slice(i + 1);
        if (validateAddress(mutated, "ton:mainnet").valid) accepted++;
      }
    }
    // CRC16 ⇒ ~1-in-65536 per mutation over ~3000 mutations. Zero is the only reading that
    // means the checksum is actually being verified rather than the shape being matched.
    expect(accepted).toBe(0);
  });

  it("calls a broken checksum what it is, so the copy says 're-copy this'", () => {
    const corrupted = TON_UQ.slice(0, -1) + (TON_UQ.endsWith("W") ? "X" : "W");
    expect(validateAddress(corrupted, "ton:mainnet")).toEqual({
      valid: false,
      errorKey: "addressChecksumError",
    });
  });

  it("rejects a TESTNET address, which is the right shape on the wrong network", () => {
    // 🔴 The one that would cost money silently: `encodeHotReceiver` keeps only workchain and
    // hash, so the test flag disappears and this becomes a valid mainnet destination for an
    // account nobody controls. The modal has to stop it here.
    const testnet = TonAddress.parse(TON_UQ).toString({ testOnly: true });
    expect(testnet).not.toBe(TON_UQ);
    expect(validateAddress(testnet, "ton:mainnet").valid).toBe(false);
  });

  it("rejects the RAW form, the one TON shape with no checksum at all", () => {
    // `Address.parseRaw` validates nothing but the hash length, and Tonkeeper does not hand
    // it out. Same call as Tron's hex form.
    expect(validateAddress(TonAddress.parse(TON_UQ).toRawString(), "ton:mainnet").valid).toBe(false);
  });

  it("rejects the wrong length and the wrong alphabet", () => {
    expect(validateAddress("UQAbc", "ton:mainnet").valid).toBe(false);
    expect(validateAddress(TON_UQ + "A", "ton:mainnet").valid).toBe(false);
    expect(validateAddress(TON_UQ.slice(0, -1) + "!", "ton:mainnet").valid).toBe(false);
  });

  it("no longer falls through to the accept-anything fallback", () => {
    expect(validateAddress("anythinghere", "ton:mainnet").valid).toBe(false);
  });
});

// Until 2026-08-13 this fallback accepted any non-empty string, which on an irreversible
// withdrawal meant a typo went straight to the bridge. It now fails CLOSED: a chain with no
// validator above cannot be withdrawn to at all. See the comment on `validateAddress`.
describe("validateAddress — chains with no validator", () => {
  it("rejects every string, including well-formed addresses for that chain", () => {
    // A real Sui-shaped string and a real Cardano one would be rejected the same way: we
    // cannot tell, so nothing is sent.
    expect(validateAddress("anythinghere", "sui:mainnet").valid).toBe(false);
    expect(validateAddress("anythinghere", "cardano:mainnet").valid).toBe(false);
    expect(
      validateAddress("0x1f9840a85d5af5bf1d1762f925bdaddc4201f9841f9840a85d5af5bf1d1762f9", "aptos:mainnet").valid
    ).toBe(false);
  });

  it("reports it as an invalid address rather than silently failing", () => {
    expect(validateAddress("anythinghere", "cardano:mainnet")).toEqual({
      valid: false,
      errorKey: "addressInvalid",
    });
  });

  it("returns invalid for empty string", () => {
    expect(validateAddress("", "btc:mainnet").valid).toBe(false);
  });
});

// D-278. Real mainnet addresses, taken from recent blocks on 2026-09-30 (mempool.space for
// Bitcoin, blockcypher for Litecoin and Dogecoin), one per script type.
const BTC_P2PKH = "1PuJjnF476W3zXfVYmJfGnouzFDAXakkL4";
const BTC_P2SH = "38QhtSmiHPKt33HNQee9wqSA5wZXx2XbhC";
const BTC_P2WPKH = "bc1q7sp49suxx62yeqa0lq0vx8ngwvhkc0v7wm7sd8";
const BTC_P2WSH = "bc1q4k09m662pgvrdprxegx5xqtt6susyxfk7fhsy4npusvuk97rzwesjqh8dc";
const BTC_P2TR = "bc1pcvdealdw46t4hjcgw59dspkr0upmrkqfwjjjh45g45zja2ry3whsc5x7da";
const LTC_P2PKH = "LfdYLbP9F9CpmCX6atZnHZb8KkS8T6x4DK";
const LTC_P2SH = "MRGThripkL8DqWcfEZqZjT78SM7DWNLdie";
const LTC_P2WPKH = "ltc1qrn85xxd093mwnqjvw3led5f0szfk3c0uw4hg0l";
const DOGE_P2PKH = "D7sm18pbxVUyqwBkyPkozKEGer66gEVpeV";
const DOGE_P2PK = "DRCX1N8DFuXZuvgQxH9CoipzyEHBXhQ3Uj";
// Built, not observed: version 0x16 + a fixed hash, base58check-encoded with @scure/base.
// Dogecoin P2SH is rare on chain; what matters is that the version byte is read, and that the
// `9…` spelling upstream's regex refuses is accepted.
const DOGE_P2SH_9 = "9uqSqP6ywx6o1Mx6gsCSz7FPaoip8GVUqW";

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

/** How many single-character substitutions of `address` (after `from`) the chain accepts. */
function acceptedMutations(address: string, chainId: string, alphabet: string, from: number): number {
  let accepted = 0;
  for (let i = from; i < address.length; i++) {
    for (const c of alphabet) {
      if (c === address[i]) continue;
      const mutated = address.slice(0, i) + c + address.slice(i + 1);
      if (validateAddress(mutated, chainId).valid) accepted++;
    }
  }
  return accepted;
}

describe("validateAddress — Bitcoin (D-278)", () => {
  it("accepts every kind of real mainnet address", () => {
    for (const a of [BTC_P2PKH, BTC_P2SH, BTC_P2WPKH, BTC_P2WSH, BTC_P2TR]) {
      expect(validateAddress(a, "btc:mainnet"), a).toEqual({ valid: true });
    }
  });

  it("accepts the BIP-350 mainnet vectors it should and refuses the rest", () => {
    // v0 as uppercase is a valid encoding, but only once `normalizeAddress` lowercases it.
    expect(validateAddress("BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4", "btc:mainnet").valid).toBe(false);
    expect(validateAddress("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", "btc:mainnet").valid).toBe(true);
    expect(
      validateAddress("bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0", "btc:mainnet").valid
    ).toBe(true);
    // Valid format, but witness versions nobody spends today (v1 with 40 bytes, v2, v16).
    expect(
      validateAddress("bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y", "btc:mainnet").valid
    ).toBe(false);
    expect(validateAddress("bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs", "btc:mainnet").valid).toBe(false);
    // Bech32 where Bech32m is required, and the reverse.
    expect(
      validateAddress("bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd", "btc:mainnet").valid
    ).toBe(false);
    expect(validateAddress("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh", "btc:mainnet").valid).toBe(false);
    // Testnet.
    expect(
      validateAddress("tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7", "btc:mainnet").valid
    ).toBe(false);
  });

  it("calls a broken checksum a checksum error, on both formats", () => {
    expect(validateAddress(BTC_P2WPKH.slice(0, -1) + "9", "btc:mainnet").errorKey).toBe("addressChecksumError");
    expect(validateAddress(BTC_P2PKH.slice(0, -1) + "5", "btc:mainnet").errorKey).toBe("addressChecksumError");
  });

  it("rejects every single-character substitution of real addresses", () => {
    expect(acceptedMutations(BTC_P2PKH, "btc:mainnet", BASE58, 1)).toBe(0);
    expect(acceptedMutations(BTC_P2SH, "btc:mainnet", BASE58, 1)).toBe(0);
    expect(acceptedMutations(BTC_P2WPKH, "btc:mainnet", BECH32, 4)).toBe(0);
    expect(acceptedMutations(BTC_P2TR, "btc:mainnet", BECH32, 4)).toBe(0);
  });

  it("refuses Litecoin and Dogecoin addresses", () => {
    for (const a of [LTC_P2PKH, LTC_P2SH, LTC_P2WPKH, DOGE_P2PKH]) {
      expect(validateAddress(a, "btc:mainnet").valid, a).toBe(false);
    }
  });
});

// D-387 (b): the all-uppercase QR form is lowercased before validation, never accepted as typed.
describe("normalizeAddress", () => {
  it("lowercases an all-uppercase bech32 address on Bitcoin and Litecoin", () => {
    for (const [a, chainId] of [
      [BTC_P2WPKH, "btc:mainnet"],
      [BTC_P2TR, "btc:mainnet"],
      [LTC_P2WPKH, "ltc:mainnet"],
    ]) {
      const normalized = normalizeAddress(a.toUpperCase(), chainId);
      expect(normalized).toBe(a);
      expect(validateAddress(normalized, chainId), a).toEqual({ valid: true });
    }
  });

  it("leaves mixed case as typed, so it stays rejected", () => {
    const mixed = "B" + BTC_P2WPKH.slice(1);
    expect(normalizeAddress(mixed, "btc:mainnet")).toBe(mixed);
    expect(validateAddress(mixed, "btc:mainnet").valid).toBe(false);
  });

  it("does not touch a non-bech32 address or another chain", () => {
    expect(normalizeAddress(BTC_P2PKH, "btc:mainnet")).toBe(BTC_P2PKH);
    expect(normalizeAddress(LTC_P2PKH, "ltc:mainnet")).toBe(LTC_P2PKH);
    // A Bitcoin QR address on the Litecoin route is not Litecoin's to lowercase.
    expect(normalizeAddress(BTC_P2WPKH.toUpperCase(), "ltc:mainnet")).toBe(BTC_P2WPKH.toUpperCase());
    expect(normalizeAddress("A".repeat(64), "near:mainnet")).toBe("A".repeat(64));
  });
});

describe("validateAddress — Litecoin (D-278)", () => {
  it("accepts real mainnet addresses", () => {
    for (const a of [LTC_P2PKH, LTC_P2SH, LTC_P2WPKH]) {
      expect(validateAddress(a, "ltc:mainnet"), a).toEqual({ valid: true });
    }
  });

  // Litecoin's old P2SH version is Bitcoin's P2SH version: accepting it would let a Bitcoin
  // `3…` address through on a Litecoin withdrawal.
  it("refuses a `3…` address, which is also Bitcoin's P2SH", () => {
    expect(validateAddress(BTC_P2SH, "ltc:mainnet").valid).toBe(false);
  });

  it("refuses Taproot, which no Litecoin wallet hands out and the bridge is not shown to pay", () => {
    // BIP-350's Taproot program re-encoded under `ltc`, checksum included: a well-formed v1
    // address, refused for being v1 — not for a bad checksum.
    const ltcTaproot = "ltc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqpj6zg2";
    expect(decodeSegwitAddress("ltc", ltcTaproot)?.version).toBe(1);
    expect(validateAddress(ltcTaproot, "ltc:mainnet")).toEqual({ valid: false, errorKey: "addressInvalid" });
  });

  it("refuses Bitcoin segwit and Dogecoin addresses", () => {
    for (const a of [BTC_P2PKH, BTC_P2WPKH, BTC_P2TR, DOGE_P2PKH]) {
      expect(validateAddress(a, "ltc:mainnet").valid, a).toBe(false);
    }
  });

  it("rejects every single-character substitution of real addresses", () => {
    expect(acceptedMutations(LTC_P2PKH, "ltc:mainnet", BASE58, 1)).toBe(0);
    expect(acceptedMutations(LTC_P2SH, "ltc:mainnet", BASE58, 1)).toBe(0);
    expect(acceptedMutations(LTC_P2WPKH, "ltc:mainnet", BECH32, 5)).toBe(0);
  });
});

describe("validateAddress — Dogecoin (D-278)", () => {
  it("accepts real mainnet addresses and P2SH in both spellings", () => {
    for (const a of [DOGE_P2PKH, DOGE_P2PK, DOGE_P2SH_9]) {
      expect(validateAddress(a, "doge:mainnet"), a).toEqual({ valid: true });
    }
  });

  // Upstream's regex (`^[DA][1-9A-HJ-NP-Za-km-z]{25,33}$`) accepts all of these.
  it("rejects every single-character substitution of a real address", () => {
    const typo = DOGE_P2PKH.slice(0, -1) + "W";
    expect(typo).toMatch(/^[DA][1-9A-HJ-NP-Za-km-z]{25,33}$/);
    expect(validateAddress(typo, "doge:mainnet").errorKey).toBe("addressChecksumError");
    expect(acceptedMutations(DOGE_P2PKH, "doge:mainnet", BASE58, 1)).toBe(0);
  });

  it("refuses Bitcoin and Litecoin addresses", () => {
    for (const a of [BTC_P2PKH, BTC_P2SH, BTC_P2WPKH, LTC_P2PKH, LTC_P2SH]) {
      expect(validateAddress(a, "doge:mainnet").valid, a).toBe(false);
    }
  });
});

describe("detectWrongChain", () => {
  it("returns EVM when EVM address used on NEAR chain", () => {
    expect(
      detectWrongChain("0xd8da6bf26964af9d7eed9e03e53415d37aa96045", "near:mainnet"),
    ).toBe("EVM");
  });

  // D-507: HOT/Telegram accounts are NEAR too; ENS/SNS names fit the grammar but are not.
  it("returns NEAR when a .tg account is used on an EVM or Solana chain", () => {
    expect(detectWrongChain("alice.tg", "eth:1")).toBe("NEAR");
    expect(detectWrongChain("alice.tg", "sol:mainnet")).toBe("NEAR");
    expect(detectWrongChain("alice.tg", "near:mainnet")).toBeNull();
  });

  it("does not call ENS or SNS names NEAR", () => {
    expect(detectWrongChain("vitalik.eth", "eth:1")).toBeNull();
    expect(detectWrongChain("alice.sol", "sol:mainnet")).toBeNull();
  });

  it("returns NEAR when .near address used on Solana chain", () => {
    expect(detectWrongChain("alice.near", "sol:mainnet")).toBe("NEAR");
  });

  // D-386 (b): an implicit account on the Arbitrum route offers "Send to NEAR", like a name.
  it("returns NEAR when a 64-hex implicit account is used on an EVM chain", () => {
    const implicit = "0123456789abcdef".repeat(4);
    expect(detectWrongChain(implicit, "eth:42161")).toBe("NEAR");
    expect(detectWrongChain(implicit, "near:mainnet")).toBeNull();
    expect(detectWrongChain(implicit.toUpperCase(), "eth:42161")).toBeNull();
    // And it is valid on no other chain, so NEAR is the only suggestion it can produce.
    for (const chainId of [
      "eth:42161", "sol:mainnet", "tron:mainnet", "stellar:mainnet",
      "ton:mainnet", "btc:mainnet", "ltc:mainnet", "doge:mainnet",
    ]) {
      expect(validateAddress(implicit, chainId).valid, chainId).toBe(false);
    }
  });

  // Shape-only on purpose, unlike validateTron: the point is to catch "you are on the wrong
  // chain" BEFORE the checksum matters, including for an address the user mistyped.
  it("returns Tron when Tron address used on EVM chain", () => {
    expect(detectWrongChain(TRON_USDT, "eth:1")).toBe("Tron");
    expect(detectWrongChain(TRON_USDT.slice(0, -1) + "u", "eth:1")).toBe("Tron");
  });

  it("returns TON when a TON address is used on another chain", () => {
    const ton = "UQCv4mTYxbLOKZBDL_b_jckLV3ev0SLA-demExEBdbkivm0W";
    expect(detectWrongChain(ton, "eth:1")).toBe("TON");
    // Shape-only, like its neighbours: a mistyped TON address is still a wrong-chain paste.
    expect(detectWrongChain(ton.slice(0, -1) + "X", "stellar:mainnet")).toBe("TON");
  });

  it("returns Bitcoin and Litecoin for their segwit addresses elsewhere", () => {
    expect(detectWrongChain(BTC_P2WPKH, "near:mainnet")).toBe("Bitcoin");
    expect(detectWrongChain(LTC_P2WPKH, "btc:mainnet")).toBe("Litecoin");
    expect(detectWrongChain(BTC_P2WPKH, "btc:mainnet")).toBeNull();
  });

  // D-387 (d): the legacy base58 forms by version byte, so a mistyped one still reads as the
  // wrong chain instead of "invalid checksum".
  it("returns the owner chain of a legacy base58 address elsewhere, mistyped or not", () => {
    expect(detectWrongChain(BTC_P2PKH, "doge:mainnet")).toBe("Bitcoin");
    expect(detectWrongChain(BTC_P2SH, "ltc:mainnet")).toBe("Bitcoin");
    expect(detectWrongChain(LTC_P2PKH, "btc:mainnet")).toBe("Litecoin");
    expect(detectWrongChain(LTC_P2SH, "doge:mainnet")).toBe("Litecoin");
    expect(detectWrongChain(DOGE_P2PKH, "btc:mainnet")).toBe("Dogecoin");
    expect(detectWrongChain(DOGE_P2SH_9, "ltc:mainnet")).toBe("Dogecoin");
    expect(detectWrongChain(BTC_P2PKH, "near:mainnet")).toBe("Bitcoin");

    const btcTypo = BTC_P2PKH.slice(0, -1) + "5";
    expect(validateAddress(btcTypo, "btc:mainnet").errorKey).toBe("addressChecksumError");
    expect(detectWrongChain(btcTypo, "doge:mainnet")).toBe("Bitcoin");
    expect(validateAddress(btcTypo, "doge:mainnet").errorKey).toBe("addressInvalid");

    for (const [a, chainId] of [
      [BTC_P2PKH, "btc:mainnet"],
      [LTC_P2PKH, "ltc:mainnet"],
      [DOGE_P2PKH, "doge:mainnet"],
    ] as const) {
      expect(detectWrongChain(a, chainId), a).toBeNull();
    }
  });

  it("does not read a Solana address as a legacy base58 one", () => {
    expect(detectWrongChain("So11111111111111111111111111111111111111112", "sol:mainnet")).toBeNull();
    expect(detectWrongChain("So11111111111111111111111111111111111111112", "btc:mainnet")).toBeNull();
  });

  it("returns null for correct chain", () => {
    expect(detectWrongChain("0xd8da6bf26964af9d7eed9e03e53415d37aa96045", "eth:1")).toBeNull();
    expect(detectWrongChain("alice.near", "near:mainnet")).toBeNull();
    expect(detectWrongChain("UQCv4mTYxbLOKZBDL_b_jckLV3ev0SLA-demExEBdbkivm0W", "ton:mainnet")).toBeNull();
  });

  it("returns null for empty address", () => {
    expect(detectWrongChain("", "eth:1")).toBeNull();
  });
});
