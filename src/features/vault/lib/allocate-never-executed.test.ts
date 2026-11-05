import { describe, it, expect, vi } from "vitest";
import { envelopeWitness, provesNeverExecuted, readEnvelopeOutcome } from "./allocate-never-executed";
import type { AllocateRescueRecord } from "./allocate-rescue-store";
import { buildVersionedV1Nonce } from "./vault-envelope";

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

// D-556: this answer ends in "your deposit didn't go through" and, for a `submitted` record, in a
// `failed` that leaves the solver's worklist. So the chain's clock decides, never the browser's.
describe("readEnvelopeOutcome", () => {
  const CLOSES_SECS = 1_800_000_000;
  const CLOSED_MS = (CLOSES_SECS + 61) * 1000;
  const NONCE_DEADLINE_SECS = CLOSES_SECS + 7 * 86_400;
  const verifierNonce = Buffer.from(
    buildVersionedV1Nonce({
      deadlineSecs: NONCE_DEADLINE_SECS,
      salt: Uint8Array.of(0x25, 0x28, 0x12, 0xb3),
      tail: new Uint8Array(15),
    })
  ).toString("base64");
  const sent = rec({ verifierNonce, envelopeDeadlineSecs: CLOSES_SECS });
  const read = (over: Partial<{ nonceUsed: boolean; saltValid: boolean; blockTimestampMs: number }> = {}) =>
    vi.fn(async () => ({ nonceUsed: false, saltValid: true, blockTimestampMs: CLOSED_MS, ...over }));

  it("never_executed: unused, valid salt, read at a block past the close", async () => {
    await expect(readEnvelopeOutcome(sent, read(), CLOSED_MS)).resolves.toBe("never_executed");
    await expect(provesNeverExecuted(sent, read(), CLOSED_MS)).resolves.toBe(true);
  });

  it("a browser clock behind the chain does not delay it", async () => {
    await expect(readEnvelopeOutcome(sent, read(), CLOSES_SECS * 1000 - 3_600_000)).resolves.toBe("never_executed");
  });

  it("executed: a burnt nonce, whatever the block's age, since a stale node can only under-report", async () => {
    const burnt = read({ nonceUsed: true, blockTimestampMs: CLOSES_SECS * 1000 - 3_600_000 });
    await expect(readEnvelopeOutcome(sent, burnt, CLOSED_MS)).resolves.toBe("executed");
    await expect(provesNeverExecuted(sent, burnt, CLOSED_MS)).resolves.toBe(false);
  });

  it.each<[string, Parameters<typeof read>[0]]>([
    ["a node hours behind: its block is from before the close", { blockTimestampMs: CLOSES_SECS * 1000 - 3 * 3_600_000 }],
    ["the block is exactly at the end of the margin", { blockTimestampMs: (CLOSES_SECS + 60) * 1000 }],
    ["the block is past the nonce's own deadline", { blockTimestampMs: NONCE_DEADLINE_SECS * 1000 }],
    ["the salt was invalidated", { saltValid: false }],
    ["a block clock that is not a number", { blockTimestampMs: Number.NaN }],
  ])("unknown under a browser clock past the close: %s", async (_why, over) => {
    await expect(readEnvelopeOutcome(sent, read(over), CLOSED_MS)).resolves.toBe("unknown");
  });

  it("unknown when the read fails", async () => {
    const down = vi.fn(() => Promise.reject(new Error("rpc down")));
    await expect(readEnvelopeOutcome(sent, down, CLOSED_MS)).resolves.toBe("unknown");
  });

  it("does not read a nonce this browser already sees as expired", async () => {
    const witness = read();
    await expect(readEnvelopeOutcome(sent, witness, NONCE_DEADLINE_SECS * 1000)).resolves.toBe("unknown");
    expect(witness).not.toHaveBeenCalled();
  });

  it("does not read without a witness", async () => {
    const witness = read();
    await expect(readEnvelopeOutcome(rec({}), witness, CLOSED_MS)).resolves.toBe("unknown");
    expect(witness).not.toHaveBeenCalled();
  });
});
