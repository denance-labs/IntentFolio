// ③ Withdraw, step 2: settlement → delivery (005.plan §8, Phase 5, block 5.2).
//
// Two waits, and the boundary between them is the one thing a user's copy must never blur:
//
//   settlement — the Verifier executes the intent on NEAR. UNTIL this lands, the General
//                Balance is intact and the withdrawal can be re-signed for free.
//   delivery   — a bridge moves the funds to the external chain. AFTER settlement the money
//                is out of the balance, so nothing that fails here may be reported as
//                "your withdrawal failed".
//
// The second wait is a different mechanism per route, and block 4.3.4 made that three:
//
//   omft        — the PoA bridge's own waiter, keyed on the asset id.
//   hot-omni    — HOT's bridge, which has no waiter; hot-delivery.ts assembles one.
//   near-native — no second wait at all: the settlement IS the delivery, because the funds
//                 never leave NEAR.
//   omni        — the Omni Bridge's transfer API, keyed on the settlement transaction
//                 (omni-bridge.ts, D-580).
//
// Modelling all three as returned variants rather than as skipped or swapped calls keeps the
// caller from having to know which routes cross which bridge — the switch lives here, once.
//
// Both SDK waiters run on real timers with their own internal budgets and no injectable
// clock, so they are injected wholesale instead of being wrapped — that is what makes the
// timeout paths testable without waiting minutes or touching the network.
//
// Attribution: see ATTRIBUTIONS.md #10 (PoA) and #11 (HOT).

import { poaBridge, solverRelay, IntentSettlementError } from "@defuse-protocol/internal-utils";
import { getWithdrawalEntry, type BridgeRoute } from "./withdrawal-registry";
import { waitForHotDelivery, type HotDeliveryDeps } from "./hot-delivery";
import { waitForOmniDelivery, type OmniDeliveryDeps } from "./omni-bridge";
import {
  WithdrawDeliveryUnconfirmedError,
  WithdrawError,
  WithdrawSettlementFailedError,
  WithdrawSettlementUnconfirmedError,
} from "./withdraw-errors";

/** `solverRelay.waitForIntentSettlement`, narrowed to what this module uses. */
export type SettlementWaiter = (params: {
  intentHash: string;
  signal?: AbortSignal;
  onTxHashKnown?: (txHash: string) => void;
}) => Promise<{ txHash: string; intentHash: string }>;

/** `poaBridge.waitForWithdrawalCompletion`, likewise. Its `signal` is mandatory upstream. */
export type DeliveryWaiter = (params: {
  txHash: string;
  withdrawalCriteria: { assetId: string };
  signal: AbortSignal;
}) => Promise<{ destinationTxHash: string; chain: string }>;

export type WithdrawSettlement = { txHash: string; intentHash: string };

export type WithdrawDelivery =
  /** Crossed the PoA bridge and landed on the destination chain. */
  | { kind: "bridge"; destinationTxHash: string; chain: string }
  /** `near-native`: settling on NEAR already delivered it. No bridge, nothing to wait for. */
  | { kind: "near-settlement" }
  /**
   * `hot-omni`: crossed HOT's own bridge (block 4.3.4). Separate from `bridge` because the
   * two are not interchangeable in the one way a caller cares about — HOT can confirm a
   * delivery it cannot name (`destinationTxHash: null`, see hot-delivery.ts), so folding it
   * into `bridge` would force every reader of that field to handle a null the PoA path never
   * produces. The `nonce` is what a manual re-check needs.
   */
  | { kind: "hot-bridge"; destinationTxHash: string | null; chain: string; nonce: string };

/**
 * A signal that aborts on `timeoutMs`, on the caller's own signal, or never.
 *
 * `timedOut()` exists because the abort reason alone cannot tell the two apart, and they
 * mean different things to the user: our deadline expiring is "not confirmed yet", while
 * the caller aborting is the user navigating away.
 */
function deadlineSignal(timeoutMs: number | undefined, outer: AbortSignal | undefined) {
  const controller = new AbortController();
  let expired = false;

  const timer =
    timeoutMs == null
      ? undefined
      : setTimeout(() => {
          expired = true;
          controller.abort(new Error(`timed out after ${timeoutMs}ms`));
        }, timeoutMs);

  const forward = () => controller.abort(outer?.reason);
  if (outer?.aborted) forward();
  else outer?.addEventListener("abort", forward);

  return {
    signal: controller.signal,
    timedOut: () => expired,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      outer?.removeEventListener("abort", forward);
    },
  };
}

const defaultSettlementWaiter: SettlementWaiter = (params) =>
  solverRelay.waitForIntentSettlement(params);

const defaultDeliveryWaiter: DeliveryWaiter = (params) =>
  poaBridge.waitForWithdrawalCompletion(params);

export type WaitForWithdrawSettlementParams = {
  intentHash: string;
  /**
   * Optional extra deadline. Left undefined the SDK's own budget applies (p99 = 356s,
   * tuned on production data) — an invented shorter number would only change what we
   * REPORT, never what the relay does.
   */
  timeoutMs?: number;
  signal?: AbortSignal;
  onTxHash?: (txHash: string) => void;
  waitForSettlement?: SettlementWaiter;
};

/**
 * Waits for the Verifier to execute the intent.
 *
 * Only an explicit `IntentSettlementError` — the relay saying the intent is invalid or
 * failed — is reported as a definitive failure. Everything else (deadline, abort, transport)
 * is `unconfirmed`, because a published intent we stopped watching is not a published intent
 * that did not settle.
 */
export async function waitForWithdrawSettlement(
  p: WaitForWithdrawSettlementParams
): Promise<WithdrawSettlement> {
  const wait = p.waitForSettlement ?? defaultSettlementWaiter;
  const deadline = deadlineSignal(p.timeoutMs, p.signal);
  try {
    return await wait({
      intentHash: p.intentHash,
      signal: deadline.signal,
      onTxHashKnown: (txHash) => {
        // Logged the moment it is known, like the vault paths (D-R17): the runs where this
        // hash is worth the most are the ones that never reach a final state.
        console.log(`[withdraw] settlement tx ${txHash} — https://nearblocks.io/txns/${txHash}`);
        p.onTxHash?.(txHash);
      },
    });
  } catch (e) {
    if (e instanceof IntentSettlementError) {
      throw new WithdrawSettlementFailedError(p.intentHash, e);
    }
    throw new WithdrawSettlementUnconfirmedError(
      p.intentHash,
      deadline.timedOut() ? `no settlement within ${p.timeoutMs}ms` : describeError(e),
      e
    );
  } finally {
    deadline.dispose();
  }
}

export type WaitForWithdrawDeliveryParams = {
  /** Full defuse asset id — the withdrawal-registry key. */
  tokenId: string;
  /** The route the envelope was built for; asserted against the registry. */
  route: BridgeRoute;
  /** The destination chain the envelope was built for — with `tokenId`, it names the route. */
  chainId: string;
  /** The NEAR transaction the settlement produced. */
  txHash: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  waitForDelivery?: DeliveryWaiter;
  /** The `hot-omni` seam. Unused by the other two routes, injected for the same reason. */
  hotDelivery?: HotDeliveryDeps;
  /**
   * REQUIRED on `omni`: the bridge answers with every transfer the settlement transaction
   * created, and ours is the one paying this address.
   */
  destinationAddress?: string;
  /** `omni`: the signed gross, so two same-address transfers in one tx are told apart. */
  amountRaw?: string;
  /** The `omni` seam, injected for the same reason as the other two. */
  omniDelivery?: OmniDeliveryDeps;
};

/**
 * Waits for the funds to reach the destination chain.
 *
 * Past this point EVERY failure is `left-balance`: the settlement already moved the money
 * out. So there is almost no error taxonomy here, only one honest outcome — not confirmed,
 * may still arrive. The single exception is HOT's own cancellation, which is passed through
 * rather than re-wrapped: it already carries `left-balance`, and it is the one answer here
 * that is definite instead of unobserved.
 */
export async function waitForWithdrawDelivery(
  p: WaitForWithdrawDeliveryParams
): Promise<WithdrawDelivery> {
  const entry = getWithdrawalEntry(p.tokenId, p.chainId);
  if (!entry) throw new Error(`Token ${p.tokenId} has no withdrawal route to "${p.chainId}"`);
  // Same drift guard as the envelope's chain assertion: the route decides whether we wait
  // for a bridge at all, so a stale caller-side route would report a bridged withdrawal as
  // already delivered.
  if (entry.bridgeRoute !== p.route) {
    throw new Error(
      `Withdrawal route mismatch for ${p.tokenId}: the registry says "${entry.bridgeRoute}" ` +
        `but the caller passed "${p.route}"`
    );
  }
  // Both NEAR-destination routes settle inside NEAR itself: there is no bridge to poll,
  // the intent either executed or it did not.
  if (entry.bridgeRoute === "near-native" || entry.bridgeRoute === "near-unwrap") {
    return { kind: "near-settlement" };
  }

  // `assetId` is only the PoA bridge's matching key, but it is also what the unconfirmed
  // error reports for BOTH bridged routes, so it is built before the split. On HOT it names
  // the NEP-245 contract rather than a per-token one — which is exactly right for an operator
  // re-checking by hand, since that is the contract the withdrawal burned from.
  const assetId = `nep141:${entry.nearTokenId}`;
  const deadline = deadlineSignal(p.timeoutMs, p.signal);
  try {
    if (entry.bridgeRoute === "omni") {
      if (!p.destinationAddress) {
        throw new Error(`An omni delivery wait needs the destination address (${p.txHash})`);
      }
      const omni = await waitForOmniDelivery({
        txHash: p.txHash,
        tokenAccountId: entry.nearTokenId,
        chainId: entry.chainId,
        destinationAddress: p.destinationAddress,
        amountRaw: p.amountRaw,
        signal: deadline.signal,
        deps: p.omniDelivery,
      });
      return { kind: "bridge", destinationTxHash: omni.destinationTxHash, chain: entry.chainId };
    }

    if (entry.bridgeRoute === "hot-omni") {
      const hot = await waitForHotDelivery({
        txHash: p.txHash,
        chainId: entry.chainId,
        signal: deadline.signal,
        deps: p.hotDelivery,
      });
      return {
        kind: "hot-bridge",
        destinationTxHash: hot.destinationTxHash,
        chain: entry.chainId,
        nonce: hot.nonce,
      };
    }

    // The bridge matches on `nep141:${near_token_id}` (findMatchingWithdrawal upstream), so
    // the criteria are rebuilt from the registry's own contract id rather than from the
    // caller's token id, which is the same string only as long as nobody re-keys the registry.
    const wait = p.waitForDelivery ?? defaultDeliveryWaiter;
    const completion = await wait({
      txHash: p.txHash,
      withdrawalCriteria: { assetId },
      signal: deadline.signal,
    });
    return {
      kind: "bridge",
      destinationTxHash: completion.destinationTxHash,
      chain: completion.chain,
    };
  } catch (e) {
    // A cancellation is already the right report: it says `left-balance`, and it says WHY.
    // Re-wrapping it as "not confirmed" would downgrade a definite answer into a maybe.
    if (e instanceof WithdrawError && e.fundsState === "left-balance") throw e;
    throw new WithdrawDeliveryUnconfirmedError(
      p.txHash,
      assetId,
      deadline.timedOut() ? `no delivery within ${p.timeoutMs}ms` : describeError(e),
      e
    );
  } finally {
    deadline.dispose();
  }
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
