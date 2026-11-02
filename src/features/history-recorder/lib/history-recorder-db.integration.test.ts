// @vitest-environment node
//
// Proves the recorder's pass against the real schema (`intentfolio-solver/db/migrations/
// 008_history.sql`): its CHECKs, foreign keys, triggers and the grants of
// `intentfolio_history_writer`, with FastNEAR replaced by real vault transactions
// (history-recorder.fixtures.ts) re-addressed to a fresh vault id per case — every history
// table is append-only, so nothing can be cleaned up and nothing is shared between cases.
//
//   cd ../intentfolio-solver && docker compose -f db/local/docker-compose.yml up -d && yarn db:migrate:local
//   npm run test:history-db
//
// Direct port 5432, not the pooler: the local pgbouncer pins the ops writer's credential.
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
import { runHistoryPass, type FastNearSource, type PassResult, type RecorderDeps } from "./history-recorder";
import type { PriceBook } from "./history-prices";
import {
  COMMIT_WITHDRAW,
  CREATE_FIRST,
  DELETE,
  FAILED_ADMIN,
  NO_VAULT_RECEIPT,
  REBALANCE,
  RENAME,
} from "./history-recorder.fixtures";

const WRITER_URL = process.env[HISTORY_WRITER_URL_VAR];
const OWNER_URL = process.env.INTENTFOLIO_OPS_DB_TEST_OWNER_URL;
const suite = WRITER_URL && OWNER_URL ? describe : describe.skip;

const REAL_VAULT = "intentfolio-vault.near";
const USDT = "nep141:usdt.tether-token.near";
const HOUR = 60 * 60 * 1000;
const PRICES: PriceBook = new Map([[USDT, { priceText: "0.5", decimals: 6 }]]);

const tsOf = (tx: FastNearTx) => Math.floor(tx.execution_outcome.block_timestamp / 1e6);
/** The default clock and indexed head of a pass: an hour after the newest fixture. */
const T1 = tsOf(REBALANCE) + HOUR;
/** Newest first, as FastNEAR lists. */
const ALL = [REBALANCE, DELETE, COMMIT_WITHDRAW, RENAME, CREATE_FIRST, FAILED_ADMIN, NO_VAULT_RECEIPT].sort(
  (a, b) => tsOf(b) - tsOf(a)
);

const copy = (tx: FastNearTx): FastNearTx => JSON.parse(JSON.stringify(tx)) as FastNearTx;
const vaultReceiptOf = (tx: FastNearTx) => tx.receipts.find((r) => r.execution_outcome.outcome.executor_id === REAL_VAULT)!;

/** The fixture as the given vault would have produced it. */
function readdress(tx: FastNearTx, vault: string): FastNearTx {
  return JSON.parse(JSON.stringify(tx).split(`"executor_id":"${REAL_VAULT}"`).join(`"executor_id":"${vault}"`));
}

const rowOf = (tx: FastNearTx): AccountTxRow => ({
  hash: tx.transaction.hash,
  blockHeight: tx.execution_outcome.block_height!,
  blockTsMs: tsOf(tx),
});

type FakeOptions = {
  /** What `/status` says; a rejection when null. Default `T1`. */
  head?: number | null;
  /** Hashes `/v0/transactions` leaves out of its answer. */
  unserved?: Set<string>;
  /** Called before the transactions are returned. */
  beforeFetch?: () => Promise<void>;
};

type FakeSource = FastNearSource & { calls: string[] };

/** FastNEAR over fixed pages; the resume token is the index of the next page. */
function fakeFastNear(pages: FastNearTx[][], vault: string, options: FakeOptions = {}): FakeSource {
  const byHash = new Map(pages.flat().map((tx) => [tx.transaction.hash, readdress(tx, vault)]));
  const calls: string[] = [];
  return {
    calls,
    async indexedHeadMs() {
      const head = options.head === undefined ? T1 : options.head;
      if (head === null) throw new Error("status down");
      return head;
    },
    async listPage(accountId, token) {
      expect(accountId).toBe(vault);
      const index = token === null ? 0 : Number(token);
      calls.push(`list ${index}`);
      return {
        rows: pages[index].map(rowOf),
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

suite("history recorder — one pass against a real Postgres 16 and the 008 schema", () => {
  let writer: Pool;
  let owner: Pool;
  let db: TransactionalQueryable;

  beforeAll(() => {
    const config = readOpsDbConfig(process.env, HISTORY_WRITER_URL_VAR);
    if (!config.ok) throw new Error(config.issues.join(", "));
    writer = new Pool(createPoolConfig({ ...config.config, maxConnections: 4 }));
    db = writer as unknown as TransactionalQueryable;
    owner = new Pool({ connectionString: OWNER_URL });
  });

  afterAll(async () => {
    await writer?.end();
    await owner?.end();
  });

  const freshVault = () => `v${randomBytes(5).toString("hex")}.test.near`;

  /** Lets the next pass start now (as the owner: the pace is a column like any other). */
  const unpace = (vault: string) =>
    owner.query("UPDATE history_cursor SET last_run_at = now() - interval '2 minutes' WHERE vault_id = $1", [vault]);

  const count = async (table: string, vault: string) =>
    Number((await owner.query(`SELECT count(*) AS n FROM ${table} WHERE vault_id = $1`, [vault])).rows[0].n);

  const cursorOf = async (vault: string) =>
    (await owner.query("SELECT * FROM history_cursor WHERE vault_id = $1", [vault])).rows[0];

  const dailyOf = async (vault: string) =>
    (
      await owner.query(
        `SELECT portfolio_id, day::text AS day, token_id, swaps, spread::text AS spread,
                spread_usd::text AS spread_usd, spread_unpriced::text AS spread_unpriced, usd_from_backfill
           FROM portfolio_daily WHERE vault_id = $1 ORDER BY portfolio_id, day, token_id`,
        [vault]
      )
    ).rows;

  /**
   * The writer's pool, except that the first statement on a lent connection matching `pattern`
   * fails as Postgres fails a writer that lost a lock to another one.
   */
  const failingOnce = (pattern: RegExp, code: string): TransactionalQueryable => {
    let armed = true;
    return {
      query: (text, values) => db.query(text, values),
      async connect() {
        const client = await db.connect();
        return {
          release: (err) => client.release(err),
          query: async (text, values) => {
            if (armed && pattern.test(text)) {
              armed = false;
              throw Object.assign(new Error("lost to another writer"), { code });
            }
            return client.query(text, values);
          },
        };
      },
    };
  };

  const pass = (vault: string, source: FastNearSource, over: Partial<RecorderDeps> = {}) =>
    runHistoryPass({
      db,
      vaultId: vault,
      fastnear: source,
      prices: async () => PRICES,
      now: () => T1,
      ...over,
    });

  const ran = (r: PassResult) => {
    if (!r.ran) throw new Error(`expected the pass to run, got ${r.reason}`);
    return r;
  };

  // ── Recording ─────────────────────────────────────────────────────────────────────────

  it("records a page of real transactions: every table, the owner, the day's swap and spread, the cursor", async () => {
    const vault = freshVault();
    const r = ran(await pass(vault, fakeFastNear([ALL], vault)));
    expect(r).toMatchObject({ ok: true, recordedTxs: 7, recordedEvents: 9, stuck: [], liveComplete: true, backfillDone: true });
    // Who the new events name: the cron brings these accounts up to date next (028-6).
    expect(r.accounts).toEqual(["pablofork.near"]);

    expect(await count("vault_tx", vault)).toBe(7);
    expect(await count("vault_event", vault)).toBe(9);
    expect(await count("vault_call", vault)).toBe(4); // on_auth + three commits
    expect(await count("vault_event_portfolio", vault)).toBe(7);
    expect(await count("portfolio_owner", vault)).toBe(1);

    // The line stored is the line logged.
    const logged = vaultReceiptOf(REBALANCE).execution_outcome.outcome.logs[0].slice("EVENT_JSON:".length);
    const same = await owner.query(
      "SELECT raw = $2::jsonb AS same, account_id FROM vault_event WHERE vault_id = $1 AND event = 'external_rebalance'",
      [vault, logged]
    );
    expect(same.rows[0]).toEqual({ same: true, account_id: null });

    // A creation's composition is kept in its call (decision 9).
    const call = await owner.query(
      "SELECT args #>> '{signer_id}' AS signer FROM vault_call WHERE vault_id = $1 AND method = 'on_auth'",
      [vault]
    );
    expect(call.rows[0].signer).toBe("pablofork.near");

    // 593 units of a 6-decimal token at the pass's price of 0.5.
    expect(await dailyOf(vault)).toEqual([
      {
        portfolio_id: "p_000000000001",
        day: new Date(tsOf(REBALANCE)).toISOString().slice(0, 10),
        token_id: USDT,
        swaps: 1,
        spread: "593",
        spread_usd: "0.000296500000",
        spread_unpriced: "0",
        usd_from_backfill: false,
      },
    ]);

    // The 028-0 fold: what went in minus what came out, per (portfolio, token).
    const fold = await owner.query(
      `SELECT p.portfolio_id, COALESCE(e.raw #>> '{data,0,token}', e.raw #>> '{data,0,token_in}') AS token,
              sum(COALESCE(p.qty_in, 0) - COALESCE(p.qty_out, 0))::text AS net
         FROM vault_event_portfolio p JOIN vault_event e USING (vault_id, receipt_id, log_index)
        WHERE p.vault_id = $1 AND e.event IN ('allocate', 'unallocate')
        GROUP BY 1, 2`,
      [vault]
    );
    expect(fold.rows).toEqual([{ portfolio_id: "p_000000000000", token: USDT, net: "0" }]);

    const cursor = await cursorOf(vault);
    expect(cursor.backfill_done).toBe(true);
    expect(cursor.last_ok_at.getTime()).toBe(T1); // the indexed head
    expect(cursor.last_error).toBeNull();

    const price = await owner.query("SELECT 1 FROM token_price_daily WHERE day = $1::date AND token_id = $2", [
      new Date(T1).toISOString().slice(0, 10),
      USDT,
    ]);
    expect(price.rowCount).toBe(1);
  });

  it("a receipt FastNEAR serves twice inside one transaction is counted once", async () => {
    const vault = freshVault();
    const twice = copy(REBALANCE);
    twice.receipts.push(copy(REBALANCE).receipts.find((r) => r.execution_outcome.outcome.executor_id === REAL_VAULT)!);
    ran(await pass(vault, fakeFastNear([[twice]], vault)));
    expect((await dailyOf(vault)).map((d) => [d.swaps, d.spread])).toEqual([[1, "593"]]);
  });

  // ── Idempotency ───────────────────────────────────────────────────────────────────────

  it("a replay fetches nothing and adds nothing", async () => {
    const vault = freshVault();
    const source = fakeFastNear([ALL], vault);
    ran(await pass(vault, source));
    await unpace(vault);
    const before = await dailyOf(vault);
    const r = ran(await pass(vault, source));
    expect(r).toMatchObject({ ok: true, recordedTxs: 0, recordedEvents: 0, accounts: [] });
    expect(source.calls.filter((c) => c.startsWith("fetch"))).toHaveLength(1); // only the first pass's
    expect(await dailyOf(vault)).toEqual(before);
  });

  it("two passes racing on the same transactions: the daily sums count each swap once", async () => {
    const vault = freshVault();
    let releaseB!: () => void;
    const aCommitted = new Promise<void>((resolve) => (releaseB = resolve));
    let bReachedFetch!: () => void;
    const bRead = new Promise<void>((resolve) => (bReachedFetch = resolve));
    let passB: Promise<PassResult> | undefined;

    // B lists and finds nothing recorded, then waits until A has committed before it writes.
    const sourceB = fakeFastNear([ALL], vault, {
      beforeFetch: async () => {
        bReachedFetch();
        await aCommitted;
      },
    });
    // A lets B start (as if A's hold had lapsed), and holds its own writes until B has read.
    const sourceA = fakeFastNear([ALL], vault, { beforeFetch: () => bRead });
    const listA = sourceA.listPage;
    sourceA.listPage = async (account, token) => {
      await unpace(vault);
      passB = pass(vault, sourceB);
      return listA(account, token);
    };

    const a = ran(await pass(vault, sourceA));
    releaseB();
    const b = ran(await passB!);
    expect(a).toMatchObject({ ok: true, recordedTxs: 7 });
    // B really wrote (no step-aside), and every one of its inserts was a no-op.
    expect(b).toMatchObject({ ok: true, stoppedBy: null, recordedTxs: 0, recordedEvents: 0 });
    expect(await count("vault_event_portfolio", vault)).toBe(7);
    expect((await dailyOf(vault)).map((d) => [d.swaps, d.spread])).toEqual([[1, "593"]]);
  });

  // ── Pace and lock ─────────────────────────────────────────────────────────────────────

  it("a pass holds the pace for its whole life; the next one may start a minute after it ends", async () => {
    const vault = freshVault();
    let during: PassResult | undefined;
    const source = fakeFastNear([ALL], vault);
    const list = source.listPage;
    source.listPage = async (account, token) => {
      during = await pass(vault, fakeFastNear([ALL], vault)); // a second trigger while this one works
      return list(account, token);
    };
    ran(await pass(vault, source));
    expect(during).toEqual({ ran: false, reason: "paced" });

    const cursor = await cursorOf(vault);
    // Handed back at its end: not left at the hold, minutes ahead.
    expect(Math.abs(Date.now() - cursor.last_run_at.getTime())).toBeLessThan(10_000);
    expect(await pass(vault, fakeFastNear([ALL], vault))).toEqual({ ran: false, reason: "paced" });
    await unpace(vault);
    expect((await pass(vault, fakeFastNear([ALL], vault))).ran).toBe(true);
  });

  it("a pass that finds the write lock taken steps aside, records nothing and says so", async () => {
    const vault = freshVault();
    const holder = await owner.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`intentfolio-history:${vault}`]);
      const r = ran(await pass(vault, fakeFastNear([ALL], vault)));
      expect(r).toMatchObject({ ok: false, stoppedBy: "busy", recordedTxs: 0 });
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    expect(await count("vault_tx", vault)).toBe(0);
    const cursor = await cursorOf(vault);
    expect(cursor.last_ok_at).toBeNull();
    expect(cursor.last_error).toMatch(/write lock/);
  });

  // ── The watermark ─────────────────────────────────────────────────────────────────────

  it("a transaction FastNEAR does not serve pins 'recorded until' at it, is named, and goes in on a later pass", async () => {
    const vault = freshVault();
    const missing = CREATE_FIRST.transaction.hash;
    const r = ran(await pass(vault, fakeFastNear([ALL], vault, { unserved: new Set([missing]) })));
    expect(r.stuck).toEqual([expect.objectContaining({ hash: missing, reason: "listed but not served by FastNEAR" })]);
    expect(r).toMatchObject({ ok: false, recordedTxs: 6 });
    let cursor = await cursorOf(vault);
    expect(cursor.last_ok_at.getTime()).toBe(tsOf(CREATE_FIRST));
    expect(cursor.last_error).toContain(missing);

    await unpace(vault);
    const t2 = T1 + HOUR;
    const later = ran(await pass(vault, fakeFastNear([ALL], vault, { head: t2 }), { now: () => t2 }));
    expect(later).toMatchObject({ ok: true, recordedTxs: 1, stuck: [] });
    cursor = await cursorOf(vault);
    expect(cursor.last_ok_at.getTime()).toBe(t2);
    expect(cursor.last_error).toBeNull();
    expect(await count("portfolio_owner", vault)).toBe(1);
  });

  it("an unfinished transaction is held back until every receipt is in, without an error while it is young", async () => {
    const vault = freshVault();
    const partial = copy(COMMIT_WITHDRAW);
    partial.receipts = partial.receipts.filter((r) => !r.execution_outcome.outcome.logs.some((l) => l.includes('"unallocate"')));
    const r = ran(await pass(vault, fakeFastNear([[partial]], vault), { now: () => tsOf(partial) + 60_000 }));
    expect(r.stuck[0].reason).toMatch(/still to come/);
    expect(r.ok).toBe(true);
    expect(await count("vault_tx", vault)).toBe(0);
    const cursor = await cursorOf(vault);
    expect(cursor.last_error).toBeNull();
    expect(cursor.last_ok_at.getTime()).toBe(tsOf(partial));

    await unpace(vault);
    ran(await pass(vault, fakeFastNear([[COMMIT_WITHDRAW]], vault), { now: () => tsOf(partial) + 120_000 }));
    expect(await count("vault_event", vault)).toBe(2);
  });

  it("without FastNEAR's indexed head, 'recorded until' is the newest transaction listed", async () => {
    const vault = freshVault();
    ran(await pass(vault, fakeFastNear([ALL], vault, { head: null })));
    expect((await cursorOf(vault)).last_ok_at.getTime()).toBe(tsOf(REBALANCE));
  });

  it("the live walk lists back to 'recorded until' − 1 h and no further", async () => {
    const vault = freshVault();
    const pages = [[REBALANCE], [DELETE], [COMMIT_WITHDRAW], [RENAME], [CREATE_FIRST]];
    // First pass: page 1, then the initial load reads the rest; "recorded until" set just past
    // an hour after COMMIT_WITHDRAW, so the next floor falls between it and DELETE.
    ran(await pass(vault, fakeFastNear(pages, vault, { head: tsOf(COMMIT_WITHDRAW) + HOUR + 1_000 })));
    expect(await count("vault_tx", vault)).toBe(5);

    await unpace(vault);
    const second = fakeFastNear(pages, vault);
    ran(await pass(vault, second));
    expect(second.calls).toEqual(["list 0", "list 1", "list 2"]);
  });

  it("a live walk cut by the budget before 'recorded until' fails loudly and moves nothing", async () => {
    const vault = freshVault();
    const pages = [[REBALANCE], [DELETE], [COMMIT_WITHDRAW]];
    ran(await pass(vault, fakeFastNear(pages, vault, { head: tsOf(COMMIT_WITHDRAW) + HOUR + 1_000 })));
    const before = (await cursorOf(vault)).last_ok_at.getTime();

    await unpace(vault);
    const r = ran(await pass(vault, fakeFastNear(pages, vault), { budgetMs: -1 }));
    expect(r).toMatchObject({ ok: false, stoppedBy: "budget", liveComplete: false });
    const cursor = await cursorOf(vault);
    expect(cursor.last_ok_at.getTime()).toBe(before);
    expect(cursor.last_error).toMatch(/time budget .* before reaching 'recorded until'/);
  });

  it("a page whose token does not advance fails the pass instead of looping", async () => {
    const vault = freshVault();
    const source = fakeFastNear([[REBALANCE]], vault);
    source.listPage = async () => ({ rows: [], resumeToken: "7" });
    const r = ran(await pass(vault, source));
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/does not advance/) });
    expect((await cursorOf(vault)).last_ok_at).toBeNull();
  });

  it("FastNEAR's rate limit ends the pass without an error, and leaves the last one as it was", async () => {
    const vault = freshVault();
    ran(await pass(vault, fakeFastNear([ALL], vault)));
    await owner.query("UPDATE history_cursor SET last_error = 'earlier' WHERE vault_id = $1", [vault]);
    const before = (await cursorOf(vault)).last_ok_at.getTime();

    await unpace(vault);
    const source = fakeFastNear([ALL], vault);
    source.listPage = async () => Promise.reject(new FastNearRateLimitError("FastNEAR /v0/account answered 429"));
    const r = ran(await pass(vault, source, { now: () => T1 + HOUR }));
    expect(r).toMatchObject({ ok: true, stoppedBy: "rate-limited", liveComplete: false });
    const cursor = await cursorOf(vault);
    expect(cursor.last_ok_at.getTime()).toBe(before);
    expect(cursor.last_error).toBe("earlier");
  });

  it("a transaction lost to another writer (deadlock, lock timeout) is retried next pass, not reported", async () => {
    for (const code of ["40P01", "55P03"]) {
      const vault = freshVault();
      // REBALANCE, the newest, loses the lock; the rest of its page is not even tried (each try
      // could wait out the lock timeout again) and waits for the next pass with it.
      const r = ran(await pass(vault, fakeFastNear([ALL], vault), { db: failingOnce(/INSERT INTO vault_event\s/, code) }));
      expect(r).toMatchObject({ ok: true, recordedTxs: 0 });
      expect(r.stuck[0]).toMatchObject({ hash: REBALANCE.transaction.hash, transient: true, reason: expect.stringContaining(code) });
      expect(r.stuck).toHaveLength(ALL.length);
      expect(r.stuck.every((s) => s.transient)).toBe(true);
      let cursor = await cursorOf(vault);
      expect(cursor.last_error).toBeNull();
      // Held below the watermark: "recorded until" stops at the oldest that did not go in.
      expect(cursor.last_ok_at.getTime()).toBe(Math.min(...ALL.map(tsOf)));

      await unpace(vault);
      const later = ran(await pass(vault, fakeFastNear([ALL], vault, { head: T1 + HOUR }), { now: () => T1 + HOUR }));
      expect(later).toMatchObject({ ok: true, recordedTxs: ALL.length, stuck: [] });
      cursor = await cursorOf(vault);
      expect(cursor.last_ok_at.getTime()).toBe(T1 + HOUR);
    }
  });

  it("a lost lock does not clear an earlier error: that pass did not see everything", async () => {
    const vault = freshVault();
    const missing = CREATE_FIRST.transaction.hash;
    ran(await pass(vault, fakeFastNear([ALL], vault, { unserved: new Set([missing]) })));
    expect((await cursorOf(vault)).last_error).toContain(missing);

    await unpace(vault);
    const r = ran(
      await pass(vault, fakeFastNear([ALL], vault, { head: T1 + HOUR }), {
        now: () => T1 + HOUR,
        db: failingOnce(/INSERT INTO vault_event\s/, "40P01"),
      })
    );
    expect(r.ok).toBe(true);
    expect((await cursorOf(vault)).last_error).toContain(missing);
  });

  // ── Bad transactions ──────────────────────────────────────────────────────────────────

  it("a transaction the database refuses does not take its page down", async () => {
    const vault = freshVault();
    const huge = copy(RENAME);
    // Over `vault_event_raw_shape`'s 64 KiB (a real line cannot be: NEAR caps a receipt's logs at 16 KiB).
    vaultReceiptOf(huge).execution_outcome.outcome.logs = [
      `EVENT_JSON:${JSON.stringify({
        standard: "intentfolio-vault",
        version: "2.0.0",
        event: "portfolio_renamed",
        data: [{ account_id: "pablofork.near", portfolio_id: "p_000000000000", name: "n".repeat(70_000) }],
      })}`,
    ];
    const r = ran(await pass(vault, fakeFastNear([[REBALANCE, huge, CREATE_FIRST]], vault)));
    expect(r.recordedTxs).toBe(2);
    expect(r.stuck).toEqual([
      expect.objectContaining({ hash: RENAME.transaction.hash, reason: expect.stringMatching(/refused by the database: 23514/) }),
    ]);
    expect(await count("vault_tx", vault)).toBe(2);
    expect((await cursorOf(vault)).last_ok_at.getTime()).toBe(tsOf(RENAME));
  });

  it("a transaction and its share of the daily sums go in together or not at all", async () => {
    const vault = freshVault();
    const odd = copy(REBALANCE);
    // A token id over `portfolio_daily`'s 256 characters: every insert before the daily one succeeds.
    const r0 = vaultReceiptOf(odd).execution_outcome.outcome;
    r0.logs = [r0.logs[0].replace("nep141:usdt.tether-token.near", `nep141:${"x".repeat(300)}`)];
    const r = ran(await pass(vault, fakeFastNear([[odd, CREATE_FIRST]], vault)));
    expect(r.stuck).toEqual([expect.objectContaining({ hash: REBALANCE.transaction.hash })]);
    expect(await count("vault_tx", vault)).toBe(1);
    expect(await count("vault_event", vault)).toBe(4); // CREATE_FIRST's only
    expect(await dailyOf(vault)).toEqual([]);
  });

  it("a transaction this code cannot read is held back alone", async () => {
    const vault = freshVault();
    // Listed as usual, served without its outcome.
    const source = fakeFastNear([[REBALANCE, RENAME]], vault);
    const fetchTxs = source.fetchTxs;
    source.fetchTxs = async (hashes) =>
      (await fetchTxs(hashes)).map((tx) => {
        if (tx.transaction.hash !== RENAME.transaction.hash) return tx;
        const broken = copy(tx);
        delete (broken as { execution_outcome?: unknown }).execution_outcome;
        return broken;
      });
    const r = ran(await pass(vault, source));
    expect(r.stuck).toEqual([expect.objectContaining({ hash: RENAME.transaction.hash, reason: expect.stringMatching(/^cannot read it/) })]);
    expect(await count("vault_tx", vault)).toBe(1);
  });

  it("a portfolio named with U+0000 goes in; call arguments Postgres refuses are dropped, the transaction kept", async () => {
    const vault = freshVault();
    const tx = copy(RENAME);
    const receipt = vaultReceiptOf(tx);
    receipt.execution_outcome.outcome.logs = [
      `EVENT_JSON:{"standard":"intentfolio-vault","version":"2.0.0","event":"portfolio_renamed","data":[{"account_id":"pablofork.near","portfolio_id":"p_000000000000","name":"a\\u0000b"}]}`,
    ];
    // Over `vault_call_args_shape`'s 256 KiB: valid JSON, so only the database can refuse it.
    const action = receipt.receipt!.receipt!.Action!.actions![0].FunctionCall as { args: string };
    action.args = Buffer.from(JSON.stringify({ junk: "x".repeat(300_000) })).toString("base64");

    const r = ran(await pass(vault, fakeFastNear([[tx]], vault)));
    expect(r).toMatchObject({ recordedTxs: 1, stuck: [], ok: false });
    expect(r.droppedCalls).toEqual([expect.stringMatching(/commit_portfolio_changes: 23514/)]);
    const name = await owner.query("SELECT raw #>> '{data,0,name}' AS name FROM vault_event WHERE vault_id = $1", [vault]);
    expect(name.rows[0].name).toBe("a�b");
    expect(await count("vault_call", vault)).toBe(0);
    expect((await cursorOf(vault)).last_error).toMatch(/call argument/);
  });

  // ── The initial load ──────────────────────────────────────────────────────────────────

  it("the initial load resumes across passes and does not advance past a page it could not finish", async () => {
    const vault = freshVault();
    const pages = [[REBALANCE], [DELETE, COMMIT_WITHDRAW], [RENAME, CREATE_FIRST]];
    const t0 = tsOf(REBALANCE) + 3 * HOUR;
    const at = (t: number) => ({ now: () => t });

    // First pass ever: page 1 only, then out of budget before the load starts.
    let r = ran(await pass(vault, fakeFastNear(pages, vault, { head: t0 }), { ...at(t0), budgetMs: -1 }));
    expect(r).toMatchObject({ recordedTxs: 1, stoppedBy: "budget", backfillDone: false, liveComplete: true });
    expect(await cursorOf(vault)).toMatchObject({ backfill_resume: "1", backfill_done: false });
    expect((await cursorOf(vault)).last_error).toMatch(/in the initial load/);

    // Page 2 has a transaction FastNEAR does not serve: held, the resume point stays.
    await unpace(vault);
    const unserved = new Set([COMMIT_WITHDRAW.transaction.hash]);
    r = ran(await pass(vault, fakeFastNear(pages, vault, { head: t0 + HOUR, unserved }), at(t0 + HOUR)));
    expect(r.backfillDone).toBe(false);
    let cursor = await cursorOf(vault);
    expect(cursor.backfill_resume).toBe("1");
    expect(cursor.last_error).toMatch(/initial load held at a page/);

    // A pass with no budget left for the load keeps that error instead of wiping it.
    await unpace(vault);
    ran(await pass(vault, fakeFastNear(pages, vault, { head: t0 + 2 * HOUR }), { ...at(t0 + 2 * HOUR), budgetMs: -1 }));
    expect((await cursorOf(vault)).last_error).toMatch(/initial load|time budget/);

    // Served again: the load runs to the end and the error clears.
    await unpace(vault);
    r = ran(await pass(vault, fakeFastNear(pages, vault, { head: t0 + 3 * HOUR }), at(t0 + 3 * HOUR)));
    expect(r).toMatchObject({ ok: true, backfillDone: true, stuck: [] });
    cursor = await cursorOf(vault);
    expect(cursor.backfill_done).toBe(true);
    expect(cursor.last_error).toBeNull();
    expect(await count("vault_tx", vault)).toBe(5);
    expect(await count("vault_event", vault)).toBe(9);
  });

  // ── Prices ────────────────────────────────────────────────────────────────────────────

  it("no price: the spread is kept unpriced; valued days later: marked as such", async () => {
    const noPrice = freshVault();
    ran(await pass(noPrice, fakeFastNear([[REBALANCE]], noPrice), { prices: async () => Promise.reject(new Error("down")) }));
    expect(await dailyOf(noPrice)).toEqual([
      expect.objectContaining({ spread: "593", spread_usd: "0", spread_unpriced: "593", usd_from_backfill: false }),
    ]);

    const late = freshVault();
    const t = tsOf(REBALANCE) + 72 * HOUR;
    ran(await pass(late, fakeFastNear([[REBALANCE]], late, { head: t }), { now: () => t }));
    expect(await dailyOf(late)).toEqual([expect.objectContaining({ spread_usd: "0.000296500000", usd_from_backfill: true })]);
  });
});
