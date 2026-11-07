import { describe, expect, it, vi } from "vitest";
import { Account, KeyPair, KeyPairSigner, actions, baseEncode, type KeyPairString, type Provider } from "near-api-js";
import { createRelaySender, RELAY_MAX_RESIGNS } from "./relay-sender";
import { RelayOutcomeUnknownError } from "./relay-service";
import type { RelayRpc, RelaySendResult } from "./relay-rpc-provider";

const BLOCK_HASH = "11111111111111111111111111111111";
const verifierKey = KeyPair.fromRandom("ed25519").toString() as KeyPairString;
const vaultKey = KeyPair.fromRandom("ed25519").toString() as KeyPairString;
const OUTCOME = { status: { SuccessValue: "" }, transaction_outcome: { id: "tx" }, receipts_outcome: [] };

/**
 * A reads provider whose on-chain nonce advances by one on every read, as if others were sending
 * (or stays put with `fixedNonce`, so a hash can be recomputed).
 */
function fakeRpc(answers: RelaySendResult[], { fixedNonce = false } = {}) {
  let nonce = 40;
  const provider = {
    viewAccessKey: vi.fn(async () => ({ nonce: BigInt(fixedNonce ? nonce : nonce++), permission: "FullAccess" })),
    viewBlock: vi.fn(async () => ({ header: { hash: BLOCK_HASH, height: 1 } })),
  } as unknown as Provider;
  const sendSigned = vi.fn<RelayRpc["sendSigned"]>(async () => answers.shift() ?? { kind: "outcome", outcome: OUTCOME });
  // The sender never reads a contract view: that is the gate's job, before the sender runs.
  const view = vi.fn<RelayRpc["view"]>(async () => {
    throw new Error("the sender must not call view");
  });
  return { rpc: { provider, sendSigned, view } satisfies RelayRpc, sendSigned, provider };
}

const call = {
  target: "verifier" as const,
  receiverId: "intents.near",
  methodName: "execute_intents",
  args: { signed: [] },
  gas: "300000000000000",
};

const senderFor = (rpc: RelayRpc) =>
  createRelaySender({
    accountId: "relayer.near",
    privateKeys: { verifier: [verifierKey], vault: [vaultKey] },
    rpc,
    log: () => {},
  });

/** The public key a signed transaction was signed with, read out of its bytes. */
function signedBy(b64: string, pool: KeyPairString[]): KeyPairString | undefined {
  const bytes = Buffer.from(b64, "base64");
  return pool.find((key) => bytes.includes(Buffer.from(KeyPair.fromString(key).getPublicKey().data)));
}

/** The hash near-api-js's own signer computes for the same transaction (signer.js). */
async function expectedHash(provider: Provider, key: KeyPairString): Promise<string> {
  const pair = KeyPair.fromString(key);
  const tx = await new Account("relayer.near", provider, key).createTransaction({
    receiverId: call.receiverId,
    actions: [actions.functionCall(call.methodName, call.args, BigInt(call.gas), BigInt(0))],
    publicKey: pair.getPublicKey(),
  });
  const { txHash } = await new KeyPairSigner(pair).signTransaction(tx);
  return baseEncode(txHash);
}

describe("createRelaySender", () => {
  it("resolves with the outcome after exactly one send", async () => {
    const { rpc, sendSigned } = fakeRpc([{ kind: "outcome", outcome: OUTCOME }]);
    await expect(senderFor(rpc)(call)).resolves.toBe(OUTCOME);
    expect(sendSigned).toHaveBeenCalledTimes(1);
  });

  it("signs each target with its own key (D-246)", async () => {
    const { rpc, sendSigned } = fakeRpc([]);
    await senderFor(rpc)({ ...call, target: "vault", receiverId: "vault.near", methodName: "commit_portfolio_changes" });
    // The signed bytes carry the public key of the vault key, not the verifier's.
    const bytes = Buffer.from(sendSigned.mock.calls[0][0], "base64");
    const vaultPk = KeyPair.fromString(vaultKey).getPublicKey().data;
    const verifierPk = KeyPair.fromString(verifierKey).getPublicKey().data;
    expect(bytes.includes(Buffer.from(vaultPk))).toBe(true);
    expect(bytes.includes(Buffer.from(verifierPk))).toBe(false);
  });

  it("starts on a random key of the pool and re-signs on the next one (D-367)", async () => {
    const pool = [0, 1, 2, 3].map(() => KeyPair.fromRandom("ed25519").toString() as KeyPairString);
    const { rpc, sendSigned } = fakeRpc([
      { kind: "invalid-nonce", error: "InvalidNonce" },
      { kind: "invalid-nonce", error: "InvalidNonce" },
      { kind: "outcome", outcome: OUTCOME },
    ]);
    const sender = createRelaySender({
      accountId: "relayer.near",
      privateKeys: { verifier: pool, vault: [vaultKey] },
      rpc,
      log: () => {},
      // 0.6 × 4 keys ⇒ starts on index 2, then wraps around the pool.
      random: () => 0.6,
    });
    await expect(sender(call)).resolves.toBe(OUTCOME);
    expect(sendSigned.mock.calls.map(([b64]) => signedBy(b64, pool))).toEqual([pool[2], pool[3], pool[0]]);
  });

  it("throws RelayOutcomeUnknownError with the hash of the tx it sent, and does not re-send (D-329)", async () => {
    const { rpc, sendSigned, provider } = fakeRpc([{ kind: "unknown", error: "no answer within 30000ms" }], {
      fixedNonce: true,
    });

    const error = await senderFor(rpc)(call).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RelayOutcomeUnknownError);
    expect((error as RelayOutcomeUnknownError).txHash).toBe(await expectedHash(provider, verifierKey));
    expect(sendSigned).toHaveBeenCalledTimes(1);
  });

  it("re-signs with a fresh nonce on InvalidNonce, up to the bound, and sends each tx once", async () => {
    const { rpc, sendSigned } = fakeRpc([
      { kind: "invalid-nonce", error: "InvalidNonce" },
      { kind: "invalid-nonce", error: "InvalidNonce" },
      { kind: "outcome", outcome: OUTCOME },
    ]);
    await expect(senderFor(rpc)(call)).resolves.toBe(OUTCOME);
    expect(sendSigned).toHaveBeenCalledTimes(RELAY_MAX_RESIGNS + 1);
    // Three different transactions, not the same bytes re-posted.
    expect(new Set(sendSigned.mock.calls.map(([b64]) => b64)).size).toBe(3);
  });

  it("gives up with a plain error once every attempt was refused for its nonce — nothing ran", async () => {
    const refused: RelaySendResult = { kind: "invalid-nonce", error: "InvalidNonce" };
    const { rpc, sendSigned } = fakeRpc([refused, refused, refused]);
    const error = await senderFor(rpc)(call).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RelayOutcomeUnknownError);
    expect(sendSigned).toHaveBeenCalledTimes(RELAY_MAX_RESIGNS + 1);
  });

  it("a refusal at validation (e.g. the allowance ran out) is a plain error, sent once, not re-signed", async () => {
    const { rpc, sendSigned } = fakeRpc([
      { kind: "rejected", error: 'The node refused the transaction: {"InvalidAccessKeyError":"NotEnoughAllowance"}' },
    ]);
    const error = await senderFor(rpc)(call).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RelayOutcomeUnknownError);
    expect((error as Error).message).toMatch(/NotEnoughAllowance/);
    expect(sendSigned).toHaveBeenCalledTimes(1);
  });

  it("an unknown answer after a re-sign is still unknown — never a failure", async () => {
    const { rpc } = fakeRpc([
      { kind: "invalid-nonce", error: "InvalidNonce" },
      { kind: "unknown", error: "HTTP 503" },
    ]);
    await expect(senderFor(rpc)(call)).rejects.toBeInstanceOf(RelayOutcomeUnknownError);
  });

  it("a failed read throws a plain error before anything is sent", async () => {
    const { rpc, sendSigned } = fakeRpc([]);
    (rpc.provider as unknown as { viewBlock: () => Promise<never> }).viewBlock = async () => {
      throw new Error("every upstream down");
    };
    const error = await senderFor(rpc)(call).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(RelayOutcomeUnknownError);
    expect(sendSigned).not.toHaveBeenCalled();
  });
});
