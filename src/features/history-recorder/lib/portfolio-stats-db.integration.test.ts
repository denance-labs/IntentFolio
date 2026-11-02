// @vitest-environment node
//
// Proves the Performance read (plan 028-3) against the real schema (`intentfolio-solver/db/
// migrations/008_history.sql`) and the grants of `intentfolio_history_reader`: the recorder
// writes real vault transactions (history-recorder.fixtures.ts) into a fresh vault id, and the
// read sees them through the read-only role.
//
//   cd ../intentfolio-solver && docker compose -f db/local/docker-compose.yml up -d && yarn db:migrate:local
//   npm run test:history-db
//
// SKIPPED unless the three URLs are set, so `npm test` stays hermetic.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { randomBytes } from "node:crypto";
import {
  createPoolConfig,
  readOpsDbConfig,
  type Queryable,
  type TransactionalQueryable,
} from "@/features/vault/lib/ops-records-service";
import { HISTORY_READER_URL_VAR, HISTORY_WRITER_URL_VAR } from "@/features/vault/lib/ops-db-pool";
import type { AccountTxRow, FastNearTx } from "@/features/vault/lib/vault-history-client";
import { runHistoryPass, type FastNearSource, type RecorderDeps } from "./history-recorder";
import type { PriceBook } from "./history-prices";
import { handlePortfolioStats } from "./portfolio-stats-service";
import { createHistoryHealthChecker, HISTORY_BEHIND_MS } from "./history-health";
import { REBALANCE } from "./history-recorder.fixtures";

const WRITER_URL = process.env[HISTORY_WRITER_URL_VAR];
const READER_URL = process.env[HISTORY_READER_URL_VAR];
const OWNER_URL = process.env.INTENTFOLIO_OPS_DB_TEST_OWNER_URL;
const suite = WRITER_URL && READER_URL && OWNER_URL ? describe : describe.skip;

const REAL_VAULT = "intentfolio-vault.near";
const USDT = "nep141:usdt.tether-token.near";
const HOUR = 60 * 60 * 1000;
const PRICES: PriceBook = new Map([[USDT, { priceText: "0.5", decimals: 6 }]]);
/** The one portfolio the fixture's rebalance pays a spread to: 593 base units of USDT. */
const PORTFOLIO = "p_000000000001";

const tsOf = (tx: FastNearTx) => Math.floor(tx.execution_outcome.block_timestamp / 1e6);
const T1 = tsOf(REBALANCE) + HOUR;
const DAY = new Date(tsOf(REBALANCE)).toISOString().slice(0, 10);

function readdress(tx: FastNearTx, vault: string): FastNearTx {
  return JSON.parse(JSON.stringify(tx).split(`"executor_id":"${REAL_VAULT}"`).join(`"executor_id":"${vault}"`));
}

/** FastNEAR serving one page with the fixture, as `vault` would have produced it. */
function source(vault: string): FastNearSource {
  const tx = readdress(REBALANCE, vault);
  const row: AccountTxRow = { hash: tx.transaction.hash, blockHeight: tx.execution_outcome.block_height!, blockTsMs: tsOf(tx) };
  return {
    indexedHeadMs: async () => T1,
    listPage: async () => ({ rows: [row], resumeToken: null }),
    fetchTxs: async () => [tx],
  };
}

suite("portfolio stats — the read against a real Postgres 16, the 008 schema and the reader role", () => {
  let writer: Pool;
  let reader: Pool;
  let owner: Pool;

  const poolFor = (urlVar: string) => {
    const config = readOpsDbConfig(process.env, urlVar);
    if (!config.ok) throw new Error(config.issues.join(", "));
    return new Pool(createPoolConfig({ ...config.config, maxConnections: 2 }));
  };

  beforeAll(() => {
    writer = poolFor(HISTORY_WRITER_URL_VAR);
    reader = poolFor(HISTORY_READER_URL_VAR);
    owner = new Pool({ connectionString: OWNER_URL });
  });

  afterAll(async () => {
    await writer?.end();
    await reader?.end();
    await owner?.end();
  });

  const freshVault = () => `v${randomBytes(5).toString("hex")}.test.near`;

  const record = (vault: string, over: Partial<RecorderDeps> = {}) =>
    runHistoryPass({
      db: writer as unknown as TransactionalQueryable,
      vaultId: vault,
      fastnear: source(vault),
      prices: async () => PRICES,
      now: () => T1,
      ...over,
    });

  const read = (vault: string, portfolioId = PORTFOLIO) =>
    handlePortfolioStats({
      portfolioId,
      vaultId: vault,
      callerKey: "k",
      db: reader as unknown as Queryable,
      limiter: { check: () => true },
      now: () => T1 + 1_000,
    });

  it("reads a recorded rebalance as the reader: one swap, the spread frozen at the price of the pass", async () => {
    const vault = freshVault();
    expect(await record(vault)).toMatchObject({ ran: true, ok: true, recordedTxs: 1 });

    const out = await read(vault);
    expect(out.status).toBe(200);
    expect(out.body).toEqual({
      ok: true,
      swaps: 1,
      spreadUsd: 0.0002965, // 593 / 1e6 × $0.5
      spreadIsMinimum: false,
      daily: [{ day: DAY, swaps: 1, spreadUsd: 0.0002965 }],
      recordedUntil: T1,
      upToDate: true,
      loading: false,
    });
    expect(out.catchUp).toBe(false);
  });

  it("values spread recorded without a price at the price kept for that day", async () => {
    const vault = freshVault();
    await record(vault, { prices: async () => Promise.reject(new Error("1Click down")) });
    // Prices are shared by every vault: make sure the day has one, and read back which.
    await writer.query(
      "INSERT INTO token_price_daily (day, token_id, price_usd, source) VALUES ($1::date, $2, 0.5, 'test') ON CONFLICT DO NOTHING",
      [DAY, USDT]
    );
    const kept = Number(
      (await owner.query("SELECT price_usd::text AS p FROM token_price_daily WHERE day = $1::date AND token_id = $2", [DAY, USDT]))
        .rows[0].p
    );

    const out = await read(vault);
    expect(out.body).toMatchObject({ ok: true, swaps: 1, spreadIsMinimum: false });
    if (out.body.ok) expect(out.body.spreadUsd).toBeCloseTo((593 / 1e6) * kept, 12);
  });

  it("another portfolio of the same vault, and the same portfolio of another vault, read nothing", async () => {
    const vault = freshVault();
    await record(vault);
    expect((await read(vault, "p_00000000000f")).body).toMatchObject({ ok: true, swaps: 0, spreadUsd: 0, daily: [] });
    expect((await read(freshVault())).body).toMatchObject({ ok: true, swaps: 0, daily: [], recordedUntil: null, loading: true });
  });

  it("the reader can run the health probe (D-496): recent, behind, never recorded", async () => {
    const vault = freshVault();
    await record(vault);
    const health = (vaultId: string, now: number) =>
      createHistoryHealthChecker({
        resolve: () => ({ ok: true, db: reader as unknown as Queryable }),
        vaultId,
        now: () => now,
        log: () => {},
      }).check();

    await expect(health(vault, T1 + 1_000)).resolves.toMatchObject({ ok: true, recordedUntil: T1 });
    await expect(health(vault, T1 + HISTORY_BEHIND_MS + 1)).resolves.toMatchObject({ ok: false, reason: "behind" });
    await expect(health(freshVault(), T1)).resolves.toMatchObject({ ok: false, reason: "never-recorded" });
  });

  it("the reader can read and nothing else", async () => {
    await expect(
      reader.query("UPDATE history_cursor SET last_error = 'x' WHERE vault_id = $1", [freshVault()])
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      reader.query(
        "INSERT INTO token_price_daily (day, token_id, price_usd, source) VALUES ('2000-01-01', 'x', 1, 'test')"
      )
    ).rejects.toMatchObject({ code: "42501" });
  });
});
