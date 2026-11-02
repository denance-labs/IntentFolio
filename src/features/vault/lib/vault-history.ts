// A real account's movements as the chain says them (triage 016, block 1b; D-339; 017-7, D-364):
// the event shape the screens map (`ChainHistoryEvent`), the extractor that pulls an account's
// events out of one transaction, and the History mapper's view of them. Since 028-7 the browser
// reads these events from the history route (`/api/history/account`, D-010), never from
// FastNEAR; the extractor stays for the comparison script and for the tests that build their
// events from real transactions. The source of truth is the NEP-297 events of the vault and of
// `intents.near`.
//
// What it can see:
//   - from the vault, the events that carry the user's `account_id`: `portfolio_created`,
//     `allocate`, `unallocate` and, from the final contract on, `portfolio_composition_changed`,
//     `portfolio_renamed` and `portfolio_deleted`. Not rebalances: their rows carry no
//     `account_id`, so they are not indexed under the user;
//   - from `intents.near`, the account's finished deposits (`mt_mint`, memo `deposit`) and
//     withdrawals (`mt_burn`, memo `withdraw`). Measured s219 on `pablofork.near`: both the
//     bridge's and the wallet's deposits mint, and every withdrawal route burns.
// The staging contract (v1.0.0) emits nothing for composition edits, so its edits have no row.
//
// Trust rules — each one has a test:
//   - only logs whose receipt was EXECUTED BY THE EXPECTED CONTRACT count. A log line has no
//     author; any contract can print an `intentfolio-vault` or `nep245` envelope naming any user;
//   - only SUCCESSFUL receipts. A failed Allocate emits no vault event, but a log from a
//     reverted receipt must never become a row either;
//   - only events naming THIS account. For `intents.near` that is the `owner_id`: the same
//     transaction can mint or burn for other accounts (s219: the solver's burns of a rebalance
//     sat in transactions listed under the user).
//
// Attribution: see ATTRIBUTIONS.md #8 (IntentFolio vault contract events) and #21 (FastNEAR).

import type { ContractEvent } from "@/features/intents-account/mock-contract/types";
import { getTokenById } from "@/features/market/lib/token-registry";
import { toRegistryTokenId } from "@/features/market/lib/intents-token-id";
import { fromBaseUnits } from "./base-units";
import { INTENTS_CONTRACT_ID } from "@/features/wallet/config/network";
import { parseVaultEventLine } from "./vault-events";
import type { CompositionEdit, SignedTarget } from "@/features/history-recorder/lib/signed-change-set";
import type { FastNearTx } from "./vault-history-client";

/** The vault events kept from the chain. Everything else is ignored. */
export const VAULT_EVENTS: ReadonlySet<string> = new Set([
  "portfolio_created",
  "allocate",
  "unallocate",
  "portfolio_composition_changed",
  "portfolio_renamed",
  "portfolio_deleted",
]);

/** The ones a portfolio's History maps; the rest only feed My Account's recent activity. */
export const PORTFOLIO_HISTORY_EVENTS: ReadonlySet<string> = new Set([
  "portfolio_created",
  "allocate",
  "unallocate",
  "portfolio_composition_changed",
]);

/**
 * Names given to the account's `intents.near` movements. Prefixed so no vault event can ever
 * be read as one: the vault's own names are bare snake_case.
 */
export const ACCOUNT_DEPOSIT_EVENT = "intents:deposit";
export const ACCOUNT_WITHDRAWAL_EVENT = "intents:withdrawal";
/**
 * A `transfer` to a 1Click deposit address that IntentFolio recorded as a Converting Withdrawal
 * (028-8, D-423). Only the history route emits it: the chain alone cannot tell it from a gas
 * purchase or a send to any other 64-hex account.
 */
export const ACCOUNT_CONVERSION_EVENT = "intents:conversion";
/**
 * A Setup's Storage Cost (D-528, D-539): its `transfer` to the ops account with memo `storage`.
 * Only the history route emits it, and only for a transaction already on the page: it is shown
 * with the creation it paid for, never as a row of its own.
 */
export const ACCOUNT_STORAGE_COST_EVENT = "intents:storage_cost";

/** NEP-245 event → (memo it must carry, name it is kept under). */
const INTENTS_MOVEMENTS: Record<string, { memo: string; event: string }> = {
  mt_mint: { memo: "deposit", event: ACCOUNT_DEPOSIT_EVENT },
  mt_burn: { memo: "withdraw", event: ACCOUNT_WITHDRAWAL_EVENT },
};

/**
 * One vault event as read from the chain, before any presentation. It keeps the contract's own
 * units (base-unit strings): the conversion runs on every read.
 */
export type ChainHistoryEvent = {
  txHash: string;
  /** Position within the transaction, for a stable event id. */
  index: number;
  /** Milliseconds: the block of the receipt that emitted it. */
  ts: number;
  event: string;
  data: Record<string, unknown>;
  /**
   * From the history route only (028-7), what a page cannot know from its own events. On
   * `portfolio_renamed`: the name it replaced, when the chain has one.
   */
  previousName?: string;
  /** On `portfolio_composition_changed`: what the signed edit said (D-489); null when unreadable. */
  edit?: CompositionEdit | null;
  /** On `portfolio_composition_changed`: the whole composition it replaced (D-530); null when unknown. */
  before?: SignedTarget[] | null;
};

function receiptSucceeded(status: Record<string, unknown>): boolean {
  return "SuccessValue" in status || "SuccessReceiptId" in status;
}

type Nep245Log = { event: string; data: Array<Record<string, unknown>> };

function parseNep245Line(line: string): Nep245Log | null {
  if (!line.startsWith("EVENT_JSON:")) return null;
  try {
    const parsed = JSON.parse(line.slice("EVENT_JSON:".length)) as {
      standard?: unknown;
      event?: unknown;
      data?: unknown;
    };
    if (parsed.standard !== "nep245" || typeof parsed.event !== "string" || !Array.isArray(parsed.data)) {
      return null;
    }
    return { event: parsed.event, data: parsed.data as Array<Record<string, unknown>> };
  } catch {
    return null;
  }
}

/**
 * The account's deposits and withdrawals in one `intents.near` log line, one per token. The
 * data keeps the intents token id and the base-unit amount, as the vault events keep theirs.
 */
function intentsMovements(line: string, accountId: string): Array<{ event: string; data: Record<string, unknown> }> {
  const parsed = parseNep245Line(line);
  const kind = parsed ? INTENTS_MOVEMENTS[parsed.event] : undefined;
  if (!parsed || !kind) return [];
  const out: Array<{ event: string; data: Record<string, unknown> }> = [];
  for (const entry of parsed.data) {
    if (entry.owner_id !== accountId || entry.memo !== kind.memo) continue;
    const tokenIds = Array.isArray(entry.token_ids) ? entry.token_ids : [];
    const amounts = Array.isArray(entry.amounts) ? entry.amounts : [];
    tokenIds.forEach((token, i) => {
      out.push({ event: kind.event, data: { account_id: accountId, token, amount: amounts[i] } });
    });
  }
  return out;
}

/** The kept events of one transaction that belong to `accountId`, in emission order. */
export function extractAccountEvents(
  tx: FastNearTx,
  params: { vaultId: string; accountId: string }
): ChainHistoryEvent[] {
  const events: ChainHistoryEvent[] = [];
  for (const receipt of tx.receipts ?? []) {
    const { outcome, block_timestamp } = receipt.execution_outcome;
    const fromVault = outcome.executor_id === params.vaultId;
    const fromIntents = outcome.executor_id === INTENTS_CONTRACT_ID;
    if (!fromVault && !fromIntents) continue;
    if (!receiptSucceeded(outcome.status ?? {})) continue;
    const push = (event: string, data: Record<string, unknown>) =>
      events.push({
        txHash: tx.transaction.hash,
        index: events.length,
        ts: Math.floor(block_timestamp / 1e6),
        event,
        data,
      });
    for (const line of outcome.logs ?? []) {
      if (fromIntents) {
        for (const m of intentsMovements(line, params.accountId)) push(m.event, m.data);
        continue;
      }
      const parsed = parseVaultEventLine(line);
      if (!parsed || !VAULT_EVENTS.has(parsed.event)) continue;
      if (parsed.data.account_id !== params.accountId) continue;
      push(parsed.event, parsed.data);
    }
  }
  return events;
}

export function quantityOf(tokenId: string, raw: unknown): number | null {
  // A token outside the curated registry has no known `decimals`; skipped rather than shown
  // wrong, the same rule as the portfolio projection (project-vault-portfolio.ts).
  const token = getTokenById(tokenId);
  if (!token || typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
  return fromBaseUnits(BigInt(raw), token.decimals);
}

/**
 * The chain events as the History mapper's `ContractEvent`s. One transaction is one commit
 * (`commit_id` = tx hash): a creation and its allocations land together, as one row.
 */
export function toContractEvents(events: ChainHistoryEvent[]): ContractEvent[] {
  // The Storage Cost carries no portfolio id: it belongs to the portfolio created in its transaction.
  const createdIn = new Map<string, string>();
  for (const e of events) {
    if (e.event === "portfolio_created" && e.data.portfolio_id) createdIn.set(e.txHash, String(e.data.portfolio_id));
  }
  const out: ContractEvent[] = [];
  for (const e of events) {
    if (e.event === ACCOUNT_STORAGE_COST_EVENT) {
      const portfolioId = createdIn.get(e.txHash);
      const token = toRegistryTokenId(String(e.data.token ?? ""));
      const qty = quantityOf(token, e.data.amount);
      if (portfolioId === undefined || qty === null) continue;
      out.push({
        kind: "storage_cost",
        event_id: `${e.txHash}:${e.index}`,
        commit_id: e.txHash,
        account_id: String(e.data.account_id),
        portfolio_id: portfolioId,
        token,
        qty,
        ts: e.ts,
      });
      continue;
    }
    if (!PORTFOLIO_HISTORY_EVENTS.has(e.event)) continue;
    const base = {
      event_id: `${e.txHash}:${e.index}`,
      commit_id: e.txHash,
      account_id: String(e.data.account_id),
      portfolio_id: String(e.data.portfolio_id ?? ""),
      ts: e.ts,
    };
    if (!base.portfolio_id) continue;
    if (e.event === "portfolio_created") {
      out.push({ kind: "portfolio_created", ...base, name: String(e.data.name ?? "") });
      continue;
    }
    // The event carries only ids (D-422). What the user signed comes from the history route
    // (`edit`, 028-7, D-489): each new target, each token added or removed. Without it — or
    // unreadable — one generic row, the same on every device.
    if (e.event === "portfolio_composition_changed") {
      if (!e.edit) {
        out.push({ kind: "composition_changed", ...base });
        continue;
      }
      const pct = (bps: number) => bps / 100;
      const line = (i: number) => ({ ...base, event_id: `${base.event_id}:${i}` });
      let i = 0;
      // With the composition it replaced (D-530), only what changed, before → after: the editor
      // signs every token whose target OR tolerance moved, so a tolerance-only edit lists them all.
      const before = new Map((e.before ?? []).map((t) => [t.token, t]));
      for (const t of e.edit.targets) {
        const token = toRegistryTokenId(t.token);
        const was = before.get(t.token);
        if (!was) {
          out.push({ kind: "target_set", ...line(i++), token, target_pct: pct(t.bps), tolerance_pct: pct(t.toleranceBps) });
        } else if (was.bps !== t.bps || was.toleranceBps !== t.toleranceBps) {
          out.push({
            kind: "target_change",
            ...line(i++),
            token,
            old_target_pct: pct(was.bps),
            new_target_pct: pct(t.bps),
            old_tolerance_pct: pct(was.toleranceBps),
            new_tolerance_pct: pct(t.toleranceBps),
          });
        }
      }
      for (const t of e.edit.added) {
        const token = toRegistryTokenId(t.token);
        out.push({ kind: "token_added", ...line(i++), token, initial_target_pct: pct(t.bps), initial_tolerance_pct: pct(t.toleranceBps) });
      }
      for (const removed of e.edit.removed) {
        out.push({ kind: "token_removed", ...line(i++), token: toRegistryTokenId(removed) });
      }
      // An edit that changed nothing the replay can see still happened: keep its row.
      if (i === 0) out.push({ kind: "composition_changed", ...base });
      continue;
    }
    // The vault spells NEAR `nep141:wrap.near`; the registry keys it `near`. Untranslated, every
    // NEAR allocation would be dropped as an unknown token (the same boundary as vault-read-client).
    const token = toRegistryTokenId(String(e.data.token ?? ""));
    const qty = quantityOf(token, e.data.qty);
    if (qty === null) continue;
    if (e.event === "allocate") out.push({ kind: "allocate", ...base, token, qty });
    else if (e.event === "unallocate") out.push({ kind: "unallocate", ...base, token, qty });
  }
  return out;
}
