// My Account's recent activity, the finished half (017-7, D-364): the account's chain events
// as one row per thing the user did, plus the joins that keep a movement still tracked in
// flight from showing twice once the chain has it too.
//
// Pure: the chain events and the in-flight lists are passed in.
//
// Attribution: see ATTRIBUTIONS.md #21 (FastNEAR; the `intents.near` NEP-245 deposit and
// withdrawal events it surfaces).

import type { ChainHistoryEvent } from "@/features/vault/lib/vault-history";
import {
  ACCOUNT_CONVERSION_EVENT,
  ACCOUNT_DEPOSIT_EVENT,
  ACCOUNT_WITHDRAWAL_EVENT,
  quantityOf,
} from "@/features/vault/lib/vault-history";
import { toRegistryTokenId } from "@/features/market/lib/intents-token-id";
import { getTokenById } from "@/features/market/lib/token-registry";
import { chainRegistry } from "@/features/bridge/lib/chain-registry";
import type {
  WithdrawalInFlightRecord,
  WithdrawalStatusKind,
} from "@/features/intents-account/mock-contract/types";

/** What the user did to a portfolio in one transaction. */
export type PortfolioAction =
  | "created"
  | "added"
  | "moved"
  /** Funds added and moved out in one operation. No contract op does it today; kept honest. */
  | "edited"
  | "composition"
  | "renamed"
  | "deleted";

export type CompletedActivity =
  | {
      kind: "portfolio";
      id: string;
      ts: number;
      txHash: string;
      portfolioId: string;
      action: PortfolioAction;
      /** The portfolio's last name the chain knows of; the view prefers the live one. */
      name: string;
      /** Only on `renamed`: the names before and after, as they were at that moment. */
      renamedFrom?: string;
      renamedTo?: string;
      /** Only on `deleted`: the solver removed it (`by: "operator"`, an empty portfolio), not the user. */
      byOperator?: true;
      /**
       * What the transaction moved in or out of the portfolio, in tokens, one entry per token
       * (D-431). Nominal on purpose: a past row in today's USD would misstate it. Empty when no
       * funds moved, and on `edited`, where in and out would be summed into one meaningless list.
       */
      amounts: { tokenId: string; qty: number }[];
    }
  | {
      kind: "deposit" | "withdrawal";
      id: string;
      ts: number;
      txHash: string;
      /** Registry id. */
      tokenId: string;
      qty: number;
      /** Base units as the chain wrote them, for the joins. */
      amount: string;
    };

/** Rows per "show more" step, here and in a portfolio's History (D-364 5). */
export const ACTIVITY_PAGE_SIZE = 20;

// The order an action wins when one transaction did several things to the same portfolio.
// Creation and deletion are what the user remembers; a rename never travels with funds.
function actionOf(kinds: Set<string>): PortfolioAction {
  if (kinds.has("portfolio_deleted")) return "deleted";
  if (kinds.has("portfolio_created")) return "created";
  const added = kinds.has("allocate");
  const moved = kinds.has("unallocate");
  if (added && moved) return "edited";
  if (added) return "added";
  if (moved) return "moved";
  if (kinds.has("portfolio_composition_changed")) return "composition";
  return "renamed";
}

/**
 * The finished rows, newest first. `events` are the account's chain events in any order.
 * A token outside the registry is skipped, never shown with guessed decimals (the rule of
 * `toContractEvents`).
 *
 * `names` and each rename's `previousName` come from the history route (028-7): a page need
 * not hold a portfolio's creation or its earlier renames. Without them the names fold from the
 * events at hand, as when the whole history was read at once.
 */
export function toCompletedActivity(events: ChainHistoryEvent[], names: Readonly<Record<string, string>> = {}): CompletedActivity[] {
  // Oldest first, so the names fold forward: a rename row must show the name it replaced.
  const ordered = [...events].sort((a, b) => a.ts - b.ts || a.index - b.index);
  const nameOf = new Map<string, string>();
  type Group = { ts: number; txHash: string; portfolioId: string; kinds: Set<string>; amounts: Map<string, number>; from?: string; to?: string; byOperator?: true };
  const groups = new Map<string, Group>();
  const rows: CompletedActivity[] = [];

  for (const e of ordered) {
    if (e.event === ACCOUNT_DEPOSIT_EVENT || e.event === ACCOUNT_WITHDRAWAL_EVENT) {
      const tokenId = toRegistryTokenId(String(e.data.token ?? ""));
      const qty = quantityOf(tokenId, e.data.amount);
      if (qty === null) continue;
      rows.push({
        kind: e.event === ACCOUNT_DEPOSIT_EVENT ? "deposit" : "withdrawal",
        id: `${e.txHash}:${e.index}`,
        ts: e.ts,
        txHash: e.txHash,
        tokenId,
        qty,
        amount: String(e.data.amount),
      });
      continue;
    }

    const portfolioId = String(e.data.portfolio_id ?? "");
    if (!portfolioId) continue;
    const key = `${e.txHash}:${portfolioId}`;
    const group: Group = groups.get(key) ?? { ts: e.ts, txHash: e.txHash, portfolioId, kinds: new Set<string>(), amounts: new Map() };
    group.kinds.add(e.event);
    if (e.event === "allocate" || e.event === "unallocate") {
      // The vault spells NEAR `nep141:wrap.near`; same boundary and skip rule as toContractEvents.
      const tokenId = toRegistryTokenId(String(e.data.token ?? ""));
      const qty = quantityOf(tokenId, e.data.qty);
      if (qty !== null) group.amounts.set(tokenId, (group.amounts.get(tokenId) ?? 0) + qty);
    }
    if (e.event === "portfolio_deleted" && e.data.by === "operator") group.byOperator = true;
    if (e.event === "portfolio_created" || e.event === "portfolio_renamed") {
      const name = String(e.data.name ?? "");
      if (e.event === "portfolio_renamed") {
        group.from = e.previousName ?? nameOf.get(portfolioId);
        group.to = name;
      }
      if (name) nameOf.set(portfolioId, name);
    }
    groups.set(key, group);
  }

  for (const [key, g] of groups) {
    const action = actionOf(g.kinds);
    rows.push({
      kind: "portfolio",
      id: key,
      ts: g.ts,
      txHash: g.txHash,
      portfolioId: g.portfolioId,
      action,
      name: names[g.portfolioId] ?? nameOf.get(g.portfolioId) ?? "",
      ...(action === "renamed" && { renamedFrom: g.from, renamedTo: g.to }),
      ...(action === "deleted" && g.byOperator && { byOperator: true as const }),
      amounts: action === "edited" ? [] : [...g.amounts].map(([tokenId, qty]) => ({ tokenId, qty })),
    });
  }

  return rows.sort((a, b) => b.ts - a.ts);
}

const CONVERSION_STATUS: Record<string, WithdrawalStatusKind> = {
  delivered: "DELIVERED",
  refunded: "REFUNDED",
};

/** Ids of the rows below: never a withdrawal record's id, which only its own browser holds. */
const HISTORY_CONVERSION_PREFIX = "history:";

/**
 * The Converting Withdrawals the history route found for the account (028-8, D-423), as the rows
 * this browser draws for the ones it tracks itself — on every device. Only finished ones reach
 * it (010 lists a conversion once the solver says delivered or refunded), so none is in progress.
 *
 * 🔴 The network and the token that arrives come from the withdrawal record, which a public
 * route writes and nobody checks against 1Click yet (the solver's open decision). So a row is
 * drawn only when both are ones the registry knows — never free text from the record. The
 * destination address is not even read (010 leaves it out). The one link is the registry's
 * explorer with the verdict's destination hash. Same skip rule as
 * `toCompletedActivity` for the token sent: never shown with guessed decimals.
 */
export function toHistoryConversions(events: ChainHistoryEvent[]): WithdrawalInFlightRecord[] {
  const rows: WithdrawalInFlightRecord[] = [];
  for (const e of events) {
    if (e.event !== ACCOUNT_CONVERSION_EVENT) continue;
    const tokenId = toRegistryTokenId(String(e.data.token ?? ""));
    const qty = quantityOf(tokenId, e.data.amount);
    const status = CONVERSION_STATUS[String(e.data.outcome)];
    const chainId = String(e.data.chain_id ?? "");
    const deliveryTokenId = toRegistryTokenId(String(e.data.delivery_token ?? ""));
    if (qty === null || !status || !Object.hasOwn(chainRegistry, chainId) || !getTokenById(deliveryTokenId)) continue;
    const destinationTx = e.data.destination_tx;
    rows.push({
      intentId: `${HISTORY_CONVERSION_PREFIX}${e.txHash}:${e.index}`,
      tokenId,
      qty,
      chainId,
      // Shown only on a row this browser can dismiss, which these never are.
      destinationAddress: "",
      status,
      ts: e.ts,
      txHash: e.txHash,
      ...(typeof destinationTx === "string" && destinationTx !== "" && { destinationTxHash: destinationTx }),
      deliveryTokenId,
      depositAddress: String(e.data.deposit_address ?? ""),
      isReal: true,
      leftBalance: true,
    });
  }
  return rows;
}

/** A row `toHistoryConversions` made: this browser has no record to dismiss behind it. */
export function isHistoryConversion(w: WithdrawalInFlightRecord): boolean {
  return w.intentId.startsWith(HISTORY_CONVERSION_PREFIX);
}

/**
 * This browser's own rows win over the history's for the same transfer: they carry what it
 * watched itself (1Click's delivered amount, the code while unconfirmed) and can be dismissed.
 */
export function withHistoryConversions(
  tracked: WithdrawalInFlightRecord[],
  fromHistory: WithdrawalInFlightRecord[]
): WithdrawalInFlightRecord[] {
  const trackedTxs = new Set(tracked.flatMap((w) => (w.txHash ? [w.txHash] : [])));
  return [...tracked, ...fromHistory.filter((w) => !trackedTxs.has(w.txHash ?? ""))];
}

type ChainMovement = Extract<CompletedActivity, { kind: "deposit" | "withdrawal" }>;

function movements(completed: CompletedActivity[], kind: ChainMovement["kind"]): ChainMovement[] {
  return completed.filter((r): r is ChainMovement => r.kind === kind);
}

/**
 * The joins between what this browser tracks and what the chain says is finished:
 *
 *   - a withdrawal still tracked hides its chain row by the NEAR transaction hash until the
 *     tracker says DELIVERED — the burn lands at settlement, while the bridge may still be
 *     delivering, and "in progress" is the truth until then. Once DELIVERED the chain row wins.
 *     The tracked row learns the hash at settlement (`onSettled`, 028-7), not at delivery;
 *   - a bridge deposit the bridge reports credited is the history's once it has been read: the
 *     history database records every deposit for every browser (028-7), and its row may sit on
 *     a page not loaded yet, or before the floor (decision 7) — the bridge lists its last
 *     deposits whatever their age, with no time to tell them apart. Only the pending ones stay.
 * A deposit from the NEAR wallet needs no join any more (D-490): the local ledger's row is gone.
 *
 * Before the history read lands nothing is hidden, so the feed degrades to today's lists.
 */
export function joinActivity<B extends { credited: boolean }>(params: {
  completed: CompletedActivity[];
  /** The history read has landed (`completed` is what it holds so far). */
  historyRead: boolean;
  withdrawals: WithdrawalInFlightRecord[];
  bridgeDeposits: B[];
}): {
  completed: CompletedActivity[];
  withdrawals: WithdrawalInFlightRecord[];
  bridgeDeposits: B[];
} {
  const withdrawalRows = movements(params.completed, "withdrawal");
  const hiddenChainRows = new Set<string>();

  const withdrawals = params.withdrawals.filter((w) => {
    const onChain = w.txHash ? withdrawalRows.filter((m) => m.txHash === w.txHash) : [];
    if (onChain.length === 0) return true;
    if (w.status === "DELIVERED") return false;
    onChain.forEach((m) => hiddenChainRows.add(m.id));
    return true;
  });

  const bridgeDeposits = params.historyRead ? params.bridgeDeposits.filter((d) => !d.credited) : params.bridgeDeposits;

  return {
    completed: params.completed.filter((r) => !hiddenChainRows.has(r.id)),
    withdrawals,
    bridgeDeposits,
  };
}

/**
 * A Converting Withdrawal that is over: delivered, or sent back to the General Balance (D-440).
 *
 * It belongs with the finished rows, not with what is in progress — and unlike a direct
 * withdrawal it never gets a chain row to hand over to (its `transfer` to 1Click is not an
 * `mt_burn`), so the tracked row itself is filed there, by date.
 */
export function isFinishedConversion(w: WithdrawalInFlightRecord): boolean {
  return w.deliveryTokenId !== undefined && (w.status === "DELIVERED" || w.status === "REFUNDED");
}

/** One finished row of the feed: the chain's, or a conversion only this browser recorded. */
export type FinishedActivityItem =
  | { kind: "chain"; ts: number; row: CompletedActivity }
  | { kind: "conversion"; ts: number; withdrawal: WithdrawalInFlightRecord };

/** The finished rows and the finished conversions as one list, newest first, for paging. */
export function finishedTimeline(
  completed: CompletedActivity[],
  conversions: WithdrawalInFlightRecord[]
): FinishedActivityItem[] {
  return [
    ...completed.map((row) => ({ kind: "chain" as const, ts: row.ts, row })),
    ...conversions.map((withdrawal) => ({ kind: "conversion" as const, ts: withdrawal.ts, withdrawal })),
  ].sort((a, b) => b.ts - a.ts);
}
