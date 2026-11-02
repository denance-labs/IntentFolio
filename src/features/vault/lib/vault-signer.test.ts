import { describe, it, expect, vi } from "vitest";
import bs58 from "bs58";
import {
  MultiPayloadRawEd25519Validator,
  MultiPayloadSep53Validator,
  MultiPayloadTip191Validator,
  MultiPayloadTonConnectValidator,
  type Validator,
} from "@defuse-protocol/contract-types/validate";
import {
  nep413VaultSigner,
  erc191VaultSigner,
  ed25519VaultSigner,
  tip191VaultSigner,
  tonConnectVaultSigner,
  type SignMessage,
  type VaultSignRequest,
} from "./vault-signer";
import type { Signature } from "@/features/intents-account/mock-contract/types";

// What these cover is the seam Phase 0b introduced: ONE envelope, two schemes, and the
// rule that each signer must sign ITS OWN form and ship exactly that. Signing the wrong
// form is not a type error and not a runtime error — it is a signature the contract
// rejects after the user already approved it, which is the expensive failure.

const NEAR_ACCOUNT = "alice.near";
const EVM_ACCOUNT = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

const NEP413_MESSAGE = JSON.stringify({ signer_id: NEAR_ACCOUNT, intents: [] });
const ERC191_MESSAGE = JSON.stringify(
  { signer_id: EVM_ACCOUNT, verifying_contract: "intents.near", nonce: "AAAA", intents: [] },
  null,
  2
);

const request: VaultSignRequest = {
  nep413: {
    message: NEP413_MESSAGE,
    recipient: "intents.near",
    nonce: new Uint8Array(32).fill(3),
  },
  erc191Message: ERC191_MESSAGE,
};

describe("nep413VaultSigner", () => {
  it("signs the NEP-413 form and assembles a nep413 MultiPayload", async () => {
    const wallet = {
      signNEP413Message: vi.fn().mockResolvedValue({
        accountId: NEAR_ACCOUNT,
        publicKey: "ed25519:8rVvtHWFr8hasdQGGD5WiQBTyr4iH2ruEPPVfj491RPN",
        signature: Buffer.from(new Uint8Array(64)).toString("base64"),
      }),
      signAndSendTransaction: vi.fn(),
    };

    const mp = (await nep413VaultSigner(wallet, NEAR_ACCOUNT).signEnvelope(request)) as {
      standard: string;
      payload: { message: string; recipient: string };
    };

    expect(wallet.signNEP413Message).toHaveBeenCalledWith({
      message: NEP413_MESSAGE,
      recipient: "intents.near",
      nonce: request.nep413.nonce,
    });
    expect(mp.standard).toBe("nep413");
    expect(mp.payload.message).toBe(NEP413_MESSAGE);
  });
});

describe("erc191VaultSigner", () => {
  function evmSignature(): Signature {
    return { scheme: "erc191", payload: ERC191_MESSAGE, signature: `0x${"11".repeat(64)}1b` };
  }

  it("signs the ERC-191 form — NOT the NEP-413 one", async () => {
    const signMessage = vi.fn().mockResolvedValue(evmSignature());

    await erc191VaultSigner(signMessage, EVM_ACCOUNT).signEnvelope(request);

    expect(signMessage).toHaveBeenCalledWith(ERC191_MESSAGE, EVM_ACCOUNT);
    // The NEP-413 message omits verifying_contract and nonce; signing it would authorise a
    // payload the contract cannot reconstruct.
    expect(signMessage).not.toHaveBeenCalledWith(NEP413_MESSAGE, expect.anything());
  });

  it("ships the signed string verbatim as the payload", async () => {
    const signMessage = vi.fn().mockResolvedValue(evmSignature());

    const mp = (await erc191VaultSigner(signMessage, EVM_ACCOUNT).signEnvelope(request)) as {
      standard: string;
      payload: string;
      signature: string;
    };

    expect(mp.standard).toBe("erc191");
    expect(mp.payload).toBe(ERC191_MESSAGE);
    // The SDK re-encodes hex -> base58 with a curve prefix; the contract recovers the
    // pubkey from it, so the shape is part of the wire contract.
    expect(mp.signature).toMatch(/^secp256k1:/);
  });

  it("refuses a signature that is not erc191", async () => {
    // `signMessage` is the shared entry point for all six families. A mis-wired adapter
    // returning ed25519 here would otherwise be labelled erc191 and sent to the Verifier.
    const signMessage = vi.fn().mockResolvedValue({
      scheme: "raw_ed25519",
      payload: ERC191_MESSAGE,
      signature: "sig",
      publicKey: "ed25519:x",
    } satisfies Signature);

    await expect(
      erc191VaultSigner(signMessage, EVM_ACCOUNT).signEnvelope(request)
    ).rejects.toThrow(/Expected a "erc191" signature/);
  });

  it("propagates a rejected signature instead of submitting anything", async () => {
    const signMessage = vi.fn().mockRejectedValue(new Error("User rejected"));

    await expect(
      erc191VaultSigner(signMessage, EVM_ACCOUNT).signEnvelope(request)
    ).rejects.toThrow("User rejected");
  });
});

// ── Block 4.1: the four non-EVM, non-NEAR families ───────────────────────────
// These pin the two things a "compiles" cannot catch, both of which produce a signature the
// user already approved and the contract then rejects (or worse, a payload they never saw):
//   1. the wire ENCODING of the signature and the public key, checked against an
//      independently derived value rather than against the code under test;
//   2. the MultiPayload SHAPE, checked against contract-types' own validators.

const SOLANA_PUBKEY = "6dNVEs1CWnDJoRJgYNvKKPRSGNwFpVfg7bMcNQ6qhFHu"; // base58, 32 bytes
const STELLAR_ADDRESS = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
const TON_PUBKEY_HEX = "e1c1b2a3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f";
const TRON_ACCOUNT = "0x41e552f6487585c2b58bc2c9bb4492bc1f17132cd0";

/** 64 raw signature bytes — enough to be re-encoded, never a real signature. */
const SIG_BYTES = new Uint8Array(64).fill(7);
const SIG_BASE58 = bs58.encode(SIG_BYTES);
const SIG_BASE64 = Buffer.from(SIG_BYTES).toString("base64");

function assertValid<I, O>(name: string, validator: Validator<I, O>, value: unknown): void {
  const result = validator.validate(JSON.parse(JSON.stringify(value)));
  const issues = "issues" in result ? result.issues : undefined;
  expect(issues, `${name}: ${JSON.stringify(issues)}`).toBeUndefined();
}

describe("tip191VaultSigner (Tron)", () => {
  const tronSig: Signature = {
    scheme: "tip191",
    payload: ERC191_MESSAGE,
    signature: `0x${"22".repeat(64)}1c`,
  };

  it("signs the flattened form and ships it verbatim under the tip191 standard", async () => {
    const signMessage = vi.fn().mockResolvedValue(tronSig);

    const mp = (await tip191VaultSigner(signMessage, TRON_ACCOUNT).signEnvelope(request)) as {
      standard: string;
      payload: string;
      signature: string;
    };

    expect(signMessage).toHaveBeenCalledWith(ERC191_MESSAGE, TRON_ACCOUNT);
    expect(signMessage).not.toHaveBeenCalledWith(NEP413_MESSAGE, expect.anything());
    // Same shape as erc191 — only the standard differs, which is the whole point of D-183.
    expect(mp.standard).toBe("tip191");
    expect(mp.payload).toBe(ERC191_MESSAGE);
    expect(mp.signature).toMatch(/^secp256k1:/);
    assertValid("MultiPayloadTip191", MultiPayloadTip191Validator, mp);
  });

  it("refuses a signature that is not tip191", async () => {
    const signMessage = vi.fn().mockResolvedValue({
      scheme: "erc191",
      payload: ERC191_MESSAGE,
      signature: `0x${"22".repeat(64)}1c`,
    } satisfies Signature);

    await expect(
      tip191VaultSigner(signMessage, TRON_ACCOUNT).signEnvelope(request)
    ).rejects.toThrow(/Expected a "tip191" signature/);
  });
});

describe("ed25519VaultSigner — Solana (raw_ed25519)", () => {
  const solanaSig: Signature = {
    scheme: "raw_ed25519",
    payload: ERC191_MESSAGE,
    signature: SIG_BASE58,
    publicKey: SOLANA_PUBKEY,
  };

  function signer(signMessage: SignMessage) {
    return ed25519VaultSigner({
      signMessage,
      family: "solana",
      signerId: "deadbeef", // hex intents account id — deliberately NOT the wallet address
      walletAddress: SOLANA_PUBKEY,
    });
  }

  it("decodes the base58 signature and derives the public key from the WALLET address", async () => {
    const signMessage = vi.fn().mockResolvedValue(solanaSig);

    const mp = (await signer(signMessage).signEnvelope(request)) as {
      standard: string;
      payload: string;
      public_key: string;
      signature: string;
    };

    expect(mp.standard).toBe("raw_ed25519");
    // The SDK signs BYTES here and decodes them back — the payload must survive that trip.
    expect(mp.payload).toBe(ERC191_MESSAGE);
    // Derived independently of the code under test: base58 -> bytes -> base58 is identity.
    expect(mp.signature).toBe(`ed25519:${SIG_BASE58}`);
    // If `signerId` (hex) leaked into userAddress, this would be the wrong key entirely.
    expect(mp.public_key).toBe(`ed25519:${SOLANA_PUBKEY}`);
    assertValid("MultiPayloadRawEd25519", MultiPayloadRawEd25519Validator, mp);
  });

  it("refuses a signature that is not raw_ed25519", async () => {
    const signMessage = vi.fn().mockResolvedValue({
      scheme: "sep53",
      payload: ERC191_MESSAGE,
      signature: SIG_BASE64,
      publicKey: STELLAR_ADDRESS,
    } satisfies Signature);

    await expect(signer(signMessage).signEnvelope(request)).rejects.toThrow(
      /Expected a "raw_ed25519" signature/
    );
  });
});

describe("ed25519VaultSigner — Stellar (sep53)", () => {
  const stellarSig: Signature = {
    scheme: "sep53",
    payload: ERC191_MESSAGE,
    signature: SIG_BASE64,
    publicKey: STELLAR_ADDRESS,
  };

  function signer(signMessage: SignMessage) {
    return ed25519VaultSigner({
      signMessage,
      family: "stellar",
      signerId: "deadbeef",
      walletAddress: STELLAR_ADDRESS,
    });
  }

  it("decodes the base64 signature and the G… address into an ed25519 public key", async () => {
    const signMessage = vi.fn().mockResolvedValue(stellarSig);

    const mp = (await signer(signMessage).signEnvelope(request)) as {
      standard: string;
      payload: string;
      public_key: string;
      signature: string;
    };

    expect(mp.standard).toBe("sep53");
    expect(mp.payload).toBe(ERC191_MESSAGE);
    // Stellar hands us base64 where Solana hands us base58 — the same 64 bytes must come
    // out the other side either way.
    expect(mp.signature).toBe(`ed25519:${SIG_BASE58}`);
    // The G… address is strkey, not raw bytes: the SDK strips its version byte and CRC.
    expect(mp.public_key).toMatch(/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/);
    expect(mp.public_key).not.toContain(STELLAR_ADDRESS);
    assertValid("MultiPayloadSep53", MultiPayloadSep53Validator, mp);
  });

  it("refuses a signature that is not sep53", async () => {
    const signMessage = vi.fn().mockResolvedValue({
      scheme: "raw_ed25519",
      payload: ERC191_MESSAGE,
      signature: SIG_BASE58,
      publicKey: SOLANA_PUBKEY,
    } satisfies Signature);

    await expect(signer(signMessage).signEnvelope(request)).rejects.toThrow(
      /Expected a "sep53" signature/
    );
  });
});

describe("tonConnectVaultSigner", () => {
  function tonSig(overrides: Partial<Extract<Signature, { scheme: "ton_connect" }>> = {}) {
    return {
      scheme: "ton_connect" as const,
      address: "0:e1c1b2a3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f",
      domain: "intentfolio.app",
      timestamp: "1800000000",
      text: ERC191_MESSAGE,
      signature: SIG_BASE64,
      publicKey: TON_PUBKEY_HEX,
      ...overrides,
    };
  }

  function signer(signMessage: SignMessage) {
    return tonConnectVaultSigner(signMessage, "deadbeef", TON_PUBKEY_HEX);
  }

  it("carries the wallet's own address, domain and timestamp onto the wire", async () => {
    const signMessage = vi.fn().mockResolvedValue(tonSig());

    const mp = (await signer(signMessage).signEnvelope(request)) as {
      standard: string;
      address: string;
      domain: string;
      timestamp: number;
      payload: { type: string; text: string };
      public_key: string;
      signature: string;
    };

    expect(mp.standard).toBe("ton_connect");
    expect(mp.payload).toEqual({ type: "text", text: ERC191_MESSAGE });
    expect(mp.address).toBe(tonSig().address);
    expect(mp.domain).toBe("intentfolio.app");
    // The union stores it as a string; the contract wants the number back.
    expect(mp.timestamp).toBe(1_800_000_000);
    expect(mp.signature).toBe(`ed25519:${SIG_BASE58}`);
    expect(mp.public_key).toMatch(/^ed25519:/);
    assertValid("MultiPayloadTonConnect", MultiPayloadTonConnectValidator, mp);
  });

  it("refuses to submit a text the wallet changed", async () => {
    // TON is the only family whose signed string reaches the wire from the wallet, so this
    // is the only place a swapped payload could be submitted under a valid signature.
    const signMessage = vi.fn().mockResolvedValue(tonSig({ text: "something else entirely" }));

    await expect(signer(signMessage).signEnvelope(request)).rejects.toThrow(
      /signed a different text/
    );
  });

  it("refuses a signature that is not ton_connect", async () => {
    const signMessage = vi.fn().mockResolvedValue({
      scheme: "erc191",
      payload: ERC191_MESSAGE,
      signature: `0x${"22".repeat(64)}1c`,
    } satisfies Signature);

    await expect(signer(signMessage).signEnvelope(request)).rejects.toThrow(
      /Expected a "ton_connect" signature/
    );
  });
});
