import { describe, it, expect } from "vitest";
import { prepareBroadcastRequest } from "@defuse-protocol/internal-utils";
import {
  IntentTransferValidator,
  IntentAuthCallValidator,
  Nep413DefuseMessageFor_DefuseIntentsValidator,
  Nep413PayloadValidator,
  MultiPayloadNep413Validator,
  MultiPayloadErc191Validator,
  type Validator,
} from "@defuse-protocol/contract-types/validate";
import {
  buildVersionedV1Nonce,
  decodeV1Nonce,
  buildAllocateSignRequest,
  buildCommitSignRequest,
  Nep413SignRequest,
  VERSIONED_NONCE_MAGIC,
  COMMIT_NONCE_SALT,
} from "./vault-envelope";
import { buildAuthCallSetupMsg, buildCommitChangeSet } from "./vault-payloads";

// Offline proof (Phase 0, no network, no signing): the hand-rolled NEP-413 envelope our
// builders emit, once assembled by the CANONICAL SDK path (`prepareSwapSignedData`), passes
// the CANONICAL contract-types validators — and the versioned nonce matches defuse-core's
// exact byte layout. This is the anti-orphan guarantee for the envelope, mirroring what the
// golden-vector test does for the money-critical bodies.

const VAULT_ID = "intentfolio-staging.near";
const TOKEN = "nep141:usdc.near";
const SIGNER = "alice.near";
const DEADLINE_SECS = 1_800_000_000; // fixed, comfortably future
// Allocate nonces outlive their envelope (ADR-0017 §5 as amended); the builder rejects the reverse.
const NONCE_DEADLINE_SECS = DEADLINE_SECS + 10 * 24 * 60 * 60;
const SALT = Uint8Array.of(0x1a, 0x2b, 0x3c, 0x4d);
const TAIL = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15);

function assertValid<I, O>(name: string, validator: Validator<I, O>, value: unknown): void {
  const result = validator.validate(value);
  const issues = "issues" in result ? result.issues : undefined;
  expect(issues, `${name}: ${JSON.stringify(issues)}`).toBeUndefined();
}

// Assemble a submit-ready MultiPayloadNep413 from a sign-request via the SDK's canonical
// assembler, using a placeholder signature (Phase 0 signs nothing). The signature must be
// valid base64 (the SDK re-encodes it base64 -> base58); 64 zero bytes stand in.
function assembleMultiPayload(req: Nep413SignRequest): unknown {
  const placeholderSig = Buffer.from(new Uint8Array(64)).toString("base64");
  const mp = prepareBroadcastRequest.prepareSwapSignedData(
    {
      type: "NEP413",
      signatureData: {
        accountId: SIGNER,
        publicKey: "ed25519:8rVvtHWFr8hasdQGGD5WiQBTyr4iH2ruEPPVfj491RPN",
        signature: placeholderSig,
      },
      signedData: { message: req.message, recipient: req.recipient, nonce: req.nonce },
    },
    { userAddress: SIGNER, userChainType: "near" }
  );
  // JSON round-trip drops any `callbackUrl: undefined` key, matching the wire form the
  // relay/contract actually sees (and what ajv validates cleanly).
  return JSON.parse(JSON.stringify(mp));
}

describe("versioned V1 nonce — byte layout vs defuse-core", () => {
  it("lays out magic || version || salt || deadline(i64 LE ns) || tail", () => {
    const nonce = buildVersionedV1Nonce({ deadlineSecs: DEADLINE_SECS, salt: SALT, tail: TAIL });
    expect(nonce.length).toBe(32);
    expect([...nonce.slice(0, 4)]).toEqual([...VERSIONED_NONCE_MAGIC]); // magic 5628f6c6
    expect(nonce[4]).toBe(0x00); // V1 discriminant
    expect([...nonce.slice(5, 9)]).toEqual([...SALT]);
    const deadlineNs = new DataView(nonce.buffer).getBigInt64(9, true); // little-endian i64
    expect(deadlineNs).toBe(BigInt(DEADLINE_SECS) * BigInt(1_000_000_000));
    expect([...nonce.slice(17, 32)]).toEqual([...TAIL]);
  });

  it("defaults commit salt to the ignored zero salt", () => {
    const nonce = buildVersionedV1Nonce({ deadlineSecs: DEADLINE_SECS, tail: TAIL });
    expect([...nonce.slice(5, 9)]).toEqual([...COMMIT_NONCE_SALT]);
  });

  it("rejects a mis-sized salt or tail", () => {
    expect(() =>
      buildVersionedV1Nonce({ deadlineSecs: DEADLINE_SECS, salt: Uint8Array.of(1, 2, 3) })
    ).toThrow(/salt must be 4 bytes/);
    expect(() =>
      buildVersionedV1Nonce({ deadlineSecs: DEADLINE_SECS, tail: Uint8Array.of(1) })
    ).toThrow(/tail must be 15 bytes/);
  });
});

describe("② Allocate envelope — [Transfer, AuthCall] validates canonically", () => {
  const authCallMsg = buildAuthCallSetupMsg({
    deadline: DEADLINE_SECS,
    nonce: Array(32).fill(7),
    chain: "near",
    address: SIGNER,
    portfolioName: "Roundtrip",
    composition: [{ tokenId: TOKEN, targetBps: 10000, toleranceBps: 500 }],
    allocations: [{ tokenId: TOKEN, amount: "1000000" }],
  });
  const { request, erc191Message, intents } = buildAllocateSignRequest({
    signerId: SIGNER,
    deadlineSecs: DEADLINE_SECS,
    nonceDeadlineSecs: NONCE_DEADLINE_SECS,
    salt: SALT,
    vaultId: VAULT_ID,
    transfers: [{ tokenId: TOKEN, amount: "1000000" }],
    authCallMsg,
    nonceTail: TAIL,
  });

  it("emits exactly [transfer -> vault, auth_call -> vault]", () => {
    assertValid("IntentTransfer", IntentTransferValidator, intents[0]);
    assertValid("IntentAuthCall", IntentAuthCallValidator, intents[1]);
    expect(intents[0]).toMatchObject({ intent: "transfer", receiver_id: VAULT_ID });
    expect(intents[1]).toMatchObject({ intent: "auth_call", contract_id: VAULT_ID, msg: authCallMsg });
  });

  it("inner message is a valid DefuseIntents message recipient=intents.near", () => {
    expect(request.recipient).toBe("intents.near");
    assertValid(
      "Nep413DefuseMessage",
      Nep413DefuseMessageFor_DefuseIntentsValidator,
      JSON.parse(request.message)
    );
  });

  // The nonce's deadline is the Verifier's permission to sweep it once used, and a swept
  // nonce reads as "never executed" to the orphan resolver (solver `921` §3 #3, `922`
  // §3.4 #1). So it is fed separately from the envelope deadline and pinned here.
  describe("nonce deadline is decoupled from the envelope deadline", () => {
    const nanos = BigInt(1_000_000_000);

    it("embeds nonceDeadlineSecs in the nonce and deadlineSecs in the signed message", () => {
      const encoded = new DataView(request.nonce.buffer, request.nonce.byteOffset).getBigInt64(9, true);
      expect(encoded).toBe(BigInt(NONCE_DEADLINE_SECS) * nanos);
      expect(JSON.parse(request.message).deadline).toBe(new Date(DEADLINE_SECS * 1000).toISOString());
      // Same nonce bytes and same envelope deadline on the erc191 twin.
      const erc = JSON.parse(erc191Message);
      expect([...Buffer.from(erc.nonce, "base64")]).toEqual([...request.nonce]);
      expect(erc.deadline).toBe(new Date(DEADLINE_SECS * 1000).toISOString());
    });

    it("REFUSES a nonce deadline before the envelope deadline — the Verifier would too", () => {
      // `deadline is greater than nonce` on mainnet (`921` §2); failing here is cheaper.
      expect(() =>
        buildAllocateSignRequest({
          signerId: SIGNER,
          deadlineSecs: DEADLINE_SECS,
          nonceDeadlineSecs: DEADLINE_SECS - 1,
          salt: SALT,
          vaultId: VAULT_ID,
          transfers: [{ tokenId: TOKEN, amount: "1000000" }],
          authCallMsg,
          nonceTail: TAIL,
        })
      ).toThrow(/nonce deadline .* must not precede the envelope deadline/);
    });

    it("accepts an equal nonce and envelope deadline (the contract's own roundtrip test shape)", () => {
      expect(() =>
        buildAllocateSignRequest({
          signerId: SIGNER,
          deadlineSecs: DEADLINE_SECS,
          nonceDeadlineSecs: DEADLINE_SECS,
          salt: SALT,
          vaultId: VAULT_ID,
          transfers: [{ tokenId: TOKEN, amount: "1000000" }],
          authCallMsg,
          nonceTail: TAIL,
        })
      ).not.toThrow();
    });
  });

  describe("multi-token funding (008.plan Phase 2)", () => {
    const ETH = "nep141:eth-0x0000000000000000000000000000000000000000.omft.near";

    it("carries every token in ONE transfer, still a valid IntentTransfer", () => {
      const multi = buildAllocateSignRequest({
        signerId: SIGNER,
        deadlineSecs: DEADLINE_SECS,
        nonceDeadlineSecs: NONCE_DEADLINE_SECS,
        salt: SALT,
        vaultId: VAULT_ID,
        transfers: [
          { tokenId: TOKEN, amount: "3500000" },
          { tokenId: ETH, amount: "130000000000000" },
        ],
        authCallMsg,
        nonceTail: TAIL,
      });
      // Two tokens, still two intents: the second Transfer that a naive implementation
      // would add is exactly what the vault does not expect.
      expect(multi.intents).toHaveLength(2);
      assertValid("IntentTransfer", IntentTransferValidator, multi.intents[0]);
      expect(multi.intents[0]).toMatchObject({
        intent: "transfer",
        receiver_id: VAULT_ID,
        tokens: { [TOKEN]: "3500000", [ETH]: "130000000000000" },
      });
    });

    it("REFUSES a duplicate token instead of silently keeping the last amount", () => {
      // `{ [t]: a, [t]: b }` collapses to b — the user would sign an amount they never
      // asked for, and the Transfer would settle for it.
      expect(() =>
        buildAllocateSignRequest({
          signerId: SIGNER,
          deadlineSecs: DEADLINE_SECS,
          nonceDeadlineSecs: NONCE_DEADLINE_SECS,
          salt: SALT,
          vaultId: VAULT_ID,
          transfers: [
            { tokenId: TOKEN, amount: "1" },
            { tokenId: TOKEN, amount: "999999" },
          ],
          authCallMsg,
          nonceTail: TAIL,
        })
      ).toThrow(/Duplicate token/);
    });

    it("refuses an empty transfer list", () => {
      expect(() =>
        buildAllocateSignRequest({
          signerId: SIGNER,
          deadlineSecs: DEADLINE_SECS,
          nonceDeadlineSecs: NONCE_DEADLINE_SECS,
          salt: SALT,
          vaultId: VAULT_ID,
          transfers: [],
          authCallMsg,
          nonceTail: TAIL,
        })
      ).toThrow(/at least one transfer/);
    });
  });

  it("assembles into a schema-valid MultiPayloadNep413 with the exact nonce", () => {
    const mp = assembleMultiPayload(request) as { payload: { nonce: string; recipient: string } };
    assertValid("Nep413Payload", Nep413PayloadValidator, mp.payload);
    assertValid("MultiPayloadNep413", MultiPayloadNep413Validator, mp);
    expect(mp.payload.recipient).toBe("intents.near");
    expect([...Buffer.from(mp.payload.nonce, "base64")]).toEqual([...request.nonce]);
  });

  // ── The ERC-191 twin (008.plan Phase 0b) ──────────────────────────────────
  // Same anti-orphan guarantee as above, for the five non-NEAR families.

  it("carries nonce and verifying_contract INSIDE the signed string", () => {
    // The whole reason this builder exists: a MultiPayloadErc191 has nowhere else to put
    // them, so if they are not in the JSON they never reach the contract.
    const payload = JSON.parse(erc191Message);
    expect(payload.verifying_contract).toBe("intents.near");
    expect([...Buffer.from(payload.nonce, "base64")]).toEqual([...request.nonce]);
    expect(payload.signer_id).toBe(SIGNER);
  });

  it("signs the SAME intents and deadline as its NEP-413 twin", () => {
    // Drift between the two forms is the failure this pairing is meant to make impossible:
    // a user would authorise one thing and the chain would execute another.
    const erc = JSON.parse(erc191Message);
    const nep = JSON.parse(request.message);
    expect(erc.intents).toEqual(nep.intents);
    expect(erc.deadline).toBe(nep.deadline);
    expect(erc.signer_id).toBe(nep.signer_id);
  });

  it("assembles into a schema-valid MultiPayloadErc191 whose payload is the signed string", () => {
    const mp = JSON.parse(
      JSON.stringify(
        prepareBroadcastRequest.prepareSwapSignedData(
          {
            type: "ERC191",
            // 65-byte secp256k1 signature: r(32) || s(32) || v. v=27 is normalised to 00.
            signatureData: `0x${"11".repeat(64)}1b`,
            signedData: { message: erc191Message },
          },
          { userAddress: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266", userChainType: "evm" }
        )
      )
    ) as { standard: string; payload: string; signature: string };

    assertValid("MultiPayloadErc191", MultiPayloadErc191Validator, mp);
    expect(mp.standard).toBe("erc191");
    // Byte-identical: the contract recovers the pubkey from (payload, signature), so any
    // re-serialisation between signing and sending would break verification.
    expect(mp.payload).toBe(erc191Message);
  });
});

// D-528: a Setup carries its Storage Cost as a third intent, last, in both signed forms.
describe("② Allocate envelope — the Setup's Storage Cost", () => {
  const authCallMsg = buildAuthCallSetupMsg({
    deadline: DEADLINE_SECS,
    nonce: Array(32).fill(7),
    chain: "near",
    address: SIGNER,
    portfolioName: "Roundtrip",
    composition: [{ tokenId: TOKEN, targetBps: 10000, toleranceBps: 500 }],
    allocations: [{ tokenId: TOKEN, amount: "990000" }],
  });
  const build = (storage?: { tokenId: string; amount: string }) =>
    buildAllocateSignRequest({
      signerId: SIGNER,
      deadlineSecs: DEADLINE_SECS,
      nonceDeadlineSecs: NONCE_DEADLINE_SECS,
      salt: SALT,
      vaultId: VAULT_ID,
      transfers: [{ tokenId: TOKEN, amount: "990000" }],
      authCallMsg,
      storage,
      nonceTail: TAIL,
    });
  const { request, erc191Message, intents } = build({ tokenId: TOKEN, amount: "10000" });

  it("appends a valid IntentTransfer to the ops account, memo `storage`, after the auth_call", () => {
    expect(intents).toHaveLength(3);
    expect(intents[1]).toMatchObject({ intent: "auth_call" });
    assertValid("IntentTransfer (storage)", IntentTransferValidator, intents[2]);
    expect(intents[2]).toEqual({
      intent: "transfer",
      receiver_id: "intentfolio-budget.near",
      tokens: { [TOKEN]: "10000" },
      memo: "storage",
    });
  });

  it("is a valid DefuseIntents message and a valid MultiPayloadNep413", () => {
    assertValid("Nep413DefuseMessage", Nep413DefuseMessageFor_DefuseIntentsValidator, JSON.parse(request.message));
    assertValid("MultiPayloadNep413", MultiPayloadNep413Validator, assembleMultiPayload(request));
  });

  it("signs the same three intents in the ERC-191 form", () => {
    expect(JSON.parse(erc191Message).intents).toEqual(JSON.parse(request.message).intents);
  });

  it("without a storage cost, stays [transfer, auth_call] (AllocateInto)", () => {
    expect(build().intents).toHaveLength(2);
  });

  it("refuses a cost that is not a positive amount of base units", () => {
    for (const amount of ["0", "-1", "1.5", "", "01"]) {
      expect(() => build({ tokenId: TOKEN, amount })).toThrow(/positive amount/);
    }
  });
});

describe("③ Unallocate (commit) envelope — verifying_contract is the vault", () => {
  const changeSet = buildCommitChangeSet({
    portfolioId: "pf-golden-1",
    unallocations: [{ tokenId: TOKEN, amount: "1000000" }],
  });
  const { request, erc191Message: erc191CommitMessage } = buildCommitSignRequest({
    signerId: SIGNER,
    deadlineSecs: DEADLINE_SECS,
    vaultId: VAULT_ID,
    changeSet,
    nonceTail: TAIL,
  });

  it("recipient is the vault, not intents.near (no Verifier in the commit loop)", () => {
    expect(request.recipient).toBe(VAULT_ID);
  });

  it("flattens the changeset next to signer_id + deadline", () => {
    const inner = JSON.parse(request.message);
    expect(inner).toMatchObject({
      signer_id: SIGNER,
      portfolio_id: "pf-golden-1",
      unallocations: [[TOKEN, "1000000"]],
      target_changes: [],
    });
    expect(typeof inner.deadline).toBe("string"); // ISO-8601
  });

  it("uses the fixed (vault-ignored) commit salt in a valid versioned nonce", () => {
    expect([...request.nonce.slice(5, 9)]).toEqual([...COMMIT_NONCE_SALT]);
    expect([...request.nonce.slice(0, 4)]).toEqual([...VERSIONED_NONCE_MAGIC]);
  });

  it("assembles into a schema-valid MultiPayloadNep413", () => {
    const mp = assembleMultiPayload(request) as { payload: { recipient: string } };
    assertValid("Nep413Payload", Nep413PayloadValidator, mp.payload);
    assertValid("MultiPayloadNep413", MultiPayloadNep413Validator, mp);
    expect(mp.payload.recipient).toBe(VAULT_ID);
  });

  it("the ERC-191 twin points verifying_contract at the VAULT, not intents.near", () => {
    // The single most expensive field to get wrong on this leg: `check_envelope` asserts
    // `verifying_contract == current_account_id` (crypto.rs:137), so intents.near here
    // fails the signature check on a withdrawal the user already approved.
    const payload = JSON.parse(erc191CommitMessage);
    expect(payload.verifying_contract).toBe(VAULT_ID);
    expect(payload.portfolio_id).toBe("pf-golden-1");
    expect([...Buffer.from(payload.nonce, "base64")]).toEqual([...request.nonce]);
  });
});

// D-312: the stored nonce is read back to ask `is_valid_salt` and to know when `is_nonce_used`
// stops being evidence. A decode that drifts from the builder would ask about the wrong salt
// or trust a swept nonce — so it is pinned as the builder's exact inverse.
describe("decodeV1Nonce", () => {
  const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

  it("reads back the salt and deadline the builder embedded", () => {
    const nonce = buildVersionedV1Nonce({ deadlineSecs: 2_060_000_000, salt: Uint8Array.of(0x25, 0x28, 0x12, 0xb3) });
    expect(decodeV1Nonce(b64(nonce))).toEqual({ saltHex: "252812b3", deadlineSecs: 2_060_000_000 });
  });

  it.each([
    ["the wrong length", b64(new Uint8Array(31))],
    ["the wrong magic", b64(new Uint8Array(32))],
    ["not base64", "%%%"],
  ])("returns null for %s", (_, input) => {
    expect(decodeV1Nonce(input)).toBeNull();
  });

  it("returns null for a non-V1 discriminant", () => {
    const nonce = buildVersionedV1Nonce({ deadlineSecs: 1 });
    nonce[4] = 0x01;
    expect(decodeV1Nonce(b64(nonce))).toBeNull();
  });
});
