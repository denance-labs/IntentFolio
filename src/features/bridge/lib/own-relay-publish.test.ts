import { describe, expect, it, vi } from "vitest";
import { RelayError } from "@/features/vault/lib/relay-client";
import { RELAY_ALREADY_SENT_ERROR } from "@/features/vault/lib/relay-types";
import type { MultiPayload, VaultSigner } from "@/features/vault/lib/vault-signer";
import {
  createOwnRelayPublication,
  executedIntentHash,
  OwnRelayUnconfirmedError,
  readSignerAndNonce,
  unconfirmedPublishTxHash,
  type VerifierSubmit,
} from "./own-relay-publish";
import { buildWithdrawSignRequest } from "./withdraw-envelope";
import { WithdrawPublishUnknownError, WithdrawRelayRejectedError } from "./withdraw-errors";
import { waitForWithdrawSettlement } from "./withdraw-poll";
import { parsePublishResponse, submitWithdraw } from "./withdraw-submit";

const SIGNER = "alice.near";
const NONCE_BYTES = new Uint8Array(32).fill(7);
const NONCE = Buffer.from(NONCE_BYTES).toString("base64");
const TX = "8sQacxtuTx";
const HASH = "EpqKNvqdFcrNS2g6aLqSWFN6RWe92a65jzc3WVQFgvKj";
const RELAYER = "relayer.near";

function nep413(message: Record<string, unknown> = { signer_id: SIGNER, deadline: "x", intents: [] }, nonce = NONCE) {
  return {
    standard: "nep413",
    payload: { message: JSON.stringify(message), nonce, recipient: "intents.near" },
    public_key: "ed25519:x",
    signature: "ed25519:x",
  } as unknown as MultiPayload;
}

const executed = (entries: Record<string, unknown>[]) =>
  `EVENT_JSON:${JSON.stringify({ standard: "dip4", version: "0.4.3", event: "intents_executed", data: entries })}`;

/**
 * An `execute_intents` outcome as `/api/relay` hands it back (EXECUTED_OPTIMISTIC): the first
 * receipt is `intents.near` running it; `tail` adds a later one (a token's `ft_transfer`).
 */
function outcome(
  opts: {
    status?: unknown;
    logs?: string[];
    executor?: string;
    receiptStatus?: unknown;
    receiptIds?: unknown;
    tail?: { status: unknown; logs?: string[] };
  } = {}
): Record<string, unknown> {
  return {
    status: "status" in opts ? opts.status : { SuccessValue: "" },
    transaction: { signer_id: RELAYER, hash: TX },
    transaction_outcome: { id: TX, outcome: { logs: [], receipt_ids: "receiptIds" in opts ? opts.receiptIds : ["R1"] } },
    receipts_outcome: [
      {
        id: "R1",
        outcome: {
          executor_id: opts.executor ?? "intents.near",
          status: opts.receiptStatus ?? { SuccessValue: "" },
          logs: opts.logs ?? [executed([{ intent_hash: HASH, account_id: SIGNER, nonce: NONCE }])],
        },
      },
      ...(opts.tail
        ? [{ id: "R2", outcome: { executor_id: "usdt.tether-token.near", status: opts.tail.status, logs: opts.tail.logs ?? [] } }]
        : []),
    ],
  };
}

const answering = (answer: unknown) => vi.fn<VerifierSubmit>(async () => answer);
const throwing = (error: unknown) =>
  vi.fn<VerifierSubmit>(async () => {
    throw error;
  });
const publishWith = (submit: VerifierSubmit, signed: MultiPayload = nep413(), quoteHashes: string[] = []) =>
  createOwnRelayPublication(submit).publish({ quote_hashes: quoteHashes, signed_data: signed });

describe("own relay publish (D-589)", () => {
  it("publishes through the Verifier target and settles at once with the executed tx", async () => {
    const submit = answering(outcome());
    const { publish, waitForSettlement, senderOf } = createOwnRelayPublication(submit);
    const signed = nep413();

    const response = await publish({ quote_hashes: [], signed_data: signed });
    expect(submit).toHaveBeenCalledWith({ target: "verifier", payload: signed });
    expect(parsePublishResponse(response)).toBe(HASH);
    // HOT's delivery wait finds the settlement by its sender: the relayer, not intents.near.
    expect(senderOf(TX)).toBe(RELAYER);
    expect(senderOf("another-tx")).toBeUndefined();

    const onTxHashKnown = vi.fn();
    await expect(waitForSettlement({ intentHash: HASH, onTxHashKnown })).resolves.toEqual({ txHash: TX, intentHash: HASH });
    expect(onTxHashKnown).toHaveBeenCalledWith(TX);
    // Once: a second wait for the same intent has nothing to follow.
    await expect(waitForSettlement({ intentHash: HASH })).rejects.toThrow(/no settlement known/);
  });

  it("takes the hash of THIS signer and nonce out of a batch the Verifier ran", async () => {
    const logs = [
      executed([
        { intent_hash: "SOLVER_HASH", account_id: "solver.near", nonce: NONCE },
        { intent_hash: "OTHER_NONCE", account_id: SIGNER, nonce: Buffer.alloc(32, 1).toString("base64") },
        { intent_hash: HASH, account_id: SIGNER, nonce: NONCE },
      ]),
    ];
    expect(parsePublishResponse(await publishWith(answering(outcome({ logs }))))).toBe(HASH);
  });

  it("reads no hash from a receipt intents.near did not run, and does not call it executed", async () => {
    const foreign = outcome({ executor: "attacker.near" });
    expect(executedIntentHash(foreign, readSignerAndNonce(nep413())!)).toBeNull();
    await expect(publishWith(answering(foreign))).rejects.toThrow(/does not show execute_intents ending/);
  });

  it("does not take the hash from a later receipt's log, even one that names this intent", async () => {
    const forged = executed([{ intent_hash: "FORGED", account_id: SIGNER, nonce: NONCE }]);
    const o = outcome({ logs: [], tail: { status: { SuccessValue: "" }, logs: [forged] } });
    // Executed but unnamed: not a refusal, and not a settlement either.
    await expect(publishWith(answering(o))).rejects.toThrow(/do not name this intent/);
  });

  it("is a settlement when execute_intents ran and a LATER receipt failed (the Verifier refunds)", async () => {
    // The final status follows the tail, so it reads Failure: it must not be read as "not executed".
    const o = outcome({ status: { Failure: {} }, tail: { status: { Failure: { ActionError: {} } } } });
    expect(parsePublishResponse(await publishWith(answering(o)))).toBe(HASH);
  });

  it("calls a refusal before sending a refusal: nothing executed (NOT_EXECUTED, untouched)", async () => {
    for (const code of ["would-fail", "check-failed", "send-failed", "paused", "cap-exceeded", "blocked"]) {
      const response = await publishWith(throwing(new RelayError("not the app's shape", code, 422)));
      const error = (() => {
        try {
          parsePublishResponse(response);
        } catch (e) {
          return e;
        }
      })();
      expect(error, code).toBeInstanceOf(WithdrawRelayRejectedError);
      expect(error).toMatchObject({ code: "NOT_EXECUTED", fundsState: "untouched" });
    }
  });

  it("keeps the contract's own code when the simulation names it", () => {
    return publishWith(throwing(new RelayError("insufficient balance or overflow", "would-fail", 422))).then((response) =>
      expect(() => parsePublishResponse(response)).toThrow(
        expect.objectContaining({ code: "INSUFFICIENT_BALANCE", fundsState: "untouched" })
      )
    );
  });

  it("calls a reverted execute_intents not executed, but a used nonce stays unknown", async () => {
    const reverted = (message: string) =>
      outcome({ receiptStatus: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: message } } } } } });

    const response = await publishWith(answering(reverted("Smart contract panicked: deadline passed")));
    expect(() => parsePublishResponse(response)).toThrow(expect.objectContaining({ code: "NOT_EXECUTED", fundsState: "untouched" }));

    const used = await publishWith(answering(reverted("Smart contract panicked: nonce was already used")));
    expect(() => parsePublishResponse(used)).toThrow(WithdrawPublishUnknownError);
  });

  it("throws (unknown) on an unanswered send, and the tx hash reaches whoever wraps the error", async () => {
    const lost = new RelayError("the send timed out", "unknown-outcome", 504, "TXLOST");
    const thrown = await publishWith(throwing(lost)).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(OwnRelayUnconfirmedError);
    expect(String(thrown)).toMatch(/TXLOST/);
    // As `submitWithdraw` wraps it before the flow reads it for the rescue record.
    expect(unconfirmedPublishTxHash(new WithdrawPublishUnknownError("x", thrown))).toBe("TXLOST");

    const offline = await publishWith(throwing(new TypeError("Failed to fetch"))).catch((e: unknown) => e);
    expect(offline).toBeInstanceOf(OwnRelayUnconfirmedError);
    expect(unconfirmedPublishTxHash(offline)).toBeNull();
  });

  it("throws (unknown) on a refusal that the first copy was already sent: it may have landed", async () => {
    const again = new RelayError(RELAY_ALREADY_SENT_ERROR, "would-fail", 422);
    await expect(publishWith(throwing(again))).rejects.toBeInstanceOf(OwnRelayUnconfirmedError);
  });

  it("throws (unknown) when the outcome does not show execute_intents ending, keeping the tx", async () => {
    for (const o of [outcome({ receiptIds: undefined }), outcome({ receiptStatus: { NotStarted: null } }), null]) {
      await expect(publishWith(answering(o))).rejects.toThrow(/does not show execute_intents ending/);
    }
    const thrown = await publishWith(answering(outcome({ receiptIds: [] }))).catch((e: unknown) => e);
    expect(unconfirmedPublishTxHash(thrown)).toBe(TX);
  });

  it("does not send a quoted swap (HOT's fee) or an envelope it cannot read", async () => {
    const submit = answering(outcome());
    for (const response of [
      await publishWith(submit, nep413(), ["quote-hash"]),
      await publishWith(submit, { standard: "nep413", payload: "x" } as unknown as MultiPayload),
    ]) {
      expect(() => parsePublishResponse(response)).toThrow(expect.objectContaining({ code: "NOT_EXECUTED" }));
    }
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("readSignerAndNonce", () => {
  const text = JSON.stringify({ signer_id: "0xabc", verifying_contract: "intents.near", nonce: NONCE, intents: [] }, null, 2);

  it("reads every family's wire form", () => {
    expect(readSignerAndNonce(nep413())).toEqual({ signerId: SIGNER, nonce: NONCE });
    for (const standard of ["erc191", "tip191", "raw_ed25519", "sep53"]) {
      expect(readSignerAndNonce({ standard, payload: text, signature: "x" }), standard).toEqual({ signerId: "0xabc", nonce: NONCE });
    }
    expect(readSignerAndNonce({ standard: "ton_connect", payload: { type: "text", text } })).toEqual({ signerId: "0xabc", nonce: NONCE });
  });

  it("is null for anything else", () => {
    for (const bad of [null, "x", { standard: "erc191", payload: "{" }, { standard: "nep413", payload: { message: "{}" } }]) {
      expect(readSignerAndNonce(bad)).toBeNull();
    }
  });
});

describe("a withdrawal end to end through the own relay (D-589)", () => {
  it("publishes, settles and names the tx, with the app's own envelope and signer seam", async () => {
    const request = buildWithdrawSignRequest({
      signerId: SIGNER,
      tokenId: "nep141:usdt.tether-token.near",
      chainId: "near:mainnet",
      qty: 1,
      heldRaw: BigInt(10) ** BigInt(12),
      destinationAddress: "bob.near",
      deadlineSecs: 1_900_000_000,
      nonce: NONCE_BYTES,
    });
    const signer: VaultSigner = {
      scheme: "nep413",
      signEnvelope: async (req) => nep413(JSON.parse(req.nep413.message) as Record<string, unknown>, Buffer.from(req.nep413.nonce).toString("base64")),
    };
    const submit = answering(outcome());
    const relay = createOwnRelayPublication(submit);

    const submitted = await submitWithdraw({
      request,
      tokenId: "nep141:usdt.tether-token.near",
      chainId: "near:mainnet",
      destinationAddress: "bob.near",
      signer,
      publish: relay.publish,
      destinationAlreadyVerified: true,
    });
    expect(submitted).toEqual({ intentHash: HASH, route: "near-native" });
    // What went to /api/relay is the signed envelope itself, intents and all.
    const sent = submit.mock.calls[0][0].payload as { payload: { message: string } };
    expect(JSON.parse(sent.payload.message).intents).toEqual(request.intents);

    await expect(
      waitForWithdrawSettlement({ intentHash: submitted.intentHash, waitForSettlement: relay.waitForSettlement })
    ).resolves.toEqual({ txHash: TX, intentHash: HASH });
  });
});
