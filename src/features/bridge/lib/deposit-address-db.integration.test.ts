// @vitest-environment node
//
// Proves Receive's deposit-address route (D-584) against the real schema (013 + 014) as the
// writer role — what the fake table of `deposit-address-service.test.ts` cannot: the SQL itself.
//   - an account never sees another account's set;
//   - with several sets, the oldest is shown, ties broken by `internal_account`;
//   - a set whose internal account is already another account's is never shown;
//   - a new set is stored with 1Click's whole answer, and the writer cannot rewrite it.
//
//   cd ../intentfolio-solver && docker compose -f db/local/docker-compose.yml up -d && yarn db:migrate:local
//   npm run test:history-db
//
// SKIPPED unless the URLs are set, so `npm test` stays hermetic.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Pool } from "pg";
import { randomBytes } from "node:crypto";
import { createOpsRateLimiter, createPoolConfig, readOpsDbConfig, type Queryable } from "@/features/vault/lib/ops-records-service";
import { HISTORY_WRITER_URL_VAR } from "@/features/vault/lib/ops-db-pool";
import { handleDepositAddress } from "./deposit-address-service";

const WRITER_URL = process.env[HISTORY_WRITER_URL_VAR];
const OWNER_URL = process.env.INTENTFOLIO_OPS_DB_TEST_OWNER_URL;
const suite = WRITER_URL && OWNER_URL ? describe : describe.skip;

const hex64 = () => randomBytes(32).toString("hex");
const account = () => `it-${randomBytes(6).toString("hex")}.near`;
const evm = (n: string) => [{ blockchain: "eth", address: `0x${n.padStart(40, "0")}` }];

function answer(recipient: string, internal: string) {
  return {
    correlationId: "c-1",
    signature: "ed25519:it",
    timestamp: "2026-11-15T00:00:00.000Z",
    quote: { depositAddress: internal, chainDepositAddresses: evm("a1"), deadline: "2038-01-04T00:00:00.000Z" },
    quoteRequest: {
      recipient,
      refundTo: recipient,
      recipientType: "INTENTS",
      refundType: "INTENTS",
      depositType: "INTENTS",
      swapType: "ANY_INPUT",
      originAsset: "1cs_v1:any",
      destinationAsset: "1cs_v1:original",
    },
  };
}

suite("deposit-address route against the real schema (013 + 014)", () => {
  let writer: Pool;
  let owner: Pool;

  beforeAll(() => {
    const w = readOpsDbConfig(process.env, HISTORY_WRITER_URL_VAR);
    if (!w.ok) throw new Error(w.issues.join(", "));
    writer = new Pool(createPoolConfig({ ...w.config, maxConnections: 2 }));
    owner = new Pool({ connectionString: OWNER_URL });
  });

  afterAll(async () => {
    await writer?.end();
    await owner?.end();
  });

  const seed = (accountId: string, internal: string, set: unknown, createdAt: string) =>
    owner.query(
      "INSERT INTO account_deposit_address (account_id, internal_account, chain_addresses, created_at) VALUES ($1, $2, $3::jsonb, $4)",
      [accountId, internal, JSON.stringify(set), createdAt]
    );

  const run = (accountId: string, fetchImpl: typeof fetch) =>
    handleDepositAddress({
      query: new URLSearchParams({ account: accountId, chain: "eth:1" }),
      callerKey: "it",
      db: writer as unknown as Queryable,
      partnerKey: "key",
      fetchImpl,
      limiter: createOpsRateLimiter(),
      createLimiter: createOpsRateLimiter(),
      attemptLimiter: createOpsRateLimiter({ maxKeys: 1 }),
      perHour: Number.MAX_SAFE_INTEGER,
    });

  const fetchFor = (recipient: string, internal: string) =>
    vi.fn(async () => new Response(JSON.stringify(answer(recipient, internal)), { status: 201 })) as unknown as typeof fetch;

  it("never shows another account's set, and stores a new one with 1Click's answer", async () => {
    const me = account();
    await seed(account(), hex64(), evm("b0"), "2020-01-01T00:00:00Z");
    const internal = hex64();
    const r = await run(me, fetchFor(me, internal));
    expect(r.body).toEqual({ ok: true, address: evm("a1")[0].address });
    const stored = await owner.query("SELECT account_id, create_response->>'signature' AS sig FROM account_deposit_address WHERE internal_account = $1", [internal]);
    expect(stored.rows).toEqual([{ account_id: me, sig: "ed25519:it" }]);
  });

  it("shows the oldest set, ties broken by internal account", async () => {
    const me = account();
    await seed(me, `b${hex64().slice(1)}`, evm("02"), "2026-01-02T00:00:00Z");
    await seed(me, `f${hex64().slice(1)}`, evm("01"), "2026-01-01T00:00:00Z");
    await seed(me, `0${hex64().slice(1)}`, evm("00"), "2026-01-01T00:00:00Z");
    const fetchImpl = fetchFor(me, hex64());
    expect((await run(me, fetchImpl)).body).toEqual({ ok: true, address: evm("00")[0].address });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never shows a set whose internal account is already another account's", async () => {
    const internal = hex64();
    await seed(account(), internal, evm("c0"), "2020-01-01T00:00:00Z");
    const me = account();
    const r = await run(me, fetchFor(me, internal));
    expect(r).toMatchObject({ status: 503, body: { ok: false } });
  });

  it("does not let the writer rewrite or delete a set", async () => {
    const me = account();
    await seed(me, hex64(), evm("d0"), "2020-01-01T00:00:00Z");
    await expect(writer.query("UPDATE account_deposit_address SET correlation_id = 'x' WHERE account_id = $1", [me])).rejects.toThrow(/permission denied/);
    await expect(writer.query("DELETE FROM account_deposit_address WHERE account_id = $1", [me])).rejects.toThrow(/permission denied/);
  });
});
