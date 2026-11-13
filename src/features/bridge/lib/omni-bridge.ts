// The `omni` withdrawal route: a token leaves `intents.near` straight into the Omni Bridge
// (`omni.bridge.near`), which carries it to its UTXO chain (D-580, plan 043). Today that is ZEC
// only, to a transparent Zcash address.
//
// Attribution: see ATTRIBUTIONS.md #9 (@defuse-protocol/intents-sdk 0.96.0 Omni Bridge route:
// `omni-withdraw-params.ts` `deriveOmniWithdrawIntentParams`, `omni-bridge-utils.ts`
// `createWithdrawIntentsPrimitive`, `omni-bridge.ts` `estimateWithdrawalFee` /
// `validateWithdrawal` / `describeWithdrawal`, `withdrawal-timing.ts` — re-review on bump).
//
// WHY NOT THE PoA ROUTE IT REPLACES
// `zec.omft.near` was migrated from PoA to the Omni Bridge. The PoA withdrawal shape still
// works, through a legacy relayer that re-sends it to Omni minus the PoA fee (0.00047 ZEC).
// Going direct costs the Omni protocol fee plus the Zcash network fee only, and does not
// depend on that relayer staying configured. Measured end to end in D-580.
//
// WHY BY HAND AND NOT THE SDK
// The SDK route pulls `@omni-bridge/core`, `@omni-bridge/near`, `lru-cache` and `ttlcache` for
// what is, on this chain, one JSON intent and two GETs. Everything below mirrors it field by
// field; what it does NOT mirror is said where it diverges.
//
// THE FEE IS SIGNED, AND IT GROWS WITH THE AMOUNT
// `MaxGasFee` travels inside the intent's `msg`: it is the ceiling the bridge may spend on the
// Zcash transaction. The real fee is only chosen when that transaction is built, AFTER the
// signature (ZIP-317: 5000 zatoshi per logical action, so 10000/15000/20000 on the twelve
// withdrawals measured in D-580); whatever the ceiling did not use arrives with the funds. The
// API's ceiling also depends on the amount — more inputs to spend — measured 2026-11-12:
// 22000 up to 50 ZEC, 33000 at 100, 44000 at 500, 66000 at 1000. So a quote is only good for
// amounts up to the one it was asked for, and the envelope refuses anything larger.

import { config, poll, POLL_PENDING, type CompletionStats } from "@defuse-protocol/internal-utils";
import type { Intent } from "@defuse-protocol/contract-types";

/** The Omni Bridge contract: `receiver_id` of every `omni` withdrawal. */
export const OMNI_BRIDGE_CONTRACT_ID = "omni.bridge.near";

/** `MIN_GAS_AMOUNT` (omni-bridge-constants.ts) — an `ft_transfer_call`, not an `ft_transfer`. */
export const OMNI_WITHDRAW_MIN_GAS = "37400000000000";

/** Omni's public API, the one `@omni-bridge/core`'s `BridgeAPI("mainnet")` calls. */
export const OMNI_API_BASE = "https://mainnet.api.bridge.nearone.org";

/**
 * Our chain ids → Omni's address prefix (`ChainKind` spelled as `omniAddress` spells it). A
 * chain absent here cannot be an `omni` destination, and everything below refuses it rather
 * than guessing a prefix.
 */
const OMNI_CHAIN_PREFIX: Record<string, string> = {
  "zec:mainnet": "zcash",
};

/** The fee request's browser budget — the SDK's own (`withTimeout`, 10 s in a window). */
const FEE_TIMEOUT_MS = 10_000;
/**
 * The transfer lookup's budget per request. Longer than the fee's because it is not in front
 * of a button, and because this endpoint was measured slow: 36 s answers and 504s at 45 s on
 * 2026-11-12. A request that runs out is a pending tick, not an error.
 */
const TRANSFER_TIMEOUT_MS = 30_000;

/**
 * Zcash's measured withdrawal p99 (`WITHDRAWAL_P99_BY_CHAIN["bip122:00040fe8…"]` = 2093 s),
 * derived into poll stats exactly as upstream does (p50/p90 from the p99, deadline 3× p99).
 */
const ZCASH_DELIVERY_P99_MS = 2_093_000;
/**
 * The floor between two lookups. `poll`'s own floor is 300 ms for the first p50 — five minutes on
 * Zcash — which against an endpoint that takes up to 36 s to answer is a back-to-back request
 * loop. A Zcash block is ~75 s, so nothing is learned faster than this anyway.
 */
const OMNI_MIN_POLL_INTERVAL_MS = 10_000;

export const OMNI_DELIVERY_STATS: CompletionStats = {
  p50: Math.max(5_000, ZCASH_DELIVERY_P99_MS * 0.15),
  p90: Math.max(30_000, ZCASH_DELIVERY_P99_MS * 0.5),
  p99: ZCASH_DELIVERY_P99_MS * 3,
};

/**
 * One live fee quote, as the screen showed it and as the envelope signs it.
 *
 * Kept whole rather than as a total because two of its parts are used separately: `gasFeeRaw`
 * is SIGNED (`MaxGasFee`), and `quotedForRaw` bounds what it may be signed for.
 */
export type OmniFeeDetail = {
  /** The Zcash network fee ceiling (`gas_fee`), signed as `MaxGasFee`. */
  gasFeeRaw: string;
  /** The bridge's own fee (`protocol_fee`), charged in the token. */
  protocolFeeRaw: string;
  /** The smallest GROSS amount the bridge takes (`min_amount`). */
  minAmountRaw: string;
  /** The gross amount this quote was asked for. The ceiling grows with the amount. */
  quotedForRaw: string;
};

/** What the fee lookup can answer. `insufficient-utxo` is the bridge saying no, not a failure. */
export type OmniFeeOutcome =
  | { kind: "ok"; fee: OmniFeeDetail }
  | { kind: "insufficient-utxo" }
  | { kind: "unavailable" };

/** Everything that leaves the balance beyond what arrives, at most: ceiling + protocol fee. */
export function omniFeeTotalRaw(fee: OmniFeeDetail): string {
  return (BigInt(fee.gasFeeRaw) + BigInt(fee.protocolFeeRaw)).toString();
}

/** `omniAddress(chainKind, address)`: the recipient as the bridge reads it, or null. */
export function omniRecipient(chainId: string, address: string): string | null {
  const prefix = OMNI_CHAIN_PREFIX[chainId];
  return prefix ? `${prefix}:${address}` : null;
}

/**
 * The caller's signal plus a per-request timeout. Not `AbortSignal.any`, which older Safari
 * (before 17.4) lacks — there it would throw, and a throw here reads as "fee unavailable",
 * which blocks the withdrawal for no reason the user could act on.
 */
function requestSignal(outer: AbortSignal | undefined, ms: number): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${ms}ms`)), ms);
  const forward = () => controller.abort(outer?.reason);
  if (outer?.aborted) forward();
  else outer?.addEventListener("abort", forward);
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      outer?.removeEventListener("abort", forward);
    },
  };
}

function positiveInteger(v: unknown): string | null {
  return typeof v === "string" && /^\d+$/.test(v) && BigInt(v) > BigInt(0) ? v : null;
}

export type FetchOmniFeeParams = {
  /** The token contract on NEAR, e.g. `zec.omft.near`. */
  tokenAccountId: string;
  chainId: string;
  destinationAddress: string;
  /** The GROSS amount about to be signed, in base units. */
  amountRaw: string;
  signal?: AbortSignal;
  /** Injected in tests; nothing here may reach the network in a unit test. */
  fetchImpl?: typeof fetch;
};

/**
 * `GET /api/v2/transfer-fee`, read the way `estimateWithdrawalFee` + `validateWithdrawal` read
 * it for a UTXO chain. Never throws: every failure is `unavailable`, which blocks the
 * withdrawal (there is no registry figure that may stand in for a signed one).
 *
 * `native_token_fee` must be zero. It is on Zcash today; if the bridge ever asks for a NEAR fee
 * on this route, the envelope would need a `storage_deposit` intent and a NEAR quote that this
 * file does not build — so that answer is `unavailable`, never a quote signed without it.
 */
export async function fetchOmniWithdrawalFee(p: FetchOmniFeeParams): Promise<OmniFeeOutcome> {
  const recipient = omniRecipient(p.chainId, p.destinationAddress);
  if (!recipient || !/^\d+$/.test(p.amountRaw) || BigInt(p.amountRaw) <= BigInt(0)) {
    return { kind: "unavailable" };
  }
  const url =
    `${OMNI_API_BASE}/api/v2/transfer-fee` +
    `?sender=${encodeURIComponent(`near:${config.env.contractID}`)}` +
    `&recipient=${encodeURIComponent(recipient)}` +
    `&token=${encodeURIComponent(`near:${p.tokenAccountId}`)}` +
    `&amount=${p.amountRaw}`;
  const doFetch = p.fetchImpl ?? fetch;
  const req = requestSignal(p.signal, FEE_TIMEOUT_MS);
  try {
    const res = await doFetch(url, { signal: req.signal });
    if (!res.ok) return { kind: "unavailable" };
    const body = (await res.json()) as Record<string, unknown>;
    if (body.insufficient_utxo === true) return { kind: "insufficient-utxo" };
    if (body.native_token_fee !== "0") return { kind: "unavailable" };
    // We sign `fee: "0"` in the token too. Were the bridge to start asking for one, a transfer
    // signed without it could be accepted by Omni and never relayed — stuck on the bridge, not
    // back in the balance — so that answer blocks rather than quotes.
    if (body.transferred_token_fee !== "0") return { kind: "unavailable" };
    const gasFeeRaw = positiveInteger(body.gas_fee);
    const protocolFeeRaw = positiveInteger(body.protocol_fee);
    const minAmountRaw = positiveInteger(body.min_amount);
    if (!gasFeeRaw || !protocolFeeRaw || !minAmountRaw) return { kind: "unavailable" };
    return {
      kind: "ok",
      fee: { gasFeeRaw, protocolFeeRaw, minAmountRaw, quotedForRaw: p.amountRaw },
    };
  } catch {
    return { kind: "unavailable" };
  } finally {
    req.done();
  }
}

/**
 * The `ft_withdraw` the bridge reads, mirroring `createWithdrawIntentsPrimitive` for a UTXO
 * chain with no NEAR fee: no `storage_deposit` intent (`native_token_fee` is 0, so the SDK
 * computes no storage account) and no `storage_deposit` field (`omni.bridge.near` is already
 * registered on the token — measured 2026-11-12; if it ever were not, `ft_transfer_call`
 * fails and the tokens return to the balance).
 *
 * ⚠️ `receiver_id` is the BRIDGE, and the user's address travels inside `msg.recipient`. The
 * payload keys keep the SDK's order (recipient, fee, native_token_fee, external_id, msg), so the
 * serialised string is the one upstream would sign for the same values.
 *
 * `amount` is GROSS: the SDK adds `gas_fee + protocol_fee` to a net amount, and our gross is
 * exactly that sum (withdraw-envelope.ts). The bridge takes the protocol fee and the real gas;
 * the user receives at least `amount − gas ceiling − protocol fee`.
 */
export function buildOmniWithdrawIntent(p: {
  tokenAccountId: string;
  amount: string;
  recipient: string;
  fee: OmniFeeDetail;
  externalId: string;
}): Intent {
  const payload = {
    recipient: p.recipient,
    fee: "0",
    native_token_fee: "0",
    external_id: p.externalId,
    msg: JSON.stringify({ MaxGasFee: p.fee.gasFeeRaw }),
  };
  return {
    intent: "ft_withdraw",
    token: p.tokenAccountId,
    receiver_id: OMNI_BRIDGE_CONTRACT_ID,
    amount: p.amount,
    msg: JSON.stringify(payload),
    min_gas: OMNI_WITHDRAW_MIN_GAS,
  } as Intent;
}

/**
 * Reads the recipient back out of an `omni` intent's `msg`, or null when it is not one. Used by
 * the submit-time destination check, which compares in the bridge's own spelling.
 */
export function readOmniRecipient(intent: unknown): string | null {
  if (!intent || typeof intent !== "object") return null;
  const f = intent as Record<string, unknown>;
  if (f.intent !== "ft_withdraw" || f.receiver_id !== OMNI_BRIDGE_CONTRACT_ID) return null;
  if (typeof f.msg !== "string") return null;
  try {
    const payload = JSON.parse(f.msg) as Record<string, unknown>;
    return typeof payload.recipient === "string" ? payload.recipient : null;
  } catch {
    return null;
  }
}

/** One element of `GET /api/v2/transfers/transfer`, narrowed to what this file reads. */
type OmniTransfer = {
  finalised?: { UtxoLog?: { transaction_hash?: unknown } | null } | null;
  transfer_message?: { token?: unknown; recipient?: unknown; amount?: unknown } | null;
};

export type OmniDeliveryDeps = {
  /** Injected in tests; nothing here may reach the network in a unit test. */
  fetchImpl?: typeof fetch;
  /** Injected in tests so the deadline paths run without waiting half an hour. */
  stats?: CompletionStats;
  /** Injected in tests; defaults to `OMNI_MIN_POLL_INTERVAL_MS`. */
  minIntervalMs?: number;
};

export type WaitForOmniDeliveryParams = {
  /** The NEAR settlement transaction — the bridge indexes the transfer under it. */
  txHash: string;
  tokenAccountId: string;
  chainId: string;
  destinationAddress: string;
  /**
   * The signed gross, when known. The relay can put two withdrawals of the same token to the
   * same address in one transaction; the amount is what tells them apart. Omni reports it back
   * unchanged as `transfer_message.amount` (the block-0 fixture).
   */
  amountRaw?: string;
  signal?: AbortSignal;
  deps?: OmniDeliveryDeps;
};

/**
 * Waits until the bridge reports the destination-chain transaction.
 *
 * The answer is an ARRAY — one element per transfer the settlement transaction created, and a
 * relay transaction can carry several — so ours is picked by token and recipient. Delivered
 * means `finalised.UtxoLog.transaction_hash` is there: the Zcash txid (measured 2026-11-12 on
 * a real withdrawal, `J8PwufFu…`; plan 043 block 0). `initialized`/`signed` without it is
 * still in flight.
 *
 * DIVERGENCE: the SDK, in a browser, calls a withdrawal complete on `utxo_meta.pending_sign_id`
 * — before broadcast. This waits for the finalised txid instead, because that is what the
 * activity row links to; it costs a few more minutes of "in progress".
 *
 * Every failure here is a pending tick: the endpoint is slow and returns 504s, and the deadline
 * — not an error count — decides when we stop looking. A transfer that never appears (the
 * bridge refused it, so `ft_transfer_call` sent the tokens back to the balance) ends at the
 * deadline as "not confirmed", like every other route's silence.
 */
export async function waitForOmniDelivery(
  p: WaitForOmniDeliveryParams
): Promise<{ destinationTxHash: string }> {
  const recipient = omniRecipient(p.chainId, p.destinationAddress);
  if (!recipient) throw new Error(`No Omni Bridge destination for chain "${p.chainId}"`);
  const token = `near:${p.tokenAccountId}`;
  const doFetch = p.deps?.fetchImpl ?? fetch;
  const url =
    `${OMNI_API_BASE}/api/v2/transfers/transfer?transaction_hash=${encodeURIComponent(p.txHash)}`;

  return poll<{ destinationTxHash: string }>(
    async () => {
      const req = requestSignal(p.signal, TRANSFER_TIMEOUT_MS);
      try {
        const res = await doFetch(url, { signal: req.signal });
        if (!res.ok) return POLL_PENDING;
        const body: unknown = await res.json();
        if (!Array.isArray(body)) return POLL_PENDING;
        const ours = (body as OmniTransfer[]).find(
          (t) =>
            t?.transfer_message?.token === token &&
            t.transfer_message.recipient === recipient &&
            (p.amountRaw === undefined || t.transfer_message.amount === p.amountRaw)
        );
        const hash = ours?.finalised?.UtxoLog?.transaction_hash;
        return typeof hash === "string" && hash !== "" ? { destinationTxHash: hash } : POLL_PENDING;
      } catch {
        return POLL_PENDING;
      } finally {
        req.done();
      }
    },
    {
      stats: p.deps?.stats ?? OMNI_DELIVERY_STATS,
      signal: p.signal,
      minInterval: p.deps?.minIntervalMs ?? OMNI_MIN_POLL_INTERVAL_MS,
    }
  );
}
