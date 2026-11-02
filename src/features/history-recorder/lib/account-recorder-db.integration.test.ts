// @vitest-environment node
//
// Proves the account recorder (plan 028-6) against the real schema: migration 009 (CHECKs,
// foreign keys, triggers, the writer's grants) and 008 for the vault rows it shares. FastNEAR is
// replaced by real mainnet transactions (account-history.fixtures.ts) re-keyed per case — the
// tables are append-only, and `intents_event` / `account_movement` are keyed by receipt, not by
// account, so nothing may be shared between cases.
//
//   cd ../intentfolio-solver && docker compose -f db/local/docker-compose.yml up -d && yarn db:migrate:local
//   npm run test:history-db
//
// SKIPPED unless both URLs are set, so `npm test` stays hermetic.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { randomBytes } from "node:crypto";
import {
  createPoolConfig,
  readOpsDbConfig,
  type TransactionalQueryable,
} from "@/features/vault/lib/ops-records-service";
import { HISTORY_WRITER_URL_VAR } from "@/features/vault/lib/ops-db-pool";
import { FastNearRateLimitError, type AccountTxRow, type FastNearTx } from "@/features/vault/lib/vault-history-client";
import {
  ACCOUNT_TX_CAP,
  FLOOR_BLOCK_HEIGHT,
  followAccount,
  recordExpectedTx,
  runAccountPass,
  type AccountPassDeps,
  type AccountPassResult,
} from "./account-recorder";
import { runHistoryPass, type FastNearSource } from "./history-recorder";
import type { PriceBook } from "./history-prices";
import { REBALANCE } from "./history-recorder.fixtures";
import {
  DEPOSIT,
  EVM_ALLOCATE,
  EVM_HOT_DEPOSIT,
  EVM_HOT_WITHDRAWAL,
  FAILED_TRANSFER,
  RECEIVED_WITHDRAWAL,
  TRANSFER_HEX,
  WITHDRAWAL,
} from "./account-history.fixtures";

const WRITER_URL = process.env[HISTORY_WRITER_URL_VAR];
const OWNER_URL = process.env.INTENTFOLIO_OPS_DB_TEST_OWNER_URL;
const suite = WRITER_URL && OWNER_URL ? describe : describe.skip;

const NEAR = "pablofork.near";
const EVM = "0xc8b1e10d011aceed84f4cdba66ca175bd6552a36";
const REAL_VAULT = "intentfolio-vault.near";
const HOUR = 60 * 60 * 1000;

const tsOf = (tx: FastNearTx) => Math.floor(tx.execution_outcome.block_timestamp / 1e6);
const NEAR_TXS = [DEPOSIT, WITHDRAWAL, TRANSFER_HEX, RECEIVED_WITHDRAWAL, FAILED_TRANSFER].sort((a, b) => tsOf(b) - tsOf(a));
const EVM_TXS = [EVM_ALLOCATE, EVM_HOT_WITHDRAWAL, EVM_HOT_DEPOSIT].sort((a, b) => tsOf(b) - tsOf(a));
const T1 = Math.max(...[...NEAR_TXS, ...EVM_TXS].map(tsOf)) + HOUR;

const tag = () => randomBytes(4).toString("hex");
const freshNear = () => `u${tag()}.test.near`;
const freshEvm = () => `0x${randomBytes(20).toString("hex")}`;
const freshVault = () => `v${tag()}.test.near`;

/**
 * The fixture as if it were another account's, another vault's, and new to the database: the
 * account, the vault and every receipt id and the hash replaced, consistently, everywhere.
 */
function rekey(tx: FastNearTx, swaps: Record<string, string>, suffix: string): FastNearTx {
  let json = JSON.stringify(tx);
  const ids = [tx.transaction.hash, ...tx.receipts.map((r) => r.execution_outcome.id!)];
  for (const id of ids) json = json.split(`"${id}"`).join(`"${id.slice(0, 50)}${suffix}"`);
  for (const [from, to] of Object.entries(swaps)) json = json.split(from).join(to);
  return JSON.parse(json) as FastNearTx;
}

const rowOf = (tx: FastNearTx): AccountTxRow => ({
  hash: tx.transaction.hash,
  blockHeight: tx.execution_outcome.block_height!,
  blockTsMs: tsOf(tx),
});

type FakeOptions = { unserved?: Set<string>; beforeFetch?: () => Promise<void>; rows?: (tx: FastNearTx) => AccountTxRow };
type FakeSource = FastNearSource & { calls: string[] };

/** FastNEAR over fixed pages for one listed account; the resume token is the next page's index. */
function fakeFastNear(pages: FastNearTx[][], listed: string, options: FakeOptions = {}): FakeSource {
  const byHash = new Map(pages.flat().map((tx) => [tx.transaction.hash, tx]));
  const calls: string[] = [];
  return {
    calls,
    async indexedHeadMs() {
      return T1;
    },
    async listPage(accountId, token) {
      expect(accountId).toBe(listed);
      const index = token === null ? 0 : Number(token);
      calls.push(`list ${index}`);
      return {
        rows: pages[index].map(options.rows ?? rowOf),
        resumeToken: index + 1 < pages.length ? String(index + 1) : null,
      };
    },
    async fetchTxs(hashes) {
      calls.push(`fetch ${hashes.length}`);
      await options.beforeFetch?.();
      return hashes.filter((h) => !options.unserved?.has(h)).map((h) => byHash.get(h)!);
    },
  };
}

suite("account recorder — one pass against a real Postgres 16 and the 009 schema", () => {
  let writer: Pool;
  let owner: Pool;
  let db: TransactionalQueryable;

  beforeAll(() => {
    const config = readOpsDbConfig(process.env, HISTORY_WRITER_URL_VAR);
    if (!config.ok) throw new Error(config.issues.join(", "));
    writer = new Pool(createPoolConfig({ ...config.config, maxConnections: 6 }));
    db = writer as unknown as TransactionalQueryable;
    owner = new Pool({ connectionString: OWNER_URL });
  });

  afterAll(async () => {
    await writer?.end();
    await owner?.end();
  });

  /** A new NEAR account and vault, with the NEAR fixtures re-keyed to them. */
  const nearCase = () => {
    const account = freshNear();
    const vault = freshVault();
    const suffix = tag();
    const swaps = { [NEAR]: account, [`"executor_id":"${REAL_VAULT}"`]: `"executor_id":"${vault}"` };
    return { account, vault, txs: NEAR_TXS.map((tx) => rekey(tx, swaps, suffix)) };
  };
  const evmCase = () => {
    const account = freshEvm();
    const vault = freshVault();
    const suffix = tag();
    const swaps = { [EVM]: account, [`"executor_id":"${REAL_VAULT}"`]: `"executor_id":"${vault}"` };
    return { account, vault, txs: EVM_TXS.map((tx) => rekey(tx, swaps, suffix)) };
  };

  const follow = async (account: string) => expect(await followAccount(db, account, { capped: false })).toBe("followed");

  const unpace = (account: string) =>
    owner.query("UPDATE account_cursor SET last_run_at = now() - interval '2 minutes' WHERE account_id = $1", [account]);

  const count = async (table: string, account: string) =>
    Number((await owner.query(`SELECT count(*) AS n FROM ${table} WHERE account_id = $1`, [account])).rows[0].n);

  const cursorOf = async (account: string) =>
    (await owner.query("SELECT * FROM account_cursor WHERE account_id = $1", [account])).rows[0];

  const pass = (account: string, vault: string, source: FastNearSource, over: Partial<AccountPassDeps> = {}) =>
    runAccountPass({ db, accountId: account, vaultId: vault, fastnear: source, now: () => T1, ...over });

  const ran = (r: AccountPassResult) => {
    if (!r.ran) throw new Error(`expected the pass to run, got ${r.reason}`);
    return r;
  };

  // ── Recording ─────────────────────────────────────────────────────────────────────────

  it("records a NEAR account's page: its transactions, the lines that name it, its movements, the cursor", async () => {
    const { account, vault, txs } = nearCase();
    await follow(account);
    const r = ran(await pass(account, vault, fakeFastNear([txs], account)));
    expect(r).toMatchObject({ ok: true, recordedTxs: 5, recordedMovements: 3, stuck: [], liveComplete: true, backfillDone: true });

    expect(await count("account_tx", account)).toBe(5);
    const kinds = await owner.query(
      "SELECT kind, amount::text AS amount, counterparty, memo FROM account_movement WHERE account_id = $1 ORDER BY block_ts",
      [account]
    );
    expect(kinds.rows.map((m) => m.kind).sort()).toEqual(["deposit", "transfer_out", "withdrawal"]);
    expect(kinds.rows.find((m) => m.kind === "transfer_out")).toMatchObject({
      amount: "14170",
      counterparty: "b3d8e1c1307a4cc180501e170a7bef826380917cd0c4453d937b2ba3085428aa",
      memo: null,
    });
    // 1 (deposit) + 3 (withdrawal) + 3 (transfer) + 1 (someone else's payout) + 0 (failed receipt).
    const lines = await owner.query(
      "SELECT count(*) AS n FROM intents_event WHERE tx_hash = ANY($1::text[])",
      [txs.map((t) => t.transaction.hash)]
    );
    expect(Number(lines.rows[0].n)).toBe(8);
    // Byte for byte, through Postgres.
    const transfer = txs.find((t) => t.transaction.hash.startsWith(TRANSFER_HEX.transaction.hash.slice(0, 50)))!;
    const logged = transfer.receipts[0].execution_outcome.outcome.logs[0];
    const stored = await owner.query("SELECT line FROM intents_event WHERE receipt_id = $1 AND log_index = 0", [
      transfer.receipts[0].execution_outcome.id,
    ]);
    expect(stored.rows[0].line).toBe(logged);

    const cursor = await cursorOf(account);
    expect(cursor).toMatchObject({ backfill_done: true, last_error: null });
    expect(cursor.last_ok_at.getTime()).toBe(T1);
  });

  it("an EVM account's allocation also writes the vault's rows; the vault's own pass then adds nothing", async () => {
    const { account, vault, txs } = evmCase();
    await follow(account);
    const r = ran(await pass(account, vault, fakeFastNear([txs], account)));
    expect(r).toMatchObject({ ok: true, recordedTxs: 3, recordedMovements: 4 });
    const vaultRows = async (table: string) =>
      Number((await owner.query(`SELECT count(*) AS n FROM ${table} WHERE vault_id = $1`, [vault])).rows[0].n);
    expect([await vaultRows("vault_tx"), await vaultRows("vault_event"), await vaultRows("portfolio_owner")]).toEqual([1, 4, 1]);

    const allocate = txs.find((t) => t.transaction.hash.startsWith(EVM_ALLOCATE.transaction.hash.slice(0, 50)))!;
    const vaultSource: FastNearSource = {
      indexedHeadMs: async () => T1,
      listPage: async () => ({ rows: [rowOf(allocate)], resumeToken: null }),
      fetchTxs: async () => [allocate],
    };
    const v = await runHistoryPass({ db, vaultId: vault, fastnear: vaultSource, prices: async () => new Map(), now: () => T1 });
    expect(v).toMatchObject({ ran: true, ok: true, recordedTxs: 0, recordedEvents: 0 });
    expect(await vaultRows("vault_event")).toBe(4);
  });

  it("a replay fetches nothing and inserts nothing", async () => {
    const { account, vault, txs } = nearCase();
    await follow(account);
    ran(await pass(account, vault, fakeFastNear([txs], account)));
    await unpace(account);
    const again = fakeFastNear([txs], account);
    expect(ran(await pass(account, vault, again))).toMatchObject({ ok: true, recordedTxs: 0, recordedMovements: 0 });
    expect(again.calls).toEqual(["list 0"]);
  });

  it("an account that is not followed is not read", async () => {
    const source = fakeFastNear([[]], "x");
    expect(await pass(freshNear(), freshVault(), source)).toEqual({ ran: false, reason: "not-followed" });
    expect(source.calls).toEqual([]);
  });

  it("an NFT id with U+0000: that movement is left out, the transaction and its line go in", async () => {
    const { account, vault } = nearCase();
    await follow(account);
    const evil = rekey(DEPOSIT, { [NEAR]: account }, tag());
    const receipt = evil.receipts.find((rc) => rc.execution_outcome.outcome.logs.some((l) => l.includes("mt_mint")))!;
    receipt.execution_outcome.outcome.logs = [
      `EVENT_JSON:${JSON.stringify({
        standard: "nep245",
        version: "1.0.0",
        event: "mt_mint",
        data: [{ owner_id: account, token_ids: ["imt:evil.near:a\u0000b", "imt:ok"], amounts: ["1", "1"], memo: "x\u0000y" }],
      })}`,
    ];
    const r = ran(await pass(account, vault, fakeFastNear([[evil]], account)));
    expect(r).toMatchObject({ ok: true, recordedTxs: 1, recordedMovements: 1 });
    expect(r.skipped).toHaveLength(1);
    const m = await owner.query("SELECT token_id, memo FROM account_movement WHERE account_id = $1", [account]);
    expect(m.rows).toEqual([{ token_id: "imt:ok", memo: "x�y" }]);
    const line = await owner.query("SELECT line FROM intents_event WHERE tx_hash = $1", [evil.transaction.hash]);
    expect(line.rows[0].line).toContain("a\\u0000b");
  });

  // ── The floor and the initial load ────────────────────────────────────────────────────

  it("nothing below the floor is fetched or stored, and the initial load ends there", async () => {
    const { account, vault, txs } = nearCase();
    await follow(account);
    const old = txs[txs.length - 1].transaction.hash;
    const rows = (tx: FastNearTx) => ({ ...rowOf(tx), blockHeight: tx.transaction.hash === old ? FLOOR_BLOCK_HEIGHT - 1 : rowOf(tx).blockHeight });
    // Page 2 would be beyond the floor: never listed.
    const source = fakeFastNear([txs.slice(0, 2), txs.slice(2), [DEPOSIT]], account, { rows });
    const r = ran(await pass(account, vault, source));
    expect(r).toMatchObject({ ok: true, recordedTxs: 4, backfillDone: true });
    expect(source.calls).toEqual(["list 0", "fetch 2", "list 1", "fetch 2"]);
    expect((await owner.query("SELECT 1 FROM account_tx WHERE tx_hash = $1", [old])).rowCount).toBe(0);
  });

  it("an initial load cut by the call cap is progress, not an error, and resumes", async () => {
    const { account, vault, txs } = nearCase();
    await follow(account);
    const pages = txs.map((t) => [t]);
    let r = ran(await pass(account, vault, fakeFastNear(pages, account), { maxCalls: 4 }));
    expect(r).toMatchObject({ ok: true, stoppedBy: "calls", liveComplete: true, backfillDone: false, recordedTxs: 2 });
    expect((await cursorOf(account)).last_error).toBeNull();

    await unpace(account);
    r = ran(await pass(account, vault, fakeFastNear(pages, account)));
    expect(r).toMatchObject({ ok: true, backfillDone: true, recordedTxs: 3 });
    expect(await count("account_tx", account)).toBe(5);
  });

  it("a live walk cut by the call cap before 'recorded until' says so and moves nothing", async () => {
    const { account, vault, txs } = nearCase();
    await follow(account);
    ran(await pass(account, vault, fakeFastNear([txs.slice(0, 1)], account)));
    await owner.query("UPDATE account_cursor SET last_ok_at = $2 WHERE account_id = $1", [account, new Date(tsOf(txs[4]) - 2 * HOUR)]);
    const before = (await cursorOf(account)).last_ok_at.getTime();
    await unpace(account);
    const r = ran(await pass(account, vault, fakeFastNear(txs.map((t) => [t]), account), { maxCalls: 2 }));
    expect(r).toMatchObject({ ok: false, stoppedBy: "calls", liveComplete: false });
    const cursor = await cursorOf(account);
    expect(cursor.last_ok_at.getTime()).toBe(before);
    expect(cursor.last_error).toMatch(/cap of .* calls .* before reaching 'recorded until'/);
  });

  it("`fresh` is the whole pass: back to 'recorded until', so asking for it every 5 s cannot stall it (R1)", async () => {
    const { account, vault, txs } = nearCase();
    await follow(account);
    // Loaded before, recorded until well below every fixture: the walk must list every page.
    await owner.query(
      "UPDATE account_cursor SET backfill_done = true, last_ok_at = $2, last_error = 'earlier' WHERE account_id = $1",
      [account, new Date(tsOf(txs[txs.length - 1]) - 2 * HOUR)]
    );
    const source = fakeFastNear(txs.map((t) => [t]), account);
    const r = ran(await pass(account, vault, source, { mode: "fresh" }));
    expect(source.calls).toHaveLength(2 * txs.length);
    expect(r).toMatchObject({ ok: true, recordedTxs: txs.length, liveComplete: true });
    const cursor = await cursorOf(account);
    expect(cursor.last_ok_at.getTime()).toBe(T1);
    expect(cursor.last_error).toBeNull();
  });

  it("`fresh` also goes on with an unfinished initial load", async () => {
    const { account, vault, txs } = nearCase();
    await follow(account);
    await owner.query(
      `UPDATE account_cursor SET backfill_done = false, backfill_resume = '1', last_ok_at = $2,
              last_error = 'initial load held at a page' WHERE account_id = $1`,
      [account, new Date(T1 - HOUR)]
    );
    const r = ran(await pass(account, vault, fakeFastNear([txs.slice(0, 2), txs.slice(2)], account), { mode: "fresh" }));
    expect(r).toMatchObject({ ok: true, liveComplete: true, backfillDone: true, recordedTxs: 5 });
    expect((await cursorOf(account)).last_error).toBeNull();
  });

  it("an expected transaction hands the pace back as it found it: asked every 2 s, it never holds the full pass (R1)", async () => {
    const { account, vault, txs } = nearCase();
    await follow(account);
    await owner.query("UPDATE account_cursor SET last_run_at = $2 WHERE account_id = $1", [account, new Date(Date.now() - 40_000)]);
    const before = (await cursorOf(account)).last_run_at.getTime();
    const of = (fixture: FastNearTx) => txs.find((t) => t.transaction.hash.startsWith(fixture.transaction.hash.slice(0, 50)))!;
    const late = of(WITHDRAWAL).transaction.hash;
    const source = fakeFastNear([txs], account, { unserved: new Set([late]) });
    for (let i = 0; i < 3; i++) {
      expect(await recordExpectedTx({ db, accountId: account, vaultId: vault, txHash: late, fastnear: source })).toMatchObject({
        status: "pending",
        detail: "not served by FastNEAR yet",
      });
    }
    expect(source.calls).toEqual(["fetch 1", "fetch 1", "fetch 1"]);
    expect((await cursorOf(account)).last_run_at.getTime()).toBe(before);
    // Recorded through `expect`, the pace is still handed back untouched.
    expect(
      (await recordExpectedTx({ db, accountId: account, vaultId: vault, txHash: of(DEPOSIT).transaction.hash, fastnear: source })).status
    ).toBe("recorded");
    expect((await cursorOf(account)).last_run_at.getTime()).toBe(before);
    expect((await pass(account, vault, fakeFastNear([txs], account))).ran).toBe(true);
  });

  it("paced: one pass per account per 30 s, and an expected transaction within 5 s of the last", async () => {
    const { account, vault, txs } = nearCase();
    await follow(account);
    ran(await pass(account, vault, fakeFastNear([txs], account)));
    const source = fakeFastNear([txs], account);
    expect(await pass(account, vault, source)).toEqual({ ran: false, reason: "paced" });
    expect(await pass(account, vault, source, { mode: "fresh" })).toEqual({ ran: false, reason: "paced" });
    expect(
      await recordExpectedTx({ db, accountId: account, vaultId: vault, txHash: "unknown", fastnear: source })
    ).toEqual({ status: "pending" });
    expect(source.calls).toEqual([]);
    // Past 5 s, `fresh` may run while a catch-up pass still may not.
    await owner.query("UPDATE account_cursor SET last_run_at = now() - interval '10 seconds' WHERE account_id = $1", [account]);
    expect(await pass(account, vault, source)).toEqual({ ran: false, reason: "paced" });
    expect((await pass(account, vault, source, { mode: "fresh" })).ran).toBe(true);
  });

  // ── Brakes ────────────────────────────────────────────────────────────────────────────

  it(`past ${ACCOUNT_TX_CAP} transactions an account is not recorded any more, and its cursor says so`, async () => {
    const { account, vault, txs } = nearCase();
    await follow(account);
    await owner.query(
      `INSERT INTO account_tx (account_id, tx_hash, block_height, block_ts)
       SELECT $1, 'filler' || g, $2, date_trunc('milliseconds', now()) FROM generate_series(1, $3) AS g`,
      [account, FLOOR_BLOCK_HEIGHT, ACCOUNT_TX_CAP]
    );
    const source = fakeFastNear([txs], account);
    const r = ran(await pass(account, vault, source));
    expect(r).toMatchObject({ ok: false, stoppedBy: "over-cap", recordedTxs: 0 });
    expect(source.calls).toEqual([]);
    expect((await cursorOf(account)).last_error).toMatch(/over the cap of 5000/);
    await unpace(account);
    expect((await recordExpectedTx({ db, accountId: account, vaultId: vault, txHash: txs[0].transaction.hash, fastnear: source })).status).toBe(
      "over-cap"
    );
  });

  it("the cap is also counted down within a pass: it stops at the page that reaches it", async () => {
    const { account, vault, txs } = nearCase();
    await follow(account);
    await owner.query(
      `INSERT INTO account_tx (account_id, tx_hash, block_height, block_ts)
       SELECT $1, 'filler' || g, $2, date_trunc('milliseconds', now()) FROM generate_series(1, $3) AS g`,
      [account, FLOOR_BLOCK_HEIGHT, ACCOUNT_TX_CAP - 2]
    );
    const source = fakeFastNear([txs.slice(0, 3), txs.slice(3)], account);
    const r = ran(await pass(account, vault, source));
    // The page that crossed went in whole (at most one page over the cap); the next was not read.
    expect(r).toMatchObject({ ok: false, stoppedBy: "over-cap", recordedTxs: 3 });
    expect(source.calls).toEqual(["list 0", "fetch 3"]);
    expect(await count("account_tx", account)).toBe(ACCOUNT_TX_CAP + 1);
  });

  it("the hourly cap on new accounts holds under concurrent requests (decision 9)", async () => {
    const recent = await owner.query("SELECT count(*) AS n FROM account_cursor WHERE created_at > now() - interval '1 hour'");
    const perHour = Number(recent.rows[0].n) + 2;
    const accounts = Array.from({ length: 6 }, freshNear);
    const results = await Promise.all(accounts.map((a) => followAccount(db, a, { capped: true, perHour })));
    expect(results.filter((x) => x === "followed")).toHaveLength(2);
    expect(results.filter((x) => x === "capped")).toHaveLength(4);
    expect(await followAccount(db, accounts[results.indexOf("followed")], { capped: true, perHour })).toBe("already");
  });

  it("past the hourly cap a signup is refused without waiting for the signup lock", async () => {
    const recent = await owner.query("SELECT count(*) AS n FROM account_cursor WHERE created_at > now() - interval '1 hour'");
    const noLock: TransactionalQueryable = {
      query: (text, values) => db.query(text, values),
      connect: () => Promise.reject(new Error("took a connection for the lock")),
    };
    expect(await followAccount(noLock, freshNear(), { capped: true, perHour: Number(recent.rows[0].n) })).toBe("capped");
  });

  it("FastNEAR's rate limit and the account's lock taken are quiet stops: the last error stays", async () => {
    const { account, vault, txs } = nearCase();
    await follow(account);
    await owner.query("UPDATE account_cursor SET last_error = 'earlier' WHERE account_id = $1", [account]);
    const limited = fakeFastNear([txs], account);
    limited.listPage = async () => Promise.reject(new FastNearRateLimitError("429"));
    expect(ran(await pass(account, vault, limited))).toMatchObject({ ok: true, stoppedBy: "rate-limited" });
    expect((await cursorOf(account)).last_error).toBe("earlier");

    await unpace(account);
    const holder = await owner.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`intentfolio-history:account:${account}`]);
      expect(ran(await pass(account, vault, fakeFastNear([txs], account)))).toMatchObject({ ok: true, stoppedBy: "busy", recordedTxs: 0 });
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    expect((await cursorOf(account)).last_error).toBe("earlier");
  });

  // ── Two writers ───────────────────────────────────────────────────────────────────────

  /** Another session writing the line `tx` shares with a second account, not committed yet. */
  const holdLine = async (tx: FastNearTx) => {
    const receipt = tx.receipts.find((rc) => rc.execution_outcome.outcome.logs.some((l) => l.includes('"transfer"')))!;
    const holder = await owner.connect();
    await holder.query("BEGIN");
    await holder.query(
      `INSERT INTO intents_event (receipt_id, log_index, tx_hash, block_height, block_ts, standard, event, line)
       VALUES ($1, 0, $2, $3, date_trunc('milliseconds', now()), 'dip4', 'transfer', $4)`,
      [receipt.execution_outcome.id, tx.transaction.hash, receipt.execution_outcome.block_height, receipt.execution_outcome.outcome.logs[0]]
    );
    return holder;
  };

  it("a line another pass is writing: waits for it, then shares it", async () => {
    const { account, vault, txs } = nearCase();
    await follow(account);
    const transfer = txs.find((t) => t.transaction.hash.startsWith(TRANSFER_HEX.transaction.hash.slice(0, 50)))!;
    const holder = await holdLine(transfer);
    const running = pass(account, vault, fakeFastNear([[transfer]], account));
    await new Promise((resolve) => setTimeout(resolve, 300));
    await holder.query("COMMIT");
    holder.release();
    const r = ran(await running);
    expect(r).toMatchObject({ ok: true, recordedTxs: 1, recordedMovements: 1, stuck: [] });
  });

  it("a line held past the lock timeout: the transaction is transient, retried next pass, not reported", async () => {
    const { account, vault, txs } = nearCase();
    await follow(account);
    const transfer = txs.find((t) => t.transaction.hash.startsWith(TRANSFER_HEX.transaction.hash.slice(0, 50)))!;
    const holder = await holdLine(transfer);
    let r: AccountPassResult;
    try {
      r = await pass(account, vault, fakeFastNear([[transfer]], account));
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    expect(ran(r)).toMatchObject({ ok: true, recordedTxs: 0, stuck: [expect.objectContaining({ transient: true, reason: expect.stringContaining("55P03") })] });
    const cursor = await cursorOf(account);
    expect(cursor.last_error).toBeNull();
    expect(cursor.last_ok_at.getTime()).toBe(tsOf(transfer));

    await unpace(account);
    expect(ran(await pass(account, vault, fakeFastNear([[transfer]], account)))).toMatchObject({ ok: true, recordedTxs: 1 });
  }, 20_000);

  it("forced: the vault's pass writes a rebalance the account's pass just committed — the daily sum counts it once", async () => {
    const account = freshNear();
    const vault = freshVault();
    await follow(account);
    const rebalance = rekey(REBALANCE, { [`"executor_id":"${REAL_VAULT}"`]: `"executor_id":"${vault}"` }, tag());
    const prices = async (): Promise<PriceBook> => new Map([["nep141:usdt.tether-token.near", { priceText: "0.5", decimals: 6 }]]);
    let vaultRead!: () => void;
    const vaultHasRead = new Promise<void>((resolve) => (vaultRead = resolve));
    let accountDone!: () => void;
    const accountCommitted = new Promise<void>((resolve) => (accountDone = resolve));
    // The vault pass finds nothing recorded, then waits until the account's pass has committed.
    const vaultSource: FastNearSource = {
      indexedHeadMs: async () => T1,
      listPage: async () => ({ rows: [rowOf(rebalance)], resumeToken: null }),
      fetchTxs: async () => {
        vaultRead();
        await accountCommitted;
        return [rebalance];
      },
    };
    // The account's pass writes only once the vault pass has read.
    const accountSource = fakeFastNear([[rebalance]], account, { beforeFetch: () => vaultHasRead });
    const vaultPass = runHistoryPass({ db, vaultId: vault, fastnear: vaultSource, prices, now: () => T1 });
    const a = ran(await pass(account, vault, accountSource, { prices }));
    accountDone();
    const v = await vaultPass;
    expect(a).toMatchObject({ ok: true, recordedTxs: 1 });
    // The vault pass really wrote (no step-aside), and every insert of its was a no-op.
    expect(v).toMatchObject({ ran: true, ok: true, stoppedBy: null, recordedTxs: 0, recordedEvents: 0 });
    const daily = await owner.query("SELECT swaps, spread::text AS spread FROM portfolio_daily WHERE vault_id = $1", [vault]);
    expect(daily.rows).toEqual([{ swaps: 1, spread: "593" }]);
  });

  it("the vault's pass and an account's pass racing on one allocation write each row once", async () => {
    for (let i = 0; i < 3; i++) {
      const { account, vault, txs } = evmCase();
      await follow(account);
      const allocate = txs.find((t) => t.transaction.hash.startsWith(EVM_ALLOCATE.transaction.hash.slice(0, 50)))!;
      const vaultSource: FastNearSource = {
        indexedHeadMs: async () => T1,
        listPage: async () => ({ rows: [rowOf(allocate)], resumeToken: null }),
        fetchTxs: async () => [allocate],
      };
      const [a, v] = await Promise.all([
        pass(account, vault, fakeFastNear([[allocate]], account)),
        runHistoryPass({ db, vaultId: vault, fastnear: vaultSource, prices: async () => new Map(), now: () => T1 }),
      ]);
      expect(a).toMatchObject({ ran: true, ok: true });
      expect(v).toMatchObject({ ran: true, ok: true });
      const n = await owner.query(
        "SELECT (SELECT count(*) FROM vault_tx WHERE vault_id = $1) AS tx, (SELECT count(*) FROM vault_event WHERE vault_id = $1) AS ev",
        [vault]
      );
      expect(n.rows[0]).toEqual({ tx: "1", ev: "4" });
    }
  });

  // ── One expected transaction ──────────────────────────────────────────────────────────

  it("an expected transaction that names the account goes in at once; one that does not, never", async () => {
    const { account, vault, txs } = nearCase();
    await follow(account);
    const deposit = txs.find((t) => t.transaction.hash.startsWith(DEPOSIT.transaction.hash.slice(0, 50)))!;
    const stranger = rekey(DEPOSIT, {}, tag()); // still names pablofork.near
    const source = fakeFastNear([[deposit, stranger]], account, { unserved: new Set(["nope"]) });

    expect(await recordExpectedTx({ db, accountId: account, vaultId: vault, txHash: "nope", fastnear: source })).toMatchObject({
      status: "pending",
    });
    await unpace(account);
    expect((await recordExpectedTx({ db, accountId: account, vaultId: vault, txHash: stranger.transaction.hash, fastnear: source })).status).toBe(
      "not-this-account"
    );
    await unpace(account);
    expect((await recordExpectedTx({ db, accountId: account, vaultId: vault, txHash: deposit.transaction.hash, fastnear: source })).status).toBe(
      "recorded"
    );
    expect(await count("account_movement", account)).toBe(1);
    // Known now: answered from the database, no call.
    const calls = source.calls.length;
    expect((await recordExpectedTx({ db, accountId: account, vaultId: vault, txHash: deposit.transaction.hash, fastnear: source })).status).toBe(
      "recorded"
    );
    expect(source.calls).toHaveLength(calls);
    // The walk lists it later and skips it.
    expect((await cursorOf(account)).last_ok_at).toBeNull();
  });
});
