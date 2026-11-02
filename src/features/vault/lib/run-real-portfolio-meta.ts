// Rename and signed delete of a LIVE-vault portfolio (017-9c; C-9, ADR-0023).
//
// Both are a `commit_portfolio_changes` with no legs, through the same submit path as a
// withdrawal (unallocate-submit.ts), and both are confirmed by READING THE CHAIN, never by the
// error or the absence of one:
//
//   - rename: done when `get_portfolio(pid).name` reads the new name;
//   - delete: done when `get_portfolio(pid)` is `null` AND pid is below `portfolio_counter` —
//     "issued and gone" is deleted; "never issued" reads the same `null` and is not (ADR-0023 §3).
//
// Why not the error: a relayer retry or a replayed payload answers `E_NONCE_CONSUMED` (or
// `E_EXPIRED_DEADLINE` once the deadline passed) even when the first send APPLIED, and a delete
// that raced an earlier one answers `E_PORTFOLIO_NOT_FOUND` for a portfolio that is in fact gone.
// Each of those is checked against the state before anything is reported.
//
// The wallet popup must open within the browser's ~5 s activation window, so reads before the
// signature are kept off the click. The delete does none: its preconditions (empty, no credit
// in flight towards it) were read to SHOW the offer, and the contract re-checks emptiness
// anyway — a refusal reverts cleanly (`E_PORTFOLIO_NOT_EMPTY`). The rename reads the vault's
// limits, which are cached; the rename modal warms that cache when it opens.
//
// Attribution: see ATTRIBUTIONS.md #8 (vault `apply_commit` check order, `delete_empty_portfolio`,
// `portfolio_id_at`).

import { VAULT_CONTRACT_ID } from "@/features/wallet/config/network";
import { getConfig, getPortfolio } from "./vault-read-client";
import { loadPreflightLimits } from "./vault-limits";
import { assertRenameFits, ChangeSetPreflightError } from "./change-set-preflight";
import { RealChangeSetInvalidError, VaultCommitRevertedError } from "./vault-errors";
import { classifyCommitFailure } from "./vault-error-code";
import { submitUnallocate, type SubmitUnallocateResult } from "./unallocate-submit";
import { RelayError } from "./relay-client";
import { resolveEnvelopeSubmitter, type WalletSubmitCapability } from "./envelope-submitter";
import type { EnvelopeSubmitter } from "./relay-types";
import type { VaultSigner } from "./vault-signer";
import type { VaultChainKind } from "./vault-payloads";

export type RealPortfolioMetaStage = "signing" | "submitting" | "confirming" | "done";

/**
 * Sent, but the chain never showed the result in time and nothing proves how it ended. Not a
 * failure: the caller re-reads the portfolio list and says it could not confirm yet.
 */
export class RealPortfolioMetaUnconfirmedError extends Error {
  constructor(
    message: string,
    readonly txHash: string | null
  ) {
    super(message);
    this.name = "RealPortfolioMetaUnconfirmedError";
  }
}

type PollOptions = {
  timeoutMs?: number;
  intervalMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

type BaseParams = {
  /** The INTENTS account id: `alice.near`, or the lowercase `0x…` derived from an EVM login. */
  accountId: string;
  portfolioId: string; // the REAL on-chain id
  signer: VaultSigner;
  loginChain: VaultChainKind;
  /** The NEAR wallet, for the self-submit path only. Null for every other family. */
  nearWallet?: WalletSubmitCapability | null;
  /** Who sends the signed envelope; defaults per login family (see `resolveEnvelopeSubmitter`). */
  submit?: EnvelopeSubmitter;
  onStage?: (stage: RealPortfolioMetaStage) => void;
  poll?: PollOptions;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_INTERVAL_MS = 1_000;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Polls `check` until it answers true. A read that throws counts as "not yet". */
async function pollUntil(check: () => Promise<boolean>, opts: PollOptions = {}): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const startedAt = now();
  for (;;) {
    try {
      if (await check()) return true;
    } catch {
      /* a failed read is not an answer; the timeout bounds it */
    }
    if (now() - startedAt >= timeoutMs) return false;
    await sleep(intervalMs);
  }
}

/** `p_` + 12 hex digits (`portfolio_id_at`, types.rs) → its index; null for anything else. */
export function portfolioIndexOf(portfolioId: string): number | null {
  const match = /^p_([0-9a-f]{12})$/.exec(portfolioId);
  return match ? Number.parseInt(match[1], 16) : null;
}

/**
 * Deleted = issued (index below `portfolio_counter`) and no longer readable. A malformed id is
 * never "deleted": it was never issued.
 */
export async function isPortfolioDeleted(portfolioId: string): Promise<boolean> {
  const index = portfolioIndexOf(portfolioId);
  if (index === null) return false;
  if ((await getPortfolio(portfolioId)) !== null) return false;
  return index < (await getConfig()).portfolio_counter;
}

function assertVaultConfigured(gesture: string): void {
  if (VAULT_CONTRACT_ID === "") throw new Error(`${gesture} needs a configured vault contract`);
}

/** Wraps the signer so the stage moves to "submitting" the moment the signature is in hand. */
function stagedSigner(signer: VaultSigner, stage: (s: RealPortfolioMetaStage) => void): VaultSigner {
  return {
    scheme: signer.scheme,
    signEnvelope: async (req) => {
      const payload = await signer.signEnvelope(req);
      stage("submitting");
      return payload;
    },
  };
}

/**
 * Submits, turning the two answers that do NOT mean "nothing happened" into a state check:
 * the replay codes (`"unconfirmed"`) and, for a delete, `E_PORTFOLIO_NOT_FOUND`. Every other
 * revert is final and propagates for the caller's copy.
 */
async function submitAndConfirm(
  p: BaseParams,
  edit: { name: string } | { delete: true },
  isApplied: () => Promise<boolean>
): Promise<{ txHash: string | null }> {
  const stage = p.onStage ?? (() => {});
  stage("signing");

  let submitted: SubmitUnallocateResult;
  try {
    submitted = await submitUnallocate({
      signerId: p.accountId,
      portfolioId: p.portfolioId,
      legs: [],
      ...edit,
      signer: stagedSigner(p.signer, stage),
      submit:
        p.submit ?? resolveEnvelopeSubmitter({ loginChain: p.loginChain, wallet: p.nearWallet ?? null }),
    });
  } catch (e) {
    // The relayer's gate refuses, before sending, a delete of a portfolio another tab already
    // deleted ("unknown portfolio …", relay-gate.ts): the chain's E_PORTFOLIO_NOT_FOUND, said early.
    const verdict =
      e instanceof VaultCommitRevertedError
        ? classifyCommitFailure(e.reason)
        : e instanceof RelayError && e.code === "would-fail" && e.message.startsWith("unknown portfolio ")
          ? "portfolio-not-found"
          : null;
    const askTheChain =
      verdict === "unconfirmed" || ("delete" in edit && verdict === "portfolio-not-found");
    if (!askTheChain) throw e;
    stage("confirming");
    if (await pollUntil(isApplied, p.poll)) {
      stage("done");
      return { txHash: null };
    }
    // Not applied after all. A replay code proves nothing either way — report it as not
    // confirmed; a "not found" that is not a deletion is a genuine refusal.
    if (verdict === "unconfirmed") throw new RealPortfolioMetaUnconfirmedError((e as Error).message, null);
    throw e;
  }

  stage("confirming");
  const seen = await pollUntil(isApplied, p.poll);
  // A send the relayer could not confirm (D-329) is only done once the chain shows it. A send
  // that came back clean and is merely slow to read is done: the commit applies synchronously,
  // and saying "failed" there would be the worse lie (same rule as composition-poll.ts).
  if (!seen && submitted.submitUncertain !== undefined) {
    throw new RealPortfolioMetaUnconfirmedError(submitted.submitUncertain, submitted.txHash);
  }
  stage("done");
  return { txHash: submitted.txHash };
}

export type RunRealRenameParams = BaseParams & { name: string };

export async function runRealRenamePortfolio(p: RunRealRenameParams): Promise<{ txHash: string | null }> {
  assertVaultConfigured("Renaming a portfolio");
  const name = p.name.trim();
  if (name === "") throw new Error("A portfolio name cannot be empty");
  try {
    assertRenameFits(name, await loadPreflightLimits());
  } catch (e) {
    if (e instanceof ChangeSetPreflightError) throw new RealChangeSetInvalidError(e.reason, e.detail);
    throw e;
  }
  return submitAndConfirm(p, { name }, async () => (await getPortfolio(p.portfolioId))?.name === name);
}

export async function runRealDeletePortfolio(p: BaseParams): Promise<{ txHash: string | null }> {
  assertVaultConfigured("Deleting a portfolio");
  return submitAndConfirm(p, { delete: true }, () => isPortfolioDeleted(p.portfolioId));
}
