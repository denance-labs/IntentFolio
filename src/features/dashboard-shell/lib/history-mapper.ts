// Presentation layer (7.0) — pure mapper from the lean ContractEvent log to the
// view-model rows the History view renders. This is the local stand-in for what the
// E8 indexer will serve pre-computed.
//
// Responsibilities:
//   - translate ContractEvent `kind` → presentation `type`
//     (receive→deposit, withdraw→withdrawal, external/forced_internal→*_rebalance);
//   - group the events of one Portfolio Commit (shared commit_id, D-082) into a single row
//     carrying its child events for the expand, typed by what the user DID (created, added to
//     the portfolio, moved to the general balance, edited) — "Portfolio Commit" is the
//     source-facing name and never reaches the screen (CONTEXT.md; triage 016, block 1b);
//   - derive the bilingual `reason` from kind + facts (never stored — see 7.0 lock);
//   - convert TokenId → symbol via the token registry and value token moves
//     with the supplied prices;
//   - read frozen before/after composition % from the snapshot store.
//
// Pure: prices and the snapshot getter are injected, so it is fully unit-testable.
// Wiring into the actual views happens in 7.2 (out of 7.0 scope).

import type {
  ContractEvent,
  TokenId,
  PortfolioId,
} from "@/features/intents-account/mock-contract/types";
import { symbolForTokenId } from "@/features/market/lib/token-registry";
import type { TokenPriceMap } from "@/features/market/types";
import {
  eventSnapshotStore,
  type CompositionPct,
  type EventCompositionSnapshot,
} from "./event-presentation-store";

export type HistoryRowType =
  | "deposit"
  | "withdrawal"
  | "external_rebalance"
  | "internal_rebalance"
  // The four commit types, one per user action (the verbs of CONTEXT.md, triage 016 Q1).
  | "portfolio_created"
  | "add_to_portfolio"
  | "move_to_general_balance"
  | "composition_edit"
  /** A commit that both added and moved funds out. The mock allows it; no contract op does. */
  | "portfolio_edit";

export type TokenMove = {
  symbol: string;
  qty: number;
  usdValue: number;
  direction: "in" | "out";
};

export type HistoryRow = {
  // commit_id for a Portfolio Commit group, event_id for a standalone event.
  id: string;
  type: HistoryRowType;
  timestamp: number;
  portfolioId?: PortfolioId;
  tokens: TokenMove[];
  reason: { en: string; es: string };
  before?: CompositionPct[];
  after?: CompositionPct[];
  attributedSpreadUsd?: number;
  // Lean child events of a Portfolio Commit, for the expandable detail (D-082).
  children?: ContractEvent[];
};

function symbolOf(tokenId: TokenId): string {
  return symbolForTokenId(tokenId);
}

function tokenMove(
  tokenId: TokenId,
  qty: number,
  direction: "in" | "out",
  prices: TokenPriceMap
): TokenMove {
  const price = prices[tokenId]?.usdPrice ?? 0;
  return { symbol: symbolOf(tokenId), qty, usdValue: qty * price, direction };
}

// ── reason derivation (bilingual, from kind + facts; never stored) ───────────

function depositReason() {
  return { en: "Manual deposit from wallet.", es: "Depósito manual desde la wallet." };
}

function withdrawalReason() {
  return { en: "Manual withdrawal to wallet.", es: "Retiro manual a la wallet." };
}

function externalRebalanceReason(inSym: string, outSym: string) {
  return {
    en: `${inSym} was below its declared target. An external counterparty swap bought ${inSym} using ${outSym}, moving the portfolio back into band.`,
    es: `${inSym} estaba por debajo de su objetivo declarado. Un swap externo compró ${inSym} usando ${outSym}, reencauzando el portfolio dentro de la banda.`,
  };
}

function internalRebalanceReason(inSym: string, outSym: string) {
  return {
    en: `${outSym} drifted outside its tolerance band with no external swap available. A forced internal rebalance swapped it for ${inSym} to bring the portfolio back.`,
    es: `${outSym} se salió de su banda de tolerancia sin un swap externo disponible. Un rebalanceo interno forzado lo cambió por ${inSym} para reencauzar el portfolio.`,
  };
}

const COMPOSITION_KINDS = new Set<ContractEvent["kind"]>([
  "token_added",
  "token_removed",
  "target_change",
  "target_set",
  "composition_changed",
]);

// What the user did in one commit. Creation wins (its allocations are part of it); then the
// direction of the funds; a commit with no funds moved is a composition edit.
function commitType(children: ContractEvent[]): HistoryRowType {
  const kinds = new Set(children.map((e) => e.kind));
  if (kinds.has("portfolio_created")) return "portfolio_created";
  const added = kinds.has("allocate");
  const moved = kinds.has("unallocate");
  if (added && moved) return "portfolio_edit";
  if (added) return "add_to_portfolio";
  if (moved) return "move_to_general_balance";
  return "composition_edit";
}

function tokensLabel(n: number): string {
  return `${n} token${n === 1 ? "" : "s"}`;
}

// The composition parts of a commit, as clauses: "added 1 token, changed 2 targets".
function compositionClauses(children: ContractEvent[]) {
  const count = (kind: ContractEvent["kind"]) => children.filter((e) => e.kind === kind).length;
  const added = count("token_added");
  const removed = count("token_removed");
  // A `target_change` knows the before (D-530): its target and its tolerance count apart. A
  // `target_set` knows only the after: it counts as a changed target.
  const changes = children.filter((e) => e.kind === "target_change");
  const targets =
    count("target_set") +
    changes.filter((e) => e.old_target_pct !== e.new_target_pct || e.old_tolerance_pct === e.new_tolerance_pct).length;
  const tolerances = changes.filter((e) => e.old_tolerance_pct !== e.new_tolerance_pct).length;
  const en: string[] = [];
  const es: string[] = [];
  if (added) { en.push(`added ${tokensLabel(added)}`); es.push(`agregaste ${tokensLabel(added)}`); }
  if (removed) { en.push(`removed ${tokensLabel(removed)}`); es.push(`quitaste ${tokensLabel(removed)}`); }
  if (targets) {
    en.push(`changed ${targets} target${targets === 1 ? "" : "s"}`);
    es.push(`cambiaste ${targets} objetivo${targets === 1 ? "" : "s"}`);
  }
  if (tolerances) {
    en.push(`changed the tolerance of ${tokensLabel(tolerances)}`);
    es.push(`cambiaste la tolerancia de ${tokensLabel(tolerances)}`);
  }
  return { en, es };
}

// Bilingual summary of a commit, in the user's own verbs (CONTEXT.md, triage 016 Q1).
function commitReason(type: HistoryRowType, children: ContractEvent[]) {
  const tokenCount = (kind: "allocate" | "unallocate") =>
    new Set(children.filter((e) => e.kind === kind).map((e) => ("token" in e ? e.token : ""))).size;
  const edited = children.some((e) => COMPOSITION_KINDS.has(e.kind));
  const andEdited = { en: edited ? " and edited its composition" : "", es: edited ? " y editaste su composición" : "" };

  switch (type) {
    case "portfolio_created": {
      const n = tokenCount("allocate");
      return n
        ? { en: `You created the portfolio and added ${tokensLabel(n)} to it.`, es: `Creaste el portfolio y le asignaste ${tokensLabel(n)}.` }
        : { en: "You created the portfolio.", es: "Creaste el portfolio." };
    }
    case "add_to_portfolio": {
      const n = tokensLabel(tokenCount("allocate"));
      return {
        en: `You added ${n} to the portfolio from your funding account${andEdited.en}.`,
        es: `Asignaste ${n} al portfolio desde tu cuenta de fondos${andEdited.es}.`,
      };
    }
    case "move_to_general_balance": {
      const n = tokensLabel(tokenCount("unallocate"));
      return {
        en: `You moved ${n} from the portfolio to your funding account${andEdited.en}.`,
        es: `Pasaste ${n} del portfolio a tu cuenta de fondos${andEdited.es}.`,
      };
    }
    case "composition_edit": {
      const { en, es } = compositionClauses(children);
      return {
        en: en.length ? `You edited the composition: ${en.join(", ")}.` : "You edited the composition.",
        es: es.length ? `Editaste la composición: ${es.join(", ")}.` : "Editaste la composición.",
      };
    }
    default:
      return { en: "You edited the portfolio.", es: "Editaste el portfolio." };
  }
}

// ── grouping + mapping ───────────────────────────────────────────────────────

function portfolioIdOf(e: ContractEvent): PortfolioId | undefined {
  return "portfolio_id" in e ? e.portfolio_id : undefined;
}

// Net allocate (in) / unallocate (out) moves of a commit, aggregated per token.
function commitTokenMoves(children: ContractEvent[], prices: TokenPriceMap): TokenMove[] {
  const net = new Map<TokenId, number>();
  for (const e of children) {
    if (e.kind === "allocate") net.set(e.token, (net.get(e.token) ?? 0) + e.qty);
    else if (e.kind === "unallocate") net.set(e.token, (net.get(e.token) ?? 0) - e.qty);
  }
  const moves: TokenMove[] = [];
  for (const [tokenId, qty] of net) {
    if (qty === 0) continue;
    moves.push(tokenMove(tokenId, Math.abs(qty), qty > 0 ? "in" : "out", prices));
  }
  return moves;
}

function mapStandalone(
  e: ContractEvent,
  prices: TokenPriceMap,
  getSnapshot: (key: string) => EventCompositionSnapshot | undefined
): HistoryRow | null {
  switch (e.kind) {
    case "receive":
      return {
        id: e.event_id,
        type: "deposit",
        timestamp: e.ts,
        tokens: [tokenMove(e.token, e.qty, "in", prices)],
        reason: depositReason(),
      };
    case "withdraw":
      return {
        id: e.event_id,
        type: "withdrawal",
        timestamp: e.ts,
        tokens: [tokenMove(e.token, e.qty, "out", prices)],
        reason: withdrawalReason(),
      };
    case "external_rebalance": {
      const snap = getSnapshot(e.event_id);
      return {
        id: e.event_id,
        type: "external_rebalance",
        timestamp: e.ts,
        portfolioId: e.portfolio_id,
        tokens: [tokenMove(e.token_in, e.qty_in, "in", prices), tokenMove(e.token_out, e.qty_out, "out", prices)],
        reason: externalRebalanceReason(symbolOf(e.token_in), symbolOf(e.token_out)),
        before: snap?.before,
        after: snap?.after,
        // attributed_spread is already frozen USD (7.0 decision 4).
        attributedSpreadUsd: e.attributed_spread,
      };
    }
    case "forced_internal_rebalance": {
      const snap = getSnapshot(e.event_id);
      return {
        id: e.event_id,
        type: "internal_rebalance",
        timestamp: e.ts,
        portfolioId: e.portfolio_id,
        tokens: [tokenMove(e.token_in, e.qty_in, "in", prices), tokenMove(e.token_out, e.qty_out, "out", prices)],
        reason: internalRebalanceReason(symbolOf(e.token_in), symbolOf(e.token_out)),
        before: snap?.before,
        after: snap?.after,
      };
    }
    default:
      // Commit-scoped kinds are never standalone; handled by the grouping pass.
      return null;
  }
}

// Maps the lean event log to newest-first presentation rows. `prices` value token
// moves; `getSnapshot` defaults to the live snapshot store but can be stubbed in tests.
export function toHistoryRows(
  events: ContractEvent[],
  prices: TokenPriceMap,
  getSnapshot: (key: string) => EventCompositionSnapshot | undefined = eventSnapshotStore.get
): HistoryRow[] {
  const rows: HistoryRow[] = [];
  const commits = new Map<string, ContractEvent[]>();

  for (const e of events) {
    if ("commit_id" in e) {
      const group = commits.get(e.commit_id) ?? [];
      group.push(e);
      commits.set(e.commit_id, group);
    } else {
      const row = mapStandalone(e, prices, getSnapshot);
      if (row) rows.push(row);
    }
  }

  for (const [commitId, children] of commits) {
    const snap = getSnapshot(commitId);
    const type = commitType(children);
    rows.push({
      id: commitId,
      type,
      timestamp: children[0]?.ts ?? 0,
      portfolioId: children.map(portfolioIdOf).find((p) => p !== undefined),
      tokens: commitTokenMoves(children, prices),
      reason: commitReason(type, children),
      before: snap?.before,
      after: snap?.after,
      children,
    });
  }

  return rows.sort((a, b) => b.timestamp - a.timestamp);
}
