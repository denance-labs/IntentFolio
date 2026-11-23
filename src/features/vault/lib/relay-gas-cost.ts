// The relayer's gas, paid by the user (D-589 block 5, 048 §10).
//
// Since the solver relay closed, our own relay (`/api/relay`) sends every envelope to the
// Verifier, and `intentfolio-budget.near` pays its gas. Each of those envelopes now carries,
// LAST, one more `transfer`: 0.002 NEAR's worth of the token the operation already moves, to the
// account that pays the gas, memo `gas`. Same signature, no swap, no second prompt — the Storage
// Cost's mechanism (storage-cost.ts, D-528) applied to every operation.
//
// Decided by the operator (2026-11-20):
//   - a FIXED 0.002 NEAR per operation, whatever its shape. Measured on real money: 0.0006–0.0013
//     NEAR per envelope (048 §9, D-167), so it covers the worst shape with margin;
//   - it is DEDUCTED from the amount the user chose, like the Storage Cost: what the operation
//     signs is the rest;
//   - a token without a live price goes UNCHARGED: nobody is left unable to move their money, and
//     the relay accepts the envelope without the transfer only when it cannot price that token
//     either (relay-gate.ts);
//   - commits to the vault (Unallocate, edit, rename, delete) are not Verifier intents and cannot
//     carry it: they stay free (008.plan, final-contract change #16).
//
// LAST in the envelope so every reader that finds the operation by position still finds it at
// index 0 (or the auth_call at 1). Its position changes nothing on-chain: `execute_intents` runs
// the intents in order in one receipt and reverts them all if any fails. No `msg`: it would call
// `mt_on_transfer` on an account without a contract.

import type { Intent } from "@defuse-protocol/contract-types";
import { NEAR_REGISTRY_TOKEN_ID, toIntentsTokenId, toRegistryTokenId } from "@/features/market/lib/intents-token-id";
import { getTokenById } from "@/features/market/lib/token-registry";
import { nearCostInTokenUnits, STORAGE_COST_RECEIVER } from "./storage-cost";

/** Who receives it: the account that pays the relay's gas — the Storage Cost's receiver too. */
export const RELAY_GAS_RECEIVER = STORAGE_COST_RECEIVER;
/** Fixed, lowercase. Tells it apart from the Setup's `storage` transfer to the same account. */
export const RELAY_GAS_MEMO = "gas";
/** 0.002 NEAR, in yoctoNEAR (operator, 2026-11-20). */
export const RELAY_GAS_COST_YOCTO = BigInt(2) * BigInt(10) ** BigInt(21);

/** One envelope's charge: the intents token id and its amount in base units. */
export type RelayGasCharge = {
  /** The id the Verifier reads (`toIntentsTokenId`): NEAR is `nep141:wrap.near`. */
  tokenId: string;
  /** Base units, a positive integer as a string. */
  amount: string;
  /** The same amount in human units, for the confirmation. */
  qty: number;
};

export type RelayGasQuote =
  | { ok: true; charge: RelayGasCharge }
  /** NEAR's or the token's price is not live: the operation goes uncharged (operator, 2026-11-20). */
  | { ok: true; charge: null }
  /** The inputs produced an amount that does not value back to the cost: a bug, never signed. */
  | { ok: false; reason: "implausible" };

/**
 * The relay's gas for an operation that moves `tokenId` (a registry id), in that token. Pure.
 * `priceOf` returns a LIVE USD price or null (`livePriceOf`): a hand-written fallback can be
 * several times off.
 */
export function quoteRelayGas(p: { tokenId: string; priceOf: (registryTokenId: string) => number | null }): RelayGasQuote {
  const token = getTokenById(p.tokenId);
  if (!token) return { ok: false, reason: "implausible" };
  const nearPrice = p.priceOf(NEAR_REGISTRY_TOKEN_ID);
  const tokenPrice = p.priceOf(p.tokenId);
  if (nearPrice === null || tokenPrice === null) return { ok: true, charge: null };
  const converted = nearCostInTokenUnits(RELAY_GAS_COST_YOCTO, nearPrice, tokenPrice, token.decimals);
  if (!converted) return { ok: false, reason: "implausible" };
  return {
    ok: true,
    charge: { tokenId: toIntentsTokenId(p.tokenId), amount: converted.amount.toString(), qty: converted.qty },
  };
}

/**
 * The token an operation that funds several pays its gas in: the highest-value leg with a live
 * price, ties to the smaller id — the same choice as the Storage Cost (`quoteStorageCost`), so a
 * Setup charges both in one token. Null when no leg has a live price (the operation goes
 * uncharged).
 */
export function relayGasTokenOf(
  grossAllocations: Readonly<Record<string, number>>,
  priceOf: (registryTokenId: string) => number | null
): string | null {
  let best: { tokenId: string; usd: number } | null = null;
  for (const [tokenId, qty] of Object.entries(grossAllocations)) {
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const price = priceOf(tokenId);
    if (price === null) continue;
    const usd = qty * price;
    if (!best || usd > best.usd || (usd === best.usd && tokenId < best.tokenId)) best = { tokenId, usd };
  }
  return best?.tokenId ?? null;
}

/** The intent itself, exactly as the relay expects it (relay-gate.ts `relayGasProblem`). */
export function relayGasIntent(charge: Pick<RelayGasCharge, "tokenId" | "amount">): Intent {
  if (!/^[1-9]\d*$/.test(charge.amount)) {
    throw new Error(`Relay gas must be a positive amount of base units, got ${charge.amount}`);
  }
  return {
    intent: "transfer",
    receiver_id: RELAY_GAS_RECEIVER,
    tokens: { [charge.tokenId]: charge.amount },
    memo: RELAY_GAS_MEMO,
  } as Intent;
}

/** The charge as a runner deducts it from its leg: a REGISTRY token id and base units. */
export type RelayGasDeduction = { tokenId: string; amount: bigint };

/**
 * What a confirmation hands its runner: the deduction, or null when the operation goes uncharged.
 * Throws on a quote that cannot be signed — the screen keeps the button off for it, so reaching
 * here with one is a bug, and signing without the charge would only be refused by the relay.
 */
export function relayGasDeductionOf(quote: RelayGasQuote): RelayGasDeduction | null {
  if (!quote.ok) throw new Error("The sending cost could not be priced consistently; nothing was signed");
  if (quote.charge === null) return null;
  return { tokenId: toRegistryTokenId(quote.charge.tokenId), amount: BigInt(quote.charge.amount) };
}
