// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { submitAllocate, EXECUTE_INTENTS_GAS, type NearSigner } from "./allocate-submit";
import { nep413VaultSigner } from "./vault-signer";
import { walletSubmitter } from "./envelope-submitter";
import { listAllocateRecords } from "./allocate-rescue-store";
import { VaultRejectedError } from "./vault-errors";
import { RelayError } from "./relay-client";
import { INTENTS_CONTRACT_ID, VAULT_CONTRACT_ID } from "@/features/wallet/config/network";

// Covers the money path end-to-end with the wallet and network faked. The assertions that
// matter most are the SAFETY ones (007.plan Phase 1):
//   - the raw msg is persisted BEFORE the wallet is asked to sign;
//   - a failed persist aborts without signing;
//   - a submit that throws stays UNRESOLVED (may have landed) rather than "failed" — unless
//     the relayer refused before sending, the one throw that proves nothing moved;
//   - a successful submit is never marked "credited" (on_auth can still orphan).

const SALT_HEX = "252812b3";

function mockSaltResponse(): Response {
  const bytes = Array.from(new TextEncoder().encode(JSON.stringify(SALT_HEX)));
  return new Response(
    JSON.stringify({ result: { result: bytes, logs: [], block_height: 1, block_hash: "h" } }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

const SIGNED = {
  accountId: "alice.near",
  publicKey: "ed25519:8rVvtHWFr8hasdQGGD5WiQBTyr4iH2ruEPPVfj491RPN",
  signature: Buffer.from(new Uint8Array(64)).toString("base64"),
};

function makeSigner(over: Partial<NearSigner> = {}): NearSigner {
  return {
    signNEP413Message: vi.fn().mockResolvedValue(SIGNED),
    signAndSendTransaction: vi
      .fn()
      .mockResolvedValue({ transaction_outcome: { id: "TxHash123" } }),
    ...over,
  };
}

// The NEAR wallet is wrapped in its scheme adapter + self-submitter here rather than being
// passed directly, so these tests keep asserting on the WALLET mock (signNEP413Message /
// signAndSendTransaction) — the behaviour under test is unchanged by the signer
// abstraction, and that is exactly what these assertions should keep proving.
function params(signer: NearSigner) {
  return {
    signerId: "alice.near",
    portfolioName: "Wet Test",
    op: {
      kind: "setup" as const,
      loginWalletChain: "near" as const,
      loginWalletAddress: "alice.near",
      composition: [{ tokenId: "nep141:usdc.near", targetBps: 10_000, toleranceBps: 500 }],
      storage: { tokenId: "nep141:usdc.near", amount: "34250" },
    },
    allocations: [{ tokenId: "nep141:usdc.near", amount: "1000000" }],
    signer: nep413VaultSigner(signer, "alice.near"),
    submit: walletSubmitter(signer),
    now: () => 1_800_000_000_000,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockSaltResponse()));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// The deadlines were one value until ADR-0017 §1: 600s fed both the envelope and the
// AuthCallMsg, so an orphaned Allocate stopped being rescuable ten minutes after signing.
// Then the nonce still expired with the envelope (ADR-0017 §5 as amended, solver `922`
// H13), so the PROOF that a rescued Allocate had executed could vanish ten minutes in.
// All three are pinned separately here because re-coupling any pair is silent — nothing
// fails until a real orphan needs rescuing, three days too late.
describe("submitAllocate — the three deadlines are not the same deadline", () => {
  const NOW_SECS = 1_800_000_000; // params().now is NOW_SECS * 1000
  const ENVELOPE_DEADLINE = NOW_SECS + 600;
  const AUTH_CALL_DEADLINE = NOW_SECS + 72 * 60 * 60;
  const NONCE_DEADLINE = AUTH_CALL_DEADLINE + 7 * 24 * 60 * 60;

  it("gives the AuthCallMsg 72h, which is what bounds the rescue window", async () => {
    const res = await submitAllocate(params(makeSigner()));

    expect(JSON.parse(res.authCallMsg).deadline).toBe(AUTH_CALL_DEADLINE);
  });

  it("keeps the Verifier envelope at 600s — it is a submission window, not a rescue window", async () => {
    const signer = makeSigner();
    await submitAllocate(params(signer));

    const inner = JSON.parse(vi.mocked(signer.signNEP413Message).mock.calls[0][0].message);
    expect(inner.deadline).toBe(new Date(ENVELOPE_DEADLINE * 1000).toISOString());
  });

  // The nonce carries its deadline in bytes [9,17) as i64 nanoseconds. It is the Verifier's
  // permission to sweep the used nonce, and `is_nonce_used` is what the orphan resolver
  // reads as "this Allocate executed" — so it must outlive the 72h rescue window by the
  // solver's 7-day witness window, and it must NOT be the envelope's 600s (the old bug)
  // nor the bare AuthCall deadline (a sweep at hour 72 would race the last rescue).
  it("encodes AuthCall deadline + 7d in the salted nonce — neither the envelope's nor the bare AuthCall one", async () => {
    const signer = makeSigner();
    await submitAllocate(params(signer));

    const { nonce } = vi.mocked(signer.signNEP413Message).mock.calls[0][0];
    const encoded = new DataView(nonce.buffer, nonce.byteOffset).getBigInt64(9, true);
    // BigInt(...) rather than an `n` literal: the tsconfig target predates ES2020.
    const nanos = BigInt(1_000_000_000);
    expect(encoded).toBe(BigInt(NONCE_DEADLINE) * nanos);
    expect(encoded).not.toBe(BigInt(ENVELOPE_DEADLINE) * nanos);
    expect(encoded).not.toBe(BigInt(AUTH_CALL_DEADLINE) * nanos);
  });

  // End to end: the msg the SOLVER will replay out of the rescue record is the one whose
  // deadline has to still be in the future when a human gets around to the rescue.
  it("persists a record whose msg stays rescuable for 72h", async () => {
    await submitAllocate(params(makeSigner()));

    const [saved] = listAllocateRecords();
    expect(JSON.parse(saved.msg).deadline).toBe(AUTH_CALL_DEADLINE);
  });
});

describe("submitAllocate — happy path", () => {
  it("submits execute_intents to intents.near with signed[] and 300 Tgas", async () => {
    const signer = makeSigner();
    const res = await submitAllocate(params(signer));

    expect(res.txHash).toBe("TxHash123");
    const call = vi.mocked(signer.signAndSendTransaction).mock.calls[0][0];
    expect(call.receiverId).toBe(INTENTS_CONTRACT_ID);
    const action = call.actions[0] as {
      params: { methodName: string; args: { signed: unknown[] }; gas: string; deposit: string };
    };
    expect(action.params.methodName).toBe("execute_intents");
    expect(action.params.gas).toBe(EXECUTE_INTENTS_GAS);
    expect(action.params.deposit).toBe("0");
    expect(action.params.args.signed).toHaveLength(1);
  });

  it("signs a NEP-413 envelope addressed to the Verifier carrying the live salt", async () => {
    const signer = makeSigner();
    await submitAllocate(params(signer));

    const req = vi.mocked(signer.signNEP413Message).mock.calls[0][0];
    expect(req.recipient).toBe(INTENTS_CONTRACT_ID);
    // Salt occupies bytes [5,9) of the versioned V1 nonce.
    expect([...req.nonce.slice(5, 9)]).toEqual([0x25, 0x28, 0x12, 0xb3]);

    const inner = JSON.parse(req.message);
    expect(inner.signer_id).toBe("alice.near");
    expect(inner.intents[0]).toMatchObject({ intent: "transfer", receiver_id: VAULT_CONTRACT_ID });
    expect(inner.intents[1]).toMatchObject({ intent: "auth_call", contract_id: VAULT_CONTRACT_ID });
    // D-528: the Setup's Storage Cost, last, to the ops account, with the fixed memo.
    expect(inner.intents[2]).toEqual({
      intent: "transfer",
      receiver_id: "intentfolio-budget.near",
      tokens: { "nep141:usdc.near": "34250" },
      memo: "storage",
    });
  });

  it("persists the AuthCall msg byte-identically to the one it signed", async () => {
    const signer = makeSigner();
    const res = await submitAllocate(params(signer));

    const signedInner = JSON.parse(
      vi.mocked(signer.signNEP413Message).mock.calls[0][0].message
    ) as { intents: Array<{ msg?: string }> };
    const [saved] = listAllocateRecords();
    expect(saved.msg).toBe(res.authCallMsg);
    expect(saved.msg).toBe(signedInner.intents[1].msg); // the sha256 pre-image
  });

  it("does NOT mark the record credited — on_auth can still orphan", async () => {
    await submitAllocate(params(makeSigner()));
    const [saved] = listAllocateRecords();
    expect(saved.status).toBe("submitted");
    expect(saved.txHash).toBe("TxHash123");
  });

  it("puts every funded token in the one Transfer and in the AuthCall msg", async () => {
    const signer = makeSigner();
    const eth = "nep141:eth-0x0.omft.near";
    const res = await submitAllocate({
      ...params(signer),
      allocations: [
        { tokenId: "nep141:usdc.near", amount: "3500000" },
        { tokenId: eth, amount: "130000000000000" },
      ],
    });

    const inner = JSON.parse(vi.mocked(signer.signNEP413Message).mock.calls[0][0].message);
    expect(inner.intents).toHaveLength(3);
    expect(inner.intents[0].tokens).toEqual({
      "nep141:usdc.near": "3500000",
      [eth]: "130000000000000",
    });
    // The AuthCall's own allocations list must agree with the Transfer, or the vault
    // credits a portfolio for funds the Verifier never moved.
    expect(JSON.parse(res.authCallMsg).op.setup.allocations).toEqual([
      ["nep141:usdc.near", "3500000"],
      [eth, "130000000000000"],
    ]);
    // And the rescue record has to describe BOTH, or a manual recovery is decided blind.
    const [saved] = listAllocateRecords();
    expect(saved.legs).toEqual([
      { tokenId: "nep141:usdc.near", amount: "3500000" },
      { tokenId: eth, amount: "130000000000000" },
    ]);
  });

  // D-321: the same envelope, gates and record, with the other AllocateOp in the msg.
  it("signs an allocate_into when the op says so, and records it under the funded portfolio", async () => {
    const signer = makeSigner();
    const res = await submitAllocate({
      ...params(signer),
      portfolioName: "canary-931",
      op: {
        kind: "allocate_into",
        portfolioId: "p_000000000017",
        tokenAdditions: [{ tokenId: "nep141:usdc.near", targetBps: 0, toleranceBps: 1000 }],
      },
    });

    const msg = JSON.parse(res.authCallMsg);
    expect(msg.op).toEqual({
      allocate_into: {
        portfolio_id: "p_000000000017",
        target_changes: [],
        token_additions: [["nep141:usdc.near", 0, 1000]],
        token_removals: [],
        allocations: [["nep141:usdc.near", "1000000"]],
      },
    });
    // The msg the wallet signed is the one the record keeps, byte for byte (D-160).
    const inner = JSON.parse(vi.mocked(signer.signNEP413Message).mock.calls[0][0].message);
    expect(inner.intents[1].msg).toBe(res.authCallMsg);
    expect(inner.intents).toHaveLength(2); // an AllocateInto never carries a Storage Cost (D-528)
    const [saved] = listAllocateRecords();
    expect(saved.msg).toBe(res.authCallMsg);
    expect(saved.portfolioName).toBe("canary-931");
  });
});

describe("submitAllocate — safety ordering", () => {
  it("persists the rescue record BEFORE asking the wallet to sign", async () => {
    const order: string[] = [];
    // Calls THROUGH to the real setItem: the second gate reads the record back to attach the
    // envelope to it, so a spy that only records would make this test pass for the wrong
    // reason — and then fail for one that has nothing to do with ordering.
    const realSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      k: string,
      v: string
    ) {
      if (k === "vault.allocate-rescue.v1") order.push("persist");
      realSetItem.call(this, k, v);
    });
    const signer = makeSigner({
      signNEP413Message: vi.fn().mockImplementation(async () => {
        order.push("sign");
        return SIGNED;
      }),
    });

    await submitAllocate(params(signer));
    expect(order[0]).toBe("persist");
    expect(order).toContain("sign");
    expect(order.indexOf("persist")).toBeLessThan(order.indexOf("sign"));
  });

  // The second gate (ADR-0017 §5 as amended, D-289). Its position is the whole safety
  // argument: after the signature, so there IS an envelope to store, and before the submit,
  // so a failure can still abort while nothing has moved.
  it("persists the SIGNED ENVELOPE after signing and before submitting", async () => {
    const order: string[] = [];
    const signer = makeSigner({
      signNEP413Message: vi.fn().mockImplementation(async () => {
        order.push("sign");
        return SIGNED;
      }),
      signAndSendTransaction: vi.fn().mockImplementation(async () => {
        order.push("submit");
        return { transaction_outcome: { id: "TxHash123" } };
      }),
    });
    const realSetItem = Storage.prototype.setItem;
    // The FIRST write that introduces the field, not every write that mentions it: once the
    // envelope is in the store, the post-submit lifecycle write serialises it again.
    let envelopeSeen = false;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      k: string,
      v: string
    ) {
      if (k === "vault.allocate-rescue.v1" && !envelopeSeen && v.includes("signedEnvelope")) {
        envelopeSeen = true;
        order.push("envelope");
      }
      realSetItem.call(this, k, v);
    });

    await submitAllocate(params(signer));
    expect(order).toEqual(["sign", "envelope", "submit"]);
  });

  it("aborts WITHOUT submitting when the signed envelope cannot be persisted", async () => {
    const signer = makeSigner();
    const realSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      k: string,
      v: string
    ) {
      // Lets the pre-signature record through and fails only the envelope write, which is the
      // only way to reach the second gate at all.
      if (k === "vault.allocate-rescue.v1" && v.includes("signedEnvelope")) {
        throw new Error("QuotaExceededError");
      }
      realSetItem.call(this, k, v);
    });

    await expect(submitAllocate(params(signer))).rejects.toThrow(/nothing was submitted/i);
    expect(signer.signNEP413Message).toHaveBeenCalled();
    expect(signer.signAndSendTransaction).not.toHaveBeenCalled();

    // Nothing was sent, so the record must not sit on the rescue worklist looking unresolved.
    expect(listAllocateRecords()[0]).toMatchObject({ status: "failed" });
  });

  it("aborts WITHOUT signing when the rescue record cannot be persisted", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    const signer = makeSigner();

    await expect(submitAllocate(params(signer))).rejects.toThrow();
    expect(signer.signNEP413Message).not.toHaveBeenCalled();
    expect(signer.signAndSendTransaction).not.toHaveBeenCalled();
  });
});

describe("submitAllocate — failure surfaces", () => {
  it("marks a rejected signature as failed (nothing was submitted)", async () => {
    const signer = makeSigner({
      signNEP413Message: vi.fn().mockRejectedValue(new Error("User rejected")),
    });

    await expect(submitAllocate(params(signer))).rejects.toThrow("User rejected");
    expect(signer.signAndSendTransaction).not.toHaveBeenCalled();
    const [saved] = listAllocateRecords();
    expect(saved.status).toBe("failed");
  });

  // D-311. It used to re-throw, and the modal read the throw as "Couldn't complete the
  // signature" with Retry ENABLED — over funds that may already be in the vault. It now
  // returns, marked uncertain, so the caller polls for the credit like any other submit.
  it("keeps a THROWN submit unresolved and does NOT throw — the tx may have landed", async () => {
    const signer = makeSigner({
      signAndSendTransaction: vi.fn().mockRejectedValue(new Error("network timeout")),
    });

    const result = await submitAllocate(params(signer));
    expect(result.submitUncertain).toContain("network timeout");
    expect(result.txHash).toBeNull();
    const [saved] = listAllocateRecords();
    // "submitted", not "failed": it stays on the rescue worklist.
    expect(saved.status).toBe("submitted");
    expect(saved.error).toContain("network timeout");
    expect(result.recordId).toBe(saved.id);
  });

  // D-311 / D-312: the relayer's own refusals are returned before it sends anything, so they
  // are the one throw that proves nothing moved. `failed` keeps them off the worklist and out
  // of the My Account notice, and the throw lets the modal offer a retry — which is safe.
  // `send-failed` joined them with D-329: the relayer only answers it while nothing has left.
  // 017-2 (D-365) added the pause, the envelope gate and the firewall's two platform answers.
  it.each([
    "bad-request",
    "destination-mismatch",
    "cap-exceeded",
    "not-configured",
    "send-failed",
    "paused",
    "would-fail",
    "check-failed",
    "rate-limited",
    "blocked",
  ])(
    "marks a relayer refusal before sending (%s) as failed, and re-throws it",
    async (code) => {
      const refusal = new RelayError(`refused: ${code}`, code, 400);
      const result = submitAllocate({ ...params(makeSigner()), submit: vi.fn().mockRejectedValue(refusal) });

      await expect(result).rejects.toBe(refusal);
      const [saved] = listAllocateRecords();
      expect(saved.status).toBe("failed");
      expect(saved.error).toContain(code);
    }
  );

  it("treats unknown-outcome as ambiguous and keeps the hash the relayer sent (D-329)", async () => {
    const unknown = new RelayError("no answer within 30000ms", "unknown-outcome", 504, "SentTxHash");
    const result = await submitAllocate({
      ...params(makeSigner()),
      submit: vi.fn().mockRejectedValue(unknown),
    });

    expect(result.submitUncertain).toContain("no answer within 30000ms");
    expect(result.txHash).toBe("SentTxHash");
    const [saved] = listAllocateRecords();
    expect(saved.status).toBe("submitted");
    expect(saved.txHash).toBe("SentTxHash");
  });

  it("treats an unknown relayer code as ambiguous — refusals are an allow-list", async () => {
    const unknown = new RelayError("something new", "brand-new-code", 500);
    const result = await submitAllocate({ ...params(makeSigner()), submit: vi.fn().mockRejectedValue(unknown) });

    expect(result.submitUncertain).toBeDefined();
    expect(listAllocateRecords()[0].status).toBe("submitted");
  });

  // D-R12: the contrast with the test above is the whole point. A THROWN submit is
  // ambiguous (may have landed) and must stay on the rescue worklist; an explicit REVERT is
  // not ambiguous at all — execute_intents rolled back, nothing moved, nothing to rescue.
  it("fails fast on a REVERTED tx and takes the record off the rescue worklist", async () => {
    const signer = makeSigner({
      signAndSendTransaction: vi.fn().mockResolvedValue({
        transaction_outcome: { id: "TxHash123" },
        status: {
          Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "E_BAD_SALT" } } } },
        },
      }),
    });

    const error = await submitAllocate(params(signer)).catch((e: unknown) => e);
    // Typed, not just worded: the message carries "rejected", and the wallet-error
    // normaliser reads that word as the user cancelling. The class is what stops it (FE #5).
    expect(error).toBeInstanceOf(VaultRejectedError);
    expect((error as Error).message).toMatch(/Verifier rejected the allocation: E_BAD_SALT/);
    const [saved] = listAllocateRecords();
    expect(saved.status).toBe("failed");
    expect(saved.error).toContain("E_BAD_SALT");
  });

  // REGRESSION (FE #5, `922` §8 #15). Until this test was inverted it pinned the opposite:
  // "a failure in a sub-receipt is a revert". It is not. The Transfer settles inside the
  // `execute_intents` receipt — the one whose status is the tx's top-level status — and
  // `on_auth` fails in its own receipt, executed by the vault. Top-level success + a failed
  // vault receipt is the ORPHAN: funds in the vault, credited to nobody. Written `failed`,
  // the record left the rescue worklist and no orphan ever reached the solver — seen twice
  // in the wet test (`ab26d5eb…`, `8e71c1a9…`).
  it("REGRESSION: a failed on_auth receipt under a successful tx is a SUSPECTED ORPHAN, not failed", async () => {
    const trap = "WebAssembly trap: An `unreachable` opcode was executed.";
    const signer = makeSigner({
      signAndSendTransaction: vi.fn().mockResolvedValue({
        transaction_outcome: { id: "TxHash123" },
        status: { SuccessValue: "" },
        receipts_outcome: [
          { outcome: { executor_id: INTENTS_CONTRACT_ID, status: { SuccessValue: "" } } },
          {
            outcome: {
              executor_id: VAULT_CONTRACT_ID,
              status: {
                Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: trap } } } },
              },
            },
          },
        ],
      }),
    });

    // Does NOT throw: the caller reports it as unconfirmed, with the non-alarming copy.
    const result = await submitAllocate(params(signer));
    expect(result.vaultFailure).toBe(trap);
    expect(result.txHash).toBe("TxHash123");

    const [saved] = listAllocateRecords();
    expect(saved.status).toBe("suspected_orphan"); // ON the worklist, with no PATCH by hand
    expect(saved.txHash).toBe("TxHash123");
    expect(saved.error).toBe(trap);
    expect(saved.msg).toBeTruthy(); // the bytes the rescue replays
  });

  // D-328: a failed receipt that is NOT the vault's, under a settled Transfer, is read as an
  // orphan — but the vault may have credited. Its seal is its own word on this exact msg.
  describe("D-328: the seal before the orphan", () => {
    it("an unsealed answer is read once more (final finality can trail the outcome)", async () => {
      const readSeal = vi
        .fn()
        .mockResolvedValueOnce({ kind: "unsealed" })
        .mockResolvedValueOnce({ kind: "sealed", deadlineSecs: 1 });
      const result = await submitAllocate({ ...params(foreignFailure()), readSeal, sealRecheckMs: 0 });
      expect(readSeal).toHaveBeenCalledTimes(2);
      expect(result.vaultFailure).toBeUndefined();
      expect(listAllocateRecords()[0].status).toBe("submitted");
    });

    it("the vault's OWN receipt failing is never re-checked: on_auth reverted the seal with it", async () => {
      const readSeal = vi.fn().mockResolvedValue({ kind: "sealed", deadlineSecs: 1 });
      const signer = makeSigner({
        signAndSendTransaction: vi.fn().mockResolvedValue({
          transaction_outcome: { id: "TxHash123" },
          status: { SuccessValue: "" },
          receipts_outcome: [
            {
              outcome: {
                executor_id: VAULT_CONTRACT_ID,
                status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "trap" } } } } },
              },
            },
          ],
        }),
      });
      const result = await submitAllocate({ ...params(signer), readSeal });
      expect(readSeal).not.toHaveBeenCalled();
      expect(result.vaultFailure).toBe("trap");
    });

    const foreignFailure = () =>
      makeSigner({
        signAndSendTransaction: vi.fn().mockResolvedValue({
          transaction_outcome: { id: "TxHash123" },
          status: { SuccessValue: "" },
          receipts_outcome: [
            { outcome: { executor_id: VAULT_CONTRACT_ID, status: { SuccessValue: "" } } },
            {
              outcome: {
                executor_id: "some-refund.near",
                status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "refund failed" } } } } },
              },
            },
          ],
        }),
      });

    it("a SEALED msg is not an orphan: submitted, and the credit poll confirms it", async () => {
      const readSeal = vi.fn().mockResolvedValue({ kind: "sealed", deadlineSecs: 1 });
      const result = await submitAllocate({ ...params(foreignFailure()), readSeal });
      expect(result.vaultFailure).toBeUndefined();
      expect(readSeal).toHaveBeenCalledWith("alice.near", result.authCallMsg);
      const [saved] = listAllocateRecords();
      expect(saved.status).toBe("submitted");
      expect(saved.error).toBe("refund failed");
    });

    it.each([
      ["unsealed", () => Promise.resolve({ kind: "unsealed" as const })],
      ["unreadable", () => Promise.resolve({ kind: "unreadable" as const, reason: "rpc down" })],
      ["a read that throws", () => Promise.reject(new Error("rpc down"))],
    ])("%s keeps the conservative verdict: suspected orphan", async (_label, seal) => {
      const result = await submitAllocate({ ...params(foreignFailure()), readSeal: vi.fn(seal), sealRecheckMs: 0 });
      expect(result.vaultFailure).toBe("refund failed");
      expect(listAllocateRecords()[0].status).toBe("suspected_orphan");
    });
  });

  it("keeps an UNDECIDABLE outcome on the worklist as submitted — never failed on a guess", async () => {
    // No top-level status, a failed receipt with no executor: the outcome says neither
    // whether the Transfer settled nor who failed. The poll decides, as for a thrown submit.
    const signer = makeSigner({
      signAndSendTransaction: vi.fn().mockResolvedValue({
        transaction_outcome: { id: "TxHash123" },
        receipts_outcome: [
          {
            outcome: {
              status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "boom" } } } } },
            },
          },
        ],
      }),
    });

    const result = await submitAllocate(params(signer));
    expect(result.vaultFailure).toBeUndefined();
    const [saved] = listAllocateRecords();
    expect(saved.status).toBe("submitted");
    expect(saved.txHash).toBe("TxHash123");
    expect(saved.error).toBe("boom");
  });

  it("still reads a failed sub-receipt as an orphan when the wallet omits executor_id", async () => {
    // Top-level success is proof enough that the Transfer settled.
    const signer = makeSigner({
      signAndSendTransaction: vi.fn().mockResolvedValue({
        transaction_outcome: { id: "TxHash123" },
        status: { SuccessValue: "" },
        receipts_outcome: [
          {
            outcome: {
              status: {
                Failure: {
                  ActionError: { kind: { FunctionCallError: { ExecutionError: "E_ON_AUTH" } } },
                },
              },
            },
          },
        ],
      }),
    });

    const result = await submitAllocate(params(signer));
    expect(result.vaultFailure).toBe("E_ON_AUTH");
    expect(listAllocateRecords()[0].status).toBe("suspected_orphan");
  });

  it("does not sign or submit if the live salt cannot be read", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("RPC down")));
    const signer = makeSigner();

    await expect(submitAllocate(params(signer))).rejects.toThrow("RPC down");
    expect(signer.signNEP413Message).not.toHaveBeenCalled();
    expect(listAllocateRecords()).toEqual([]);
  });
});

// ── Off-client persistence (ADR-0017, P-OPS v1 point 3) ────────────────────────────────
//
// The block above proves the ordering for the localStorage channel. Since ADR-0017 there is a
// SECOND fail-closed channel — the ops database — and it is the one that closes the real gap:
// localStorage does not survive a cleared browser or a new device, and the solver never sees
// it. These re-import the module with the flag on, because `OPS_RECORDS_ENABLED` is read at
// load time (Next inlines NEXT_PUBLIC_ values at build time).
describe("submitAllocate — the rescue record also goes off-client", () => {
  /** The salt read, then whatever the ops route answers. */
  function fetchWith(opsResponse: () => Response) {
    return vi.fn(async (url: string) =>
      String(url).includes("/api/ops/") ? opsResponse() : mockSaltResponse()
    );
  }

  const opsOk = () =>
    new Response(JSON.stringify({ ok: true, id: "x", created: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  async function loadWithFlag(enabled: boolean) {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_OPS_RECORDS", enabled ? "true" : "false");
    return import("./allocate-submit");
  }

  afterEach(() => vi.unstubAllEnvs());

  it("POSTs the record BEFORE the wallet is asked to sign", async () => {
    const order: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/api/ops/")) {
          order.push("database");
          return opsOk();
        }
        return mockSaltResponse();
      })
    );
    const signer = makeSigner({
      signNEP413Message: vi.fn().mockImplementation(async () => {
        order.push("sign");
        return SIGNED;
      }),
    });

    const { submitAllocate: submit } = await loadWithFlag(true);
    await submit(params(signer));

    // A third entry follows — the post-signature status PATCH. What this pins is the INSERT
    // landing first: the signature must never exist before the pre-image is durable.
    expect(order.slice(0, 2)).toEqual(["database", "sign"]);
  });

  // The failure this whole decision exists to prevent: an Allocate submitted with no durable
  // copy of the sha256 pre-image is a potentially unrecoverable orphan. So a database that is
  // down does not degrade the flow — it stops it, before any signature exists.
  it("aborts WITHOUT signing when the record cannot be stored off-client", async () => {
    vi.stubGlobal(
      "fetch",
      fetchWith(() =>
        new Response(JSON.stringify({ ok: false, code: "write-failed", error: "connection refused" }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        })
      )
    );
    const signer = makeSigner();
    const { submitAllocate: submit } = await loadWithFlag(true);

    await expect(submit(params(signer))).rejects.toThrow(/nothing was signed/i);
    expect(signer.signNEP413Message).not.toHaveBeenCalled();
    expect(signer.signAndSendTransaction).not.toHaveBeenCalled();
  });

  it("carries the submitted status and the tx hash to the database too", async () => {
    const patched: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (!String(url).includes("/api/ops/")) return mockSaltResponse();
        if (init.method === "PATCH") patched.push(JSON.parse(init.body as string));
        return opsOk();
      })
    );
    const { submitAllocate: submit } = await loadWithFlag(true);
    const result = await submit(params(makeSigner()));

    // TWO patches since D-289, in this order: the envelope before the submit, the lifecycle
    // after it. Pinned as a whole list rather than by `toContainEqual` so that dropping the
    // envelope write, or moving it after the submit, fails here.
    expect(patched).toHaveLength(2);
    expect(patched[0]).toMatchObject({ id: result.recordId });
    expect(Object.keys(patched[0] as object).sort()).toEqual(["id", "signedEnvelope"]);
    // Deliberately "submitted" and never "credited": execute_intents can report success while
    // the vault's on_auth receipt fails, and that is precisely the orphan.
    expect(patched[1]).toEqual({ id: result.recordId, status: "submitted", txHash: "TxHash123" });
  });

  // The row in the database IS the worklist (`listSuspectedOrphans` selects on this exact
  // status). The local assertion above proves the verdict; this one proves it travelled.
  it("PATCHes the database to suspected_orphan with the tx hash when on_auth failed (FE #5)", async () => {
    const patched: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (!String(url).includes("/api/ops/")) return mockSaltResponse();
        if (init.method === "PATCH") patched.push(JSON.parse(init.body as string));
        return opsOk();
      })
    );
    const { submitAllocate: submit } = await loadWithFlag(true);
    const result = await submit(
      params(
        makeSigner({
          signAndSendTransaction: vi.fn().mockResolvedValue({
            transaction_outcome: { id: "TxHash123" },
            status: { SuccessValue: "" },
            receipts_outcome: [
              {
                outcome: {
                  executor_id: VAULT_CONTRACT_ID,
                  status: {
                    Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "trap" } } } },
                  },
                },
              },
            ],
          }),
        })
      )
    );

    expect(patched).toHaveLength(2);
    expect(patched[1]).toEqual({
      id: result.recordId,
      status: "suspected_orphan",
      txHash: "TxHash123",
      error: "trap",
    });
  });

  // What the solver's rescue tool actually reads (`rescue/envelope.ts`): the canonical
  // MultiPayload, verbatim. It re-derives the signed digest from these four fields, so a
  // reshaped or partially-copied envelope would verify as nothing.
  it("stores the canonical MultiPayload verbatim — the four fields the rescue verifies", async () => {
    let stored: Record<string, unknown> | undefined;
    let submittedPayload: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (!String(url).includes("/api/ops/")) return mockSaltResponse();
        const body = JSON.parse(init.body as string);
        if (init.method === "PATCH" && body.signedEnvelope) stored = body.signedEnvelope;
        return opsOk();
      })
    );
    const signer = makeSigner({
      signAndSendTransaction: vi.fn().mockImplementation(async (call: {
        actions: Array<{ params: { args: { signed: unknown[] } } }>;
      }) => {
        submittedPayload = call.actions[0].params.args.signed[0];
        return { transaction_outcome: { id: "TxHash123" } };
      }),
    });

    const { submitAllocate: submit } = await loadWithFlag(true);
    await submit(params(signer));

    expect(stored).toMatchObject({
      standard: "nep413",
      public_key: SIGNED.publicKey,
      payload: { recipient: INTENTS_CONTRACT_ID },
    });
    expect(typeof (stored as { signature?: unknown }).signature).toBe("string");
    // The nonce is what `is_nonce_used` is looked up by; without it the rescue cannot show the
    // envelope ever executed, and a stored envelope that cannot do that is not worth storing.
    expect(typeof ((stored as { payload: { nonce?: unknown } }).payload.nonce)).toBe("string");
    // And it is the SAME object that went to the Verifier, not a rebuild of it.
    expect(stored).toEqual(submittedPayload);
  });

  it("tells the database a rejected signature stranded nothing", async () => {
    const patched: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (!String(url).includes("/api/ops/")) return mockSaltResponse();
        if (init.method === "PATCH") patched.push(JSON.parse(init.body as string));
        return opsOk();
      })
    );
    const signer = makeSigner({
      signNEP413Message: vi.fn().mockRejectedValue(new Error("User rejected")),
    });
    const { submitAllocate: submit } = await loadWithFlag(true);

    await expect(submit(params(signer))).rejects.toThrow("User rejected");
    expect(patched[0]).toMatchObject({ status: "failed" });
  });

  // ⚠️ THIS TEST USED TO SAY THE OPPOSITE, and the sentence it used to carry — "fail-closed
  // applies to the INSERT only" — is the pre-amendment reading of ADR-0017 §5 that D-289
  // corrects. Fail-closed now applies to the envelope too. What stays best-effort is
  // everything AFTER the submit, and the reason is not importance: it is that by then the
  // funds may have moved, so refusing to continue protects nothing and only replaces a real
  // message to the user with a storage one.
  it("does not fail the Allocate when a POST-SUBMIT lifecycle PATCH cannot be delivered", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (!String(url).includes("/api/ops/")) return mockSaltResponse();
        // Only the lifecycle patch fails; the envelope write is a different rule and is
        // asserted below.
        if (init.method === "PATCH" && !JSON.parse(init.body as string).signedEnvelope) {
          throw new Error("network down");
        }
        return opsOk();
      })
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { submitAllocate: submit } = await loadWithFlag(true);

    await expect(submit(params(makeSigner()))).resolves.toMatchObject({ txHash: "TxHash123" });
  });

  // The other half of the same rule, and the one D-289 is about: an envelope the database
  // never received means the solver's rescue tool would refuse to sign a credit for these
  // funds (`rescue-verifier.ts` reports `signature: 'absent'`). So the Allocate stops here,
  // where stopping is still free.
  it("aborts WITHOUT submitting when the envelope PATCH cannot be delivered", async () => {
    const signer = makeSigner();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (!String(url).includes("/api/ops/")) return mockSaltResponse();
        if (init.method === "PATCH" && JSON.parse(init.body as string).signedEnvelope) {
          return new Response(
            JSON.stringify({ ok: false, code: "write-failed", error: "connection refused" }),
            { status: 502, headers: { "Content-Type": "application/json" } }
          );
        }
        return opsOk();
      })
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { submitAllocate: submit } = await loadWithFlag(true);

    await expect(submit(params(signer))).rejects.toThrow(/nothing was submitted/i);
    expect(signer.signNEP413Message).toHaveBeenCalled();
    expect(signer.signAndSendTransaction).not.toHaveBeenCalled();
  });

  // The flag defaults OFF, and it is the database channel it gates — not the envelope. If it
  // gated both, every deployment running with the flag unset would produce records that are
  // un-rescuable with the Solver key, which is the exact failure D-289 is about.
  it("still stores the envelope locally while the flag is off", async () => {
    const fetchImpl = fetchWith(opsOk);
    vi.stubGlobal("fetch", fetchImpl);
    const { submitAllocate: submit } = await loadWithFlag(false);
    await submit(params(makeSigner()));

    expect(fetchImpl.mock.calls.every(([url]) => !String(url).includes("/api/ops/"))).toBe(true);
    expect(listAllocateRecords()[0]).toMatchObject({
      status: "submitted",
      signedEnvelope: { standard: "nep413" },
    });
  });

  it("touches no ops route at all while the flag is off", async () => {
    const fetchImpl = fetchWith(opsOk);
    vi.stubGlobal("fetch", fetchImpl);
    const { submitAllocate: submit } = await loadWithFlag(false);
    await submit(params(makeSigner()));

    expect(fetchImpl.mock.calls.every(([url]) => !String(url).includes("/api/ops/"))).toBe(true);
  });
});

// D-312: the record keeps what later proves an envelope never ran — its nonce, byte for byte
// the one that was signed, and its own deadline (not the AuthCall's, not the nonce's).
describe("submitAllocate — the record keeps the nonce witness", () => {
  it("stores the signed nonce (base64) and the envelope deadline", async () => {
    const signer = makeSigner();
    await submitAllocate(params(signer));

    const [saved] = listAllocateRecords();
    const signedNonce = vi.mocked(signer.signNEP413Message).mock.calls[0][0].nonce;
    expect(saved.verifierNonce).toBe(Buffer.from(signedNonce).toString("base64"));
    expect(saved.envelopeDeadlineSecs).toBe(1_800_000_000 + 600);
  });
});
