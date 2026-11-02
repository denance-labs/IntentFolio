// @vitest-environment node
import { describe, it, expect } from "vitest";
import { toHistoryRows } from "./history-mapper";
import type { EventCompositionSnapshot } from "./event-presentation-store";
import type { ContractEvent } from "@/features/intents-account/mock-contract/types";
import type { TokenPriceMap } from "@/features/market/types";

const prices: TokenPriceMap = {
  near: { symbol: "NEAR", usdPrice: 2, updatedAt: "", source: "test" },
  USDC: { symbol: "USDC", usdPrice: 1, updatedAt: "", source: "test" },
};

const snapshots: Record<string, EventCompositionSnapshot> = {
  "commit-1": { before: [{ symbol: "NEAR", pct: 100 }], after: [{ symbol: "NEAR", pct: 90 }] },
  "evt-rebal": { before: [{ symbol: "NEAR", pct: 35 }], after: [{ symbol: "NEAR", pct: 48 }] },
};
const getSnapshot = (key: string) => snapshots[key];

const log: ContractEvent[] = [
  { kind: "receive", event_id: "evt-recv", account_id: "a", token: "near", qty: 10, chain: "near", bridge_tx: "tx", ts: 1000 },
  { kind: "register_user", event_id: "evt-reg", commit_id: "commit-1", account_id: "a", ts: 2000 },
  { kind: "portfolio_created", event_id: "evt-pc", commit_id: "commit-1", account_id: "a", portfolio_id: "p1", name: "P", ts: 2000 },
  { kind: "allocate", event_id: "evt-alloc", commit_id: "commit-1", account_id: "a", portfolio_id: "p1", token: "near", qty: 5, ts: 2000 },
  { kind: "external_rebalance", event_id: "evt-rebal", account_id: "a", portfolio_id: "p1", token_in: "near", qty_in: 1, token_out: "USDC", qty_out: 2, attributed_spread: 0.5, ts: 3000 },
];

describe("toHistoryRows", () => {
  const rows = toHistoryRows(log, prices, getSnapshot);

  it("returns rows newest-first", () => {
    expect(rows.map((r) => r.timestamp)).toEqual([3000, 2000, 1000]);
  });

  it("groups a Portfolio Commit's events into one row with its children", () => {
    const commit = rows.find((r) => r.id === "commit-1");
    expect(commit?.type).toBe("portfolio_created");
    expect(commit?.id).toBe("commit-1");
    expect(commit?.children).toHaveLength(3);
    // net allocate move: +5 NEAR valued at $2 = $10
    expect(commit?.tokens).toEqual([{ symbol: "NEAR", qty: 5, usdValue: 10, direction: "in" }]);
    expect(commit?.before).toEqual(snapshots["commit-1"].before);
  });

  it("translates kinds to presentation types", () => {
    expect(rows.find((r) => r.id === "evt-recv")?.type).toBe("deposit");
    expect(rows.find((r) => r.id === "evt-rebal")?.type).toBe("external_rebalance");
  });

  it("derives bilingual reason and resolves token symbols", () => {
    const deposit = rows.find((r) => r.id === "evt-recv");
    expect(deposit?.reason.es).toContain("Depósito");
    expect(deposit?.tokens[0].symbol).toBe("NEAR");
    expect(deposit?.tokens[0].usdValue).toBe(20); // 10 × $2

    const rebal = rows.find((r) => r.id === "evt-rebal");
    expect(rebal?.reason.en).toContain("NEAR was below");
  });

  it("passes through frozen attributed_spread (USD) and the rebalance snapshot", () => {
    const rebal = rows.find((r) => r.id === "evt-rebal");
    expect(rebal?.attributedSpreadUsd).toBe(0.5);
    expect(rebal?.after).toEqual(snapshots["evt-rebal"].after);
    expect(rebal?.tokens).toEqual([
      { symbol: "NEAR", qty: 1, usdValue: 2, direction: "in" },
      { symbol: "USDC", qty: 2, usdValue: 2, direction: "out" },
    ]);
  });
});

// Triage 016, block 1b: a commit row says what the user DID, in the verbs of CONTEXT.md.
// "Portfolio Commit" is the source-facing name of the operation and never reaches the screen.
describe("commit rows — one type per user action", () => {
  const ev = (kind: string, extra: Record<string, unknown> = {}) =>
    ({ event_id: `${kind}-${Math.random()}`, commit_id: "c", account_id: "a", portfolio_id: "p1", ts: 1, kind, ...extra }) as unknown as ContractEvent;
  const rowOf = (events: ContractEvent[]) => toHistoryRows(events, prices, () => undefined)[0];

  it.each([
    ["portfolio_created", [ev("portfolio_created", { name: "P" }), ev("allocate", { token: "near", qty: 1 })]],
    ["add_to_portfolio", [ev("allocate", { token: "near", qty: 1 })]],
    ["move_to_general_balance", [ev("unallocate", { token: "near", qty: 1 })]],
    ["composition_edit", [ev("target_change", { token: "near", old_target_pct: 50, new_target_pct: 60 })]],
    ["portfolio_edit", [ev("allocate", { token: "near", qty: 1 }), ev("unallocate", { token: "USDC", qty: 1 })]],
  ])("%s", (type, events) => {
    expect(rowOf(events as ContractEvent[]).type).toBe(type);
  });

  it("a move to the general balance that also edited the composition says both", () => {
    const row = rowOf([ev("unallocate", { token: "near", qty: 1 }), ev("token_removed", { token: "USDC" })]);
    expect(row.type).toBe("move_to_general_balance");
    expect(row.reason.es).toBe("Pasaste 1 token del portfolio a tu cuenta de fondos y editaste su composición.");
    expect(row.reason.en).toBe("You moved 1 token from the portfolio to your funding account and edited its composition.");
  });

  // D-422: the final vault's `portfolio_composition_changed` carries no detail.
  it("a chain composition edit is a generic composition_edit row", () => {
    const row = rowOf([ev("composition_changed")]);
    expect(row.type).toBe("composition_edit");
    expect(row.tokens).toEqual([]);
    expect(row.reason).toEqual({ en: "You edited the composition.", es: "Editaste la composición." });
  });

  it("an add to the portfolio that also edited the composition on-chain says both", () => {
    const row = rowOf([ev("allocate", { token: "near", qty: 1 }), ev("composition_changed")]);
    expect(row.type).toBe("add_to_portfolio");
    expect(row.reason.es).toBe("Asignaste 1 token al portfolio desde tu cuenta de fondos y editaste su composición.");
    expect(row.reason.en).toBe("You added 1 token to the portfolio from your funding account and edited its composition.");
  });

  it("a composition edit lists what changed", () => {
    const row = rowOf([
      ev("token_added", { token: "near", initial_target_pct: 0, initial_tolerance_pct: 5 }),
      ev("target_change", { token: "USDC", old_target_pct: 50, new_target_pct: 60 }),
      ev("target_change", { token: "near", old_target_pct: 0, new_target_pct: 40 }),
    ]);
    expect(row.reason.es).toBe("Editaste la composición: agregaste 1 token, cambiaste 2 objetivos.");
  });

  it("never says \"Portfolio Commit\"", () => {
    const all = toHistoryRows(log, prices, getSnapshot).flatMap((r) => [r.reason.en, r.reason.es]);
    for (const text of all) expect(text).not.toMatch(/portfolio commit/i);
  });
});
