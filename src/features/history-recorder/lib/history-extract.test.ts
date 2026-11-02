import { describe, it, expect } from "vitest";
import type { FastNearTx } from "@/features/vault/lib/vault-history-client";
import {
  countMissingReceipts,
  extractTx,
  HistoryShapeError,
  portfolioRowsOf,
  sanitizeJsonText,
  type ExtractedTx,
} from "./history-extract";
import {
  COMMIT_WITHDRAW,
  CREATE_FIRST,
  DELETE,
  FAILED_ADMIN,
  NO_VAULT_RECEIPT,
  REBALANCE,
  RENAME,
} from "./history-recorder.fixtures";

const VAULT = "intentfolio-vault.near";

function complete(x: ExtractedTx): Extract<ExtractedTx, { complete: true }> {
  if (!x.complete) throw new Error("expected a finished transaction");
  return x;
}

const clone = (tx: FastNearTx): FastNearTx => JSON.parse(JSON.stringify(tx)) as FastNearTx;

/** The vault receipt of a fixture that carries logs, for tests that rewrite it. */
function vaultReceipt(tx: FastNearTx, which = 0) {
  return tx.receipts.filter((r) => r.execution_outcome.outcome.executor_id === VAULT)[which];
}

const line = (event: string, data: Record<string, unknown>, version = "2.0.0") =>
  `EVENT_JSON:${JSON.stringify({ standard: "intentfolio-vault", version, event, data: [data] })}`;

describe("sanitizeJsonText — only what jsonb refuses, nothing else", () => {
  it("leaves text without a \\u escape exactly as it was, big integers included", () => {
    const text = '{"eta":18446744073709551615,"name":"Agresivo ñ 😀","q":"a\\"b\\\\c"}';
    expect(sanitizeJsonText(text)).toBe(text);
  });

  it("replaces an escaped NUL with U+FFFD", () => {
    expect(sanitizeJsonText('{"name":"x\\u0000y"}')).toBe('{"name":"x\\ufffdy"}');
  });

  it("does not touch an escaped backslash followed by the letters u0000", () => {
    const text = '{"name":"x\\\\u0000y"}';
    expect(sanitizeJsonText(text)).toBe(text);
    expect(JSON.parse(text).name).toBe("x\\u0000y");
  });

  it("an escaped backslash, then a real NUL escape: only the second is replaced", () => {
    expect(sanitizeJsonText('{"n":"\\\\\\u0000"}')).toBe('{"n":"\\\\\\ufffd"}');
  });

  it("keeps a surrogate pair, replaces the halves that are alone", () => {
    expect(sanitizeJsonText('"\\ud83d\\ude00"')).toBe('"\\ud83d\\ude00"');
    expect(sanitizeJsonText('"\\ud83dx"')).toBe('"\\ufffdx"');
    expect(sanitizeJsonText('"\\ud83d\\u0041"')).toBe('"\\ufffd\\u0041"');
    expect(sanitizeJsonText('"\\ude00"')).toBe('"\\ufffd"');
    expect(sanitizeJsonText('"\\ud83d\\ud83d\\ude00"')).toBe('"\\ufffd\\ud83d\\ude00"');
  });

  it("an escaped backslash followed by a lone low surrogate escape: the low one is replaced", () => {
    // `\\` is one unit; what follows it is a real `\ude00` with no high half in front.
    expect(sanitizeJsonText('"\\\\\\ude00"')).toBe('"\\\\\\ufffd"');
  });

  it("every output still parses as the same JSON shape", () => {
    for (const text of ['{"a":"\\u0000"}', '["\\ud800",1]', '{"b":"\\\\u0000\\u0000"}']) {
      expect(() => JSON.parse(sanitizeJsonText(text))).not.toThrow();
    }
  });
});

describe("countMissingReceipts — the 'finished' rule", () => {
  it("every real fixture is finished", () => {
    for (const tx of [REBALANCE, CREATE_FIRST, COMMIT_WITHDRAW, RENAME, DELETE, FAILED_ADMIN, NO_VAULT_RECEIPT]) {
      expect(countMissingReceipts(tx)).toBe(0);
    }
  });

  it("a receipt that some outcome created and that is not here yet makes it unfinished", () => {
    const tx = clone(COMMIT_WITHDRAW);
    // The callback that emits `unallocate` lands blocks later than the commit.
    const callback = tx.receipts.findIndex((r) => r.execution_outcome.outcome.logs.some((l) => l.includes('"unallocate"')));
    tx.receipts.splice(callback, 1);
    expect(countMissingReceipts(tx)).toBeGreaterThan(0);
    const x = extractTx(tx, VAULT);
    expect(x.complete).toBe(false);
    expect(x.tx.txHash).toBe(COMMIT_WITHDRAW.transaction.hash);
  });
});

describe("extractTx — the receipts list itself", () => {
  it("an exact repeat of a receipt is read once", () => {
    const tx = clone(REBALANCE);
    tx.receipts.push(clone(REBALANCE).receipts.find((r) => r.execution_outcome.outcome.executor_id === VAULT)!);
    expect(complete(extractTx(tx, VAULT)).events).toHaveLength(1);
  });

  it("two different bodies under one receipt id hold the transaction back", () => {
    const tx = clone(REBALANCE);
    const twin = clone(REBALANCE).receipts.find((r) => r.execution_outcome.outcome.executor_id === VAULT)!;
    twin.execution_outcome.outcome.logs = [];
    tx.receipts.push(twin);
    expect(() => extractTx(tx, VAULT)).toThrow(HistoryShapeError);
  });

  it("a missing receipt_ids list is a shape error, never 'finished'", () => {
    const onTx = clone(RENAME);
    delete onTx.execution_outcome.outcome!.receipt_ids;
    expect(() => extractTx(onTx, VAULT)).toThrow(HistoryShapeError);
    const onReceipt = clone(RENAME);
    delete onReceipt.receipts[0].execution_outcome.outcome.receipt_ids;
    expect(() => countMissingReceipts(onReceipt)).toThrow(HistoryShapeError);
  });
});

describe("extractTx — real vault transactions", () => {
  it("a rebalance: one event, no account, one row per attribution with its spread in token_out", () => {
    const x = complete(extractTx(REBALANCE, VAULT));
    expect(x.tx).toEqual({
      txHash: "6zuZRUkR1bppdVxtUSLDEmyPAx8iGg3BnqgZyF1fQWe4",
      blockHeight: 220210867,
      blockTsMs: Math.floor(REBALANCE.execution_outcome.block_timestamp / 1e6),
    });
    expect(x.calls).toEqual([]); // the solver's `reconcile_balances` is not kept
    expect(x.events).toHaveLength(1);
    const [e] = x.events;
    expect(e).toMatchObject({
      receiptId: "6NWnbp1uqQ4h9gS5WWc6bVB1YNGWVma6BuaLoeVCHzAU",
      logIndex: 0,
      blockHeight: 220210868,
      event: "external_rebalance",
      version: "2.0.0",
      accountId: null,
      owner: null,
    });
    expect(e.portfolios).toEqual([
      {
        ord: 0,
        portfolioId: "p_000000000001",
        qtyIn: "84046287820715792235350",
        qtyOut: "444329",
        spread: "593",
        swapToken: "nep141:usdt.tether-token.near",
      },
    ]);
    // Stored from the log text itself, not re-serialised.
    expect(`EVENT_JSON:${e.rawText}`).toBe(vaultReceipt(REBALANCE).execution_outcome.outcome.logs[0]);
  });

  it("a first creation: four events of the account, the owner, the allocation, and the call's arguments verbatim", () => {
    const x = complete(extractTx(CREATE_FIRST, VAULT));
    expect(x.events.map((e) => e.event)).toEqual(["register_user", "link_wallet", "portfolio_created", "allocate"]);
    expect(x.events.map((e) => e.logIndex)).toEqual([0, 1, 2, 3]);
    expect(x.events.every((e) => e.accountId === "pablofork.near")).toBe(true);
    expect(x.events[0].portfolios).toEqual([]);
    expect(x.events[1].portfolios).toEqual([]);
    expect(x.events[2].owner).toEqual({ portfolioId: "p_000000000000", accountId: "pablofork.near" });
    expect(x.events[2].portfolios).toEqual([
      { ord: 0, portfolioId: "p_000000000000", qtyIn: null, qtyOut: null, spread: null, swapToken: null },
    ]);
    expect(x.events[3].portfolios[0]).toMatchObject({ qtyIn: "2457698", qtyOut: null });

    expect(x.calls).toHaveLength(1);
    const [call] = x.calls;
    expect(call.method).toBe("on_auth");
    const action = vaultReceipt(CREATE_FIRST).receipt!.receipt!.Action!.actions![0].FunctionCall as { args: string };
    expect(call.argsText).toBe(Buffer.from(action.args, "base64").toString("utf8"));
    expect(x.droppedCalls).toEqual([]);
  });

  it("a withdrawal: the opened legs move nothing, the callback's unallocate moves it, the commit is kept", () => {
    const x = complete(extractTx(COMMIT_WITHDRAW, VAULT));
    expect(x.events.map((e) => e.event)).toEqual(["pending_unallocation_opened", "unallocate"]);
    const [opened, unallocate] = x.events;
    expect(opened.accountId).toBeNull();
    expect(opened.portfolios).toEqual([
      { ord: 0, portfolioId: "p_000000000000", qtyIn: null, qtyOut: null, spread: null, swapToken: null },
    ]);
    expect(unallocate.portfolios[0]).toMatchObject({ qtyIn: null, qtyOut: "2457698" });
    // Different receipts, different blocks.
    expect(opened.receiptId).not.toBe(unallocate.receiptId);
    expect(unallocate.blockHeight).toBeGreaterThan(opened.blockHeight);
    expect(x.calls.map((c) => c.method)).toEqual(["commit_portfolio_changes"]);
    expect(JSON.parse(x.calls[0].argsText).payload.payload.message).toContain('"unallocations"');
  });

  it("rename and delete: one row each, nothing moved", () => {
    for (const tx of [RENAME, DELETE]) {
      const x = complete(extractTx(tx, VAULT));
      expect(x.events).toHaveLength(1);
      expect(x.events[0].portfolios).toEqual([
        { ord: 0, portfolioId: "p_000000000000", qtyIn: null, qtyOut: null, spread: null, swapToken: null },
      ]);
    }
  });

  it("a failed vault receipt contributes nothing; a transaction without vault receipts is finished and empty", () => {
    for (const tx of [FAILED_ADMIN, NO_VAULT_RECEIPT]) {
      const x = complete(extractTx(tx, VAULT));
      expect(x.events).toEqual([]);
      expect(x.calls).toEqual([]);
    }
  });
});

describe("extractTx — trust rules", () => {
  it("ignores an intentfolio-vault line printed by another contract", () => {
    const tx = clone(REBALANCE);
    vaultReceipt(tx).execution_outcome.outcome.executor_id = "impostor.near";
    expect(complete(extractTx(tx, VAULT)).events).toEqual([]);
  });

  it("ignores the logs of a vault receipt that failed", () => {
    const tx = clone(REBALANCE);
    vaultReceipt(tx).execution_outcome.outcome.status = { Failure: {} };
    expect(complete(extractTx(tx, VAULT)).events).toEqual([]);
  });

  it("counts every line in log_index, events or not", () => {
    const tx = clone(RENAME);
    const logs = vaultReceipt(tx).execution_outcome.outcome.logs;
    logs.unshift("plain text", 'EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_transfer","data":[]}', "EVENT_JSON:{not json");
    const x = complete(extractTx(tx, VAULT));
    expect(x.events.map((e) => [e.event, e.logIndex])).toEqual([["portfolio_renamed", 3]]);
  });
});

describe("extractTx — what a user writes cannot stop the recorder", () => {
  it("a portfolio name holding U+0000 is stored with U+FFFD in its place", () => {
    const tx = clone(RENAME);
    vaultReceipt(tx).execution_outcome.outcome.logs = [
      line("portfolio_renamed", { account_id: "pablofork.near", portfolio_id: "p_000000000000", name: "a\u0000b" }),
    ];
    const [e] = complete(extractTx(tx, VAULT)).events;
    expect(e.rawText).toContain('"name":"a\\ufffdb"');
    expect(JSON.parse(e.rawText).data[0].name).toBe("a�b");
  });

  it("call arguments that are not a JSON object are dropped with a reason; the events still go in", () => {
    const tx = clone(RENAME);
    const action = vaultReceipt(tx).receipt!.receipt!.Action!.actions![0].FunctionCall as { args: string };
    action.args = Buffer.from("[1,2]").toString("base64");
    const x = complete(extractTx(tx, VAULT));
    expect(x.calls).toEqual([]);
    expect(x.droppedCalls).toEqual([
      expect.objectContaining({ actionIndex: 0, reason: "arguments are not a JSON object" }),
    ]);
    expect(x.events).toHaveLength(1);

    action.args = Buffer.from([0xff, 0xfe]).toString("base64");
    expect(complete(extractTx(tx, VAULT)).droppedCalls[0].reason).toBe("arguments are not UTF-8");
  });

  it("call arguments with a lone surrogate escape are made storable", () => {
    const tx = clone(RENAME);
    const action = vaultReceipt(tx).receipt!.receipt!.Action!.actions![0].FunctionCall as { args: string };
    action.args = Buffer.from('{"payload":{},"junk":"\\ud800"}').toString("base64");
    const [call] = complete(extractTx(tx, VAULT)).calls;
    expect(call.argsText).toBe('{"payload":{},"junk":"\\ufffd"}');
  });
});

describe("extractTx — what the contract writes must have the expected shape", () => {
  const withLog = (log: string) => {
    const tx = clone(RENAME);
    vaultReceipt(tx).execution_outcome.outcome.logs = [log];
    return tx;
  };

  it("a version this file does not know holds the transaction back", () => {
    const tx = withLog(line("portfolio_renamed", { account_id: "a.near", portfolio_id: "p_1", name: "x" }, "3.0.0"));
    expect(() => extractTx(tx, VAULT)).toThrow(HistoryShapeError);
  });

  it("an amount that is not a u128 holds it back", () => {
    for (const qty of ["-1", "1.5", 7, "340282366920938463463374607431768211456"]) {
      const tx = withLog(line("allocate", { account_id: "a.near", portfolio_id: "p_1", token: "t", qty }));
      expect(() => extractTx(tx, VAULT)).toThrow(HistoryShapeError);
    }
  });

  it("an account_id that is not an account holds it back; a missing one is null", () => {
    expect(() => extractTx(withLog(line("register_user", { account_id: 5 })), VAULT)).toThrow(HistoryShapeError);
    const x = complete(extractTx(withLog(line("token_frozen", { token: "t", reason: "r", actor: "admin.near" })), VAULT));
    expect(x.events[0]).toMatchObject({ event: "token_frozen", accountId: null, portfolios: [] });
  });

  it("drops leading zeros so equal amounts compare equal", () => {
    const tx = withLog(line("allocate", { account_id: "a.near", portfolio_id: "p_1", token: "t", qty: "007" }));
    expect(complete(extractTx(tx, VAULT)).events[0].portfolios[0].qtyIn).toBe("7");
  });
});

describe("portfolioRowsOf — the quantity rule of the 008 header", () => {
  it("a forced rebalance counts the swap, never a spread", () => {
    const rows = portfolioRowsOf("forced_internal_rebalance", {
      token_in: "a",
      token_out: "b",
      attributions: [
        { portfolio_id: "p_1", qty_in: "1", qty_out: "2" },
        { portfolio_id: "p_2", qty_in: "3", qty_out: "4" },
      ],
    });
    expect(rows).toEqual([
      { ord: 0, portfolioId: "p_1", qtyIn: "1", qtyOut: "2", spread: null, swapToken: "b" },
      { ord: 1, portfolioId: "p_2", qtyIn: "3", qtyOut: "4", spread: null, swapToken: "b" },
    ]);
  });

  it("a repair: a positive delta adds, a negative one takes, zero moves nothing", () => {
    const rows = portfolioRowsOf("reconciliation_repaired", {
      corrections: [
        ["p_1", "t", "5"],
        ["p_2", "t", "-7"],
        ["p_3", "t", "0"],
      ],
      reason: "r",
      actor: "admin.near",
    });
    expect(rows.map((r) => [r.portfolioId, r.qtyIn, r.qtyOut])).toEqual([
      ["p_1", "5", null],
      ["p_2", null, "7"],
      ["p_3", null, null],
    ]);
  });

  it("a rescue claim and a deferred withdrawal name the portfolio and move nothing", () => {
    for (const event of ["pending_allocation_claimed", "unallocate_deferred"]) {
      expect(portfolioRowsOf(event, { account_id: "a.near", portfolio_id: "p_9" })).toEqual([
        { ord: 0, portfolioId: "p_9", qtyIn: null, qtyOut: null, spread: null, swapToken: null },
      ]);
    }
  });

  it("a failed withdrawal and the admin events touch no portfolio", () => {
    expect(portfolioRowsOf("unallocate_failed", { commit_id: "c", reason: "r" })).toEqual([]);
    expect(portfolioRowsOf("paused", { area: "all", reason: "r", actor: "a" })).toEqual([]);
  });
});
