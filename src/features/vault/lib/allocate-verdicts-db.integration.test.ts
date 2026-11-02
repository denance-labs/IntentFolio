// @vitest-environment node
//
// Proves the query in `allocate-verdicts-service.ts` reads what the solver writes
// (`intentfolio-solver/db/migrations/005_allocate_rescue_verdict.sql`), through the same pooled
// port and writer role as production. The verdicts are inserted as the LOCAL owner: the solver's
// role has INSERT only, and the frontend's role must not be able to write them at all.
//
//   cd ../intentfolio-solver && docker compose -f db/local/docker-compose.yml up -d
//   npm run test:ops-db
//
// SKIPPED unless both URLs are set, so `npm test` stays hermetic. Both tables are append-only,
// so every case uses a fresh record instead of cleaning up.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { createPoolConfig, handleCreateRecord, readOpsDbConfig, type Queryable } from "./ops-records-service";
import { handleAllocateVerdicts } from "./allocate-verdicts-service";

const WRITER_URL = process.env.INTENTFOLIO_OPS_DB_URL;
const OWNER_URL = process.env.INTENTFOLIO_OPS_DB_TEST_OWNER_URL;
const suite = WRITER_URL && OWNER_URL ? describe : describe.skip;

const allow = { check: () => true };

suite("allocate_rescue_verdict — the pending notice's read, against a real Postgres 16", () => {
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
        signerId: "alice.near",
        msg: `{"nonce":"${id}"}`,
        vaultId: "intentfolio-vault.near",
        portfolioName: "Balanced",
        legs: [{ tokenId: "nep141:wrap.near", amount: "1" }],
        createdAt: Date.now(),
      },
      callerKey: "it",
      db,
      limiter: allow,
      log: () => {},
    });
    expect(res.status).toBe(200);
    return id;
  }

  async function verdict(id: string, kind: string) {
    await owner.query(
      "INSERT INTO allocate_rescue_verdict (record_id, verdict, detail) VALUES ($1, $2, $3::jsonb)",
      [id, kind, JSON.stringify({ block: 1, tx: null, checks: [] })]
    );
  }

  const read = (ids: string[]) => handleAllocateVerdicts({ body: { ids }, callerKey: "it", db, limiter: allow });

  it("a record with no verdict is absent — not decided yet", async () => {
    const id = await freshRecord();
    expect((await read([id])).body).toEqual({ ok: true, verdicts: {} });
  });

  it("reads each verdict for its own record only", async () => {
    const [a, b, c] = [await freshRecord(), await freshRecord(), await freshRecord()];
    await verdict(a, "never_executed");
    await verdict(b, "orphan_escalated");
    expect((await read([a, b, c])).body).toEqual({
      ok: true,
      verdicts: { [a]: "never_executed", [b]: "orphan_escalated" },
    });
  });

  it("credited wins over the negative the database lets sit next to it", async () => {
    const id = await freshRecord();
    await verdict(id, "orphan_escalated");
    await verdict(id, "credited");
    expect((await read([id])).body).toEqual({ ok: true, verdicts: { [id]: "credited" } });
  });

  it("matches an id sent in upper case", async () => {
    const id = await freshRecord();
    await verdict(id, "credited");
    expect((await read([id.toUpperCase()])).body).toEqual({ ok: true, verdicts: { [id]: "credited" } });
  });

  it("the frontend's role cannot write a verdict", async () => {
    const id = await freshRecord();
    await expect(
      db.query("INSERT INTO allocate_rescue_verdict (record_id, verdict, detail) VALUES ($1, 'credited', '{}')", [id])
    ).rejects.toThrow(/permission denied/);
  });
});
