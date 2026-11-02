// Which of this browser's Allocates are still in transit, for the My Account notice (D-293,
// 012.plan B2). Read-only: nothing here writes a record — flipping `→ credited` stays the job
// of the hygiene sweep (`allocate-record-hygiene.ts`), which is the one place allowed to.
//
// The local `status` alone cannot answer the question. A tab closed during the 120s credit
// poll leaves its record at `submitted` forever (the sweep only re-reads `suspected_orphan` and
// enveloped `failed`), so a status-only notice would report a credited Allocate as pending for
// the rest of the browser's life. The on-chain seal decides instead — the same per-record fact
// the sweep and the solver's resolver use (`allocate-seal.ts`).
//
// The direction of every doubt is "show it": an unreadable seal keeps the row. Over-warning
// costs a notice that lingers until the next load; under-warning hides money in transit.
// The one thing that hides an unsealed record is positive proof that its envelope never ran
// (D-312, `allocate-never-executed.ts`) — a burnt-or-not nonce read under conditions where
// `false` is evidence. The hygiene sweep writes that same verdict down as `failed` (D-295),
// so the row stays gone once the proof expires.
//
// Both on-chain proofs expire: the seal may be purged after the AuthCall deadline, the nonce
// witness a week later. The solver's final verdict (D-448, `allocate-verdicts-client.ts`) does
// not, so it is asked FIRST and, when present, decides without any chain read: `credited` and
// `never_executed` hide the row, `orphan_escalated` keeps it as "under team review". No verdict
// — not decided yet, or the read failed — falls through to the chain reads, as before.

import type { Language } from "@/features/portfolio-editor/types";
import { shellTranslations } from "@/features/dashboard-shell/lib/translations";
import type { AllocateRescueRecord } from "./allocate-rescue-store";
import type { SealRead } from "./allocate-seal";
import { provesNeverExecuted, type ReadNonceWitness } from "./allocate-never-executed";
import { verdictFor, type AllocateVerdicts, type ReadAllocateVerdicts } from "./allocate-verdicts-client";

export type PendingAllocateKind =
  /** The vault refused the credit or the poll gave up: the record is on the rescue worklist. */
  | "completing"
  /** Sent, and its outcome never reached this browser. It may still land by itself. */
  | "confirming"
  /**
   * The solver's final verdict: the funds reached the vault and were never credited
   * (`orphan_escalated`). Permanent — the team's way out does not change it — so the copy says
   * the team is on it, never that the funds are stuck (942 D5).
   */
  | "review";

/** Which AllocateOp the record signed: creating a portfolio, or funding one (D-321). */
export type PendingAllocateOp = "setup" | "allocate_into";

export type PendingAllocate = {
  id: string;
  /** The portfolio being created (setup) or funded (allocate_into). */
  portfolioName: string;
  op: PendingAllocateOp;
  /**
   * The existing portfolio an `allocate_into` funds, read from the signed msg (D-302 g: no
   * column needed). Null for a `setup`, which creates a new one. The delete offer is withheld
   * for a portfolio with a credit still on its way: deleting it would turn that credit into a
   * Return the user waits a week for (ADR-0023).
   */
  portfolioId: string | null;
  /** Base units, verbatim from the record. */
  legs: Array<{ tokenId: string; amount: string }>;
  createdAt: number;
  kind: PendingAllocateKind;
};

/**
 * A record that may hold funds in transit for `signerId`.
 *
 * The signed envelope is the proof it was ever sent: it is written between the signature and
 * the submit, so a record without one (a declined signature, a lost write, a record from before
 * the envelope existed and still at `signing`) never reached the chain. `failed` is a revert or
 * an abort before sending; `credited` is done.
 */
export function isPendingCandidate(record: AllocateRescueRecord, signerId: string): boolean {
  if (record.signerId !== signerId) return false;
  if (record.signedEnvelope === undefined) return false;
  return (
    record.status === "signing" ||
    record.status === "submitted" ||
    record.status === "suspected_orphan"
  );
}

export type FindPendingDeps = {
  records: () => AllocateRescueRecord[];
  readSeal: (signerId: string, msg: string) => Promise<SealRead>;
  /** `intents-read-client.ts` `readNonceWitness`; may throw — a throw is "cannot tell". */
  readNonceWitness: ReadNonceWitness;
  /** `allocate-verdicts-client.ts` `fetchAllocateVerdicts`. Absent ⇒ no verdicts (chain reads only). */
  readVerdicts?: ReadAllocateVerdicts;
  signerId: string;
  /** Injectable for tests. */
  now?: () => number;
};

/**
 * Read from the raw msg the record already keeps, so no new column is needed here or in the
 * ops database. Anything unreadable is `setup`: the only op before D-321, and the row is shown
 * either way — only its wording depends on this.
 */
export function allocateOpOf(msg: string): PendingAllocateOp {
  try {
    const op = (JSON.parse(msg) as { op?: Record<string, unknown> }).op;
    return op && typeof op === "object" && "allocate_into" in op ? "allocate_into" : "setup";
  } catch {
    return "setup";
  }
}

/** The `allocate_into.portfolio_id` of a signed msg; null for a setup or anything unreadable. */
export function allocateIntoPortfolioIdOf(msg: string): string | null {
  try {
    const op = (JSON.parse(msg) as { op?: { allocate_into?: { portfolio_id?: unknown } } }).op;
    const pid = op?.allocate_into?.portfolio_id;
    return typeof pid === "string" ? pid : null;
  } catch {
    return null;
  }
}

/** Same bound as the hygiene sweep: the candidates are few, this only caps a pathological store. */
const CONCURRENCY = 3;

/** In transit = not credited (no seal) and not proven never-executed. Never throws. */
async function isInTransit(
  record: AllocateRescueRecord,
  deps: FindPendingDeps,
  now: number
): Promise<boolean> {
  try {
    if ((await deps.readSeal(record.signerId, record.msg)).kind === "sealed") return false;
  } catch {
    /* unreadable: fall through — a doubt is shown, unless the nonce proves otherwise */
  }
  return !(await provesNeverExecuted(record, deps.readNonceWitness, now));
}

/**
 * The candidates still in transit, newest first. Never throws: every read that fails leaves
 * the record shown.
 */
export async function findPendingAllocates(deps: FindPendingDeps): Promise<PendingAllocate[]> {
  const now = (deps.now ?? Date.now)();
  const candidates = deps.records().filter((r) => isPendingCandidate(r, deps.signerId));
  const pending: PendingAllocate[] = [];
  if (candidates.length === 0) return pending;

  let verdicts: AllocateVerdicts = {};
  try {
    verdicts = (await deps.readVerdicts?.(candidates.map((r) => r.id))) ?? {};
  } catch {
    /* no verdicts: the chain reads below decide, as before D-448 */
  }

  const row = (record: AllocateRescueRecord, kind: PendingAllocateKind): PendingAllocate => ({
    id: record.id,
    portfolioName: record.portfolioName,
    op: allocateOpOf(record.msg),
    portfolioId: allocateIntoPortfolioIdOf(record.msg),
    legs: record.legs ?? [],
    createdAt: record.createdAt,
    kind,
  });

  const undecided: AllocateRescueRecord[] = [];
  for (const record of candidates) {
    const verdict = verdictFor(verdicts, record.id);
    if (verdict === "orphan_escalated") pending.push(row(record, "review"));
    else if (verdict === undefined) undecided.push(record);
    // `credited` / `never_executed`: settled for good, nothing in transit.
  }

  for (let i = 0; i < undecided.length; i += CONCURRENCY) {
    const batch = undecided.slice(i, i + CONCURRENCY);
    const inTransit = await Promise.all(batch.map((r) => isInTransit(r, deps, now)));
    batch.forEach((record, j) => {
      if (!inTransit[j]) return;
      pending.push(row(record, record.status === "suspected_orphan" ? "completing" : "confirming"));
    });
  }

  return pending.sort((a, b) => b.createdAt - a.createdAt);
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * How long ago an Allocate was signed, for the notice: "just now" under a minute, then
 * minutes, hours up to 48 h, then days. Floors each unit so the age never overstates.
 * A `createdAt` in the future (another device's clock) reads as "just now", never as a
 * negative age.
 */
export function formatAllocateAge(createdAt: number, now: number, lang: Language): string {
  const elapsed = now - createdAt;
  if (!(elapsed >= MINUTE_MS)) return shellTranslations[lang].pendingAllocateJustNow;
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "always" });
  if (elapsed < HOUR_MS) return rtf.format(-Math.floor(elapsed / MINUTE_MS), "minute");
  if (elapsed < 48 * HOUR_MS) return rtf.format(-Math.floor(elapsed / HOUR_MS), "hour");
  return rtf.format(-Math.floor(elapsed / DAY_MS), "day");
}
