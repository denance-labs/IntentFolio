// Orchestrates ③ Withdraw of the General Balance, end to end (005.plan §8, Phase 5, block 5.3).
// Only reachable behind NEXT_PUBLIC_REAL_WITHDRAWAL (`isRealWithdrawalRoute`).
//
//   build envelope → sign → persist the rescue record → publish → settle → deliver
//
// The vault is not in the loop: a General Balance withdrawal is signed directly against
// `intents.near` (ADR-0005, Path D). Everything network-facing is injected, so the whole
// money path is unit-testable with no wallet and no network.
//
// THE ONE THING THIS FILE EXISTS TO GET RIGHT
// `published-unconfirmed` is NOT a failure. It means the withdrawal was published — and
// possibly already settled — but we stopped watching before the delivery was observed. Two
// facts from block 5.2 make it the honest default rather than an edge case:
//
//   1. Neither SDK waiter takes an injectable clock, and `waitForWithdrawalCompletion`'s
//      `signal` is mandatory. Our `timeoutMs` bounds what we REPORT; it cancels nothing
//      server-side. So "the timeout expired" can never mean "it did not go out".
//   2. Every error out of `submitWithdraw` / the two waits carries `fundsState`
//      (`untouched` / `unknown` / `left-balance`), fixed by 5.2's test matrix. That field is
//      the single source of truth about where the money is. It is CONSUMED here, never
//      re-derived — the class name says what broke, `fundsState` says what the money is
//      doing, and only the second one may drive the copy.
//
// Hence the rule the whole module is built around: only `fundsState === "untouched"` may be
// reported as a plain failure. Everything else reaches the caller as
// `RealWithdrawUnconfirmedError`, which keeps `fundsState` so the UI cannot claim a loss
// that did not happen.

import type { VaultSigner } from "@/features/vault/lib/vault-signer";
import { getIntentsBalances } from "@/features/vault/lib/intents-read-client";
import { AmountExceedsBalanceError } from "@/features/vault/lib/base-units";
import { toIntentsTokenId } from "@/features/market/lib/intents-token-id";
import { buildWithdrawSignRequest, type SupportedWithdrawRoute } from "./withdraw-envelope";
import {
  submitWithdraw,
  type NearDestinationProbe,
  type WithdrawPublisher,
} from "./withdraw-submit";
import {
  waitForWithdrawDelivery,
  waitForWithdrawSettlement,
  type DeliveryWaiter,
  type SettlementWaiter,
  type WithdrawDelivery,
} from "./withdraw-poll";
import type { HotDeliveryDeps } from "./hot-delivery";
import type { HotFeeDetail } from "./hot-fee";
import { WithdrawError, type WithdrawFundsState } from "./withdraw-errors";
import { recordPendingWithdraw, updateWithdrawRecord } from "./withdraw-record-sink";
import { nonceToBase64 } from "./withdraw-publication-check";

export type RealWithdrawStage =
  | "preparing"
  | "signing"
  | "publishing"
  | "awaiting-settlement"
  /** Only for routes that actually cross the bridge; `near-native` skips it. */
  | "awaiting-delivery"
  | "delivered"
  // Published (and possibly settled) without an observed delivery. NOT a failure: the funds
  // may be in flight. The rescue record keeps the handle to re-check with.
  | "published-unconfirmed";

export type RealWithdrawResult = {
  /** Rescue-store id — the handle for following this withdrawal after the fact. */
  recordId: string;
  intentHash: string;
  /** The NEAR settlement transaction. */
  txHash: string;
  route: SupportedWithdrawRoute;
  /** Base units actually withdrawn, as signed. */
  amount: string;
  delivery: WithdrawDelivery;
};

/**
 * Published, not confirmed delivered. The withdrawal twin of `RealAllocateUnconfirmedError`.
 *
 * Extends `WithdrawError` so `fundsState` survives the wrap: callers branch on that, not on
 * the class (withdraw-errors.ts). The original stays reachable through `cause`, and the
 * message is reused verbatim rather than re-worded — 5.2 already phrased these without
 * claiming a loss, and re-wording them here is exactly how that guarantee gets lost.
 */
export class RealWithdrawUnconfirmedError extends WithdrawError {
  constructor(
    message: string,
    fundsState: WithdrawFundsState,
    /** Null only if no record could be established — see the guard after the publish. */
    readonly recordId: string | null,
    readonly intentHash: string | null,
    readonly txHash: string | null,
    cause?: unknown
  ) {
    super(message, fundsState, cause);
    this.name = "RealWithdrawUnconfirmedError";
  }
}

export type RunRealWithdrawParams = {
  /** The INTENTS account id: `alice.near`, or the lowercase `0x…` derived from a non-NEAR login. */
  accountId: string;
  /** Full defuse asset id — the withdrawal-registry key. */
  tokenId: string;
  /**
   * Destination chain. With `tokenId` it picks the route among the ones the registry offers
   * (an `omft` token can also go to NEAR, D-384); the builder refuses any other.
   */
  chainId: string;
  /** Human units, as the modal collects them. */
  qty: number;
  destinationAddress: string;
  /** Destination tag, for chains that route on one. Threaded to the envelope AND the submit. */
  destinationMemo?: string;
  /**
   * REQUIRED on `hot-omni`, meaningless elsewhere — forwarded to `buildWithdrawSignRequest`
   * unchanged. See `BuildWithdrawParams.hotFee` (withdraw-envelope.ts) for why it is a
   * parameter rather than a lookup: it is SIGNED, so it has to be the exact quote the screen
   * showed, not one fetched again here.
   */
  hotFee?: HotFeeDetail;
  /** Signs in the login family's own scheme and assembles the MultiPayload. */
  signer: VaultSigner;
  onStage?: (stage: RealWithdrawStage) => void;
  /**
   * The rescue-store id, the instant it exists — after the signature, before the publish.
   *
   * `RealWithdrawResult.recordId` only arrives at the end, and a UI that keyed its in-flight
   * row on something else would show that row TWICE after a reload: once from memory, once
   * from the worklist. Handing the id over here is what keeps the row the user is watching
   * and the durable record the same withdrawal.
   */
  onRecordId?: (recordId: string) => void;
  /**
   * The settlement transaction, the instant it is observed — before the bridge delivers. A
   * tracked row that learns the hash only at delivery shows the chain's burn as a second
   * withdrawal in between (My Account's join is by this hash, 028-7).
   */
  onSettled?: (txHash: string) => void;
  /** Envelope tuning; injectable so tests are deterministic. */
  envelope?: { deadlineSecs?: number; nonce?: Uint8Array };
  /**
   * Set when the UI already ran the `near-native` destination pre-flight, before the click
   * that opens the wallet prompt. See `destinationAlreadyVerified` in withdraw-submit.ts for
   * why the check moves rather than disappears.
   */
  destinationAlreadyVerified?: boolean;
  /** Network seams, all injectable — nothing here may reach the network in a test. */
  publish?: WithdrawPublisher;
  probe?: NearDestinationProbe;
  waitForSettlement?: SettlementWaiter;
  waitForDelivery?: DeliveryWaiter;
  /** The `hot-omni` delivery seam (4.3.4). Same contract: no test may reach the network. */
  hotDelivery?: HotDeliveryDeps;
  /**
   * Extra deadlines on the two waits.
   *
   * ⚠️ They bound what we REPORT and nothing else: the relay and the bridge keep working
   * after they expire (5.2). Left undefined, each SDK waiter applies its own budget.
   */
  timeouts?: { settlementMs?: number; deliveryMs?: number };
  /** The caller navigating away. Distinct from a deadline — see `deadlineSignal` in the poll. */
  signal?: AbortSignal;
  /** The exact balance the amount is capped against (D-303). Injectable like the seams above. */
  readHeld?: (accountId: string, tokenId: string) => Promise<bigint>;
};

/**
 * How long the balance read may take inside the click. On `omft` it runs AFTER the modal's
 * fee re-check (up to 1.2 s, `FEE_RECHECK_BUDGET_MS`), and the browser drops the wallet popup
 * ~5 s after the click — so a slow RPC must end in an error the user can retry, not in a
 * popup that silently never opens. 1.2 + 2.5 leaves over a second for the rest.
 */
export const HELD_READ_BUDGET_MS = 2_500;

export class HeldReadTimeoutError extends Error {
  constructor() {
    super("Reading your balance took too long; nothing was signed. Please try again.");
    this.name = "HeldReadTimeoutError";
  }
}

/**
 * The balance read failed outright — the RPC answered with an error rather than slowly. Typed so
 * the modal can say so in the user's language (D-304 a); nothing was signed either way.
 */
export class HeldReadFailedError extends Error {
  constructor(readonly cause: unknown) {
    super(`Could not read your balance (${describeError(cause)}); nothing was signed. Please try again.`);
    this.name = "HeldReadFailedError";
  }
}

/** The default `readHeld`. Shared with the Converting Withdrawal, which reads inside the same click. */
export async function readHeldOnVerifier(accountId: string, tokenId: string): Promise<bigint> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HeldReadTimeoutError()), HELD_READ_BUDGET_MS);
  });
  try {
    const read = getIntentsBalances(accountId, [toIntentsTokenId(tokenId)]);
    const [held] = await Promise.race([read, budget]);
    return held;
  } finally {
    clearTimeout(timer);
  }
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function runRealWithdraw(p: RunRealWithdrawParams): Promise<RealWithdrawResult> {
  const stage = p.onStage ?? (() => {});
  stage("preparing");

  // The one read before the builder: the exact balance the amount is capped against, so a
  // withdrawal never asks for more than the account holds (D-303) — as last finalized: a
  // spend of the same token still in flight is not subtracted, and then the Verifier refuses
  // the whole intent (nothing moves). It sits inside the click with a budget of its own
  // (`HELD_READ_BUDGET_MS`); a failed or slow read throws, and nothing is signed.
  //
  // D-305: on `native-balance` the relayer's gas leaves as a second `mt_withdraw` entry, out
  // of the chain's native token, and the quote only knew that balance from the screen. So it
  // is read here too, in parallel. It cannot be capped — the relayer needs the whole fee — so
  // a native that no longer covers it refuses before signing. Withdrawing the native itself
  // has no second entry (`withFee`, hot-envelope.ts), so it keeps the single read and cap.
  const gasFee =
    p.hotFee?.payment === "native-balance" && p.tokenId !== p.hotFee.nativeAssetId
      ? p.hotFee
      : null;
  const readHeld = p.readHeld ?? readHeldOnVerifier;
  let heldRaw: bigint;
  let nativeHeldRaw: bigint | null;
  try {
    [heldRaw, nativeHeldRaw] = await Promise.all([
      readHeld(p.accountId, p.tokenId),
      gasFee ? readHeld(p.accountId, gasFee.nativeAssetId) : null,
    ]);
  } catch (e) {
    if (e instanceof HeldReadTimeoutError) throw e;
    throw new HeldReadFailedError(e);
  }
  if (gasFee && nativeHeldRaw !== null && nativeHeldRaw < BigInt(gasFee.relayerFeeRaw)) {
    throw new AmountExceedsBalanceError(BigInt(gasFee.relayerFeeRaw), nativeHeldRaw);
  }

  // Offline: every guard the builder carries (chain vs registry, unsupported route, amount
  // under the bridge minimum, rounds-to-zero) fires here, before a wallet is ever asked.
  const request = buildWithdrawSignRequest({
    signerId: p.accountId,
    tokenId: p.tokenId,
    chainId: p.chainId,
    qty: p.qty,
    heldRaw,
    destinationAddress: p.destinationAddress,
    destinationMemo: p.destinationMemo,
    hotFee: p.hotFee,
    ...p.envelope,
  });

  // A holder, not a `let`: the id is assigned inside the signer callback below, and a plain
  // local would be narrowed to `null` by control-flow analysis that cannot see into it.
  const rescue: { id: string | null } = { id: null };
  const track = (patch: Parameters<typeof updateWithdrawRecord>[1]) => {
    if (rescue.id !== null) updateWithdrawRecord(rescue.id, patch);
  };

  stage("signing");
  let submitted;
  try {
    submitted = await submitWithdraw({
      request,
      tokenId: p.tokenId,
      chainId: p.chainId,
      destinationAddress: p.destinationAddress,
      destinationMemo: p.destinationMemo,
      destinationAlreadyVerified: p.destinationAlreadyVerified,
      publish: p.publish,
      probe: p.probe,
      signer: {
        scheme: p.signer.scheme,
        signEnvelope: async (req) => {
          const payload = await p.signer.signEnvelope(req);
          // ── D-190: the trace is written HERE — after the signature, immediately before
          // the publish that `submitWithdraw` does next. Writing it after the publish would
          // miss the window where the request goes out and the answer never comes back,
          // which is precisely the case with no other trace. See withdraw-rescue-store.ts
          // for why this is not the Allocate moment (before signing).
          //
          // It THROWS if it cannot persist, which aborts before the publish. That costs one
          // discarded signature — free, nothing has moved — and buys never publishing a
          // withdrawal we could not record.
          rescue.id = recordPendingWithdraw({
            signerId: p.accountId,
            tokenId: p.tokenId,
            amount: request.amount,
            qty: p.qty,
            route: request.route,
            chainId: p.chainId,
            destinationAddress: p.destinationAddress,
            destinationMemo: p.destinationMemo,
            nonce: nonceToBase64(request.nep413.nonce),
            deadline: request.deadlineSecs * 1000,
          }, payload);
          p.onRecordId?.(rescue.id);
          stage("publishing");
          return payload;
        },
      },
    });
  } catch (e) {
    // 5.2 fixes `fundsState` on every error this call can produce. An error WITHOUT one did
    // not come from the published path — nothing after the signature throws untyped — so it
    // is the pre-publish case and the balance is intact.
    const fundsState = e instanceof WithdrawError ? e.fundsState : "untouched";
    if (fundsState === "untouched") {
      // Definitive and safe. Resolving the record keeps a rejected publish OFF the worklist,
      // which is what stops the worklist filling with withdrawals that never moved.
      track({ status: "failed", error: describeError(e) });
      throw e;
    }
    // Unknown: the relay may have taken it before the connection died. The record stays
    // UNRESOLVED — that is the whole point of having written it before publishing.
    track({ error: describeError(e) });
    stage("published-unconfirmed");
    throw new RealWithdrawUnconfirmedError(
      describeError(e),
      fundsState,
      rescue.id,
      null,
      null,
      e
    );
  }

  const recordId = rescue.id;
  if (recordId === null) {
    // Structurally impossible: `submitWithdraw` awaits the signer callback that writes the
    // record before it publishes. Reported as unconfirmed and never as a failure, because by
    // this line the intent IS published — the honest statement is "no local trace", not
    // "it did not go out".
    stage("published-unconfirmed");
    throw new RealWithdrawUnconfirmedError(
      `Withdrawal ${submitted.intentHash} was published but no rescue record was written`,
      "unknown",
      null,
      submitted.intentHash,
      null
    );
  }
  updateWithdrawRecord(recordId, { status: "published", intentHash: submitted.intentHash });

  stage("awaiting-settlement");
  let settlement;
  // The tx hash can be known before the settlement is confirmed, and that half-knowledge is
  // worth keeping: it is what an operator follows on the explorer when the wait times out.
  let observedTxHash: string | null = null;
  try {
    settlement = await waitForWithdrawSettlement({
      intentHash: submitted.intentHash,
      timeoutMs: p.timeouts?.settlementMs,
      signal: p.signal,
      waitForSettlement: p.waitForSettlement,
      // Recorded the moment the relay reveals it, NOT when the wait resolves. The STATUS is
      // deliberately left alone: a known tx hash is not an observed settlement, and marking
      // the record `settled` here would assert the funds left the balance on weaker evidence
      // than 5.2's `fundsState` allows.
      onTxHash: (txHash) => {
        observedTxHash = txHash;
        updateWithdrawRecord(recordId, { txHash });
      },
    });
  } catch (e) {
    const fundsState = e instanceof WithdrawError ? e.fundsState : "unknown";
    if (fundsState === "untouched") {
      // The Verifier declared the intent invalid or failed: it did not execute, so the
      // balance is intact and the same amount can be re-signed. 5.2's matrix says so — this
      // line does not decide it.
      updateWithdrawRecord(recordId, { status: "failed", error: describeError(e) });
      throw e;
    }
    stage("published-unconfirmed");
    updateWithdrawRecord(recordId, { error: describeError(e) });
    throw new RealWithdrawUnconfirmedError(
      describeError(e),
      fundsState,
      recordId,
      submitted.intentHash,
      observedTxHash,
      e
    );
  }
  updateWithdrawRecord(recordId, { status: "settled", txHash: settlement.txHash });
  p.onSettled?.(settlement.txHash);

  // `near-native` settles and delivers in the same transaction, so there is no bridge to
  // wait for and announcing one would be a spinner for an event that never happens. Both
  // bridged routes DO have one — `hot-omni` since 4.3.4, which is why this is a negation and
  // no longer an `omft` test.
  if (submitted.route !== "near-native") stage("awaiting-delivery");

  let delivery: WithdrawDelivery;
  try {
    delivery = await waitForWithdrawDelivery({
      tokenId: p.tokenId,
      route: submitted.route,
      chainId: p.chainId,
      txHash: settlement.txHash,
      timeoutMs: p.timeouts?.deliveryMs,
      signal: p.signal,
      waitForDelivery: p.waitForDelivery,
      hotDelivery: p.hotDelivery,
    });
  } catch (e) {
    // Past the settlement EVERY failure is `left-balance`, and this is the one catch that
    // does NOT read `fundsState` off the error. Not an oversight: `waitForWithdrawDelivery`
    // also throws pre-wait guard errors (route mismatch, unknown token) that are classified
    // `untouched` because they normally fire before anything is signed. Firing here they
    // would repeat that claim AFTER the money left the balance.
    stage("published-unconfirmed");
    updateWithdrawRecord(recordId, { error: describeError(e) });
    throw new RealWithdrawUnconfirmedError(
      describeError(e),
      "left-balance",
      recordId,
      submitted.intentHash,
      settlement.txHash,
      e
    );
  }

  updateWithdrawRecord(recordId, {
    status: "delivered",
    // `hot-bridge` can confirm a delivery without naming a transaction, and that is recorded
    // as no hash rather than as no delivery — `?? undefined` and not a falsy test, so an
    // empty string can never masquerade as "the bridge did not answer".
    destinationTxHash:
      delivery.kind === "near-settlement" ? undefined : delivery.destinationTxHash ?? undefined,
  });
  stage("delivered");

  return {
    recordId,
    intentHash: submitted.intentHash,
    txHash: settlement.txHash,
    route: submitted.route,
    amount: request.amount,
    delivery,
  };
}
