// @vitest-environment node
//
// Proves the Evolution read (plan 033-A) against the real schema (`intentfolio-solver/db/
// migrations/008_history.sql`) and the grants of `intentfolio_history_reader`: the recorder writes
// real vault transactions (history-recorder.fixtures.ts) into a fresh vault id, and MOVES_SQL /
// PRICES_SQL read them back through the read-only role.
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
import { runHistoryPass, type FastNearSource } from "./history-recorder";
import type { PriceBook } from "./history-prices";
import { MOVES_SQL, handlePortfolioComposition } from "./portfolio-composition-service";
import { COMMIT_WITHDRAW, CREATE_FIRST, REBALANCE } from "./history-recorder.fixtures";

const WRITER_URL = process.env[HISTORY_WRITER_URL_VAR];
const READER_URL = process.env[HISTORY_READER_URL_VAR];
const OWNER_URL = process.env.INTENTFOLIO_OPS_DB_TEST_OWNER_URL;
const suite = WRITER_URL && READER_URL && OWNER_URL ? describe : describe.skip;

const REAL_VAULT = "intentfolio-vault.near";
const USDT = "nep141:usdt.tether-token.near";
const WNEAR = "nep141:wrap.near";
const HOUR = 60 * 60 * 1000;
const PRICES: PriceBook = new Map([[USDT, { priceText: "0.5", decimals: 6 }]]);

const tsOf = (tx: FastNearTx) => Math.floor(tx.execution_outcome.block_timestamp / 1e6);
const dayOf = (tx: FastNearTx) => new Date(tsOf(tx)).toISOString().slice(0, 10);
const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 24 * HOUR).toISOString().slice(0, 10);
const T1 = tsOf(REBALANCE) + HOUR;

function readdress(tx: FastNearTx, vault: string): FastNearTx {
  return JSON.parse(JSON.stringify(tx).split(`"executor_id":"${REAL_VAULT}"`).join(`"executor_id":"${vault}"`));
}

/** FastNEAR serving one page with these transactions, as `vault` would have produced them. */
function source(vault: string, txs: FastNearTx[]): FastNearSource {
  const served = txs.map((tx) => readdress(tx, vault)).sort((a, b) => tsOf(b) - tsOf(a));
  const rows: AccountTxRow[] = served.map((tx) => ({
    hash: tx.transaction.hash,
    blockHeight: tx.execution_outcome.block_height!,
    blockTsMs: tsOf(tx),
  }));
  return {
    indexedHeadMs: async () => T1,
    listPage: async () => ({ rows, resumeToken: null }),
    fetchTxs: async (hashes) => served.filter((tx) => hashes.includes(tx.transaction.hash)),
  };
}

suite("portfolio composition — the read against a real Postgres 16, the 008 schema and the reader role", () => {
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

  const record = (vault: string, txs: FastNearTx[]) =>
    runHistoryPass({
      db: writer as unknown as TransactionalQueryable,
      vaultId: vault,
      fastnear: source(vault, txs),
      prices: async () => PRICES,
      now: () => T1,
    });

  const read = (vault: string, portfolioId: string) =>
    handlePortfolioComposition({
      portfolioId,
      vaultId: vault,
      callerKey: "k",
      db: reader as unknown as Queryable,
      limiter: { check: () => true },
      now: () => T1 + 1_000,
    });

  /** Prices are shared by every vault: make sure the day has one, and read back which it kept. */
  async function priceOn(day: string, token: string): Promise<number> {
    await writer.query(
      "INSERT INTO token_price_daily (day, token_id, price_usd, source) VALUES ($1::date, $2, 0.5, 'test') ON CONFLICT DO NOTHING",
      [day, token]
    );
    const { rows } = await owner.query("SELECT price_usd::text AS p FROM token_price_daily WHERE day = $1::date AND token_id = $2", [
      day,
      token,
    ]);
    return Number(rows[0].p);
  }

  it("an allocation shows from the next day on, valued at that day's price", async () => {
    const vault = freshVault();
    expect(await record(vault, [CREATE_FIRST])).toMatchObject({ ran: true, ok: true });
    const first = nextDay(dayOf(CREATE_FIRST));
    const kept = await priceOn(first, USDT);

    const out = await read(vault, "p_000000000000");
    expect(out.status).toBe(200);
    if (!out.body.ok) throw new Error("read failed");
    expect(out.body).toMatchObject({ recordedUntil: T1, upToDate: true, loading: false });
    expect(out.body.days[0].day).toBe(first);
    expect(out.body.days[0].tokens).toHaveLength(1);
    expect(out.body.days[0].tokens[0].tokenId).toBe(USDT);
    expect(out.body.days[0].tokens[0].usd).toBeCloseTo(2.457698 * kept, 12);
    // Every later priced day holds the same and only that.
    for (const day of out.body.days) expect(day.tokens.map((t) => t.tokenId)).toEqual([USDT]);
  });

  it("an allocation withdrawn the same day leaves no day at all", async () => {
    const vault = freshVault();
    await record(vault, [CREATE_FIRST, COMMIT_WITHDRAW]);
    await priceOn(nextDay(dayOf(CREATE_FIRST)), USDT);
    expect((await read(vault, "p_000000000000")).body).toMatchObject({ ok: true, days: [] });
  });

  it("reads both legs of one rebalance row, and a balance below zero is left out, not shown", async () => {
    const vault = freshVault();
    await record(vault, [REBALANCE]);
    const { rows } = await reader.query(MOVES_SQL, [vault, "p_000000000001"]);
    expect(rows).toEqual([
      { token: USDT, day: dayOf(REBALANCE), delta: "-444329" },
      { token: WNEAR, day: dayOf(REBALANCE), delta: "84046287820715792235350" },
    ]);
    // Priced the next day, so only the negative USDT (no allocation in this vault) keeps it out.
    await priceOn(nextDay(dayOf(REBALANCE)), USDT);
    await priceOn(nextDay(dayOf(REBALANCE)), WNEAR);
    expect((await read(vault, "p_000000000001")).body).toMatchObject({ ok: true, days: [] });
  });
});
