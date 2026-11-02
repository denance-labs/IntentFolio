// ③ Withdraw, step 2 for `hot-omni`: the delivery wait the PoA bridge cannot give
// (008.plan §Fase 4, block 4.3.4).
//
// Attribution: see ATTRIBUTIONS.md #11 (mirrors @defuse-protocol/intents-sdk 0.78.0
// `HotBridge.describeWithdrawal` / `watchWithdrawal` / `withdrawal-timing.ts` and
// @hot-labs/omni-sdk 2.25.5 `parseWithdrawalNonces` / `getGaslessWithdrawStatus` —
// re-review on version bump).
//
// WHY THIS IS A THIRD PATH AND NOT A THIRD ARGUMENT
// `omft` is delivered by the PoA bridge, which offers one call that answers "did it land"
// (`waitForWithdrawalCompletion`, keyed on the asset id). HOT crosses its own bridge, and
// there is no such call. What it has instead is three sources that only together say
// anything:
//
//   1. the SETTLEMENT transaction's receipt logs, which are the only place the withdrawal's
//      nonce is ever written down — it is not in the intent, not in the relay's answer, and
//      not derivable from either;
//   2. `get_withdrawal_hash` on the refuel contract, which knows CANCELED, but whose
//      destination hash is submitted after the fact by whoever happens to relay it — so on
//      EVM it lags, and on the two non-EVM chains it never arrives at all (see below);
//   3. the bridge indexer, which is the one source that actually carries the destination
//      hash, on every chain HOT bridges to.
//
// So the primary source is the indexer and the contract is the fallback — the inverse of
// what "ask the chain, not an API" would suggest, and upstream's ordering for the same
// reason.
//
// 🔴 THE INDEXER IS NOT EVM-ONLY, AND ASSUMING IT WAS COST A DELIVERED WITHDRAWAL ITS CLOSE
// Until D-262 this file asked the indexer ONLY on EVM and left the two non-EVM chains with
// the contract as their single source. The contract never answers for them: measured on
// 2026-08-10 with real money, `get_withdrawal_hash("1786399461000001592906")` was still
// `null` more than 15 minutes after Horizon had confirmed the 4 USDC credited — and `null`
// is the only PENDING answer this file has (`statusToOutcome`). So a delivered non-EVM
// withdrawal could not close: it polled to its deadline and reported UNCONFIRMED, amber over
// money that had landed intact.
//
// The cure the plan expected was a second source of truth per destination chain (Horizon for
// Stellar, toncenter for TON). Measuring the indexer first made that unnecessary — it already
// has both, keyed by the same nonce we already parse:
//
//   nonce 1786399461000001592906 → blockchain "stellar", chain_id 1100,
//     hash 75e5cad6…b978b07, destination_chain_time 2026-08-10T22:09:16Z
//   nonce 1786374427000001591051 → blockchain "ton", chain_id 1117,
//     hash 3584b924…f83e6c7, destination_chain_time 2026-08-10T15:12:22Z
//
// Both verified against the destination chain rather than taken on trust: Horizon reports
// 75e5cad6… as a successful transaction in ledger 63893652 at 22:09:16Z — the same second
// the session-121 run recorded `account_credited 4.0000000 USDC`. Upstream's EVM-only
// branch is upstream's, and this is a deliberate divergence from it.
//
// DELIBERATE DIVERGENCE: NO HOT PRIVATE API
// When the indexer throws, upstream falls back to HOT's own REST API
// (`/api/v1/evm/bridge_withdrawal_hash`). We fall back to `get_withdrawal_hash` instead —
// the answer we already fetched this tick, from the contract rather than from a new external
// host. It is not an invention: reading the status string as the destination hash is exactly
// what upstream does on its non-EVM branch, so the semantics are upstream's; only which
// branch uses them is ours. What it costs is the case where the contract has no hash yet and
// the indexer is down at the same moment, which stays pending one tick longer.
//
// EVERY OUTCOME HERE IS POST-SETTLEMENT. The money left the General Balance before the first
// line of this file runs. There is no "failed safely" state to report — see withdraw-poll.ts.

import { poll, POLL_PENDING, bridgeIndexer, config, type CompletionStats } from "@defuse-protocol/internal-utils";
import { fetchTxOutcome, viewCall } from "@/features/vault/lib/near-view";
import { HOT_BRIDGE_RECEIVER_ID } from "./hot-envelope";
import { WithdrawDeliveryCancelledError } from "./withdraw-errors";

/** The two statuses `get_withdrawal_hash` spells out. Anything else is a hash, or nothing. */
const HOT_STATUS_COMPLETED = "COMPLETED";
const HOT_STATUS_CANCELED = "CANCELED";

/** `MAX_CONSECUTIVE_ERRORS` (intents-sdk `withdrawal-watcher.ts`). */
const MAX_CONSECUTIVE_ERRORS = 5;

/** The indexer's budget, with upstream's browser/server split (a user is watching one). */
const INDEXER_TIMEOUT_MS = typeof window !== "undefined" ? 10_000 : 3_000;

/** `HOT_EXTRA_TIMEOUT_MS` — 12 minutes upstream adds to every HOT deadline. */
const HOT_EXTRA_TIMEOUT_MS = 720_000;

/**
 * `WITHDRAWAL_P99_BY_CHAIN` (intents-sdk `withdrawal-timing.ts`), for the chains our
 * registry actually carries on this route, keyed by OUR chain ids rather than CAIP-2.
 *
 * These are measured production p99s, which is the whole reason to mirror them: an invented
 * deadline would only change when we stop LOOKING, never when the bridge delivers, and the
 * spread here is real — Optimism is 23 seconds and Avalanche is eleven minutes.
 */
const DELIVERY_P99_MS: Record<string, number> = {
  "eth:56": 36_000, // eip155:56
  "eth:137": 410_000, // eip155:137
  "eth:43114": 657_000, // eip155:43114
  "eth:10": 23_000, // eip155:10
  "ton:mainnet": 53_000, // tvm:-239 — reachable since block 4.5 built TON's receiver
  "stellar:mainnet": 50_000, // stellar:pubnet
};
// Re-read against intents-sdk 0.76.0 on 2026-08-07 while adding Stellar: the five values
// above still match upstream exactly, so this mirror carries no drift.

/** `DEFAULT_WITHDRAWAL_STATS`: a conservative 6 hours for a chain with no measurement. */
const DEFAULT_P50_MS = 60_000;
const DEFAULT_P90_MS = 600_000;
const DEFAULT_P99_MS = 21_600_000;

/**
 * The poll cadence and hard deadline for a chain, derived exactly as upstream derives them:
 * poll hard early where most deliveries land, back off for the tail, and give up looking at
 * 3x p99 plus HOT's 12-minute allowance.
 */
export function hotDeliveryStats(chainId: string): CompletionStats {
  const p99 = DELIVERY_P99_MS[chainId];
  if (p99 == null) {
    return { p50: DEFAULT_P50_MS, p90: DEFAULT_P90_MS, p99: DEFAULT_P99_MS + HOT_EXTRA_TIMEOUT_MS };
  }
  return {
    p50: Math.max(5_000, p99 * 0.15),
    p90: Math.max(30_000, p99 * 0.5),
    p99: p99 * 3 + HOT_EXTRA_TIMEOUT_MS,
  };
}

/**
 * Every HOT withdrawal nonce written into a transaction's receipt logs, in emission order.
 *
 * The regex is upstream's, verbatim, and it is a regex over a LOG LINE rather than a parsed
 * event on purpose: the nonce rides in the `memo` field of the NEP-245 burn the refuel
 * contract emits, and there is no schema for it to hang off.
 *
 * ⚠️ Only `receipts_outcome` is read, never `transaction_outcome` — also upstream's choice,
 * and here it is load-bearing rather than incidental: callers index this array positionally,
 * so one extra log line from a different outcome would silently shift which withdrawal a
 * nonce belongs to.
 */
export function parseHotWithdrawalNonces(outcome: unknown): string[] {
  const o = (outcome ?? {}) as { receipts_outcome?: Array<{ outcome?: { logs?: unknown } }> };
  const nonces: string[] = [];
  for (const receipt of o.receipts_outcome ?? []) {
    const logs = receipt?.outcome?.logs;
    if (!Array.isArray(logs)) continue;
    for (const log of logs) {
      const nonce = `${log}`.match(/"memo":"(\d+)"/)?.[1];
      if (nonce != null) nonces.push(nonce);
    }
  }
  return nonces;
}

/** HOT hands back hexified raw bytes, unprefixed. `isHex` (intents-sdk `lib/hex.ts`). */
function isHotTxHash(value: string): boolean {
  return value.length % 2 === 0 && /^[0-9A-Fa-f]+$/.test(value);
}

function strip0x(value: string): string {
  return value.startsWith("0x") ? value.slice(2) : value;
}

/** `formatTxHash`: EVM explorers want the prefix HOT does not send. */
function formatHotTxHash(hash: string, chainId: string): string {
  const bare = strip0x(hash);
  return chainId.startsWith("eth:") ? `0x${bare}` : bare;
}

/** What the withdrawal is doing, as the two chain-side sources can express it. */
export type HotDeliveryOutcome = {
  /** The withdrawal's own id on the HOT bridge — the handle for any manual re-check. */
  nonce: string;
  /**
   * `null` when the bridge confirms delivery without naming a transaction. Delivered is
   * delivered: a missing hash is a missing LINK, and must never be reported as "not arrived".
   */
  destinationTxHash: string | null;
};

/** The bridge indexer's withdrawals for one NEAR transaction. Injected so tests stay offline. */
export type HotIndexerWithdrawals = (
  nearTxHash: string
) => Promise<ReadonlyArray<{ nonce: string; hash: string | null }>>;

export type HotDeliveryDeps = {
  /** The settlement transaction's receipts. Defaults to the shared NEAR RPC helper. */
  fetchTxOutcome?: (txHash: string, senderAccountId: string) => Promise<unknown>;
  /** `get_withdrawal_hash` on the refuel contract. */
  getWithdrawalStatus?: (nonce: string) => Promise<unknown>;
  indexerWithdrawals?: HotIndexerWithdrawals;
};

const defaultGetWithdrawalStatus = (nonce: string): Promise<unknown> =>
  viewCall<unknown>(HOT_BRIDGE_RECEIVER_ID, "get_withdrawal_hash", { nonce });

const defaultIndexerWithdrawals: HotIndexerWithdrawals = async (nearTxHash) => {
  const { withdrawals } = await bridgeIndexer.httpClient.withdrawalsByNearTxHash(nearTxHash, {
    timeout: INDEXER_TIMEOUT_MS,
  });
  return withdrawals;
};

/**
 * The contract's answer, read as upstream reads it on the branch that has no indexer.
 *
 * `null` means "nothing yet" and is the ONLY pending answer: `get_withdrawal_hash` returns
 * null while a withdrawal is in flight, so any string it does return means the bridge is
 * finished with it. A string that is not `COMPLETED` and not readable as hex therefore still
 * counts as delivered — with no link, which is the honest half-answer.
 */
function statusToOutcome(status: unknown, nonce: string, chainId: string): HotDeliveryOutcome | null {
  if (typeof status !== "string" || status === "") return null;
  if (status === HOT_STATUS_COMPLETED) return { nonce, destinationTxHash: null };
  if (!isHotTxHash(strip0x(status))) return { nonce, destinationTxHash: null };
  return { nonce, destinationTxHash: formatHotTxHash(status, chainId) };
}

export type WaitForHotDeliveryParams = {
  /** The NEAR transaction the settlement produced. */
  txHash: string;
  /** Destination chain, as the withdrawal registry names it. Decides cadence and hash format. */
  chainId: string;
  signal?: AbortSignal;
  /**
   * Cadence and hard deadline. Defaults to the destination chain's own measured budget;
   * overridable so a test does not have to sit out a real chain's in real time.
   */
  poll?: { stats?: CompletionStats; minInterval?: number; maxInterval?: number };
  deps?: HotDeliveryDeps;
};

/**
 * Waits for a `hot-omni` withdrawal to land on its destination chain.
 *
 * Resolves only on a delivery the bridge itself confirms. Throws
 * `WithdrawDeliveryCancelledError` when the bridge says it cancelled, and `PollTimeoutError`
 * when the deadline expires — the caller turns both into a `left-balance` report, because by
 * this point the funds are out of the General Balance either way.
 *
 * Transient failures are absorbed the way upstream absorbs them (five in a row and it gives
 * up), and that includes not finding the nonce yet: `EXECUTED_OPTIMISTIC` can answer before
 * every receipt is visible, and a missing nonce one tick after settlement is a propagation
 * delay, not a missing withdrawal.
 */
export async function waitForHotDelivery(
  p: WaitForHotDeliveryParams
): Promise<HotDeliveryOutcome> {
  const deps = p.deps ?? {};
  const readOutcome = deps.fetchTxOutcome ?? fetchTxOutcome;
  const readStatus = deps.getWithdrawalStatus ?? defaultGetWithdrawalStatus;
  const readIndexer = deps.indexerWithdrawals ?? defaultIndexerWithdrawals;
  const isEvm = p.chainId.startsWith("eth:");

  // Resolved once and kept: the logs of a finished transaction do not change, and re-reading
  // them every tick would spend the whole budget on the one call that cannot tell us anything
  // new. Upstream caches this for the same reason (an LRU with a 1h TTL).
  let nonce: string | null = null;
  let consecutiveErrors = 0;

  return poll<HotDeliveryOutcome>(async () => {
    try {
      if (nonce === null) {
        // `intents.near`, not the user: the settlement transaction is signed by the Verifier
        // contract's relayer, and the RPC needs the sender to find it.
        const outcome = await readOutcome(p.txHash, config.env.contractID);
        nonce = parseHotWithdrawalNonces(outcome)[0] ?? null;
        if (nonce === null) {
          throw new Error(`no HOT withdrawal nonce in the receipts of ${p.txHash} yet`);
        }
      }

      const status = await readStatus(nonce);
      // Checked before anything else and rethrown past the retry counter: a cancellation is
      // an answer, and retrying it four more times only delays telling the user.
      if (status === HOT_STATUS_CANCELED) {
        throw new WithdrawDeliveryCancelledError(p.txHash, nonce);
      }

      // Asked on EVERY chain since D-262 — it is the only source that has the non-EVM hash.
      let indexerAnswered = false;
      try {
        const withdrawals = await readIndexer(p.txHash);
        const hash = withdrawals.find((w) => w.nonce === nonce)?.hash;
        const formatted =
          hash != null && hash !== "" ? formatHotTxHash(hash, p.chainId) : null;
        // Flagged only once the answer is fully READ, never merely received. Setting it above
        // this line is a real regression, not a style point: `find` on a malformed body and
        // `strip0x` on a non-string hash both throw, and on EVM a set flag turns that throw
        // into "the indexer answered and has nothing" — which suppresses the contract and
        // polls to the deadline, where the pre-D-262 code closed on the contract's hash.
        indexerAnswered = true;
        if (formatted !== null) return { nonce, destinationTxHash: formatted };
      } catch {
        // An indexer that FAILED falls through to the contract. See the header. A 404 counts
        // as a failure here and that is right: the indexer answers 404 for a withdrawal it
        // has not seen yet, which is silence, not a statement that nothing was delivered.
      }

      if (isEvm && indexerAnswered) {
        // EVM ONLY: the indexer answered and does not have it yet. Its silence is informative
        // here, so the contract's lagging hash is not consulted — that is what keeps this from
        // reporting a delivery the indexer would have contradicted.
        //
        // The same rule on non-EVM would be a regression rather than a safeguard: it would
        // discard the contract's CANCELED-adjacent answers to protect against a hash the
        // contract does not have on those chains anyway. So non-EVM keeps reading the contract
        // exactly as it did before D-262, and the indexer is strictly an extra way to close.
        consecutiveErrors = 0;
        return POLL_PENDING;
      }

      const outcome = statusToOutcome(status, nonce, p.chainId);
      consecutiveErrors = 0;
      return outcome ?? POLL_PENDING;
    } catch (e) {
      if (e instanceof WithdrawDeliveryCancelledError) throw e;
      consecutiveErrors++;
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) throw e;
      return POLL_PENDING;
    }
  }, {
    ...p.poll,
    stats: p.poll?.stats ?? hotDeliveryStats(p.chainId),
    signal: p.signal,
  });
}
