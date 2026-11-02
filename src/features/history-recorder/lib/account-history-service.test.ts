// @vitest-environment node
// An account's history read (plan 028-7): validation before the database, `expect` / `fresh`
// writing before the read, the page assembled in the browser's event shape (names, a rename's
// previous name, an edit's detail, the next key), and when a read starts a pass after answering.
// Against a stub; the SQL itself runs against the real schema in
// `account-history-db.integration.test.ts`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Queryable, TransactionalQueryable } from "@/features/vault/lib/ops-records-service";
import { ACCOUNT_CONVERSION_EVENT, ACCOUNT_DEPOSIT_EVENT, ACCOUNT_STORAGE_COST_EVENT } from "@/features/vault/lib/vault-history";
import { ACCOUNT_PACE_MS, ACCOUNT_TX_CAP, type AccountPassResult } from "./account-recorder";
import {
  ACCOUNT_STALE_MS,
  COMPOSITIONS_SQL,
  CATCH_UP_BUDGET_MS,
  CURSOR_SQL,
  EVENTS_SQL,
  FRESH_BUDGET_MS,
  NAMES_SQL,
  PAGE_SQL,
  PAGE_TXS,
  catchUpAccountAfterRead,
  conversionOutcomeOf,
  handleAccountHistory,
  replayCompositions,
  type AccountRecorderFns,
} from "./account-history-service";

const VAULT = "intentfolio-vault.near";
const ACCOUNT = "pablofork.near";
const P1 = "p_000000000001";
const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const allow = { check: () => true };
const WRITER = { query: vi.fn(), connect: vi.fn() } as unknown as TransactionalQueryable;

type Cursor = { backfill_done: boolean; last_ok_at: Date | null; last_run_at: Date | null; recorded: number | null };
const UP_TO_DATE: Cursor = {
  backfill_done: true,
  last_ok_at: new Date(NOW - 10_000),
  last_run_at: new Date(NOW - 10_000),
  recorded: null,
};

type Tables = {
  cursor?: Cursor | null;
  page?: Array<{ tx_hash: string; ts: Date }>;
  events?: Array<Record<string, unknown>>;
  names?: Array<Record<string, unknown>>;
  compositions?: Array<Record<string, unknown>>;
  fail?: Error;
};

function stub(t: Tables = {}) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const db: Queryable = {
    async query<R>(text: string, values?: unknown[]) {
      calls.push({ text, values: values ?? [] });
      if (t.fail) throw t.fail;
      const rows =
        text === CURSOR_SQL
          ? t.cursor === null
            ? []
            : [t.cursor ?? UP_TO_DATE]
          : text === PAGE_SQL
            ? (t.page ?? [])
            : text === EVENTS_SQL
              ? (t.events ?? [])
              : text === NAMES_SQL
                ? (t.names ?? [])
                : text === COMPOSITIONS_SQL
                  ? (t.compositions ?? [])
                  : [];
      return { rows: rows as R[], rowCount: rows.length };
    },
  };
  return { db, calls };
}

const passRan = { ran: true, ok: true } as AccountPassResult;

function fakeRecorder(over: Partial<AccountRecorderFns> = {}): AccountRecorderFns & { order: string[] } {
  const order: string[] = [];
  return {
    order,
    follow: over.follow ?? vi.fn(async () => "followed" as const),
    runPass: over.runPass ?? vi.fn(async () => passRan),
    expectTx: over.expectTx ?? vi.fn(async () => ({ status: "recorded" as const })),
  };
}

const run = (db: Queryable, params: Record<string, string>, over: Partial<Parameters<typeof handleAccountHistory>[0]> = {}) =>
  handleAccountHistory({
    query: new URLSearchParams({ account: ACCOUNT, ...params }),
    vaultId: VAULT,
    callerKey: "k",
    reader: db,
    writer: () => ({ ok: true, db: WRITER }),
    limiter: allow,
    now: () => NOW,
    recorder: fakeRecorder(),
    ...over,
  });

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("handleAccountHistory — before the database", () => {
  it("refuses a bad account, portfolio, page key, hash or flag, without a query or a write", async () => {
    const bad: Array<Record<string, string>> = [
      { account: "" },
      { account: "Pablofork.near" },
      { account: "0xC8B1E10D011ACEED84F4CDBA66CA175BD6552A36" },
      { portfolio: "p_1" },
      { portfolio: "P_000000000001" },
      { before: "123" },
      { before: "abc_HASH" },
      { before: `1_${"a".repeat(65)}` },
      { expect: "not a hash" },
      { expect: "a".repeat(65) },
      { fresh: "true" },
      { expect: "abc", fresh: "1" },
    ];
    for (const params of bad) {
      const { db, calls } = stub();
      const recorder = fakeRecorder();
      const writer = vi.fn(() => ({ ok: true as const, db: WRITER }));
      const out = await run(db, params, { recorder, writer });
      expect(out, JSON.stringify(params)).toMatchObject({ status: 400, body: { ok: false, code: "bad-request" }, catchUp: null });
      expect(calls).toHaveLength(0);
      expect(writer).not.toHaveBeenCalled();
    }
  });

  it("503 without a vault; 429 past the caller's brake — without a query", async () => {
    const { db, calls } = stub();
    expect(await run(db, {}, { vaultId: "" })).toMatchObject({ status: 503, body: { code: "not-configured" } });
    expect(await run(db, {}, { limiter: { check: () => false } })).toMatchObject({ status: 429, body: { code: "too-many-requests" } });
    expect(calls).toHaveLength(0);
  });

  it("a plain read never opens the writer", async () => {
    const writer = vi.fn(() => ({ ok: true as const, db: WRITER }));
    await run(stub().db, {}, { writer });
    expect(writer).not.toHaveBeenCalled();
  });

  it("a read that fails is a 502, never an empty history", async () => {
    expect(await run(stub({ fail: new Error("boom") }).db, {})).toMatchObject({ status: 502, body: { code: "read-failed" }, catchUp: null });
  });
});

describe("handleAccountHistory — the user's own operation", () => {
  it("`expect`: recorded before the read, and the answer says how it went", async () => {
    const { db, calls } = stub();
    const seen: number[] = [];
    const recorder = fakeRecorder({
      expectTx: vi.fn(async (deps) => {
        seen.push(calls.length);
        expect(deps).toMatchObject({ db: WRITER, accountId: ACCOUNT, vaultId: VAULT, txHash: "Abc123" });
        return { status: "recorded" as const };
      }),
    });
    const out = await run(db, { expect: "Abc123" }, { recorder });
    expect(seen).toEqual([0]);
    expect(out.body).toMatchObject({ ok: true, expect: "recorded" });
  });

  it("`expect` on an account not followed yet: pending, and the pass after the answer follows it", async () => {
    const recorder = fakeRecorder({ expectTx: vi.fn(async () => ({ status: "not-followed" as const })) });
    const out = await run(stub({ cursor: null }).db, { expect: "Abc123" }, { recorder });
    expect(out).toMatchObject({ body: { ok: true, expect: "pending", loading: true }, catchUp: "follow" });
  });

  it("`expect` without a writer, or failing: pending, and the read still answers", async () => {
    const throwing = fakeRecorder({ expectTx: vi.fn(async () => Promise.reject(new Error("55P03"))) });
    expect((await run(stub().db, { expect: "Abc123" }, { recorder: throwing })).body).toMatchObject({ ok: true, expect: "pending" });
    const noWriter = await run(stub().db, { expect: "Abc123" }, { writer: () => ({ ok: false, issues: ["unset"] }) });
    expect(noWriter.body).toMatchObject({ ok: true, expect: "pending" });
  });

  it("`fresh`: the account's pass at the 5 s pace, before the read; no second pass after it", async () => {
    const recorder = fakeRecorder();
    const stale: Cursor = { ...UP_TO_DATE, last_ok_at: new Date(NOW - 10 * ACCOUNT_STALE_MS), last_run_at: new Date(NOW) };
    const out = await run(stub({ cursor: stale }).db, { fresh: "1" }, { recorder });
    expect(recorder.runPass).toHaveBeenCalledWith({ db: WRITER, accountId: ACCOUNT, vaultId: VAULT, mode: "fresh", budgetMs: FRESH_BUDGET_MS });
    expect(out.catchUp).toBeNull();
    expect(out.body).not.toHaveProperty("expect");
    // Unpaced and behind, a plain read would start one: the `fresh` pass is what holds it.
    const unpaced = { ...stale, last_run_at: new Date(NOW - 10 * ACCOUNT_PACE_MS) };
    expect((await run(stub({ cursor: unpaced }).db, {})).catchUp).toBe("pass");
    expect((await run(stub({ cursor: unpaced }).db, { fresh: "1" }, { recorder: fakeRecorder() })).catchUp).toBeNull();
  });
});

describe("handleAccountHistory — freshness and the pass after answering", () => {
  const read = async (cursor: Cursor | null) => run(stub({ cursor }).db, {});

  it("first visit: loading, nothing recorded yet, and the account is followed after answering", async () => {
    expect(await read(null)).toMatchObject({
      body: { ok: true, events: [], recordedUntil: null, upToDate: false, loading: true, unavailable: false },
      catchUp: "follow",
    });
  });

  it("up to date: no pass; behind: a pass, unless one ran within the pace or is still running", async () => {
    expect((await read(UP_TO_DATE)).catchUp).toBeNull();
    const behind = { ...UP_TO_DATE, last_ok_at: new Date(NOW - ACCOUNT_STALE_MS - 1) };
    expect(await read({ ...behind, last_run_at: new Date(NOW - ACCOUNT_PACE_MS) })).toMatchObject({
      body: { upToDate: false, recordedUntil: NOW - ACCOUNT_STALE_MS - 1 },
      catchUp: "pass",
    });
    expect((await read({ ...behind, last_run_at: new Date(NOW - 5_000) })).catchUp).toBeNull();
    expect((await read({ ...behind, last_run_at: new Date(NOW + 20_000) })).catchUp).toBeNull();
  });

  it("an unfinished initial load is `loading`; past the cap the history is `unavailable` and no pass is started", async () => {
    // Still loading: the load goes on with each read, even right after a pass set "recorded until" to the head.
    expect(await read({ ...UP_TO_DATE, backfill_done: false, last_run_at: new Date(NOW - ACCOUNT_PACE_MS) })).toMatchObject({
      body: { loading: true, upToDate: true },
      catchUp: "pass",
    });
    expect((await read({ ...UP_TO_DATE, backfill_done: false })).catchUp).toBeNull();
    const capped = { ...UP_TO_DATE, last_ok_at: new Date(NOW - 10 * ACCOUNT_STALE_MS), last_run_at: null, recorded: ACCOUNT_TX_CAP };
    expect(await read(capped)).toMatchObject({ body: { unavailable: true }, catchUp: null });
    expect((await read({ ...UP_TO_DATE, recorded: 12 })).body).toMatchObject({ unavailable: false });
  });
});

const SETUP = [
  { token_id: "nep141:wrap.near", target_bps: 5000, tolerance_bps: 500 },
  { token_id: "nep141:x", target_bps: 5000, tolerance_bps: 500 },
];

describe("handleAccountHistory — the page", () => {
  const ts = (s: number) => new Date(NOW - s * 1000);
  const ev = (tx: string, s: number, event: string, data: Record<string, unknown>, at = { receipt_id: `r-${tx}`, log_index: 0 }) => ({
    source: "vault",
    tx_hash: tx,
    block_ts: ts(s),
    ...at,
    event,
    data,
  });

  it("in the browser's shape: a transaction's events together, newest transaction first, names and details added", async () => {
    const { db, calls } = stub({
      page: [
        { tx_hash: "TxRename", ts: ts(10) },
        { tx_hash: "TxEdit", ts: ts(20) },
        { tx_hash: "TxDeposit", ts: ts(30) },
      ],
      events: [
        { source: "intents", tx_hash: "TxDeposit", block_ts: ts(30), receipt_id: "rd", log_index: 0, event: "deposit", data: { account_id: ACCOUNT, token: "nep141:wrap.near", amount: "5" } },
        ev("TxEdit", 20, "portfolio_composition_changed", { account_id: ACCOUNT, portfolio_id: P1 }),
        ev("TxEdit", 21, "allocate", { account_id: ACCOUNT, portfolio_id: P1, token: "nep141:wrap.near", qty: "5" }, { receipt_id: "r-TxEdit", log_index: 1 }),
        ev("TxRename", 10, "portfolio_renamed", { account_id: ACCOUNT, portfolio_id: P1, name: "Second" }, { receipt_id: "rn", log_index: 0 }),
      ],
      names: [
        { receipt_id: "rc", log_index: 0, portfolio_id: P1, name: "First" },
        { receipt_id: "rn", log_index: 0, portfolio_id: P1, name: "Second" },
      ],
      compositions: [
        {
          tx_hash: "TxCreate",
          event: "portfolio_created",
          portfolio_id: P1,
          method: "on_auth",
          args: { signer_id: ACCOUNT, msg: JSON.stringify({ op: { setup: { composition: SETUP } } }) },
        },
        {
          tx_hash: "TxEdit",
          event: "portfolio_composition_changed",
          portfolio_id: P1,
          method: "commit_portfolio_changes",
          args: {
            payload: {
              standard: "erc191",
              payload: JSON.stringify({ portfolio_id: P1, target_changes: [["nep141:wrap.near", 10000, 500]], token_additions: [], token_removals: ["nep141:x"] }),
            },
          },
        },
      ],
    });
    const out = await run(db, {});
    expect(out.body).toMatchObject({ ok: true, names: { [P1]: "Second" }, next: null });
    if (!out.body.ok) throw new Error("expected ok");
    expect(out.body.events).toEqual([
      { txHash: "TxRename", index: 0, ts: NOW - 10_000, event: "portfolio_renamed", data: { account_id: ACCOUNT, portfolio_id: P1, name: "Second" }, previousName: "First" },
      {
        txHash: "TxEdit",
        index: 0,
        ts: NOW - 20_000,
        event: "portfolio_composition_changed",
        data: { account_id: ACCOUNT, portfolio_id: P1 },
        edit: { targets: [{ token: "nep141:wrap.near", bps: 10000, toleranceBps: 500 }], added: [], removed: ["nep141:x"] },
        before: [
          { token: "nep141:wrap.near", bps: 5000, toleranceBps: 500 },
          { token: "nep141:x", bps: 5000, toleranceBps: 500 },
        ],
      },
      { txHash: "TxEdit", index: 1, ts: NOW - 21_000, event: "allocate", data: { account_id: ACCOUNT, portfolio_id: P1, token: "nep141:wrap.near", qty: "5" } },
      { txHash: "TxDeposit", index: 0, ts: NOW - 30_000, event: ACCOUNT_DEPOSIT_EVENT, data: { account_id: ACCOUNT, token: "nep141:wrap.near", amount: "5" } },
    ]);
    // The page's events are read from its last key up; names only for its portfolios; compositions
    // only for its edited portfolios, up to its newest edit.
    expect(calls.find((c) => c.text === EVENTS_SQL)?.values.slice(5)).toEqual([
      ["TxRename", "TxEdit", "TxDeposit"],
      ts(30),
      "intentfolio-budget.near",
      "storage",
    ]);
    expect(calls.find((c) => c.text === NAMES_SQL)?.values[2]).toEqual([P1]);
    expect(calls.find((c) => c.text === COMPOSITIONS_SQL)?.values.slice(1)).toEqual([ACCOUNT, [P1], ts(20)]);
  });

  it("an edit whose call is missing or unreadable says so with `edit: null`", async () => {
    const { db } = stub({
      page: [{ tx_hash: "TxEdit", ts: ts(20) }],
      events: [ev("TxEdit", 20, "portfolio_composition_changed", { account_id: ACCOUNT, portfolio_id: P1 })],
    });
    const out = await run(db, {});
    if (!out.body.ok) throw new Error("expected ok");
    expect(out.body.events[0]).toMatchObject({ event: "portfolio_composition_changed", edit: null, before: null });
  });

  it("a Converting Withdrawal: its own event, the outcome from the final verdict only, never the verdict itself", async () => {
    const DEPOSIT = "a".repeat(64);
    const conversion = (tx: string, s: number, verdict: string | null) => ({
      source: "conversion",
      tx_hash: tx,
      block_ts: ts(s),
      receipt_id: `r-${tx}`,
      log_index: 0,
      event: "conversion",
      data: {
        account_id: ACCOUNT,
        token: "nep141:usdc.near",
        amount: "1000000",
        deposit_address: DEPOSIT,
        chain_id: "btc:mainnet",
        delivery_token: "nep141:btc.omft.near",
        verdict,
        destination_tx: verdict === "delivered" ? "btc-tx" : null,
      },
    });
    const { db } = stub({
      page: [
        { tx_hash: "TxDone", ts: ts(10) },
        { tx_hash: "TxOpen", ts: ts(20) },
      ],
      events: [conversion("TxDone", 10, "delivered"), conversion("TxOpen", 20, null)],
    });
    const out = await run(db, {});
    if (!out.body.ok) throw new Error("expected ok");
    expect(out.body.events.map((e) => [e.txHash, e.event, e.data.outcome, e.data.destination_tx])).toEqual([
      ["TxDone", ACCOUNT_CONVERSION_EVENT, "delivered", "btc-tx"],
      ["TxOpen", ACCOUNT_CONVERSION_EVENT, null, null],
    ]);
    expect(out.body.events.every((e) => !("verdict" in e.data))).toBe(true);
  });

  // D-539: the Storage Cost rides with its Setup; the SQL lists it only for the page's transactions.
  it("a Setup's Storage Cost comes as its own event of the creation's transaction", async () => {
    const { db } = stub({
      page: [{ tx_hash: "TxSetup", ts: ts(10) }],
      events: [
        { source: "storage", tx_hash: "TxSetup", block_ts: ts(10), receipt_id: "ri", log_index: 0, event: "transfer_out", data: { account_id: ACCOUNT, token: "nep141:eth.omft.near", amount: "30957572709894" } },
        ev("TxSetup", 10, "portfolio_created", { account_id: ACCOUNT, portfolio_id: P1, name: "Pioneers" }, { receipt_id: "rv", log_index: 0 }),
      ],
    });
    const out = await run(db, { portfolio: P1 });
    if (!out.body.ok) throw new Error("expected ok");
    expect(out.body.events.map((e) => [e.index, e.event, e.data])).toEqual([
      [0, ACCOUNT_STORAGE_COST_EVENT, { account_id: ACCOUNT, token: "nep141:eth.omft.near", amount: "30957572709894" }],
      [1, "portfolio_created", { account_id: ACCOUNT, portfolio_id: P1, name: "Pioneers" }],
    ]);
  });

  it("conversionOutcomeOf: delivered or refunded; anything else is no outcome, never fine", () => {
    expect(conversionOutcomeOf("delivered")).toBe("delivered");
    expect(conversionOutcomeOf("refunded")).toBe("refunded");
    expect(conversionOutcomeOf("never_executed")).toBeNull();
    expect(conversionOutcomeOf(null)).toBeNull();
    expect(conversionOutcomeOf("settled")).toBeNull();
  });

  it(`${PAGE_TXS} transactions per page; the key of the last one asks for the next`, async () => {
    const page = Array.from({ length: PAGE_TXS + 1 }, (_, i) => ({ tx_hash: `Tx${i}`, ts: ts(i + 1) }));
    const { db, calls } = stub({ page });
    const out = await run(db, {});
    expect(out.body).toMatchObject({ ok: true, next: `${(NOW - PAGE_TXS * 1000)}_Tx${PAGE_TXS - 1}` });
    expect(calls.find((c) => c.text === PAGE_SQL)?.values).toEqual([VAULT, ACCOUNT, expect.any(Array), null, true, null, null, PAGE_TXS + 1]);
    expect((calls.find((c) => c.text === EVENTS_SQL)?.values[5] as string[]).length).toBe(PAGE_TXS);

    const exact = stub({ page: page.slice(0, PAGE_TXS) });
    expect((await run(exact.db, {})).body).toMatchObject({ ok: true, next: null });

    const second = stub();
    await run(second.db, { before: `${NOW - 20_000}_Tx19`, portfolio: P1 });
    const values = second.calls.find((c) => c.text === PAGE_SQL)?.values ?? [];
    expect(values.slice(3)).toEqual([P1, false, new Date(NOW - 20_000), "Tx19", PAGE_TXS + 1]);
    // A portfolio's History reads the kinds its mapper shows, never renames or movements.
    expect(values[2]).toEqual(["portfolio_created", "allocate", "unallocate", "portfolio_composition_changed"]);
  });
});

describe("catchUpAccountAfterRead", () => {
  const resolveDb = () => ({ ok: true as const, db: WRITER });

  it("first visit: follows under the hourly cap, then loads", async () => {
    const recorder = fakeRecorder();
    await catchUpAccountAfterRead({ accountId: ACCOUNT, vaultId: VAULT, catchUp: "follow", resolveDb, recorder });
    expect(recorder.follow).toHaveBeenCalledWith(WRITER, ACCOUNT, { capped: true });
    expect(recorder.runPass).toHaveBeenCalledWith({ db: WRITER, accountId: ACCOUNT, vaultId: VAULT, budgetMs: CATCH_UP_BUDGET_MS });
  });

  it("the hourly cap reached: no pass; a signup lock that timed out (R3): logged, never thrown", async () => {
    const capped = fakeRecorder({ follow: vi.fn(async () => "capped" as const) });
    await catchUpAccountAfterRead({ accountId: ACCOUNT, vaultId: VAULT, catchUp: "follow", resolveDb, recorder: capped });
    expect(capped.runPass).not.toHaveBeenCalled();
    const locked = fakeRecorder({ follow: vi.fn(async () => Promise.reject(Object.assign(new Error("lock timeout"), { code: "55P03" }))) });
    await expect(
      catchUpAccountAfterRead({ accountId: ACCOUNT, vaultId: VAULT, catchUp: "follow", resolveDb, recorder: locked })
    ).resolves.toBeUndefined();
    expect(locked.runPass).not.toHaveBeenCalled();
  });

  it("a followed account behind: only the pass; without a writer, nothing", async () => {
    const recorder = fakeRecorder();
    await catchUpAccountAfterRead({ accountId: ACCOUNT, vaultId: VAULT, catchUp: "pass", resolveDb, recorder });
    expect(recorder.follow).not.toHaveBeenCalled();
    expect(recorder.runPass).toHaveBeenCalledTimes(1);
    const none = fakeRecorder();
    await catchUpAccountAfterRead({ accountId: ACCOUNT, vaultId: VAULT, catchUp: "pass", resolveDb: () => ({ ok: false, issues: ["unset"] }), recorder: none });
    expect(none.runPass).not.toHaveBeenCalled();
  });
});

// D-530: each edit's "before", replayed from the Setup — the towanda187.near case of 2026-10-23,
// where only the tolerance changed (12% → 30%) and the editor signed every token.
describe("replayCompositions", () => {
  const P = "p_00000000000a";
  const auth = (op: unknown) => ({ signer_id: ACCOUNT, msg: JSON.stringify({ op }) });
  const commit = (cs: Record<string, unknown>) => ({ payload: { standard: "erc191", payload: JSON.stringify({ portfolio_id: P, ...cs }) } });
  const created = { tx_hash: "T0", event: "portfolio_created", portfolio_id: P, method: "on_auth", args: auth({ setup: { composition: [
    { token_id: "nep141:a", target_bps: 9500, tolerance_bps: 1200 },
    { token_id: "nep141:b", target_bps: 500, tolerance_bps: 1200 },
  ] } }) };
  const added = { tx_hash: "T1", event: "portfolio_composition_changed", portfolio_id: P, method: "on_auth", args: auth({ allocate_into: {
    portfolio_id: P, target_changes: [], token_additions: [["nep141:c", 0, 1000]], token_removals: [], allocations: [],
  } }) };
  const tolerance = { tx_hash: "T2", event: "portfolio_composition_changed", portfolio_id: P, method: "commit_portfolio_changes", args: commit({
    target_changes: [["nep141:a", 9500, 3000], ["nep141:b", 500, 3000]], token_additions: [], token_removals: [],
  }) };

  it("gives each edit the composition it replaced", () => {
    const out = replayCompositions([created, added, tolerance]);
    expect(out.get(`${P}:T1`)?.before).toEqual([
      { token: "nep141:a", bps: 9500, toleranceBps: 1200 },
      { token: "nep141:b", bps: 500, toleranceBps: 1200 },
    ]);
    expect(out.get(`${P}:T2`)).toEqual({
      edit: { targets: [{ token: "nep141:a", bps: 9500, toleranceBps: 3000 }, { token: "nep141:b", bps: 500, toleranceBps: 3000 }], added: [], removed: [] },
      before: [
        { token: "nep141:a", bps: 9500, toleranceBps: 1200 },
        { token: "nep141:b", bps: 500, toleranceBps: 1200 },
        { token: "nep141:c", bps: 0, toleranceBps: 1000 },
      ],
    });
  });

  it("an unreadable step leaves every later before null, never guessed; the edit is still read", () => {
    const broken = { ...added, args: { msg: "not json" } };
    const out = replayCompositions([created, broken, tolerance]);
    expect(out.get(`${P}:T1`)).toEqual({ edit: null, before: expect.any(Array) });
    expect(out.get(`${P}:T2`)?.before).toBeNull();
    expect(out.get(`${P}:T2`)?.edit).not.toBeNull();
    // No Setup in reach: no before.
    expect(replayCompositions([tolerance]).get(`${P}:T2`)?.before).toBeNull();
  });
});
