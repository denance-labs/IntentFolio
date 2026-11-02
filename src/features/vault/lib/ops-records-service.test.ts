// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import {
  buildPatchStatement,
  createOpsRateLimiter,
  createPoolConfig,
  handleCreateRecord,
  handlePatchRecord,
  readOpsDbConfig,
  validateCreateBody,
  validatePatchBody,
  type Queryable,
} from "./ops-records-service";
import { OPS_RECORD_LIMITS } from "./ops-records-types";

const ID = "6f1b3c2a-9d4e-4f7a-8b1c-2e5d7a9c0f31";

function validBody(over: Record<string, unknown> = {}) {
  return {
    id: ID,
    signerId: "alice.near",
    msg: '{"deadline":123,"nonce":[1,2,3]}',
    vaultId: "intentfolio-staging.near",
    portfolioName: "Balanced",
    legs: [{ tokenId: "nep141:wrap.near", amount: "1000000" }],
    createdAt: 1_760_000_000_000,
    ...over,
  };
}

/** A stub that records what SQL it was asked to run. */
function stubDb(result: { rows?: unknown[]; rowCount?: number | null } = {}) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const db: Queryable = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      calls.push({ text, values: values ?? [] });
      return { rows: (result.rows ?? []) as never[], rowCount: result.rowCount ?? 1 };
    }),
  };
  return { db, calls };
}

/** Like `stubDb`, but answers each call in turn — an Error in the list is thrown instead. */
function sequencedDb(results: Array<{ rowCount: number } | Error>) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const db: Queryable = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      calls.push({ text, values: values ?? [] });
      const next = results[calls.length - 1];
      if (!next) throw new Error(`unexpected query #${calls.length}: ${text}`);
      if (next instanceof Error) throw next;
      return { rows: [] as never[], rowCount: next.rowCount };
    }),
  };
  return { db, calls };
}

const noLog = () => {};
const allow = { check: () => true };

describe("readOpsDbConfig", () => {
  it("refuses to run without a credential instead of defaulting to something", () => {
    const result = readOpsDbConfig({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]).toContain("INTENTFOLIO_OPS_DB_URL");
  });

  it("rejects a connection string that is not postgres://", () => {
    expect(readOpsDbConfig({ INTENTFOLIO_OPS_DB_URL: "mysql://x/y" }).ok).toBe(false);
  });

  // TLS is opt-OUT and only the literal "false" opts out: a typo in the variable must leave
  // certificate verification on, never silently send a database password in the clear.
  it.each([
    [undefined, true],
    ["", true],
    ["FALSE", true],
    ["0", true],
    ["no", true],
    ["false", false],
  ])("INTENTFOLIO_OPS_DB_SSL=%s => ssl %s", (raw, expected) => {
    const result = readOpsDbConfig({
      INTENTFOLIO_OPS_DB_URL: "postgres://u:p@127.0.0.1:6432/d",
      ...(raw === undefined ? {} : { INTENTFOLIO_OPS_DB_SSL: raw }),
    });
    expect(result.ok && result.config.ssl).toBe(expected);
  });

  it("refuses to drop TLS for anything but a loopback host", () => {
    const result = readOpsDbConfig({
      INTENTFOLIO_OPS_DB_URL: "postgres://u:p@db.example.com:25061/d",
      INTENTFOLIO_OPS_DB_SSL: "false",
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues[0]).toMatch(/only allowed for a loopback host/);
  });

  // The CA has to travel as a value, not a path: a serverless invocation has no disk to
  // point `sslrootcert` at. DigitalOcean signs with a per-project CA, so without this the
  // chain never verifies.
  it("carries a PEM certificate authority into the ssl options", () => {
    const ca = "-----BEGIN CERTIFICATE-----\nMIIDfake\n-----END CERTIFICATE-----";
    const result = readOpsDbConfig({
      INTENTFOLIO_OPS_DB_URL: "postgres://u:p@db.example.com:25061/d",
      INTENTFOLIO_OPS_DB_CA: ca,
    });
    expect(result.ok && result.config.ssl).toEqual({ ca });
  });

  it("rejects a certificate authority that is not a PEM", () => {
    const result = readOpsDbConfig({
      INTENTFOLIO_OPS_DB_URL: "postgres://u:p@db.example.com:25061/d",
      INTENTFOLIO_OPS_DB_CA: "not-a-certificate",
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues[0]).toMatch(/must be a PEM certificate/);
  });

  // `pg` lets a parsed connection string overwrite the pool's ssl options, so an sslmode in
  // the URL would discard the CA above and leave verification against the system trust
  // store. That failure is silent at config time and fatal at connect time.
  it("refuses a URL that carries sslmode, which would discard the CA", () => {
    const result = readOpsDbConfig({
      INTENTFOLIO_OPS_DB_URL: "postgres://u:p@db.example.com:25061/d?sslmode=verify-full",
      INTENTFOLIO_OPS_DB_CA: "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----",
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues[0]).toMatch(/must not carry sslmode/);
  });

  it("falls back to the default for an out-of-range or junk pool size", () => {
    const base = { INTENTFOLIO_OPS_DB_URL: "postgres://u:p@h:6432/d" };
    for (const raw of ["0", "-1", "999", "abc", "2.5"]) {
      const r = readOpsDbConfig({ ...base, INTENTFOLIO_OPS_DB_MAX_CONNECTIONS: raw });
      expect(r.ok && r.config.maxConnections).toBe(3);
    }
    const ok = readOpsDbConfig({ ...base, INTENTFOLIO_OPS_DB_MAX_CONNECTIONS: "7" });
    expect(ok.ok && ok.config.maxConnections).toBe(7);
  });
});

describe("createPoolConfig", () => {
  const config = {
    connectionString: "postgres://u:p@h:6432/d",
    ssl: true,
    maxConnections: 3,
    connectionTimeoutMs: 5_000,
    queryTimeoutMs: 5_000,
  };

  // THE regression this file exists for. `pg` puts `statement_timeout` in the connection
  // startup packet, and the writer reaches Postgres through a TRANSACTION-mode pooler, which
  // answers an unrecognised startup parameter with `FATAL: unsupported startup parameter`.
  // With fail-closed writes that is not a slow Allocate, it is no Allocate at all.
  it("never sets statement_timeout — it would be a startup parameter through the pooler", () => {
    expect(createPoolConfig(config)).not.toHaveProperty("statement_timeout");
  });

  it("keeps a client-side query deadline instead", () => {
    expect(createPoolConfig(config).query_timeout).toBe(5_000);
  });

  it("keeps certificate verification on, and omits ssl entirely when disabled", () => {
    expect(createPoolConfig(config).ssl).toBe(true);
    expect(createPoolConfig({ ...config, ssl: false })).not.toHaveProperty("ssl");
  });

  it("passes a certificate authority through untouched", () => {
    const ssl = { ca: "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----" };
    expect(createPoolConfig({ ...config, ssl }).ssl).toEqual(ssl);
  });
});

describe("validateCreateBody", () => {
  it("accepts a well-formed record", () => {
    expect(validateCreateBody(validBody()).ok).toBe(true);
  });

  it.each([
    ["a non-uuid id", { id: "not-a-uuid" }],
    ["a one-character signer", { signerId: "a" }],
    ["an empty msg", { msg: "" }],
    ["legs that are not an array", { legs: { tokenId: "x", amount: "1" } }],
    ["a numeric amount", { legs: [{ tokenId: "x", amount: 1 }] }],
    ["a missing createdAt", { createdAt: undefined }],
    ["a non-numeric createdAt", { createdAt: "2026-08-20" }],
  ])("rejects %s", (_label, over) => {
    expect(validateCreateBody(validBody(over)).ok).toBe(false);
  });

  // Base units exceed Number.MAX_SAFE_INTEGER. A number here would round the very quantity a
  // rescue has to replay, so the string is the contract, not a formatting preference.
  it("keeps a leg amount that no JS number could hold", () => {
    const huge = "123456789012345678901234567890";
    const result = validateCreateBody(validBody({ legs: [{ tokenId: "eth", amount: huge }] }));
    expect(result.ok && result.value.legs[0].amount).toBe(huge);
  });

  // The browser clock and the server clock disagree by design (001 says so) and `received_at`
  // is the one to trust. Rejecting a skewed clock would fail-closed an Allocate over a wrong
  // system time — a user setting, not a corrupt record.
  it("accepts a badly skewed browser clock rather than blocking the Allocate", () => {
    expect(validateCreateBody(validBody({ createdAt: 0 })).ok).toBe(true);
    expect(validateCreateBody(validBody({ createdAt: 4_102_444_800_000 })).ok).toBe(true);
  });

  // These mirror 003_size_bounds.sql. They must never be TIGHTER than the DDL: a rule
  // stricter than the table would refuse records the rescue could have used.
  it("matches the DDL ceilings exactly at the boundary", () => {
    expect(validateCreateBody(validBody({ msg: "x".repeat(OPS_RECORD_LIMITS.msgMax) })).ok).toBe(true);
    expect(validateCreateBody(validBody({ msg: "x".repeat(OPS_RECORD_LIMITS.msgMax + 1) })).ok).toBe(false);
    const legs = (n: number) => Array.from({ length: n }, () => ({ tokenId: "t", amount: "1" }));
    expect(validateCreateBody(validBody({ legs: legs(OPS_RECORD_LIMITS.legsMax) })).ok).toBe(true);
    expect(validateCreateBody(validBody({ legs: legs(OPS_RECORD_LIMITS.legsMax + 1) })).ok).toBe(false);
    const name = (n: number) => "n".repeat(n);
    expect(validateCreateBody(validBody({ portfolioName: name(OPS_RECORD_LIMITS.portfolioNameMax) })).ok).toBe(true);
    expect(validateCreateBody(validBody({ portfolioName: name(OPS_RECORD_LIMITS.portfolioNameMax + 1) })).ok).toBe(false);
  });
});

describe("validatePatchBody", () => {
  it("rejects a status the database CHECK would refuse", () => {
    expect(validatePatchBody({ id: ID, status: "orphaned" }).ok).toBe(false);
  });

  // Every value here is one the frontend can now send: `suspected_orphan` was the last one
  // left unwired and the credit poll writes it since P-OPS v1 point 5.
  it("accepts every status in the DDL vocabulary", () => {
    for (const status of ["signing", "submitted", "suspected_orphan", "credited", "failed"]) {
      expect(validatePatchBody({ id: ID, status }).ok).toBe(true);
    }
  });

  it("refuses an empty patch rather than issuing an UPDATE with no SET", () => {
    expect(validatePatchBody({ id: ID }).ok).toBe(false);
  });

  it("truncates an oversized error — the table has no DELETE to undo one", () => {
    const result = validatePatchBody({ id: ID, error: "e".repeat(5_000) });
    expect(result.ok && result.value.error?.length).toBe(2_000);
  });

  it("accepts a real envelope, whose payload may be an object OR a plain string", () => {
    // nep413 nests an object; erc191/tip191/sep53/raw_ed25519 put the signed string there.
    expect(
      validatePatchBody({
        id: ID,
        signedEnvelope: { standard: "nep413", payload: { message: "{}", nonce: "AA==" } },
      }).ok
    ).toBe(true);
    expect(
      validatePatchBody({ id: ID, signedEnvelope: { standard: "erc191", payload: "{}" } }).ok
    ).toBe(true);
  });

  // The FIRST of two bounds on `signed_envelope`, and the tighter one. The solver repo added
  // the matching CHECK on 2026-08-23 (004, at twice this value), so this is no longer all that
  // stands between a public Next route and a row nobody can delete — it is the gate that
  // produces a readable message instead of a raw constraint violation.
  it("refuses an envelope over the ceiling rather than storing it forever", () => {
    const oversized = { standard: "nep413", payload: { message: "x".repeat(70_000) } };
    const result = validatePatchBody({ id: ID, signedEnvelope: oversized });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/signedEnvelope/);
  });

  it("keeps the ceiling above anything the frontend can legitimately produce", () => {
    // The envelope's biggest component is `msg`, capped at 16 KiB by the DDL, and it appears
    // escaped inside a JSON string. A ceiling at or below that would reject real records.
    expect(OPS_RECORD_LIMITS.signedEnvelopeMax).toBeGreaterThan(OPS_RECORD_LIMITS.msgMax * 2);
  });

  it("rejects a non-object envelope — the rescue reads four fields off it", () => {
    expect(validatePatchBody({ id: ID, signedEnvelope: "nep413" }).ok).toBe(false);
    expect(validatePatchBody({ id: ID, signedEnvelope: null }).ok).toBe(false);
  });
});

describe("handleCreateRecord", () => {
  it("INSERTs the raw msg verbatim and stamps status 'signing'", async () => {
    const { db, calls } = stubDb({ rowCount: 1 });
    // Spaced on purpose. The vault seals on sha256(msg), so ANY round trip through
    // JSON.parse/stringify — which preserves key order but not whitespace — produces a
    // different hash and the rescue fails (D-160). A compact msg would let a re-serialising
    // bug pass this assertion unnoticed.
    const msg = '{ "deadline": 1, "nonce": [9, 8, 7], "op": { "Setup": {} } }';
    const result = await handleCreateRecord({
      body: validBody({ msg }),
      callerKey: "1.2.3.4",
      db,
      limiter: allow,
      log: noLog,
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true, id: ID, created: true });
    expect(calls[0].text).toContain("INSERT INTO allocate_rescue_record");
    expect(calls[0].text).toContain("'signing'");
    // Verbatim — a re-serialisation that reorders one key is a different sha256 and the
    // rescue fails (D-160).
    expect(calls[0].values[2]).toBe(msg);
    // legs go over as a JSON string for the ::jsonb cast, amounts still strings.
    expect(calls[0].values[5]).toBe('[{"tokenId":"nep141:wrap.near","amount":"1000000"}]');
    expect(calls[0].values[6]).toBeInstanceOf(Date);
  });

  // ADR-0017 §4: the id is the browser's randomUUID and the primary key, so a retry after a
  // lost response must be a no-op. `created: false` is a SUCCESS — the record is there, which
  // is the only thing the caller needs to know before it signs.
  it("answers 200 with created:false when the id is already stored", async () => {
    const { db, calls } = stubDb({ rowCount: 0 });
    const result = await handleCreateRecord({
      body: validBody(),
      callerKey: "1.2.3.4",
      db,
      limiter: allow,
      log: noLog,
    });
    expect(result).toEqual({ status: 200, body: { ok: true, id: ID, created: false } });
    expect(calls[0].text).toContain("ON CONFLICT (id) DO NOTHING");
  });

  it("does not touch the database when the body is malformed", async () => {
    const { db, calls } = stubDb();
    const result = await handleCreateRecord({
      body: validBody({ msg: "" }),
      callerKey: "1.2.3.4",
      db,
      limiter: allow,
      log: noLog,
    });
    expect(result.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("reports a write failure as 502 so the caller fails closed", async () => {
    const db: Queryable = { query: vi.fn().mockRejectedValue(new Error("connection refused")) };
    const result = await handleCreateRecord({
      body: validBody(),
      callerKey: "1.2.3.4",
      db,
      limiter: allow,
      log: noLog,
    });
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ ok: false, code: "write-failed" });
  });

  // ADR-0017 §8: the row carries user financial data and must not reach logs or tickets.
  it("never logs the signer, the name, the amounts or the msg", async () => {
    const lines: string[] = [];
    const { db } = stubDb({ rowCount: 1 });
    await handleCreateRecord({
      body: validBody(),
      callerKey: "1.2.3.4",
      db,
      limiter: allow,
      log: (m) => lines.push(m),
    });
    const all = lines.join("\n");
    expect(all).toContain(ID);
    for (const secret of ["alice.near", "Balanced", "1000000", "wrap.near"]) {
      expect(all).not.toContain(secret);
    }
  });

  it("refuses over the rate limit without querying", async () => {
    const { db, calls } = stubDb();
    const result = await handleCreateRecord({
      body: validBody(),
      callerKey: "1.2.3.4",
      db,
      limiter: { check: () => false },
      log: noLog,
    });
    expect(result.status).toBe(429);
    expect(calls).toHaveLength(0);
  });
});

describe("handlePatchRecord", () => {
  it("SETs only the fields present, by their real column names", async () => {
    const { db, calls } = stubDb({ rowCount: 1 });
    await handlePatchRecord({
      body: { id: ID, status: "submitted", txHash: "Tx123" },
      callerKey: "1.2.3.4",
      db,
      limiter: allow,
      log: noLog,
    });
    expect(calls[0].text).toContain("SET status = $2, tx_hash = $3");
    expect(calls[0].values).toEqual([ID, "submitted", "Tx123"]);
  });

  it("casts the signed envelope to jsonb", async () => {
    const { db, calls } = stubDb({ rowCount: 1 });
    await handlePatchRecord({
      body: { id: ID, signedEnvelope: { standard: "nep413" } },
      callerKey: "1.2.3.4",
      db,
      limiter: allow,
      log: noLog,
    });
    expect(calls[0].text).toContain("signed_envelope = $2::jsonb");
    expect(calls[0].values[1]).toBe('{"standard":"nep413"}');
  });

  // Gate 1 of 2: the validator drops keys it does not know, so an evidence field never even
  // reaches the SQL builder.
  it("drops any field outside the lifecycle vocabulary before building SQL", async () => {
    const { db, calls } = stubDb({ rowCount: 1 });
    await handlePatchRecord({
      body: { id: ID, status: "failed", msg: "tampered", signerId: "mallory.near", legs: [] },
      callerKey: "1.2.3.4",
      db,
      limiter: allow,
      log: noLog,
    });
    for (const column of ["msg", "signer_id", "legs", "vault_id", "created_at", "received_at"]) {
      expect(calls[0].text).not.toContain(`${column} =`);
    }
  });

  // `updated_at` is maintained by the freeze-evidence trigger. Writing it here would only
  // give the route a chance to disagree with the database clock.
  it("leaves updated_at to the trigger", async () => {
    const { db, calls } = stubDb({ rowCount: 1 });
    await handlePatchRecord({
      body: { id: ID, status: "credited" },
      callerKey: "1.2.3.4",
      db,
      limiter: allow,
      log: noLog,
    });
    expect(calls[0].text).not.toContain("updated_at");
  });

  it("reports 404 when no row matched — an Allocate with no evidence row", async () => {
    const { db } = stubDb({ rowCount: 0 });
    const result = await handlePatchRecord({
      body: { id: ID, status: "credited" },
      callerKey: "1.2.3.4",
      db,
      limiter: allow,
      log: noLog,
    });
    expect(result.status).toBe(404);
    expect(result.body).toMatchObject({ ok: false, code: "not-found" });
  });

  // D-449: the route is public and the grant lets the writer UPDATE the envelope at any time,
  // so write-once has to live in the statement itself.
  describe("the envelope is write-once (D-449)", () => {
    const envelope = { standard: "nep413", signature: "ed25519:abc" };
    const patchEnvelope = (db: Queryable, log: (m: string) => void = noLog) =>
      handlePatchRecord({
        body: { id: ID, signedEnvelope: envelope },
        callerKey: "1.2.3.4",
        db,
        limiter: allow,
        log,
      });

    it("only matches a row whose envelope is empty or equal in value to this one", async () => {
      const { db, calls } = sequencedDb([{ rowCount: 1 }]);
      const result = await patchEnvelope(db);
      expect(result.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0].text).toContain(
        "WHERE id = $1 AND (signed_envelope IS NULL OR signed_envelope = $2::jsonb)"
      );
    });

    it("answers 409 and writes nothing when a different envelope is already stored", async () => {
      const { db, calls } = sequencedDb([{ rowCount: 0 }, { rowCount: 1 }]);
      const lines: string[] = [];
      const result = await patchEnvelope(db, (m) => lines.push(m));
      expect(result.status).toBe(409);
      expect(result.body).toMatchObject({ ok: false, code: "conflict" });
      // The second statement is a read of the id alone, never another write attempt.
      expect(calls[1].text).toBe("SELECT 1 FROM allocate_rescue_record WHERE id = $1");
      expect(calls[1].values).toEqual([ID]);
      // Neither envelope reaches the log.
      expect(lines.join("\n")).not.toContain("ed25519");
    });

    it("still answers 404 when the record does not exist at all", async () => {
      const { db } = sequencedDb([{ rowCount: 0 }, { rowCount: 0 }]);
      const result = await patchEnvelope(db);
      expect(result.status).toBe(404);
      expect(result.body).toMatchObject({ ok: false, code: "not-found" });
    });

    it("reports a failed existence read as a write failure, so the browser retries", async () => {
      const { db } = sequencedDb([{ rowCount: 0 }, new Error("connection reset")]);
      const result = await patchEnvelope(db);
      expect(result.status).toBe(502);
      expect(result.body).toMatchObject({ ok: false, code: "write-failed" });
    });

    it("refuses a mixed patch as a whole: the guard covers every column it sets", async () => {
      const { db, calls } = sequencedDb([{ rowCount: 0 }, { rowCount: 1 }]);
      const result = await handlePatchRecord({
        body: { id: ID, status: "submitted", txHash: "Tx1", signedEnvelope: envelope },
        callerKey: "1.2.3.4",
        db,
        limiter: allow,
        log: noLog,
      });
      expect(result.status).toBe(409);
      expect(calls[0].text).toBe(
        "UPDATE allocate_rescue_record SET status = $2, signed_envelope = $3::jsonb, tx_hash = $4 " +
          "WHERE id = $1 AND (signed_envelope IS NULL OR signed_envelope = $3::jsonb) RETURNING id"
      );
    });

    it("leaves a patch without the envelope unguarded and spends no second read", async () => {
      const { db, calls } = sequencedDb([{ rowCount: 0 }]);
      const result = await handlePatchRecord({
        body: { id: ID, status: "credited" },
        callerKey: "1.2.3.4",
        db,
        limiter: allow,
        log: noLog,
      });
      expect(result.status).toBe(404);
      expect(calls).toHaveLength(1);
      expect(calls[0].text).not.toContain("signed_envelope");
    });
  });
});

// Gate 2 of 2, exercised with the validator OUT of the way. Feeding a hostile object through
// `handlePatchRecord` proves nothing about the allowlist — the validator would have stripped
// the field first — so the two gates are only two if each is checked on its own. (The database
// is a third, independent gate: 002_roles.sql grants UPDATE on exactly these four columns and
// a trigger freezes the rest, which the integration test verifies against a real Postgres.)
describe("buildPatchStatement — the allowlist, on its own", () => {
  it("emits nothing for a field that is not a lifecycle column, however it is spelled", () => {
    const { sql, values, columns } = buildPatchStatement({
      id: ID,
      status: "failed",
      msg: "tampered",
      signer_id: "mallory.near",
      signerId: "mallory.near",
      legs: [],
      created_at: 0,
      received_at: 0,
      updated_at: 0,
    } as never);

    expect(columns).toEqual(["status"]);
    expect(sql).toBe(
      "UPDATE allocate_rescue_record SET status = $2 WHERE id = $1 RETURNING id"
    );
    expect(values).toEqual([ID, "failed"]);
  });

  it("can only ever name the four columns the writer credential may update", () => {
    const { columns } = buildPatchStatement({
      id: ID,
      status: "credited",
      signedEnvelope: { standard: "nep413" },
      txHash: "Tx1",
      error: "e",
    } as never);
    expect([...columns].sort()).toEqual(["error", "signed_envelope", "status", "tx_hash"]);
  });

  // Values are parameters, never interpolated: the SET clause is built from the allowlist and
  // the caller's data only ever arrives as $n.
  it("never puts caller data in the statement text", () => {
    const { sql } = buildPatchStatement({
      id: ID,
      error: "'; DROP TABLE allocate_rescue_record; --",
    } as never);
    expect(sql).not.toContain("DROP TABLE");
    expect(sql).toContain("error = $2");
  });
});

describe("createOpsRateLimiter", () => {
  it("allows up to the ceiling and refuses past it", () => {
    const limiter = createOpsRateLimiter({ maxPerWindow: 3, now: () => 1_000 });
    expect([1, 2, 3].map(() => limiter.check("a"))).toEqual([true, true, true]);
    expect(limiter.check("a")).toBe(false);
  });

  // The write is FAIL-CLOSED, so a 429 does not degrade an Allocate — it cancels it. One
  // abusive source must therefore never be able to spend anyone else's budget.
  it("keys per caller, so one flooder cannot cancel another user's Allocate", () => {
    const limiter = createOpsRateLimiter({ maxPerWindow: 2, now: () => 1_000 });
    limiter.check("flooder");
    limiter.check("flooder");
    expect(limiter.check("flooder")).toBe(false);
    expect(limiter.check("someone-else")).toBe(true);
  });

  it("forgets a caller once its window has passed", () => {
    let now = 1_000;
    const limiter = createOpsRateLimiter({ maxPerWindow: 1, windowMs: 60_000, now: () => now });
    expect(limiter.check("a")).toBe(true);
    expect(limiter.check("a")).toBe(false);
    now += 60_001;
    expect(limiter.check("a")).toBe(true);
  });

  it("does not grow without bound when every caller is a new one", () => {
    let now = 1_000;
    const limiter = createOpsRateLimiter({ maxKeys: 2, windowMs: 60_000, now: () => now });
    expect(limiter.check("a")).toBe(true);
    expect(limiter.check("b")).toBe(true);
    expect(limiter.check("c")).toBe(false); // full, and both entries still live
    now += 60_001;
    expect(limiter.check("c")).toBe(true); // pruned on the next call
  });
});
