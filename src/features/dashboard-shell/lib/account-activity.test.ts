import { describe, expect, it } from "vitest";
import type { WithdrawalInFlightRecord } from "@/features/intents-account/mock-contract/types";
import { ACCOUNT_CONVERSION_EVENT, extractAccountEvents, type ChainHistoryEvent } from "@/features/vault/lib/vault-history";
import {
  DEPOSIT_USDT,
  V2_COMPOSITION,
  V2_CREATE,
  V2_DELETE,
  V2_RENAME,
  V2_UNALLOCATE,
  WITHDRAW_USDT,
} from "@/features/vault/lib/vault-history-v2.fixtures";
import {
  finishedTimeline,
  isFinishedConversion,
  isHistoryConversion,
  joinActivity,
  toCompletedActivity,
  toHistoryConversions,
  withHistoryConversions,
  type CompletedActivity,
} from "./account-activity";

const USER = "pablofork.near";
const V2 = { vaultId: "intentfolio-vault.near", accountId: USER };

// The operator's real-money test of s217, as the chain recorded it: create "Aggressive" with
// USDT, rename it, move its funds out, delete it; plus a second portfolio's mix change and the
// account's own deposit and withdrawal.
const S217 = [V2_CREATE, V2_RENAME, V2_UNALLOCATE, V2_DELETE, V2_COMPOSITION, DEPOSIT_USDT, WITHDRAW_USDT].flatMap(
  (tx) => extractAccountEvents(tx, V2)
);

type PortfolioRow = Extract<CompletedActivity, { kind: "portfolio" }>;
type MovementRow = Extract<CompletedActivity, { kind: "deposit" | "withdrawal" }>;

describe("toCompletedActivity", () => {
  const rows = toCompletedActivity(S217);
  const portfolioRows = rows.filter((r): r is PortfolioRow => r.kind === "portfolio");

  it("one row per thing done to a portfolio; a creation and its allocation are one", () => {
    const of = (id: string) => portfolioRows.filter((r) => r.portfolioId === id).map((r) => r.action);
    // Newest first.
    expect(of("p_000000000000")).toEqual(["deleted", "moved", "renamed", "created"]);
    expect(of("p_000000000001")).toEqual(["composition"]);
  });

  it("newest first across every kind", () => {
    const ts = rows.map((r) => r.ts);
    expect(ts).toEqual([...ts].sort((a, b) => b - a));
  });

  it("a rename names the name it replaced and the new one; the rest carry the last known name", () => {
    const renamed = portfolioRows.find((r) => r.action === "renamed")!;
    expect(renamed.renamedFrom).toBe("Aggressive");
    expect(renamed.renamedTo).toBe("AgrRenamed");
    expect(portfolioRows.find((r) => r.action === "created")!.name).toBe("AgrRenamed");
  });

  // 028-7: a page need not hold the creation or the earlier renames; the route says them.
  it("on a page without them, the names come from the server: the latest one and a rename's previous", () => {
    const page = S217.filter((e) => e.event !== "portfolio_created").map((e) =>
      e.event === "portfolio_renamed" ? { ...e, previousName: "Aggressive" } : e
    );
    const out = toCompletedActivity(page, { p_000000000000: "AgrRenamed" }).filter(
      (r): r is PortfolioRow => r.kind === "portfolio" && r.portfolioId === "p_000000000000"
    );
    expect(out.find((r) => r.action === "renamed")).toMatchObject({ renamedFrom: "Aggressive", renamedTo: "AgrRenamed" });
    expect(out.find((r) => r.action === "moved")!.name).toBe("AgrRenamed");
  });

  it("a deletion by the solver (by: operator) is marked; the user's own is not (D-420 b)", () => {
    expect(portfolioRows.find((r) => r.action === "deleted")!.byOperator).toBeUndefined();
    const removed = toCompletedActivity([
      { txHash: "t1", index: 0, ts: 1, event: "portfolio_deleted", data: { portfolio_id: "p_9", by: "operator" } },
    ])[0] as PortfolioRow;
    expect(removed.action).toBe("deleted");
    expect(removed.byOperator).toBe(true);
  });

  it("the account's deposit and withdrawal, with the token's quantity", () => {
    const movements = rows.filter((r): r is MovementRow => r.kind !== "portfolio");
    expect(movements.map((m) => [m.kind, m.tokenId, m.qty])).toEqual(
      expect.arrayContaining([
        ["deposit", "nep141:usdt.tether-token.near", 2.457698],
        ["withdrawal", "nep141:usdt.tether-token.near", 0.5],
      ])
    );
  });

  it("wNEAR is shown as the registry's NEAR, and an unknown token is skipped", () => {
    const raw = (token: string, index: number): ChainHistoryEvent => ({
      txHash: "h",
      index,
      ts: 1,
      event: "intents:deposit",
      data: { account_id: USER, token, amount: "1000000000000000000000000" },
    });
    const rows = toCompletedActivity([raw("nep141:wrap.near", 0), raw("nep141:unknown.near", 1)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "deposit", tokenId: "near", qty: 1 });
  });

  it("a withdrawal carries where it landed only with a destination tx on a bridge route (D-582)", () => {
    const raw = (event: string, token: string, destination_tx: unknown, index: number): ChainHistoryEvent => ({
      txHash: `h${index}`,
      index: 0,
      ts: 1,
      event,
      data: { account_id: USER, token, amount: "500000", destination_tx },
    });
    const ZEC_TX = "0ca4c1687d8e3b0f2a9e4c51b7d3a6f8e2c9b0a1d4f7e3c6b9a2d5f8e1c4b7a0";
    const rows = toCompletedActivity([
      raw("intents:withdrawal", "nep141:zec.omft.near", ZEC_TX, 0),
      // No verdict yet: as before, only "Sent".
      raw("intents:withdrawal", "nep141:zec.omft.near", undefined, 1),
      // A NEAR token has no destination chain to link: ignored.
      raw("intents:withdrawal", "nep141:usdt.tether-token.near", ZEC_TX, 2),
      // Not a hash: never passed along as text.
      raw("intents:withdrawal", "nep141:zec.omft.near", "<a href=x>", 3),
      // A deposit never carries one.
      raw("intents:deposit", "nep141:zec.omft.near", ZEC_TX, 4),
    ]) as MovementRow[];
    const byTx = new Map(rows.map((r) => [r.txHash, r.destination]));
    expect(byTx.get("h0")).toEqual({ chainId: "zec:mainnet", txHash: ZEC_TX });
    expect([1, 2, 3, 4].map((i) => byTx.get(`h${i}`))).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("funds added and moved out in one transaction are an edit, not either one", () => {
    const e = (event: string, index: number): ChainHistoryEvent => ({
      txHash: "h",
      index,
      ts: 1,
      event,
      data: { account_id: USER, portfolio_id: "p_1", token: "nep141:usdt.tether-token.near", qty: "1" },
    });
    const rows = toCompletedActivity([e("allocate", 0), e("unallocate", 1)]);
    expect(rows).toMatchObject([{ action: "edited" }]);
    // In and out summed into one list would say nothing true (D-431).
    expect((rows[0] as PortfolioRow).amounts).toEqual([]);
  });

  it("rows that moved funds carry the nominal amounts; the others carry none (D-431)", () => {
    const amountsOf = (action: string) => portfolioRows.find((r) => r.action === action)!.amounts;
    expect(amountsOf("created").length).toBeGreaterThan(0);
    expect(amountsOf("moved").length).toBeGreaterThan(0);
    for (const { tokenId, qty } of [...amountsOf("created"), ...amountsOf("moved")]) {
      expect(tokenId).toBe("nep141:usdt.tether-token.near");
      expect(qty).toBeGreaterThan(0);
    }
    expect(amountsOf("renamed")).toEqual([]);
    expect(amountsOf("composition")).toEqual([]);
  });

  it("one entry per token: the same token twice in a transaction is summed, wNEAR is NEAR", () => {
    const allocate = (token: string, qty: string, index: number): ChainHistoryEvent => ({
      txHash: "h",
      index,
      ts: 1,
      event: "allocate",
      data: { account_id: USER, portfolio_id: "p_1", token, qty },
    });
    const rows = toCompletedActivity([
      allocate("nep141:usdt.tether-token.near", "1000000", 0),
      allocate("nep141:usdt.tether-token.near", "500000", 1),
      allocate("nep141:wrap.near", "2000000000000000000000000", 2),
      allocate("nep141:unknown.near", "1", 3),
    ]);
    expect((rows[0] as PortfolioRow).amounts).toEqual([
      { tokenId: "nep141:usdt.tether-token.near", qty: 1.5 },
      { tokenId: "near", qty: 2 },
    ]);
  });
});

describe("joinActivity", () => {
  const completed = toCompletedActivity(S217);
  const chainWithdrawal = completed.find((r): r is MovementRow => r.kind === "withdrawal")!;
  const chainDeposit = completed.find((r): r is MovementRow => r.kind === "deposit")!;
  const none = { withdrawals: [] };

  const tracked = (status: WithdrawalInFlightRecord["status"]): WithdrawalInFlightRecord => ({
    intentId: "w1",
    tokenId: "nep141:usdt.tether-token.near",
    qty: 0.5,
    chainId: "near:mainnet",
    destinationAddress: USER,
    status,
    ts: 1,
    txHash: chainWithdrawal.txHash,
    isReal: true,
  });

  it("a withdrawal still on its way keeps its tracked row and hides the chain's", () => {
    const out = joinActivity({ ...none, completed, withdrawals: [tracked("SETTLED")] });
    expect(out.withdrawals).toHaveLength(1);
    expect(out.completed.some((r) => r.id === chainWithdrawal.id)).toBe(false);
  });

  it("once delivered, the chain's row stays and the tracked one leaves", () => {
    const out = joinActivity({ ...none, completed, withdrawals: [tracked("DELIVERED")] });
    expect(out.withdrawals).toEqual([]);
    expect(out.completed.some((r) => r.id === chainWithdrawal.id)).toBe(true);
  });

  // D-584: an `omft` withdrawal ends as sent — final, so the chain's own "Sent" row takes over.
  it("once sent, the chain's row stays and the tracked one leaves", () => {
    const out = joinActivity({ ...none, completed, withdrawals: [tracked("SENT")] });
    expect(out.withdrawals).toEqual([]);
    expect(out.completed.some((r) => r.id === chainWithdrawal.id)).toBe(true);
  });

  it("a delivered withdrawal the chain read does not have yet stays tracked", () => {
    const out = joinActivity({ ...none, completed: [], withdrawals: [tracked("DELIVERED")] });
    expect(out.withdrawals).toHaveLength(1);
  });

  it("a sent withdrawal the chain read does not have yet stays tracked", () => {
    const out = joinActivity({ ...none, completed: [], withdrawals: [tracked("SENT")] });
    expect(out.withdrawals).toHaveLength(1);
  });

  it("before the chain read lands nothing is hidden", () => {
    const out = joinActivity({ completed: [], withdrawals: [tracked("SETTLED")] });
    expect(out.withdrawals).toHaveLength(1);
  });

  it("a chain deposit passes through untouched", () => {
    const out = joinActivity({ ...none, completed });
    expect(out.completed).toContain(chainDeposit);
  });
});

describe("isFinishedConversion (D-440)", () => {
  const w = (status: WithdrawalInFlightRecord["status"], deliveryTokenId?: string) =>
    ({ intentId: "w", tokenId: "x", qty: 1, chainId: "near:mainnet", destinationAddress: "a.near", status, ts: 1, isReal: true, deliveryTokenId }) as WithdrawalInFlightRecord;

  it("is a conversion that was delivered or came back, nothing else", () => {
    expect(isFinishedConversion(w("DELIVERED", "nep141:usdt.tether-token.near"))).toBe(true);
    expect(isFinishedConversion(w("REFUNDED", "nep141:usdt.tether-token.near"))).toBe(true);
    for (const status of ["PENDING", "TX_BROADCASTED", "SETTLED", "UNCONFIRMED", "FAILED"] as const) {
      expect(isFinishedConversion(w(status, "nep141:usdt.tether-token.near"))).toBe(false);
    }
    // A direct one hands over to its chain row (`joinActivity`); it is not filed here.
    expect(isFinishedConversion(w("DELIVERED"))).toBe(false);
  });

  it("files conversions among the chain rows, newest first", () => {
    const rows = toCompletedActivity(S217);
    const mid = rows[Math.floor(rows.length / 2)].ts;
    const out = finishedTimeline(rows, [{ ...w("DELIVERED", "t"), ts: mid + 1 }]);
    expect(out).toHaveLength(rows.length + 1);
    expect(out.map((i) => i.ts)).toEqual([...out.map((i) => i.ts)].sort((a, b) => b - a));
  });
});

describe("toHistoryConversions / withHistoryConversions (028-8, D-423)", () => {
  const DEPOSIT_ADDRESS = "b3d8e1c1307a4cc180501e170a7bef826380917cd0c4453d937b2ba3085428aa";
  const conversion = (txHash: string, outcome: string, extra: Record<string, unknown> = {}): ChainHistoryEvent => ({
    txHash,
    index: 0,
    ts: 1_760_000_000_000,
    event: ACCOUNT_CONVERSION_EVENT,
    data: {
      account_id: USER,
      token: "nep141:nbtc.bridge.near",
      amount: "14170",
      deposit_address: DEPOSIT_ADDRESS,
      chain_id: "btc:mainnet",
      delivery_token: "nep141:btc.omft.near",
      outcome,
      destination_tx: null,
      ...extra,
    },
  });

  it("the row this browser draws for its own conversions, never under a record id; a final one files with the finished", () => {
    const [done] = toHistoryConversions([conversion("TxDone", "delivered", { destination_tx: "btc-tx" })]);
    expect(done).toMatchObject({
      tokenId: "nep141:nbtc.bridge.near",
      qty: 0.0001417,
      chainId: "btc:mainnet",
      destinationAddress: "",
      status: "DELIVERED",
      txHash: "TxDone",
      destinationTxHash: "btc-tx",
      deliveryTokenId: "nep141:btc.omft.near",
      depositAddress: DEPOSIT_ADDRESS,
    });
    expect(isHistoryConversion(done)).toBe(true);
    expect(isFinishedConversion(done)).toBe(true);
  });

  it("delivered or refunded to its status; anything else, or a network or token the registry does not know, is skipped", () => {
    const rows = toHistoryConversions([
      conversion("A", "refunded"),
      conversion("B", "unconfirmed"),
      conversion("C", "converting"),
      conversion("D", "something-new"),
      conversion("E", "delivered", { token: "nep141:not-in-the-registry.near" }),
      // The record's own fields are unchecked: never free text on screen.
      conversion("F", "delivered", { chain_id: "Send support your seed phrase" }),
      conversion("G", "delivered", { delivery_token: "nep141:free-text.near" }),
      conversion("H", "delivered", { chain_id: "__proto__" }),
    ]);
    expect(rows.map((r) => [r.txHash, r.status])).toEqual([["A", "REFUNDED"]]);
    expect(toHistoryConversions(S217)).toEqual([]);
  });

  it("this browser's own row wins for the same transfer; the history adds the rest", () => {
    const fromHistory = toHistoryConversions([conversion("TxMine", "refunded"), conversion("TxOther", "delivered")]);
    const mine = { ...fromHistory[0], intentId: "local-record-id", status: "DELIVERED" } as WithdrawalInFlightRecord;
    const merged = withHistoryConversions([mine], fromHistory);
    expect(merged.map((w) => [w.intentId, w.txHash])).toEqual([
      ["local-record-id", "TxMine"],
      [fromHistory[1].intentId, "TxOther"],
    ]);
    expect(isHistoryConversion(mine)).toBe(false);
  });
});
