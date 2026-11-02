// The signed message that hands a Converting Withdrawal to 1Click: ONE `transfer` intent of the
// held token to the quote's deposit address, nothing else (D-392, plan 020 §5.4 C1–C3; ADR-0024).
//
// Attribution: see ATTRIBUTIONS.md #13 (1Click API v0 — the deposit address this pays).
//
// The same shape and the same factory as the gas purchase (`buildGasPurchaseSignRequest`):
// `makeSwapMessage` against `intents.near`, all seven signing schemes, no vault in the loop. What
// differs is the size of the trust. The gas purchase hands 1Click five cents; this hands it the
// whole withdrawal until it delivers or refunds. So every number signed here comes from a quote
// `quoteConversion` already checked (G1–G7), and the three checks below are the ones only the
// moment of the click can make.

import { messageFactory, config } from "@defuse-protocol/internal-utils";
import type { Intent } from "@defuse-protocol/contract-types";
import { INTENTS_CONTRACT_ID } from "@/features/wallet/config/network";
import { toIntentsTokenId } from "@/features/market/lib/intents-token-id";
import { withdrawalPlan } from "./conversion-routes";
import type { ConversionQuote } from "./oneclick-conversion-quote";
import { WithdrawError } from "./withdraw-errors";

/**
 * C2: the least time a quote must still have when the user clicks. Below it the screen re-quotes
 * instead of signing. The screen refreshes every 30 s against a 10-minute deadline, so in practice
 * a click finds ~9.5 minutes left; this floor only bites on a tab left open.
 */
export const CONVERSION_MIN_QUOTE_REMAINING_SECS = 120;

/**
 * C2: how long before the quote's deadline the signed `transfer` itself expires. A transfer that
 * settles AFTER the deadline reaches a quote 1Click no longer executes — the money waits for the
 * refund instead of converting. Ending the signature first makes that ordering impossible: past
 * this point the relay refuses the intent and nothing moves.
 */
export const CONVERSION_TRANSFER_DEADLINE_MARGIN_SECS = 60;

const ZERO = BigInt(0);
const DEPOSIT_ADDRESS_RE = /^[0-9a-f]{64}$/;

/** Why a quote that passed G1–G7 still cannot be signed at the moment of the click. */
export type ConversionNotSignableReason =
  /** C1: the exact balance is below `amountIn`. Re-quote; the amount is never shrunk to fit. */
  | "balance-short"
  /** C2: less than `CONVERSION_MIN_QUOTE_REMAINING_SECS` left on the quote. Re-quote. */
  | "quote-expiring"
  /** The quote refunds to another account than the one signing — a login switched under it. */
  | "signer-mismatch"
  /** The quote is not a conversion this build would ask for. A regression, not a user state. */
  | "quote-invalid";

/**
 * Raised BEFORE anything is signed, so `fundsState` is always `untouched`: the General Balance
 * is intact and the screen's only correct response is to re-quote or explain.
 */
export class ConversionNotSignableError extends WithdrawError {
  constructor(
    readonly reason: ConversionNotSignableReason,
    message: string
  ) {
    super(message, "untouched");
    this.name = "ConversionNotSignableError";
  }
}

/**
 * A refusal the screen answers by re-pricing, not by an error (operator, s227): the quote went
 * stale (C2) or the balance no longer covers it (C1). Nothing was signed, so no "not completed"
 * toast either — that would contradict the step that is re-pricing in front of the user.
 */
export function wantsRequote(e: unknown): boolean {
  return (
    e instanceof ConversionNotSignableError &&
    (e.reason === "balance-short" || e.reason === "quote-expiring")
  );
}

export type BuildConversionParams = {
  /** The INTENTS account id doing the sending — must be the quote's `refundTo`. */
  signerId: string;
  /** EXACTLY the quote the screen displayed and the user accepted. */
  quote: ConversionQuote;
  /** The signer's exact balance of the held token, read on click (C1, D-303). */
  heldRaw: bigint;
  /** Injectable clock (ms), for C2. */
  nowMs?: number;
  /** Injectable so tests are deterministic; defaults to the SDK's random 32-byte nonce. */
  nonce?: Uint8Array;
};

export type ConversionSignRequest = {
  /** Consumed by `VaultSigner` unchanged — the shapes are identical. */
  nep413: { message: string; recipient: string; nonce: Uint8Array };
  erc191Message: string;
  /** The raw intents, for offline validation against contract-types. Exactly one `transfer`. */
  intents: Intent[];
  /** Base units LEAVING the General Balance: `quote.amountInRaw`, unchanged. */
  amount: string;
  /** Unix seconds when the signed transfer expires — before the quote does. */
  deadlineSecs: number;
};

function refuse(reason: ConversionNotSignableReason, message: string): never {
  throw new ConversionNotSignableError(reason, message);
}

/** The quote's effective deadline: the earlier of what was asked and what 1Click answered. */
export function conversionQuoteExpiresAtMs(quote: ConversionQuote): number {
  return Math.min(quote.requestedDeadlineMs, quote.quoteDeadlineMs);
}

export function buildConversionSignRequest(p: BuildConversionParams): ConversionSignRequest {
  const { quote } = p;

  // Re-asked of the delivery table rather than trusted from the object: a `ConversionQuote` is
  // a plain value, and one built by hand for a pair the table does not name must not sign.
  const plan = withdrawalPlan(quote.originTokenId, quote.chainId);
  if (
    plan.kind !== "conversion" ||
    plan.deliveryTokenId !== quote.deliveryTokenId ||
    plan.destinationAsset !== quote.destinationAsset
  ) {
    refuse(
      "quote-invalid",
      `No conversion from ${quote.originTokenId} to ${quote.chainId} delivers ${quote.deliveryTokenId}`
    );
  }
  if (!/^\d+$/.test(quote.amountInRaw) || BigInt(quote.amountInRaw) <= ZERO) {
    refuse("quote-invalid", `Conversion would transfer ${quote.amountInRaw} base units`);
  }
  if (!DEPOSIT_ADDRESS_RE.test(quote.depositAddress) || quote.depositAddress === p.signerId) {
    refuse("quote-invalid", `Deposit address ${quote.depositAddress} is not one 1Click hands out`);
  }

  // 🔴 The refund address was fixed when the quote was requested. Signing it from another account
  // would move THIS account's money into a quote whose refund goes to someone else.
  if (quote.refundTo !== p.signerId) {
    refuse("signer-mismatch", `Quote refunds to ${quote.refundTo}, but ${p.signerId} is signing`);
  }

  // ── C1: the exact balance covers the whole amount. Never shrunk: a transfer below `amountIn`
  // is an incomplete deposit, which 1Click does not convert — it sits until the refund deadline.
  const amountIn = BigInt(quote.amountInRaw);
  if (p.heldRaw < amountIn) {
    refuse("balance-short", `Balance ${p.heldRaw} is below the quoted ${quote.amountInRaw}`);
  }

  // ── C2: enough life left, and a signature that dies first.
  const nowMs = p.nowMs ?? Date.now();
  const expiresAtMs = conversionQuoteExpiresAtMs(quote);
  const remainingMs = expiresAtMs - nowMs;
  if (!Number.isFinite(remainingMs) || remainingMs < CONVERSION_MIN_QUOTE_REMAINING_SECS * 1000) {
    // `toISOString` throws on NaN, which would trade this typed refusal for a bare RangeError.
    const when = Number.isFinite(expiresAtMs) ? new Date(expiresAtMs).toISOString() : "an unreadable time";
    refuse("quote-expiring", `Quote expires at ${when}; re-quote`);
  }
  const deadlineSecs = Math.floor(expiresAtMs / 1000) - CONVERSION_TRANSFER_DEADLINE_MARGIN_SECS;

  // `makeSwapMessage` stamps `config.env.contractID` as both recipient and verifying_contract.
  // Checked, not trusted, exactly as the withdrawal envelope does.
  if (config.env.contractID !== INTENTS_CONTRACT_ID) {
    throw new Error(
      `SDK is configured for "${config.env.contractID}" but conversions must address ` +
        INTENTS_CONTRACT_ID
    );
  }

  // ── C3: one `transfer`, the whole quoted amount, to the deposit address. No memo — the deposit
  // address alone identifies the quote (G1 refused any other deposit mode).
  const intents: Intent[] = [
    {
      intent: "transfer",
      receiver_id: quote.depositAddress,
      tokens: { [toIntentsTokenId(quote.originTokenId)]: quote.amountInRaw },
    } as Intent,
  ];

  const message = messageFactory.makeSwapMessage({
    innerMessage: {
      signer_id: p.signerId,
      deadline: new Date(deadlineSecs * 1000).toISOString(),
      intents,
    },
    nonce: p.nonce,
  });

  return {
    nep413: {
      message: message.NEP413.message,
      recipient: message.NEP413.recipient,
      nonce: message.NEP413.nonce,
    },
    erc191Message: message.ERC191.message,
    intents,
    amount: quote.amountInRaw,
    deadlineSecs,
  };
}
