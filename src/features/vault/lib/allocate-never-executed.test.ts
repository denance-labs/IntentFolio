import { describe, it, expect } from "vitest";
import { envelopeWitness } from "./allocate-never-executed";
import type { AllocateRescueRecord } from "./allocate-rescue-store";

// D-295: records from before D-312 carry the nonce and the envelope deadline only inside the
// signed envelope. Every wire shape the signers produce is read here; anything else is `null`
// (no witness ⇒ no proof ⇒ the record keeps being shown).

const NONCE = "Vij2xgAlKBKzAOwAr9Q82hgtbidRbTLp9YQUvUnPUdg=";
const DEADLINE = "2026-09-20T23:34:46.000Z";
const DEADLINE_SECS = Date.parse(DEADLINE) / 1000;
const canonical = JSON.stringify({ signer_id: "x", verifying_contract: "intents.near", deadline: DEADLINE, nonce: NONCE, intents: [] });

function rec(over: Partial<AllocateRescueRecord>): AllocateRescueRecord {
  return {
    id: "r",
    signerId: "x",
    msg: "{}",
    vaultId: "v",
    portfolioName: "p",
    legs: [],
    createdAt: 0,
    status: "submitted",
    ...over,
  };
}

describe("envelopeWitness", () => {
  it("prefers the record's own fields (written since D-312)", () => {
    const r = rec({ verifierNonce: "own", envelopeDeadlineSecs: 42, signedEnvelope: { standard: "erc191", payload: canonical } });
    expect(envelopeWitness(r)).toEqual({ nonceBase64: "own", envelopeDeadlineSecs: 42 });
  });

  it("reads NEP-413: nonce beside the message, deadline inside it", () => {
    const r = rec({
      signedEnvelope: {
        standard: "nep413",
        payload: { message: JSON.stringify({ signer_id: "x", deadline: DEADLINE, intents: [] }), nonce: NONCE, recipient: "intents.near" },
      },
    });
    expect(envelopeWitness(r)).toEqual({ nonceBase64: NONCE, envelopeDeadlineSecs: DEADLINE_SECS });
  });

  it.each(["erc191", "tip191", "sep53", "raw_ed25519"])("reads the canonical JSON string of %s", (standard) => {
    const r = rec({ signedEnvelope: { standard, payload: canonical } });
    expect(envelopeWitness(r)).toEqual({ nonceBase64: NONCE, envelopeDeadlineSecs: DEADLINE_SECS });
  });

  it("reads TON's `payload.text`", () => {
    const r = rec({ signedEnvelope: { standard: "ton_connect", payload: { type: "text", text: canonical } } });
    expect(envelopeWitness(r)).toEqual({ nonceBase64: NONCE, envelopeDeadlineSecs: DEADLINE_SECS });
  });

  it.each([
    ["no envelope", undefined],
    ["no payload", { standard: "nep413" }],
    ["a message that is not JSON", { standard: "nep413", payload: { message: "not json", nonce: NONCE } }],
    ["a missing nonce", { standard: "nep413", payload: { message: JSON.stringify({ deadline: DEADLINE }) } }],
    ["a deadline that is not a date", { standard: "erc191", payload: JSON.stringify({ nonce: NONCE, deadline: "soon" }) }],
    ["a numeric deadline", { standard: "erc191", payload: JSON.stringify({ nonce: NONCE, deadline: 1 }) }],
    ["an unknown object payload", { standard: "webauthn", payload: { foo: 1 } }],
    ["a payload that is not JSON", { standard: "erc191", payload: "hello" }],
  ])("is null for %s — and never throws", (_why, signedEnvelope) => {
    expect(envelopeWitness(rec({ signedEnvelope }))).toBeNull();
  });
});
