// Prices a Converting Withdrawal with 1Click, and refuses every answer it cannot vouch for
// (D-392, plan 020 §5.4 G1–G7; ADR-0024).
//
// Attribution: see ATTRIBUTIONS.md #13 (1Click API v0 `/v0/quote`).
//
// 🔴 WHAT A QUOTE COMMITS. The user will sign a `transfer` of `amountIn` to `depositAddress`
// (conversion-envelope.ts). Once that settles the money sits in 1Click's account until 1Click
// delivers it — to the recipient and as the asset WRITTEN IN THE QUOTE REQUEST — or refunds it to
// `refundTo`. So the request is the contract, and the response is only trusted where it repeats
// it: every field sent must come back identical in `quoteRequest` (G1), and anything that does not
// is a quote about somebody else's trade. Nothing here returns a partial quote; every refusal is
// "not available right now" on screen and nothing is signed.
//
// WHAT WAS MEASURED (2026-10-06, s225, `scripts/measure-conversion-quotes.py --all`): 89 routes,
// every one echoing all twelve fields verbatim — a checksummed EVM recipient keeps its case.
// `minAmountOut` is `amountOut` less exactly the slippage; `withdrawFee` is in the Delivery Token's
// units and already deducted from `amountOut`; Conversion Cost 0–5 bps (USDC/USDT on Aptos ~21).
//
// ⚠️ ONE FIELD IN THE ECHO WAS NOT SENT: `quoteRequest.appFees`, 1Click's own fee on a keyless
// call (recipient `5880ad2b…`, in bps). Measured: 1 on 114 of 122 quotes, 20 on the five Aptos-USDC
// routes — which is their ~21 bps — and none on nBTC → Bitcoin. It is not compared like the rest:
// it is already inside `amountOut`, and G5 bounds the amounts whatever the fee line says. Reading
// it as a list to approve would make every new fee schedule an outage instead of a cost (D-424).

import { getTokenById } from "@/features/market/lib/token-registry";
import {
  INTENTS_CONTRACT_ID,
  RETIRED_VAULT_CONTRACT_IDS,
  VAULT_CONTRACT_ID,
} from "@/features/wallet/config/network";
import { validateAddress } from "./address-validation";
import { withdrawalPlan } from "./conversion-routes";
import { ONE_CLICK_BASE_URL } from "./oneclick-base-url";
import {
  getWithdrawalEntry,
  NEAR_DESTINATION_CHAIN_ID,
  unreceivableNearDestination,
} from "./withdrawal-registry";

/**
 * Basis points of slippage the quote may absorb (plan 020 §9.2). `minAmountOut` lands exactly this
 * far below `amountOut`, so it is the user's worst case beyond the measured cost — 50 bps against
 * a Conversion Cost measured at 0–5 bps on same-family routes.
 */
export const CONVERSION_SLIPPAGE_BPS = 50;

/**
 * 🔴 G5: the most a quote may lose between `amountIn` and `minAmountOut`, Network Fee excluded,
 * in basis points of `amountIn`. Slippage (50) + 50 of margin.
 *
 * The margin is sized to what the price can honestly include: the worst route measured (USDC on
 * Aptos, ~21 bps, 20 of them 1Click's own `appFees`) and the 25 bps 1Click documents for callers
 * without a partner key (D-424) — today 1 bp on the routes it treats as same-asset, but it could
 * charge that 20-25 on any of them tomorrow. Past 1% a same-family conversion is not a
 * conversion any more, it is a loss — and no USD price is needed to say so, because both sides are
 * the same asset (only the decimals differ, which `normalizedLoss` handles).
 */
export const CONVERSION_LOSS_CEILING_BPS = 100;

/** How long the quote asks to stay open. near.com uses the same 10 minutes. */
export const CONVERSION_QUOTE_DEADLINE_SECS = 600;

/** G5's Network Fee ceiling off NEAR: this many times the registry's fee for the Delivery Token. */
const NETWORK_FEE_CEILING_MULTIPLE = BigInt(2);

/**
 * 🔴 G5's Network Fee ceiling TO NEAR, per Delivery Token, in its base units.
 *
 * Plan 020 §5.4 said "0 toward NEAR". The measurement says otherwise: a NEAR account not yet
 * registered on the Delivery Token costs 1Click a storage deposit (0.00125 NEAR on nBTC, USDT and
 * USDC; `eth.bridge.near` registers for free), and 1Click passes it on as `withdrawFee` — 8 sats
 * on nBTC, 6693 base units (≈ US$0.0067) on USDT(NEAR) and USDC(NEAR), measured 2026-10-06. A
 * ceiling of zero would refuse exactly the unregistered-account case plan 020 §6 must deliver.
 *
 * Each ceiling is ~US$0.10 at that day's prices (ETH ≈ US$2,700, BTC ≈ US$86,000), 12–15× the
 * fee measured, so it stops an absurd charge without tracking the NEAR price. ⚠️ It IS a price
 * assumption, of the same kind as the registry's `withdrawalFeeRaw`: if NEAR rose ~12× against
 * BTC, conversions to UNREGISTERED NEAR accounts would start failing closed ("not available right
 * now", nothing signed) — that is the signal to revisit these four numbers.
 */
export const NEAR_DELIVERY_FEE_CEILING_RAW: Readonly<Record<string, string>> = {
  "nep141:eth.bridge.near": "40000000000000", // 0.00004 ETH — measured 0 (free registration)
  "nep141:nbtc.bridge.near": "100", // 100 sats — measured 8
  // 0.10 USDC — measured 6692
  "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1": "100000",
  "nep141:usdt.tether-token.near": "100000", // 0.10 USDT — measured 6693
};

/**
 * 🔴 G5's Network Fee ceiling when the delivery must first open the recipient's token account
 * (D-441). Only Solana's SPL tokens, keyed by Delivery Token.
 *
 * On Solana a token balance lives in its own account per (wallet, token), and a wallet that never
 * held USDC has none. The first delivery opens it and leaves its rent deposit there — a fixed
 * amount in SOL for a 165-byte account: 1 488 440 lamports, `getMinimumBalanceForRentExemption(165)`
 * on mainnet 2026-10-07, and the exact balance the real delivery of s231 left in the account it
 * opened (the long-quoted 2 039 280 is the value before Solana lowered rent). 1Click passes it on as
 * `withdrawFee`. Measured 2026-10-07 (s231), 2 USDC/USDT from NEAR, SOL at US$116.31 on 1Click's
 * own `/v0/tokens`: with the account 10149 / 10151, without it 313664 / 313726. The difference
 * (≈ 0.3035) is ~1.75× the rent at that price (0.1731): 1Click charges well over the bare rent.
 * ⚠️ Solana can change rent again; if it does, this constant is what to update. The regular ceiling (2× the registry's 30000) refuses the second one, and refusing it means
 * a fresh Solana wallet can never receive by this route.
 *
 * So the ceiling follows the SOL price instead of assuming one (operator, s231): the regular
 * ceiling plus `TOKEN_ACCOUNT_RENT_MARGIN` × the rent at the LIVE SOL price, in the Delivery
 * Token at its live price. Past it, 1Click is charging well over what opening the account costs,
 * and the quote is plain "unavailable" — there is nothing true and specific to tell the user.
 * Without a live price for either token (the registry's `fallbackUsdPrice` is not one), the
 * fixed `fallbackCeilingRaw` applies, which assumes SOL up to ≈ US$200.
 *
 * It is also what stops a misbehaving 1Click from passing any fee off as an account opening:
 * `TOKEN_ACCOUNT_MAX_FEE_SHARE_BPS` alone would let half of a large withdrawal through.
 */
const SOL_ID = "nep141:sol.omft.near";
const SPL_TOKEN_ACCOUNT_RENT_LAMPORTS = 1_488_440;
export const TOKEN_ACCOUNT_OPENING: Readonly<
  Record<string, { nativeTokenId: string; rentRaw: number; nativeDecimals: number; fallbackCeilingRaw: string }>
> = {
  // USDC (SOL)
  "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near": {
    nativeTokenId: SOL_ID, rentRaw: SPL_TOKEN_ACCOUNT_RENT_LAMPORTS, nativeDecimals: 9, fallbackCeilingRaw: "600000",
  },
  // USDT (SOL)
  "nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near": {
    nativeTokenId: SOL_ID, rentRaw: SPL_TOKEN_ACCOUNT_RENT_LAMPORTS, nativeDecimals: 9, fallbackCeilingRaw: "600000",
  },
};

/** How many times the bare rent the account allowance holds. Measured: 1Click charges ~1.75×. */
export const TOKEN_ACCOUNT_RENT_MARGIN = 3;

/**
 * The account-opening ceiling for a Delivery Token, in its base units, or `undefined` when its
 * chain has no accounts to open. `regular` is the ceiling without one.
 */
export function tokenAccountFeeCeiling(
  deliveryTokenId: string,
  deliveryDecimals: number,
  regular: bigint,
  liveUsdPrice?: (tokenId: string) => number | null
): bigint | undefined {
  const opening = TOKEN_ACCOUNT_OPENING[deliveryTokenId];
  if (!opening) return undefined;
  const nativeUsd = liveUsdPrice?.(opening.nativeTokenId) ?? null;
  const deliveryUsd = liveUsdPrice?.(deliveryTokenId) ?? null;
  if (!nativeUsd || !deliveryUsd || !(nativeUsd > 0) || !(deliveryUsd > 0)) {
    return BigInt(opening.fallbackCeilingRaw);
  }
  const rentInDelivery =
    (opening.rentRaw / 10 ** opening.nativeDecimals) * nativeUsd * TOKEN_ACCOUNT_RENT_MARGIN / deliveryUsd;
  if (!Number.isFinite(rentInDelivery)) return BigInt(opening.fallbackCeilingRaw);
  return regular + BigInt(Math.ceil(rentInDelivery * 10 ** deliveryDecimals));
}

/**
 * 🔴 The most of `amountIn` a token-account-opening Network Fee may take, in basis points (D-441,
 * cross-review s231). `normalizedLoss` leaves the fee out and the account ceiling is absolute, so
 * without this a 0.32 USDC withdrawal to a fresh Solana wallet would pass and deliver ~0.006.
 * A ratio, so it does not move with the SOL price; the minimum it asks for comes from the live fee.
 */
export const TOKEN_ACCOUNT_MAX_FEE_SHARE_BPS = 5_000;

const ZERO = BigInt(0);
const BPS = BigInt(10_000);

/** A base-unit integer. Anything else is not arithmetic that may reach a signed intent. */
function isBaseUnitString(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

/** The intents account 1Click hands out per quote: an implicit account, 64 lowercase hex. */
const DEPOSIT_ADDRESS_RE = /^[0-9a-f]{64}$/;

export type ConversionQuote = {
  originTokenId: string;
  deliveryTokenId: string;
  chainId: string;
  /** What the request asked 1Click to deliver: the Delivery Token, or the pair's override. */
  destinationAsset: string;
  recipient: string;
  /** The signer's intents account: where 1Click refunds a conversion it cannot complete. */
  refundTo: string;
  /** The intents account the signed `transfer` pays. One per quote. */
  depositAddress: string;
  /** Base units of the held token that leave the General Balance. Equals the amount asked. */
  amountInRaw: string;
  /** Base units of the Delivery Token expected to arrive, already net of `withdrawFeeRaw`. */
  amountOutRaw: string;
  /** The least that may arrive — the figure the screen states as guaranteed. */
  minAmountOutRaw: string;
  /** The Network Fee, in the Delivery Token's base units. `0` toward a registered NEAR account. */
  withdrawFeeRaw: string;
  /**
   * The Network Fee includes opening the recipient's token account on the destination chain — a
   * one-time cost the screen names (D-441). Read from the fee's size: above the regular ceiling,
   * within `tokenAccountFeeCeiling`.
   */
  createsTokenAccount: boolean;
  /** What a refund would keep, in the held token's base units. Measured `0`. */
  refundFeeRaw: string;
  slippageBps: number;
  /** The deadline the request asked for (ms). The signed transfer must expire before it (C2). */
  requestedDeadlineMs: number;
  /** The deadline the response states (ms) — measured at the request + 3 days (plan 020 §9.1). */
  quoteDeadlineMs: number;
  /** 1Click's estimate of the delivery time, display only; `null` when absent. */
  timeEstimateSecs: number | null;
  /** 1Click's ed25519 signature over the quote — kept in the rescue record as proof (G7). */
  signature: string;
  /** When the quote was requested (ms), for the screen's 30 s refresh. */
  quotedAtMs: number;
};

export type ConversionQuoteResult =
  | { ok: true; quote: ConversionQuote }
  /**
   * 1Click answered "try at least N": below the destination bridge's floor. `minAmountRaw` is in
   * the HELD token's base units — measured with an 18-decimal origin (USDT on BSC → Tron), where N
   * came back at 18 decimals.
   */
  | { ok: false; reason: "below-minimum"; minAmountRaw: string }
  /**
   * The recipient's token account can be opened, but its fee would take more than
   * `TOKEN_ACCOUNT_MAX_FEE_SHARE_BPS` of the amount. `minAmountRaw` is in the HELD token's base
   * units (the least that keeps the fee within the share); `feeRaw` in the Delivery Token's.
   */
  | { ok: false; reason: "token-account-below-minimum"; minAmountRaw: string; feeRaw: string }
  /** Anything else. `detail` names the refusal for the console; the screen shows one message. */
  | { ok: false; reason: "unavailable"; detail: string };

export type ConversionQuoteDeps = {
  /** Injected so no test reaches the network. */
  fetchImpl?: typeof fetch;
  /** Injectable clock, for the deadline the request carries. */
  now?: () => number;
};

export type QuoteConversionParams = {
  /** Full defuse asset id of the token the user holds — what is sent. */
  originTokenId: string;
  /** Destination chain. Together with the held token it fixes the Delivery Token (G6). */
  chainId: string;
  /** Exact base units to send — `EXACT_INPUT`, so this is what leaves the balance. */
  amountRaw: string;
  /** The destination address on `chainId`. */
  recipient: string;
  /** The signer's intents account. Never defaulted: it is the only way back for a failed fill. */
  refundTo: string;
  /**
   * A token's LIVE USD price, or `null` — never the registry's fallback. Sizes the ceiling for
   * opening a recipient's token account (`tokenAccountFeeCeiling`); absent, the fixed one applies.
   */
  liveUsdPrice?: (tokenId: string) => number | null;
  signal?: AbortSignal;
  deps?: ConversionQuoteDeps;
};

const unavailable = (detail: string): ConversionQuoteResult => ({
  ok: false,
  reason: "unavailable",
  detail,
});

/**
 * `amountIn − minAmountOut − withdrawFee`, with both sides scaled to the larger of the two decimals
 * so 6/7/8/18-decimal members of one family compare as the same asset. Returned with the scaled
 * `amountIn` it is a fraction of. Negative when more arrives than was sent.
 */
export function normalizedLoss(p: {
  amountInRaw: string;
  inDecimals: number;
  outRaw: string;
  withdrawFeeRaw: string;
  outDecimals: number;
}): { loss: bigint; of: bigint } {
  const top = Math.max(p.inDecimals, p.outDecimals);
  const scaleIn = BigInt(10) ** BigInt(top - p.inDecimals);
  const scaleOut = BigInt(10) ** BigInt(top - p.outDecimals);
  const of = BigInt(p.amountInRaw) * scaleIn;
  const loss = of - (BigInt(p.outRaw) + BigInt(p.withdrawFeeRaw)) * scaleOut;
  return { loss, of };
}

/**
 * The Conversion Cost of a quote in basis points (CONTEXT.md "Conversion Cost"): what is lost
 * between `amountIn` and the expected `amountOut`, the Network Fee excluded. For display; G5 bounds
 * the worse figure, `minAmountOut`. Floored at 0 — a route that pays the user is not a cost.
 */
export function conversionCostBps(quote: ConversionQuote): number {
  const inDecimals = getTokenById(quote.originTokenId)?.decimals;
  const outDecimals = getTokenById(quote.deliveryTokenId)?.decimals;
  if (inDecimals === undefined || outDecimals === undefined) return Number.NaN;
  const { loss, of } = normalizedLoss({
    amountInRaw: quote.amountInRaw,
    inDecimals,
    outRaw: quote.amountOutRaw,
    withdrawFeeRaw: quote.withdrawFeeRaw,
    outDecimals,
  });
  if (loss <= ZERO || of === ZERO) return 0;
  // Hundredths of a basis point, then back: enough resolution for "~0.02 %" on screen.
  return Number((loss * BPS * BigInt(100)) / of) / 100;
}

/** "Amount is too low for bridge, try at least 1928334" → "1928334". */
function parseMinimum(message: unknown): string | null {
  if (typeof message !== "string") return null;
  const match = /try at least (\d+)\b/.exec(message);
  return match ? match[1] : null;
}

function networkFeeCeiling(deliveryTokenId: string, chainId: string): bigint | null {
  if (chainId === NEAR_DESTINATION_CHAIN_ID) {
    const ceiling = NEAR_DELIVERY_FEE_CEILING_RAW[deliveryTokenId];
    return ceiling === undefined ? null : BigInt(ceiling);
  }
  const entry = getWithdrawalEntry(deliveryTokenId);
  if (!entry || entry.chainId !== chainId) return null;
  return BigInt(entry.withdrawalFeeRaw) * NETWORK_FEE_CEILING_MULTIPLE;
}

/**
 * A live quote for sending `amountRaw` of the held token to `recipient` on `chainId`, converted
 * to that chain's Delivery Token — or the reason there is none.
 */
export async function quoteConversion(p: QuoteConversionParams): Promise<ConversionQuoteResult> {
  // ── What may be asked at all. A pair the delivery table does not name is not sent to 1Click.
  const plan = withdrawalPlan(p.originTokenId, p.chainId);
  if (plan.kind !== "conversion") {
    return unavailable(`no conversion route from ${p.originTokenId} to ${p.chainId}`);
  }
  if (!isBaseUnitString(p.amountRaw) || BigInt(p.amountRaw) <= ZERO) {
    return unavailable("amount is not a positive base-unit integer");
  }
  if (!p.refundTo) return unavailable("no refund account");

  const inDecimals = getTokenById(p.originTokenId)?.decimals;
  const outDecimals = getTokenById(plan.deliveryTokenId)?.decimals;
  if (inDecimals === undefined || outDecimals === undefined) return unavailable("token decimals unknown");
  const feeCeiling = networkFeeCeiling(plan.deliveryTokenId, p.chainId);
  if (feeCeiling === null) return unavailable(`no Network Fee ceiling for ${plan.deliveryTokenId}`);

  // The recipient is committed by the request, and the echo can only prove 1Click repeated it —
  // not that it was worth sending. So the address is checked here against the chain it is for,
  // and, on NEAR, against the accounts a plain `ft_transfer` lands nowhere in (D-384).
  if (!validateAddress(p.recipient, p.chainId).valid) {
    return unavailable(`recipient is not a valid ${p.chainId} address`);
  }
  const deliveryEntry = getWithdrawalEntry(plan.deliveryTokenId);
  if (deliveryEntry && unreceivableNearDestination(deliveryEntry, p.recipient)) {
    return unavailable("recipient is a contract, not an account");
  }

  const now = p.deps?.now?.() ?? Date.now();
  // Whole seconds: the `.000Z` form is the one measured to come back verbatim in the echo.
  const requestedDeadlineMs =
    Math.floor((now + CONVERSION_QUOTE_DEADLINE_SECS * 1000) / 1000) * 1000;

  const body = {
    dry: false,
    swapType: "EXACT_INPUT",
    slippageTolerance: CONVERSION_SLIPPAGE_BPS,
    originAsset: p.originTokenId,
    depositType: "INTENTS",
    destinationAsset: plan.destinationAsset,
    amount: p.amountRaw,
    refundTo: p.refundTo,
    refundType: "INTENTS",
    recipient: p.recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(requestedDeadlineMs).toISOString(),
  };

  let payload: unknown;
  try {
    const res = await (p.deps?.fetchImpl ?? fetch)(`${ONE_CLICK_BASE_URL}/v0/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: p.signal,
    });
    payload = await res.json().catch(() => null);
    if (!res.ok) {
      const minimum = parseMinimum((payload as { message?: unknown } | null)?.message);
      if (minimum !== null) return { ok: false, reason: "below-minimum", minAmountRaw: minimum };
      return unavailable(`1Click answered ${res.status}`);
    }
  } catch {
    // Network error, abort. Both mean the same thing to the screen.
    return unavailable("1Click unreachable");
  }

  const root = payload as { quote?: unknown; quoteRequest?: unknown; signature?: unknown } | null;
  if (typeof root?.quote !== "object" || root.quote === null) {
    return unavailable("no quote in the response");
  }
  if (typeof root.quoteRequest !== "object" || root.quoteRequest === null) {
    return unavailable("no quoteRequest echo");
  }
  const q = root.quote as Record<string, unknown>;
  const echo = root.quoteRequest as Record<string, unknown>;

  // ── G1: the echo. Every field sent comes back identical — the asset pair (G6 rides here: the
  // destination asset is ours, from the delivery table), amount, recipient, refund account and
  // the four types. Strict equality, no normalisation: measured verbatim on 89 routes.
  for (const [field, sent] of Object.entries(body)) {
    if (echo[field] !== sent) return unavailable(`echo mismatch on ${field}`);
  }
  // …and nothing we did NOT send that changes where or how it is delivered. Equality on what we
  // sent cannot see these: an `ft_transfer_call` message to the recipient, a virtual-chain
  // recipient or refund recipient, Confidential Intents handling (spec `QuoteRequest`, 2026-10-06;
  // cross-review 020-4). Empty is how 1Click echoes them unset (recorded: `null`, `"public"`).
  for (const field of ["customRecipientMsg", "virtualChainRecipient", "virtualChainRefundRecipient"]) {
    const value = echo[field];
    if (value !== undefined && value !== null && value !== "") {
      return unavailable(`echo carries ${field}, which we never sent`);
    }
  }
  if (echo.confidentiality !== undefined && echo.confidentiality !== "public") {
    return unavailable("echo asks for confidential handling, which we never sent");
  }
  // Our `transfer` carries no memo, so a deposit 1Click would only match by memo is one it could
  // not attribute — the money would wait for the refund deadline instead of converting.
  if (echo.depositMode !== undefined && echo.depositMode !== "SIMPLE") {
    return unavailable("deposit mode is not SIMPLE");
  }
  if (q.depositMemo !== undefined && q.depositMemo !== null && q.depositMemo !== "") {
    return unavailable("quote asks for a deposit memo");
  }

  // ── G2: where the money goes. A per-quote implicit account, and none of the accounts a
  // transfer must never pay: the signer (a no-op that reads as delivered), the recipient, the
  // Verifier, a vault.
  const depositAddress = q.depositAddress;
  if (typeof depositAddress !== "string" || !DEPOSIT_ADDRESS_RE.test(depositAddress)) {
    return unavailable("deposit address is not 64 lowercase hex");
  }
  if (
    depositAddress === p.refundTo ||
    depositAddress === p.recipient ||
    depositAddress === INTENTS_CONTRACT_ID ||
    depositAddress === VAULT_CONTRACT_ID ||
    RETIRED_VAULT_CONTRACT_IDS.has(depositAddress)
  ) {
    return unavailable("deposit address is a known account");
  }

  // ── G3: what leaves. EXACT_INPUT, so exactly the amount asked; `minAmountIn` no higher.
  const { amountIn, minAmountIn, amountOut, minAmountOut, withdrawFee, refundFee } = q;
  if (!isBaseUnitString(amountIn) || amountIn !== p.amountRaw) {
    return unavailable("amountIn is not the amount asked");
  }
  if (!isBaseUnitString(minAmountIn) || BigInt(minAmountIn) > BigInt(amountIn)) {
    return unavailable("minAmountIn above amountIn");
  }

  // ── G4: what arrives. Positive integers, the guarantee no higher than the expectation.
  if (!isBaseUnitString(amountOut) || !isBaseUnitString(minAmountOut)) {
    return unavailable("amountOut/minAmountOut not base units");
  }
  if (BigInt(minAmountOut) <= ZERO || BigInt(minAmountOut) > BigInt(amountOut)) {
    return unavailable("minAmountOut not in (0, amountOut]");
  }
  if (!isBaseUnitString(withdrawFee) || !isBaseUnitString(refundFee)) {
    return unavailable("withdrawFee/refundFee not base units");
  }

  // ── G5: the ceiling without prices. Same family on both sides, so a loss is a loss whatever
  // the asset is worth.
  const { loss, of } = normalizedLoss({
    amountInRaw: amountIn,
    inDecimals,
    outRaw: minAmountOut,
    withdrawFeeRaw: withdrawFee,
    outDecimals,
  });
  const ceilingBps = BigInt(CONVERSION_LOSS_CEILING_BPS);
  if (loss * BPS > of * ceilingBps) return unavailable("loss above the conversion ceiling");
  // A fee past the regular ceiling is acceptable only as the opening of a token account (D-441).
  // Its own refusal (below the minimum) waits until every other guard has passed: a response wrong
  // in some other way must read "unavailable", not "the minimum is …".
  const createsTokenAccount = BigInt(withdrawFee) > feeCeiling;
  const accountCeiling =
    createsTokenAccount && p.chainId === deliveryEntry?.chainId
      ? tokenAccountFeeCeiling(plan.deliveryTokenId, outDecimals, feeCeiling, p.liveUsdPrice)
      : undefined;
  if (createsTokenAccount && accountCeiling === undefined) {
    return unavailable("Network Fee above its ceiling");
  }
  if (accountCeiling !== undefined && BigInt(withdrawFee) > accountCeiling) {
    return unavailable("Network Fee above the token-account ceiling");
  }
  // A refund comes back in the held token; it may not cost more than a conversion is allowed to.
  if (BigInt(refundFee) * BPS > BigInt(amountIn) * ceilingBps) {
    return unavailable("refundFee above the conversion ceiling");
  }

  // ── Deadlines. The response's own is what C2 also has to beat; unreadable is a refusal.
  const quoteDeadlineMs = typeof q.deadline === "string" ? Date.parse(q.deadline) : Number.NaN;
  if (!Number.isFinite(quoteDeadlineMs)) return unavailable("quote deadline unreadable");

  // ── G7: the proof of what was quoted, for the rescue record.
  if (typeof root.signature !== "string" || root.signature === "") {
    return unavailable("quote is not signed");
  }

  if (accountCeiling !== undefined) {
    // Both sides at the larger decimals, as `normalizedLoss` does.
    const top = Math.max(inDecimals, outDecimals);
    const feeTop = BigInt(withdrawFee) * BigInt(10) ** BigInt(top - outDecimals);
    const inTop = BigInt(amountIn) * BigInt(10) ** BigInt(top - inDecimals);
    const share = BigInt(TOKEN_ACCOUNT_MAX_FEE_SHARE_BPS);
    if (feeTop * BPS > inTop * share) {
      // The least `amountIn` with fee ≤ share, back in held units, rounded up.
      const minTop = (feeTop * BPS + share - BigInt(1)) / share;
      const unit = BigInt(10) ** BigInt(top - inDecimals);
      return {
        ok: false,
        reason: "token-account-below-minimum",
        minAmountRaw: ((minTop + unit - BigInt(1)) / unit).toString(),
        feeRaw: withdrawFee,
      };
    }
  }

  return {
    ok: true,
    quote: {
      originTokenId: p.originTokenId,
      deliveryTokenId: plan.deliveryTokenId,
      chainId: p.chainId,
      destinationAsset: plan.destinationAsset,
      recipient: p.recipient,
      refundTo: p.refundTo,
      depositAddress,
      amountInRaw: amountIn,
      amountOutRaw: amountOut,
      minAmountOutRaw: minAmountOut,
      withdrawFeeRaw: withdrawFee,
      createsTokenAccount,
      refundFeeRaw: refundFee,
      slippageBps: CONVERSION_SLIPPAGE_BPS,
      requestedDeadlineMs,
      quoteDeadlineMs,
      timeEstimateSecs:
        typeof q.timeEstimate === "number" && Number.isFinite(q.timeEstimate) ? q.timeEstimate : null,
      signature: root.signature,
      quotedAtMs: now,
    },
  };
}
