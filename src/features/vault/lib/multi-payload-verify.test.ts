// Every scheme is checked against a vector this repo did not produce: defuse's own reference
// vectors (@ 6cfce73, crates/signatures/*/src/lib.rs and core/src/payload/multi.rs) for five of
// them, and near-api-js's independent NEP-413 serializer for the sixth. A vector signed with
// this file's own hashing would prove nothing.

import bs58 from "bs58";
import { Keypair } from "@stellar/stellar-base";
import { KeyPair, KeyPairSigner } from "near-api-js";
import { publicKeyToAddress, generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { buildCommitSignRequest } from "./vault-envelope";
import { buildCommitChangeSet } from "./vault-payloads";
import {
  extractDefuseEnvelope,
  formatSignerKey,
  implicitAccountId,
  isImplicitAccountId,
  verifyMultiPayload,
} from "./multi-payload-verify";

const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const ed = (bytes: Uint8Array) => `ed25519:${bs58.encode(bytes)}`;
const secp = (bytes: Uint8Array) => `secp256k1:${bs58.encode(bytes)}`;

// defuse-core core/src/payload/multi.rs `raw_ed25519` (legacy nonce, `{timestamp}` deadline).
const RAW_ED25519_VECTOR = JSON.parse(
  `{"standard":"raw_ed25519","payload":"{\\"signer_id\\":\\"74affa71ab030d400fdfa1bed033dfa6fd3ae34f92d17c046ebe368e80d53751\\",\\"verifying_contract\\":\\"intents.near\\",\\"deadline\\":{\\"timestamp\\":1732035219},\\"nonce\\":\\"XVoKfmScb3G+XqH9ke/fSlJ/3xO59sNhCxhpG821BH8=\\",\\"intents\\":[{\\"intent\\":\\"token_diff\\",\\"diff\\":{\\"nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near\\":\\"-1000\\",\\"nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near\\":\\"998\\"}}]}","public_key":"ed25519:8rVvtHWFr8hasdQGGD5WiQBTyr4iH2ruEPPVfj491RPN","signature":"ed25519:3vtbNQJHZfuV1s5DykzyjkbNLc583hnkrhTz57eDhd966iqzkor6Twgr4Loh2C195SCSEsiGfrd6KcxpjNq9ZbVj"}`
);

// crates/signatures/erc191 + tip191: one key, two prefixes. v is 0x1c on the reference; the
// crate tests fix it to 1 before verifying, which is what the SDK does before the wire.
const SECP_REFERENCE_PUBKEY = hex(
  "85a66984273f338ce4ef7b85e5430b008307e8591bb7c1b980852cf6423770b801f41e9438155eb53a5e20f748640093bb42ae3aeca035f7b7fd7a1a21f22f68"
);
const ERC191_SIG_V28 = hex(
  "7800a70d05cde2c49ed546a6ce887ce6027c2c268c0285f6efef0cdfc4366b23643790f67a86468ee8301ed12cfffcb07c6530f90a9327ec057800fabd332e471c"
);
const TIP191_SIG_V28 = hex(
  "eea1651a60600ec4d9c45e8ae81da1a78377f789f0ac2019de66ad943459913015ef9256809ee0e6bb76e303a0b4802e475c1d26ade5d585292b80c9fe9cb10c1c"
);
const fixV = (sig: Uint8Array) => Uint8Array.from([...sig.subarray(0, 64), sig[64] - 27]);

// crates/signatures/ton-connect `verify_text`.
const TON_TEXT_VECTOR = {
  standard: "ton_connect",
  address: "0:f4809e5ffac9dc42a6b1d94c5e74ad5fd86378de675c805f2274d0055cbc9378",
  domain: "ton-connect.github.io",
  timestamp: 1747759882,
  payload: { type: "text", text: "Hello, TON!".repeat(100) },
  public_key: ed(hex("22e795a07e832fc9084ca35a488a711f1dbedef637d4e886a6997d93ee2c2e37")),
  signature: ed(
    hex(
      "7bc628f6d634ab6ddaf10463742b13f0ede3cb828737d9ce1962cc808fbfe7035e77c1a3d0b682acf02d645cc1a244992b276552c0e1c57d30b03c2820d73d01"
    )
  ),
};

// crates/signatures/sep53 `reference_test_vectors`.
const SEP53_SEED = "SAKICEVQLYWGSOJS4WW7HZJWAHZVEEBS527LHK5V4MLJALYKICQCJXMW";
const SEP53_VECTORS: Array<[string, string]> = [
  ["Hello, World!", "fO5dbYhXUhBMhe6kId/cuVq/AfEnHRHEvsP8vXh03M1uLpi5e46yO2Q8rEBzu3feXQewcQE5GArp88u6ePK6BA=="],
  ["こんにちは、世界！", "CDU265Xs8y3OWbB/56H9jPgUss5G9A0qFuTqH2zs2YDgTm+++dIfmAEceFqB7bhfN3am59lCtDXrCtwH2k1GBA=="],
];

function tamperLastChar(s: string): string {
  const last = s.at(-1) === "1" ? "2" : "1";
  return s.slice(0, -1) + last;
}

describe("verifyMultiPayload — reference vectors", () => {
  it("raw_ed25519: recovers the defuse-core vector's key", async () => {
    const key = await verifyMultiPayload(RAW_ED25519_VECTOR);
    expect(key && formatSignerKey(key)).toBe("ed25519:8rVvtHWFr8hasdQGGD5WiQBTyr4iH2ruEPPVfj491RPN");
    expect(key && implicitAccountId(key)).toBe("74affa71ab030d400fdfa1bed033dfa6fd3ae34f92d17c046ebe368e80d53751");
  });

  it("raw_ed25519: a tampered signature or payload does not verify", async () => {
    expect(await verifyMultiPayload({ ...RAW_ED25519_VECTOR, signature: tamperLastChar(RAW_ED25519_VECTOR.signature) })).toBeNull();
    expect(await verifyMultiPayload({ ...RAW_ED25519_VECTOR, payload: RAW_ED25519_VECTOR.payload.replace("998", "999") })).toBeNull();
  });

  it("erc191: recovers the reference key once v is 0/1", async () => {
    const key = await verifyMultiPayload({ standard: "erc191", payload: "Hello world!", signature: secp(fixV(ERC191_SIG_V28)) });
    expect(key?.curve).toBe("secp256k1");
    expect(Buffer.from(key!.bytes).toString("hex")).toBe(Buffer.from(SECP_REFERENCE_PUBKEY).toString("hex"));
  });

  it("erc191: the implicit id is the EVM address of the key", async () => {
    const key = await verifyMultiPayload({ standard: "erc191", payload: "Hello world!", signature: secp(fixV(ERC191_SIG_V28)) });
    const address = publicKeyToAddress(`0x04${Buffer.from(SECP_REFERENCE_PUBKEY).toString("hex")}`).toLowerCase();
    expect(implicitAccountId(key!)).toBe(address);
  });

  it("erc191: a different message recovers a different key (never the signer's)", async () => {
    const key = await verifyMultiPayload({ standard: "erc191", payload: "Hello, NEAR!", signature: secp(fixV(ERC191_SIG_V28)) });
    expect(key && Buffer.from(key.bytes).toString("hex")).not.toBe(Buffer.from(SECP_REFERENCE_PUBKEY).toString("hex"));
  });

  it("erc191: v = 27/28 is refused, like NEAR's ecrecover", async () => {
    expect(await verifyMultiPayload({ standard: "erc191", payload: "Hello world!", signature: secp(ERC191_SIG_V28) })).toBeNull();
  });

  it("erc191: a high-s twin of a valid signature is refused (malleability flag)", async () => {
    const sig = fixV(ERC191_SIG_V28);
    const n = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
    const s = BigInt(`0x${Buffer.from(sig.subarray(32, 64)).toString("hex")}`);
    const highS = hex((n - s).toString(16).padStart(64, "0"));
    const twin = Uint8Array.from([...sig.subarray(0, 32), ...highS, sig[64] ^ 1]);
    expect(await verifyMultiPayload({ standard: "erc191", payload: "Hello world!", signature: secp(twin) })).toBeNull();
  });

  it("tip191: recovers the reference key, and only under the TRON prefix", async () => {
    const tron = await verifyMultiPayload({ standard: "tip191", payload: "Hello, TRON!", signature: secp(fixV(TIP191_SIG_V28)) });
    expect(Buffer.from(tron!.bytes).toString("hex")).toBe(Buffer.from(SECP_REFERENCE_PUBKEY).toString("hex"));
    const asEvm = await verifyMultiPayload({ standard: "erc191", payload: "Hello, TRON!", signature: secp(fixV(TIP191_SIG_V28)) });
    expect(asEvm && Buffer.from(asEvm.bytes).toString("hex")).not.toBe(Buffer.from(SECP_REFERENCE_PUBKEY).toString("hex"));
  });

  it("ton_connect (text): verifies the reference vector", async () => {
    const key = await verifyMultiPayload(TON_TEXT_VECTOR);
    expect(key && formatSignerKey(key)).toBe(TON_TEXT_VECTOR.public_key);
  });

  it("ton_connect: a changed domain, timestamp, address or text does not verify", async () => {
    expect(await verifyMultiPayload({ ...TON_TEXT_VECTOR, domain: "evil.example" })).toBeNull();
    expect(await verifyMultiPayload({ ...TON_TEXT_VECTOR, timestamp: TON_TEXT_VECTOR.timestamp + 1 })).toBeNull();
    expect(
      await verifyMultiPayload({ ...TON_TEXT_VECTOR, address: TON_TEXT_VECTOR.address.replace("f480", "f481") })
    ).toBeNull();
    expect(await verifyMultiPayload({ ...TON_TEXT_VECTOR, payload: { type: "text", text: "Hello, TON!" } })).toBeNull();
  });

  it("ton_connect: the timestamp may arrive as a digit string", async () => {
    const key = await verifyMultiPayload({ ...TON_TEXT_VECTOR, timestamp: String(TON_TEXT_VECTOR.timestamp) });
    expect(key).not.toBeNull();
  });

  it("ton_connect: a binary or cell payload is refused (the app only signs text)", async () => {
    expect(await verifyMultiPayload({ ...TON_TEXT_VECTOR, payload: { type: "binary", bytes: "AA==" } })).toBeNull();
  });

  it("sep53: verifies both reference vectors, and not across them", async () => {
    const publicKey = ed(Keypair.fromSecret(SEP53_SEED).rawPublicKey());
    for (const [message, signatureB64] of SEP53_VECTORS) {
      const signature = ed(Uint8Array.from(Buffer.from(signatureB64, "base64")));
      const key = await verifyMultiPayload({ standard: "sep53", payload: message, public_key: publicKey, signature });
      expect(key && formatSignerKey(key)).toBe(publicKey);
    }
    const crossed = ed(Uint8Array.from(Buffer.from(SEP53_VECTORS[1][1], "base64")));
    expect(
      await verifyMultiPayload({ standard: "sep53", payload: SEP53_VECTORS[0][0], public_key: publicKey, signature: crossed })
    ).toBeNull();
  });

  it("nep413: verifies near-api-js's own NEP-413 signature (independent serializer)", async () => {
    const keyPair = KeyPair.fromRandom("ed25519");
    const nonce = new Uint8Array(32).fill(7);
    const params = { message: '{"signer_id":"x"}', recipient: "intentfolio-staging.near", nonce };
    const signed = await new KeyPairSigner(keyPair).signNep413Message("x.near", params);
    const mp = {
      standard: "nep413",
      payload: { message: params.message, nonce: Buffer.from(nonce).toString("base64"), recipient: params.recipient },
      public_key: signed.publicKey.toString(),
      signature: ed(signed.signature),
    };
    const key = await verifyMultiPayload(mp);
    expect(key && formatSignerKey(key)).toBe(keyPair.getPublicKey().toString());
    // Each field is inside the signed bytes.
    expect(await verifyMultiPayload({ ...mp, payload: { ...mp.payload, recipient: "intents.near" } })).toBeNull();
    expect(
      await verifyMultiPayload({ ...mp, payload: { ...mp.payload, nonce: Buffer.alloc(32, 8).toString("base64") } })
    ).toBeNull();
    expect(await verifyMultiPayload({ ...mp, payload: { ...mp.payload, callbackUrl: "https://x" } })).toBeNull();
  });

  it("nep413: a callbackUrl is part of what is signed", async () => {
    const keyPair = KeyPair.fromRandom("ed25519");
    const nonce = new Uint8Array(32).fill(3);
    const params = { message: "m", recipient: "r.near", nonce, callbackUrl: "https://cb.example" };
    const signed = await new KeyPairSigner(keyPair).signNep413Message("x.near", params);
    const key = await verifyMultiPayload({
      standard: "nep413",
      payload: { message: "m", nonce: Buffer.from(nonce).toString("base64"), recipient: "r.near", callbackUrl: params.callbackUrl },
      public_key: signed.publicKey.toString(),
      signature: ed(signed.signature),
    });
    expect(key).not.toBeNull();
  });

  it("refuses the schemes the app does not produce, and junk", async () => {
    expect(await verifyMultiPayload({ standard: "webauthn", payload: "{}" })).toBeNull();
    expect(await verifyMultiPayload(null)).toBeNull();
    expect(await verifyMultiPayload({ standard: "erc191", payload: 42, signature: "secp256k1:1" })).toBeNull();
    expect(await verifyMultiPayload({ ...RAW_ED25519_VECTOR, public_key: "secp256k1:8rVvtHWFr8hasdQGGD5WiQBTyr4iH2ruEPPVfj491RPN" })).toBeNull();
  });
});

describe("extractDefuseEnvelope", () => {
  const nowSecs = 1_900_000_000;
  const changeSet = buildCommitChangeSet({ portfolioId: "7", unallocations: [{ tokenId: "nep141:wrap.near", amount: "5" }] });

  it("nep413: verifying_contract is the recipient and the nonce sits beside the message", () => {
    const { request } = buildCommitSignRequest({
      signerId: "alice.near",
      deadlineSecs: nowSecs,
      vaultId: "intentfolio-staging.near",
      changeSet,
      nonceTail: new Uint8Array(15),
    });
    const env = extractDefuseEnvelope({
      standard: "nep413",
      payload: { message: request.message, nonce: Buffer.from(request.nonce).toString("base64"), recipient: request.recipient },
    });
    expect(env?.signerId).toBe("alice.near");
    expect(env?.verifyingContract).toBe("intentfolio-staging.near");
    expect(Buffer.from(env!.nonce)).toEqual(Buffer.from(request.nonce));
    expect(env?.message).toEqual(changeSet);
  });

  it("the flattened form (every other family) carries the same envelope inside the payload", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const signerId = account.address.toLowerCase();
    const { erc191Message, request } = buildCommitSignRequest({
      signerId,
      deadlineSecs: nowSecs,
      vaultId: "intentfolio-staging.near",
      changeSet,
    });
    const env = extractDefuseEnvelope({ standard: "erc191", payload: erc191Message });
    expect(env?.signerId).toBe(signerId);
    expect(env?.verifyingContract).toBe("intentfolio-staging.near");
    expect(Buffer.from(env!.nonce)).toEqual(Buffer.from(request.nonce));
    expect(env?.message).toEqual(changeSet);

    // And the signature a real EVM wallet makes over it recovers that same account.
    const signature = await account.signMessage({ message: erc191Message });
    const v = parseInt(signature.slice(-2), 16);
    const wire = hex(signature.slice(2, -2) + (v >= 27 ? v - 27 : v).toString(16).padStart(2, "0"));
    const key = await verifyMultiPayload({ standard: "erc191", payload: erc191Message, signature: secp(wire) });
    expect(implicitAccountId(key!)).toBe(signerId);
  });

  it("ton_connect: the envelope is the signed text", () => {
    const { erc191Message } = buildCommitSignRequest({
      signerId: "ab".repeat(32),
      deadlineSecs: nowSecs,
      vaultId: "intentfolio-staging.near",
      changeSet,
    });
    const env = extractDefuseEnvelope({ ...TON_TEXT_VECTOR, payload: { type: "text", text: erc191Message } });
    expect(env?.signerId).toBe("ab".repeat(32));
    expect(env?.message).toEqual(changeSet);
  });

  it("null for a payload without a 32-byte nonce, a signer or a verifying contract", () => {
    expect(extractDefuseEnvelope({ standard: "erc191", payload: JSON.stringify({ signer_id: "a", verifying_contract: "b", nonce: "AA==" }) })).toBeNull();
    expect(extractDefuseEnvelope({ standard: "erc191", payload: "not json" })).toBeNull();
    expect(extractDefuseEnvelope({ standard: "webauthn", payload: "{}" })).toBeNull();
  });
});

describe("isImplicitAccountId", () => {
  it("accepts the two implicit forms, lowercase only", () => {
    expect(isImplicitAccountId("ab".repeat(32))).toBe(true);
    expect(isImplicitAccountId(`0x${"ab".repeat(20)}`)).toBe(true);
    expect(isImplicitAccountId("pablofork.near")).toBe(false);
    expect(isImplicitAccountId("AB".repeat(32))).toBe(false);
  });
});
