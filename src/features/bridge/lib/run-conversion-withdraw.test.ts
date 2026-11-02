// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { IntentSettlementError } from "@defuse-protocol/internal-utils";
import type { MultiPayload, VaultSigner } from "@/features/vault/lib/vault-signer";
import {
  runConversionWithdraw,
  type ConversionWithdrawStage,
  type RunConversionWithdrawParams,
} from "./run-conversion-withdraw";
import { HeldReadFailedError, HeldReadTimeoutError, RealWithdrawUnconfirmedError } from "./run-real-withdraw";
import { ConversionNotSignableError } from "./conversion-envelope";
import type { ConversionQuote } from "./oneclick-conversion-quote";
import { conversionWatchBudgetMs, type ConversionOutcome } from "./oneclick-status";
import {
  listUnresolvedWithdrawRecords,
  listWithdrawRecords,
  type ConversionWithdrawRescueRecord,
} from "./withdraw-rescue-store";
import { nonceToBase64 } from "./withdraw-publication-check";
import {
  WithdrawError,
  WithdrawRelayRejectedError,
  WithdrawSettlementFailedError,
} from "./withdraw-errors";
import type { SettlementWaiter } from "./withdraw-poll";
import type { WithdrawPublisher } from "./withdraw-submit";

// End to end with the wallet, the relay and 1Click faked. The happy path is the least of it; what
// these tests defend is the rule the whole module is built on:
//
//   - only `fundsState: "untouched"` resolves a record as failed, and only BEFORE the money reaches
//     1Click (a refused publish, a Verifier-declared invalid settlement);
//   - after the settlement only 1Click's SUCCESS or REFUNDED closes the record — FAILED, an outage
//     or an expired watch reach the caller as `RealWithdrawUnconfirmedError` with `left-balance`,
//     the record left OPEN for the next mount;
//   - the record is written after the signature and before the publish, or nothing is published.
//
// No network: `fetch` throws, so an un-injected call fails the test instead of hitting mainnet.

const SIGNER = "pablofork.near";
const INTENT_HASH = "0xTransferIntent";
const TX_HASH = "TransferSettlementTx";
const FAKE_PAYLOAD = { standard: "nep413" } as unknown as MultiPayload;

/** Journey 1's quote (ETH from Ethereum → a NEAR wallet), as `quoteConversion` returns it. */
const QUOTE: ConversionQuote = {
  originTokenId: "nep141:eth.omft.near",
  deliveryTokenId: "nep141:eth.bridge.near",
  chainId: "near:mainnet",
  destinationAsset: "nep141:eth.bridge.near",
  recipient: SIGNER,
  refundTo: SIGNER,
  depositAddress: "5863efabda6c40d89b37aa899add569e32cb7a670e6b56a7f2cbb8d62c5333a0",
  amountInRaw: "5000000000000000",
  amountOutRaw: "4998990052004899",
  minAmountOutRaw: "4973995101744874",
  withdrawFeeRaw: "0",
  createsTokenAccount: false,
  refundFeeRaw: "0",
  slippageBps: 50,
  requestedDeadlineMs: Date.parse("2026-10-06T10:27:22.000Z"),
  quoteDeadlineMs: Date.parse("2026-10-09T10:27:22.000Z"),
  timeEstimateSecs: 10,
  signature: "ed25519:3pqqpV5Xz3UboL1wq7TjCeJ9AD6xQUzSSZ2FAawWc7MPLqn4vsW4U3vfZHUeBrVGFM2kbdkvpq69F7gZUHUeybHr",
  quotedAtMs: Date.parse("2026-10-06T10:17:22.000Z"),
};
const CLICK_MS = QUOTE.quotedAtMs + 30_000;

const READING = {
  updatedAt: "2026-10-06T10:18:00.000Z",
  destinationTxHash: null,
  amountOutRaw: null,
  refundedAmountRaw: "0",
};
const DELIVERED: ConversionOutcome = {
  kind: "delivered",
  reading: { ...READING, status: "SUCCESS", destinationTxHash: "DestTx", amountOutRaw: "4998990052004899" },
};
const REFUNDED: ConversionOutcome = {
  kind: "refunded",
  reading: { ...READING, status: "REFUNDED", refundedAmountRaw: "5000000000000000" },
};
const FAILED: ConversionOutcome = { kind: "failed", reading: { ...READING, status: "FAILED" } };
const UNANSWERED: ConversionOutcome = {
  kind: "unanswered",
  last: { ...READING, status: "PROCESSING" },
  detail: "no final answer within 900s (1Click still reports PROCESSING)",
};

/** A waiter that never resolves on its own, so only a deadline can end it. */
const hangs =
  <T,>(): ((p: { signal?: AbortSignal }) => Promise<T>) =>
  ({ signal }) =>
    new Promise<T>((_resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener("abort", () => reject(signal.reason));
    });

let signer: VaultSigner & { signEnvelope: ReturnType<typeof vi.fn> };
let publish: ReturnType<typeof vi.fn>;
let settle: ReturnType<typeof vi.fn>;
let watchConversion: ReturnType<typeof vi.fn>;
let stages: ConversionWithdrawStage[];

beforeEach(() => {
  window.localStorage.clear();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("no test may touch the network");
    })
  );
  signer = { scheme: "nep413", signEnvelope: vi.fn(async () => FAKE_PAYLOAD) };
  publish = vi.fn(async () => ({ status: "OK", intent_hash: INTENT_HASH }));
  settle = vi.fn(async ({ intentHash, onTxHashKnown }: { intentHash: string; onTxHashKnown?: (h: string) => void }) => {
    onTxHashKnown?.(TX_HASH);
    return { txHash: TX_HASH, intentHash };
  });
  watchConversion = vi.fn(async () => DELIVERED);
  stages = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function run(over: Partial<RunConversionWithdrawParams> = {}) {
  return runConversionWithdraw({
    accountId: SIGNER,
    quote: QUOTE,
    qty: 0.005,
    signer,
    publish: publish as unknown as WithdrawPublisher,
    waitForSettlement: settle as unknown as SettlementWaiter,
    watchConversion: watchConversion as unknown as RunConversionWithdrawParams["watchConversion"],
    envelope: { nowMs: CLICK_MS, nonce: new Uint8Array(32).fill(7) },
    readHeld: async () => BigInt(QUOTE.amountInRaw),
    onStage: (s) => stages.push(s),
    ...over,
  });
}

function onlyRecord(): ConversionWithdrawRescueRecord {
  const records = listWithdrawRecords();
  expect(records).toHaveLength(1);
  expect(records[0].kind).toBe("conversion");
  return records[0] as ConversionWithdrawRescueRecord;
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the run to throw");
    },
    (e: unknown) => e
  );
}

describe("runConversionWithdraw — 1Click delivers", () => {
  it("walks every stage in order and reports the delivery", async () => {
    const result = await run();

    expect(stages).toEqual([
      "preparing",
      "signing",
      "publishing",
      "awaiting-settlement",
      "converting",
      "delivered",
    ]);
    expect(result).toEqual({
      recordId: onlyRecord().id,
      intentHash: INTENT_HASH,
      txHash: TX_HASH,
      amount: QUOTE.amountInRaw,
      outcome: { kind: "delivered", destinationTxHash: "DestTx", amountOutRaw: "4998990052004899" },
    });
  });

  // D-463: what lets a reload ask intents.near whether the transfer ever ran.
  it("keeps the signed nonce and the transfer deadline on the record", async () => {
    await run();
    const [request] = signer.signEnvelope.mock.calls[0];
    const deadline = JSON.parse(request.nep413.message).deadline;
    expect(onlyRecord()).toMatchObject({
      nonce: nonceToBase64(new Uint8Array(32).fill(7)),
      deadline: Date.parse(deadline),
    });
  });

  it("signs one transfer of the whole amount to the deposit address, against intents.near", async () => {
    await run();

    const [request] = signer.signEnvelope.mock.calls[0];
    expect(request.nep413.recipient).toBe("intents.near");
    const signed = JSON.parse(request.nep413.message);
    expect(signed.signer_id).toBe(SIGNER);
    expect(signed.intents).toEqual([
      {
        intent: "transfer",
        receiver_id: QUOTE.depositAddress,
        tokens: { [QUOTE.originTokenId]: QUOTE.amountInRaw },
      },
    ]);
  });

  it("publishes with no relay quote hash — 1Click's quote is not the relay's", async () => {
    await run();
    expect(publish).toHaveBeenCalledWith({ quote_hashes: [], signed_data: FAKE_PAYLOAD });
  });

  it("follows 1Click by the quote's deposit address and signature, on the quote's own budget", async () => {
    const controller = new AbortController();
    await run({ signal: controller.signal });

    expect(watchConversion).toHaveBeenCalledWith({
      depositAddress: QUOTE.depositAddress,
      quoteSignature: QUOTE.signature,
      timeoutMs: conversionWatchBudgetMs(QUOTE.timeEstimateSecs),
      signal: controller.signal,
    });
  });

  it("lets the caller bound the watch", async () => {
    await run({ timeouts: { conversionMs: 1234 } });
    expect(watchConversion.mock.calls[0][0].timeoutMs).toBe(1234);
  });

  it("keeps the whole quote in a resolved conversion record", async () => {
    await run();

    expect(onlyRecord()).toMatchObject({
      kind: "conversion",
      signerId: SIGNER,
      // What LEFT the balance is the held token; what arrives is the Delivery Token.
      tokenId: QUOTE.originTokenId,
      amount: QUOTE.amountInRaw,
      qty: 0.005,
      chainId: "near:mainnet",
      destinationAddress: SIGNER,
      status: "delivered",
      intentHash: INTENT_HASH,
      txHash: TX_HASH,
      destinationTxHash: "DestTx",
      conversion: {
        depositAddress: QUOTE.depositAddress,
        deliveryTokenId: QUOTE.deliveryTokenId,
        amountOut: QUOTE.amountOutRaw,
        minAmountOut: QUOTE.minAmountOutRaw,
        requestedDeadlineMs: QUOTE.requestedDeadlineMs,
        quoteSignature: QUOTE.signature,
      },
    });
    expect(listUnresolvedWithdrawRecords()).toEqual([]);
  });

  it("records a delivery 1Click could not name as delivered, with no hash key at all", async () => {
    watchConversion = vi.fn(async () => ({ ...DELIVERED, reading: { ...DELIVERED.reading, destinationTxHash: null } }));
    const result = await run();

    expect(result.outcome).toMatchObject({ kind: "delivered", destinationTxHash: null });
    expect(onlyRecord().status).toBe("delivered");
    expect("destinationTxHash" in onlyRecord()).toBe(false);
  });

  it("hands over the record id before the publish", async () => {
    const seen: Array<{ id: string; publishedYet: boolean }> = [];
    const result = await run({
      onRecordId: (id) => seen.push({ id, publishedYet: publish.mock.calls.length > 0 }),
    });
    expect(seen).toEqual([{ id: result.recordId, publishedYet: false }]);
  });
});

describe("runConversionWithdraw — 1Click refunds", () => {
  it("returns the refund as an outcome and resolves the record as refunded", async () => {
    watchConversion = vi.fn(async () => REFUNDED);
    const result = await run();

    expect(stages.at(-1)).toBe("refunded");
    expect(stages).not.toContain("published-unconfirmed");
    expect(result.outcome).toEqual({ kind: "refunded", refundedAmountRaw: "5000000000000000" });
    expect(onlyRecord()).toMatchObject({ status: "refunded", refundedAmount: "5000000000000000" });
    expect(listUnresolvedWithdrawRecords()).toEqual([]);
  });
});

describe("runConversionWithdraw — past the settlement, nothing short of a final answer closes it", () => {
  it.each([
    ["1Click reports FAILED", FAILED, /FAILED/],
    ["the watch ends without a final answer", UNANSWERED, /still reports PROCESSING/],
  ])("%s: unconfirmed, left-balance, record open", async (_label, outcome, message) => {
    watchConversion = vi.fn(async () => outcome);

    const error = await failure(run());

    expect(error).toBeInstanceOf(RealWithdrawUnconfirmedError);
    const e = error as RealWithdrawUnconfirmedError;
    expect(e.fundsState).toBe("left-balance");
    expect(e.message).toMatch(message);
    expect(e.recordId).toBe(onlyRecord().id);
    expect(e.intentHash).toBe(INTENT_HASH);
    expect(e.txHash).toBe(TX_HASH);
    expect(stages.at(-1)).toBe("published-unconfirmed");
    // Still `settled` and on the worklist: the next mount asks 1Click again.
    expect(onlyRecord()).toMatchObject({ status: "settled", error: expect.stringMatching(message) });
    expect(listUnresolvedWithdrawRecords()).toHaveLength(1);
  });

  it("treats a watch that throws like one that never answered", async () => {
    watchConversion = vi.fn(async () => {
      throw new Error("watch crashed");
    });

    const error = (await failure(run())) as RealWithdrawUnconfirmedError;

    expect(error).toBeInstanceOf(RealWithdrawUnconfirmedError);
    expect(error.fundsState).toBe("left-balance");
    expect(onlyRecord()).toMatchObject({ status: "settled", error: "watch crashed" });
  });
});

describe("runConversionWithdraw — the publish and the settlement", () => {
  it("a publish with no answer is unknown, never failed, and the record stays open", async () => {
    publish = vi.fn(async () => {
      throw new Error("socket hang up");
    });

    const error = (await failure(run())) as RealWithdrawUnconfirmedError;

    expect(error).toBeInstanceOf(RealWithdrawUnconfirmedError);
    expect(error.fundsState).toBe("unknown");
    expect(error.intentHash).toBeNull();
    expect(stages.at(-1)).toBe("published-unconfirmed");
    expect(onlyRecord()).toMatchObject({ status: "publishing", error: expect.stringMatching(/socket hang up/) });
    expect(listUnresolvedWithdrawRecords()).toHaveLength(1);
    expect(settle).not.toHaveBeenCalled();
  });

  it("a relay refusal is untouched: record resolved as failed, nothing followed", async () => {
    publish = vi.fn(async () => ({ status: "FAILED", reason: "insufficient balance or overflow" }));

    const error = await failure(run());

    expect(error).toBeInstanceOf(WithdrawRelayRejectedError);
    expect((error as WithdrawError).fundsState).toBe("untouched");
    expect(stages).not.toContain("published-unconfirmed");
    expect(onlyRecord().status).toBe("failed");
    expect(listUnresolvedWithdrawRecords()).toEqual([]);
    expect(settle).not.toHaveBeenCalled();
    expect(watchConversion).not.toHaveBeenCalled();
  });

  it("an answer the relay gave in a shape we cannot read is unknown", async () => {
    publish = vi.fn(async () => ({ hello: "world" }));

    const error = (await failure(run())) as RealWithdrawUnconfirmedError;

    expect(error).toBeInstanceOf(RealWithdrawUnconfirmedError);
    expect(error.fundsState).toBe("unknown");
    expect(listUnresolvedWithdrawRecords()).toHaveLength(1);
  });

  it("a Verifier-declared invalid transfer is untouched: nothing reached 1Click", async () => {
    settle = vi.fn(async () => {
      throw new IntentSettlementError({
        status: "NOT_FOUND_OR_NOT_VALID",
        intent_hash: INTENT_HASH,
        status_details: "FAILED",
      });
    });

    const error = await failure(run());

    expect(error).toBeInstanceOf(WithdrawSettlementFailedError);
    expect((error as WithdrawError).fundsState).toBe("untouched");
    expect(onlyRecord()).toMatchObject({ status: "failed", intentHash: INTENT_HASH });
    expect(watchConversion).not.toHaveBeenCalled();
  });

  it("a settlement we stopped watching is unknown, keeps the tx hash, and never reaches 1Click's leg", async () => {
    settle = vi.fn(
      ({ onTxHashKnown, signal }: { onTxHashKnown?: (h: string) => void; signal?: AbortSignal }) => {
        onTxHashKnown?.(TX_HASH);
        return hangs<{ txHash: string; intentHash: string }>()({ signal });
      }
    );

    const error = (await failure(run({ timeouts: { settlementMs: 5 } }))) as RealWithdrawUnconfirmedError;

    expect(error).toBeInstanceOf(RealWithdrawUnconfirmedError);
    expect(error.fundsState).toBe("unknown");
    expect(error.txHash).toBe(TX_HASH);
    // A known hash is not an observed settlement.
    expect(onlyRecord()).toMatchObject({ status: "published", txHash: TX_HASH });
    expect(stages).not.toContain("converting");
    expect(watchConversion).not.toHaveBeenCalled();
  });
});

describe("runConversionWithdraw — before anything is published", () => {
  it("does not publish at all when the record cannot be persisted", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });

    const error = await failure(run());

    expect(String(error)).toMatch(/QuotaExceededError/);
    // Not a WithdrawError: the screen reads that as `untouched`, which it is.
    expect(error).not.toBeInstanceOf(WithdrawError);
    expect(signer.signEnvelope).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
  });

  it("refuses to sign a balance below the quote — re-quote, never shrink", async () => {
    const error = await failure(run({ readHeld: async () => BigInt(QUOTE.amountInRaw) - BigInt(1) }));

    expect(error).toBeInstanceOf(ConversionNotSignableError);
    expect((error as ConversionNotSignableError).reason).toBe("balance-short");
    expect((error as ConversionNotSignableError).fundsState).toBe("untouched");
    expect(signer.signEnvelope).not.toHaveBeenCalled();
    expect(listWithdrawRecords()).toEqual([]);
  });

  it("refuses a quote about to expire", async () => {
    const error = await failure(run({ envelope: { nowMs: QUOTE.requestedDeadlineMs - 60_000 } }));
    expect((error as ConversionNotSignableError).reason).toBe("quote-expiring");
    expect(signer.signEnvelope).not.toHaveBeenCalled();
  });

  it("refuses a quote that refunds to another account than the one signing", async () => {
    const error = await failure(run({ accountId: "someone-else.near" }));
    expect((error as ConversionNotSignableError).reason).toBe("signer-mismatch");
    expect(signer.signEnvelope).not.toHaveBeenCalled();
  });

  it("reads the balance of the token that leaves, for the signing account", async () => {
    const readHeld = vi.fn(async () => BigInt(QUOTE.amountInRaw));
    await run({ readHeld });
    expect(readHeld).toHaveBeenCalledWith(SIGNER, QUOTE.originTokenId);
  });

  it("a balance read that fails or stalls signs nothing", async () => {
    const failed = await failure(run({ readHeld: async () => Promise.reject(new Error("RPC 502")) }));
    expect(failed).toBeInstanceOf(HeldReadFailedError);

    const slow = await failure(run({ readHeld: async () => Promise.reject(new HeldReadTimeoutError()) }));
    expect(slow).toBeInstanceOf(HeldReadTimeoutError);

    expect(signer.signEnvelope).not.toHaveBeenCalled();
  });

  it("a cancel in the wallet leaves no record and publishes nothing", async () => {
    signer.signEnvelope.mockRejectedValueOnce(new Error("User rejected the request"));

    const error = await failure(run());

    expect(String(error)).toMatch(/User rejected/);
    expect(listWithdrawRecords()).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
  });
});
