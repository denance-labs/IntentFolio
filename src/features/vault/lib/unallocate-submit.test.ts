// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { submitUnallocate, COMMIT_CHANGES_GAS } from "./unallocate-submit";
import type { NearSigner } from "./allocate-submit";
import { nep413VaultSigner } from "./vault-signer";
import { walletSubmitter } from "./envelope-submitter";
import { INTENTS_CONTRACT_ID, VAULT_CONTRACT_ID } from "@/features/wallet/config/network";
import { VaultCommitRevertedError } from "./vault-errors";
import { RelayError } from "./relay-client";
import { VAULT_DEBUG_ENVELOPES_KEY } from "./vault-debug-log";
import { normalizeWalletError } from "@/features/wallet/adapter/normalize-error";

// The commit is the return leg of the round-trip. The assertions that matter are the ones
// a wrong value would make expensive on mainnet (007.plan Phase 2):
//   - it goes to the VAULT, not to intents.near, and signs against the vault too
//     (verifying_contract == current_account_id, crypto.rs:137);
//   - a DEFERRED commit is reported as deferred even though the tx succeeded;
//   - a zero-quantity leg is refused before the wallet is ever opened.

const SIGNED = {
  accountId: "denance02.near",
  publicKey: "ed25519:8rVvtHWFr8hasdQGGD5WiQBTyr4iH2ruEPPVfj491RPN",
  signature: Buffer.from(new Uint8Array(64)).toString("base64"),
};

const PID = "p_000000000000";
const USDT = "nep141:usdt.tether-token.near";

function eventLog(event: string, data: Record<string, unknown>): string {
  return `EVENT_JSON:${JSON.stringify({
    standard: "intentfolio-vault",
    version: "1.0.0",
    event,
    data: [data],
  })}`;
}

function makeSigner(logs: string[] = [eventLog("pending_unallocation_opened", { commit_id: "c1" })]) {
  return {
    signNEP413Message: vi.fn().mockResolvedValue(SIGNED),
    signAndSendTransaction: vi.fn().mockResolvedValue({
      transaction_outcome: { id: "CommitTxHash", outcome: { logs: [] } },
      receipts_outcome: [{ outcome: { logs, status: { SuccessValue: "" } } }],
    }),
  } satisfies NearSigner;
}

// Wallet wrapped in its scheme adapter + self-submitter, so the assertions below keep
// observing the WALLET mock directly (see the same note in allocate-submit.test.ts).
function params(signer: NearSigner) {
  return {
    signerId: "denance02.near",
    portfolioId: PID,
    legs: [{ tokenId: USDT, amount: "1000000" }],
    signer: nep413VaultSigner(signer, "denance02.near"),
    submit: walletSubmitter(signer),
    now: () => 1_800_000_000_000,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("submitUnallocate — wire shape", () => {
  it("calls commit_portfolio_changes on the VAULT with payload + 300 Tgas, no deposit", async () => {
    const signer = makeSigner();
    const res = await submitUnallocate(params(signer));

    expect(res.txHash).toBe("CommitTxHash");
    const call = vi.mocked(signer.signAndSendTransaction).mock.calls[0][0];
    expect(call.receiverId).toBe(VAULT_CONTRACT_ID);
    expect(call.receiverId).not.toBe(INTENTS_CONTRACT_ID); // no Verifier in the commit loop
    const action = call.actions[0] as {
      params: { methodName: string; args: { payload: unknown }; gas: string; deposit: string };
    };
    expect(action.params.methodName).toBe("commit_portfolio_changes");
    expect(action.params.gas).toBe(COMMIT_CHANGES_GAS);
    expect(action.params.deposit).toBe("0");
    expect(action.params.args.payload).toBeTruthy();
  });

  it("signs against the DEPLOYED vault account, never a hardcoded name", async () => {
    const signer = makeSigner();
    await submitUnallocate(params(signer));

    const signArgs = vi.mocked(signer.signNEP413Message).mock.calls[0][0];
    // recipient => DefusePayload.verifying_contract, asserted == current_account_id.
    expect(signArgs.recipient).toBe(VAULT_CONTRACT_ID);
    expect(signArgs.nonce).toHaveLength(32);
  });

  it("signs the change set flattened next to signer_id + deadline", async () => {
    const signer = makeSigner();
    await submitUnallocate(params(signer));

    const message = JSON.parse(vi.mocked(signer.signNEP413Message).mock.calls[0][0].message);
    expect(message).toMatchObject({
      signer_id: "denance02.near",
      portfolio_id: PID,
      target_changes: [],
      token_additions: [],
      token_removals: [],
      unallocations: [[USDT, "1000000"]],
    });
    // Envelope TTL: 600s from now, as an ISO-8601 string.
    expect(message.deadline).toBe(new Date(1_800_000_600_000).toISOString());
  });
});

// D-472: the signed commit is submittable by any account for 600 s, so a user who signs and
// then cancels in the wallet must not leave it in the console for whoever reads it.
describe("submitUnallocate — the signed payload in the console", () => {
  afterEach(() => window.localStorage.clear());
  const loggedPayload = (log: { mock: { calls: unknown[][] } }) =>
    log.mock.calls.some((c) => String(c[0]).includes("commit payload"));

  it("stays out of the console by default", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await submitUnallocate(params(makeSigner()));
    expect(loggedPayload(log)).toBe(false);
  });

  it("is logged when this browser opted in (the operator-as-relayer hatch, D-R1)", async () => {
    window.localStorage.setItem(VAULT_DEBUG_ENVELOPES_KEY, "1");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await submitUnallocate(params(makeSigner()));
    expect(loggedPayload(log)).toBe(true);
  });
});

describe("submitUnallocate — outcomes", () => {
  it("reports a DEFER even though the transaction succeeded", async () => {
    const signer = makeSigner([
      eventLog("unallocate_deferred", {
        account_id: "denance02.near",
        portfolio_id: PID,
        token: USDT,
        qty_requested: "1000000",
        qty_available: "1000000",
        next_release_at: 1_800_000_300,
        reason: "maturity",
      }),
    ]);
    const res = await submitUnallocate(params(signer));

    expect(res.deferred?.nextReleaseAt).toBe(1_800_000_300);
    expect(res.accepted).toBe(false);
  });

  it("marks an accepted withdrawal as settling", async () => {
    const res = await submitUnallocate(params(makeSigner()));
    expect(res.deferred).toBeNull();
    expect(res.accepted).toBe(true);
    expect(res.failure).toBeNull();
  });

  it("fails fast on a REVERTED commit instead of polling for a settlement that cannot come", async () => {
    const signer = makeSigner();
    vi.mocked(signer.signAndSendTransaction).mockResolvedValue({
      transaction_outcome: { id: "CommitTxHash", outcome: { logs: [] } },
      status: {
        Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "rejected by the vault: E_NONCE_CONSUMED" } } } },
      },
      receipts_outcome: [],
    });

    // Typed, so the editor never reads the revert as the user cancelling (D-301).
    const error = await submitUnallocate(params(signer)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VaultCommitRevertedError);
    expect((error as VaultCommitRevertedError).reason).toMatch(/E_NONCE_CONSUMED/);
    expect((error as Error).message).toMatch(/vault reverted the change: .*E_NONCE_CONSUMED/);
    // And the classifier the editor runs it through agrees — the real class, not a stand-in.
    // The reason says "rejected" on purpose: only the class can keep it from reading as a cancel.
    expect(normalizeWalletError(error).kind).toBe("error");
  });

  it("surfaces a reverted batch transfer", async () => {
    const signer = makeSigner([
      eventLog("unallocate_failed", { commit_id: "c1", reason: "mt_batch_transfer reverted" }),
    ]);
    const res = await submitUnallocate(params(signer));
    expect(res.failure).toBe("mt_batch_transfer reverted");
  });

  // D-385 (a): the commit executed (nonce consumed, composition applied); only the batch
  // transfer failed in intents.near and the vault's callback released the locks.
  const panicked = (error: string) => ({
    Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: error } } } },
  });

  it("reads a batch transfer that failed in intents.near as the batch failure, not as a revert", async () => {
    const signer = makeSigner();
    vi.mocked(signer.signAndSendTransaction).mockResolvedValue({
      transaction_outcome: { id: "CommitTxHash", outcome: { logs: [] } },
      status: { SuccessValue: "" },
      receipts_outcome: [
        {
          outcome: {
            executor_id: VAULT_CONTRACT_ID,
            logs: [eventLog("pending_unallocation_opened", { commit_id: "c1" })],
            status: { SuccessValue: "" },
          },
        },
        {
          outcome: {
            executor_id: INTENTS_CONTRACT_ID,
            logs: [],
            status: panicked("Smart contract panicked: insufficient balance"),
          },
        },
        {
          outcome: {
            executor_id: VAULT_CONTRACT_ID,
            logs: [eventLog("unallocate_failed", { commit_id: "c1", reason: "mt_batch_transfer reverted" })],
            status: { SuccessValue: "" },
          },
        },
      ],
    });

    const res = await submitUnallocate(params(signer));
    expect(res.failure).toBe("mt_batch_transfer reverted");
  });

  it("still reads a vault receipt that panicked as a revert, whatever it logged first (D-324)", async () => {
    const signer = makeSigner();
    vi.mocked(signer.signAndSendTransaction).mockResolvedValue({
      transaction_outcome: { id: "CommitTxHash", outcome: { logs: [] } },
      status: panicked("Smart contract panicked: E_LEDGER_ARITHMETIC"),
      receipts_outcome: [
        {
          outcome: {
            executor_id: VAULT_CONTRACT_ID,
            logs: [eventLog("unallocate_failed", { commit_id: "c1", reason: "mt_batch_transfer reverted" })],
            status: panicked("Smart contract panicked: E_LEDGER_ARITHMETIC"),
          },
        },
      ],
    });

    const error = await submitUnallocate(params(signer)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VaultCommitRevertedError);
    expect((error as VaultCommitRevertedError).reason).toMatch(/E_LEDGER_ARITHMETIC/);
  });
});

describe("submitUnallocate — a relayer answer that proves nothing (D-329, D-330)", () => {
  it("returns submitUncertain with the relayer's hash instead of throwing", async () => {
    const unknown = new RelayError("no answer within 30000ms", "unknown-outcome", 504, "SentTxHash");
    const res = await submitUnallocate({ ...params(makeSigner()), submit: vi.fn().mockRejectedValue(unknown) });

    expect(res).toEqual({
      txHash: "SentTxHash",
      deferred: null,
      accepted: false,
      failure: null,
      submitUncertain: "no answer within 30000ms",
    });
  });

  it("re-throws a relayer refusal: it proves nothing was sent", async () => {
    const refusal = new RelayError("every upstream down", "send-failed", 502);
    await expect(
      submitUnallocate({ ...params(makeSigner()), submit: vi.fn().mockRejectedValue(refusal) })
    ).rejects.toBe(refusal);
  });

  it("re-throws a wallet's own error untouched (a cancel stays a cancel)", async () => {
    const cancelled = new Error("User rejected the request");
    await expect(
      submitUnallocate({ ...params(makeSigner()), submit: vi.fn().mockRejectedValue(cancelled) })
    ).rejects.toBe(cancelled);
  });
});

describe("submitUnallocate — refuses to sign nonsense", () => {
  it("rejects a zero-quantity leg without opening the wallet", async () => {
    const signer = makeSigner();
    await expect(
      submitUnallocate({ ...params(signer), legs: [{ tokenId: USDT, amount: "0" }] })
    ).rejects.toThrow(/Invalid unallocate amount/);
    expect(signer.signNEP413Message).not.toHaveBeenCalled();
  });

  it("rejects a non-integer amount (a float leaked from the editor)", async () => {
    const signer = makeSigner();
    await expect(
      submitUnallocate({ ...params(signer), legs: [{ tokenId: USDT, amount: "1.5" }] })
    ).rejects.toThrow(/Invalid unallocate amount/);
    expect(signer.signNEP413Message).not.toHaveBeenCalled();
  });

  it("rejects a change set that carries no effect at all", async () => {
    const signer = makeSigner();
    await expect(submitUnallocate({ ...params(signer), legs: [] })).rejects.toThrow(
      /at least one leg, one composition change, a rename or a delete/
    );
    expect(signer.signNEP413Message).not.toHaveBeenCalled();
  });

  // 017-9c: a signed delete rides alone (ADR-0023). Mixed, the contract answers
  // E_INVALID_COMPOSITION after the signature; refused here before it.
  it("rejects a delete that carries legs, edits or a rename", async () => {
    const signer = makeSigner();
    for (const extra of [
      { legs: [{ tokenId: USDT, amount: "1" }] },
      { legs: [], tokenRemovals: [USDT] },
      { legs: [], name: "x" },
    ]) {
      await expect(submitUnallocate({ ...params(signer), ...extra, delete: true })).rejects.toThrow(
        /cannot carry/
      );
    }
    expect(signer.signNEP413Message).not.toHaveBeenCalled();
  });

  it("ACCEPTS a legless commit when it carries composition edits (008.plan Phase 2)", async () => {
    const signer = makeSigner();
    await submitUnallocate({
      ...params(signer),
      legs: [],
      tokenRemovals: ["nep141:dai.near"],
    });

    const inner = JSON.parse(vi.mocked(signer.signNEP413Message).mock.calls[0][0].message);
    expect(inner.token_removals).toEqual(["nep141:dai.near"]);
    expect(inner.unallocations).toEqual([]);
  });
});
