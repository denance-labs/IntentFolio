import { describe, expect, it, vi } from "vitest";
import { chainRegistry } from "./chain-registry";
import { handleDepositAddress, parseChainAddresses, parseCreateResponse, RDA_BLOCKCHAIN } from "./deposit-address-service";
import { createOpsRateLimiter, type Queryable } from "@/features/vault/lib/ops-records-service";

const ACCOUNT = "alice.near";
const OTHER = "bob.near";
const SET = [
  { blockchain: "eth", address: "0xf8CcE6e8D3D2C52915B9651C6b39783cdBCD719f" },
  { blockchain: "base", address: "0xf8CcE6e8D3D2C52915B9651C6b39783cdBCD719f" },
  { blockchain: "stellar", address: "GSTELLAR", memo: "123456789" },
];
const OTHER_SET = [{ blockchain: "eth", address: "0x00000000000000000000000000000000000000b0" }];

/** The 38 `blockchain` values of a real set (0a, 2026-11-15). */
const MEASURED_BLOCKCHAINS =
  "eth near base arb xlayer monad btc ltc sol fogo ton dash doge xrp zec gnosis bera bsc pol avax op tron sui stellar aptos movement cardano bch adi scroll plasma starknet aleo hypercore hood qtc miden prl".split(" ");

function createAnswer(over: { quote?: Record<string, unknown>; quoteRequest?: Record<string, unknown>; top?: Record<string, unknown> } = {}) {
  return {
    correlationId: "a7dfb17d-eee2-44db-a17d-08ef63ee4272",
    signature: "ed25519:sig",
    timestamp: "2026-11-15T02:54:39.227Z",
    quote: {
      depositAddress: "73a1".padEnd(64, "0"),
      chainDepositAddresses: SET,
      deadline: "2038-01-04T00:00:00.000Z",
      timeWhenInactive: "2038-01-04T00:00:00.000Z",
      ...over.quote,
    },
    quoteRequest: {
      recipient: ACCOUNT,
      refundTo: ACCOUNT,
      recipientType: "INTENTS",
      refundType: "INTENTS",
      depositType: "INTENTS",
      swapType: "ANY_INPUT",
      originAsset: "1cs_v1:any",
      destinationAsset: "1cs_v1:original",
      ...over.quoteRequest,
    },
    ...over.top,
  };
}

type Row = { account_id: string; internal_account: string; chain_addresses: unknown; create_response: unknown };

/**
 * A fake table that honours what the route relies on: rows are scoped by `account_id` ($1), the
 * oldest (insert order) comes first, and the primary key is `internal_account`.
 */
function fakeDb(seed: Row[] = [], options: { count?: number; beforeReselect?: (rows: Row[]) => void; dropInsert?: boolean } = {}) {
  const rows = [...seed];
  let selects = 0;
  const db = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith("SELECT internal_account")) {
        if (selects++ === 1) options.beforeReselect?.(rows);
        const mine = rows.filter((r) => r.account_id === params[0]);
        return { rows: mine.slice(0, 1), rowCount: mine.length ? 1 : 0 };
      }
      if (sql.startsWith("SELECT count")) return { rows: [{ n: String(options.count ?? 0) }], rowCount: 1 };
      if (sql.startsWith("INSERT")) {
        if (options.dropInsert || rows.some((r) => r.internal_account === params[1])) return { rows: [], rowCount: 0 };
        rows.push({
          account_id: String(params[0]),
          internal_account: String(params[1]),
          chain_addresses: JSON.parse(String(params[2])),
          create_response: JSON.parse(String(params[4])),
        });
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected SQL ${sql}`);
    }),
  };
  return { db: db as unknown as Queryable, rows };
}

const row = (account_id: string, chain_addresses: unknown, internal_account = `${account_id}-ia`): Row => ({
  account_id,
  internal_account,
  chain_addresses,
  create_response: null,
});

const okFetch = (json: unknown = createAnswer(), status = 201) =>
  vi.fn(async () => new Response(JSON.stringify(json), { status })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

const run = (q: Record<string, string>, over: Partial<Parameters<typeof handleDepositAddress>[0]> = {}) =>
  handleDepositAddress({
    query: new URLSearchParams(q),
    callerKey: "1.2.3.4",
    db: fakeDb().db,
    partnerKey: "key",
    fetchImpl: okFetch(),
    limiter: createOpsRateLimiter(),
    createLimiter: createOpsRateLimiter(),
    attemptLimiter: createOpsRateLimiter({ maxKeys: 1 }),
    ...over,
  });

describe("RDA_BLOCKCHAIN", () => {
  it("names every chain Receive knows", () => {
    expect(Object.keys(RDA_BLOCKCHAIN).sort()).toEqual(Object.keys(chainRegistry).sort());
  });

  it("maps each to a distinct blockchain a real set carries", () => {
    const values = Object.values(RDA_BLOCKCHAIN);
    expect(new Set(values).size).toBe(values.length);
    for (const v of values) expect(MEASURED_BLOCKCHAINS, v).toContain(v);
  });
});

describe("handleDepositAddress", () => {
  it("shows the stored set without calling 1Click", async () => {
    const fetchImpl = okFetch();
    const r = await run({ account: ACCOUNT, chain: "eth:8453" }, { db: fakeDb([row(ACCOUNT, SET)]).db, fetchImpl });
    expect(r).toEqual({ status: 200, body: { ok: true, address: SET[1].address } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never shows another account's set", async () => {
    const { db, rows } = fakeDb([row(OTHER, OTHER_SET)]);
    const r = await run({ account: ACCOUNT, chain: "eth:1" }, { db });
    expect(r.body).toEqual({ ok: true, address: SET[0].address });
    expect(rows.filter((x) => x.account_id === ACCOUNT)).toHaveLength(1);
  });

  it("creates, stores (with 1Click's whole answer) and shows a set for a new account", async () => {
    const { db, rows } = fakeDb();
    const fetchImpl = okFetch();
    const r = await run({ account: ACCOUNT, chain: "eth:1" }, { db, fetchImpl });
    expect(r.body).toEqual({ ok: true, address: SET[0].address });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ account_id: ACCOUNT, internal_account: "73a1".padEnd(64, "0") });
    expect(rows[0].create_response).toMatchObject({ signature: "ed25519:sig", timestamp: "2026-11-15T02:54:39.227Z" });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v0\/quote$/);
    expect(init.redirect).toBe("error");
    expect(init.headers).toMatchObject({ "X-API-Key": "key" });
    expect(JSON.parse(String(init.body))).toMatchObject({
      dry: false,
      recipient: ACCOUNT,
      refundTo: ACCOUNT,
      recipientType: "INTENTS",
      refundType: "INTENTS",
      depositType: "INTENTS",
      swapType: "ANY_INPUT",
      originAsset: "1cs_v1:any",
      destinationAsset: "1cs_v1:original",
      deadline: "2038-01-01T00:00:00.000Z",
    });
  });

  it("shows the oldest set when a concurrent first visit stored one before ours", async () => {
    const { db } = fakeDb([], { beforeReselect: (rows) => rows.unshift(row(ACCOUNT, OTHER_SET, "older")) });
    const r = await run({ account: ACCOUNT, chain: "eth:1" }, { db });
    expect(r.body).toEqual({ ok: true, address: OTHER_SET[0].address });
  });

  it("shows nothing when the set it created did not get stored", async () => {
    const r = await run({ account: ACCOUNT, chain: "eth:1" }, { db: fakeDb([], { dropInsert: true }).db });
    expect(r).toMatchObject({ status: 503, body: { ok: false, code: "unavailable" } });
  });

  it("does not show a set whose internal account is already another account's", async () => {
    const taken = row(OTHER, OTHER_SET, "73a1".padEnd(64, "0"));
    const r = await run({ account: ACCOUNT, chain: "eth:1" }, { db: fakeDb([taken]).db });
    expect(r.status).toBe(503);
  });

  it("returns the memo with the address", async () => {
    const r = await run({ account: ACCOUNT, chain: "stellar:mainnet" }, { db: fakeDb([row(ACCOUNT, SET)]).db });
    expect(r.body).toEqual({ ok: true, address: "GSTELLAR", memo: "123456789" });
  });

  it("fails closed on a memo network without a memo", async () => {
    for (const memo of [undefined, null, ""]) {
      const r = await run({ account: ACCOUNT, chain: "stellar:mainnet" }, { db: fakeDb([row(ACCOUNT, [{ blockchain: "stellar", address: "G", memo }])]).db });
      expect(r.status, String(memo)).toBe(502);
    }
  });

  it("fails closed when the set has no entry for the network", async () => {
    const r = await run({ account: ACCOUNT, chain: "btc:mainnet" }, { db: fakeDb([row(ACCOUNT, SET)]).db });
    expect(r.status).toBe(502);
  });

  it("fails closed when 1Click refuses or throws, and stores nothing", async () => {
    const { db, rows } = fakeDb();
    expect((await run({ account: ACCOUNT, chain: "eth:1" }, { db, fetchImpl: okFetch({ message: "no" }, 400) })).status).toBe(502);
    const boom = vi.fn(async () => { throw new Error("timeout"); }) as unknown as typeof fetch;
    expect((await run({ account: ACCOUNT, chain: "eth:1" }, { db, fetchImpl: boom })).status).toBe(502);
    const notJson = vi.fn(async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    expect((await run({ account: ACCOUNT, chain: "eth:1" }, { db, fetchImpl: notJson })).status).toBe(502);
    expect(rows).toHaveLength(0);
  });

  it("does not create past the hourly cap, past this instance's attempts, nor without a key", async () => {
    const fetchImpl = okFetch();
    expect((await run({ account: ACCOUNT, chain: "eth:1" }, { db: fakeDb([], { count: 120 }).db, fetchImpl })).body).toMatchObject({ code: "busy" });
    const attempts = createOpsRateLimiter({ maxPerWindow: 1, windowMs: 3_600_000, maxKeys: 1 });
    attempts.check("all");
    expect((await run({ account: ACCOUNT, chain: "eth:1" }, { attemptLimiter: attempts, fetchImpl })).body).toMatchObject({ code: "busy" });
    expect((await run({ account: ACCOUNT, chain: "eth:1" }, { partnerKey: undefined, fetchImpl })).body).toMatchObject({ code: "not-configured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("brakes creates per caller, but not reads of a stored set", async () => {
    const createLimiter = createOpsRateLimiter({ maxPerWindow: 1, windowMs: 3_600_000 });
    expect((await run({ account: ACCOUNT, chain: "eth:1" }, { createLimiter })).status).toBe(200);
    expect((await run({ account: "carol.near", chain: "eth:1" }, { createLimiter })).body).toMatchObject({ code: "too-many-requests" });
    expect((await run({ account: OTHER, chain: "eth:1" }, { createLimiter, db: fakeDb([row(OTHER, OTHER_SET)]).db })).status).toBe(200);
  });

  it("validates the account and the chain", async () => {
    expect((await run({ account: "0xABC", chain: "eth:1" })).status).toBe(400);
    expect((await run({ account: "Alice.near", chain: "eth:1" })).status).toBe(400);
    expect((await run({ account: ACCOUNT, chain: "eth:999" })).status).toBe(400);
    expect((await run({ account: ACCOUNT, chain: "constructor" })).status).toBe(400);
    expect((await run({ account: ACCOUNT, chain: "toString" })).status).toBe(400);
    expect((await run({ chain: "eth:1" })).status).toBe(400);
  });

  it("rate limits a caller", async () => {
    const limiter = createOpsRateLimiter({ maxPerWindow: 1 });
    const db = fakeDb([row(ACCOUNT, SET)]).db;
    expect((await run({ account: ACCOUNT, chain: "eth:1" }, { db, limiter })).status).toBe(200);
    expect((await run({ account: ACCOUNT, chain: "eth:1" }, { db, limiter })).status).toBe(429);
  });
});

describe("parseCreateResponse", () => {
  it("accepts the measured shape, for named, 0x and 64-hex accounts", () => {
    for (const account of [ACCOUNT, "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", "d0".repeat(32)]) {
      const r = parseCreateResponse(account, createAnswer({ quoteRequest: { recipient: account, refundTo: account } }));
      expect(r.ok, account).toBe(true);
    }
  });

  it.each([
    ["another recipient", { quoteRequest: { recipient: OTHER } }],
    ["another refund", { quoteRequest: { refundTo: OTHER } }],
    ["a confidential balance", { quoteRequest: { recipientType: "CONFIDENTIAL_INTENTS" } }],
    ["refund elsewhere", { quoteRequest: { refundType: "ORIGIN_CHAIN" } }],
    ["another deposit type", { quoteRequest: { depositType: "ORIGIN_CHAIN" } }],
    ["another swap type", { quoteRequest: { swapType: "EXACT_INPUT" } }],
    ["another origin", { quoteRequest: { originAsset: "nep141:wrap.near" } }],
    ["a converted destination", { quoteRequest: { destinationAsset: "nep141:wrap.near" } }],
    ["a deadline that expires soon", { quote: { deadline: "2026-11-16T00:00:00.000Z" } }],
    ["no deadline", { quote: { deadline: undefined } }],
    ["going inactive soon", { quote: { timeWhenInactive: "2026-11-16T00:00:00.000Z" } }],
    ["no internal account", { quote: { depositAddress: undefined } }],
    ["no set", { quote: { chainDepositAddresses: [] } }],
    ["a broken entry for a network we serve", { quote: { chainDepositAddresses: [{ blockchain: "eth" }] } }],
    ["no quote", { top: { quote: undefined } }],
    ["no echo", { top: { quoteRequest: undefined } }],
  ])("refuses %s", (_label, over) => {
    expect(parseCreateResponse(ACCOUNT, createAnswer(over as Parameters<typeof createAnswer>[0])).ok).toBe(false);
  });
});

describe("parseChainAddresses", () => {
  it("ignores entries of networks Receive does not serve, and treats a null or empty memo as none", () => {
    const set = [
      { blockchain: "hypercore", address: "" },
      { blockchain: "brand-new-chain", address: { odd: true } },
      { blockchain: "ton", address: "UQton", memo: null },
      { blockchain: "xrp", address: "rXrp", memo: "" },
      ...SET,
    ];
    expect(parseChainAddresses(set)).toEqual([
      { blockchain: "ton", address: "UQton" },
      { blockchain: "xrp", address: "rXrp" },
      ...SET,
    ]);
  });
});
