// @vitest-environment node
//
// Proves the account history read (plan 028-7) against the real schema (008 + 009) as the
// reader role, on real mainnet transactions recorded by the account pass:
//   - the events are the ones the browser extracts from the same transactions today
//     (`extractAccountEvents`, the read the route replaces — decision 6 on fixtures);
//   - a page is whole transactions, newest first, and `next` walks every one exactly once;
//   - what paging takes away comes back: names, a rename's previous name, an edit's detail;
//   - a `transfer_out` is a Converting Withdrawal only with a conversion record for that
//     account and address the solver closed (010's view: final verdicts only, the oldest wins);
//   - a first visit follows the account after answering, and `expect` records before it.
//
//   cd ../intentfolio-solver && docker compose -f db/local/docker-compose.yml up -d && yarn db:migrate:local
//   npm run test:history-db
//
// SKIPPED unless the three URLs are set, so `npm test` stays hermetic.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { randomBytes, randomUUID } from "node:crypto";
import { createPoolConfig, readOpsDbConfig, type TransactionalQueryable } from "@/features/vault/lib/ops-records-service";
import { HISTORY_READER_URL_VAR, HISTORY_WRITER_URL_VAR } from "@/features/vault/lib/ops-db-pool";
import type { AccountTxRow, FastNearTx } from "@/features/vault/lib/vault-history-client";
import {
  ACCOUNT_CONVERSION_EVENT,
  ACCOUNT_STORAGE_COST_EVENT,
  extractAccountEvents,
  type ChainHistoryEvent,
} from "@/features/vault/lib/vault-history";
import { ACCOUNT_TX_CAP, followAccount, recordExpectedTx, runAccountPass } from "./account-recorder";
import type { FastNearSource } from "./history-recorder";
import {
  PAGE_TXS,
  catchUpAccountAfterRead,
  handleAccountHistory,
  type AccountHistoryBody,
  type AccountRecorderFns,
} from "./account-history-service";
import { CREATE_FIRST, DELETE, RENAME } from "./history-recorder.fixtures";
import {
  DEPOSIT,
  EDIT,
  EDIT_ALLOCATE_INTO,
  FAILED_TRANSFER,
  RECEIVED_WITHDRAWAL,
  TRANSFER_HEX,
  UNALLOCATE,
  WITHDRAWAL,
} from "./account-history.fixtures";

const WRITER_URL = process.env[HISTORY_WRITER_URL_VAR];
const READER_URL = process.env[HISTORY_READER_URL_VAR];
const OWNER_URL = process.env.INTENTFOLIO_OPS_DB_TEST_OWNER_URL;
const suite = WRITER_URL && READER_URL && OWNER_URL ? describe : describe.skip;

const NEAR = "pablofork.near";
const REAL_VAULT = "intentfolio-vault.near";
const tsOf = (tx: FastNearTx) => Math.floor(tx.execution_outcome.block_timestamp / 1e6);
const FIXTURES = [CREATE_FIRST, RENAME, DELETE, UNALLOCATE, DEPOSIT, WITHDRAWAL, TRANSFER_HEX, RECEIVED_WITHDRAWAL, FAILED_TRANSFER, EDIT, EDIT_ALLOCATE_INTO];
const T1 = Math.max(...FIXTURES.map(tsOf)) + 60_000;
const tag = () => randomBytes(4).toString("hex");

/** The fixture as another account's and another vault's: account, vault, hash and receipt ids replaced everywhere. */
function rekey(tx: FastNearTx, swaps: Record<string, string>, suffix: string): FastNearTx {
  let json = JSON.stringify(tx);
  const ids = [tx.transaction.hash, ...tx.receipts.map((r) => r.execution_outcome.id!)];
  for (const id of ids) json = json.split(`"${id}"`).join(`"${id.slice(0, 50)}${suffix}"`);
  for (const [from, to] of Object.entries(swaps)) json = json.split(from).join(to);
  return JSON.parse(json) as FastNearTx;
}

const rowOf = (tx: FastNearTx): AccountTxRow => ({ hash: tx.transaction.hash, blockHeight: tx.execution_outcome.block_height!, blockTsMs: tsOf(tx) });

/** FastNEAR with one page listing `txs`, newest first. */
function fakeFastNear(txs: FastNearTx[]): FastNearSource {
  const byHash = new Map(txs.map((t) => [t.transaction.hash, t]));
  return {
    indexedHeadMs: async () => T1,
    listPage: async () => ({ rows: [...txs].sort((a, b) => tsOf(b) - tsOf(a)).map(rowOf), resumeToken: null }),
    fetchTxs: async (hashes) => hashes.flatMap((h) => (byHash.has(h) ? [byHash.get(h)!] : [])),
  };
}

/** `(tx, event, data)` with the data's keys sorted: jsonb does not keep their order. */
const keyOf = (e: ChainHistoryEvent) => `${e.txHash}|${e.ts}|${e.event}|${JSON.stringify(e.data, Object.keys(e.data).sort())}`;

suite("account history read — against a real Postgres 16, as the reader role", () => {
  let writer: Pool;
  let reader: Pool;
  let owner: Pool;
  let wdb: TransactionalQueryable;

  beforeAll(() => {
    const w = readOpsDbConfig(process.env, HISTORY_WRITER_URL_VAR);
    const r = readOpsDbConfig(process.env, HISTORY_READER_URL_VAR);
    if (!w.ok || !r.ok) throw new Error("history database URLs are not readable");
    writer = new Pool(createPoolConfig({ ...w.config, maxConnections: 4 }));
    reader = new Pool(createPoolConfig({ ...r.config, maxConnections: 1 }));
    owner = new Pool({ connectionString: OWNER_URL });
    wdb = writer as unknown as TransactionalQueryable;
  });

  afterAll(async () => {
    await writer?.end();
    await reader?.end();
    await owner?.end();
  });

  /** A new account and vault, the fixtures re-keyed to them. */
  const newCase = () => {
    const account = `u${tag()}.test.near`;
    const vault = `v${tag()}.test.near`;
    const suffix = tag();
    const swaps = { [NEAR]: account, [`"executor_id":"${REAL_VAULT}"`]: `"executor_id":"${vault}"` };
    return { account, vault, txs: FIXTURES.map((tx) => rekey(tx, swaps, suffix)) };
  };

  const recorderFor = (txs: FastNearTx[]): AccountRecorderFns => ({
    // The hourly cap is decision 9's own test (account-recorder-db): every run of these suites
    // follows dozens of accounts, so the real 60 would fail a second run within the hour.
    follow: (db, accountId, options) => followAccount(db, accountId, { ...options, perHour: Number.MAX_SAFE_INTEGER }),
    runPass: (deps) => runAccountPass({ ...deps, fastnear: fakeFastNear(txs), now: () => T1 }),
    expectTx: (deps) => recordExpectedTx({ ...deps, fastnear: fakeFastNear(txs) }),
  });

  const read = async (account: string, vault: string, params: Record<string, string> = {}, recorder?: AccountRecorderFns) => {
    const out = await handleAccountHistory({
      query: new URLSearchParams({ account, ...params }),
      vaultId: vault,
      callerKey: "test",
      reader,
      writer: () => ({ ok: true, db: wdb }),
      limiter: { check: () => true },
      now: () => T1,
      recorder,
    });
    return out;
  };
  const ok = (body: AccountHistoryBody) => {
    if (!body.ok) throw new Error(`expected ok, got ${body.code}: ${body.error}`);
    return body;
  };

  const recorded = async (txs: FastNearTx[], account: string, vault: string) => {
    expect(await followAccount(wdb, account, { capped: false })).toBe("followed");
    const r = await runAccountPass({ db: wdb, accountId: account, vaultId: vault, fastnear: fakeFastNear(txs), now: () => T1 });
    expect(r).toMatchObject({ ran: true, ok: true, backfillDone: true });
  };

  it("the same events the browser extracts from the same transactions (decision 6 on fixtures)", async () => {
    const { account, vault, txs } = newCase();
    await recorded(txs, account, vault);
    const body = ok((await read(account, vault)).body);

    const browser = txs.flatMap((tx) => extractAccountEvents(tx, { vaultId: vault, accountId: account }));
    expect(browser.length).toBeGreaterThan(8);
    expect(body.events.map(keyOf).sort()).toEqual(browser.map(keyOf).sort());
    // Newest transaction first, each one's events together.
    const order = [...new Set(body.events.map((e) => e.txHash))];
    const firstTs = order.map((h) => Math.min(...body.events.filter((e) => e.txHash === h).map((e) => e.ts)));
    expect(firstTs).toEqual([...firstTs].sort((a, b) => b - a));
    expect(body).toMatchObject({ next: null, loading: false, unavailable: false, recordedUntil: T1, upToDate: true });
  });

  it("names, a rename's previous name and each edit's signed detail", async () => {
    const { account, vault, txs } = newCase();
    await recorded(txs, account, vault);
    const body = ok((await read(account, vault)).body);
    expect(body.names).toEqual({ p_000000000000: "AgrRenamed" });
    expect(body.events.find((e) => e.event === "portfolio_renamed")).toMatchObject({ previousName: "Aggressive", data: { name: "AgrRenamed" } });
    const edits = body.events.filter((e) => e.event === "portfolio_composition_changed");
    expect(edits).toHaveLength(2);
    expect(edits.find((e) => e.txHash.startsWith(EDIT.transaction.hash.slice(0, 40)))?.edit).toEqual({
      targets: [
        { token: "nep141:meta-pool.near", bps: 3950, toleranceBps: 2000 },
        { token: "nep141:usdt.tether-token.near", bps: 2350, toleranceBps: 2000 },
      ],
      added: [{ token: "nep141:wrap.near", bps: 3700, toleranceBps: 1000 }],
      removed: [],
    });
    expect(edits.find((e) => e.txHash.startsWith(EDIT_ALLOCATE_INTO.transaction.hash.slice(0, 40)))?.edit?.added.length).toBeGreaterThan(0);
    // D-530: p_000000000001's Setup is not recorded here, so no edit can know what it replaced.
    expect(edits.map((e) => e.before)).toEqual([null, null]);
  });

  it("`portfolio=`: that portfolio's History kinds only — no renames, deletions or movements", async () => {
    const { account, vault, txs } = newCase();
    await recorded(txs, account, vault);
    const body = ok((await read(account, vault, { portfolio: "p_000000000001" })).body);
    expect(new Set(body.events.map((e) => e.event))).toEqual(new Set(["portfolio_composition_changed", "allocate"]));
    expect(body.events.every((e) => e.data.portfolio_id === "p_000000000001")).toBe(true);
    const zero = ok((await read(account, vault, { portfolio: "p_000000000000" })).body);
    expect(new Set(zero.events.map((e) => e.event))).toEqual(new Set(["portfolio_created", "allocate", "unallocate"]));
  });

  // D-539: the Setup's `transfer` to the ops account with memo `storage`, next to its creation —
  // in the account's feed and in that portfolio's History; a lookalike to anyone else never.
  it("a Setup's Storage Cost: with its creation, in the feed and in the portfolio's History; only to the ops account with memo `storage`", async () => {
    const { account, vault, txs } = newCase();
    await recorded(txs, account, vault);
    const {
      rows: [setup],
    } = await owner.query<{ tx_hash: string; block_height: string; block_ts: Date }>(
      `SELECT tx_hash, block_height, block_ts FROM vault_event
        WHERE vault_id = $1 AND account_id = $2 AND event = 'portfolio_created' AND raw #>> '{data,0,portfolio_id}' = 'p_000000000000'`,
      [vault, account]
    );
    // On chain the `transfer` lands a block before the vault's `portfolio_created` (tx `EYJiFGF…b3Au`:
    // ~0.3 s earlier) — older than the last key of a portfolio's History page.
    const height = String(BigInt(setup.block_height) - BigInt(1));
    const at = new Date(setup.block_ts.getTime() - 331);
    const transfer = async (receiver: string, memo: string, logIndex: number) => {
      const receipt = `rs${tag()}`;
      const line = `EVENT_JSON:${JSON.stringify({ standard: "dip4", event: "transfer", data: [] })}`;
      await owner.query(
        `INSERT INTO intents_event (receipt_id, log_index, tx_hash, block_height, block_ts, standard, event, line)
         VALUES ($1, $2, $3, $4, $5, 'dip4', 'transfer', $6)`,
        [receipt, logIndex, setup.tx_hash, height, at, line]
      );
      await owner.query(
        `INSERT INTO account_movement (account_id, receipt_id, log_index, entry_index, token_index, kind, token_id, amount,
                                       counterparty, memo, tx_hash, block_height, block_ts)
         VALUES ($1, $2, $3, 0, 0, 'transfer_out', 'nep141:eth.omft.near', 30957572709894, $4, $5, $6, $7, $8)`,
        [account, receipt, logIndex, receiver, memo, setup.tx_hash, height, at]
      );
    };
    await transfer("intentfolio-budget.near", "storage", 0);
    await transfer("someone-else.near", "storage", 1);
    await transfer("intentfolio-budget.near", "gift", 2);

    const costs = (body: AccountHistoryBody) =>
      ok(body).events.filter((e) => e.event === ACCOUNT_STORAGE_COST_EVENT).map((e) => [e.txHash, e.data]);
    const expected = [[setup.tx_hash, { account_id: account, token: "nep141:eth.omft.near", amount: "30957572709894" }]];
    expect(costs((await read(account, vault)).body)).toEqual(expected);
    expect(costs((await read(account, vault, { portfolio: "p_000000000000" })).body)).toEqual(expected);
    // Another portfolio's History: its transactions never hold that Setup.
    expect(costs((await read(account, vault, { portfolio: "p_000000000001" })).body)).toEqual([]);
  });

  it("a Converting Withdrawal: only with a record for that account and address the solver closed; the oldest closed one wins", async () => {
    // TRANSFER_HEX: the account signs a `transfer` of nBTC to this 64-hex 1Click deposit address.
    const DEPOSIT_ADDRESS = "b3d8e1c1307a4cc180501e170a7bef826380917cd0c4453d937b2ba3085428aa";
    const { account, vault, txs } = newCase();
    await recorded(txs, account, vault);
    const conversions = async () =>
      ok((await read(account, vault)).body).events.filter((e) => e.event === ACCOUNT_CONVERSION_EVENT);

    // No record: a send to a 64-hex account like any other — not shown, as before 028-8.
    expect(await conversions()).toEqual([]);

    const insertRecord = async (signer: string, destination: string, receivedAt: string) => {
      const id = randomUUID();
      await owner.query(
        `INSERT INTO withdraw_record (id, kind, signer_id, token_id, amount, chain_id, destination_address,
                                      nonce, deadline, signed_payload, conversion, created_at, received_at)
         VALUES ($1, 'conversion', $2, 'nep141:nbtc.bridge.near', '14170', 'btc:mainnet', $3,
                 'nonce', now() + interval '1 hour', '{}'::jsonb, $4::jsonb, $5::timestamptz, $5::timestamptz)`,
        [id, signer, destination, JSON.stringify({ depositAddress: DEPOSIT_ADDRESS, deliveryTokenId: "nep141:btc.omft.near", amountOut: "14000", minAmountOut: "13900", requestedDeadlineMs: 0, quoteSignature: "sig" }), receivedAt]
      );
      return id;
    };
    const verdict = (id: string, v: string, destinationTx: string | null) =>
      owner.query(`INSERT INTO withdraw_verdict (record_id, verdict, detail) VALUES ($1, $2, $3::jsonb)`, [
        id,
        v,
        JSON.stringify({ tx: null, destinationTx, block: null, checks: [] }),
      ]);

    // Another account's closed record for the same address matches nothing here.
    await verdict(await insertRecord(`x${tag()}.test.near`, "bc1qother", "2026-10-15T00:00:00Z"), "delivered", "other-tx");
    expect(await conversions()).toEqual([]);

    // Open records are not shown (anyone can POST one): `settled` is a fact, not an outcome.
    const genuine = await insertRecord(account, "bc1qgenuine", "2026-10-15T00:00:01Z");
    const later = await insertRecord(account, "bc1qlater", "2026-10-15T00:00:02Z");
    await verdict(genuine, "settled", null);
    expect(await conversions()).toEqual([]);

    await verdict(genuine, "delivered", "btc-destination-tx");
    const expected = {
      txHash: txs[FIXTURES.indexOf(TRANSFER_HEX)].transaction.hash,
      data: {
        account_id: account,
        token: "nep141:nbtc.bridge.near",
        amount: "14170",
        deposit_address: DEPOSIT_ADDRESS,
        chain_id: "btc:mainnet",
        delivery_token: "nep141:btc.omft.near",
        outcome: "delivered",
        destination_tx: "btc-destination-tx",
      },
    };
    expect(await conversions()).toEqual([expect.objectContaining(expected)]);
    // A later record closed too never replaces the first.
    await verdict(later, "refunded", null);
    expect(await conversions()).toEqual([expect.objectContaining(expected)]);

    // A portfolio's History never shows it.
    const portfolio = ok((await read(account, vault, { portfolio: "p_000000000000" })).body);
    expect(portfolio.events.some((e) => e.event === ACCOUNT_CONVERSION_EVENT)).toBe(false);
  });

  it(`pages of ${PAGE_TXS} transactions: \`next\` walks every one once, newest first; a mint with another memo is never shown`, async () => {
    const { account, vault, txs } = newCase();
    await recorded(txs, account, vault);
    // 30 older deposits, one transaction each and ALL IN ONE millisecond (so every page edge
    // falls inside a tie, broken by the hash), and one mint someone made with a memo of their own.
    const base = Math.min(...txs.map(tsOf)) - 3_600_000;
    await owner.query(
      `WITH g AS (SELECT n, $2 || n AS h, date_trunc('milliseconds', to_timestamp($3::bigint / 1000.0)) AS ts
                    FROM generate_series(1, 31) AS n),
            t AS (INSERT INTO account_tx (account_id, tx_hash, block_height, block_ts) SELECT $1, h, 220000000, ts FROM g),
            e AS (INSERT INTO intents_event (receipt_id, log_index, tx_hash, block_height, block_ts, standard, event, line)
                  SELECT 'r' || h, 0, h, 220000000, ts, 'nep245', 'mt_mint', 'EVENT_JSON:{}' FROM g)
       INSERT INTO account_movement (account_id, receipt_id, log_index, entry_index, token_index, kind, token_id, amount,
                                     memo, tx_hash, block_height, block_ts)
       SELECT $1, 'r' || h, 0, 0, 0, 'deposit', 'nep141:wrap.near', n, CASE WHEN n = 31 THEN 'airdrop' ELSE 'deposit' END,
              h, 220000000, ts FROM g`,
      [account, `Syn${tag()}`, base]
    );
    const all = ok((await read(account, vault)).body);
    const seen: string[] = [];
    let before: string | null = null;
    let pages = 0;
    do {
      const body = ok((await read(account, vault, before ? { before } : {})).body);
      const hashes = [...new Set(body.events.map((e) => e.txHash))];
      expect(hashes.length).toBeLessThanOrEqual(PAGE_TXS);
      if (body.next !== null) expect(hashes).toHaveLength(PAGE_TXS);
      seen.push(...hashes);
      before = body.next;
      pages += 1;
    } while (before !== null && pages < 10);
    expect(pages).toBe(Math.ceil(seen.length / PAGE_TXS));
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.filter((h) => h.startsWith("Syn"))).toHaveLength(30);
    expect(seen.slice(0, [...new Set(all.events.map((e) => e.txHash))].length)).toEqual([...new Set(all.events.map((e) => e.txHash))]);
  });

  it("past the cap the history says `unavailable` and starts no pass; an error under the cap does not (decision 8)", async () => {
    const { account, vault, txs } = newCase();
    await recorded(txs, account, vault);
    await owner.query("UPDATE account_cursor SET last_error = 'held at a page' WHERE account_id = $1", [account]);
    expect(await read(account, vault)).toMatchObject({ body: { ok: true, unavailable: false } });

    await owner.query(
      `INSERT INTO account_tx (account_id, tx_hash, block_height, block_ts)
       SELECT $1, 'filler' || g, 220000000, date_trunc('milliseconds', now()) FROM generate_series(1, $2) AS g`,
      [account, ACCOUNT_TX_CAP]
    );
    await owner.query("UPDATE account_cursor SET last_run_at = NULL, last_error = NULL WHERE account_id = $1", [account]);
    const pass = await runAccountPass({ db: wdb, accountId: account, vaultId: vault, fastnear: fakeFastNear(txs), now: () => T1 + 120_000 });
    expect(pass).toMatchObject({ ran: true, stoppedBy: "over-cap" });
    const out = await handleAccountHistory({
      query: new URLSearchParams({ account }),
      vaultId: vault,
      callerKey: "test",
      reader,
      writer: () => ({ ok: true, db: wdb }),
      limiter: { check: () => true },
      // Behind and unpaced: without the cap this read would start a pass.
      now: () => Date.now() + 10 * 60_000,
    });
    expect(out).toMatchObject({ catchUp: null, body: { ok: true, unavailable: true } });
  });

  it("first visit: an answer that says loading, the account followed and loaded after it, then the rows", async () => {
    const { account, vault, txs } = newCase();
    const recorder = recorderFor(txs);
    const first = await read(account, vault, {}, recorder);
    expect(first).toMatchObject({ status: 200, catchUp: "follow", body: { ok: true, loading: true, recordedUntil: null } });
    await catchUpAccountAfterRead({ accountId: account, vaultId: vault, catchUp: "follow", resolveDb: () => ({ ok: true, db: wdb }), recorder });
    const again = await read(account, vault, {}, recorder);
    expect(again).toMatchObject({ catchUp: null, body: { ok: true, loading: false, recordedUntil: T1 } });
    expect(ok(again.body).events.length).toBeGreaterThan(8);
  });

  it("`expect`: the user's transaction is in this very answer", async () => {
    const { account, vault, txs } = newCase();
    const deposit = txs[FIXTURES.indexOf(DEPOSIT)];
    expect(await followAccount(wdb, account, { capped: false })).toBe("followed");
    const res = await read(account, vault, { expect: deposit.transaction.hash }, recorderFor(txs));
    const out = ok(res.body);
    expect(out.expect).toBe("recorded");
    // R1: `expect` handed the pace back as it found it (never run), so the full pass may start.
    expect(res.catchUp).toBe("pass");
    expect(out.events.map((e) => e.txHash)).toEqual([deposit.transaction.hash]);
    expect(out.events[0].event).toBe("intents:deposit");
  });
});
