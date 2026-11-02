// Buying the destination chain's gas with the token being withdrawn (008.plan §Fase 4, D-251).
//
// Attribution: see ATTRIBUTIONS.md #13 (1Click API v0 `/v0/quote`, chaindefuser.com —
// re-review on API version bump).
//
// WHY THIS EXISTS AT ALL
// A `hot-omni` withdrawal of a token that is NOT its chain's gas has to hand the HOT relayer
// that chain's native asset (`amount_native`, hot-envelope.ts). Upstream buys it with a
// `token_diff` against the solver relay. Measured on 2026-08-09, that market does not exist:
// NONE of the 11 `hot.tg` native assets is quoted by any solver, in either direction, at any
// size — while non-native assets on the same bridge quote fine. So `fetchFeeSwap` returns
// `null` for all 10 non-native `hot-omni` tokens, and the withdrawal blocks.
//
// 1Click prices the same swap. It is a DISTRIBUTION CHANNEL rather than a quote endpoint: it
// answers with an intents account to send the input to, and delivers the output itself.
//
// WHAT THAT COSTS, STATED PLAINLY
// The input leaves the signer's balance and sits with a third party until the output comes
// back. That is why this buys ONLY the gas — ~$0.05 — and never routes the withdrawal itself:
// 1Click quoted the whole 5 USDT → TON withdrawal at essentially the same price (0.052859 vs
// 0.053459 USDT), and taking that deal would have put the entire amount in their custody
// instead of five cents. The withdrawal stays a `mt_withdraw` we sign ourselves. (The one
// exception is a Converting Withdrawal — a pair no direct route delivers — which goes to 1Click
// whole by decision: ADR-0024, oneclick-conversion-quote.ts. A direct withdrawal never does.)
//
// HOW COMPLETION IS OBSERVED: it is not, not here. The gas landing in the signer's own
// balance is the completion signal, and the withdrawal screen already re-quotes when that
// balance changes (withdrawal-modal.tsx). Polling 1Click's status endpoint would add a second
// source of truth about the same fact, and the balance is the one that matters. (Conversions
// do poll it, oneclick-status.ts: there the delivery lands outside the user's balance.)

import { messageFactory } from "@defuse-protocol/internal-utils";
import type { Intent } from "@defuse-protocol/contract-types";
import { ONE_CLICK_BASE_URL } from "./oneclick-base-url";

/** Basis points. 1% on a five-cent swap is noise; refusing to fill it is not. */
const SLIPPAGE_BPS = 100;

/**
 * 🔴 HOW MUCH MORE THAN THE CURRENT REQUIREMENT TO BUY. THE ANSWER IS PER CHAIN, BECAUSE THE
 * REASON FOR A MARGIN IS PER CHAIN.
 *
 * A margin exists for exactly one reason: this purchase is DECOUPLED IN TIME from the
 * withdrawal it pays for. The screen re-reads the requirement every 15 seconds and compares it
 * against the balance, so if the requirement can move between the purchase and the withdrawal,
 * a purchase sized exactly is already short — and a blocked screen offers to buy again, which
 * is a second real payment to a third party. Where the requirement CANNOT move, a margin has
 * no drift to absorb, and what it buys instead is a leftover.
 *
 * WHAT THE LEFTOVER IS WORTH, STATED HONESTLY, because it is the real trade and an earlier
 * version of this comment argued both sides of it two paragraphs apart. A surplus is NOT
 * wasted: it stays in the signer's own balance and the next withdrawal to the same chain pays
 * its fee straight out of it (`payment: "native-balance"`, hot-fee.ts) with no purchase and no
 * second signature. So 2x roughly halves the number of third-party transfers FOR A USER WHO
 * WITHDRAWS TO THE SAME CHAIN AGAIN. Against that: there is no market to sell a `hot.tg` native
 * back into (measured — GRAM and XLM return null in both directions at every size tried), so
 * for a user who does not come back, the leftover is stranded, not banked. We buy exactly on
 * the constant-fee chains: one purchase per withdrawal, and no dust left on a chain the user
 * may never use again.
 *
 * WHERE THE REQUIREMENT MOVES (margin justified):
 *   - The four EVM chains: `floor(gasPrice * 1.3) * 200_000`, read from the RPC at quote time
 *     (hot-fee.ts). Genuinely continuous. 2x covers a 100% rise.
 *
 * WHERE IT DOES NOT (margin removed, measured 2026-08-12):
 *   - TON: a flat constant, `TON_RELAYER_FEE_RAW`. No RPC, nothing to drift.
 *   - Stellar: two constants — 1.1 XLM for a destination account that does not exist yet,
 *     0.1 XLM for one that does. Not a market price.
 *
 * ⚠️ THE ARGUMENT THIS COMMENT USED TO MAKE FOR STELLAR DID NOT HOLD, and it is written down
 * so it is not reintroduced. It said: buy against the cheap answer, have Horizon time out on
 * the next check, and the requirement jumps 11x. The jump is real — every uncertain Horizon
 * answer resolves to NEW_ACCOUNT by design (hot-fee.ts) — but **2x does not protect against an
 * 11x jump**. Holding 0.2 XLM against a 1.1 XLM requirement is exactly as blocked as holding
 * 0.1, and produces the same follow-up purchase. Covering that case would mean always buying
 * the expensive constant (~$0.18 every time, to insure against a Horizon outage), which costs
 * more than the problem. Precise about what was lost by dropping it: in the loop where the two
 * INDEPENDENT Horizon lookups disagree (`fetchHotGasRequirement` says EXISTS, the fee effect's
 * `fetchHotWithdrawalFee` times out into NEW_ACCOUNT), each purchase does add to the balance,
 * so 2x escaped in ~6 rounds where 1x takes ~11. Both are unacceptable and neither margin is
 * the fix — the two lookups are (D-274).
 *
 * ⚠️ IN PRACTICE THE EVM BRANCH IS A FALLBACK OF A FALLBACK. Measured 2026-08-12 against the
 * live relay with production's own `fetchHotWithdrawalFee`: all four EVM chains answer
 * `payment: "swap"` — the fee is paid atomically inside the signed intent, in the token being
 * withdrawn, and no purchase happens at all (USDT/USDC(POL) 0.0056 USDT, USDT(BSC) 0.0082,
 * USDT(AVAX) 0.000084, USDT(OP) 0.0005, at the gas prices of that day). Only TON and Stellar
 * return `null` and reach this code. So the 2x below fires only when an EVM chain's RPC is
 * alive (there is a gas price) while the solver market for its native is dry. **We have never
 * observed that** — which is a weaker claim than "rare", deliberately: how long a third-party
 * market keeps quoting is not something this repo can measure or promise. When it happens the
 * drift is real, so the margin stays.
 *
 * 🔴 WHY BUYING EXACTLY IS SAFE ON THE 1x CHAINS, AND WHAT WOULD BREAK IT. `nativeGasBalanceRaw`
 * (withdrawal-modal.tsx) reads the balance in HUMAN units as a double and re-scales it with
 * `Math.floor`, so the error points DOWNWARDS (D-206). Buy exactly the requirement, land exactly
 * at it, lose one base unit to that floor, and the screen stays blocked on gas that is really
 * there. It does not happen for the three real fee constants — verified in
 * `gas-purchase.test.ts`, which is where a decimals change would be caught — but it is a
 * property of those specific numbers, not a general guarantee.
 */
const GAS_PURCHASE_MARGIN_DEFAULT = { num: BigInt(2), den: BigInt(1) };
const GAS_PURCHASE_MARGIN_EXACT = { num: BigInt(1), den: BigInt(1) };

/** Chains whose relayer fee is a constant, so a margin absorbs nothing. */
const GAS_PURCHASE_MARGIN_BY_CHAIN: Record<string, { num: bigint; den: bigint }> = {
  "ton:mainnet": GAS_PURCHASE_MARGIN_EXACT,
  "stellar:mainnet": GAS_PURCHASE_MARGIN_EXACT,
};

/**
 * The amount to actually buy, given what the relayer needs right now and where it is going.
 *
 * Exported and applied by the CALLER rather than hidden inside `quoteGasPurchase`, because the
 * screen has to state the number it is buying: a quote for double what the fee row says would
 * be the screen and the signature disagreeing about the trade.
 *
 * `chainId` is REQUIRED rather than defaulted: the margin is a per-chain claim about whether
 * that chain's fee can move (see the table above), and a caller that could omit it would
 * silently get the conservative answer for a chain that does not need one — which is the cost
 * this parameter exists to remove. An unknown chain still gets the safe 2x.
 */
export function gasPurchaseTargetRaw(requirementRaw: string, chainId: string): string | null {
  if (!isBaseUnitString(requirementRaw)) return null;
  const need = BigInt(requirementRaw);
  if (need <= ZERO) return null;
  const margin = GAS_PURCHASE_MARGIN_BY_CHAIN[chainId] ?? GAS_PURCHASE_MARGIN_DEFAULT;
  return ((need * margin.num) / margin.den).toString();
}

/** How long the quote asks to stay valid. The screen re-quotes on click, so this is a floor. */
const QUOTE_DEADLINE_SECS = 20 * 60;

/** Seconds the signed transfer stays valid — the same budget the withdrawal envelope uses. */
const TRANSFER_DEADLINE_SECS = 10 * 60;

const ZERO = BigInt(0);

/** A base-unit integer. Anything else is not arithmetic that may reach a signed intent. */
function isBaseUnitString(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

export type GasPurchaseQuote = {
  /** The intents account the input must be transferred to for 1Click to execute. */
  depositAddress: string;
  /** Base units of the WITHDRAWN token this costs. */
  amountInRaw: string;
  /** Base units of the chain's native asset that come back. At least the relayer fee. */
  amountOutRaw: string;
  /** The asset sold — the token being withdrawn. */
  tokenId: string;
  /** The asset bought — the destination chain's gas. */
  nativeAssetId: string;
};

export type GasPurchaseDeps = {
  /** Injected so no test reaches the network. */
  fetchImpl?: typeof fetch;
  /** Injectable clock, for the deadline the quote carries. */
  now?: () => number;
};

export type QuoteGasPurchaseParams = {
  /** Full defuse asset id of the token being withdrawn — what gets sold. */
  tokenId: string;
  /** Full defuse asset id of the destination chain's gas — what gets bought. */
  nativeAssetId: string;
  /** Base units of gas needed: `HotFeeDetail.relayerFeeRaw`, never a rounded figure. */
  feeRaw: string;
  /** The signer's intents account: both the recipient of the gas and the refund address. */
  accountId: string;
  signal?: AbortSignal;
  deps?: GasPurchaseDeps;
};

/**
 * A quote to buy exactly `feeRaw` of the chain's gas, or `null` when one cannot be had.
 *
 * EXACT_OUTPUT and not EXACT_INPUT: what is needed is a precise amount of gas, and the user
 * pays whatever that costs. Sizing the input from a price would buy an amount nobody checked
 * — too little stalls the delivery, too much silently overpays.
 *
 * `null` for every failure, and never a partial quote: the caller's only correct response is
 * to leave the withdrawal blocked, which is what it already does.
 */
export async function quoteGasPurchase(
  p: QuoteGasPurchaseParams
): Promise<GasPurchaseQuote | null> {
  if (!isBaseUnitString(p.feeRaw) || BigInt(p.feeRaw) <= ZERO) return null;
  if (!p.accountId) return null;

  const doFetch = p.deps?.fetchImpl ?? fetch;
  const now = p.deps?.now?.() ?? Date.now();

  const body = {
    dry: false,
    swapType: "EXACT_OUTPUT",
    slippageTolerance: SLIPPAGE_BPS,
    originAsset: p.tokenId,
    depositType: "INTENTS",
    destinationAsset: p.nativeAssetId,
    amount: p.feeRaw,
    // Both the gas and any refund come back to the signer's own account. `refundTo` is the
    // only thing standing between a failed fill and funds with no owner, so it is never left
    // to a default.
    refundTo: p.accountId,
    refundType: "INTENTS",
    recipient: p.accountId,
    recipientType: "INTENTS",
    deadline: new Date(now + QUOTE_DEADLINE_SECS * 1000).toISOString(),
  };

  let payload: unknown;
  try {
    const res = await doFetch(`${ONE_CLICK_BASE_URL}/v0/quote`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: p.signal,
    });
    if (!res.ok) return null;
    payload = await res.json();
  } catch {
    // Network error, abort, malformed JSON. All mean the same thing to the caller.
    return null;
  }

  const root = payload as { quote?: unknown; quoteRequest?: unknown } | null;
  const quote = root?.quote;
  if (typeof quote !== "object" || quote === null) return null;
  const q = quote as Record<string, unknown>;

  // 🔴 The request is the contract: 1Click delivers the asset, the amount and the refund
  // WRITTEN IN THE REQUEST, and every `/v0/quote` answer repeats it in `quoteRequest`
  // (measured since 2026-10-04, plan 020). A quote whose echo disagrees is about somebody
  // else's trade, so it never reaches a signature — the same rule Converting Withdrawals
  // apply (G1, oneclick-conversion-quote.ts), including refusing an answer with no echo.
  // The sibling solver path checks the pair too: `toSwap` (hot-fee.ts). (D-447)
  if (typeof root?.quoteRequest !== "object" || root.quoteRequest === null) return null;
  const echo = root.quoteRequest as Record<string, unknown>;
  // Measured 2026-10-14 on EXACT_OUTPUT INTENTS→INTENTS gas quotes (BNB, POL): echoed verbatim.
  for (const field of [
    "originAsset",
    "destinationAsset",
    "amount",
    "refundTo",
    "recipient",
    "swapType",
    "depositType",
    "refundType",
    "recipientType",
  ] as const) {
    if (echo[field] !== body[field]) return null;
  }

  if (typeof q.depositAddress !== "string" || q.depositAddress === "") return null;
  if (!isBaseUnitString(q.amountIn) || !isBaseUnitString(q.amountOut)) return null;

  // 🔴 The guard that makes an EXACT_OUTPUT quote safe to act on. A fill that returns LESS
  // gas than asked leaves the withdrawal blocked anyway — but only after the input has
  // already left the balance. Refusing here costs nothing; accepting costs the difference.
  //
  // It is checked against `minAmountOut` when the response carries one, because THAT is the
  // field that answers "what is the least I will receive". `amountOut` is the expected fill,
  // and the request asks for 1% of slippage tolerance — so on a response where the two differ,
  // trusting `amountOut` would accept a quote contractually allowed to deliver less than the
  // fee. Measured 2026-08-09 they are equal on `EXACT_OUTPUT` (the slippage lands on the input
  // side); this reads the stricter of the two rather than depending on that staying true.
  const guaranteedOut = isBaseUnitString(q.minAmountOut)
    ? (BigInt(q.minAmountOut) < BigInt(q.amountOut) ? q.minAmountOut : q.amountOut)
    : q.amountOut;
  if (BigInt(guaranteedOut) < BigInt(p.feeRaw)) return null;
  if (BigInt(q.amountIn) <= ZERO) return null;

  // `tokenId` and `nativeAssetId` are returned from our request, which the echo check above
  // has just confirmed 1Click quoted.
  return {
    depositAddress: q.depositAddress,
    amountInRaw: q.amountIn,
    amountOutRaw: q.amountOut,
    tokenId: p.tokenId,
    nativeAssetId: p.nativeAssetId,
  };
}

/**
 * What the SCREEN can say about a gas purchase, which is everything except who is buying.
 *
 * `accountId` is the field that is missing, and its absence is the point: it is the refund
 * address and the recipient, so a component that could fill it in is a component that could
 * misdirect the money. The withdrawal modal builds one of these and hands it up; the shell,
 * which knows the identity, calls `quoteGasPurchase`.
 */
export type GasQuoteRequest = Omit<QuoteGasPurchaseParams, "accountId" | "deps">;

/** Prices the purchase for the screen. Wallet-free: no signature, no identity, one fetch. */
export type GasQuoteSeam = (p: GasQuoteRequest) => Promise<GasPurchaseQuote | null>;

/**
 * Signs and publishes EXACTLY the quote the screen displayed — never a fresher one obtained on
 * the way past. `amountIn` and `depositAddress` are the price and the destination; re-quoting
 * between the render and the signature would sign numbers nobody agreed to, which is the same
 * failure `HotFeeDetail` rides on the fee quote to prevent.
 *
 * `maxAmountInRaw` travels WITH the quote rather than being looked up by the buyer: the
 * ceiling is a statement about what this trade is worth, and the screen is where the USD
 * rates that decide that already are. Passing them separately would let a caller sign a quote
 * against a ceiling computed for a different one.
 *
 * Resolves when the purchase is done — including the wait for the token to actually land,
 * because until then the button must stay disabled and a second click would be a second
 * purchase. Rejects otherwise, in words that say where the money is.
 */
export type BuyGasSeam = (p: {
  quote: GasPurchaseQuote;
  maxAmountInRaw: string;
  /** The withdrawal this purchase exists to unblock — the purchase must not consume it. */
  withdrawalAmountRaw: string;
}) => Promise<void>;

export type BuildGasPurchaseParams = {
  /** The INTENTS account id doing the buying. */
  signerId: string;
  quote: GasPurchaseQuote;
  /** Base units the withdrawal itself will move — the purchase must not eat into it. */
  withdrawalAmountRaw: string;
  /** Injectable so tests are deterministic. */
  deadlineSecs?: number;
  nonce?: Uint8Array;
};

/**
 * The signed message that pays 1Click for the gas: ONE `transfer` intent, nothing else.
 *
 * Deliberately the same shape and the same factory as the withdrawal envelope
 * (`makeSwapMessage` against `intents.near`), not the vault's — a gas purchase never touches
 * the vault, so it needs neither the versioned V1 nonce nor an `auth_call`.
 */
export function buildGasPurchaseSignRequest(p: BuildGasPurchaseParams): {
  nep413: { message: string; recipient: string; nonce: Uint8Array };
  erc191Message: string;
  intents: Intent[];
} {
  const amountIn = BigInt(p.quote.amountInRaw);
  if (amountIn <= ZERO) {
    throw new Error(`Gas purchase would transfer ${p.quote.amountInRaw} base units`);
  }

  // 🔴 The purchase is paid out of the SAME balance the withdrawal is about to spend. A quote
  // that costs as much as the withdrawal itself would leave nothing to withdraw — and the
  // failure would surface as a rejected `mt_withdraw` AFTER the token had been sold, which is
  // the one ordering where the user is out real money for nothing.
  if (!isBaseUnitString(p.withdrawalAmountRaw)) {
    throw new Error(`Gas purchase needs the withdrawal amount to compare against`);
  }
  if (amountIn >= BigInt(p.withdrawalAmountRaw)) {
    throw new Error(
      `Gas purchase of ${p.quote.amountInRaw} base units is not worth making against a ` +
        `withdrawal of ${p.withdrawalAmountRaw}: it would consume the whole amount`
    );
  }

  const deadlineSecs =
    p.deadlineSecs ?? Math.floor(Date.now() / 1000) + TRANSFER_DEADLINE_SECS;

  const intents: Intent[] = [
    {
      intent: "transfer",
      receiver_id: p.quote.depositAddress,
      tokens: { [p.quote.tokenId]: p.quote.amountInRaw },
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
  };
}
