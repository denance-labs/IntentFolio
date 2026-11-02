// Orchestrates a Converting Withdrawal, end to end (D-392, plan 020 §5.4 and block 020-2;
// ADR-0024). Nothing reaches it until 020-3 wires the screen behind its flag.
//
//   read balance → build the transfer → sign → persist the rescue record → publish → settle →
//   follow 1Click until it delivers or refunds
//
// Attribution: see ATTRIBUTIONS.md #10 (relay publish parsing and settlement, reused unchanged)
// and #13 (1Click: the quote this pays and the `/v0/status` it follows).
//
// THE SAME DISCIPLINE AS run-real-withdraw.ts, ONE LEG LONGER. The publish and the settlement are
// the direct withdrawal's own pieces (`parsePublishResponse`, `waitForWithdrawSettlement`), and
// their `fundsState` is consumed, never re-derived: only `untouched` is a plain failure, and
// everything else reaches the caller as `RealWithdrawUnconfirmedError` — the same class, so the
// screen's existing "not confirmed" branch covers both kinds. What is new is the leg after the
// settlement. There the money is in 1Click's deposit account, and the only things that close the
// record are 1Click's two final answers (oneclick-status.ts):
//
//   SUCCESS   → `delivered`  (resolved)
//   REFUNDED  → `refunded`   (resolved; the money is back in the General Balance)
//   FAILED, or no final answer before the watch ends → `published-unconfirmed`, `left-balance`,
//             record OPEN — `usePendingWithdrawals` asks again on the next mount.
//
// It never says "lost": past the settlement the honest statements are "delivered", "back in your
// balance" and "not confirmed yet".

import type { VaultSigner } from "@/features/vault/lib/vault-signer";
import { buildConversionSignRequest } from "./conversion-envelope";
import type { ConversionQuote } from "./oneclick-conversion-quote";
import {
  conversionWatchBudgetMs,
  waitForConversionOutcome,
  type ConversionOutcome,
} from "./oneclick-status";
import {
  HeldReadFailedError,
  HeldReadTimeoutError,
  RealWithdrawUnconfirmedError,
  readHeldOnVerifier,
} from "./run-real-withdraw";
import { waitForWithdrawSettlement, type SettlementWaiter } from "./withdraw-poll";
import {
  defaultWithdrawPublisher,
  parsePublishResponse,
  type WithdrawPublisher,
} from "./withdraw-submit";
import { WithdrawError, WithdrawPublishUnknownError, type WithdrawFundsState } from "./withdraw-errors";
import { recordPendingWithdraw, updateWithdrawRecord } from "./withdraw-record-sink";
import { nonceToBase64 } from "./withdraw-publication-check";

export type ConversionWithdrawStage =
  | "preparing"
  | "signing"
  | "publishing"
  | "awaiting-settlement"
  /** Settled: the money left the General Balance and 1Click is converting and sending it. */
  | "converting"
  | "delivered"
  /** 1Click sent the money back to the General Balance. Resolved, and not a failure to move. */
  | "refunded"
  /** Published, possibly settled and converting, with no final answer observed. NOT a failure. */
  | "published-unconfirmed";

export type ConversionWithdrawResult = {
  /** Rescue-store id — the handle for following this withdrawal after the fact. */
  recordId: string;
  intentHash: string;
  /** The NEAR settlement transaction of the `transfer`. */
  txHash: string;
  /** Base units of the held token that left the General Balance: `quote.amountInRaw`. */
  amount: string;
  outcome:
    | { kind: "delivered"; destinationTxHash: string | null; amountOutRaw: string | null }
    | { kind: "refunded"; refundedAmountRaw: string | null };
};

export type RunConversionWithdrawParams = {
  /** The INTENTS account id — the quote's `refundTo`, or nothing is signed. */
  accountId: string;
  /** EXACTLY the quote the screen displayed and the user accepted. */
  quote: ConversionQuote;
  /** Human units, as the modal shows them. For the record and the activity row only. */
  qty: number;
  signer: VaultSigner;
  onStage?: (stage: ConversionWithdrawStage) => void;
  /**
   * The rescue-store id, the instant it exists — after the signature, before the publish. Same
   * contract as `RunRealWithdrawParams.onRecordId`: it keeps the row on screen and the durable
   * record the same withdrawal after a reload.
   */
  onRecordId?: (recordId: string) => void;
  /** Envelope tuning; injectable so tests are deterministic. `nowMs` is C2's clock. */
  envelope?: { nonce?: Uint8Array; nowMs?: number };
  /** The exact balance C1 checks against (D-303). Defaults to the direct withdrawal's read. */
  readHeld?: (accountId: string, tokenId: string) => Promise<bigint>;
  /** Network seams, all injectable — nothing here may reach the network in a test. */
  publish?: WithdrawPublisher;
  waitForSettlement?: SettlementWaiter;
  watchConversion?: typeof waitForConversionOutcome;
  /**
   * They bound what we REPORT and nothing else. `conversionMs` defaults to
   * `conversionWatchBudgetMs(quote.timeEstimateSecs)`.
   */
  timeouts?: { settlementMs?: number; conversionMs?: number };
  /** The caller navigating away. Ends the watch as unconfirmed; it cancels nothing at 1Click. */
  signal?: AbortSignal;
};

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function runConversionWithdraw(
  p: RunConversionWithdrawParams
): Promise<ConversionWithdrawResult> {
  const stage = p.onStage ?? (() => {});
  const { quote } = p;
  stage("preparing");

  // C1's input, inside the click and on the same budget as the direct withdrawal. A failed or
  // slow read throws and nothing is signed.
  let heldRaw: bigint;
  try {
    heldRaw = await (p.readHeld ?? readHeldOnVerifier)(p.accountId, quote.originTokenId);
  } catch (e) {
    if (e instanceof HeldReadTimeoutError) throw e;
    throw new HeldReadFailedError(e);
  }

  // C1–C3, offline. `ConversionNotSignableError` (always `untouched`) travels to the screen as is:
  // `balance-short` and `quote-expiring` mean "re-quote", the other two mean "error".
  const request = buildConversionSignRequest({
    signerId: p.accountId,
    quote,
    heldRaw,
    nowMs: p.envelope?.nowMs,
    nonce: p.envelope?.nonce,
  });

  stage("signing");
  // A cancel in the wallet travels untouched, as in the gas purchase: nothing has moved.
  const signedData = await p.signer.signEnvelope({
    nep413: request.nep413,
    erc191Message: request.erc191Message,
  });

  // ── D-190, C4: the trace is written after the signature and before the publish. It THROWS if
  // it cannot persist, which aborts here — one discarded signature, nothing moved — rather than
  // handing the whole withdrawal to 1Click with no record of where it went.
  const recordId = recordPendingWithdraw({
    kind: "conversion",
    signerId: p.accountId,
    tokenId: quote.originTokenId,
    amount: request.amount,
    qty: p.qty,
    chainId: quote.chainId,
    destinationAddress: quote.recipient,
    nonce: nonceToBase64(request.nep413.nonce),
    deadline: request.deadlineSecs * 1000,
    conversion: {
      depositAddress: quote.depositAddress,
      deliveryTokenId: quote.deliveryTokenId,
      amountOut: quote.amountOutRaw,
      minAmountOut: quote.minAmountOutRaw,
      requestedDeadlineMs: quote.requestedDeadlineMs,
      quoteSignature: quote.signature,
    },
  }, signedData);
  p.onRecordId?.(recordId);
  stage("publishing");

  /** Past the publish, anything short of a final answer: record open, error kept, never "failed". */
  const unconfirmed = (
    e: unknown,
    fundsState: WithdrawFundsState,
    intentHash: string | null,
    txHash: string | null
  ) => {
    updateWithdrawRecord(recordId, { error: describeError(e) });
    stage("published-unconfirmed");
    return new RealWithdrawUnconfirmedError(
      describeError(e),
      fundsState,
      recordId,
      intentHash,
      txHash,
      e
    );
  };

  // ── C5: the relay, exactly as the gas purchase publishes. Empty `quote_hashes`: 1Click's quote
  // is not a relay quote, and the intent is a plain `transfer` the relay never prices.
  let response: unknown;
  try {
    response = await (p.publish ?? defaultWithdrawPublisher)({
      quote_hashes: [],
      signed_data: signedData,
    });
  } catch (e) {
    // The relay may have taken it before the connection died.
    throw unconfirmed(new WithdrawPublishUnknownError(describeError(e), e), "unknown", null, null);
  }

  let intentHash: string;
  try {
    intentHash = parsePublishResponse(response);
  } catch (e) {
    const fundsState = e instanceof WithdrawError ? e.fundsState : "unknown";
    if (fundsState === "untouched") {
      // A refusal never executes. Resolving the record keeps it off the worklist.
      updateWithdrawRecord(recordId, { status: "failed", error: describeError(e) });
      throw e;
    }
    throw unconfirmed(e, fundsState, null, null);
  }
  updateWithdrawRecord(recordId, { status: "published", intentHash });
  // Logged at the publish, not at the end: the runs where this line is worth the most are the
  // ones that never reach a final state (D-R17).
  console.log(
    `[conversion] published intent ${intentHash} — ${quote.amountInRaw} of ${quote.originTokenId} ` +
      `to ${quote.depositAddress}, for ${quote.amountOutRaw} of ${quote.deliveryTokenId} on ` +
      `${quote.chainId} (min ${quote.minAmountOutRaw})`
  );

  stage("awaiting-settlement");
  // Known before the settlement is confirmed, and worth keeping for an unconfirmed report.
  let observedTxHash: string | null = null;
  let settlement;
  try {
    settlement = await waitForWithdrawSettlement({
      intentHash,
      timeoutMs: p.timeouts?.settlementMs,
      signal: p.signal,
      waitForSettlement: p.waitForSettlement,
      onTxHash: (txHash) => {
        observedTxHash = txHash;
        updateWithdrawRecord(recordId, { txHash });
      },
    });
  } catch (e) {
    const fundsState = e instanceof WithdrawError ? e.fundsState : "unknown";
    if (fundsState === "untouched") {
      // The Verifier declared the transfer invalid: it did not execute, nothing reached 1Click.
      updateWithdrawRecord(recordId, { status: "failed", error: describeError(e) });
      throw e;
    }
    throw unconfirmed(e, fundsState, intentHash, observedTxHash);
  }
  updateWithdrawRecord(recordId, { status: "settled", txHash: settlement.txHash });

  // ── The leg 1Click owns. From here every outcome is `left-balance` or resolved.
  stage("converting");
  let outcome: ConversionOutcome;
  try {
    outcome = await (p.watchConversion ?? waitForConversionOutcome)({
      depositAddress: quote.depositAddress,
      quoteSignature: quote.signature,
      timeoutMs: p.timeouts?.conversionMs ?? conversionWatchBudgetMs(quote.timeEstimateSecs),
      signal: p.signal,
    });
  } catch (e) {
    // The default watch never throws; an injected one might. Same answer as no answer.
    throw unconfirmed(e, "left-balance", intentHash, settlement.txHash);
  }

  if (outcome.kind === "delivered") {
    const { destinationTxHash, amountOutRaw } = outcome.reading;
    updateWithdrawRecord(recordId, {
      status: "delivered",
      ...(destinationTxHash !== null && { destinationTxHash }),
      ...(amountOutRaw !== null && { deliveredAmount: amountOutRaw }),
    });
    stage("delivered");
    return {
      recordId,
      intentHash,
      txHash: settlement.txHash,
      amount: request.amount,
      outcome: { kind: "delivered", destinationTxHash, amountOutRaw: outcome.reading.amountOutRaw },
    };
  }

  if (outcome.kind === "refunded") {
    const refundedAmountRaw = outcome.reading.refundedAmountRaw;
    updateWithdrawRecord(recordId, {
      status: "refunded",
      ...(refundedAmountRaw !== null && { refundedAmount: refundedAmountRaw }),
    });
    stage("refunded");
    return {
      recordId,
      intentHash,
      txHash: settlement.txHash,
      amount: request.amount,
      outcome: { kind: "refunded", refundedAmountRaw },
    };
  }

  // FAILED, or the watch ended: the money left the balance and nobody has seen where it landed.
  const reason =
    outcome.kind === "failed"
      ? `1Click reported the conversion ${quote.depositAddress} as FAILED; not yet delivered or refunded`
      : `Conversion ${quote.depositAddress} not confirmed: ${outcome.detail}`;
  throw unconfirmed(new Error(reason), "left-balance", intentHash, settlement.txHash);
}
