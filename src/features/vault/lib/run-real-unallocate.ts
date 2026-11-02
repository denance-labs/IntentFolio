// Orchestrates `commit_portfolio_changes` against the LIVE vault, end to end.
//
//   ③ Unallocate (007.plan Phase 2) — funds go back from the portfolio to the General
//     Balance, closing the round-trip;
//   composition edits (008.plan Phase 2) — retarget / add / remove, alone or riding the
//     same signature as a withdrawal.
//
//   fold + validate against the chain's composition → read the position on-chain →
//   submit (sign + commit_portfolio_changes) → deferred? report it : composition-only?
//   done : poll the vault ledger until it settles → report what remains
//
// THE AMOUNTS COME FROM THE CHAIN, NOT FROM THE UI. The editor works in human units
// (floats); the contract needs exact base units. Converting the user's float and sending
// that would either overshoot (E_INSUFFICIENT_PORTFOLIO_BALANCE — the whole commit
// reverts) or undershoot and leave a permanent dust remainder that no "withdraw all" can
// ever clear. So a full withdrawal sends the `get_portfolio_balance` bigint verbatim.
//
// This module does NOT enforce maturity. The countdown is a UI courtesy built on a
// locally derived clock; if that clock were wrong or missing, hard-blocking here would
// trap a user's funds behind a bug of ours. The chain is the real gate, and its way of
// saying no — a defer — is safe and retryable, so we let it answer.

import { getTokenById } from "@/features/market/lib/token-registry";
import { capToHeld, fromBaseUnits, toBaseUnits } from "./base-units";
import {
  getPendingUnallocation,
  getPortfolio,
  getPortfolioPositions,
} from "./vault-read-client";
import {
  ChangeSetPreflightError,
  pctToBps,
  resultingComposition,
  type CompositionRowBps,
} from "./change-set-preflight";
import { waitForCompositionCommit } from "./composition-poll";
import { loadPreflightLimits } from "./vault-limits";
import { RealChangeSetInvalidError, RealUnallocateTransferFailedError } from "./vault-errors";
import type { TokenCompositionInput } from "./vault-payloads";
import { submitUnallocate } from "./unallocate-submit";
import { waitForUnallocateSettlement } from "./unallocate-poll";
import { toIntentsTokenId, toRegistryTokenId } from "@/features/market/lib/intents-token-id";
import { resolveEnvelopeSubmitter, type WalletSubmitCapability } from "./envelope-submitter";
import type { EnvelopeSubmitter } from "./relay-types";
import type { VaultSigner } from "./vault-signer";
import type { VaultChainKind } from "./vault-payloads";

export type RealUnallocateStage =
  | "preparing"
  | "signing"
  | "submitting"
  | "awaiting-settlement"
  | "settled"
  // The vault refused for now: the position has not matured. Nothing moved, nothing was
  // consumed — the same withdrawal can be signed again after `nextReleaseAt`.
  | "deferred"
  // Submitted and accepted, but the settlement was not observed in time. The funds are
  // still in the portfolio; this is a retry, never a loss.
  | "pending-unconfirmed";

/** What the user asked to withdraw, in the editor's human units. */
export type UnallocateRequest = { tokenId: string; qty: number };

/**
 * Composition edits in the EDITOR's units (percent), converted to basis points here.
 * Keeping the conversion on this side of the seam means every contract-shaped number in
 * the whole flow is produced in one place, next to the validator that checks it.
 */
export type CompositionEdits = {
  targetChanges?: Array<{ tokenId: string; targetPct: number; tolerancePct: number }>;
  /** An addition carries its target (FE #6). Absent = 0%. */
  tokenAdditions?: Array<{ tokenId: string; targetPct?: number; tolerancePct: number }>;
  tokenRemovals?: string[];
};

export type RealUnallocateResult =
  | {
      kind: "settled";
      txHash: string | null;
      /** Human units still held by the portfolio, per token, after settlement. */
      remaining: Record<string, number>;
    }
  | {
      /** Composition-only commit: applied synchronously, no funds moved, nothing to poll. */
      kind: "committed";
      txHash: string | null;
    }
  | {
      kind: "deferred";
      txHash: string | null;
      /** Unix seconds — the contract's own deadline, not our derived one. */
      nextReleaseAt: number;
      tokenId: string;
    };

export class RealUnallocateUnconfirmedError extends Error {
  constructor(
    message: string,
    readonly txHash: string | null,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = "RealUnallocateUnconfirmedError";
  }
}

export type RunRealUnallocateParams = {
  /** The INTENTS account id: `alice.near`, or the lowercase `0x…` derived from an EVM login. */
  accountId: string;
  portfolioId: string; // the REAL on-chain id (D-R6)
  requests: UnallocateRequest[];
  /** Composition edits riding the same signature (008.plan Phase 2). */
  composition?: CompositionEdits;
  /** Signs in the login family's own scheme. */
  signer: VaultSigner;
  /**
   * The login family. Unlike the Allocate leg this never reaches the contract as data — a
   * commit carries no `login_wallet` — but it still decides who submits.
   */
  loginChain: VaultChainKind;
  /** The NEAR wallet, for the self-submit path only. Null for every other family. */
  nearWallet?: WalletSubmitCapability | null;
  /** Who sends the signed envelope; defaults per login family (see `resolveEnvelopeSubmitter`). */
  submit?: EnvelopeSubmitter;
  onStage?: (stage: RealUnallocateStage) => void;
  /** Settlement-poll tuning; injectable so the timeout path is testable without waiting. */
  poll?: {
    timeoutMs?: number;
    intervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
    /** Injectable clock — lets a test reach a timeout without waiting for one. */
    now?: () => number;
  };
};

/**
 * Percent → basis points, once, for all three lists. An addition's target passes through as
 * given (0% when absent, FE #6).
 */
function toCompositionEditsBps(edits: CompositionEdits | undefined): {
  targetChanges: TokenCompositionInput[];
  tokenAdditions: TokenCompositionInput[];
  tokenRemovals: string[];
} {
  return {
    targetChanges: (edits?.targetChanges ?? []).map((c) => ({
      tokenId: c.tokenId,
      targetBps: pctToBps(c.targetPct),
      toleranceBps: pctToBps(c.tolerancePct),
    })),
    tokenAdditions: (edits?.tokenAdditions ?? []).map((a) => ({
      tokenId: a.tokenId,
      targetBps: pctToBps(a.targetPct ?? 0),
      toleranceBps: pctToBps(a.tolerancePct),
    })),
    tokenRemovals: edits?.tokenRemovals ?? [],
  };
}

/**
 * What each token of the portfolio holds and how much of it a new withdrawal may take
 * (`get_portfolio_positions`): a withdrawal still in flight locks part of the position, and
 * asking for more than `available` would be refused, so Max caps at `available` (017-9a).
 */
async function readWithdrawable(
  portfolioId: string
): Promise<{ held: Map<string, bigint>; available: Map<string, bigint> }> {
  const positions = await getPortfolioPositions(portfolioId);
  if (!positions) throw new Error(`The vault does not know portfolio ${portfolioId}`);
  return {
    held: new Map(positions.map((pos) => [pos.tokenId, pos.qtyHeld])),
    available: new Map(positions.map((pos) => [pos.tokenId, pos.available])),
  };
}

/**
 * `get_pending_unallocation(commit_id) == null`: the batch resolved (settled or failed) or was
 * never opened. A read that throws counts as "not yet" — the poll's own timeout bounds it.
 *
 * Residual, accepted: the view reads at final finality and can lag the outcome by a block or
 * two, so a first read may answer null before the opening is final. The balance rule still has
 * to agree, so that window is only as wrong as the balance rule alone.
 */
function batchResolvedReader(commitId: string): () => Promise<boolean> {
  return async () => (await getPendingUnallocation(commitId)) === null;
}

/** Registry id → contract id on one composition row; see intents-token-id.ts. */
function toIntentsComposition(row: TokenCompositionInput): TokenCompositionInput {
  return { ...row, tokenId: toIntentsTokenId(row.tokenId) };
}

export async function runRealUnallocate(
  p: RunRealUnallocateParams
): Promise<RealUnallocateResult> {
  const stage = p.onStage ?? (() => {});
  stage("preparing");

  const edits = toCompositionEditsBps(p.composition);
  const hasEdits =
    edits.targetChanges.length > 0 ||
    edits.tokenAdditions.length > 0 ||
    edits.tokenRemovals.length > 0;
  if (p.requests.length === 0 && !hasEdits) {
    throw new Error("Real commit needs at least one token or one composition change");
  }

  // Fold the edits onto the composition AS THE CHAIN HOLDS IT, not as the editor believes
  // it to be. A stale read-model would otherwise produce a change set the vault rejects
  // (`E_INVALID_COMPOSITION`) after the user has already signed — and the presence rules
  // (retarget/remove need the token present, add needs it absent) are exactly the ones a
  // stale copy gets wrong.
  // Kept, not discarded: this is exactly what the chain must report once the commit lands,
  // so the composition-only confirmation below polls for it instead of guessing.
  let expectedComposition: CompositionRowBps[] | null = null;
  if (hasEdits) {
    const [portfolio, limits] = await Promise.all([getPortfolio(p.portfolioId), loadPreflightLimits()]);
    if (!portfolio) throw new Error(`The vault does not know portfolio ${p.portfolioId}`);
    try {
      expectedComposition = resultingComposition(
        portfolio.composition.map((c) => ({
          tokenId: c.token_id,
          targetBps: c.target_bps,
          toleranceBps: c.tolerance_bps,
        })),
        { ...edits, unallocations: [] },
        limits
      );
    } catch (e) {
      // Re-thrown as the editor's own type so the confirm modal can show WHY, instead of
      // the wallet-error copy that would misdescribe a change nothing has tried to sign.
      if (e instanceof ChangeSetPreflightError) {
        throw new RealChangeSetInvalidError(e.reason, e.detail);
      }
      throw e;
    }
  }

  // `heldBefore` travels with the leg so the settlement poll can compute the expected
  // remainder without reaching back for a Map that only exists when there are legs.
  // Same two-id shape as the allocate path: `tokenId` is ours (it indexes `held`, the
  // settlement poll and the maturity clock, all of which speak registry ids), while
  // `intentsTokenId` is the one the change set puts on the wire.
  const legs: Array<{
    tokenId: string;
    intentsTokenId: string;
    amount: string;
    decimals: number;
    heldBefore: bigint;
  }> = [];
  if (p.requests.length > 0) {
    const { held, available } = await readWithdrawable(p.portfolioId);

    for (const request of p.requests) {
      const token = getTokenById(request.tokenId);
      if (!token) throw new Error(`Unknown token ${request.tokenId}`);
      const onChain = available.get(request.tokenId) ?? BigInt(0);
      if (onChain === BigInt(0)) {
        // The vault can hold the token with all of it locked by a withdrawal in flight.
        throw new Error(`The vault holds no ${token.symbol} for this portfolio that can be withdrawn`);
      }

      // "Withdraw everything" must send the on-chain bigint verbatim — see the header. The
      // float round-trip is only trusted for a genuinely partial amount: Max lands within
      // float noise of `onChain` on EITHER side, and `capToHeld` turns the side below into
      // the exact figure too (D-313). Above is capped silently, unlike the General Balance
      // withdrawal: the Solver moves a portfolio's quantities, so a Max read a moment ago
      // can sit above the chain without anyone having made a mistake.
      const requested = BigInt(toBaseUnits(request.qty, token.decimals));
      const amount = requested >= onChain ? onChain : capToHeld(requested, onChain);
      if (amount === BigInt(0)) {
        throw new Error(`Withdrawal of ${token.symbol} rounds to zero base units`);
      }
      legs.push({
        tokenId: request.tokenId,
        intentsTokenId: toIntentsTokenId(request.tokenId),
        amount: amount.toString(),
        decimals: token.decimals,
        // The whole position, locked part included: what the settlement poll subtracts from.
        heldBefore: held.get(request.tokenId) ?? onChain,
      });
    }
  }

  stage("signing");
  const submitted = await submitUnallocate({
    signerId: p.accountId,
    portfolioId: p.portfolioId,
    // The change set crosses to the contract, so every id in it is converted here. The
    // folding above ran in registry space on purpose — it compares against the composition
    // as the chain holds it, which `getPortfolio` already translated back for us.
    legs: legs.map((l) => ({ tokenId: l.intentsTokenId, amount: l.amount })),
    targetChanges: edits.targetChanges.map(toIntentsComposition),
    tokenAdditions: edits.tokenAdditions.map(toIntentsComposition),
    tokenRemovals: edits.tokenRemovals.map(toIntentsTokenId),
    signer: {
      scheme: p.signer.scheme,
      signEnvelope: async (req) => {
        const payload = await p.signer.signEnvelope(req);
        stage("submitting");
        return payload;
      },
    },
    submit:
      p.submit ??
      resolveEnvelopeSubmitter({ loginChain: p.loginChain, wallet: p.nearWallet ?? null }),
  });

  // Deferred: the tx succeeded but the vault mutated nothing; the event carries the deadline.
  if (submitted.deferred) {
    // The event carries the CONTRACT's id; the caller indexes by ours.
    const deferredTokenId = toRegistryTokenId(submitted.deferred.token);
    stage("deferred");
    return {
      kind: "deferred",
      txHash: submitted.txHash,
      nextReleaseAt: submitted.deferred.nextReleaseAt,
      tokenId: deferredTokenId,
    };
  }

  if (submitted.failure) {
    // The batch transfer reverted and the locks were released — funds untouched.
    throw new RealUnallocateTransferFailedError(submitted.failure);
  }

  // Composition-only: `apply_commit` wrote the new composition and returned before opening
  // any pending. There is no transfer in flight, so there is nothing to SETTLE — but there
  // is still something to CONFIRM. Returning here as soon as the relayer had submitted was
  // the bug: the caller invalidates the vault read-model immediately after, that refetch
  // raced the chain and cached the PRE-commit composition, and `staleTime` then held the
  // stale copy — so a saved change looked lost until a manual reload (008.plan Phase 2).
  //
  // Best-effort by construction: `waitForCompositionCommit` resolves false on timeout
  // instead of throwing. The commit is already on-chain either way; only the moment we
  // re-read is in question, and a false "failed" here would be the worse lie.
  //
  // A commit the relayer could not confirm (`submitUncertain`, D-329) goes through the same
  // polls — they read the chain's state, which is the only honest judge of whether it landed —
  // but here an unseen composition is NOT a success: it ends "not confirmed", never "saved".
  if (legs.length === 0) {
    if (expectedComposition) {
      stage("awaiting-settlement");
      const seen = await waitForCompositionCommit({
        portfolioId: p.portfolioId,
        expected: expectedComposition,
        ...p.poll,
      });
      if (!seen && submitted.submitUncertain !== undefined) {
        stage("pending-unconfirmed");
        throw new RealUnallocateUnconfirmedError(submitted.submitUncertain, submitted.txHash);
      }
    }
    stage("settled");
    return { kind: "committed", txHash: submitted.txHash };
  }

  stage("awaiting-settlement");
  let remainingBalances: Array<[string, bigint]>;
  try {
    remainingBalances = await waitForUnallocateSettlement({
      portfolioId: p.portfolioId,
      legs: legs.map((l) => ({
        tokenId: l.tokenId,
        expectedRemaining: l.heldBefore - BigInt(l.amount),
      })),
      // The vault names our batch (D-379). A commit whose outcome did not carry the event (a
      // relay answer that proved nothing) keeps the balance rule alone.
      ...(submitted.commitId
        ? { batchResolved: batchResolvedReader(submitted.commitId) }
        : {}),
      ...p.poll,
    });
  } catch (e) {
    stage("pending-unconfirmed");
    throw new RealUnallocateUnconfirmedError(
      e instanceof Error ? e.message : String(e),
      submitted.txHash,
      e
    );
  }

  const remaining: Record<string, number> = {};
  for (const [tokenId, amount] of remainingBalances) {
    const decimals = getTokenById(tokenId)?.decimals;
    if (decimals === undefined) continue; // a token we cannot price is not renderable
    remaining[tokenId] = fromBaseUnits(amount, decimals);
  }

  stage("settled");
  return { kind: "settled", txHash: submitted.txHash, remaining };
}
