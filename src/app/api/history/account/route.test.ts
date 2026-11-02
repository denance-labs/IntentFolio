// The transport shell of the account history read. Validation, SQL, paging and freshness are
// covered in `account-history-service.test.ts` (and against the schema in
// `account-history-db.integration.test.ts`); what is only reachable HERE is the wiring: the
// reader's credential (and the 503 without it), the server's own vault, `no-store`, the writer
// only for `expect` / `fresh` and for the pass handed to `after()` — never run before answering.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { calls, state, afterTasks } = vi.hoisted(() => ({
  calls: [] as Array<{ conn: string; text: string; values: unknown[] }>,
  state: { followed: true },
  afterTasks: [] as Array<() => unknown>,
}));

vi.mock("pg", () => ({
  Pool: class MockPool {
    constructor(private readonly config: { connectionString: string }) {}
    async query(text: string, values?: unknown[]) {
      calls.push({ conn: this.config.connectionString, text, values: values ?? [] });
      if (text.includes("FROM account_cursor") && state.followed) {
        const now = Date.now();
        return { rows: [{ backfill_done: true, last_ok_at: new Date(now - 5_000), last_run_at: new Date(now - 5_000), recorded: null }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    async end() {}
    on() {}
  },
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => unknown) => afterTasks.push(task),
}));

vi.mock("@/features/wallet/config/network", () => ({ VAULT_CONTRACT_ID: "intentfolio-vault.near", INTENTS_CONTRACT_ID: "intents.near" }));

const { follow, runPass, expectTx } = vi.hoisted(() => ({
  follow: vi.fn(async () => "followed"),
  runPass: vi.fn(async () => ({ ran: false, reason: "paced" })),
  expectTx: vi.fn(async () => ({ status: "pending" })),
}));
vi.mock("@/features/history-recorder/lib/account-recorder", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/history-recorder/lib/account-recorder")>()),
  followAccount: follow,
  runAccountPass: runPass,
  recordExpectedTx: expectTx,
}));

const READER = "postgres://reader:p@127.0.0.1:5432/intentfolio";
const WRITER = "postgres://writer:p@127.0.0.1:5432/intentfolio";
const ENV_KEYS = ["INTENTFOLIO_HISTORY_READER_DB_URL", "INTENTFOLIO_HISTORY_WRITER_DB_URL", "INTENTFOLIO_OPS_DB_SSL"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  calls.length = 0;
  afterTasks.length = 0;
  state.followed = true;
  for (const f of [follow, runPass, expectTx]) f.mockClear();
  process.env.INTENTFOLIO_HISTORY_READER_DB_URL = READER;
  process.env.INTENTFOLIO_HISTORY_WRITER_DB_URL = WRITER;
  process.env.INTENTFOLIO_OPS_DB_SSL = "false";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

const get = (query: string) => new Request(`http://localhost/api/history/account${query}`);
const connOf = (deps: unknown) => (deps as { db: { config: { connectionString: string } } }).db.config.connectionString;

describe("GET /api/history/account", () => {
  it("answers 503 without the reader's credential, uncached", async () => {
    delete process.env.INTENTFOLIO_HISTORY_READER_DB_URL;
    const { GET } = await import("./route");
    const res = await GET(get("?account=pablofork.near"));
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(calls).toHaveLength(0);
  });

  it("reads the account in the server's own vault, as the reader only, never cached", async () => {
    const { GET } = await import("./route");
    const res = await GET(get("?account=pablofork.near&vault=someone-else.near"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, events: [], next: null, loading: false, upToDate: true });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(new Set(calls.map((c) => c.conn))).toEqual(new Set([READER]));
    expect(calls[1].values.slice(0, 2)).toEqual(["intentfolio-vault.near", "pablofork.near"]);
    expect(afterTasks).toHaveLength(0);
    expect(runPass).not.toHaveBeenCalled();
  });

  it("a malformed account is a 400 with no query, uncached", async () => {
    const { GET } = await import("./route");
    const res = await GET(get("?account=Robert');DROP"));
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(calls).toHaveLength(0);
  });

  it("first visit: answers first, then follows and loads the account as the recorder", async () => {
    state.followed = false;
    const { GET } = await import("./route");
    const res = await GET(get("?account=pablofork.near"));
    expect(await res.json()).toMatchObject({ ok: true, loading: true });
    expect(follow).not.toHaveBeenCalled();
    expect(afterTasks).toHaveLength(1);

    await afterTasks[0]();
    expect(follow).toHaveBeenCalledTimes(1);
    expect(follow.mock.calls[0]).toMatchObject([expect.anything(), "pablofork.near", { capped: true }]);
    expect(runPass).toHaveBeenCalledTimes(1);
    expect(runPass.mock.calls[0]).toMatchObject([{ accountId: "pablofork.near", vaultId: "intentfolio-vault.near", budgetMs: 20_000 }]);
    expect(connOf((runPass.mock.calls[0] as unknown[])[0])).toBe(WRITER);
  });

  it("`expect` writes as the recorder before answering, and says how it went", async () => {
    const { GET } = await import("./route");
    const res = await GET(get("?account=pablofork.near&expect=67p7kFmHWXsddHomYKthabbG7Rtqxy2fjn3KxFuVMS5m"));
    expect(await res.json()).toMatchObject({ ok: true, expect: "pending" });
    expect(expectTx).toHaveBeenCalledTimes(1);
    expect(connOf((expectTx.mock.calls[0] as unknown[])[0])).toBe(WRITER);
  });
});
