"use client";

import { useSyncExternalStore, useEffect, useRef } from "react";
import { mockContract } from "@/features/intents-account/mock-contract";
import type {
  TokenId,
  WithdrawalInFlightRecord,
  WithdrawalStatusKind,
} from "@/features/intents-account/mock-contract/types";
import {
  closeWithServerVerdict,
  dismissWithdrawRecord,
  getWithdrawRecord,
  isResolvedWithdrawRecord,
  listUnresolvedWithdrawRecords,
  listWithdrawRecords,
  type WithdrawRescueRecord,
} from "../lib/withdraw-rescue-store";
// The re-checks' verdicts also reach the ops database (ADR-0025); hiding a record does not.
import { resolveUnansweredPublish, updateWithdrawRecord } from "../lib/withdraw-record-sink";
import { waitForWithdrawDelivery } from "../lib/withdraw-poll";
import { getWithdrawalEntry } from "../lib/withdrawal-registry";
import type { SupportedWithdrawRoute } from "../lib/withdraw-envelope";
import { conversionWatchBudgetMs, waitForConversionOutcome } from "../lib/oneclick-status";
import { checkPublication, type PublicationVerdict } from "../lib/withdraw-publication-check";
import { fetchWithdrawVerdicts, type ReadWithdrawVerdicts } from "../lib/withdraw-verdicts-client";
import type { WithdrawVerdictAnswer } from "../lib/withdraw-records-types";

// Realistic mock progression: simulates bridge settlement timing (30s→90s→180s→300s total).
// Applies ONLY to mock withdrawals. A real one (`isReal`) has an observed status coming from
// `runRealWithdraw`, and overwriting it on a timer would invent a settlement that may not
// have happened — see the guard in the scheduling effect.
const MOCK_PROGRESSION: Array<{ delay: number; status: Exclude<WithdrawalStatusKind, "PENDING" | "FAILED"> }> = [
  { delay:  30_000, status: "TX_BROADCASTED" },
  { delay:  60_000, status: "SETTLED" },
  { delay:  90_000, status: "DELIVERED" },
];

// Deterministic ~25% failure rate: UUID first char in {0,1,2,3} (4/16 hex digits).
// Same intentId always follows the same path; no randomness at render time.
function willSimulateFail(intentId: string): boolean {
  return ["0", "1", "2", "3"].includes(intentId[0] ?? "");
}

// D-193 — the rescue worklist finally gets a reader.
//
// A real withdrawal's only durable trace is `withdraw-rescue-store` (localStorage); the
// in-flight list the activity feed renders lives in memory and dies with the tab. So a
// withdrawal published at 14:00 and still unsettled when the user reloads at 14:05 would
// simply vanish from the UI while the money was in flight.
//
// This matters more here than anywhere else in the product: unlike Allocate, a withdrawal
// has NO Solver-side backstop that rescues orphans (D-160). This worklist is the only
// recovery mechanism there is, and the moment it earns its keep is the mainnet wet test.
//
// Scope is deliberately narrow (block 5.4): hydrate the CURRENT account's unresolved
// records into the same in-memory store the feed already reads, then let the existing
// subscription drive the rest. The operator view that concatenates the Allocate and
// withdrawal stores is D-194 and comes after the wet test.
const RESCUE_TO_TRACKED: Record<string, WithdrawalStatusKind> = {
  publishing: "PENDING",
  // The relay returned an intent hash: it is out, and settlement is not observed yet.
  published: "TX_BROADCASTED",
  settled: "SETTLED",
  // The RESOLVED states. Reachable only through `closedUnseen` — see `hydrateFromRescueStore`.
  delivered: "DELIVERED",
  failed: "FAILED",
  refunded: "REFUNDED",
};

// D-259 — rehydration used to restore the LABEL and not the MACHINERY.
//
// Two faces, one mistake. A record carrying a persisted `error` came back as a clean
// "Pending"; a `settled` record with no `destinationTxHash` came back as "Settled on NEAR"
// and stayed there forever, because the real path takes no timers (see the guard below) and
// nothing ever re-opened the delivery wait. Both are the same error: treating the last state
// written to localStorage as the state of the world. The cure is to resolve against the
// chain — the technique `gas-purchase.ts` already uses to observe its purchase.
//
// Measured 2026-08-10 on a real withdrawal, both faces in the same run (008.plan §sesión 120).

/** A settled withdrawal whose delivery was never observed. Everything a re-check needs. */
type ResumableDelivery = {
  id: string;
  /** Whose withdrawal this is. Decides who gets TOLD, never whether the re-check runs. */
  signerId: string;
  tokenId: string;
  route: SupportedWithdrawRoute;
  /** With `tokenId`, names the route: an `omft` token can also have gone to NEAR (D-384). */
  chainId: string;
  txHash: string;
};

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 🔴 `closedUnseen` — WITHOUT IT, D-264's TWO HALVES CANCEL EACH OTHER OUT.
 *
 * Found by cross-review, reproduced. Letting the re-check run with no session (the (a) half)
 * means a record can be CLOSED before the account that owns it is ever known: `loginStatus` is
 * `"restoring"` on every first client render and stays there up to `RESTORE_TIMEOUT_MS`, and
 * stays `"idle"` forever when the session does not restore at all. Hydration reads the
 * UNRESOLVED worklist, and a `delivered` record is not on it — so the row never appears, the
 * strip counts zero, and the user who reloaded specifically to check on their withdrawal is
 * shown an empty feed. "Nothing" reads as "there was no withdrawal".
 *
 * That is a disappearance, not a false claim — the stored value is correct throughout. But it
 * lands on exactly the reload the feature was written for, which makes it worse than the freeze
 * it replaced.
 *
 * So a record this page closed while nobody could see it is remembered by id, and hydration
 * lets those through the resolved filter. A resolved DIRECT withdrawal needs nothing more: its
 * `mt_burn` is a chain row in the finished feed, which is where it belongs once delivered.
 *
 * D-440 — A RESOLVED CONVERSION HAS NO CHAIN ROW. Its `transfer` to 1Click's deposit address is
 * not a withdrawal event (`toCompletedActivity` reads `mt_burn`), so this record is the only
 * trace of it the feed can show. Measured s230: a delivered conversion vanished from Activity
 * on reload. So delivered and refunded conversions are hydrated whole, for as long as the store
 * keeps them — `RESOLVED_RETENTION_MS` past their creation, but pruned only when the next
 * withdrawal is recorded, so possibly longer; the feed files them among the finished rows by date
 * (`isFinishedConversion`), so a month of them pages like the rest instead of pinning on top.
 * A `failed` one is not: its funds never left (`fundsState: "untouched"`), as for a direct one.
 */
function hydrateFromRescueStore(
  intentsAccountId: string,
  closedUnseen: ReadonlySet<string>
): void {
  let records: WithdrawRescueRecord[];
  try {
    // The whole store, not just the worklist: resolved conversions and the records in
    // `closedUnseen` are resolved by definition.
    records = listWithdrawRecords();
  } catch {
    // A worklist we cannot read must never take the dashboard down with it.
    return;
  }

  const alreadyTracked = new Set(
    mockContract.getTrackedWithdrawals(intentsAccountId).map((r) => r.intentId)
  );

  for (const record of records) {
    if (record.signerId !== intentsAccountId) continue;
    if (alreadyTracked.has(record.id)) continue;
    if (
      isResolvedWithdrawRecord(record) &&
      !closedUnseen.has(record.id) &&
      !(record.kind === "conversion" && (record.status === "delivered" || record.status === "refunded"))
    ) {
      continue;
    }
    const mapped = RESCUE_TO_TRACKED[record.status];
    // An unmapped status means the store learned a state this mapping has not; showing it
    // as PENDING would understate how far along it is, so leave it to the store's own
    // readers rather than guess.
    if (!mapped) continue;

    // An error was persisted against a record that never resolved, so the outcome is genuinely
    // UNKNOWN and the label has to say so. `PENDING` would describe a withdrawal cleanly in
    // flight, and `FAILED` would promise the funds are safe — only `fundsState: "untouched"`
    // may promise that, and it would have resolved the record already, so it never gets here.
    //
    // A RESOLVED record is exempt, and that exemption is load-bearing now that resolved records
    // can be hydrated: an `error` from an attempt that later succeeded would otherwise relabel
    // an observed delivery as "Not confirmed" — the stale-label bug D-259 exists to end,
    // pointing the other way.
    const status: WithdrawalStatusKind =
      record.error && !isResolvedWithdrawRecord(record) ? "UNCONFIRMED" : mapped;

    mockContract.trackWithdrawal(record.id, {
      accountId: intentsAccountId,
      tokenId: record.tokenId as TokenId,
      qty: record.qty,
      chainId: record.chainId,
      destinationAddress: record.destinationAddress,
      ts: record.createdAt,
      status,
      isReal: true,
      ...(record.status === "settled" && { leftBalance: true }),
      ...(record.kind === "conversion" && {
        deliveryTokenId: record.conversion.deliveryTokenId as TokenId,
        depositAddress: record.conversion.depositAddress,
        ...(record.deliveredAmount !== undefined && { deliveredAmountRaw: record.deliveredAmount }),
      }),
    });
    if (record.txHash || record.destinationTxHash) {
      mockContract.setWithdrawalStatus(record.id, status, {
        txHash: record.txHash,
        // Carried so a delivery closed before login still shows its explorer link, instead of
        // the NEAR settlement hash standing in for the destination one.
        destinationTxHash: record.destinationTxHash,
      });
    }
  }
}

/**
 * Every settled record with no delivery observed — read from the STORE, not from what happens
 * to be tracked in memory right now, and not filtered by who is logged in.
 *
 * The store separation is the fix for two bugs cross-review found. Resumability used to be a
 * by-product of hydration, so a record that was already tracked was skipped by
 * `alreadyTracked` and never became resumable again. A wait killed by the effect's cleanup —
 * StrictMode's second pass in dev, or switching account and coming back — was therefore never
 * reopened, and the row froze on "Settled on NEAR" exactly as before the fix.
 *
 * Whether a row exists in memory says nothing about whether anyone is still waiting on the
 * bridge. Only the store and the chain know that.
 *
 * D-264 — AND WHETHER ANYONE IS LOGGED IN SAYS NOTHING ABOUT IT EITHER. This used to take the
 * current account and filter on it, so the shell's `loginConnected ? intentsAccountId : ""`
 * made the whole recovery mechanism inert whenever the session did not restore — which is
 * exactly the reload the mechanism exists for, and a withdrawal has no Solver-side backstop
 * (D-160) to catch what it misses. Nothing in the re-check needs a wallet: it reads a record
 * the browser already has and asks public sources about it, signing nothing and moving
 * nothing. So it runs for every unresolved record, and the account only decides who is told.
 */
function listResumableDeliveries(): ResumableDelivery[] {
  let records: WithdrawRescueRecord[];
  try {
    records = listUnresolvedWithdrawRecords();
  } catch {
    return [];
  }

  const resumable: ResumableDelivery[] = [];
  for (const record of records) {
    // A conversion crosses no bridge of ours: 1Click delivers it, and only 1Click can say where
    // it is (`listResumableConversions`). Its settled record looks exactly like a bridge wait
    // with no answer, which is why this has to be said out loud.
    if (record.kind === "conversion") continue;
    // Settled, with the NEAR transaction, and no delivery observed: the funds have left the
    // balance and the bridge is the only thing that can say where they are.
    if (record.status !== "settled" || !record.txHash || record.destinationTxHash) continue;
    resumable.push({
      id: record.id,
      signerId: record.signerId,
      tokenId: record.tokenId,
      route: record.route,
      chainId: record.chainId,
      txHash: record.txHash,
    });
  }
  return resumable;
}

/** An open Converting Withdrawal. Everything a `/v0/status` re-check needs. */
type ResumableConversion = {
  id: string;
  depositAddress: string;
  quoteSignature: string;
  /** Set while the transfer's own publish is unresolved: it may have never run (D-463). */
  publication: PublicationToCheck | null;
};

/**
 * Every UNRESOLVED conversion, whatever its status (plan 020 §5.4). Unlike a bridge wait, which
 * needs the settlement hash, `/v0/status` is keyed on the deposit address the record has from the
 * moment it is written — so even a publish whose answer never came back can be asked about. Not
 * filtered by login, for the same reason as `listResumableDeliveries` (D-264).
 */
function listResumableConversions(): ResumableConversion[] {
  let records: WithdrawRescueRecord[];
  try {
    records = listUnresolvedWithdrawRecords();
  } catch {
    return [];
  }
  const resumable: ResumableConversion[] = [];
  for (const record of records) {
    if (record.kind !== "conversion") continue;
    resumable.push({
      id: record.id,
      depositAddress: record.conversion.depositAddress,
      quoteSignature: record.conversion.quoteSignature,
      publication: isUnresolvedPublish(record) ? toPublicationToCheck(record) : null,
    });
  }
  return resumable;
}

// D-463 — `publishing` and `published` had no re-check at all. A page closed in the seconds
// between the publish and the settlement left the record open for good — and the D-264 strip
// with it, on every load, with no way to dismiss it (measured s254: delivered, "in progress"
// for nine days). `checkPublication` asks the relay and then `intents.near`.

/** What `checkPublication` reads, plus what a direct withdrawal needs to carry on from it. */
type PublicationToCheck = {
  id: string;
  signerId: string;
  intentHash?: string;
  nonce?: string;
  deadline?: number;
};

type ResumablePublication = PublicationToCheck & {
  tokenId: string;
  route: SupportedWithdrawRoute;
  chainId: string;
};

function isUnresolvedPublish(record: WithdrawRescueRecord): boolean {
  return record.status === "publishing" || record.status === "published";
}

function toPublicationToCheck(record: WithdrawRescueRecord): PublicationToCheck {
  return {
    id: record.id,
    signerId: record.signerId,
    intentHash: record.intentHash,
    nonce: record.nonce,
    deadline: record.deadline,
  };
}

/**
 * Every DIRECT record whose publish never got an answer. Conversions take the same check inside
 * their own resume (`listResumableConversions`), because only 1Click can say where an executed
 * transfer went. Not filtered by login, for the same reason as `listResumableDeliveries`.
 */
function listResumablePublications(): ResumablePublication[] {
  let records: WithdrawRescueRecord[];
  try {
    records = listUnresolvedWithdrawRecords();
  } catch {
    return [];
  }
  const resumable: ResumablePublication[] = [];
  for (const record of records) {
    if (record.kind === "conversion" || !isUnresolvedPublish(record)) continue;
    resumable.push({
      ...toPublicationToCheck(record),
      tokenId: record.tokenId,
      route: record.route,
      chainId: record.chainId,
    });
  }
  return resumable;
}

/** Every open record, whoever it belongs to — what the solver's verdicts are asked for (024-D). */
function listOpenRecordIds(): string[] {
  try {
    return listUnresolvedWithdrawRecords().map((r) => r.id);
  } catch {
    return [];
  }
}

/**
 * Both NEAR-destination routes deliver in the settlement itself (`waitForWithdrawDelivery`).
 * Asked of the registry, with the same drift guard the delivery wait applies: a stored route the
 * registry no longer agrees with must not be enough to call a withdrawal delivered.
 */
function settlesOnNear(record: { tokenId: string; chainId: string; route: SupportedWithdrawRoute }): boolean {
  const route = getWithdrawalEntry(record.tokenId, record.chainId)?.bridgeRoute;
  return route === record.route && (route === "near-native" || route === "near-unwrap");
}

/**
 * D-463 (023-B) — «Hide» on a row no re-check could close. The durable record goes first: if it
 * refuses (too young, already resolved, storage failing) the row stays, so the screen never hides
 * what the next reload would bring back. Returns whether the row was hidden.
 */
export function dismissWithdrawal(id: string): boolean {
  if (!dismissWithdrawRecord(id)) return false;
  mockContract.untrackWithdrawal(id);
  return true;
}

type Options = {
  intentsAccountId: string;
  onDelivered?: (record: WithdrawalInFlightRecord) => void;
  onFailed?: (record: WithdrawalInFlightRecord) => void;
  /** A conversion 1Click sent back to the General Balance, observed on a re-check. */
  onRefunded?: (record: WithdrawalInFlightRecord) => void;
  /**
   * D-463: a publish proven never to have executed — the funds never left. Apart from `onFailed`,
   * which the mock progression also fires on a simulated refund; this one only comes from the chain.
   */
  onNeverExecuted?: (record: WithdrawalInFlightRecord) => void;
  /**
   * The delivery wait used to resume a settled-but-undelivered record (D-259). Injected for
   * the same reason every other seam on this path is: the money path has to be testable with
   * no network. Defaults to the real one.
   */
  resumeDelivery?: typeof waitForWithdrawDelivery;
  /** The `/v0/status` watch used to resume an open conversion. Same reason as `resumeDelivery`. */
  resumeConversion?: typeof waitForConversionOutcome;
  /** The relay + nonce check for an unanswered publish (D-463). Same reason as `resumeDelivery`. */
  checkPublishedWithdraw?: (record: PublicationToCheck) => Promise<PublicationVerdict>;
  /** The solver's final verdicts (024-D). Same reason as `resumeDelivery`. */
  readWithdrawVerdicts?: ReadWithdrawVerdicts;
};

export function usePendingWithdrawals({
  intentsAccountId,
  onDelivered,
  onFailed,
  onRefunded,
  onNeverExecuted,
  resumeDelivery,
  resumeConversion,
  checkPublishedWithdraw,
  readWithdrawVerdicts,
}: Options): WithdrawalInFlightRecord[] {
  useSyncExternalStore(mockContract.subscribe, mockContract.getVersion, mockContract.getVersion);

  const scheduledRef = useRef(new Set<string>());
  const timerIdsRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const hydratedRef = useRef<string | null>(null);
  const inFlightRef = useRef(new Set<string>());
  /** Records this page closed while their owner was not on screen. See `hydrateFromRescueStore`. */
  const closedUnseenRef = useRef(new Set<string>());
  const onDeliveredRef = useRef(onDelivered);
  onDeliveredRef.current = onDelivered;
  const onFailedRef = useRef(onFailed);
  onFailedRef.current = onFailed;
  const onRefundedRef = useRef(onRefunded);
  onRefundedRef.current = onRefunded;
  const onNeverExecutedRef = useRef(onNeverExecuted);
  onNeverExecutedRef.current = onNeverExecuted;
  const resumeDeliveryRef = useRef(resumeDelivery);
  resumeDeliveryRef.current = resumeDelivery;
  const resumeConversionRef = useRef(resumeConversion);
  resumeConversionRef.current = resumeConversion;
  const checkPublicationRef = useRef(checkPublishedWithdraw);
  checkPublicationRef.current = checkPublishedWithdraw;
  const readVerdictsRef = useRef(readWithdrawVerdicts);
  readVerdictsRef.current = readWithdrawVerdicts;

  // Once per account, before the first paint that could show a stale-looking empty feed.
  useEffect(() => {
    // HYDRATION needs an account — it fills the on-screen feed for whoever is looking. The
    // RESUME below deliberately does not; see `listResumableDeliveries` (D-264).
    const closedUnseen = closedUnseenRef.current;
    if (intentsAccountId && hydratedRef.current !== intentsAccountId) {
      hydrateFromRescueStore(intentsAccountId, closedUnseen);
      // Set AFTER the work, not before: marking the account hydrated first would leave it
      // marked even if hydration threw partway, and the records past the throw would sit out
      // the whole session.
      hydratedRef.current = intentsAccountId;

      // Tell this account about anything that closed before it could see it. Same signal the
      // live path sends, so the toast and the My Account badge behave identically whether the
      // delivery was observed with the user watching or during the restore window.
      //
      // Only the ids this account claimed are forgotten: another signer's record has to stay
      // remembered in case THEY log in later in the same page.
      for (const id of [...closedUnseen]) {
        const row = mockContract
          .getTrackedWithdrawals(intentsAccountId)
          .find((r) => r.intentId === id);
        if (!row) continue;
        closedUnseen.delete(id);
        if (row.status === "DELIVERED") onDeliveredRef.current?.(row);
        else if (row.status === "REFUNDED") onRefundedRef.current?.(row);
        // Only `closeNeverExecuted` closes a record as FAILED on a resume.
        else if (row.status === "FAILED") onNeverExecutedRef.current?.(row);
      }
    }

    // Recomputed on EVERY run of this effect, deliberately — see `listResumableDeliveries`.
    const openIds = listOpenRecordIds();
    if (openIds.length === 0) return;

    // D-259, the half that needs the chain: re-open the delivery wait for every settled
    // record that never got an answer. Aborted on unmount so a closed dashboard stops
    // polling — the record stays on the worklist and the next mount picks it up again.
    const controller = new AbortController();
    const wait = resumeDeliveryRef.current ?? waitForWithdrawDelivery;
    const check = checkPublicationRef.current ?? ((record: PublicationToCheck) => checkPublication(record));
    const readVerdicts = readVerdictsRef.current ?? fetchWithdrawVerdicts;
    const inFlight = inFlightRef.current;

    /**
     * Shows a record this page just CLOSED — to the account on screen, or, when it belongs to
     * nobody visible yet, remembers it for hydration (`closedUnseen`). Shared by both resumes.
     */
    const announceClosed = (id: string, notify: typeof onDeliveredRef) => {
      // Looked up under the account being SHOWN, never under the record's own signer —
      // which is what keeps another account's resumed delivery from firing this one's
      // toast and badge, now that the worklist is no longer filtered by login (D-264).
      // Only `hydrateFromRescueStore` puts a record in here, and only under its own
      // signer, so a record belonging to somebody else simply is not found.
      const updated = mockContract
        .getTrackedWithdrawals(intentsAccountId)
        .find((r) => r.intentId === id);
      if (updated) notify.current?.(updated);
      // Closed with nobody able to see it — either the session had not restored yet, or the
      // record belongs to a signer who is not the one on screen. Remembered so hydration
      // can still surface it when that account arrives; without this the row simply
      // vanishes, which is the defect cross-review reproduced.
      else closedUnseenRef.current.add(id);
    };

    /**
     * The D-259 delivery wait for a settled record. Shared by the settled records found on load
     * and by an unanswered publish the relay turns out to have settled (D-463).
     */
    const awaitDelivery = async (item: ResumableDelivery) => {
      try {
        const delivery = await wait({
          tokenId: item.tokenId,
          route: item.route,
          chainId: item.chainId,
          txHash: item.txHash,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;

        // HOT can confirm a delivery it cannot name (`destinationTxHash: null`), and
        // `near-settlement` has no destination transaction at all. Delivery is still
        // delivery: the absence of a hash is not the absence of an answer.
        const destinationTxHash =
          "destinationTxHash" in delivery && delivery.destinationTxHash
            ? delivery.destinationTxHash
            : undefined;

        // `destinationTxHash` is spread into the stored record as-is, so passing an explicit
        // `undefined` would ERASE a hash another tab had already recorded — two tabs share
        // localStorage but not the in-memory tracking, so both can wait on one withdrawal,
        // and on `hot-omni` one of them can legitimately answer without a hash. Only write
        // the key when there is something to write.
        updateWithdrawRecord(item.id, {
          status: "delivered",
          ...(destinationTxHash !== undefined && { destinationTxHash }),
        });
        // A no-op when this record is not tracked in memory, which is the normal case for a
        // record resumed while nobody is logged in. The durable store above is what carries
        // the answer to the next mount.
        mockContract.setWithdrawalStatus(item.id, "DELIVERED", { destinationTxHash });
        announceClosed(item.id, onDeliveredRef);
      } catch (e) {
        if (controller.signal.aborted) return;
        // Past settlement the funds have already left the balance, so an unanswered wait is
        // NOT a failure and must never take FAILED's copy or colour: it may still arrive.
        // The error is persisted so the next reload starts from what we learned rather than
        // from a confident "Settled on NEAR" — which is the freeze this fix exists to end.
        updateWithdrawRecord(item.id, { error: describeError(e) });
        mockContract.setWithdrawalStatus(item.id, "UNCONFIRMED");
      }
    };

    const resumeDeliveries = (items: ResumableDelivery[]) => {
      for (const item of items) {
        // Guards against two waits on one withdrawal, NOT against ever waiting twice: the key
        // is dropped when the wait settles, and the whole set is dropped when the cleanup
        // aborts. A wait that was killed must be free to start again — the previous version
        // marked an id resumed forever, which fired only in the cases where it did harm.
        if (inFlight.has(item.id)) continue;
        inFlight.add(item.id);
        void awaitDelivery(item).finally(() => releaseKey(item.id));
      }
    };

    /**
     * Frees a key when its work settles — unless the cleanup already cleared the set: by then a
     * newer run may own the same key, and deleting it would let a third run start a duplicate.
     */
    const releaseKey = (id: string) => {
      if (!controller.signal.aborted) inFlight.delete(id);
    };

    /** The check never throws; an injected one might, and that is the same as no answer. */
    const safeCheck = async (record: PublicationToCheck): Promise<PublicationVerdict> => {
      try {
        return await check(record);
      } catch (e) {
        return { kind: "unknown", reason: describeError(e) };
      }
    };

    /**
     * Proven never executed: the balance is intact, so the record is `failed` like any refusal.
     * Every verdict below goes through `resolveUnansweredPublish`: written only if no other tab
     * has moved the record on meanwhile.
     */
    const closeNeverExecuted = (id: string) => {
      const wrote = resolveUnansweredPublish(id, {
        status: "failed",
        error: "Never executed: nonce unused past the intent deadline",
      });
      if (!wrote) return;
      mockContract.setWithdrawalStatus(id, "FAILED");
      announceClosed(id, onNeverExecutedRef);
    };

    // D-463: a direct withdrawal whose publish never got an answer.
    const resumePublications = (items: ResumablePublication[]) => {
      for (const item of items) {
        if (inFlight.has(item.id)) continue;
        inFlight.add(item.id);

        void (async () => {
          const verdict = await safeCheck(item);
          if (controller.signal.aborted) return;

          if (verdict.kind === "settled") {
            // From here it is the D-259 case — and a NEAR route answers at once.
            if (!resolveUnansweredPublish(item.id, { status: "settled", txHash: verdict.txHash })) return;
            mockContract.setWithdrawalStatus(item.id, "SETTLED", { txHash: verdict.txHash });
            await awaitDelivery({
              id: item.id,
              signerId: item.signerId,
              tokenId: item.tokenId,
              route: item.route,
              chainId: item.chainId,
              txHash: verdict.txHash,
            });
          } else if (verdict.kind === "executed") {
            if (settlesOnNear(item)) {
              // The settlement WAS the delivery; only its transaction is unknown.
              if (!resolveUnansweredPublish(item.id, { status: "delivered" })) return;
              mockContract.setWithdrawalStatus(item.id, "DELIVERED");
              announceClosed(item.id, onDeliveredRef);
            } else {
              // Out of the balance, but the bridge wait is keyed on the settlement transaction the
              // relay no longer names. `settled` is what is known; the error says what is not, so
              // it shows as unconfirmed and is not re-checked on every load.
              const wrote = resolveUnansweredPublish(item.id, {
                status: "settled",
                error: "Executed on NEAR (nonce used); settlement tx unknown, delivery not checkable",
              });
              if (!wrote) return;
              mockContract.setWithdrawalStatus(item.id, "UNCONFIRMED");
            }
          } else if (verdict.kind === "never-executed") {
            closeNeverExecuted(item.id);
          } else {
            // Left as it was: asked again on the next load.
            console.log(`[withdraw] ${item.id} still unresolved: ${verdict.reason}`);
          }
        })().finally(() => releaseKey(item.id));
      }
    };

    // Plan 020 §5.4: an open conversion is asked about by its deposit address. Only 1Click's
    // SUCCESS or REFUNDED closes it; FAILED and an unanswered watch leave it open and say so.
    const watchConversion = resumeConversionRef.current ?? waitForConversionOutcome;
    const resumeConversions = (items: ResumableConversion[]) => {
      for (const item of items) {
        if (inFlight.has(item.id)) continue;
        inFlight.add(item.id);

        void (async () => {
          try {
            // D-463: a transfer that provably never ran has nothing for 1Click to report — its watch
            // would only time out into "unconfirmed". Anything else, 1Click decides.
            if (item.publication) {
              const verdict = await safeCheck(item.publication);
              if (controller.signal.aborted) return;
              if (verdict.kind === "never-executed") {
                closeNeverExecuted(item.id);
                return;
              }
            }
            const outcome = await watchConversion({
              depositAddress: item.depositAddress,
              quoteSignature: item.quoteSignature,
              // The quote's own estimate did not survive the reload; the floor covers Bitcoin.
              timeoutMs: conversionWatchBudgetMs(null),
              signal: controller.signal,
              // D-436: a row hydrated as UNCONFIRMED from a stored `error` goes back to Converting
              // while 1Click itself reports PROCESSING. Only that state, only from UNCONFIRMED; the
              // final outcome below still decides the end state.
              onReading: (r) => {
                if (controller.signal.aborted || r.status !== "PROCESSING") return;
                const row = mockContract
                  .getTrackedWithdrawals(intentsAccountId)
                  .find((w) => w.intentId === item.id);
                if (row?.status === "UNCONFIRMED") mockContract.setWithdrawalStatus(item.id, "SETTLED");
              },
            });
            if (controller.signal.aborted) return;

            if (outcome.kind === "delivered") {
              const destinationTxHash = outcome.reading.destinationTxHash ?? undefined;
              const deliveredAmountRaw = outcome.reading.amountOutRaw ?? undefined;
              // Same rule as the bridge resume: never write an explicit `undefined` over a hash
              // another tab may already have recorded.
              updateWithdrawRecord(item.id, {
                status: "delivered",
                ...(destinationTxHash !== undefined && { destinationTxHash }),
                ...(deliveredAmountRaw !== undefined && { deliveredAmount: deliveredAmountRaw }),
              });
              // What arrived, not what was sent: the "delivered" toast reads it (cross-review 020-4).
              mockContract.setWithdrawalStatus(item.id, "DELIVERED", {
                destinationTxHash,
                deliveredAmountRaw,
              });
              announceClosed(item.id, onDeliveredRef);
            } else if (outcome.kind === "refunded") {
              const refundedAmount = outcome.reading.refundedAmountRaw ?? undefined;
              updateWithdrawRecord(item.id, {
                status: "refunded",
                ...(refundedAmount !== undefined && { refundedAmount }),
              });
              mockContract.setWithdrawalStatus(item.id, "REFUNDED");
              announceClosed(item.id, onRefundedRef);
            } else {
              // FAILED, or no final answer in time. Neither a loss nor a refund: the transfer may
              // still be settling, or the money is with 1Click. The record stays open for the next
              // mount.
              const error =
                outcome.kind === "failed" ? "1Click reported FAILED" : outcome.detail;
              updateWithdrawRecord(item.id, { error });
              mockContract.setWithdrawalStatus(item.id, "UNCONFIRMED");
            }
          } catch (e) {
            // The default watch never throws; an injected one might. Same answer as no answer.
            if (controller.signal.aborted) return;
            updateWithdrawRecord(item.id, { error: describeError(e) });
            mockContract.setWithdrawalStatus(item.id, "UNCONFIRMED");
          } finally {
            releaseKey(item.id);
          }
        })();
      }
    };

    /**
     * 024-D — the solver's final verdict, when it has one, closes the record before any re-check
     * runs. It outlives everything the browser can ask: the relay forgets the intent within days,
     * and a bridge wait needs the settlement tx the relay named. Guarded like every other close
     * here (`closeWithServerVerdict`): a record another tab closed meanwhile keeps that answer.
     *
     * Not mirrored back to the ops database: the verdict came from there.
     */
    const closeWithVerdict = (id: string, answer: WithdrawVerdictAnswer) => {
      const { verdict, txHash, destinationTxHash } = answer;
      // A conversion's delivery and refund are left to the 1Click resume below: 1Click answers by
      // deposit address for good, and only it knows the amount that arrived or came back — the
      // verdict carries none, and the toast would show what was SENT under the symbol of what
      // arrives (cross-review 024-D).
      if (verdict !== "never_executed" && getWithdrawRecord(id)?.kind === "conversion") return;
      if (verdict === "delivered") {
        // Same rule as the resumes: never write an explicit `undefined` over a stored hash.
        const hashes = {
          ...(txHash !== undefined && { txHash }),
          ...(destinationTxHash !== undefined && { destinationTxHash }),
        };
        if (!closeWithServerVerdict(id, { status: "delivered", ...hashes })) return;
        mockContract.setWithdrawalStatus(id, "DELIVERED", hashes);
        announceClosed(id, onDeliveredRef);
      } else if (verdict === "refunded") {
        if (!closeWithServerVerdict(id, { status: "refunded" })) return;
        mockContract.setWithdrawalStatus(id, "REFUNDED");
        announceClosed(id, onRefundedRef);
      } else {
        // The close `closeNeverExecuted` makes, which the solver proved the same way — and only
        // from the same statuses: a record this browser saw settle has left the balance, whatever
        // a mismatched verdict says (cross-review 024-D).
        const wrote = closeWithServerVerdict(
          id,
          { status: "failed", error: "Never executed: nonce unused past the intent deadline" },
          ["publishing", "published"]
        );
        if (!wrote) return;
        mockContract.setWithdrawalStatus(id, "FAILED");
        announceClosed(id, onNeverExecutedRef);
      }
      // The trace the wet test reads to tell which path closed the record.
      console.log(`[withdraw] ${id} closed by the solver's verdict: ${verdict}`);
    };

    void (async () => {
      let verdicts: Record<string, WithdrawVerdictAnswer> = {};
      try {
        verdicts = await readVerdicts(openIds);
      } catch {
        /* the default read never throws; an injected one might — same as no verdict */
      }
      if (controller.signal.aborted) return;
      for (const id of openIds) {
        const answer = verdicts[id.toLowerCase()];
        if (answer) closeWithVerdict(id, answer);
      }
      // Listed AFTER the verdicts, so a record they closed is not re-checked.
      resumeDeliveries(listResumableDeliveries());
      resumePublications(listResumablePublications());
      resumeConversions(listResumableConversions());
    })();

    return () => {
      controller.abort();
      // These waits are dead. Forgetting them is what lets a later mount reopen them.
      inFlight.clear();
    };
  }, [intentsAccountId]);

  const records = intentsAccountId
    ? mockContract.getTrackedWithdrawals(intentsAccountId)
    : [];

  // Start mock timers for each newly PENDING withdrawal. Guard prevents double-scheduling.
  // ~25% of withdrawals (deterministic by intentId) follow the FAILED path:
  //   TX_BROADCASTED (30s) → FAILED + refund (60s)
  // The rest follow the happy path: TX_BROADCASTED → SETTLED → DELIVERED.
  useEffect(() => {
    for (const record of records) {
      // The real path reports its own stages, including the ones that are NOT failures.
      // A simulated 25% failure fired at a real withdrawal would refund a balance the mock
      // does not own and label money that is in flight as lost.
      if (record.isReal) continue;
      if (record.status !== "PENDING") continue;
      if (scheduledRef.current.has(record.intentId)) continue;
      scheduledRef.current.add(record.intentId);

      const intentId = record.intentId;

      if (willSimulateFail(intentId)) {
        const broadcastId = setTimeout(() => {
          mockContract.setWithdrawalStatus(intentId, "TX_BROADCASTED");
        }, 30_000);
        const failId = setTimeout(() => {
          mockContract.refundWithdrawal(intentId);
          const updated = mockContract
            .getTrackedWithdrawals(intentsAccountId)
            .find((r) => r.intentId === intentId);
          if (updated) onFailedRef.current?.(updated);
        }, 60_000);
        timerIdsRef.current.push(broadcastId, failId);
      } else {
        let cumulative = 0;
        for (const step of MOCK_PROGRESSION) {
          cumulative += step.delay;
          const delay = cumulative;
          const { status } = step;
          const id = setTimeout(() => {
            mockContract.setWithdrawalStatus(intentId, status);
            if (status === "DELIVERED") {
              const updated = mockContract
                .getTrackedWithdrawals(intentsAccountId)
                .find((r) => r.intentId === intentId);
              if (updated) onDeliveredRef.current?.(updated);
            }
          }, delay);
          timerIdsRef.current.push(id);
        }
      }
    }
  });

  useEffect(() => {
    return () => {
      timerIdsRef.current.forEach(clearTimeout);
    };
  }, []);

  return records;
}
