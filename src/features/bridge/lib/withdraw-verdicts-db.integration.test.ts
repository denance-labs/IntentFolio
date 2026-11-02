// @vitest-environment node
//
// Proves the query in `withdraw-verdicts-service.ts` reads what the solver writes into
// `withdraw_verdict` (`intentfolio-solver/db/migrations/006_withdraw_record.sql`), through the
// same pooled port and writer role as production. The verdicts are inserted as the LOCAL owner:
// the frontend's role must not be able to write them at all.
//
//   cd ../intentfolio-solver && docker compose -f db/local/docker-compose.yml up -d
//   npm run test:ops-db
//
// SKIPPED unless both URLs are set, so `npm test` stays hermetic. Both tables are append-only,
// so every case uses a fresh record instead of cleaning up.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { createPoolConfig, readOpsDbConfig, type Queryable } from "@/features/vault/lib/ops-records-service";
import { handleCreateRecord } from "./withdraw-records-service";
import { handleWithdrawVerdicts } from "./withdraw-verdicts-service";

const WRITER_URL = process.env.INTENTFOLIO_OPS_DB_URL;
const OWNER_URL = process.env.INTENTFOLIO_OPS_DB_TEST_OWNER_URL;
const suite = WRITER_URL && OWNER_URL ? describe : describe.skip;

const allow = { check: () => true };
const NEAR_TX = "9xKcXGhT2qWvbnLmRtYpZsAeDfGhJkLmNoPqRsTuVwXy";
const DEST_TX = "0x5a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9";

suite("withdraw_verdict — the returning user's read, against a real Postgres 16", () => {
  let writer: Pool;
  let owner: Pool;
  let db: Queryable;

  beforeAll(() => {
    const config = readOpsDbConfig(process.env);
    if (!config.ok) throw new Error(config.issues.join(", "));
    writer = new Pool(createPoolConfig(config.config));
    db = writer as unknown as Queryable;
    owner = new Pool({ connectionString: OWNER_URL });
  });

  afterAll(async () => {
    await writer?.end();
    await owner?.end();
  });

  /** A fresh record, written the way the browser writes it (the verdict's foreign key needs it). */
  async function freshRecord(): Promise<string> {
    const id = randomUUID();
    const res = await handleCreateRecord({
      body: {
        id,
        kind: "direct",
        signerId: "alice.near",
        tokenId: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
        amount: "1000000",
        chainId: "eth:1",
        route: "omft",
        destinationAddress: "0x000000000000000000000000000000000000dEaD",
        nonce: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
        deadline: Date.now() + 600_000,
        signedPayload: { standard: "nep413", payload: { message: "{}", nonce: "BwcH" }, signature: "ed25519:sig" },
        createdAt: Date.now(),
      },
      callerKey: "it",
      db,
      limiter: allow,
      log: () => {},
    });
    if (!res.body.ok) throw new Error(`seed record failed: ${JSON.stringify(res.body)}`);
    return id;
  }

  async function verdict(id: string, kind: string, detail: Record<string, unknown> = {}) {
    await owner.query("INSERT INTO withdraw_verdict (record_id, verdict, detail) VALUES ($1, $2, $3::jsonb)", [
      id,
      kind,
      JSON.stringify({ tx: null, destinationTx: null, block: null, checks: [], ...detail }),
    ]);
  }

  const read = (ids: string[]) => handleWithdrawVerdicts({ body: { ids }, callerKey: "it", db, limiter: allow });

  it("answers the final verdict with its hashes, next to the intermediate ones it ignores", async () => {
    const id = await freshRecord();
    await verdict(id, "settled", { tx: NEAR_TX });
    await verdict(id, "escalated_e1", { tx: NEAR_TX });
    await verdict(id, "delivered", { tx: NEAR_TX, destinationTx: DEST_TX });

    expect((await read([id])).body).toEqual({
      ok: true,
      verdicts: { [id]: { verdict: "delivered", txHash: NEAR_TX, destinationTxHash: DEST_TX } },
    });
  });

  it("answers nothing for a record with no final verdict, or no record at all", async () => {
    const id = await freshRecord();
    await verdict(id, "settled", { tx: NEAR_TX });
    expect((await read([id, randomUUID()])).body).toEqual({ ok: true, verdicts: {} });
  });

  it("reads never_executed and refunded without hashes", async () => {
    const a = await freshRecord();
    const b = await freshRecord();
    await verdict(a, "never_executed", { block: 123 });
    await verdict(b, "refunded");
    expect((await read([a, b])).body).toEqual({
      ok: true,
      verdicts: { [a]: { verdict: "never_executed" }, [b]: { verdict: "refunded" } },
    });
  });

  it("the frontend's role cannot write a verdict", async () => {
    const id = await freshRecord();
    await expect(
      writer.query("INSERT INTO withdraw_verdict (record_id, verdict, detail) VALUES ($1, 'delivered', '{}')", [id])
    ).rejects.toThrow(/permission denied/);
  });
});
