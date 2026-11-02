// Post-submit confirmation for ② Allocate (007.plan, Phase 1).
//
// Why polling and not the tx receipt: `execute_intents` can report SUCCESS while the
// vault's `on_auth` receipt fails. That is the orphan — the Transfer settled, the credit
// never happened. So the only trustworthy confirmation is an observed balance in the vault
// ledger itself — a credited balance for Setup, the vault's own idempotency seal for
// AllocateInto (see `waitForAllocateSeal`). Nothing here may mark a record credited on tx
// status alone.
//
// Identifying the new portfolio: `AllocateOp::Setup` creates one, and its id is not known
// before the call. We snapshot `list_portfolios_for` BEFORE submitting and then watch for
// an id that was not in the snapshot — robust for an account that already has portfolios.

import { listPortfoliosFor, getPortfolioBalance } from "./vault-read-client";
import { updateAllocateRecordEverywhere } from "./allocate-record-sink";
import { readAllocateSeal, type SealRead } from "./allocate-seal";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_INTERVAL_MS = 3_000;

export type AllocateCredit = {
  portfolioId: string;
  /** One entry per funded leg, in the order they were requested. */
  legs: Array<{ tokenId: string; amount: bigint }>;
};

export type WaitForCreditParams = {
  accountId: string;
  /** Every funded leg. The portfolio counts as credited only when ALL of them are in. */
  legs: Array<{ tokenId: string; expectedAmount: bigint }>;
  /** Portfolio ids observed BEFORE submitting — see snapshotPortfolios. */
  knownPortfolioIds: string[];
  /** Rescue-store id; marked credited only on an observed balance. */
  recordId?: string;
  timeoutMs?: number;
  intervalMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

/** Snapshot to diff against. Call BEFORE submitAllocate. */
export async function snapshotPortfolios(accountId: string): Promise<string[]> {
  return listPortfoliosFor(accountId);
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Polls the vault ledger until the new portfolio shows the credit.
 * Throws on timeout — the caller must treat that as "possibly orphaned", NOT as failure:
 * the record is marked `suspected_orphan`, which is what hands it to the solver's rescue
 * worklist, and the operator can run credit_pending_allocation.
 *
 * EVERY leg must be credited before this resolves. A partial credit is not a success to
 * report early: `credit_portfolio` applies the legs of one settled Transfer together, so
 * seeing one token but not the other means the read caught the ledger mid-write — or that
 * something is wrong, which is exactly the case the timeout must reach.
 */
export async function waitForAllocateCredit(p: WaitForCreditParams): Promise<AllocateCredit> {
  const timeoutMs = p.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = p.intervalMs ?? DEFAULT_INTERVAL_MS;
  const sleep = p.sleep ?? defaultSleep;
  const now = p.now ?? Date.now;
  const known = new Set(p.knownPortfolioIds);
  const startedAt = now();

  // A zero expectation would be satisfied by an empty ledger row, so the FIRST unknown
  // portfolio would be reported as credited — including one the user created elsewhere.
  if (p.legs.length === 0) throw new Error("Allocate credit poll needs at least one leg");
  for (const leg of p.legs) {
    if (leg.expectedAmount <= BigInt(0)) {
      throw new Error(`Allocate credit poll needs a positive amount for ${leg.tokenId}`);
    }
  }

  // Transient read errors must not abort the wait: a submitted Allocate is in flight and
  // giving up early would strand it with no confirmation. Keep the last one for the
  // timeout message.
  let lastError: unknown;

  for (;;) {
    try {
      const current = await listPortfoliosFor(p.accountId);
      for (const portfolioId of current) {
        if (known.has(portfolioId)) continue;
        const balances = await getPortfolioBalance(portfolioId);
        const held = new Map(balances);
        const credited = p.legs.map((leg) => ({
          tokenId: leg.tokenId,
          amount: held.get(leg.tokenId) ?? BigInt(0),
          expected: leg.expectedAmount,
        }));
        if (credited.every((leg) => leg.amount >= leg.expected)) {
          // Awaited before returning: this is the one transition that takes a record OFF
          // the solver's rescue worklist, and reporting a credit the database never heard
          // about leaves a human chasing an orphan that resolved itself. Best-effort still —
          // `updateAllocateRecordEverywhere` never throws — so a slow write cannot turn an
          // observed credit into a failure.
          if (p.recordId) {
            await updateAllocateRecordEverywhere(p.recordId, { status: "credited" });
          }
          return {
            portfolioId,
            legs: credited.map(({ tokenId, amount }) => ({ tokenId, amount })),
          };
        }
      }
    } catch (e) {
      lastError = e;
    }

    if (now() - startedAt >= timeoutMs) {
      // The transition that hands the record to the SOLVER (ADR-0017 §7, P-OPS v1 point 5).
      // `listSuspectedOrphans` selects on this exact value and nothing else, so until it is
      // written the watchdog reads an EMPTY worklist however many Allocates went unconfirmed:
      // the record would sit at `submitted`, which reads as "still in flight", not as "check
      // whether these funds are stranded".
      //
      // Awaited, like the `credited` write above, because this is the write that starts a
      // rescue. Safe to await: `updateAllocateRecordEverywhere` never throws, its HTTP leg is
      // bounded by OPS_PATCH_BUDGET_MS, and — unlike the `credited` one — this branch sits
      // OUTSIDE the loop's try/catch, so a throw here could not be swallowed as a read error.
      //
      // Attribution: see ATTRIBUTIONS.md #17.
      if (p.recordId) {
        await updateAllocateRecordEverywhere(p.recordId, { status: "suspected_orphan" });
      }
      const suffix = lastError instanceof Error ? ` (last read error: ${lastError.message})` : "";
      throw new Error(
        `Allocate not credited within ${Math.round(timeoutMs / 1000)}s${suffix}. ` +
          `The funds may be held pending — the rescue record is kept.`
      );
    }
    await sleep(intervalMs);
  }
}

export type WaitForSealParams = {
  signerId: string;
  /** The RAW AuthCallMsg, byte for byte as signed — the seal key hashes it (D-160). */
  msg: string;
  /** Rescue-store id; marked credited only on an observed seal. */
  recordId?: string;
  timeoutMs?: number;
  intervalMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  readSeal?: (signerId: string, msg: string) => Promise<SealRead>;
};

/**
 * Polls until the vault holds this Allocate's idempotency seal — the confirmation for an
 * `AllocateInto` (D-321), where there is no new portfolio to find by diffing.
 *
 * Why the seal and not a balance: `apply_allocation` writes it in the same receipt as the
 * credit, so "sealed" is "credited", per msg, exactly. A balance diff on a portfolio that
 * already exists is not: the Solver swaps its tokens (seen on staging, 013.plan B0), so the
 * expected figure can land and be traded away between two reads, or never appear at all.
 *
 * Same contract as `waitForAllocateCredit`: `unreadable` is never success, a timeout marks
 * the record `suspected_orphan` (which puts it on the solver's worklist) and throws.
 */
export async function waitForAllocateSeal(p: WaitForSealParams): Promise<void> {
  const timeoutMs = p.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = p.intervalMs ?? DEFAULT_INTERVAL_MS;
  const sleep = p.sleep ?? defaultSleep;
  const now = p.now ?? Date.now;
  const readSeal = p.readSeal ?? readAllocateSeal;
  const startedAt = now();
  let lastUnreadable: string | undefined;

  for (;;) {
    const seal = await readSeal(p.signerId, p.msg);
    if (seal.kind === "sealed") {
      // Awaited for the same reason as the balance poll's `credited` write: it takes the
      // record OFF the worklist.
      if (p.recordId) await updateAllocateRecordEverywhere(p.recordId, { status: "credited" });
      return;
    }
    if (seal.kind === "unreadable") lastUnreadable = seal.reason;

    if (now() - startedAt >= timeoutMs) {
      // The hand-off to the solver — see the matching branch of `waitForAllocateCredit`.
      if (p.recordId) {
        await updateAllocateRecordEverywhere(p.recordId, { status: "suspected_orphan" });
      }
      const suffix = lastUnreadable ? ` (last seal read: ${lastUnreadable})` : "";
      throw new Error(
        `Allocate not credited within ${Math.round(timeoutMs / 1000)}s${suffix}. ` +
          `The funds may be held pending — the rescue record is kept.`
      );
    }
    await sleep(intervalMs);
  }
}
