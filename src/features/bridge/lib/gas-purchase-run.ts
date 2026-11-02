// Orchestrates the gas purchase, end to end (008.plan §Fase 4, D-251, piece D).
//
//   guard → sign → publish → settle
//
// Attribution: see ATTRIBUTIONS.md #10 (relay publish-failure parsing, reused via
// `parsePublishResponse`) and #13 (1Click, whose quote this spends).
//
// 🔴 ONE OF THE TWO PATHS IN THE APP THAT SEND MONEY TO A THIRD PARTY.
// Everything else signs `mt_withdraw`/`ft_withdraw` intents that pay an address the user
// typed, or vault calls that pay the user's own portfolios. This one signs a `transfer` to
// 1Click's deposit account and trusts them to send the gas back. D-253 accepted that trade
// for ~$0.05 and refused it for the whole withdrawal, so the guards below exist to keep the
// amount at ~$0.05: they are not ceremony, they are the entire reason the trade was
// acceptable. The other path is a Converting Withdrawal (run-conversion-withdraw.ts), where
// D-253 was revised for that case only (ADR-0024) and the whole amount goes by design, under
// its own guards; nothing here relaxes because of it.
//
// WHAT IT DELIBERATELY DOES NOT DO
//   - It does not wait for the gas to arrive. The transfer settling means 1Click HAS the
//     input; delivery is theirs to do, and the only honest observation of it is the signer's
//     own balance going up (gas-purchase.ts). The caller watches that.
//   - It writes no rescue record. A withdrawal gets one because an orphan is worth someone's
//     whole balance (D-190); an orphaned gas purchase is worth five cents and 1Click's
//     `refundTo` points at the buyer's own account. The intent hash goes to the console for
//     the same reason the withdrawal's does (D-R17), and that is the whole trace.

import type { VaultSigner } from "@/features/vault/lib/vault-signer";
import { buildGasPurchaseSignRequest, type GasPurchaseQuote } from "./gas-purchase";
import { parsePublishResponse, PUBLISH_REQUEST_CONFIG, type WithdrawPublisher } from "./withdraw-submit";
import { waitForWithdrawSettlement, type SettlementWaiter } from "./withdraw-poll";
import { WithdrawError, type WithdrawFundsState } from "./withdraw-errors";
import { solverRelay } from "@defuse-protocol/internal-utils";

const ZERO = BigInt(0);

export type GasPurchaseStage =
  | "signing"
  | "publishing"
  | "awaiting-settlement"
  /** The input is with 1Click. What comes back, and when, is observed off the balance. */
  | "bought"
  /** Published, possibly settled, not observed. NOT a failure — see the class below. */
  | "published-unconfirmed";

export type GasPurchaseResult = {
  intentHash: string;
  txHash: string;
  /** Base units of the withdrawn token that left the balance. */
  amountInRaw: string;
  /** Base units of gas 1Click owes. */
  amountOutRaw: string;
};

/**
 * A gas purchase that did not reach a state worth calling done.
 *
 * Carries `fundsState` for the same reason every withdrawal error does (withdraw-errors.ts):
 * the class says what broke, `fundsState` says where the money is, and only the second may
 * drive what the user is told. Its own class rather than the `Withdraw*` ones because those
 * spell "withdrawal" into every message, and telling someone their WITHDRAWAL failed when
 * what failed was a five-cent gas purchase is a worse error than saying nothing.
 */
export class GasPurchaseError extends WithdrawError {
  constructor(message: string, fundsState: WithdrawFundsState, cause?: unknown) {
    super(message, fundsState, cause);
    this.name = "GasPurchaseError";
  }
}

export type RunGasPurchaseParams = {
  /** The INTENTS account id doing the buying — the signer, the refund address, the recipient. */
  signerId: string;
  /** EXACTLY the quote the screen displayed and the user accepted. */
  quote: GasPurchaseQuote;
  /** Base units the withdrawal itself will move. The purchase must not eat into it. */
  withdrawalAmountRaw: string;
  /**
   * 🔴 The price ceiling, in base units of the token being sold, and the guard that keeps this
   * a five-cent trade.
   *
   * Required, and stated by the CALLER rather than derived here, because pricing it needs USD
   * rates this module has no business fetching. The screen already has them: it renders the
   * cost in dollars next to the button, so it can say what an absurd version of that number
   * would be. Without a ceiling the only bound on `amountIn` is "less than the withdrawal" —
   * which would happily sign away 4.99 of a 5 USDT withdrawal to buy four cents of gas.
   */
  maxAmountInRaw: string;
  signer: VaultSigner;
  onStage?: (stage: GasPurchaseStage) => void;
  /** Network seams, all injectable — no test here may reach the network. */
  publish?: WithdrawPublisher;
  waitForSettlement?: SettlementWaiter;
  /** Bounds what we REPORT about the settlement, never what the relay does. */
  settlementTimeoutMs?: number;
  signal?: AbortSignal;
  /** Envelope tuning; injectable so tests are deterministic. */
  envelope?: { deadlineSecs?: number; nonce?: Uint8Array };
};

const defaultPublisher: WithdrawPublisher = (params) =>
  solverRelay.httpClient.publishIntent(params, PUBLISH_REQUEST_CONFIG);

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A base-unit integer. Anything else is not arithmetic that may reach a signed intent. */
function isBaseUnitString(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

/**
 * Everything that can be checked before a wallet is asked for anything.
 *
 * All of it fires while the balance is still intact, which is what makes each of these a
 * refusal rather than a loss. `buildGasPurchaseSignRequest` re-checks the amount against the
 * withdrawal itself; this adds the two things it cannot know — the ceiling, and that the
 * quote is about the pair the caller thinks it is.
 */
function assertQuoteIsWorthSigning(p: RunGasPurchaseParams): void {
  const q = p.quote;
  if (!isBaseUnitString(q.amountInRaw) || BigInt(q.amountInRaw) <= ZERO) {
    throw new GasPurchaseError(
      `The gas purchase quote asks for ${q.amountInRaw} base units, which is not an amount`,
      "untouched"
    );
  }
  if (!isBaseUnitString(p.maxAmountInRaw) || BigInt(p.maxAmountInRaw) <= ZERO) {
    throw new GasPurchaseError(
      `A gas purchase needs a price ceiling to be checked against; got ${p.maxAmountInRaw}`,
      "untouched"
    );
  }
  // 🔴 The one guard that keeps this a five-cent trade. Measured 2026-08-10: 0.053907 USDT
  // bought 0.04 GRAM, against a market value of ~0.0536 — a spread of well under 1%. A quote
  // several times that is not a bad price, it is a different transaction.
  if (BigInt(q.amountInRaw) > BigInt(p.maxAmountInRaw)) {
    throw new GasPurchaseError(
      `The gas purchase would cost ${q.amountInRaw} base units, over the ${p.maxAmountInRaw} ` +
        `ceiling for this trade — not signing`,
      "untouched"
    );
  }
  if (!q.depositAddress) {
    throw new GasPurchaseError(
      `The gas purchase quote names no deposit address, so the transfer has no destination`,
      "untouched"
    );
  }
}

/**
 * Buys the destination chain's gas with the token being withdrawn, and returns once the
 * transfer has SETTLED — not once the gas has arrived.
 *
 * The ordering rule is the withdrawal's (run-real-withdraw.ts) and it is the same rule for the
 * same reason: only `fundsState === "untouched"` may be reported as a plain failure. After the
 * publish, "it did not work" is a claim nobody is in a position to make — the relay may have
 * taken the intent before the connection died, and the input may be with 1Click already.
 */
export async function runGasPurchase(p: RunGasPurchaseParams): Promise<GasPurchaseResult> {
  const stage = p.onStage ?? (() => {});

  // Offline, before a wallet is asked: the ceiling, the pair, and — inside the builder — that
  // the purchase does not consume the withdrawal it is meant to enable.
  assertQuoteIsWorthSigning(p);
  let request;
  try {
    request = buildGasPurchaseSignRequest({
      signerId: p.signerId,
      quote: p.quote,
      withdrawalAmountRaw: p.withdrawalAmountRaw,
      ...p.envelope,
    });
  } catch (e) {
    throw new GasPurchaseError(describeError(e), "untouched", e);
  }

  stage("signing");
  // Signing errors travel untouched: a user cancelling in their wallet is a wallet error, and
  // the screen shows the error's own words. Wrapping a cancel would make it read like a
  // protocol failure — and nothing has moved either way.
  const signedData = await p.signer.signEnvelope({
    nep413: request.nep413,
    erc191Message: request.erc191Message,
  });

  stage("publishing");
  let response: unknown;
  try {
    // Empty `quote_hashes`, and this is the one place in the app where that is worth stating:
    // 1Click's quote is NOT a solver-relay quote. The relay never prices this intent — it is a
    // plain `transfer`, not a swap — so there is no hash for it to honour. D-147's rule holds
    // here by having nothing to name, not by omission.
    response = await publishWith(p, { quote_hashes: [], signed_data: signedData });
  } catch (e) {
    // Ambiguous on purpose: the relay may have taken it before the connection died.
    stage("published-unconfirmed");
    throw new GasPurchaseError(
      `Could not confirm whether the ${p.quote.nativeAssetId} purchase was published: ` +
        `${describeError(e)}. Check your balance before trying again.`,
      "unknown",
      e
    );
  }

  let intentHash: string;
  try {
    intentHash = parsePublishResponse(response);
  } catch (e) {
    // `parsePublishResponse` throws the withdrawal classes, which already fix `fundsState`
    // correctly for each case — a rejection is `untouched`, an unreadable answer is `unknown`.
    // Consumed rather than re-derived, exactly as run-real-withdraw.ts consumes them; only
    // the wording is ours, because theirs says "withdrawal".
    const fundsState = e instanceof WithdrawError ? e.fundsState : "unknown";
    if (fundsState !== "untouched") stage("published-unconfirmed");
    throw new GasPurchaseError(
      fundsState === "untouched"
        ? `The relay refused the gas purchase: ${describeError(e)}. Nothing left your balance.`
        : `${describeError(e)} Check your balance before trying again.`,
      fundsState,
      e
    );
  }
  // Logged at the publish and not at the end: the runs where this hash is worth the most are
  // the ones that never reach a final state (D-R17).
  console.log(
    `[gas-purchase] published intent ${intentHash} — ${p.quote.amountInRaw} of ` +
      `${p.quote.tokenId} to ${p.quote.depositAddress} for ${p.quote.amountOutRaw} of ` +
      `${p.quote.nativeAssetId}`
  );

  stage("awaiting-settlement");
  let settlement;
  try {
    settlement = await waitForWithdrawSettlement({
      intentHash,
      timeoutMs: p.settlementTimeoutMs,
      signal: p.signal,
      waitForSettlement: p.waitForSettlement,
    });
  } catch (e) {
    const fundsState = e instanceof WithdrawError ? e.fundsState : "unknown";
    if (fundsState === "untouched") {
      // The Verifier declared the intent invalid: it did not execute, so nothing was spent
      // and the same quote can be signed again while it lasts.
      throw new GasPurchaseError(
        `The gas purchase did not settle: ${describeError(e)}. Nothing left your balance.`,
        "untouched",
        e
      );
    }
    stage("published-unconfirmed");
    throw new GasPurchaseError(
      `The gas purchase ${intentHash} was published but not confirmed: ${describeError(e)}. ` +
        `It may still complete — check your balance before trying again.`,
      fundsState,
      e
    );
  }

  stage("bought");
  return {
    intentHash,
    txHash: settlement.txHash,
    amountInRaw: p.quote.amountInRaw,
    amountOutRaw: p.quote.amountOutRaw,
  };
}

function publishWith(
  p: RunGasPurchaseParams,
  params: Parameters<WithdrawPublisher>[0]
): Promise<unknown> {
  return (p.publish ?? defaultPublisher)(params);
}
