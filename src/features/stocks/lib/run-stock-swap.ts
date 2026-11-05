// Runs one stock swap end to end (plan 039):
//
//   read balance → build the transfer → sign → publish → settle → watch 1Click
//
// The same discipline as `runConversionWithdraw`, without its rescue record: 1Click's `refundTo` is the
// signer's own account, and a swap that stays unconfirmed is read from that balance.
//
// 🔴 PAST THE PUBLISH, "IT FAILED" IS A CLAIM NOBODY CAN MAKE. The relay may have taken the intent
// before the connection died, and the input may be with 1Click already. So only a refusal that
// proves nothing moved is thrown; everything else comes back as `unconfirmed`, with the hashes.
//
// Attribution: see ATTRIBUTIONS.md #10 (relay publish parsing and settlement, reused unchanged) and
// #13 (1Click `/v0/status`).

import { conversionWatchBudgetMs, waitForConversionOutcome, type OneClickStatus } from "@/features/bridge/lib/oneclick-status";
import { readHeldOnVerifier } from "@/features/bridge/lib/run-real-withdraw";
import { WithdrawError, WithdrawRelayRejectedError } from "@/features/bridge/lib/withdraw-errors";
import { waitForWithdrawSettlement, type SettlementWaiter } from "@/features/bridge/lib/withdraw-poll";
import { defaultWithdrawPublisher, parsePublishResponse, type WithdrawPublisher } from "@/features/bridge/lib/withdraw-submit";
import type { VaultSigner } from "@/features/vault/lib/vault-signer";
import { buildStockSwapSignRequest, type StockSwapQuote } from "./stock-swap";

export type StockSwapStage = "preparing" | "signing" | "publishing" | "awaiting-settlement" | "converting";

export type StockSwapResult =
  | { kind: "delivered"; intentHash: string; txHash: string; amountOutRaw: string | null }
  | { kind: "refunded"; intentHash: string; txHash: string; refundedAmountRaw: string | null }
  /** The input may have left the balance and nobody has seen where it landed. Not a failure. */
  | { kind: "unconfirmed"; detail: string; intentHash: string | null; txHash: string | null; depositAddress: string };

export type RunStockSwapParams = {
  accountId: string;
  /** EXACTLY the quote the screen displayed and the user accepted. */
  quote: StockSwapQuote;
  signer: VaultSigner;
  onStage?: (stage: StockSwapStage) => void;
  onStatus?: (status: OneClickStatus) => void;
  signal?: AbortSignal;
  /** Network seams: no test may reach the network. */
  readHeld?: typeof readHeldOnVerifier;
  publish?: WithdrawPublisher;
  waitForSettlement?: SettlementWaiter;
  watchSwap?: typeof waitForConversionOutcome;
  envelope?: { nowMs?: number; nonce?: Uint8Array };
};

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function provesNothingMoved(e: unknown): boolean {
  // A reason the parser does not recognise is an opaque string, not evidence of a refusal
  // (`withdraw-submit.ts`, NOT_PROOF_OF_REFUSAL). The shared parser stays as it is: past this point
  // a wrong "it never moved" tells someone with no rescue record that their money is still there.
  if (e instanceof WithdrawRelayRejectedError && e.code === "UNKNOWN_ERROR") return false;
  return e instanceof WithdrawError && e.fundsState === "untouched";
}

export async function runStockSwap(p: RunStockSwapParams): Promise<StockSwapResult> {
  const stage = p.onStage ?? (() => {});
  const { quote } = p;
  const { depositAddress } = quote;

  stage("preparing");
  // A failed or slow read throws, and nothing is signed.
  const heldRaw = await (p.readHeld ?? readHeldOnVerifier)(p.accountId, quote.originAsset);
  const request = buildStockSwapSignRequest({
    signerId: p.accountId,
    quote,
    heldRaw,
    nowMs: p.envelope?.nowMs,
    nonce: p.envelope?.nonce,
  });

  stage("signing");
  // A cancel in the wallet travels as it is: nothing has moved.
  const signedData = await p.signer.signEnvelope({ nep413: request.nep413, erc191Message: request.erc191Message });

  stage("publishing");
  let intentHash: string;
  try {
    // Empty `quote_hashes`: 1Click's quote is not a relay quote, and this is a plain `transfer`.
    intentHash = parsePublishResponse(
      await (p.publish ?? defaultWithdrawPublisher)({ quote_hashes: [], signed_data: signedData })
    );
  } catch (e) {
    if (provesNothingMoved(e)) throw e;
    return { kind: "unconfirmed", detail: describeError(e), intentHash: null, txHash: null, depositAddress };
  }
  console.log(
    `[stocks] published intent ${intentHash} — ${quote.amountInRaw} of ${quote.originAsset} to ` +
      `${quote.depositAddress}, for ${quote.amountOutRaw} of ${quote.destinationAsset} (min ${quote.minAmountOutRaw})`
  );

  stage("awaiting-settlement");
  let txHash: string;
  let observedTxHash: string | null = null;
  try {
    const settlement = await waitForWithdrawSettlement({
      intentHash,
      signal: p.signal,
      waitForSettlement: p.waitForSettlement,
      onTxHash: (hash) => {
        observedTxHash = hash;
      },
    });
    txHash = settlement.txHash;
  } catch (e) {
    if (provesNothingMoved(e)) throw e;
    return { kind: "unconfirmed", detail: describeError(e), intentHash, txHash: observedTxHash, depositAddress };
  }

  // The leg 1Click owns. From here the input has left the balance.
  stage("converting");
  try {
    const outcome = await (p.watchSwap ?? waitForConversionOutcome)({
      depositAddress: quote.depositAddress,
      quoteSignature: quote.signature,
      timeoutMs: conversionWatchBudgetMs(quote.timeEstimateSecs),
      signal: p.signal,
      onReading: (reading) => p.onStatus?.(reading.status),
    });
    if (outcome.kind === "delivered") {
      return { kind: "delivered", intentHash, txHash, amountOutRaw: outcome.reading.amountOutRaw };
    }
    if (outcome.kind === "refunded") {
      return { kind: "refunded", intentHash, txHash, refundedAmountRaw: outcome.reading.refundedAmountRaw };
    }
    const detail = outcome.kind === "failed" ? "1Click informó FAILED" : outcome.detail;
    return { kind: "unconfirmed", detail, intentHash, txHash, depositAddress };
  } catch (e) {
    return { kind: "unconfirmed", detail: describeError(e), intentHash, txHash, depositAddress };
  }
}
