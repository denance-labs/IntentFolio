import { describe, it, expect } from "vitest";
import {
  ACCOUNT_DEPOSIT_EVENT,
  ACCOUNT_STORAGE_COST_EVENT,
  ACCOUNT_WITHDRAWAL_EVENT,
  extractAccountEvents,
  toContractEvents,
  type ChainHistoryEvent,
} from "./vault-history";
import type { FastNearTx } from "./vault-history-client";
import {
  ALLOCATE_INTO,
  COMPOSITION_ONLY,
  CREATE,
  FAILED_ALLOCATE,
  RESCUED_CREATE,
  UNALLOCATE_TWO,
} from "./vault-history.fixtures";
import {
  DEPOSIT_USDT,
  FOREIGN_BURN,
  V2_COMPOSITION,
  V2_CREATE,
  V2_DELETE,
  V2_RENAME,
  V2_UNALLOCATE,
  WITHDRAW_USDT,
} from "./vault-history-v2.fixtures";

const VAULT = "intentfolio-staging.near";
const USER = "pablofork.near";
const params = { vaultId: VAULT, accountId: USER };

const read = (tx: FastNearTx) => toContractEvents(extractAccountEvents(tx, params));

describe("extractAccountEvents + toContractEvents (real staging transactions)", () => {
  it("a creation is one commit: the portfolio and both allocations, keyed by the tx hash", () => {
    const events = read(CREATE);
    expect(events.map((e) => e.kind)).toEqual(["portfolio_created", "allocate", "allocate"]);
    for (const e of events) {
      expect("commit_id" in e && e.commit_id).toBe(CREATE.transaction.hash);
      expect("portfolio_id" in e && e.portfolio_id).toBe("p_000000000017");
    }
    expect(events[0]).toMatchObject({ kind: "portfolio_created", name: "canary-931-stnear" });
    // Base units to the registry's decimals: stNEAR has 24, USDT 6.
    expect(events[1]).toMatchObject({ token: "nep141:meta-pool.near", qty: 0.6662737441174942 });
    expect(events[2]).toMatchObject({ token: "nep141:usdt.tether-token.near", qty: 4.4 });
    // Milliseconds from the receipt's nanoseconds.
    expect(events[0].ts).toBe(Math.floor(CREATE.receipts[1].execution_outcome.block_timestamp / 1e6));
  });

  it("adding funds to an existing portfolio is one allocation", () => {
    expect(read(ALLOCATE_INTO)).toEqual([
      expect.objectContaining({ kind: "allocate", portfolio_id: "p_000000000017", qty: 0.2 }),
    ]);
  });

  it("moving two tokens to the general balance is two unallocations in one commit", () => {
    const events = read(UNALLOCATE_TWO);
    expect(events.map((e) => e.kind)).toEqual(["unallocate", "unallocate"]);
    expect(new Set(events.map((e) => ("commit_id" in e ? e.commit_id : "")))).toEqual(
      new Set([UNALLOCATE_TWO.transaction.hash])
    );
  });

  it("a creation the solver rescued counts its allocation once (the claim event is ignored)", () => {
    const events = read(RESCUED_CREATE);
    expect(events.map((e) => e.kind)).toEqual(["portfolio_created", "allocate"]);
    // And the vault's `nep141:wrap.near` reaches the History as the registry's `near`.
    expect(events[1]).toMatchObject({ token: "near", qty: 0.24807177 });
  });

  it("a failed allocation leaves no row: the vault emitted nothing", () => {
    expect(read(FAILED_ALLOCATE)).toEqual([]);
  });

  it("a composition-only edit is invisible on-chain in v1 (the staging contract emits nothing)", () => {
    expect(read(COMPOSITION_ONLY)).toEqual([]);
  });

  it("rejects a vault envelope printed by any other contract", () => {
    const spoof: FastNearTx = {
      ...CREATE,
      receipts: CREATE.receipts.map((r) => ({
        execution_outcome: {
          ...r.execution_outcome,
          outcome: { ...r.execution_outcome.outcome, executor_id: "evil.near" },
        },
      })),
    };
    expect(read(spoof)).toEqual([]);
  });

  it("rejects the logs of a receipt that failed", () => {
    const reverted: FastNearTx = {
      ...CREATE,
      receipts: CREATE.receipts.map((r) => ({
        execution_outcome: {
          ...r.execution_outcome,
          outcome: { ...r.execution_outcome.outcome, status: { Failure: { ActionError: {} } } },
        },
      })),
    };
    expect(read(reverted)).toEqual([]);
  });

  it("ignores events that name another account", () => {
    expect(toContractEvents(extractAccountEvents(CREATE, { vaultId: VAULT, accountId: "other.near" }))).toEqual([]);
  });

  it("skips a token outside the registry instead of guessing its decimals", () => {
    const raw: ChainHistoryEvent = {
      txHash: "h",
      index: 0,
      ts: 1,
      event: "allocate",
      data: { account_id: USER, portfolio_id: "p_1", token: "nep141:unknown.near", qty: "100" },
    };
    expect(toContractEvents([raw])).toEqual([]);
  });
});

// ── 017-7: the account's own movements and the final vault's events ─────────

describe("extractAccountEvents — account movements and v2 events (real pablofork.near txs)", () => {
  const V2 = { vaultId: "intentfolio-vault.near", accountId: USER };
  const names = (tx: FastNearTx) => extractAccountEvents(tx, V2).map((e) => e.event);

  it("a finished withdrawal is one burn of the account's token, base units kept", () => {
    const [e] = extractAccountEvents(WITHDRAW_USDT, V2).filter((x) => x.event === ACCOUNT_WITHDRAWAL_EVENT);
    expect(e.data).toEqual({ account_id: USER, token: "nep141:usdt.tether-token.near", amount: "500000" });
  });

  it("a finished deposit is one mint", () => {
    expect(names(DEPOSIT_USDT)).toEqual([ACCOUNT_DEPOSIT_EVENT]);
    expect(extractAccountEvents(DEPOSIT_USDT, V2)[0].data.amount).toBe("2457698");
  });

  it("ignores another account's burns in a transaction listed under this one", () => {
    const all = FOREIGN_BURN.receipts.flatMap((r) => r.execution_outcome.outcome.logs);
    expect(all.some((l) => l.includes('"mt_burn"') && !l.includes(`"owner_id":"${USER}"`))).toBe(true);
    const mine = extractAccountEvents(FOREIGN_BURN, V2).filter((e) => e.event === ACCOUNT_WITHDRAWAL_EVENT);
    expect(mine.every((e) => e.data.account_id === USER)).toBe(true);
    expect(mine.length).toBeLessThan(all.filter((l) => l.includes('"mt_burn"')).length);
  });

  it("rejects a nep245 mint printed by any contract other than intents.near", () => {
    const forged: FastNearTx = {
      ...DEPOSIT_USDT,
      receipts: DEPOSIT_USDT.receipts.map((r) => ({
        execution_outcome: {
          ...r.execution_outcome,
          outcome: { ...r.execution_outcome.outcome, executor_id: "evil.near" },
        },
      })),
    };
    expect(names(forged)).toEqual([]);
  });

  it("keeps the final vault's creation, rename, composition change, deletion and unallocation", () => {
    expect(names(V2_CREATE)).toEqual(["portfolio_created", "allocate"]);
    expect(names(V2_RENAME)).toEqual(["portfolio_renamed"]);
    expect(names(V2_COMPOSITION)).toEqual(["portfolio_composition_changed"]);
    expect(names(V2_DELETE)).toEqual(["portfolio_deleted"]);
    expect(names(V2_UNALLOCATE)).toEqual(["unallocate"]);
  });

  it("a portfolio's History maps creation, fund moves and composition changes", () => {
    const events = [V2_CREATE, V2_RENAME, V2_COMPOSITION, V2_DELETE, DEPOSIT_USDT].flatMap((tx) =>
      extractAccountEvents(tx, V2)
    );
    expect(toContractEvents(events).map((e) => e.kind)).toEqual([
      "portfolio_created",
      "allocate",
      "composition_changed",
    ]);
  });

  // D-422: only the ids on-chain, so one generic row keyed like every other chain row.
  it("a composition change is one generic event under its tx hash, with no token detail", () => {
    expect(toContractEvents(extractAccountEvents(V2_COMPOSITION, V2))).toEqual([
      {
        kind: "composition_changed",
        event_id: "BSeAtKgKi7CBrkckhen4QuyAVbWSxyg3Ej7BHRjwa7aA:0",
        commit_id: "BSeAtKgKi7CBrkckhen4QuyAVbWSxyg3Ej7BHRjwa7aA",
        account_id: "pablofork.near",
        portfolio_id: "p_000000000001",
        ts: 1790834147455,
      },
    ]);
  });

  // 028-7 (D-489): the history route adds what the edit signed; each line is its own event.
  it("an edit with its signed detail opens into a line per target, token added and token removed", () => {
    const [event] = extractAccountEvents(V2_COMPOSITION, V2);
    const edit = {
      targets: [{ token: "nep141:usdt.tether-token.near", bps: 3950, toleranceBps: 2000 }],
      added: [{ token: "nep141:wrap.near", bps: 3700, toleranceBps: 1000 }],
      removed: ["nep141:eth.bridge.near"],
    };
    const base = { commit_id: event.txHash, account_id: "pablofork.near", portfolio_id: "p_000000000001", ts: event.ts };
    expect(toContractEvents([{ ...event, edit }])).toEqual([
      { kind: "target_set", event_id: `${event.txHash}:0:0`, ...base, token: "nep141:usdt.tether-token.near", target_pct: 39.5, tolerance_pct: 20 },
      // The vault spells NEAR `nep141:wrap.near`; the registry keys it `near`.
      { kind: "token_added", event_id: `${event.txHash}:0:1`, ...base, token: "near", initial_target_pct: 37, initial_tolerance_pct: 10 },
      { kind: "token_removed", event_id: `${event.txHash}:0:2`, ...base, token: "nep141:eth.bridge.near" },
    ]);
    // Unreadable: the generic row of today.
    expect(toContractEvents([{ ...event, edit: null }]).map((e) => e.kind)).toEqual(["composition_changed"]);
  });

  // D-530: with the composition it replaced, only what changed, before → after.
  it("an edit with its before lists only the tokens whose target or tolerance changed", () => {
    const [event] = extractAccountEvents(V2_COMPOSITION, V2);
    const USDT = "nep141:usdt.tether-token.near";
    const edit = {
      targets: [
        { token: USDT, bps: 3500, toleranceBps: 3000 },
        { token: "nep141:wrap.near", bps: 6500, toleranceBps: 1200 },
        { token: "nep141:eth.bridge.near", bps: 0, toleranceBps: 1200 },
      ],
      added: [],
      removed: [],
    };
    const before = [
      { token: USDT, bps: 3500, toleranceBps: 1200 },
      { token: "nep141:wrap.near", bps: 5000, toleranceBps: 1200 },
      { token: "nep141:eth.bridge.near", bps: 0, toleranceBps: 1200 },
      { token: "nep141:x", bps: 1500, toleranceBps: 1200 },
    ];
    const base = { commit_id: event.txHash, account_id: "pablofork.near", portfolio_id: "p_000000000001", ts: event.ts };
    expect(toContractEvents([{ ...event, edit, before }])).toEqual([
      { kind: "target_change", event_id: `${event.txHash}:0:0`, ...base, token: USDT, old_target_pct: 35, new_target_pct: 35, old_tolerance_pct: 12, new_tolerance_pct: 30 },
      { kind: "target_change", event_id: `${event.txHash}:0:1`, ...base, token: "near", old_target_pct: 50, new_target_pct: 65, old_tolerance_pct: 12, new_tolerance_pct: 12 },
    ]);
    // A token the before does not have: only its new target, as without one.
    expect(toContractEvents([{ ...event, edit, before: [] }]).map((e) => e.kind)).toEqual(["target_set", "target_set", "target_set"]);
    // Nothing changed: the edit keeps its generic row.
    const same = { targets: [before[2]], added: [], removed: [] };
    expect(toContractEvents([{ ...event, edit: same, before }]).map((e) => e.kind)).toEqual(["composition_changed"]);
  });

  // D-539: the Storage Cost carries no portfolio id; it joins the creation of its transaction.
  it("a Setup's Storage Cost joins the portfolio created in its transaction, and nothing else", () => {
    const tx = "EYJiFGFSw1PyD6mTSPD8YfxGch9mS45zEt1h7WzHb3Au";
    const account_id = "0xc8b1e10d011aceed84f4cdba66ca175bd6552a36";
    const ts = 1793071498113;
    const storage = (txHash: string, index: number): ChainHistoryEvent => ({
      txHash,
      index,
      ts,
      event: ACCOUNT_STORAGE_COST_EVENT,
      data: { account_id, token: "nep141:eth.omft.near", amount: "30957572709894" },
    });
    const created: ChainHistoryEvent = { txHash: tx, index: 1, ts, event: "portfolio_created", data: { account_id, portfolio_id: "p_00000000000e", name: "Pioneers" } };
    expect(toContractEvents([storage(tx, 0), created])).toEqual([
      { kind: "storage_cost", event_id: `${tx}:0`, commit_id: tx, account_id, portfolio_id: "p_00000000000e", token: "nep141:eth.omft.near", qty: 0.000030957572709894, ts },
      { kind: "portfolio_created", event_id: `${tx}:1`, commit_id: tx, account_id, portfolio_id: "p_00000000000e", name: "Pioneers", ts },
    ]);
    // Without a creation in the same transaction it has no portfolio to belong to.
    expect(toContractEvents([storage("OtherTx", 0), created])).toEqual([
      expect.objectContaining({ kind: "portfolio_created" }),
    ]);
  });
});
