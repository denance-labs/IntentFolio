// The withdrawal fee the user is about to pay (005.plan §8, 5.4).
//
// `omft` has no live quote any more: the PoA bridge's `withdrawal_estimate` closed with its API
// on 2026-11-11 (D-584). Its fees are the registry's, re-checked 2026-11-19 (046 §3) — flat on
// every `omft` token but one. USDT on Tron depends on whether the destination already holds
// USDT, so that one is priced by reading the destination (`tron-usdt-fee.ts`).
//
// `hot-omni` is not a bridge quote at all — its fee is the destination chain's own gas price
// plus a solver swap to buy that gas, and it is SIGNED. That lives in `hot-fee.ts` (4.3.1).
// `omni` likewise, in `omni-bridge.ts`. `near-native` never crosses a bridge: its fee is
// genuinely 0, not "unknown".
//
// The fee is NOT part of what gets signed: the envelope carries the GROSS amount and the
// bridge deducts its fee on the far side (withdraw-envelope.ts). So a fee that moved
// between the quote and the signature changes what LANDS, never whether the signature is
// valid — which is exactly why P2 is answered in the UI (block and re-confirm) and not by
// rebuilding the envelope.

import {
  fetchHotFeeAndRequirement,
  hotFeeSupported,
  type HotFeeDeps,
  type HotFeeDetail,
  type HotGasRequirement,
} from "./hot-fee";
import { getWithdrawalEntry } from "./withdrawal-registry";
import { fetchOmniWithdrawalFee, omniFeeTotalRaw, type OmniFeeDetail } from "./omni-bridge";
import { readTronUsdtBalance, tronUsdtFeeRaw, TRON_USDT_TOKEN_ID } from "./tron-usdt-fee";

export type WithdrawalFeeQuote = {
  /** Base units of the token being withdrawn — same precision as the registry's fee. */
  feeRaw: string;
  /** Where the number came from, so the UI can say so instead of implying precision. */
  source: "live" | "registry";
  /**
   * `hot-omni` only, and only when a signable quote was obtained (`hot-fee.ts`, 4.3.1).
   *
   * It rides on the quote rather than being fetched again at signing time BECAUSE it is
   * signed: `blockNumber` and the fee-paying swap go inside the intent, so the envelope has
   * to be built from the very object the screen showed and the user accepted. Re-requesting
   * it at the click would produce a different `blockNumber` than the one on screen, which is
   * the whole failure mode this field exists to prevent.
   *
   * Absent on `omft` and `near-native`, where the fee is deducted downstream and never
   * signed — and absent on `hot-omni` too when no live quote could be had, which is the
   * signal that the withdrawal cannot be built at all (there is no static stand-in).
   */
  hot?: HotFeeDetail;
  /**
   * `omni` only, and only from a live quote (omni-bridge.ts). Rides here for the same reason as
   * `hot`: its gas ceiling is SIGNED, so the envelope must be built from the object on screen.
   * `feeRaw` is its total (ceiling + protocol fee) — the most the withdrawal can cost.
   */
  omni?: OmniFeeDetail;
};

/** The registry's snapshot. Always available, never blocks, never throws for a known token. */
export function staticWithdrawalFee(
  tokenId: string,
  chainId?: string
): WithdrawalFeeQuote | null {
  const entry = getWithdrawalEntry(tokenId, chainId);
  if (!entry) return null;
  return { feeRaw: entry.withdrawalFeeRaw, source: "registry" };
}

/**
 * Whether a live quote is even obtainable for this token — see the header. On `omft` only USDT
 * on Tron, whose fee is read off the destination (D-584).
 *
 * `hot-omni` joins as of block 4.3.5: the arithmetic no longer disagrees (4.3.2 subtracts,
 * like `omft`), and `hotFeeSupported` (hot-fee.ts) is the same table `fetchHotWithdrawalFee`
 * itself gates on, so this cannot claim "live" for a chain that module cannot quote.
 */
export function supportsLiveWithdrawalFee(tokenId: string, chainId?: string): boolean {
  const entry = getWithdrawalEntry(tokenId, chainId);
  if (!entry) return false;
  if (entry.bridgeRoute === "omni") return true;
  if (entry.bridgeRoute === "omft") return tokenId === TRON_USDT_TOKEN_ID && entry.chainId === "tron:mainnet";
  if (entry.bridgeRoute === "hot-omni") return hotFeeSupported(tokenId);
  return false;
}

/**
 * The smallest GROSS amount worth signing: it has to cover the bridge fee AND still leave at
 * least the bridge's own minimum on the far side.
 *
 * One number expresses both guards, because `minWithdrawalRaw` is never `0` — so any amount
 * at or above `fee + min` is necessarily above `fee`. This is the UI's rendering of the two
 * throws in `buildWithdrawSignRequest`, and it exists so the screen refuses the same amounts
 * the envelope would refuse, rather than letting the user reach a wallet prompt to be told.
 *
 * `feeRaw` is the caller's current best figure: the registry snapshot before a live quote
 * arrives, the live quote after. Falls back to the registry when omitted.
 *
 * `chainId` is the destination; omitted, the token's own chain. On every function here it
 * matters only for an `omft` token sent to NEAR (D-384), which pays no bridge fee.
 */
export function minimumWithdrawalRaw(
  tokenId: string,
  feeRaw?: string,
  chainId?: string
): string | null {
  const entry = getWithdrawalEntry(tokenId, chainId);
  if (!entry) return null;
  const fee = BigInt(feeRaw ?? entry.withdrawalFeeRaw);
  return (fee + BigInt(entry.minWithdrawalRaw)).toString();
}

export type FetchWithdrawalFeeParams = {
  /** Full defuse asset id — the withdrawal-registry key. */
  tokenId: string;
  /** The destination chain; omitted, the token's own. NEAR for an `omft` token has no fee. */
  chainId?: string;
  /** The real destination: USDT on Tron is priced by it, and `hot-omni`/`omni` quote for it. */
  destinationAddress: string;
  /**
   * `hot-omni` only: base units of the destination chain's native asset the signer already
   * holds. Lets the fee be paid straight out of that balance instead of selling part of the
   * withdrawal for it — see `nativeBalanceRaw` in `hot-fee.ts` for why it is advisory.
   */
  nativeBalanceRaw?: string;
  /**
   * `omni` only, and REQUIRED there: the gross amount about to be signed, in base units. The
   * bridge's gas ceiling grows with it (omni-bridge.ts), so a quote without it cannot be had.
   */
  amountRaw?: string;
  signal?: AbortSignal;
  /** Injected in tests; USDT on Tron only — see `tron-usdt-fee.ts`. */
  tronFetch?: typeof fetch;
  /** Injected in tests; `omni` only. */
  omniFetch?: typeof fetch;
  /** Injected in tests; `hot-omni` only — see `hot-fee.ts`. */
  hotFeeDeps?: HotFeeDeps;
};

/**
 * What a fee lookup produces. `quote` is the answer; `hotRequirement` is what the answer was
 * computed AGAINST, and it exists because on `hot-omni` a `quote` of `null` is not the end of
 * the interaction — the screen still has to offer a way out of the block, and sizing that
 * offer needs the gas figure the `null` would otherwise have discarded.
 *
 * 🔴 D-274. Recovering that figure with a second, independent call was the bug: on Stellar the
 * requirement is resolved against Horizon per destination account, so two lookups in one cycle
 * could disagree by 11x — the purchase sized against one constant, sufficiency judged against
 * the other, and the screen blocked over gas it had just bought. Carrying it out of the same
 * pass is what makes the two agree by construction. See `HotFeeOutcome` in `hot-fee.ts`.
 */
export type WithdrawalFeeResult = {
  quote: WithdrawalFeeQuote | null;
  /**
   * `hot-omni` only, and PRESENT EVEN WHEN `quote` IS `null` — that combination is the whole
   * point. `null` here is the other failure: the gas cost itself could not be established, so
   * no purchase can be sized and none must be offered.
   */
  hotRequirement?: HotGasRequirement | null;
  /**
   * `omni` only: the bridge answered, and said it cannot pay out this amount right now
   * (`insufficient_utxo`). `quote` is `null` with it. Separate from a failed lookup because
   * "try again in a moment" is not what the user should be told.
   */
  omniInsufficientUtxo?: boolean;
};

/**
 * A live quote, or the registry's snapshot when one cannot be had — for `omft`. For
 * `hot-omni` there IS no snapshot to fall back to (hot-fee.ts's header): a failed live quote
 * returns `quote: null` here too, and the caller has to treat that as a block, not as "use the
 * static figure", or it risks showing Avalanche/Optimism's registry `"0"` against a live fee
 * above zero.
 */
export async function fetchWithdrawalFee(
  p: FetchWithdrawalFeeParams
): Promise<WithdrawalFeeResult> {
  const entry = getWithdrawalEntry(p.tokenId, p.chainId);
  if (!entry) return { quote: null };

  if (entry.bridgeRoute === "hot-omni") {
    // `fetchHotFeeAndRequirement` and not `fetchHotWithdrawalFee`: the narrow one drops the
    // requirement, which is exactly what D-274 is about (hot-fee.ts).
    const { fee: live, requirement } = await fetchHotFeeAndRequirement({
      tokenId: p.tokenId,
      destinationAddress: p.destinationAddress,
      nativeBalanceRaw: p.nativeBalanceRaw,
      signal: p.signal,
      deps: p.hotFeeDeps,
    });
    return {
      quote: live ? { feeRaw: live.feeRaw, source: "live", hot: live.hot } : null,
      hotRequirement: requirement,
    };
  }

  if (entry.bridgeRoute === "omni") {
    // No fallback, as on `hot-omni`: the registry figure is never signed.
    if (!p.amountRaw) return { quote: null };
    const outcome = await fetchOmniWithdrawalFee({
      tokenAccountId: entry.nearTokenId,
      chainId: entry.chainId,
      destinationAddress: p.destinationAddress,
      amountRaw: p.amountRaw,
      signal: p.signal,
      fetchImpl: p.omniFetch,
    });
    if (outcome.kind === "ok") {
      return { quote: { feeRaw: omniFeeTotalRaw(outcome.fee), source: "live", omni: outcome.fee } };
    }
    return { quote: null, omniInsufficientUtxo: outcome.kind === "insufficient-utxo" };
  }

  const fallback: WithdrawalFeeQuote = { feeRaw: entry.withdrawalFeeRaw, source: "registry" };
  if (entry.bridgeRoute !== "omft" || p.tokenId !== TRON_USDT_TOKEN_ID || entry.chainId !== "tron:mainnet") {
    return { quote: fallback };
  }

  // An unread balance keeps the registry's figure, which is the higher of the two: the screen
  // may then say a little more than is taken, never less.
  const balance = await readTronUsdtBalance(p.destinationAddress, { fetchImpl: p.tronFetch, signal: p.signal });
  if (balance === null) return { quote: fallback };
  return { quote: { feeRaw: tronUsdtFeeRaw(balance), source: "live" } };
}
