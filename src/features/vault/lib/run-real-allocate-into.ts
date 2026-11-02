// Orchestrates `AllocateOp::AllocateInto` against the LIVE vault: new funds from the General
// Balance into a portfolio the signer already owns (D-321, 013.plan B1).
//
//   read the portfolio + the General Balance (one round trip) → pre-flight against the chain
//   → submit (sign + execute_intents) → poll the vault's idempotency seal.
//
// Same envelope and the same two safety gates as the Setup Allocate (`submitAllocate`); what
// differs is what can strand funds and how the credit is confirmed:
//
//   - Everything `on_auth` refuses is an ORPHAN, not a rejection: the Transfer has already
//     settled. For AllocateInto that includes a portfolio that is gone or not the signer's, a
//     composition addition that no longer folds, and a `held_tokens` list with no room left.
//     So each of those is checked against the chain before anything is signed.
//   - There is no new portfolio to find by diffing, and the Solver trades the tokens of this
//     one, so the credit is confirmed by the seal (see `waitForAllocateSeal`).
//
// A timeout is NOT a failure, exactly as in `run-real-allocate.ts`: the rescue record is what
// recovers the funds, and the error carries that distinction to the UI.

import { getTokenById } from "@/features/market/lib/token-registry";
import { toIntentsTokenId } from "@/features/market/lib/intents-token-id";
import { capToHeld, fromBaseUnits, toBaseUnits } from "./base-units";
import {
  assertAllocateIntoFits,
  assertAllocationLegIds,
  ChangeSetPreflightError,
  pctToBps,
  resultingComposition,
} from "./change-set-preflight";
import { waitForAllocateSeal, type WaitForSealParams } from "./allocate-poll";
import { submitAllocate } from "./allocate-submit";
import { getIntentsBalances } from "./intents-read-client";
import { getPortfolio } from "./vault-read-client";
import { loadPreflightLimits } from "./vault-limits";
import { resolveEnvelopeSubmitter, type WalletSubmitCapability } from "./envelope-submitter";
import { RealChangeSetInvalidError } from "./vault-errors";
import { parseVaultErrorCode } from "./vault-error-code";
import { RealAllocateUnconfirmedError, type RealAllocateStage } from "./run-real-allocate";
import type { EnvelopeSubmitter } from "./relay-types";
import type { VaultSigner } from "./vault-signer";
import type { TokenCompositionInput, VaultChainKind } from "./vault-payloads";

export type RealAllocateIntoResult = {
  recordId: string;
  txHash: string | null;
  /**
   * Human units per funded token. Taken from the signed legs, not read back: the seal proves
   * the msg was applied, and `credit_portfolio` credits exactly the amounts the msg names.
   */
  credited: Array<{ tokenId: string; qty: number }>;
};

export type RunRealAllocateIntoParams = {
  /** The INTENTS account id: `alice.near`, or the lowercase `0x…` derived from an EVM login. */
  accountId: string;
  /** The REAL on-chain id (D-R6). */
  portfolioId: string;
  /** Shown by the rescue record and the pending notice; not part of the signed msg. */
  portfolioName: string;
  /** Registry ids, human units. At least one. */
  allocations: Array<{ tokenId: string; qty: number }>;
  /**
   * Tokens the user wants in the composition, joining at 0% (rule 2, §7.1). Filtered against
   * the composition as the CHAIN holds it: one already there is dropped rather than sent as an
   * addition the vault would refuse — inside `on_auth`, i.e. as an orphan.
   */
  tokenAdditions?: Array<{ tokenId: string; tolerancePct: number }>;
  signer: VaultSigner;
  /** Decides who submits. Unlike Setup it never reaches the msg: AllocateInto has no `login_wallet`. */
  loginChain: VaultChainKind;
  /** The NEAR wallet, for the self-submit path only. Null for every other family. */
  nearWallet?: WalletSubmitCapability | null;
  submit?: EnvelopeSubmitter;
  onStage?: (stage: RealAllocateStage) => void;
  /** Seal-poll tuning; injectable so the timeout path is testable without waiting. */
  poll?: Pick<WaitForSealParams, "timeoutMs" | "intervalMs" | "sleep" | "now" | "readSeal">;
};

export async function runRealAllocateInto(
  p: RunRealAllocateIntoParams
): Promise<RealAllocateIntoResult> {
  const stage = p.onStage ?? (() => {});
  stage("preparing");

  if (p.allocations.length === 0) throw new Error("Real allocate needs at least one allocation");

  // Same two-id shape as `run-real-allocate.ts`: `tokenId` is ours, `intentsTokenId` is the
  // only one that crosses the wire.
  const legs: Array<{ tokenId: string; intentsTokenId: string; amount: string; decimals: number }> =
    [];
  const seen = new Set<string>();
  for (const allocation of p.allocations) {
    const token = getTokenById(allocation.tokenId);
    if (!token) throw new Error(`Unknown token ${allocation.tokenId}`);
    if (seen.has(allocation.tokenId)) {
      throw new Error(`Duplicate token in allocation: ${allocation.tokenId}`);
    }
    seen.add(allocation.tokenId);
    const amount = toBaseUnits(allocation.qty, token.decimals);
    if (amount === "0") {
      throw new Error(`Real allocate amount for ${token.symbol} rounds to zero base units`);
    }
    legs.push({
      tokenId: allocation.tokenId,
      intentsTokenId: toIntentsTokenId(allocation.tokenId),
      amount,
      decimals: token.decimals,
    });
  }

  // One round trip, inside the click: the portfolio for the pre-flight and the General Balance
  // for the cap (D-303). With the salt and the ops record that is three before the wallet
  // opens — the same count as Setup, whose snapshot this path does not need. A failed read
  // throws: no pre-flight, no cap, no signature. The vault's limits ride the same round trip
  // (vault-limits.ts: `get_config`, read once per page load).
  const [portfolio, held, limits] = await Promise.all([
    getPortfolio(p.portfolioId),
    getIntentsBalances(
      p.accountId,
      legs.map((l) => l.intentsTokenId)
    ),
    loadPreflightLimits(),
  ]);

  // ── The orphan gate: everything `apply_allocate_into` would refuse inside `on_auth`. ──
  if (!portfolio || portfolio.deleted) {
    throw new Error(`The vault has no live portfolio ${p.portfolioId}`);
  }
  if (portfolio.owner !== p.accountId) {
    throw new Error(`Portfolio ${p.portfolioId} is not owned by ${p.accountId}`);
  }
  // Registry space, like the chain read `getPortfolio` already translated.
  const chainComposition = portfolio.composition.map((c) => ({
    tokenId: c.token_id,
    targetBps: c.target_bps,
    toleranceBps: c.tolerance_bps,
  }));
  const present = new Set(chainComposition.map((c) => c.tokenId));
  const tokenAdditions: TokenCompositionInput[] = [];
  for (const addition of p.tokenAdditions ?? []) {
    if (present.has(addition.tokenId)) continue;
    present.add(addition.tokenId);
    tokenAdditions.push({
      tokenId: addition.tokenId,
      targetBps: 0,
      toleranceBps: pctToBps(addition.tolerancePct),
    });
  }
  try {
    // The contract folds only when a list is non-empty, and so does this.
    if (tokenAdditions.length > 0) {
      resultingComposition(
        chainComposition,
        {
          targetChanges: [],
          tokenAdditions,
          tokenRemovals: [],
          unallocations: [],
        },
        limits
      );
    }
    assertAllocateIntoFits(
      portfolio.held_tokens,
      legs.map((l) => l.tokenId),
      limits
    );
    assertAllocationLegIds(
      legs.map((l) => l.intentsTokenId),
      limits
    );
  } catch (e) {
    if (e instanceof ChangeSetPreflightError) throw new RealChangeSetInvalidError(e.reason, e.detail);
    throw e;
  }

  // Never sign more than the General Balance holds (D-303), and Max lands on it exactly (D-315).
  legs.forEach((leg, i) => {
    leg.amount = capToHeld(BigInt(leg.amount), held[i]).toString();
  });

  stage("signing");
  const submitted = await submitAllocate({
    signerId: p.accountId,
    portfolioName: p.portfolioName,
    op: {
      kind: "allocate_into",
      portfolioId: p.portfolioId,
      tokenAdditions: tokenAdditions.map((a) => ({ ...a, tokenId: toIntentsTokenId(a.tokenId) })),
    },
    allocations: legs.map((l) => ({ tokenId: l.intentsTokenId, amount: l.amount })),
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

  // The Transfer settled and `on_auth` refused it: the record is already `suspected_orphan`.
  // No seal is coming by itself, so the poll would only delay the same verdict.
  if (submitted.vaultFailure !== undefined) {
    stage("pending-unconfirmed");
    throw new RealAllocateUnconfirmedError(
      `Allocate settled but the vault could not credit it (${submitted.vaultFailure}). ` +
        `The funds are held pending — the rescue record is kept.`,
      submitted.recordId,
      parseVaultErrorCode(submitted.vaultFailure) === "E_PORTFOLIO_NOT_FOUND" ? "portfolio_gone" : "vault_failed"
    );
  }

  stage("awaiting-credit");
  try {
    await waitForAllocateSeal({
      signerId: p.accountId,
      msg: submitted.authCallMsg,
      recordId: submitted.recordId,
      ...p.poll,
    });
  } catch (e) {
    stage("pending-unconfirmed");
    throw new RealAllocateUnconfirmedError(
      e instanceof Error ? e.message : String(e),
      submitted.recordId,
      "unconfirmed",
      e
    );
  }

  stage("credited");
  return {
    recordId: submitted.recordId,
    txHash: submitted.txHash,
    credited: legs.map((l) => ({
      tokenId: l.tokenId,
      qty: fromBaseUnits(BigInt(l.amount), l.decimals),
    })),
  };
}
