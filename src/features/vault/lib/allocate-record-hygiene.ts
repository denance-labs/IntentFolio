// Worklist hygiene for the Allocate rescue records, run once per app load (009.plan FE #4).
//
// A record the 120s credit poll gave up on (`suspected_orphan`) that WAS credited later — a
// late `on_auth`, the operator's CLI, the solver's resolver — stayed `suspected_orphan`
// forever: the solver's credential is read-only by design, and nothing here ever re-read the
// store. It costs no funds (the resolver skips it by its on-chain seal) but it sits on every
// worklist a human looks at during an incident, and the table admits no DELETE.
//
// This is the one place that decides what a candidate is. Pure and injectable so the decision
// is testable without a browser: the component in `components/allocate-record-hygiene.tsx`
// only wires the real store, the real seal read and the real sink.
//
// FAIL-OPEN, the inverse of the Allocate's two writes: nothing here may throw, block a render
// or stop an Allocate. Every failure is logged and retried on the next load — the record is
// left as it was, which is what makes the retry happen.

import type { AllocateRescueRecord } from "./allocate-rescue-store";
import type { SealRead } from "./allocate-seal";
import { provesNeverExecuted, type ReadNonceWitness } from "./allocate-never-executed";
import { verdictFor, type AllocateVerdicts, type ReadAllocateVerdicts } from "./allocate-verdicts-client";

export type ReconcileDeps = {
  records: () => AllocateRescueRecord[];
  readSeal: (signerId: string, msg: string) => Promise<SealRead>;
  confirm: (id: string) => Promise<boolean>;
  readNonceWitness: ReadNonceWitness;
  /** `allocate-record-sink.ts` `markAllocateRecordNeverExecuted`: `→ failed`, database first. */
  markNeverExecuted: (id: string) => Promise<boolean>;
  /** `allocate-verdicts-client.ts` `fetchAllocateVerdicts`. Absent ⇒ no verdicts (chain reads only). */
  readVerdicts?: ReadAllocateVerdicts;
  log: (message: string) => void;
  /** Injectable for tests. */
  now?: () => number;
};

/**
 * How long a `failed` record stays a candidate. A seal can only be written while the
 * AuthCall is rescuable — its 72h deadline (`vault-envelope.ts` AUTH_CALL_TTL_SECS) — and
 * the nonce that proves the execution is witnessed for 7 more days: 10 days is the horizon
 * the rescue itself works within. Past it a `failed` row is a real revert (or a lost write)
 * that will never seal, and re-reading it on every load for the rest of the browser's life
 * is a view per row per load for nothing. `suspected_orphan` has no cap: that state is the
 * poll's verdict, not a guess, and it has no other exit.
 */
export const FAILED_CANDIDATE_MAX_AGE_MS = 10 * 24 * 60 * 60 * 1000;

export type ReconcileSummary = {
  candidates: number;
  flipped: number;
  unsealed: number;
  unreadable: number;
  failed: number;
  /** `submitted`/`signing` records with an envelope, checked for a seal or a never-executed proof. */
  sentCandidates: number;
  /** ...of which sealed and flipped to `credited` (026 A0). */
  sentCredited: number;
  /** ...of which proven never executed and flipped to `failed` (D-295). */
  neverExecuted: number;
  /** Candidates of either kind the solver had a final verdict for (D-448); no chain read for them. */
  verdicts: number;
  /** ...of which flipped to `credited` / to `failed` on that verdict. */
  verdictCredited: number;
  verdictNeverExecuted: number;
};

/** The seal reads are cheap and the candidates are few; this only bounds a pathological store. */
const CONCURRENCY = 3;

/**
 * A record the sweep may flip: it is waiting for exactly this, or it might be, and no other
 * process is going to look at it.
 *
 *   - `suspected_orphan`: the poll gave up, the rescue is somebody else's (the operator's
 *     CLI, the solver's resolver, a late `on_auth`), and nothing local ever re-checks it.
 *   - `failed` WITH a signed envelope (FE #5, `922` §8 #15): until FE #5 the submit wrote
 *     `failed` for an Allocate whose Transfer had settled and whose `on_auth` had failed —
 *     the orphan itself, taken off the worklist by its own status. Those rows were rescued
 *     by hand and stay `failed` here forever. The envelope is what tells them apart from a
 *     `failed` that never reached the chain (a declined signature, a lost record write):
 *     it is written between the signature and the submit, so a record without one was
 *     never sent and can have no seal. Reading the seal costs one view; a `failed` that
 *     was a real revert reads `unsealed` and is left alone.
 *
 * `submitted` may still be under the poll in another tab; `signing` and `credited` are not
 * waiting for anything. The list of OWN records stays the browser's (ADR-0017 §8, D-292):
 * this widens what is checked, not where it comes from.
 */
export function isHygieneCandidate(record: AllocateRescueRecord, now: number = Date.now()): boolean {
  if (record.status === "suspected_orphan") return true;
  return (
    record.status === "failed" &&
    record.signedEnvelope !== undefined &&
    now - record.createdAt <= FAILED_CANDIDATE_MAX_AGE_MS
  );
}

/**
 * A record stuck at `submitted`/`signing` that the sweep may settle: it was sent — or at least
 * signed, the envelope is written between the signature and the submit — and nothing local will
 * ever move it again. A tab closed during the credit poll, a relayer that refused before D-312
 * made that `failed` at the source, a crash between signing and sending: all of them sit here
 * forever, and the My Account notice can only hide them while a proof lasts.
 *
 * Two exits, each on its own proof; without one the record is left alone, however old:
 *   - sealed ⇒ `credited` (026 A0). The commonest case — the tab closed before the poll saw the
 *     credit. It has to happen while the seal exists: anyone may purge it once the AuthCall
 *     deadline passes (`942` H3), and after that only the solver's verdict can tell.
 *   - provably never executed ⇒ `failed` (D-295, `provesNeverExecuted`).
 *
 * A live credit poll in another tab does not make the first exit unsafe: the seal proves the
 * credit, and the poll, if it sees it, writes the same `credited`. The second exit cannot reach
 * a polled record: the proof waits for the envelope deadline, and the poll starts before it.
 */
export function isNeverExecutedCandidate(record: AllocateRescueRecord): boolean {
  return (
    (record.status === "submitted" || record.status === "signing") &&
    record.signedEnvelope !== undefined
  );
}

/**
 * Flips every local candidate (`isHygieneCandidate`) whose seal is on chain to `credited`, and
 * every `isNeverExecutedCandidate` to `credited` when sealed (026 A0) or to `failed` when its
 * envelope provably never ran (D-295).
 *
 * A `sealed` read is the ONLY thing that reaches `confirm`; `unsealed` and `unreadable`
 * leave the record for the next load.
 */
export async function reconcileSuspectedOrphans(deps: ReconcileDeps): Promise<ReconcileSummary> {
  const now = (deps.now ?? Date.now)();
  const records = deps.records();
  let candidates = records.filter((r) => isHygieneCandidate(r, now));
  let sent = records.filter(isNeverExecutedCandidate);
  const summary: ReconcileSummary = {
    candidates: candidates.length,
    flipped: 0,
    unsealed: 0,
    unreadable: 0,
    failed: 0,
    sentCandidates: sent.length,
    sentCredited: 0,
    neverExecuted: 0,
    verdicts: 0,
    verdictCredited: 0,
    verdictNeverExecuted: 0,
  };
  if (candidates.length === 0 && sent.length === 0) return summary;

  // D-448: the solver's final verdict first. It outlives both on-chain proofs (the seal can be
  // purged after the AuthCall deadline, the nonce witness expires a week later) and it is
  // permanent, so a record it covers is settled here and never read on chain again:
  //   - `credited` ⇒ `credited`, whatever the local status (the seal path's own transition);
  //   - `never_executed` ⇒ `failed`, unless already `failed`. The solver writes it only past
  //     the deadline with the nonce provably unused — the D-312 proof, read where it still holds;
  //   - `orphan_escalated` ⇒ nothing to write (no status says it), and nothing to read either.
  // A sink that cannot persist leaves the record as it was; the next load reads the verdict again.
  let verdicts: AllocateVerdicts = {};
  try {
    verdicts = (await deps.readVerdicts?.([...candidates, ...sent].map((r) => r.id))) ?? {};
  } catch {
    /* no verdicts: the chain reads below decide, as before D-448 */
  }
  const decided = [...candidates, ...sent].filter((r) => verdictFor(verdicts, r.id) !== undefined);
  summary.verdicts = decided.length;
  for (const record of decided) {
    const verdict = verdictFor(verdicts, record.id);
    try {
      if (verdict === "credited" && (await deps.confirm(record.id))) summary.verdictCredited++;
      if (verdict === "never_executed" && record.status !== "failed" && (await deps.markNeverExecuted(record.id))) {
        summary.verdictNeverExecuted++;
      }
    } catch {
      /* the sinks never throw; if one did, the record stays for the next load */
    }
  }
  candidates = candidates.filter((r) => verdictFor(verdicts, r.id) === undefined);
  sent = sent.filter((r) => verdictFor(verdicts, r.id) === undefined);

  const settle = async (record: AllocateRescueRecord): Promise<"flipped" | "unsealed" | "failed"> => {
    const seal = await deps.readSeal(record.signerId, record.msg);
    if (seal.kind === "unsealed") return "unsealed";
    if (seal.kind === "unreadable") throw new Error(seal.reason);
    return (await deps.confirm(record.id)) ? "flipped" : "failed";
  };

  // `allSettled`, never `all`: one record that cannot be read must not stop the others, and
  // a rejection is counted as unreadable rather than propagated.
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const outcomes = await Promise.allSettled(candidates.slice(i, i + CONCURRENCY).map(settle));
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") summary.unreadable++;
      else summary[outcome.value]++;
    }
  }

  // The seal is read first: a sealed record is a credited Allocate, so it goes to `credited`
  // and never near the never-executed proof — `failed` for it would be the one wrong write this
  // can make. Unreadable ⇒ left as it was. Every failure is swallowed into "not flipped".
  const settleSent = async (record: AllocateRescueRecord): Promise<"credited" | "neverExecuted" | null> => {
    try {
      const seal = await deps.readSeal(record.signerId, record.msg);
      if (seal.kind === "sealed") return (await deps.confirm(record.id)) ? "credited" : null;
      if (seal.kind !== "unsealed") return null;
      if (!(await provesNeverExecuted(record, deps.readNonceWitness, now))) return null;
      return (await deps.markNeverExecuted(record.id)) ? "neverExecuted" : null;
    } catch {
      return null;
    }
  };
  for (let i = 0; i < sent.length; i += CONCURRENCY) {
    const outcomes = await Promise.all(sent.slice(i, i + CONCURRENCY).map(settleSent));
    summary.sentCredited += outcomes.filter((o) => o === "credited").length;
    summary.neverExecuted += outcomes.filter((o) => o === "neverExecuted").length;
  }

  // Counts only — no ids, no signer, no amounts (ADR-0017 §8).
  deps.log(
    `[vault] rescue-record hygiene: ${summary.candidates} candidate(s) checked — ` +
      `${summary.flipped} credited, ${summary.unsealed} still unsealed, ` +
      `${summary.unreadable} unreadable, ${summary.failed} not confirmed; ` +
      `${summary.sentCandidates} sent record(s) checked — ${summary.sentCredited} credited, ` +
      `${summary.neverExecuted} never executed; ` +
      `${summary.verdicts} with a final verdict — ${summary.verdictCredited} credited, ` +
      `${summary.verdictNeverExecuted} never executed`
  );
  return summary;
}
