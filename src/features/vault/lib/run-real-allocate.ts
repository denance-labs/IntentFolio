// Orchestrates ② Allocate against the LIVE vault, end to end (007.plan, Phase 1).
// Only reachable behind NEXT_PUBLIC_VAULT_ROUNDTRIP with a NEAR login wallet.
//
//   snapshot portfolios → submit (sign + execute_intents) → poll the vault ledger for the
//   credit. The read model is re-read from the vault by the caller (D-R6), never mirrored.
//
// The snapshot must be taken BEFORE submitting: AllocateOp::Setup mints a portfolio id we
// cannot know in advance, so the credit poll finds it by diffing against this snapshot.
//
// A timeout in the poll is NOT reported as "the allocate failed". The funds may be held
// pending in the vault, and the rescue record is what recovers them — the stage carries
// that distinction to the UI so the copy never claims a loss that did not happen.

import { getTokenById } from "@/features/market/lib/token-registry";
import { toIntentsTokenId } from "@/features/market/lib/intents-token-id";
import type { PortfolioChangeSet } from "@/features/intents-account/mock-contract/types";
import { capToHeld, toBaseUnits, fromBaseUnits } from "./base-units";
import {
  assertAllocationLegIds,
  assertSetupFits,
  assertSetupLegCount,
  assertValidComposition,
  assertWithinAppTokenCap,
  ChangeSetPreflightError,
  pctToBps,
} from "./change-set-preflight";
import { RealChangeSetInvalidError } from "./vault-errors";
import { loadPreflightLimits } from "./vault-limits";
import { snapshotPortfolios, waitForAllocateCredit } from "./allocate-poll";
import { storageCostBytes } from "./storage-cost";
import { submitAllocate } from "./allocate-submit";
import { getIntentsBalances } from "./intents-read-client";
import { resolveEnvelopeSubmitter, type WalletSubmitCapability } from "./envelope-submitter";
import type { EnvelopeSubmitter } from "./relay-types";
import type { VaultSigner } from "./vault-signer";
import type { VaultChainKind } from "./vault-payloads";

export type RealAllocateStage =
  | "preparing"
  | "signing"
  | "submitting"
  | "awaiting-credit"
  | "credited"
  // Submitted but never observed as credited. Possibly orphaned — recoverable by the
  // operator via credit_pending_allocation, never presented as a plain failure.
  | "pending-unconfirmed";

export type RealAllocateResult = {
  portfolioId: string;
  recordId: string;
  txHash: string | null;
  /** Human units per funded token, as read back from the vault. */
  credited: Array<{ tokenId: string; qty: number }>;
};

export type RunRealAllocateParams = {
  /** The INTENTS account id: `alice.near`, or the lowercase `0x…` derived from an EVM login. */
  accountId: string;
  portfolioName: string;
  /** The allocations are GROSS: what the user chose, before the Storage Cost is deducted. */
  changeset: PortfolioChangeSet;
  /**
   * The Storage Cost the confirmation showed (`quoteStorageCost`, D-528): a registry token id,
   * base units, and the bytes it was priced for. Deducted here, and only here, from that
   * token's leg; the bytes are re-derived from what is about to be signed and must match.
   */
  storage: { tokenId: string; amount: bigint; bytes: number };
  /** Signs in the login family's own scheme. */
  signer: VaultSigner;
  /**
   * The login family. NOT cosmetic: it is recorded inside the AuthCallMsg's `login_wallet`.
   * The vault (since step 1.9) rejects a NEAR or EVM Setup unless the wallet's address,
   * lowercased for EVM, IS the signer (`E_ACCOUNT_ID_MISMATCH`, from `on_auth` — an orphan).
   * `deriveIntentsAccountId` already sends what the rule needs.
   * It also decides who submits.
   */
  loginChain: VaultChainKind;
  /** The wallet's own address, as the contract will re-derive the account id from it. */
  loginWalletAddress: string;
  /**
   * The NEAR wallet, for the self-submit path only (NEAR login with the relayer off).
   * Null for every other family — they have no account to send from.
   */
  nearWallet?: WalletSubmitCapability | null;
  /**
   * Who sends the signed envelope. Defaults to the relayer or the wallet depending on the login
   * family and `NEXT_PUBLIC_VAULT_RELAY` (see `resolveEnvelopeSubmitter`). Injected in tests.
   */
  submit?: EnvelopeSubmitter;
  onStage?: (stage: RealAllocateStage) => void;
  /** Credit-poll tuning; injectable so the timeout path is testable without waiting. */
  poll?: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> };
};

/**
 * Why a submitted Allocate was not confirmed. Both mean "do NOT sign again" — the funds are
 * recoverable either way — but they are not the same news, so the UI words them apart:
 *
 *   - `vault_failed`: the Transfer settled and the vault's `on_auth` refused it (FE #5). No
 *     credit is coming by itself; the record is already `suspected_orphan`.
 *   - `unconfirmed`: the credit poll ran out of time. The credit may still land on its own.
 *   - `portfolio_gone`: an AllocateInto whose `on_auth` answered `E_PORTFOLIO_NOT_FOUND` — the
 *     portfolio was deleted before the credit (D-302 h1). That `msg` never applies; the only
 *     exit is a Return to the General Balance (ADR-0023), so it gets its own words.
 */
export type RealAllocateUnconfirmedReason = "vault_failed" | "unconfirmed" | "portfolio_gone";

export class RealAllocateUnconfirmedError extends Error {
  constructor(
    message: string,
    readonly recordId: string,
    readonly reason: RealAllocateUnconfirmedReason,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = "RealAllocateUnconfirmedError";
  }
}

export async function runRealAllocate(
  p: RunRealAllocateParams
): Promise<RealAllocateResult> {
  const stage = p.onStage ?? (() => {});
  stage("preparing");

  // Phase 2 funds N tokens in one Transfer (008.plan). The per-leg conversion is done
  // here, once, so the amount that reaches the rescue record, the envelope and the credit
  // poll is the same string in all three.
  const allocations = p.changeset.allocations ?? [];
  if (allocations.length === 0) throw new Error("Real allocate needs at least one allocation");

  // Two ids per leg, deliberately. `tokenId` is OUR id and stays that way for everything
  // that comes back — the credit poll, the maturity clock, the returned `credited` — because
  // the vault read client translates its answers back into the same space. `intentsTokenId`
  // is what the Transfer intent must name, and it is the only thing that crosses the wire.
  // For 55 of 56 tokens they are the same string; for NEAR they are not (intents-token-id.ts).
  const legs: Array<{
    tokenId: string;
    intentsTokenId: string;
    amount: string;
    decimals: number;
  }> = [];
  const seen = new Set<string>();
  for (const allocation of allocations) {
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

  // Converted here and not at the submit call so `assertValidComposition` below validates
  // the ids the CONTRACT will receive — the length check in particular is about those bytes.
  const composition = (p.changeset.tokenAdditions ?? []).map((t) => ({
    tokenId: toIntentsTokenId(t.tokenId),
    targetBps: pctToBps(t.initialTargetPct),
    toleranceBps: pctToBps(t.initialTolerancePct),
  }));
  if (composition.length === 0) throw new Error("Real allocate needs a composition");

  // Before submitting: the diff base for finding the new portfolio and, in the same round
  // trip, the exact General Balance every leg is capped against (D-303) — the amount can come
  // from a float balance a few units above the real one, and "never sign more than the user
  // holds" has to hold every time, not most of the time (as last finalized: a spend in flight
  // is not subtracted, and then the Verifier refuses the whole intent). Parallel on purpose:
  // this runs inside the click, which already makes further sequential calls (the salt, the
  // ops record) before the wallet opens within the browser's 5 s user-activation window — so
  // this read must add no round trip of its own. A failed read throws: no cap, no signature.
  // The vault's limits ride the same round trip (`get_config`, read once per page load), and
  // the snapshot doubles as the portfolio count.
  const [knownPortfolioIds, held, limits] = await Promise.all([
    snapshotPortfolios(p.accountId),
    getIntentsBalances(p.accountId, legs.map((l) => l.intentsTokenId)),
    loadPreflightLimits(),
  ]);

  // THE orphan gate. A Setup the vault refuses does not roll the Transfer back: the funds
  // land on the vault, `on_auth` panics, and they are credited to nobody until an operator
  // runs `credit_pending_allocation`. So the composition is validated against the contract's
  // own rules — in basis points, after the conversion above — BEFORE anything is signed,
  // together with the rest of what `apply_setup` checks: the portfolio count (D-361), the
  // name and address lengths and the leg ids (D-302 k).
  try {
    assertValidComposition(composition, limits);
    assertWithinAppTokenCap(0, composition.length);
    assertSetupFits(
      {
        portfolioCount: knownPortfolioIds.length,
        portfolioName: p.portfolioName,
        loginWalletAddress: p.loginWalletAddress,
      },
      limits
    );
    assertSetupLegCount(legs.length, limits);
    assertAllocationLegIds(legs.map((l) => l.intentsTokenId), limits);
  } catch (e) {
    // Typed like the AllocateInto and commit paths, so the modal words the reason instead of
    // reading it as a failed signature.
    if (e instanceof ChangeSetPreflightError) throw new RealChangeSetInvalidError(e.reason, e.detail);
    throw e;
  }
  legs.forEach((leg, i) => {
    leg.amount = capToHeld(BigInt(leg.amount), held[i]).toString();
  });

  // The Storage Cost (D-528), deducted from the GROSS amount after the cap, never before: the
  // cap settles "Max" against the exact balance, and the vault leg plus the cost must fit in
  // it together. Written back into the same `legs` the envelope, the rescue record and the
  // credit poll all read, so the three carry the same net figure.
  const storageLeg = legs.find((l) => l.tokenId === p.storage.tokenId);
  const signedBytes = storageCostBytes({
    accountId: p.accountId,
    loginAddress: p.loginWalletAddress,
    portfolioName: p.portfolioName,
    compositionTokenIds: (p.changeset.tokenAdditions ?? []).map((t) => t.tokenId),
    fundedTokenIds: legs.map((l) => l.tokenId),
  });
  if (!storageLeg || p.storage.amount <= BigInt(0) || p.storage.bytes !== signedBytes) {
    throw new RealChangeSetInvalidError(
      "storage-mismatch",
      `storage ${p.storage.tokenId} ${p.storage.amount} for ${p.storage.bytes} B; the Setup takes ${signedBytes} B`
    );
  }
  const net = BigInt(storageLeg.amount) - p.storage.amount;
  if (net <= BigInt(0)) {
    throw new RealChangeSetInvalidError(
      "storage-exceeds-amount",
      `${storageLeg.tokenId}: ${storageLeg.amount} held for the leg, storage ${p.storage.amount}`
    );
  }
  storageLeg.amount = net.toString();

  stage("signing");
  const submitted = await submitAllocate({
    signerId: p.accountId,
    portfolioName: p.portfolioName,
    op: {
      kind: "setup",
      loginWalletChain: p.loginChain,
      loginWalletAddress: p.loginWalletAddress,
      composition,
      storage: { tokenId: toIntentsTokenId(p.storage.tokenId), amount: p.storage.amount.toString() },
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

  // The vault's `on_auth` receipt failed after the Transfer settled — the orphan (FE #5).
  // `submitAllocate` already wrote `suspected_orphan` with the tx hash, which is what puts
  // the record on the solver's worklist. There is no credit to wait for: the 120s poll
  // would only delay the same verdict, so it is reported straight away, and through the
  // SAME error as an unconfirmed settlement — the funds are recoverable, not lost, and the
  // copy must say so rather than "rejected", which the wallet-error path reads as a cancel.
  if (submitted.vaultFailure !== undefined) {
    stage("pending-unconfirmed");
    throw new RealAllocateUnconfirmedError(
      `Allocate settled but the vault could not credit it (${submitted.vaultFailure}). ` +
        `The funds are held pending — the rescue record is kept.`,
      submitted.recordId,
      "vault_failed"
    );
  }

  // A submit that threw without proof that nothing was sent (`submitUncertain`, D-311) lands
  // here too, on purpose: the credit poll is the only honest judge of whether it landed. A
  // credit is a success like any other; a timeout is the terminal "unconfirmed" below — never
  // an error the modal would offer to retry.
  stage("awaiting-credit");
  try {
    const credit = await waitForAllocateCredit({
      accountId: p.accountId,
      legs: legs.map((l) => ({ tokenId: l.tokenId, expectedAmount: BigInt(l.amount) })),
      knownPortfolioIds,
      recordId: submitted.recordId,
      ...p.poll,
    });
    stage("credited");
    const decimalsByToken = new Map(legs.map((l) => [l.tokenId, l.decimals]));
    return {
      portfolioId: credit.portfolioId,
      recordId: submitted.recordId,
      txHash: submitted.txHash,
      credited: credit.legs.map((leg) => {
        const decimals = decimalsByToken.get(leg.tokenId);
        // Structurally impossible (the poll only reports the legs it was given), but a
        // missing entry would silently misreport a quantity by orders of magnitude.
        if (decimals === undefined) throw new Error(`Credited an unrequested token ${leg.tokenId}`);
        return { tokenId: leg.tokenId, qty: fromBaseUnits(leg.amount, decimals) };
      }),
    };
  } catch (e) {
    stage("pending-unconfirmed");
    throw new RealAllocateUnconfirmedError(
      e instanceof Error ? e.message : String(e),
      submitted.recordId,
      "unconfirmed",
      e
    );
  }
}
