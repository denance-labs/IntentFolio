// Reads the vault's NEP-297 events out of a transaction outcome (007.plan, Phase 2).
//
// Needed because `commit_portfolio_changes` has an outcome the tx status cannot express:
// an IMMATURE withdrawal is a graceful DEFER — no panic, no mutation, tx SUCCESS, nonce
// left unconsumed so the same payload can be retried later (unallocate.rs:236-247). Read
// only the status and a deferred commit is indistinguishable from a settled one.
//
// The deferred event is also the only authoritative source of a position's maturity:
// `next_release_at` is the contract's own number, and no view exposes it.
//
// Wire format (events.rs `emit_event`), one log line per event:
//   EVENT_JSON:{"standard":"intentfolio-vault","version":"1.0.0",
//               "event":"<snake_case>","data":[{…fields…}]}
//
// Attribution: see ATTRIBUTIONS.md #8 (IntentFolio vault contract events).

const LOG_PREFIX = "EVENT_JSON:";
const EVENT_STANDARD = "intentfolio-vault";

export type VaultEventLog = {
  event: string;
  data: Record<string, unknown>;
};

type OutcomeLike = {
  transaction_outcome?: { outcome?: { logs?: unknown } };
  receipts_outcome?: Array<{ outcome?: { logs?: unknown; status?: unknown } }>;
};

function asLogArray(logs: unknown): string[] {
  return Array.isArray(logs) ? logs.filter((l): l is string => typeof l === "string") : [];
}

// A receipt that panics KEEPS the logs it wrote before panicking (NEAR semantics), while its
// state changes roll back. Its events describe something that never happened, so only a
// receipt that executed contributes.
function receiptSucceeded(status: unknown): boolean {
  if (!status || typeof status !== "object") return false;
  return "SuccessValue" in status || "SuccessReceiptId" in status;
}

/**
 * Every log line of a tx, across the transaction outcome and every SUCCESSFUL receipt (D-324).
 * The vault's events are emitted in a RECEIPT (the call is a cross-contract hop from the
 * wallet's tx), so reading `transaction_outcome` alone would miss all of them.
 */
export function collectLogs(outcome: unknown): string[] {
  const o = (outcome ?? {}) as OutcomeLike;
  const logs = asLogArray(o.transaction_outcome?.outcome?.logs);
  for (const receipt of o.receipts_outcome ?? []) {
    if (!receiptSucceeded(receipt?.outcome?.status)) continue;
    logs.push(...asLogArray(receipt?.outcome?.logs));
  }
  return logs;
}

/**
 * One log line as a vault event, or null when it is not one (foreign standard, malformed).
 * Reads the envelope only: WHO emitted the line is the caller's to check — a log line carries
 * no author, and any contract can print an `intentfolio-vault` envelope.
 */
export function parseVaultEventLine(line: string): VaultEventLog | null {
  if (!line.startsWith(LOG_PREFIX)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice(LOG_PREFIX.length));
  } catch {
    return null; // a log we cannot read must never break the flow that produced it
  }
  const envelope = parsed as { standard?: unknown; event?: unknown; data?: unknown };
  if (envelope.standard !== EVENT_STANDARD) return null;
  if (typeof envelope.event !== "string") return null;
  // `data` is always a single-element array for enum-emitted events (events.rs emit()).
  const first = Array.isArray(envelope.data) ? envelope.data[0] : envelope.data;
  if (!first || typeof first !== "object") return null;
  return { event: envelope.event, data: first as Record<string, unknown> };
}

/** Parsed vault events, in emission order. Foreign and malformed logs are skipped. */
export function parseVaultEvents(outcome: unknown): VaultEventLog[] {
  const events: VaultEventLog[] = [];
  for (const line of collectLogs(outcome)) {
    const event = parseVaultEventLine(line);
    if (event) events.push(event);
  }
  return events;
}

export type UnallocateDeferred = {
  portfolioId: string;
  token: string;
  /** Unix seconds. The contract's own maturity deadline for this position. */
  nextReleaseAt: number;
  reason: string;
};

// u64 crosses as a JSON number, U128 as a decimal string — accept both defensively so a
// serde change upstream degrades to "unknown" rather than to a wrong timestamp.
function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

/**
 * The `UnallocateDeferred` of this tx, if the commit was deferred. A deferred commit
 * changed NOTHING on-chain — the caller must not report the withdrawal as done.
 */
export function findUnallocateDeferred(outcome: unknown): UnallocateDeferred | null {
  for (const { event, data } of parseVaultEvents(outcome)) {
    if (event !== "unallocate_deferred") continue;
    const nextReleaseAt = toNumber(data.next_release_at);
    if (nextReleaseAt === null) continue;
    return {
      portfolioId: String(data.portfolio_id ?? ""),
      token: String(data.token ?? ""),
      nextReleaseAt,
      reason: String(data.reason ?? "unknown"),
    };
  }
  return null;
}

/**
 * True when the vault opened a pending unallocation — the legs are locked and the
 * `mt_batch_transfer` is in flight. Distinguishes "accepted, settling" from "deferred".
 */
export function hasPendingUnallocation(outcome: unknown): boolean {
  return parseVaultEvents(outcome).some((e) => e.event === "pending_unallocation_opened");
}

/**
 * The `commit_id` of the batch this commit opened, or null. v2 answers
 * `get_pending_unallocation(commit_id)` for exactly this batch (D-379), which is how the
 * settlement poll tells OUR withdrawal from another one of the same position.
 */
export function findPendingUnallocationCommitId(outcome: unknown): string | null {
  for (const { event, data } of parseVaultEvents(outcome)) {
    if (event !== "pending_unallocation_opened") continue;
    if (typeof data.commit_id === "string" && data.commit_id.length > 0) return data.commit_id;
  }
  return null;
}

type StatusLike = { Failure?: unknown; SuccessValue?: unknown };

// The panic string lives at a different depth depending on where it happened, so walk the
// error object for the first `ExecutionError` instead of pattern-matching one shape.
function findExecutionError(node: unknown, depth = 0): string | null {
  if (depth > 8 || !node || typeof node !== "object") return null;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "ExecutionError" && typeof value === "string") return value;
    const nested = findExecutionError(value, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function failureOf(status: StatusLike | undefined): string | null {
  if (!status || typeof status !== "object" || !("Failure" in status)) return null;
  if (status.Failure === undefined) return null;
  return findExecutionError(status.Failure) ?? JSON.stringify(status.Failure);
}

/**
 * The failure of a REVERTED transaction, or null when it executed.
 *
 * Complements the events, it does not replace them: a panic (wrong owner, consumed nonce,
 * frozen token) shows up here and yields no vault event (its logs are skipped, D-324), while
 * a DEFER produces an event and leaves the status successful. Reading only one of the two
 * mislabels half the outcomes.
 *
 * Sub-receipts are checked too: a wallet may hand back a `FinalExecutionOutcome` whose
 * top-level status is fine while the receipt that ran the vault reverted.
 *
 * NOT for the Allocate: there a failed sub-receipt under a successful top-level status is
 * the orphan, not a revert — see `classifyAllocateOutcome`.
 */
export function findExecutionFailure(outcome: unknown): string | null {
  const o = (outcome ?? {}) as {
    status?: StatusLike;
    receipts_outcome?: Array<{ outcome?: { status?: StatusLike } }>;
  };
  const statuses: Array<StatusLike | undefined> = [o.status];
  for (const receipt of o.receipts_outcome ?? []) statuses.push(receipt?.outcome?.status);

  for (const status of statuses) {
    const error = failureOf(status);
    if (error !== null) return error;
  }
  return null;
}

/** `UnallocateFailed`: the batch transfer reverted and the locks were released. */
export function findUnallocateFailure(outcome: unknown): string | null {
  for (const { event, data } of parseVaultEvents(outcome)) {
    if (event !== "unallocate_failed") continue;
    return String(data.reason ?? "unallocate failed");
  }
  return null;
}

export type AllocateOutcomeVerdict =
  /** No failure anywhere: the Transfer settled and `on_auth` ran. */
  | { kind: "executed" }
  /** `execute_intents` rolled back: nothing moved, nothing to rescue. */
  | { kind: "reverted"; error: string }
  /**
   * The Transfer settled and a LATER receipt failed — in practice the vault's `on_auth`.
   * This is the orphan of ADR-0017: funds in the vault, credited to nobody.
   */
  | {
      kind: "vault_failed";
      error: string;
      /**
       * True when the failed receipt is the vault's own (`on_auth` panicked, so nothing was
       * sealed). False when it is another receipt under a settled Transfer: the vault may still
       * have credited, and only its seal can say (D-328).
       */
      byVault: boolean;
    }
  /**
   * A receipt failed but the outcome says neither whether the Transfer settled (no
   * top-level status) nor who failed (no vault `executor_id`). Undecidable here: the
   * record stays `submitted` and the credit poll decides, as it does for a thrown submit.
   */
  | { kind: "undecided"; error: string };

type ReceiptOutcomeLike = { outcome?: { executor_id?: unknown; status?: StatusLike } };

/**
 * What an Allocate's `execute_intents` outcome means for the rescue record (FE #5, `922` §8 #15).
 *
 * `findExecutionFailure` reads ANY failed receipt as a revert. For the Allocate that is wrong
 * by construction: the payload is `[Transfer, AuthCall → on_auth]`, and the two settle in
 * different receipts. The Transfer is `intents.near`'s own ledger move inside the
 * `execute_intents` receipt — the one whose status becomes the tx's TOP-LEVEL status. The
 * AuthCall is a separate receipt run BY THE VAULT (`executor_id`), and `on_auth` opens no
 * promises of its own. So:
 *
 *   - a top-level `Failure` is `execute_intents` rolling back: nothing moved (D-R12 holds);
 *   - a top-level `SuccessValue` means the Transfer SETTLED, whatever failed afterwards. A
 *     failed receipt under it — the vault's `on_auth` panicking — is exactly the orphan, and
 *     writing it off as `failed` takes it OFF the rescue worklist: nobody rescues it.
 *
 * When the top-level status is missing (a wallet handing back a trimmed outcome) the
 * receipt's `executor_id` decides: the vault's ⇒ orphan. A foreign or absent one under no
 * top-level status is `undecided` — never `reverted` on a guess.
 *
 * The chosen failure direction is TOWARDS the worklist, in every branch. A
 * `suspected_orphan` that was not one is dropped by the resolver on its on-chain seal and
 * burnt nonce; a `failed` that was one is invisible to every human and every process that
 * looks for stranded funds. Only a top-level `Failure` — the chain saying `execute_intents`
 * rolled back — may write `failed`.
 */
export function classifyAllocateOutcome(outcome: unknown, vaultId: string): AllocateOutcomeVerdict {
  const o = (outcome ?? {}) as { status?: StatusLike; receipts_outcome?: ReceiptOutcomeLike[] };

  const top = failureOf(o.status);
  if (top !== null) return { kind: "reverted", error: top };
  const transferSettled =
    !!o.status && typeof o.status === "object" && "SuccessValue" in o.status;

  let foreign: string | null = null;
  for (const receipt of o.receipts_outcome ?? []) {
    const error = failureOf(receipt?.outcome?.status);
    if (error === null) continue;
    if (receipt.outcome?.executor_id === vaultId) return { kind: "vault_failed", error, byVault: true };
    foreign ??= error;
  }
  if (foreign !== null) {
    return transferSettled
      ? { kind: "vault_failed", error: foreign, byVault: false }
      : { kind: "undecided", error: foreign };
  }
  return { kind: "executed" };
}
