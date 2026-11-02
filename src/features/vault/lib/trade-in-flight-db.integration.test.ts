// @vitest-environment node
//
// Proves the query in `trade-in-flight-service.ts` reads what the solver writes
// (`intentfolio-solver/db/migrations/007_portfolio_trade_event.sql`), through the same pooled
// port and writer role as production. The rows are inserted as the LOCAL owner, the only role
// that may set `at` — which is how a test reaches "opened 100 s ago" without waiting.
//
//   cd ../intentfolio-solver && docker compose -f db/local/docker-compose.yml up -d
//   npm run test:ops-db
//
// SKIPPED unless both URLs are set, so `npm test` stays hermetic. The table is append-only, so
// every case uses a fresh portfolio id instead of cleaning up.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { randomBytes } from "node:crypto";
import { createPoolConfig, readOpsDbConfig, type Queryable } from "./ops-records-service";
import { handleTradeInFlight } from "./trade-in-flight-service";

const WRITER_URL = process.env.INTENTFOLIO_OPS_DB_URL;
const OWNER_URL = process.env.INTENTFOLIO_OPS_DB_TEST_OWNER_URL;
const suite = WRITER_URL && OWNER_URL ? describe : describe.skip;

const VAULT = "intentfolio-vault.near";
const allow = { check: () => true };

suite("portfolio_trade_event — the confirm modal's read, against a real Postgres 16", () => {
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

  const freshPortfolio = () => `p_${randomBytes(6).toString("hex")}`;
  const freshQuote = () => randomBytes(16).toString("hex");

  async function event(quote: string, portfolio: string, kind: "opened" | "closed", secondsAgo = 0, vault = VAULT) {
    await owner.query(
      `INSERT INTO portfolio_trade_event (quote_hash, vault_id, portfolio_id, event, at)
       VALUES ($1, $2, $3, $4, now() - make_interval(secs => $5))`,
      [quote, vault, portfolio, kind, secondsAgo]
    );
  }

  const read = (portfolio: string) =>
    handleTradeInFlight({ portfolioId: portfolio, vaultId: VAULT, callerKey: "it", db, limiter: allow });

  it("a portfolio with no events: go ahead", async () => {
    expect((await read(freshPortfolio())).body).toEqual({ ok: true, inFlight: false, remainingMs: 0 });
  });

  it("an open trade 10 s old: in flight for about 80 s more, by the database's clock", async () => {
    const p = freshPortfolio();
    await event(freshQuote(), p, "opened", 10);
    const { body } = await read(p);
    expect(body).toMatchObject({ ok: true, inFlight: true });
    if (body.ok) {
      expect(body.remainingMs).toBeGreaterThan(75_000);
      expect(body.remainingMs).toBeLessThanOrEqual(80_000);
    }
  });

  it("closed for the same quote and portfolio: go ahead", async () => {
    const p = freshPortfolio();
    const q = freshQuote();
    await event(q, p, "opened", 20);
    await event(q, p, "closed", 1);
    expect((await read(p)).body).toMatchObject({ inFlight: false });
  });

  it("another quote's closed, or the same quote closed in another portfolio, does not release this one", async () => {
    const p = freshPortfolio();
    const other = freshPortfolio();
    const q = freshQuote();
    await event(q, p, "opened", 5);
    await event(q, other, "opened", 5);
    await event(q, other, "closed", 1);
    await event(freshQuote(), p, "closed", 1);
    expect((await read(p)).body).toMatchObject({ inFlight: true });
  });

  it("past the 90 s cap, an unclosed trade no longer holds anyone", async () => {
    const p = freshPortfolio();
    await event(freshQuote(), p, "opened", 100);
    expect((await read(p)).body).toMatchObject({ inFlight: false });
  });

  it("another vault's trade on the same portfolio id does not count", async () => {
    const p = freshPortfolio();
    await event(freshQuote(), p, "opened", 5, "intentfolio-staging.near");
    expect((await read(p)).body).toMatchObject({ inFlight: false });
  });

  it("two open trades: the newest one sets the wait", async () => {
    const p = freshPortfolio();
    await event(freshQuote(), p, "opened", 60);
    await event(freshQuote(), p, "opened", 5);
    const { body } = await read(p);
    if (!body.ok) throw new Error("expected an answer");
    expect(body.remainingMs).toBeGreaterThan(80_000);
  });
});
