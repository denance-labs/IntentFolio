// The Storage Cost of a Setup (D-528, 031.plan): what the vault locks to store a new portfolio
// (NEAR storage staking, 1 byte = 0.00001 NEAR), charged once, at cost, as a third `transfer`
// in the Setup's signed envelope. ONE function prices it for the confirmation and for the
// signature, so what the user reads is what the user signs.
//
// The byte formula is not an estimate: it was measured on a sandbox running the production
// vault wasm (031.plan, block 031-0) and reproduces all sixteen measurements exactly:
//
//   302 + 4 × account + 2 × login address + name (UTF-8 bytes)
//       + Σ composition tokens (162 + 4 × id) + Σ funds-only tokens (154 + 3 × id)
//
// where every length is in bytes and a token id is the one the contract stores
// (`toIntentsTokenId`: NEAR is `nep141:wrap.near`). It always prices a NEW account: an account
// that already exists in the vault takes 372 bytes less, but that discount was not measured per
// account length, and believing an account exists when it does not would charge short. A
// composition token the Setup does not fund is priced as held, because the portfolio will hold
// it once it reaches its targets. If the final contract changes how it stores a portfolio, this
// has to be measured again (008.plan, final-contract changes).
//
// Money-critical, so the conversion to the charged token is integer arithmetic rounded UP: a
// float has no ceiling at 18 or 24 decimals. Prices must be live (a hand-written fallback can be
// several times off), and the result is checked against an independent float valuation before
// anyone signs it — an inverted ratio would charge whole coins of BTC.
//
// Attribution: see ATTRIBUTIONS.md #8 (the vault's storage, measured on its production wasm).

import { MIN_FUNDED_USD } from "@/features/dashboard-shell/lib/general-balance";
import { NEAR_REGISTRY_TOKEN_ID, toIntentsTokenId } from "@/features/market/lib/intents-token-id";
import { getTokenById } from "@/features/market/lib/token-registry";
import type { TokenPriceMap } from "@/features/market/types";
import { fromBaseUnits } from "./base-units";

/** Where the Storage Cost goes: the ops account that tops up the vault's NEAR (ADR-0013 as amended). */
export const STORAGE_COST_RECEIVER = "intentfolio-budget.near";
/**
 * Fixed, lowercase: the portfolio id is assigned by the vault in `on_auth`, after signing. The
 * transfer is tied to its Setup by the shared intent hash and the sender.
 */
export const STORAGE_COST_MEMO = "storage";

const BASE_BYTES = 302;
const BYTES_PER_ACCOUNT_BYTE = 4;
const BYTES_PER_ADDRESS_BYTE = 2;
const COMPOSITION_TOKEN_BYTES = 162;
const BYTES_PER_COMPOSITION_ID_BYTE = 4;
const FUNDS_ONLY_TOKEN_BYTES = 154;
const BYTES_PER_FUNDS_ONLY_ID_BYTE = 3;

const TEN = BigInt(10);
/** NEAR's storage price: 10^19 yoctoNEAR (0.00001 NEAR) per byte. */
const YOCTO_PER_BYTE = TEN ** BigInt(19);
const YOCTO_PER_NEAR = TEN ** BigInt(24);
/**
 * A Setup at every contract cap (32 legs of 128-byte ids, 64-byte account and address, 75-byte
 * name) takes ~22.3 KB ≈ 0.223 NEAR. Anything above this is a bug in the inputs, not a cost.
 */
export const MAX_STORAGE_COST_YOCTO = YOCTO_PER_NEAR / BigInt(4); // 0.25 NEAR
/** Prices cross into integer arithmetic at this scale; a price below 10^-18 USD is no price. */
const PRICE_SCALE = 1e18;

const utf8Length = (s: string) => new TextEncoder().encode(s).length;

export type StorageCostBytesInput = {
  /** The INTENTS account id that signs the Setup. */
  accountId: string;
  /** The login wallet address exactly as the Setup's `login_wallet` carries it. */
  loginAddress: string;
  /** The name as signed (trimmed). */
  portfolioName: string;
  /** Registry ids of the composition. */
  compositionTokenIds: readonly string[];
  /** Registry ids the Setup funds. Those outside the composition are funds-only. */
  fundedTokenIds: readonly string[];
};

/** The bytes the vault stores for this Setup, priced as a new account (see the header). */
export function storageCostBytes(p: StorageCostBytesInput): number {
  const composition = new Set(p.compositionTokenIds);
  let bytes =
    BASE_BYTES +
    BYTES_PER_ACCOUNT_BYTE * utf8Length(p.accountId) +
    BYTES_PER_ADDRESS_BYTE * utf8Length(p.loginAddress) +
    utf8Length(p.portfolioName);
  for (const id of composition) {
    bytes += COMPOSITION_TOKEN_BYTES + BYTES_PER_COMPOSITION_ID_BYTE * utf8Length(toIntentsTokenId(id));
  }
  for (const id of new Set(p.fundedTokenIds)) {
    if (composition.has(id)) continue;
    bytes += FUNDS_ONLY_TOKEN_BYTES + BYTES_PER_FUNDS_ONLY_ID_BYTE * utf8Length(toIntentsTokenId(id));
  }
  return bytes;
}

/**
 * The USD price of a token if it is live (from the price feed, or its last answer within the
 * hour), else null. A registry fallback is written by hand and can be several times off.
 */
export function livePriceOf(prices: TokenPriceMap, tokenId: string): number | null {
  const price = prices[tokenId];
  if (!price || (price.source !== "chaindefuser" && price.source !== "coingecko" && price.source !== "cached")) return null;
  return Number.isFinite(price.usdPrice) && price.usdPrice * PRICE_SCALE >= 1 ? price.usdPrice : null;
}

/** The funded tokens are the keys of `grossAllocations` with a positive amount. */
export type StorageQuoteInput = Omit<StorageCostBytesInput, "fundedTokenIds"> & {
  /** Registry id → the amount the user chose, in human units, before the cost is deducted. */
  grossAllocations: Readonly<Record<string, number>>;
  /** Live USD price, or null (`livePriceOf`). */
  priceOf: (tokenId: string) => number | null;
};

export type StorageQuote =
  | {
      ok: true;
      /** Registry id of the token it is charged in: the Setup's highest-value leg. */
      tokenId: string;
      /** In the token's base units, rounded up. */
      amount: bigint;
      /** The same amount in human units, for the confirmation. */
      qty: number;
      bytes: number;
      costYocto: bigint;
    }
  | {
      ok: false;
      /** What is left of the charged token after the cost would be dust (under MIN_FUNDED_USD). */
      reason: "exceeds-amount";
      tokenId: string;
      /** The cost, in that token, for the message. */
      qty: number;
    }
  | {
      ok: false;
      reason:
        | "no-funds"
        /** NEAR's or the funding tokens' price is not live. */
        | "prices-not-live"
        /** The inputs produced a cost no Setup can have: a bug, never signed. */
        | "implausible";
    };

/** A priced Storage Cost, as the confirmation shows it and the Setup signs it. */
export type SetupStorageCost = Extract<StorageQuote, { ok: true }>;

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - BigInt(1)) / b;
}

/** The Storage Cost of a Setup, in the token it is charged in. Pure. */
export function quoteStorageCost(p: StorageQuoteInput): StorageQuote {
  const funded = Object.entries(p.grossAllocations).filter(([, qty]) => Number.isFinite(qty) && qty > 0);
  if (funded.length === 0) return { ok: false, reason: "no-funds" };

  const nearPrice = p.priceOf(NEAR_REGISTRY_TOKEN_ID);
  if (nearPrice === null) return { ok: false, reason: "prices-not-live" };

  // The highest-value leg, among those with a live price. Ties go to the smaller id, so the
  // choice does not depend on the order the allocations were built in.
  let charged: { tokenId: string; qty: number; price: number; usd: number } | null = null;
  for (const [tokenId, qty] of funded) {
    const price = p.priceOf(tokenId);
    if (price === null) continue;
    const usd = qty * price;
    if (!charged || usd > charged.usd || (usd === charged.usd && tokenId < charged.tokenId)) {
      charged = { tokenId, qty, price, usd };
    }
  }
  if (!charged) return { ok: false, reason: "prices-not-live" };
  const token = getTokenById(charged.tokenId);
  if (!token) return { ok: false, reason: "implausible" };

  const bytes = storageCostBytes({ ...p, fundedTokenIds: funded.map(([id]) => id) });
  const costYocto = BigInt(bytes) * YOCTO_PER_BYTE;
  if (costYocto <= BigInt(0) || costYocto > MAX_STORAGE_COST_YOCTO) return { ok: false, reason: "implausible" };

  // amount = ceil(costNEAR × nearUSD / tokenUSD), in the token's base units.
  const nearScaled = BigInt(Math.round(nearPrice * PRICE_SCALE));
  const tokenScaled = BigInt(Math.round(charged.price * PRICE_SCALE));
  const amount = ceilDiv(
    costYocto * nearScaled * TEN ** BigInt(token.decimals),
    tokenScaled * YOCTO_PER_NEAR
  );
  const qty = fromBaseUnits(amount, token.decimals);

  // Independent float valuation: the amount must cover the cost, and one base unit less must not
  // (the ceiling adds at most one). Catches an inverted ratio or a wrong decimals count.
  const costUsd = (Number(costYocto) / 1e24) * nearPrice;
  const unitUsd = charged.price / 10 ** token.decimals;
  const amountUsd = qty * charged.price;
  const slack = costUsd * 1e-6;
  if (amountUsd < costUsd - slack || amountUsd - unitUsd >= costUsd + slack) return { ok: false, reason: "implausible" };

  // What stays in the portfolio of that token must still be a funded line (C2, 016 §7).
  if (Math.round((charged.qty - qty) * charged.price * 100) / 100 < MIN_FUNDED_USD) {
    return { ok: false, reason: "exceeds-amount", tokenId: charged.tokenId, qty };
  }
  return { ok: true, tokenId: charged.tokenId, amount, qty, bytes, costYocto };
}
