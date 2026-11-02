// The withdrawal fee the user is about to pay, live from the PoA bridge (005.plan §8, 5.4).
//
// Attribution: see ATTRIBUTIONS.md #4 (wraps internal-utils — re-review on version bump).
//
// WHY LIVE AT ALL. `withdrawalRegistry` carries a fee snapshotted on 2026-06-08. It is
// accurate enough to reason about, and stale enough to mis-state what someone receives:
// the OMFT fee tracks destination-chain gas and moves on its own. The registry stays the
// FALLBACK, never the silent default — a failed estimate shows the static figure rather
// than blocking a withdrawal on a fee lookup.
//
// WHY ONLY `omft`. `withdrawal_estimate` is a PoA bridge method and only answers for tokens
// the bridge moves. `near-native` never crosses it (its fee is genuinely 0, not "unknown"),
// and `hot-omni` is not a bridge quote at all — its fee is the destination chain's own gas
// price plus a solver swap to buy that gas, and it is SIGNED. That lives in `hot-fee.ts`
// (4.3.1); asking the PoA bridge for it would return an error we would then have to paper
// over with the static value we already have.
//
// The fee is NOT part of what gets signed: the envelope carries the GROSS amount and the
// bridge deducts its fee on the far side (withdraw-envelope.ts). So a fee that moved
// between the quote and the signature changes what LANDS, never whether the signature is
// valid — which is exactly why P2 is answered in the UI (block and re-confirm) and not by
// rebuilding the envelope.

import { poaBridge } from "@defuse-protocol/internal-utils";
import { getTokenById } from "@/features/market/lib/token-registry";
import {
  fetchHotFeeAndRequirement,
  hotFeeSupported,
  type HotFeeDeps,
  type HotFeeDetail,
  type HotGasRequirement,
} from "./hot-fee";
import { getWithdrawalEntry } from "./withdrawal-registry";

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
 * Whether a live quote is even obtainable for this token — see the `omft` note above.
 *
 * `hot-omni` joins as of block 4.3.5: the arithmetic no longer disagrees (4.3.2 subtracts,
 * like `omft`), and `hotFeeSupported` (hot-fee.ts) is the same table `fetchHotWithdrawalFee`
 * itself gates on, so this cannot claim "live" for a chain that module cannot quote.
 */
export function supportsLiveWithdrawalFee(tokenId: string, chainId?: string): boolean {
  const entry = getWithdrawalEntry(tokenId, chainId);
  if (!entry) return false;
  if (entry.bridgeRoute === "omft") return true;
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
  /** The real destination. The bridge may price per-address, so the dummy is a last resort. */
  destinationAddress: string;
  /**
   * `hot-omni` only: base units of the destination chain's native asset the signer already
   * holds. Lets the fee be paid straight out of that balance instead of selling part of the
   * withdrawal for it — see `nativeBalanceRaw` in `hot-fee.ts` for why it is advisory.
   */
  nativeBalanceRaw?: string;
  signal?: AbortSignal;
  /** Injected in tests; nothing here may reach the network in a unit test. */
  estimate?: typeof poaBridge.httpClient.getWithdrawalEstimate;
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

  const fallback: WithdrawalFeeQuote = { feeRaw: entry.withdrawalFeeRaw, source: "registry" };
  if (entry.bridgeRoute !== "omft") return { quote: fallback };

  const call = p.estimate ?? poaBridge.httpClient.getWithdrawalEstimate;
  try {
    // `chain` is typed `BlockchainEnum` upstream, whose members are exactly these chain-id
    // strings — but the constant lags the live API (see chain-registry.ts:75), so the cast
    // matches what `getPendingDeposits` already does rather than dropping live chains.
    type EstimateParams = Parameters<typeof poaBridge.httpClient.getWithdrawalEstimate>[0];
    const result = await call(
      {
        token: entry.nearTokenId,
        address: p.destinationAddress,
        chain: entry.chainId,
      } as EstimateParams,
      { fetchOptions: p.signal ? { signal: p.signal } : undefined }
    );

    const feeRaw = result?.withdrawalFee;
    if (typeof feeRaw !== "string" || !/^\d+$/.test(feeRaw)) return { quote: fallback };

    // The response reports its OWN precision, and it is the registry's fee — not the
    // amount — that this number has to line up with. It has always matched the token's
    // decimals in practice, but "in practice" is not something to spend someone's money
    // on: a mismatch would scale the displayed fee by a power of ten, silently. Take the
    // static figure rather than a number we cannot place on the same scale.
    const decimals = getTokenById(p.tokenId)?.decimals;
    if (decimals !== undefined && result.withdrawalFeeDecimals !== decimals) {
      return { quote: fallback };
    }

    return { quote: { feeRaw, source: "live" } };
  } catch {
    // Includes the caller aborting. Same answer either way: show what we know.
    return { quote: fallback };
  }
}
