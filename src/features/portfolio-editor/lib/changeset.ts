// Pure diff between a committed portfolio and an edited draft (5.3.1 / 5.3.2).
//
// The editor edits an ephemeral draft; on Save we compute the minimal
// PortfolioChangeSet that turns the committed portfolio into the draft, show it
// in a preview, sign it once, and hand it to mockContract.commitPortfolioChanges.
//
// 5.3.1 ("composition-first") covered targetChanges / tokenAdditions / tokenRemovals.
// 5.3.2 adds the balance moves: allocations (funds in from General Balance) and
// unallocations (funds back to it), carried in the draft as a signed per-token delta
// (+ = allocate, − = unallocate). They fold into the SAME changeset and signature as
// composition, which is why the interim balance write-through (_devSetBalances) is gone.

import type { PortfolioChangeSet } from "@/features/intents-account/mock-contract/types";
import type { TargetAllocation } from "../types";

// An in-progress input can briefly hold "" — read it as 0. Save is gated by the
// validation engine, so only sum-to-100 drafts ever reach buildChangeSet.
const num = (v: number | "" | undefined): number => (typeof v === "number" ? v : Number(v) || 0);

// Signed per-token balance change relative to the committed portfolio balances.
// + = allocate that qty from General Balance into the portfolio; − = unallocate it back.
export type BalanceDeltas = Record<string, number>;

// Below this (in token units) a delta is treated as no move — guards against float
// noise from slider/percentage math leaking a spurious allocation into the changeset.
const QTY_EPSILON = 1e-9;

/**
 * Minimal diff: committed → draft. Composition rows are keyed by tokenId (the
 * composition primary key); the row `id` is UI-only and never crosses this seam.
 * Balance deltas become allocations (>0) / unallocations (<0). The result, applied
 * by the mock to the committed portfolio, reproduces the draft exactly — so the
 * contract gate and the editor gate agree.
 */
export function buildChangeSet(
  committed: TargetAllocation[],
  draft: TargetAllocation[],
  balanceDeltas: BalanceDeltas = {}
): PortfolioChangeSet {
  const committedByToken = new Map(committed.filter((t) => t.tokenId).map((t) => [t.tokenId, t]));
  const draftByToken = new Map(draft.filter((t) => t.tokenId).map((t) => [t.tokenId, t]));

  const tokenAdditions: NonNullable<PortfolioChangeSet["tokenAdditions"]> = [];
  const targetChanges: NonNullable<PortfolioChangeSet["targetChanges"]> = [];
  const tokenRemovals: NonNullable<PortfolioChangeSet["tokenRemovals"]> = [];
  const allocations: NonNullable<PortfolioChangeSet["allocations"]> = [];
  const unallocations: NonNullable<PortfolioChangeSet["unallocations"]> = [];

  for (const [tokenId, row] of draftByToken) {
    const prev = committedByToken.get(tokenId);
    if (!prev) {
      tokenAdditions.push({
        tokenId,
        initialTargetPct: num(row.targetPct),
        initialTolerancePct: num(row.tolerancePct),
      });
    } else if (
      num(prev.targetPct) !== num(row.targetPct) ||
      num(prev.tolerancePct) !== num(row.tolerancePct)
    ) {
      targetChanges.push({
        tokenId,
        newTargetPct: num(row.targetPct),
        newTolerancePct: num(row.tolerancePct),
      });
    }
  }

  for (const tokenId of committedByToken.keys()) {
    if (!draftByToken.has(tokenId)) tokenRemovals.push({ tokenId });
  }

  for (const [tokenId, delta] of Object.entries(balanceDeltas)) {
    if (!tokenId) continue;
    if (delta > QTY_EPSILON) allocations.push({ tokenId, qty: delta });
    else if (delta < -QTY_EPSILON) unallocations.push({ tokenId, qty: -delta });
  }

  // Omit empty arrays so the changeset is a clean minimal payload.
  const changeset: PortfolioChangeSet = {};
  if (tokenRemovals.length) changeset.tokenRemovals = tokenRemovals;
  if (tokenAdditions.length) changeset.tokenAdditions = tokenAdditions;
  if (targetChanges.length) changeset.targetChanges = targetChanges;
  if (allocations.length) changeset.allocations = allocations;
  if (unallocations.length) changeset.unallocations = unallocations;
  return changeset;
}

export function isEmptyChangeSet(cs: PortfolioChangeSet): boolean {
  return !(
    cs.tokenRemovals?.length ||
    cs.tokenAdditions?.length ||
    cs.targetChanges?.length ||
    cs.allocations?.length ||
    cs.unallocations?.length
  );
}

// Display-ready view of a changeset, enriched with the committed "before" values
// (the changeset itself only carries the new values). Ordering: composition first
// (D-093: removals → additions → targetChanges), then the balance moves (allocations
// → unallocations). Consumed by the confirm modal (render) and the signature text
// (below), so the two can never disagree on what is being signed.
export type ChangeSummary = {
  removals: Array<{ tokenId: string; symbol: string; fromPct: number; fromBand: number }>;
  additions: Array<{ tokenId: string; symbol: string; toPct: number; toBand: number }>;
  targetChanges: Array<{
    tokenId: string;
    symbol: string;
    fromPct: number;
    toPct: number;
    fromBand: number;
    toBand: number;
  }>;
  allocations: Array<{ tokenId: string; symbol: string; qty: number }>;
  unallocations: Array<{ tokenId: string; symbol: string; qty: number }>;
};

export function summarizeChangeSet(
  changeset: PortfolioChangeSet,
  committed: TargetAllocation[],
  symbolFor: (tokenId: string) => string
): ChangeSummary {
  const committedByToken = new Map(committed.filter((t) => t.tokenId).map((t) => [t.tokenId, t]));

  const removals = (changeset.tokenRemovals ?? []).map((r) => {
    const prev = committedByToken.get(r.tokenId);
    return {
      tokenId: r.tokenId,
      symbol: symbolFor(r.tokenId),
      fromPct: num(prev?.targetPct),
      fromBand: num(prev?.tolerancePct),
    };
  });

  const additions = (changeset.tokenAdditions ?? []).map((a) => ({
    tokenId: a.tokenId,
    symbol: symbolFor(a.tokenId),
    toPct: a.initialTargetPct,
    toBand: a.initialTolerancePct,
  }));

  const targetChanges = (changeset.targetChanges ?? []).map((c) => {
    const prev = committedByToken.get(c.tokenId);
    return {
      tokenId: c.tokenId,
      symbol: symbolFor(c.tokenId),
      fromPct: num(prev?.targetPct),
      toPct: c.newTargetPct,
      fromBand: num(prev?.tolerancePct),
      toBand: c.newTolerancePct,
    };
  });

  const allocations = (changeset.allocations ?? []).map((a) => ({
    tokenId: a.tokenId,
    symbol: symbolFor(a.tokenId),
    qty: a.qty,
  }));

  const unallocations = (changeset.unallocations ?? []).map((u) => ({
    tokenId: u.tokenId,
    symbol: symbolFor(u.tokenId),
    qty: u.qty,
  }));

  return { removals, additions, targetChanges, allocations, unallocations };
}

// 021 R2: what the targets table marks while a draft is open, read off the same summary
// the confirm modal renders — so a row is marked exactly when the signature would carry it.
export type RowMark =
  | { kind: "added" }
  // `null` = that value is not changing (only the other one is).
  | { kind: "changed"; fromPct: number | null; fromBand: number | null };

export type RemovedRowMark = { tokenId: string; symbol: string; fromPct: number; fromBand: number };

export type PendingMarks = {
  byTokenId: Record<string, RowMark>;
  /** Signed quantity moving with the commit: + allocate into the portfolio, − back out. */
  balanceMoves: Record<string, number>;
  /** Committed tokens the draft drops (and funds-only ones it empties), in their committed order. */
  removed: RemovedRowMark[];
  /** Each committed token's position, which places the removed rows among the others. */
  committedOrder: Record<string, number>;
};

export function buildPendingMarks(
  summary: ChangeSummary,
  committed: TargetAllocation[],
  // D-536: what the portfolio holds outside its composition (funds-only tokens), keyed in the
  // order the table lists them. One the draft withdraws whole would just vanish from the
  // table, since it has no target to keep its row: it is struck like a removed token instead.
  heldOutside: Record<string, number> = {}
): PendingMarks {
  const committedOrder: Record<string, number> = {};
  committed.forEach((row, i) => {
    if (row.tokenId) committedOrder[row.tokenId] = i;
  });
  // The held tokens follow the composition, as in the table, so a struck one keeps its place.
  let nextOrder = committed.length;
  for (const tokenId of Object.keys(heldOutside)) {
    if (!(tokenId in committedOrder)) committedOrder[tokenId] = nextOrder++;
  }

  const byTokenId: Record<string, RowMark> = {};
  for (const a of summary.additions) byTokenId[a.tokenId] = { kind: "added" };
  for (const c of summary.targetChanges) {
    byTokenId[c.tokenId] = {
      kind: "changed",
      fromPct: c.fromPct !== c.toPct ? c.fromPct : null,
      fromBand: c.fromBand !== c.toBand ? c.fromBand : null,
    };
  }

  const balanceMoves: Record<string, number> = {};
  for (const a of summary.allocations) balanceMoves[a.tokenId] = a.qty;
  for (const u of summary.unallocations) balanceMoves[u.tokenId] = -u.qty;

  const emptied = summary.unallocations
    .filter((u) => (heldOutside[u.tokenId] ?? 0) > 0 && u.qty >= heldOutside[u.tokenId] - QTY_EPSILON)
    .map(({ tokenId, symbol }) => ({ tokenId, symbol, fromPct: 0, fromBand: 0 }));
  const removed = [
    ...summary.removals.map(({ tokenId, symbol, fromPct, fromBand }) => ({ tokenId, symbol, fromPct, fromBand })),
    ...emptied,
  ].sort((a, b) => (committedOrder[a.tokenId] ?? Infinity) - (committedOrder[b.tokenId] ?? Infinity));

  return { byTokenId, balanceMoves, removed, committedOrder };
}

export type PlacedRow<T> = { kind: "row"; row: T } | { kind: "removed"; removed: RemovedRowMark };

// A removed row keeps its place: it goes before the first row that came after it in the
// committed portfolio. Rows the portfolio does not hold yet (additions, held tokens) sort
// last. A token that is still on screen as a row is never doubled by its removed twin.
export function placeRemovedRows<T extends { tokenId: string }>(
  rows: T[],
  marks: Pick<PendingMarks, "removed" | "committedOrder"> | null | undefined
): PlacedRow<T>[] {
  if (!marks || marks.removed.length === 0) return rows.map((row) => ({ kind: "row", row }));
  const shown = new Set(rows.map((row) => row.tokenId));
  const pending = marks.removed.filter((r) => !shown.has(r.tokenId));
  const at = (tokenId: string) => marks.committedOrder[tokenId] ?? Infinity;
  const out: PlacedRow<T>[] = [];
  let next = 0;
  for (const row of rows) {
    while (next < pending.length && at(pending[next].tokenId) < at(row.tokenId)) {
      out.push({ kind: "removed", removed: pending[next++] });
    }
    out.push({ kind: "row", row });
  }
  while (next < pending.length) out.push({ kind: "removed", removed: pending[next++] });
  return out;
}

/**
 * Deterministic human-readable text the wallet signs (D-132 mock path). The mock
 * Verifier ignores the payload today; when the real Verifier lands (E5/E6) this is
 * replaced by the canonical signed JSON — see project-verifier-signs-json-not-prose.
 * Kept in English (source-facing) and free of i18n so the signed bytes are stable.
 */
export function changeSummaryToSignatureText(summary: ChangeSummary, portfolioName: string): string {
  const lines: string[] = [
    "IntentFolio — Confirm portfolio changes",
    `Portfolio: ${portfolioName}`,
  ];
  if (summary.removals.length) {
    lines.push("", "Remove:");
    for (const r of summary.removals) lines.push(`- ${r.symbol}`);
  }
  if (summary.additions.length) {
    lines.push("", "Add:");
    for (const a of summary.additions) lines.push(`- ${a.symbol}: target ${a.toPct}%, band ${a.toBand}%`);
  }
  if (summary.targetChanges.length) {
    lines.push("", "Update targets:");
    for (const c of summary.targetChanges) {
      const band = c.fromBand !== c.toBand ? `band ${c.fromBand}% → ${c.toBand}%` : `band ${c.toBand}%`;
      lines.push(`- ${c.symbol}: target ${c.fromPct}% → ${c.toPct}%, ${band}`);
    }
  }
  if (summary.allocations.length) {
    lines.push("", "Allocate:");
    for (const a of summary.allocations) lines.push(`- ${a.symbol}: ${fmtQty(a.qty)}`);
  }
  if (summary.unallocations.length) {
    lines.push("", "Unallocate:");
    for (const u of summary.unallocations) lines.push(`- ${u.symbol}: ${fmtQty(u.qty)}`);
  }
  return lines.join("\n");
}

// Deterministic token-quantity string for the signed text: fixed-precision then
// trailing-zero trim, so float math ("0.30000000000000004") never reaches the bytes.
function fmtQty(qty: number): string {
  return String(Number(qty.toFixed(8)));
}
