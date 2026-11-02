// Server-side core of the Allocate rescue record ingest (ADR-0017 §3, P-OPS v1 points 2-3).
// SERVER ONLY — never import this from a component: it reads the database credential out of
// the environment.
//
// The route handler (`src/app/api/ops/allocate-records/route.ts`) is a thin shell around this
// module, exactly like `relay-service.ts` is for `/api/relay`, so the validation, the SQL and
// the anti-spam brake are unit-testable without a database or a running server. The only
// thing injected is the `Queryable`.
//
// ⚠️ SECRET: `INTENTFOLIO_OPS_DB_URL` must NEVER get a `NEXT_PUBLIC_` prefix. Next inlines
// those into the browser bundle, which would publish a writer credential to every visitor.
//
// What this credential can and cannot do is enforced by the database, not by this file
// (`db/migrations/002_roles.sql`): it may INSERT, and it may UPDATE exactly five lifecycle
// columns. It cannot rewrite `msg`, `signer_id`, `vault_id`, `legs` or either timestamp — a
// trigger blocks that even for the owner — and nobody holds DELETE. The record is an evidence
// trail, so this module only ever adds to it.
//
// One gap the database leaves open on purpose is closed HERE instead: the grant lets the
// writer UPDATE `signed_envelope` at any time, so the database alone would let a PATCH
// replace an envelope that is already stored. This module makes it write-once (D-449) — see
// `buildPatchStatement`.

import {
  OPS_RECORD_LIMITS,
  OPS_RECORD_STATUSES,
  type CreateAllocateRecordBody,
  type OpsRecordErrorCode,
  type OpsRecordLeg,
  type OpsRecordResponseBody,
  type OpsRecordStatus,
  type PatchAllocateRecordBody,
} from "./ops-records-types";

/**
 * The slice of `pg.Pool` this service uses. Narrow on purpose: it is what lets the tests
 * exercise the real SQL against a stub, and the integration test against a real Postgres,
 * through the same code path. Mirrors the solver's `Queryable` on the read side.
 */
export interface Queryable {
  query<R>(text: string, values?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

/**
 * A pool that can also lend one connection for an explicit transaction (`BEGIN` … `COMMIT` must
 * run on the same connection). Only the history recorder needs it (plan 028-2).
 */
export interface TransactionalQueryable extends Queryable {
  connect(): Promise<Queryable & { release(err?: Error | boolean): void }>;
}

// ── Configuration ───────────────────────────────────────────────────────────────────────

export type OpsDbConfig = {
  /** Writer credential (`intentfolio_ops_writer`). See `intentfolio-solver/db/README.md`. */
  connectionString: string;
  /**
   * Resolved TLS for the pool: `false` for a loopback dev instance, `true` when the provider
   * signs with a publicly trusted CA, `{ ca }` when it signs with its own — DigitalOcean does.
   * Resolved here rather than in `createPoolConfig` so there is one place that decides.
   */
  ssl: false | true | { ca: string };
  /** Ceiling on concurrent connections per server instance. */
  maxConnections: number;
  /** Fail fast rather than hanging a signing flow behind an unreachable host. */
  connectionTimeoutMs: number;
  /** CLIENT-side query deadline. Deliberately not the server-side one — see createPoolConfig. */
  queryTimeoutMs: number;
};

export type OpsDbConfigResult =
  | { ok: true; config: OpsDbConfig }
  | { ok: false; issues: string[] };

const DEFAULT_MAX_CONNECTIONS = 3;
const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_QUERY_TIMEOUT_MS = 5_000;

/** The only hosts allowed to be reached without TLS. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * `urlVar` names the credential: the ops writer by default, or another role on the same database
 * (the history recorder's, plan 028-2). TLS and the pool limits are shared — same host.
 */
export function readOpsDbConfig(
  env: Record<string, string | undefined> = process.env,
  urlVar = "INTENTFOLIO_OPS_DB_URL"
): OpsDbConfigResult {
  const connectionString = env[urlVar]?.trim();
  if (!connectionString) return { ok: false, issues: [`missing ${urlVar}`] };
  if (!/^postgres(ql)?:\/\//.test(connectionString)) {
    return { ok: false, issues: [`${urlVar} must be a postgres:// connection string`] };
  }

  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return { ok: false, issues: [`${urlVar} is not a parseable URL`] };
  }

  // `pg` merges a parsed connection string OVER the options passed to the pool
  // (`Object.assign({}, config, parse(connectionString))`), so any `sslmode` in the URL
  // REPLACES the `ssl` object built below — silently discarding the CA and leaving
  // verification against the system trust store, which a private CA never satisfies.
  // The solver does the opposite (its URL is authoritative) because it can point
  // `sslrootcert` at a file on disk. A serverless runtime has no such file.
  if (url.searchParams.has("sslmode")) {
    return {
      ok: false,
      issues: [
        `${urlVar} must not carry sslmode: it would overwrite the TLS settings ` +
          "built from INTENTFOLIO_OPS_DB_CA and silently drop the certificate authority",
      ],
    };
  }

  const caCert = env.INTENTFOLIO_OPS_DB_CA?.trim();
  if (caCert && !caCert.includes("-----BEGIN CERTIFICATE-----")) {
    return { ok: false, issues: ["INTENTFOLIO_OPS_DB_CA must be a PEM certificate"] };
  }

  // Opt-OUT, not opt-in: a typo in the variable name must leave TLS on, not off. And the
  // opt-out is refused outright for anything but a loopback host, rather than ignored —
  // silently overriding an operator's explicit choice is how a password ends up in the clear.
  const wantsPlaintext = env.INTENTFOLIO_OPS_DB_SSL?.trim() === "false";
  if (wantsPlaintext && !LOOPBACK_HOSTS.has(url.hostname)) {
    return {
      ok: false,
      issues: [`INTENTFOLIO_OPS_DB_SSL=false is only allowed for a loopback host, not ${url.hostname}`],
    };
  }

  return {
    ok: true,
    config: {
      connectionString,
      ssl: wantsPlaintext ? false : caCert ? { ca: caCert } : true,
      maxConnections: boundedInt(env.INTENTFOLIO_OPS_DB_MAX_CONNECTIONS, DEFAULT_MAX_CONNECTIONS, 1, 20),
      connectionTimeoutMs: boundedInt(
        env.INTENTFOLIO_OPS_DB_CONNECTION_TIMEOUT_MS,
        DEFAULT_CONNECTION_TIMEOUT_MS,
        250,
        60_000
      ),
      queryTimeoutMs: boundedInt(
        env.INTENTFOLIO_OPS_DB_QUERY_TIMEOUT_MS,
        DEFAULT_QUERY_TIMEOUT_MS,
        250,
        60_000
      ),
    },
  };
}

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return fallback;
  if (parsed < min || parsed > max) return fallback;
  return parsed;
}

/**
 * The `pg` pool settings, as a plain object so the choice below is unit-testable.
 *
 * ⚠️ THE ONE THING NOT TO "FIX": there is no `statement_timeout` here, and its absence is the
 * decision, not an omission. `pg` puts `statement_timeout` into the CONNECTION STARTUP PACKET
 * when `PoolConfig` sets it. This writer reaches the database through a pooler in TRANSACTION
 * mode — that is the whole reason the frontend gets the pooled port
 * (`intentfolio-solver/db/local/pgbouncer.ini`, and the same shape at any managed provider) —
 * and a transaction-mode pooler answers an unrecognised startup parameter with
 * `FATAL: unsupported startup parameter`. That is a hard connection failure, not a
 * degradation: with fail-closed writes it would stop every Allocate.
 *
 * The other option — adding it to the pooler's `ignore_startup_parameters` — makes the
 * server-side timeout SILENTLY VANISH while the code still reads as if it had one. Between a
 * timeout that lies and no timeout at all, this picks the honest one and covers the case
 * client-side with `query_timeout` (a JS timer that also destroys the connection).
 *
 * What that costs, stated so nobody discovers it later: a statement that outlives the socket
 * keeps running on the server. At one INSERT per Allocate that is an acceptable trade; if this
 * table ever gets an expensive query, set the timeout per-transaction with `SET LOCAL` inside
 * an explicit `BEGIN`, which is the only form a transaction-mode pooler passes through safely.
 */
export function createPoolConfig(config: OpsDbConfig): Record<string, unknown> {
  return {
    connectionString: config.connectionString,
    max: config.maxConnections,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    query_timeout: config.queryTimeoutMs,
    // A serverless invocation is short-lived; do not hold a pooler slot after it.
    idleTimeoutMillis: 10_000,
    // Certificate verification stays ON in every branch — `{ ca }` adds a trust anchor, it
    // does not replace `rejectUnauthorized`. The URL must not carry sslmode, or this is
    // discarded; `readOpsDbConfig` refuses such a URL.
    ...(config.ssl === false ? {} : { ssl: config.ssl }),
  };
}

// ── Anti-spam ───────────────────────────────────────────────────────────────────────────

/**
 * A per-caller write brake. ADR-0017 §6: this endpoint needs ANTI-SPAM, not a trust boundary —
 * a forged record cannot authorise anything, because every rescue cross-checks on-chain
 * evidence before it moves funds.
 *
 * In-memory and per server instance, deliberately and with the same caveat as the relay
 * ledger: it resets on restart and is not shared across instances, so it is a brake against a
 * loop, not a quota. Keyed by caller so that one abusive source cannot lock everyone else out —
 * which matters more here than anywhere else in the app, because the write is FAIL-CLOSED:
 * a 429 does not degrade an Allocate, it cancels it. That is also why the default ceiling is
 * ~two orders of magnitude above real traffic (one INSERT plus a few PATCHes per Allocate).
 */
export type OpsRateLimiter = { check: (key: string) => boolean };

export const DEFAULT_RATE_LIMIT = { maxPerWindow: 60, windowMs: 60_000, maxKeys: 5_000 };

export function createOpsRateLimiter(
  options: Partial<typeof DEFAULT_RATE_LIMIT> & { now?: () => number } = {}
): OpsRateLimiter {
  const maxPerWindow = options.maxPerWindow ?? DEFAULT_RATE_LIMIT.maxPerWindow;
  const windowMs = options.windowMs ?? DEFAULT_RATE_LIMIT.windowMs;
  const maxKeys = options.maxKeys ?? DEFAULT_RATE_LIMIT.maxKeys;
  const now = options.now ?? Date.now;
  const hits = new Map<string, { count: number; windowStart: number }>();

  return {
    check(key: string): boolean {
      const t = now();
      // Prune expired entries before the size check, so a long-lived instance does not grow
      // without bound and a burst of one-off callers cannot evict active ones.
      for (const [k, v] of hits) {
        if (t - v.windowStart >= windowMs) hits.delete(k);
      }
      const existing = hits.get(key);
      if (existing) {
        if (existing.count >= maxPerWindow) return false;
        existing.count += 1;
        return true;
      }
      // Full table with every entry still inside its window: refuse rather than evict. This
      // is the only branch that can deny a legitimate caller, and it needs a flood of
      // distinct sources to reach.
      if (hits.size >= maxKeys) return false;
      hits.set(key, { count: 1, windowStart: t });
      return true;
    },
  };
}

const processRateLimiter = createOpsRateLimiter();

// ── Validation ──────────────────────────────────────────────────────────────────────────
//
// Mirrors the CHECK constraints of 001/003 so a malformed record gets a readable message
// instead of a raw constraint violation, and so the browser does not spend a round-trip on
// something the table would refuse. The DATABASE remains the authority: nothing here is
// tighter than the DDL, because a rule stricter than the table would reject records the
// rescue could have used.

type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Widest epoch-ms range a JS `Date` (and therefore a timestamptz) can represent. */
const MAX_EPOCH_MS = 8.64e15;

export function validateCreateBody(body: unknown): Validated<CreateAllocateRecordBody> {
  if (!body || typeof body !== "object") return bad("Body must be a JSON object");
  const b = body as Record<string, unknown>;

  if (typeof b.id !== "string" || !UUID_RE.test(b.id)) return bad("id must be a UUID");

  const signerId = b.signerId;
  if (
    typeof signerId !== "string" ||
    signerId.length < OPS_RECORD_LIMITS.signerIdMin ||
    signerId.length > OPS_RECORD_LIMITS.signerIdMax
  ) {
    return bad(
      `signerId must be ${OPS_RECORD_LIMITS.signerIdMin}-${OPS_RECORD_LIMITS.signerIdMax} characters`
    );
  }

  // The sha256 pre-image. Length is all that is checked: it is opaque bytes to this route and
  // re-serialising it anywhere would break the rescue it exists for (D-160).
  const msg = b.msg;
  if (typeof msg !== "string" || msg.length === 0 || msg.length > OPS_RECORD_LIMITS.msgMax) {
    return bad(`msg must be 1-${OPS_RECORD_LIMITS.msgMax} characters`);
  }

  const vaultId = b.vaultId;
  if (
    typeof vaultId !== "string" ||
    vaultId.length < OPS_RECORD_LIMITS.vaultIdMin ||
    vaultId.length > OPS_RECORD_LIMITS.vaultIdMax
  ) {
    return bad(
      `vaultId must be ${OPS_RECORD_LIMITS.vaultIdMin}-${OPS_RECORD_LIMITS.vaultIdMax} characters`
    );
  }

  const portfolioName = b.portfolioName;
  if (
    typeof portfolioName !== "string" ||
    portfolioName.length > OPS_RECORD_LIMITS.portfolioNameMax
  ) {
    return bad(`portfolioName must be at most ${OPS_RECORD_LIMITS.portfolioNameMax} characters`);
  }

  const legs = validateLegs(b.legs);
  if (!legs.ok) return legs;

  // The browser clock, and it is NOT sanity-checked against the server's: the two disagree by
  // design (001 says so) and `received_at` is the one to trust when ordering. Rejecting a
  // skewed clock would fail-closed an Allocate over a wrong system time.
  const createdAt = b.createdAt;
  if (
    typeof createdAt !== "number" ||
    !Number.isFinite(createdAt) ||
    Math.abs(createdAt) > MAX_EPOCH_MS
  ) {
    return bad("createdAt must be an epoch-milliseconds number");
  }

  return {
    ok: true,
    value: {
      id: b.id,
      signerId,
      msg,
      vaultId,
      portfolioName,
      legs: legs.value,
      createdAt,
    },
  };
}

function validateLegs(raw: unknown): Validated<OpsRecordLeg[]> {
  if (!Array.isArray(raw)) return bad("legs must be an array");
  if (raw.length > OPS_RECORD_LIMITS.legsMax) {
    return bad(`legs must hold at most ${OPS_RECORD_LIMITS.legsMax} entries`);
  }
  const legs: OpsRecordLeg[] = [];
  for (const [index, entry] of raw.entries()) {
    const leg = entry as Partial<OpsRecordLeg> | null;
    // Amounts are strings all the way through: base units exceed Number.MAX_SAFE_INTEGER, and
    // a number here would silently round the very quantity a rescue has to replay.
    if (!leg || typeof leg.tokenId !== "string" || typeof leg.amount !== "string") {
      return bad(`legs[${index}] must be {tokenId: string, amount: string}`);
    }
    legs.push({ tokenId: leg.tokenId, amount: leg.amount });
  }
  return { ok: true, value: legs };
}

export function validatePatchBody(body: unknown): Validated<PatchAllocateRecordBody> {
  if (!body || typeof body !== "object") return bad("Body must be a JSON object");
  const b = body as Record<string, unknown>;
  if (typeof b.id !== "string" || !UUID_RE.test(b.id)) return bad("id must be a UUID");

  const patch: PatchAllocateRecordBody = { id: b.id };

  if (b.status !== undefined) {
    if (typeof b.status !== "string" || !OPS_RECORD_STATUSES.includes(b.status as OpsRecordStatus)) {
      return bad(`status must be one of ${OPS_RECORD_STATUSES.join(", ")}`);
    }
    patch.status = b.status as OpsRecordStatus;
  }
  if (b.signedEnvelope !== undefined) {
    if (b.signedEnvelope === null || typeof b.signedEnvelope !== "object") {
      return bad("signedEnvelope must be the signed MultiPayload object");
    }
    // Deliberately tighter than the DDL's own bound (004: 131072 characters of Postgres's
    // rendering, twice this), so an oversized envelope gets a readable message here instead of
    // a raw constraint violation. Measured on the serialised form because that is what reaches
    // the column, and rejected rather than truncated: half an envelope verifies as nothing and
    // would read like tampering to the rescue tool. What this measurement cannot see is jsonb's
    // numeric expansion — see `signedEnvelopeMax`; that one only the CHECK catches.
    const serialised = JSON.stringify(b.signedEnvelope);
    if (serialised.length > OPS_RECORD_LIMITS.signedEnvelopeMax) {
      return bad(
        `signedEnvelope must serialise to at most ${OPS_RECORD_LIMITS.signedEnvelopeMax} bytes of JSON`
      );
    }
    patch.signedEnvelope = b.signedEnvelope;
  }
  if (b.txHash !== undefined) {
    if (typeof b.txHash !== "string" || b.txHash.length === 0 || b.txHash.length > 128) {
      return bad("txHash must be a non-empty string");
    }
    patch.txHash = b.txHash;
  }
  if (b.error !== undefined) {
    if (typeof b.error !== "string") return bad("error must be a string");
    // Bounded here rather than in the DDL: `error` is the one column that carries an
    // arbitrary upstream message, and the table has no DELETE to undo an oversized one.
    patch.error = b.error.slice(0, 2_000);
  }

  if (patch.status === undefined && patch.signedEnvelope === undefined &&
      patch.txHash === undefined && patch.error === undefined) {
    return bad("patch must carry at least one of status, signedEnvelope, txHash, error");
  }
  return { ok: true, value: patch };
}

function bad(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

// ── Handlers ────────────────────────────────────────────────────────────────────────────

export type HandleOpsRecordInput = {
  body: unknown;
  /** Caller identity for the anti-spam brake — the forwarded IP, or a fixed fallback. */
  callerKey: string;
  db: Queryable;
  limiter?: OpsRateLimiter;
  log?: (message: string) => void;
};

export type HandleOpsRecordOutput = { status: number; body: OpsRecordResponseBody };

const INSERT_SQL = `INSERT INTO allocate_rescue_record
    (id, signer_id, msg, vault_id, portfolio_name, legs, created_at, status)
  VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 'signing')
  ON CONFLICT (id) DO NOTHING
  RETURNING id`;

/**
 * The pre-signature INSERT. Fail-closed at the CALLER: the browser aborts the Allocate when
 * this does not return ok, because a submitted Allocate whose raw `msg` nobody kept is a
 * potentially unrecoverable orphan (ADR-0017 §4).
 *
 * `ON CONFLICT DO NOTHING` is what makes a retry after a lost response a no-op rather than a
 * duplicate: the id is the browser's `crypto.randomUUID()` and it is the primary key. The
 * conflict case answers 200 with `created: false` — the record IS there, which is the only
 * thing the caller needs to know before it signs.
 */
export async function handleCreateRecord(
  input: HandleOpsRecordInput
): Promise<HandleOpsRecordOutput> {
  const log = input.log ?? ((m: string) => console.log(m));
  const limiter = input.limiter ?? processRateLimiter;

  const validated = validateCreateBody(input.body);
  if (!validated.ok) return fail(400, "bad-request", validated.error);

  if (!limiter.check(input.callerKey)) {
    return fail(429, "too-many-requests", "Too many rescue-record writes from this caller");
  }

  const record = validated.value;
  let rowCount: number | null;
  try {
    const result = await input.db.query<{ id: string }>(INSERT_SQL, [
      record.id,
      record.signerId,
      record.msg,
      record.vaultId,
      record.portfolioName,
      JSON.stringify(record.legs),
      new Date(record.createdAt),
    ]);
    rowCount = result.rowCount;
  } catch (e) {
    // ⚠️ The message may name a column and a constraint; it must never carry the row. The
    // record holds user financial data and ADR-0017 §8 keeps it out of logs and tickets.
    const message = e instanceof Error ? e.message : String(e);
    log(`[ops] rescue-record INSERT FAILED id=${record.id}: ${message}`);
    return fail(502, "write-failed", `Could not persist the rescue record: ${message}`);
  }

  const created = (rowCount ?? 0) > 0;
  // No amounts, no name, no signer in this line — see the note above.
  log(`[ops] rescue-record ${created ? "stored" : "already present"} id=${record.id}`);
  return { status: 200, body: { ok: true, id: record.id, created } };
}

/**
 * Columns a PATCH may touch, as an allowlist that doubles as the name map. The column names
 * come from HERE and never from the request, which is what keeps the generated SET clause
 * free of anything the caller controls. The database enforces the same split independently
 * (002_roles.sql grants UPDATE on exactly these), so a bug in this map cannot widen it.
 */
const PATCHABLE_COLUMNS = {
  status: "status",
  signedEnvelope: "signed_envelope",
  txHash: "tx_hash",
  error: "error",
} as const;

/**
 * Turns a validated patch into the UPDATE statement.
 *
 * Extracted so the ALLOWLIST can be tested on its own. It is the second of two independent
 * gates — `validatePatchBody` already drops unknown keys — and two gates only count as two if
 * each is verified without the other: a test that feeds this through the validator proves
 * nothing about this function, because the validator would have stripped the field anyway.
 *
 * The column names come from `PATCHABLE_COLUMNS` and never from the request, which is what
 * keeps the generated SET clause free of anything a caller controls. The database enforces
 * the same split a third time (002_roles.sql grants UPDATE on exactly these columns, and a
 * trigger freezes the rest), so a bug here cannot widen what a compromised credential reaches.
 *
 * `updated_at` is deliberately absent: the freeze-evidence trigger sets it on every UPDATE,
 * so writing it here would only give the route a chance to disagree with the database clock.
 *
 * The envelope is WRITE-ONCE (D-449), enforced in the `WHERE` rather than in a prior read so
 * that check and write are one statement. The grant lets the writer UPDATE it whenever, and
 * this route is public on purpose (ADR-0017 §6), so without this guard anyone holding a record
 * id could overwrite a stored envelope. The solver would not be fooled — the envelope has to
 * verify against the frozen `msg` and `signer_id`, and a foreign one ends `undecided` — but it
 * would push a real record into human review on demand.
 *
 * Re-sending the SAME envelope still matches, and that is not a loophole: it is the retry
 * `patchSignedEnvelope` makes when a response is lost. Without the equality branch, a first
 * attempt that committed but timed out would come back as a conflict on the retry, and the
 * browser would abort an Allocate whose envelope is in fact stored. jsonb compares by value,
 * not by text, so a genuine resend is equal whatever order its keys arrive in.
 *
 * A patch that carries the envelope together with other fields succeeds or fails as a whole:
 * on a conflict nothing in it is written. The browser never combines them — the envelope goes
 * alone through its fail-closed call — so this only decides what a hand-made request gets.
 */
export function buildPatchStatement(patch: Record<string, unknown> & { id: string }): {
  sql: string;
  values: unknown[];
  columns: string[];
} {
  const assignments: string[] = [];
  const columns: string[] = [];
  const values: unknown[] = [patch.id];
  let where = "id = $1";
  for (const [field, column] of Object.entries(PATCHABLE_COLUMNS)) {
    const value = patch[field];
    if (value === undefined) continue;
    const isJson = field === "signedEnvelope";
    values.push(isJson ? JSON.stringify(value) : value);
    const param = `$${values.length}${isJson ? "::jsonb" : ""}`;
    assignments.push(`${column} = ${param}`);
    columns.push(column);
    if (isJson) where += ` AND (${column} IS NULL OR ${column} = ${param})`;
  }
  return {
    sql: `UPDATE allocate_rescue_record SET ${assignments.join(", ")} WHERE ${where} RETURNING id`,
    values,
    columns,
  };
}

/** Tells "no such record" from "the guard refused it" after an UPDATE that matched nothing. */
const RECORD_EXISTS_SQL = "SELECT 1 FROM allocate_rescue_record WHERE id = $1";

export async function handlePatchRecord(
  input: HandleOpsRecordInput
): Promise<HandleOpsRecordOutput> {
  const log = input.log ?? ((m: string) => console.log(m));
  const limiter = input.limiter ?? processRateLimiter;

  const validated = validatePatchBody(input.body);
  if (!validated.ok) return fail(400, "bad-request", validated.error);

  if (!limiter.check(input.callerKey)) {
    return fail(429, "too-many-requests", "Too many rescue-record writes from this caller");
  }

  const patch = validated.value;
  const { sql, values, columns } = buildPatchStatement(patch);

  let rowCount: number | null;
  try {
    const result = await input.db.query<{ id: string }>(sql, values);
    rowCount = result.rowCount;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log(`[ops] rescue-record UPDATE FAILED id=${patch.id}: ${message}`);
    return fail(502, "write-failed", `Could not update the rescue record: ${message}`);
  }

  if ((rowCount ?? 0) === 0 && patch.signedEnvelope !== undefined) {
    // Only an envelope patch can miss for two reasons, so only it pays for the second read.
    // `SELECT` is granted to the writer (002_roles.sql), and with no DELETE anywhere a row
    // cannot vanish between the two statements. The reverse can happen — a row INSERTed in
    // between reads as a conflict although its envelope is NULL — but only for a hand-made
    // request: the browser never sends an envelope for a record whose POST did not succeed.
    let exists: boolean;
    try {
      const result = await input.db.query<unknown>(RECORD_EXISTS_SQL, [patch.id]);
      exists = (result.rowCount ?? 0) > 0;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log(`[ops] rescue-record EXISTENCE CHECK FAILED after an unmatched UPDATE id=${patch.id}: ${message}`);
      return fail(502, "write-failed", `Could not update the rescue record: ${message}`);
    }
    if (exists) {
      // Not an outage and not worth an alert: any anonymous caller can provoke it. The stored
      // envelope is untouched, which is the whole point.
      log(`[ops] rescue-record UPDATE REFUSED — id=${patch.id} already holds a different envelope`);
      return fail(
        409,
        "conflict",
        `Rescue record ${patch.id} already holds a different signed envelope; it cannot be replaced`
      );
    }
  }

  if ((rowCount ?? 0) === 0) {
    // Louder than it looks: a lifecycle update for a record the table never received means an
    // Allocate is in flight with no evidence row, so the solver's worklist cannot see it. The
    // caller treats PATCH as best-effort and will not abort — this log is the only trace.
    log(`[ops] rescue-record UPDATE MISSED — no row with id=${patch.id}`);
    return fail(404, "not-found", `No rescue record with id ${patch.id}`);
  }

  log(`[ops] rescue-record updated id=${patch.id} fields=${columns.join("+")}`);
  return { status: 200, body: { ok: true, id: patch.id, updated: true } };
}

function fail(
  status: number,
  code: OpsRecordErrorCode,
  error: string
): HandleOpsRecordOutput {
  return { status, body: { ok: false, code, error } };
}
