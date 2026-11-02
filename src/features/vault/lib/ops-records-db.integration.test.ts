// @vitest-environment node
//
// The ONLY test that proves the SQL in `ops-records-service.ts` matches the DDL the solver
// owns. The unit tests run the same statements against a stub, which checks the shape of the
// string and nothing about whether Postgres would accept it — and this seam is a contract
// between two repositories, so "the string looks right" is not evidence.
//
// It runs against `intentfolio-solver/db/local/`, which applies migrations 001/002/003
// verbatim, through the POOLED port — the transaction-mode PgBouncer the frontend's writer
// uses in production. That is deliberate: the pooler is where the `statement_timeout` startup
// parameter would fail the connection outright, and a test that used the direct port would
// pass while production could not connect at all.
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
  handleCreateRecord,
  handlePatchRecord,
  readOpsDbConfig,
  type Queryable,
} from "./ops-records-service";
import { createOpsHealthChecker, OPS_HEALTH_SQL } from "./ops-health";

const CONNECTION_STRING = process.env.INTENTFOLIO_OPS_DB_URL;
const suite = CONNECTION_STRING ? describe : describe.skip;

const allow = { check: () => true };
const noLog = () => {};

suite("allocate_rescue_record — against a real Postgres 16 through the pooler", () => {
  let pool: Pool;
  let db: Queryable;

  beforeAll(() => {
    const config = readOpsDbConfig(process.env);
    if (!config.ok) throw new Error(config.issues.join(", "));
    // Built by the same function the route uses. If it ever regained a `statement_timeout`,
    // every test below would fail on connect with `unsupported startup parameter` — which is
    // exactly the production failure, surfaced here instead of on deploy day.
    pool = new Pool(createPoolConfig(config.config));
    db = pool as unknown as Queryable;
  });

  afterAll(async () => {
    await pool?.end();
  });

  function record(over: Record<string, unknown> = {}) {
    return {
      id: randomUUID(),
      signerId: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      // Spaced on purpose — see the note in ops-records-service.test.ts. Postgres stores
      // `msg` as text, so this also proves nothing normalises it on the way in.
      msg: '{ "deadline": 1790000000, "nonce": [1, 2, 3], "op": { "Setup": { "name": "Balanced" } } }',
      vaultId: "intentfolio-staging.near",
      portfolioName: "Balanced",
      legs: [
        { tokenId: "nep141:wrap.near", amount: "1000000000000000000000000" },
        { tokenId: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", amount: "5000000" },
      ],
      createdAt: 1_760_000_000_000,
      ...over,
    };
  }

  const create = (body: unknown) =>
    handleCreateRecord({ body, callerKey: "test", db, limiter: allow, log: noLog });
  const patch = (body: unknown) =>
    handlePatchRecord({ body, callerKey: "test", db, limiter: allow, log: noLog });

  it("connects through the transaction-mode pooler at all", async () => {
    const { rows } = await db.query<{ ok: number }>("SELECT 1 AS ok");
    expect(rows[0].ok).toBe(1);
  });

  it("stores every column the rescue needs, with the msg byte-identical", async () => {
    const body = record();
    expect(await create(body)).toEqual({
      status: 200,
      body: { ok: true, id: body.id, created: true },
    });

    const { rows } = await db.query<Record<string, unknown>>(
      `SELECT signer_id, msg, vault_id, portfolio_name, legs, created_at, received_at,
              status, signed_envelope, tx_hash, error
         FROM allocate_rescue_record WHERE id = $1`,
      [body.id]
    );
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.msg).toBe(body.msg);
    // Guard on the guard: if the fixture were compact, the line above would pass even for a
    // parse-and-rebuild, which is the exact bug it exists to catch.
    expect(JSON.stringify(JSON.parse(body.msg))).not.toBe(body.msg);
    expect(row.signer_id).toBe(body.signerId);
    expect(row.vault_id).toBe(body.vaultId);
    expect(row.portfolio_name).toBe(body.portfolioName);
    // Round-trips through jsonb with the amounts still strings — the whole point of not
    // letting a base-unit quantity become a JS number anywhere on this path.
    expect(row.legs).toEqual(body.legs);
    expect((row.created_at as Date).getTime()).toBe(body.createdAt);
    expect(row.status).toBe("signing");
    expect(row.signed_envelope).toBeNull();
    // The database stamps its own clock; the two are separate columns because they disagree.
    expect(row.received_at).toBeInstanceOf(Date);
  });

  // ADR-0017 §4. The browser generates the id, so a retry after a lost response must be a
  // no-op — not a duplicate, and not an error that would fail-close a legitimate Allocate.
  it("makes a repeated POST of the same id a no-op that still says 'go ahead'", async () => {
    const body = record();
    await create(body);
    const retry = await create(body);
    expect(retry.body).toEqual({ ok: true, id: body.id, created: false });

    const { rows } = await db.query<{ n: string }>(
      "SELECT count(*) AS n FROM allocate_rescue_record WHERE id = $1",
      [body.id]
    );
    expect(rows[0].n).toBe("1");
  });

  it("carries the lifecycle through PATCH and lets the trigger move updated_at", async () => {
    const body = record();
    await create(body);
    const before = await db.query<{ updated_at: Date }>(
      "SELECT updated_at FROM allocate_rescue_record WHERE id = $1",
      [body.id]
    );

    const envelope = { standard: "nep413", payload: { message: "…" }, signature: "ed25519:…" };
    expect((await patch({ id: body.id, status: "submitted", txHash: "TxAbc", signedEnvelope: envelope })).status).toBe(200);

    const { rows } = await db.query<Record<string, unknown>>(
      "SELECT status, tx_hash, signed_envelope, updated_at FROM allocate_rescue_record WHERE id = $1",
      [body.id]
    );
    expect(rows[0].status).toBe("submitted");
    expect(rows[0].tx_hash).toBe("TxAbc");
    expect(rows[0].signed_envelope).toEqual(envelope);
    expect((rows[0].updated_at as Date).getTime()).toBeGreaterThanOrEqual(
      before.rows[0].updated_at.getTime()
    );
  });

  // jsonb is NOT a byte-preserving store: it reorders keys, drops duplicates and normalises
  // numbers. That is safe for this column only because of WHERE the signed bytes live — the
  // NEP-413 digest is computed over `payload.message`, which is a STRING, so jsonb may shuffle
  // the object around it without touching what was signed. Asserting it rather than reasoning
  // about it: if this ever stopped holding, every stored envelope would verify as invalid and
  // the rescue tool would refuse to sign, one orphan at a time.
  it("returns the envelope's signed bytes byte-identical through jsonb", async () => {
    const body = record();
    await create(body);

    // Spaced and oddly ordered on purpose, and with the msg escaped inside it — the shape the
    // real envelope has.
    const message =
      '{ "signer_id": "alice.near", "intents": [ { "intent": "auth_call", "msg": "{\"deadline\":1}" } ] }';
    const envelope = {
      standard: "nep413",
      signature: "ed25519:2ZmSfF…",
      payload: { recipient: "intents.near", message, nonce: "Vij2xgAlKBKzAHB9RgLj+g==" },
      public_key: "ed25519:8rVvtHWFr8hasdQGGD5WiQBTyr4iH2ruEPPVfj491RPN",
    };
    expect((await patch({ id: body.id, signedEnvelope: envelope })).status).toBe(200);

    const { rows } = await db.query<{ signed_envelope: Record<string, unknown> }>(
      "SELECT signed_envelope FROM allocate_rescue_record WHERE id = $1",
      [body.id]
    );
    const stored = rows[0].signed_envelope as { payload: { message: string } };
    expect(stored.payload.message).toBe(message);
    // The four fields `rescue/envelope.ts` reads, all present after the round-trip.
    expect(stored).toEqual(envelope);
  });

  // The second half proves the invariant `db/README.md` §Schema changes requires: our ceiling
  // must be TIGHTER than the DDL's, never looser. 004 bounds this column at 131072 characters
  // of Postgres's rendering — deliberately twice ours — so a payload we refuse at 64 KiB is
  // one the table would still have taken. If this ever starts failing, the two sides have
  // crossed and live Allocates are about to be rejected by a constraint instead of by us.
  it("refuses an oversized envelope that the table itself would have accepted", async () => {
    const body = record();
    await create(body);

    const oversized = { standard: "nep413", payload: { message: "x".repeat(70_000) } };
    expect((await patch({ id: body.id, signedEnvelope: oversized })).status).toBe(400);

    await expect(
      db.query("UPDATE allocate_rescue_record SET signed_envelope = $2::jsonb WHERE id = $1", [
        body.id,
        JSON.stringify(oversized),
      ])
    ).resolves.toBeTruthy();
  });

  it("accepts suspected_orphan, the status that puts a record on the rescue worklist", async () => {
    const body = record();
    await create(body);
    expect((await patch({ id: body.id, status: "suspected_orphan" })).status).toBe(200);
  });

  // ── The `suspected_orphan → credited` flip on app load (009.plan FE #4) ─────────────
  // The body below is the literal `confirmAllocateRecordCredited` sends. What it must do to
  // the row: move `status` and nothing else, and take it off BOTH of the solver's worklists.
  it("flips a suspected_orphan to credited, touches no evidence column, and leaves the solver's worklists", async () => {
    const body = record();
    await create(body);
    const envelope = { standard: "nep413", payload: { message: "…" }, signature: "ed25519:…" };
    await patch({ id: body.id, signedEnvelope: envelope });
    await patch({ id: body.id, status: "submitted", txHash: "TxAbc" });
    expect((await patch({ id: body.id, status: "suspected_orphan" })).status).toBe(200);

    const columns =
      "SELECT status, signed_envelope, tx_hash, error, updated_at FROM allocate_rescue_record WHERE id = $1";
    const before = (await db.query<Record<string, unknown>>(columns, [body.id])).rows[0];
    expect(before.status).toBe("suspected_orphan");

    expect(await patch({ id: body.id, status: "credited" })).toEqual({
      status: 200,
      body: { ok: true, id: body.id, updated: true },
    });

    const after = (await db.query<Record<string, unknown>>(columns, [body.id])).rows[0];
    expect(after.status).toBe("credited");
    expect(after.signed_envelope).toEqual(before.signed_envelope);
    expect(after.tx_hash).toBe(before.tx_hash);
    expect(after.error).toBe(before.error);
    expect((after.updated_at as Date).getTime()).toBeGreaterThanOrEqual(
      (before.updated_at as Date).getTime()
    );

    // The two WHEREs of `allocate-rescue-reader.service.ts`, verbatim: `listSuspectedOrphans`
    // (watchdog + CLI) and `listUnresolved` (the resolver). Gone from both.
    const orphans = await db.query(
      "SELECT id FROM allocate_rescue_record WHERE status = 'suspected_orphan' AND id = $1",
      [body.id]
    );
    expect(orphans.rows).toHaveLength(0);
    const unresolved = await db.query(
      "SELECT id FROM allocate_rescue_record WHERE status = ANY('{signing,submitted,suspected_orphan}') AND id = $1",
      [body.id]
    );
    expect(unresolved.rows).toHaveLength(0);
  });

  // StrictMode, HMR, or two tabs: the flip may run twice, and the second must be a no-op that
  // still says 200 — not a 4xx that the caller would read as "leave it for the next load".
  it("accepts the credited flip twice", async () => {
    const body = record();
    await create(body);
    await patch({ id: body.id, status: "suspected_orphan" });
    for (let i = 0; i < 2; i++) {
      expect(await patch({ id: body.id, status: "credited" })).toEqual({
        status: 200,
        body: { ok: true, id: body.id, updated: true },
      });
    }
    const { rows } = await db.query<{ status: string }>(
      "SELECT status FROM allocate_rescue_record WHERE id = $1",
      [body.id]
    );
    expect(rows[0].status).toBe("credited");
  });

  it("reports 404 for a PATCH of a record that was never inserted", async () => {
    const result = await patch({ id: randomUUID(), status: "credited" });
    expect(result).toMatchObject({ status: 404, body: { code: "not-found" } });
  });

  // ── D-449: the envelope is write-once, enforced by the route's WHERE ─────────────────────
  // The grant lets this credential UPDATE `signed_envelope` whenever, so these prove the
  // statement — not the database — is what keeps a stored envelope from being replaced.

  const envelopeA = {
    standard: "nep413",
    payload: { recipient: "intents.near", message: '{"deadline":1}', nonce: "AAAA" },
    public_key: "ed25519:A",
    signature: "ed25519:sigA",
  };

  it("refuses a second, different envelope with 409 and keeps the first", async () => {
    const body = record();
    await create(body);
    expect((await patch({ id: body.id, signedEnvelope: envelopeA })).status).toBe(200);

    const other = { ...envelopeA, signature: "ed25519:sigB" };
    const result = await patch({ id: body.id, signedEnvelope: other });
    expect(result).toMatchObject({ status: 409, body: { code: "conflict" } });

    const { rows } = await db.query<{ signed_envelope: unknown }>(
      "SELECT signed_envelope FROM allocate_rescue_record WHERE id = $1",
      [body.id]
    );
    expect(rows[0].signed_envelope).toEqual(envelopeA);
  });

  it("writes nothing from a mixed patch whose envelope conflicts", async () => {
    const body = record();
    await create(body);
    await patch({ id: body.id, signedEnvelope: envelopeA });

    const result = await patch({
      id: body.id,
      status: "failed",
      error: "hand-made",
      signedEnvelope: { ...envelopeA, signature: "ed25519:sigB" },
    });
    expect(result.status).toBe(409);

    const { rows } = await db.query<{ status: string; error: string | null }>(
      "SELECT status, error FROM allocate_rescue_record WHERE id = $1",
      [body.id]
    );
    expect(rows[0]).toEqual({ status: "signing", error: null });
  });

  // The retry `patchSignedEnvelope` makes after a lost response. Re-ordered keys on purpose:
  // jsonb compares by value, so equality must not depend on the order the object was built in.
  it("accepts a resend of the same envelope — a lost-response retry must not abort the Allocate", async () => {
    const body = record();
    await create(body);
    expect((await patch({ id: body.id, signedEnvelope: envelopeA })).status).toBe(200);

    const reordered = {
      signature: envelopeA.signature,
      public_key: envelopeA.public_key,
      payload: { nonce: "AAAA", message: '{"deadline":1}', recipient: "intents.near" },
      standard: "nep413",
    };
    expect((await patch({ id: body.id, signedEnvelope: reordered })).status).toBe(200);
    // And a lifecycle patch afterwards is untouched by the guard.
    expect((await patch({ id: body.id, status: "submitted", txHash: "Tx1" })).status).toBe(200);
  });

  it("still answers 404 for an envelope patch on a record that was never inserted", async () => {
    const result = await patch({ id: randomUUID(), signedEnvelope: envelopeA });
    expect(result).toMatchObject({ status: 404, body: { code: "not-found" } });
  });

  // ── The properties the seam's security rests on, verified from THIS side ──────────────
  // The frontend holds the writer credential. If any of these three stopped holding, a
  // compromised frontend could rewrite or erase the bytes a rescue replays.

  it("cannot rewrite the msg it already stored", async () => {
    const body = record();
    await create(body);
    await expect(
      db.query("UPDATE allocate_rescue_record SET msg = $2 WHERE id = $1", [body.id, "tampered"])
    ).rejects.toThrow();

    const { rows } = await db.query<{ msg: string }>(
      "SELECT msg FROM allocate_rescue_record WHERE id = $1",
      [body.id]
    );
    expect(rows[0].msg).toBe(body.msg);
  });

  it("cannot delete a record", async () => {
    const body = record();
    await create(body);
    await expect(
      db.query("DELETE FROM allocate_rescue_record WHERE id = $1", [body.id])
    ).rejects.toThrow();
  });

  it("cannot invent a status outside the vocabulary the solver knows", async () => {
    const body = record();
    await create(body);
    await expect(
      db.query("UPDATE allocate_rescue_record SET status = 'weird' WHERE id = $1", [body.id])
    ).rejects.toThrow();
  });

  // ── The route's ceilings must not be tighter OR looser than the table's ──────────────

  it("refuses an oversized msg at the same boundary the DDL does", async () => {
    // One under the limit is accepted by both.
    const ok = record({ msg: "x".repeat(16_384) });
    expect((await create(ok)).status).toBe(200);
    // One over is refused by the route, so it never reaches the constraint...
    const tooBig = record({ msg: "x".repeat(16_385) });
    expect((await create(tooBig)).status).toBe(400);
    // ...and the table would have refused it too, which is what makes the route's copy of
    // the ceiling a convenience rather than a second, drifting rule.
    await expect(
      db.query(
        `INSERT INTO allocate_rescue_record
           (id, signer_id, msg, vault_id, portfolio_name, legs, created_at)
         VALUES ($1, 'a.near', $2, 'v.near', 'n', '[]'::jsonb, now())`,
        [tooBig.id, "x".repeat(16_385)]
      )
    ).rejects.toThrow();
  });

  // ── The health probe (ADR-0017 §7) ──────────────────────────────────────────────────
  //
  // The whole point of `/api/ops/health` is that a green answer means the WRITER can reach
  // the table. That rests on `002_roles.sql` granting SELECT — read off the DDL, which is an
  // argument, not a measurement. This runs the statement with the writer's own credential.

  it("the writer can actually run the health statement — GRANT, schema and connectivity", async () => {
    const checker = createOpsHealthChecker({ resolve: () => ({ ok: true, db }), log: noLog });
    const verdict = await checker.check();
    expect(verdict).toMatchObject({ ok: true, cached: false });
  });

  it("the health statement reads no user data, whatever the table holds", async () => {
    // A row exists by now (the suite above inserted several), so this is the loaded case.
    const result = await db.query<Record<string, unknown>>(OPS_HEALTH_SQL);
    expect(result.rows.length).toBeLessThanOrEqual(1);
    for (const row of result.rows) {
      // The projection is the constant `1`: no column of the record comes back.
      expect(Object.keys(row)).not.toContain("signer_id");
      expect(Object.keys(row)).not.toContain("msg");
      expect(Object.keys(row)).not.toContain("legs");
    }
  });

  it("reports unhealthy when the table is not there — the state a bare `SELECT 1` would call green", async () => {
    // Proves the choice of statement, not the plumbing: same credential, same connection, a
    // name that does not exist. If the probe ever went back to `SELECT 1`, this fails.
    const missingTable: Queryable = {
      query: <R,>(text: string, values?: unknown[]) =>
        db.query<R>(text.replace("allocate_rescue_record", "allocate_rescue_record_gone"), values),
    };
    const checker = createOpsHealthChecker({ resolve: () => ({ ok: true, db: missingTable }), log: noLog });

    await expect(checker.check()).resolves.toMatchObject({ ok: false, reason: "query-failed" });
    await expect(db.query("SELECT 1")).resolves.toBeTruthy();
  });
});
