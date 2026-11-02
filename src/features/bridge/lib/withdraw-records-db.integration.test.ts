// @vitest-environment node
//
// Proves the SQL in `withdraw-records-service.ts` matches the DDL the solver owns
// (`intentfolio-solver/db/migrations/006_withdraw_record.sql`). The unit tests check the
// statements against a stub; only a real Postgres says whether it accepts them.
//
// Same stack and same POOLED port as `ops-records-db.integration.test.ts` — the
// transaction-mode PgBouncer the writer uses in production.
//
//   cd ../intentfolio-solver && docker compose -f db/local/docker-compose.yml up -d
//   npm run test:ops-db
//
// SKIPPED when `INTENTFOLIO_OPS_DB_URL` is unset, so `npm test` stays hermetic.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import {
  createPoolConfig,
  readOpsDbConfig,
  type Queryable,
} from "@/features/vault/lib/ops-records-service";
import { handleCreateRecord, handlePatchRecord } from "./withdraw-records-service";

const CONNECTION_STRING = process.env.INTENTFOLIO_OPS_DB_URL;
const suite = CONNECTION_STRING ? describe : describe.skip;

const allow = { check: () => true };
const noLog = () => {};

suite("withdraw_record — against a real Postgres 16 through the pooler", () => {
  let pool: Pool;
  let db: Queryable;

  beforeAll(() => {
    const config = readOpsDbConfig(process.env);
    if (!config.ok) throw new Error(config.issues.join(", "));
    pool = new Pool(createPoolConfig(config.config));
    db = pool as unknown as Queryable;
  });

  afterAll(async () => {
    await pool?.end();
  });

  function direct(over: Record<string, unknown> = {}) {
    return {
      id: randomUUID(),
      kind: "direct",
      signerId: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      tokenId: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
      // Past Number.MAX_SAFE_INTEGER on purpose: it must arrive as the same digits.
      amount: "1000000000000000000000001",
      chainId: "eth:1",
      route: "omft",
      destinationAddress: "0x000000000000000000000000000000000000dEaD",
      destinationMemo: "memo-1",
      nonce: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
      deadline: Date.parse("2026-10-09T12:10:00Z"),
      signedPayload: { standard: "nep413", payload: { message: "{}", nonce: "BwcH" }, signature: "ed25519:sig" },
      createdAt: Date.parse("2026-10-09T12:00:00Z"),
      ...over,
    };
  }

  const call = (fn: typeof handleCreateRecord, body: unknown) =>
    fn({ body, callerKey: "it", db, limiter: allow, log: noLog });

  it("stores a direct withdrawal exactly as sent", async () => {
    const record = direct();
    const result = await call(handleCreateRecord, record);
    expect(result).toEqual({ status: 200, body: { ok: true, id: record.id, created: true } });

    const { rows } = await db.query<Record<string, unknown>>(
      `SELECT kind, amount, route, destination_memo, status, conversion, signed_payload,
              deadline = to_timestamp($2::double precision / 1000) AS deadline_ok
         FROM withdraw_record WHERE id = $1`,
      [record.id, record.deadline]
    );
    expect(rows[0]).toEqual({
      kind: "direct",
      amount: "1000000000000000000000001",
      route: "omft",
      destination_memo: "memo-1",
      status: "publishing",
      conversion: null,
      signed_payload: record.signedPayload,
      deadline_ok: true,
    });
  });

  it("stores a conversion with its quote, which the shape CHECK accepts", async () => {
    const quote = {
      depositAddress: "0x1111111111111111111111111111111111111111",
      deliveryTokenId: "nep141:eth.bridge.near",
      amountOut: "990000",
      minAmountOut: "980000",
      requestedDeadlineMs: 1_760_011_800_000,
      quoteSignature: "ed25519:abc",
    };
    const record = direct({ kind: "conversion", route: undefined, chainId: "near:mainnet", conversion: quote });
    expect((await call(handleCreateRecord, record)).status).toBe(200);

    const { rows } = await db.query<{ conversion: unknown; route: unknown }>(
      "SELECT conversion, route FROM withdraw_record WHERE id = $1",
      [record.id]
    );
    expect(rows[0]).toEqual({ conversion: quote, route: null });
  });

  it("turns a retried POST into a no-op", async () => {
    const record = direct();
    await call(handleCreateRecord, record);
    const again = await call(handleCreateRecord, record);
    expect(again.body).toEqual({ ok: true, id: record.id, created: false });
  });

  it("advances every lifecycle hint the grant allows", async () => {
    const record = direct();
    await call(handleCreateRecord, record);

    const result = await call(handlePatchRecord, {
      id: record.id,
      status: "delivered",
      intentHash: "ih",
      txHash: "Gx1",
      destinationTxHash: "0xdest",
      error: "none",
    });
    expect(result.status).toBe(200);

    const { rows } = await db.query<Record<string, unknown>>(
      "SELECT status, intent_hash, tx_hash, destination_tx_hash, error FROM withdraw_record WHERE id = $1",
      [record.id]
    );
    expect(rows[0]).toEqual({
      status: "delivered",
      intent_hash: "ih",
      tx_hash: "Gx1",
      destination_tx_hash: "0xdest",
      error: "none",
    });
  });

  it("answers 404 for a record the table never received", async () => {
    const result = await call(handlePatchRecord, { id: randomUUID(), status: "settled" });
    expect(result.status).toBe(404);
  });

  it("can read the verdict table the solver writes — the grant 024-D will rely on", async () => {
    const record = direct();
    await call(handleCreateRecord, record);
    const { rows } = await db.query("SELECT verdict FROM withdraw_verdict WHERE record_id = $1", [record.id]);
    expect(rows).toEqual([]);
  });
});
