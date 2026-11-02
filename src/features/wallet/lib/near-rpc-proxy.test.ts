import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ALLOWED_VIEW_METHODS,
  DEFAULT_PRIMARY_RPC_URL,
  FALLBACK_RPC_URL,
  HEAD_CHECK_INTERVAL_MS,
  MAX_BODY_BYTES,
  MAX_HEAD_LAG_MS,
  createPrimaryHeadWatch,
  handleNearRpcRequest,
  readNearRpcConfig,
  refuseByHeaders,
  validateNearRpcRequest,
  type NearRpcConfig,
} from "./near-rpc-proxy";
import { BROWSER_RPC_URL } from "../config/network";
import { viewCall } from "@/features/vault/lib/near-view";

const KEY = "k3y-that-must-never-leak";
const PRIMARY_URL = "https://rpc.primary.example";

const bothUpstreams: NearRpcConfig = readNearRpcConfig({
  NEAR_RPC_API_KEY: KEY,
  NEAR_RPC_PRIMARY_URL: PRIMARY_URL,
});

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");

function callFunction(methodName: string, accountId = "intents.near") {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: "q",
    method: "query",
    params: {
      request_type: "call_function",
      account_id: accountId,
      method_name: methodName,
      args_base64: b64({}),
      finality: "final",
    },
  });
}

const rpcResult = (result: unknown) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: "q", result }), { status: 200 });

const rpcError = (name: string, top = "HANDLER_ERROR") =>
  new Response(
    JSON.stringify({ jsonrpc: "2.0", id: "q", error: { code: -32000, name: top, cause: { name } } }),
    { status: 200 }
  );

/** What the proxy actually sent upstream on call `n`. */
const forwarded = (fetchImpl: ReturnType<typeof fakeFetch>, n = 0) =>
  JSON.parse((fetchImpl.mock.calls[n][1] as RequestInit).body as string);

type Route = (url: string, init: RequestInit) => Response | Promise<Response>;

/** A fetch whose behaviour is chosen per upstream URL; records every call. */
function fakeFetch(routes: Record<string, Route>) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const route = routes[url];
    if (!route) throw new Error(`unexpected upstream ${url}`);
    return route(url, init ?? {});
  });
}

const timeout = () => {
  throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
};

describe("readNearRpcConfig", () => {
  it("without a key, uses FastNEAR only (Preview and keyless local runs keep working)", () => {
    expect(readNearRpcConfig({}).upstreams).toEqual([
      { role: "fallback", url: FALLBACK_RPC_URL, headers: {} },
    ]);
    expect(readNearRpcConfig({ NEAR_RPC_API_KEY: "   " }).upstreams).toHaveLength(1);
  });

  it("with a key, puts the primary first with X-API-Key and FastNEAR second", () => {
    expect(readNearRpcConfig({ NEAR_RPC_API_KEY: KEY }).upstreams).toEqual([
      { role: "primary", url: DEFAULT_PRIMARY_RPC_URL, headers: { "X-API-Key": KEY } },
      { role: "fallback", url: FALLBACK_RPC_URL, headers: {} },
    ]);
  });

  it("an empty NEAR_RPC_PRIMARY_URL falls back to the default URL instead of becoming it", () => {
    const [primary] = readNearRpcConfig({ NEAR_RPC_API_KEY: KEY, NEAR_RPC_PRIMARY_URL: "" }).upstreams;
    expect(primary.url).toBe(DEFAULT_PRIMARY_RPC_URL);
  });

  it("an unparseable NEAR_RPC_PRIMARY_URL drops the primary (FastNEAR keeps serving) and never logs the value", () => {
    const lines: string[] = [];
    const bad = `rpc.metapool.app?key=${KEY}`;
    const config = readNearRpcConfig({ NEAR_RPC_API_KEY: KEY, NEAR_RPC_PRIMARY_URL: bad }, (l) => lines.push(l));
    expect(config.upstreams).toEqual([{ role: "fallback", url: FALLBACK_RPC_URL, headers: {} }]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/NEAR_RPC_PRIMARY_URL is not a valid https URL/);
    expect(lines[0]).not.toContain(KEY);
  });

  it.each([
    ["plain http (the key would travel in the clear)", "http://rpc.metapool.app"],
    ["host:port without a scheme (parses as a scheme)", "rpc.metapool.app:443"],
  ])("drops a primary URL that is %s", (_label, url) => {
    const config = readNearRpcConfig({ NEAR_RPC_API_KEY: KEY, NEAR_RPC_PRIMARY_URL: url }, () => {});
    expect(config.upstreams.map((u) => u.role)).toEqual(["fallback"]);
  });
});

describe("refuseByHeaders — only the app's own pages", () => {
  const headers = (h: Record<string, string>) => new Headers(h);

  it("lets through what the app's readers send", () => {
    expect(refuseByHeaders(headers({ "content-type": "application/json" }))).toBeNull();
    expect(
      refuseByHeaders(headers({ "content-type": "application/json; charset=utf-8", "sec-fetch-site": "same-origin" }))
    ).toBeNull();
  });

  it.each([
    ["no content-type", {}, 415],
    ["text/plain (a CORS simple request, no preflight)", { "content-type": "text/plain" }, 415],
    ["form data", { "content-type": "application/x-www-form-urlencoded" }, 415],
    ["another site", { "content-type": "application/json", "sec-fetch-site": "cross-site" }, 403],
    ["a sibling subdomain", { "content-type": "application/json", "sec-fetch-site": "same-site" }, 403],
  ] as const)("refuses %s", (_label, h, status) => {
    const out = refuseByHeaders(headers(h));
    expect(out).toMatchObject({ status, upstream: null });
  });
});

describe("validateNearRpcRequest — the allowlist", () => {
  it.each([
    ["call_function on an allowed method", callFunction("current_salt")],
    [
      "view_account",
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "query",
        params: { request_type: "view_account", account_id: "a.near", finality: "final" },
      }),
    ],
    [
      "tx",
      JSON.stringify({
        jsonrpc: "2.0",
        id: "tx",
        method: "tx",
        params: { tx_hash: "H", sender_account_id: "intents.near", wait_until: "EXECUTED_OPTIMISTIC" },
      }),
    ],
  ])("accepts %s", (_label, body) => {
    expect(validateNearRpcRequest(body).ok).toBe(true);
  });

  it.each([
    ["a send method", { method: "send_tx", params: { signed_tx_base64: "x" } }],
    ["broadcast_tx_commit", { method: "broadcast_tx_commit", params: ["x"] }],
    ["block (not a read the app makes)", { method: "block", params: { finality: "final" } }],
    ["view_access_key_list", { method: "query", params: { request_type: "view_access_key_list", account_id: "a.near" } }],
    ["view_code", { method: "query", params: { request_type: "view_code", account_id: "a.near" } }],
    [
      "a call_function outside the allowlist",
      { method: "query", params: { request_type: "call_function", account_id: "x.near", method_name: "get_everything", args_base64: "" } },
    ],
    ["params as an array", { method: "query", params: ["call_function/intents.near/current_salt", ""] }],
    ["tx without sender", { method: "tx", params: { tx_hash: "H" } }],
    // Raw storage reads went with the staging vault's seal read (D-366): the views replace them.
    [
      "view_state, the vault's included",
      { method: "query", params: { request_type: "view_state", account_id: "intentfolio-vault.near", prefix_base64: "AA==" } },
    ],
    [
      "an unknown finality",
      { method: "query", params: { request_type: "view_account", account_id: "a.near", finality: "whatever" } },
    ],
    [
      "a block_id that is neither hash nor height",
      { method: "query", params: { request_type: "view_account", account_id: "a.near", block_id: { x: 1 } } },
    ],
    ["an unknown wait_until", { method: "tx", params: { tx_hash: "H", sender_account_id: "a.near", wait_until: "FOREVER" } }],
  ])("refuses %s", (_label, request) => {
    const result = validateNearRpcRequest(JSON.stringify({ jsonrpc: "2.0", id: 1, ...request }));
    expect(result.ok).toBe(false);
  });

  it("fits a balance batch over 150 token ids (the registry has 64, ~4.4 KB)", () => {
    const ids = Array.from({ length: 150 }, (_, i) => `nep141:${i.toString(16).padStart(64, "0")}`);
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: "q",
      method: "query",
      params: {
        request_type: "call_function",
        account_id: "intents.near",
        method_name: "mt_batch_balance_of",
        args_base64: b64({ account_id: "a".repeat(64), token_ids: ids }),
        finality: "final",
      },
    });
    expect(validateNearRpcRequest(body).ok).toBe(true);
  });

  it("refuses a batch, non-JSON and a wrong jsonrpc version", () => {
    expect(validateNearRpcRequest(JSON.stringify([JSON.parse(callFunction("current_salt"))])).ok).toBe(false);
    expect(validateNearRpcRequest("not json").ok).toBe(false);
    expect(validateNearRpcRequest(callFunction("current_salt").replace('"2.0"', '"1.0"')).ok).toBe(false);
  });
});

describe("handleNearRpcRequest", () => {
  it("serves from the primary with the key attached, and says so", async () => {
    const fetchImpl = fakeFetch({ [PRIMARY_URL]: () => rpcResult({ result: [1] }) });
    const out = await handleNearRpcRequest(callFunction("current_salt"), { config: bothUpstreams, fetchImpl });

    expect(out).toMatchObject({ status: 200, upstream: "primary" });
    expect(JSON.parse(out.body).result).toEqual({ result: [1] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["X-API-Key"]).toBe(KEY);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("never sends the key to the fallback", async () => {
    const fetchImpl = fakeFetch({
      [PRIMARY_URL]: timeout,
      [FALLBACK_RPC_URL]: () => rpcResult("ok"),
    });
    await handleNearRpcRequest(callFunction("current_salt"), { config: bothUpstreams, fetchImpl, log: () => {} });
    const fallbackInit = fetchImpl.mock.calls[1][1] as RequestInit;
    expect(JSON.stringify(fallbackInit.headers)).not.toContain(KEY);
  });

  it.each([
    ["a timeout", timeout, /timeout after 1500ms/],
    ["a network error", () => { throw new TypeError("fetch failed"); }, /network error/],
    ["401 (revoked key)", () => new Response("Unauthorized", { status: 401 }), /http 401/],
    ["429", () => new Response("{}", { status: 429 }), /http 429/],
    ["503", () => new Response("down", { status: 503 }), /http 503/],
    ["a 200 that is not JSON", () => new Response("<html>", { status: 200 }), /not JSON/],
    ["a 200 without result or error", () => new Response("{\"jsonrpc\":\"2.0\"}", { status: 200 }), /not a JSON-RPC envelope/],
  ] as const)("falls back to FastNEAR on %s, and logs why", async (_label, primary, reason) => {
    const lines: string[] = [];
    const fetchImpl = fakeFetch({ [PRIMARY_URL]: primary, [FALLBACK_RPC_URL]: () => rpcResult("from-fastnear") });
    const out = await handleNearRpcRequest(callFunction("current_salt"), {
      config: bothUpstreams,
      fetchImpl,
      log: (l) => lines.push(l),
    });

    expect(out).toMatchObject({ status: 200, upstream: "fallback" });
    expect(JSON.parse(out.body).result).toBe("from-fastnear");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(reason);
    expect(lines[0]).toContain("rpc.primary.example");
    expect(lines[0]).not.toContain(KEY);
  });

  it("forwards only the fields it validated", async () => {
    const fetchImpl = fakeFetch({ [PRIMARY_URL]: () => rpcResult({}) });
    const tx = JSON.stringify({
      jsonrpc: "2.0",
      id: "tx",
      method: "tx",
      params: { tx_hash: "H", sender_account_id: "a.near", wait_until: "FINAL", signed_tx_base64: "EVIL" },
      extra: 1,
    });
    await handleNearRpcRequest(tx, { config: bothUpstreams, fetchImpl });
    expect(forwarded(fetchImpl)).toEqual({
      jsonrpc: "2.0",
      id: "tx",
      method: "tx",
      params: { tx_hash: "H", sender_account_id: "a.near", wait_until: "FINAL" },
    });

    const query = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "query",
      params: { request_type: "view_account", account_id: "a.near", finality: "final", method_name: "x", prefix_base64: "" },
    });
    await handleNearRpcRequest(query, { config: bothUpstreams, fetchImpl });
    expect(forwarded(fetchImpl, 1).params).toEqual({ request_type: "view_account", account_id: "a.near", finality: "final" });
  });

  it.each([
    ["NO_SYNCED_BLOCKS", "HANDLER_ERROR"],
    ["UNAVAILABLE_SHARD", "HANDLER_ERROR"],
    ["NOT_SYNCED_YET", "HANDLER_ERROR"],
    ["TIMEOUT_ERROR", "HANDLER_ERROR"],
    ["INTERNAL_ERROR", "INTERNAL_ERROR"],
  ])("falls back on a sick-node error: %s", async (cause, top) => {
    const lines: string[] = [];
    const fetchImpl = fakeFetch({ [PRIMARY_URL]: () => rpcError(cause, top), [FALLBACK_RPC_URL]: () => rpcResult("ok") });
    const out = await handleNearRpcRequest(callFunction("current_salt"), {
      config: bothUpstreams,
      fetchImpl,
      log: (l) => lines.push(l),
    });
    expect(out.upstream).toBe("fallback");
    expect(lines[0]).toMatch(new RegExp(`node error ${cause}`));
  });

  it("passes a sick-node error through when the last upstream sends it too", async () => {
    const fetchImpl = fakeFetch({
      [PRIMARY_URL]: () => rpcError("NO_SYNCED_BLOCKS"),
      [FALLBACK_RPC_URL]: () => rpcError("UNAVAILABLE_SHARD"),
    });
    const out = await handleNearRpcRequest(callFunction("current_salt"), { config: bothUpstreams, fetchImpl, log: () => {} });
    expect(out).toMatchObject({ status: 200, upstream: null });
    expect(JSON.parse(out.body).error.cause.name).toBe("UNAVAILABLE_SHARD");
  });

  it("does NOT fall back on a JSON-RPC error: UNKNOWN_ACCOUNT is an answer (accountExists depends on it)", async () => {
    const fetchImpl = fakeFetch({
      [PRIMARY_URL]: () => rpcError("UNKNOWN_ACCOUNT"),
      [FALLBACK_RPC_URL]: () => rpcResult({ amount: "1" }),
    });
    const out = await handleNearRpcRequest(callFunction("current_salt"), { config: bothUpstreams, fetchImpl });

    expect(out.upstream).toBe("primary");
    expect(JSON.parse(out.body).error.cause.name).toBe("UNKNOWN_ACCOUNT");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives tx a longer primary budget than query", async () => {
    const lines: string[] = [];
    const fetchImpl = fakeFetch({ [PRIMARY_URL]: timeout, [FALLBACK_RPC_URL]: () => rpcResult({}) });
    const tx = JSON.stringify({
      jsonrpc: "2.0",
      id: "tx",
      method: "tx",
      params: { tx_hash: "H", sender_account_id: "intents.near", wait_until: "EXECUTED_OPTIMISTIC" },
    });
    await handleNearRpcRequest(tx, { config: bothUpstreams, fetchImpl, log: (l) => lines.push(l) });
    expect(lines[0]).toMatch(/timeout after 4000ms/);
  });

  it("without a key, goes straight to FastNEAR", async () => {
    const fetchImpl = fakeFetch({ [FALLBACK_RPC_URL]: () => rpcResult("x") });
    const out = await handleNearRpcRequest(callFunction("current_salt"), { config: readNearRpcConfig({}), fetchImpl });
    expect(out.upstream).toBe("fallback");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("passes the last upstream's HTTP error through when every upstream fails", async () => {
    const fetchImpl = fakeFetch({
      [PRIMARY_URL]: timeout,
      [FALLBACK_RPC_URL]: () => new Response("{\"err\":1}", { status: 429 }),
    });
    const out = await handleNearRpcRequest(callFunction("current_salt"), { config: bothUpstreams, fetchImpl, log: () => {} });
    expect(out).toMatchObject({ status: 429, upstream: null });
  });

  it("answers 502 when no upstream answered at all", async () => {
    const fetchImpl = fakeFetch({ [PRIMARY_URL]: timeout, [FALLBACK_RPC_URL]: timeout });
    const out = await handleNearRpcRequest(callFunction("current_salt"), { config: bothUpstreams, fetchImpl, log: () => {} });
    expect(out).toMatchObject({ status: 502, upstream: null });
    expect(JSON.parse(out.body).error.message).toMatch(/no RPC upstream answered/);
  });

  it("refuses before touching any upstream: 400 for a disallowed request, 413 for a large body", async () => {
    const fetchImpl = fakeFetch({});
    const refused = await handleNearRpcRequest(callFunction("get_everything"), { config: bothUpstreams, fetchImpl });
    expect(refused).toMatchObject({ status: 400, upstream: null });
    expect(JSON.parse(refused.body).error.message).toMatch(/view method not allowed: get_everything/);

    const big = callFunction("current_salt").replace('"final"', `"${"x".repeat(MAX_BODY_BYTES)}"`);
    expect((await handleNearRpcRequest(big, { config: bothUpstreams, fetchImpl })).status).toBe(413);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never echoes the key in any response body", async () => {
    const fetchImpl = fakeFetch({ [PRIMARY_URL]: timeout, [FALLBACK_RPC_URL]: timeout });
    const out = await handleNearRpcRequest(callFunction("current_salt"), { config: bothUpstreams, fetchImpl, log: () => {} });
    expect(out.body).not.toContain(KEY);
  });
});

// D-331: a primary that stops advancing but keeps answering is skipped, without the check ever
// sitting in front of a request.
describe("handleNearRpcRequest — the primary's head check", () => {
  const T0 = 1_800_000_000_000;

  /** A primary whose `final` head is `lagMs` behind `clock.now`; reads answer normally. */
  function primary(clock: { now: number; lagMs: number }, head: Route | null = null): Route {
    return (url, init) => {
      if (JSON.parse(init.body as string).method !== "block") return rpcResult("from-primary");
      if (head) return head(url, init);
      const nanos = (BigInt(clock.now - clock.lagMs) * BigInt(1_000_000)).toString();
      return rpcResult({ header: { height: 1, timestamp_nanosec: nanos } });
    };
  }
  const headCalls = (fetchImpl: ReturnType<typeof fakeFetch>) =>
    fetchImpl.mock.calls.filter((c) => JSON.parse((c[1] as RequestInit).body as string).method === "block");

  function setup(lagMs: number, head: Route | null = null) {
    const clock = { now: T0, lagMs };
    const lines: string[] = [];
    const fetchImpl = fakeFetch({ [PRIMARY_URL]: primary(clock, head), [FALLBACK_RPC_URL]: () => rpcResult("from-fastnear") });
    const headWatch = createPrimaryHeadWatch();
    const ask = () =>
      handleNearRpcRequest(callFunction("current_salt"), {
        config: bothUpstreams,
        fetchImpl,
        log: (l) => lines.push(l),
        headWatch,
        now: () => clock.now,
      });
    return { clock, lines, fetchImpl, headWatch, ask };
  }

  it("keeps serving from a primary whose head is a few seconds behind", async () => {
    const { headWatch, ask, lines } = setup(3_000);
    await ask();
    await headWatch.inFlight;
    expect((await ask()).upstream).toBe("primary");
    expect(lines).toEqual([]);
  });

  it("skips a frozen primary once the check has seen it, and says so once", async () => {
    const { headWatch, ask, lines, fetchImpl } = setup(MAX_HEAD_LAG_MS + 60_000);
    // The first request does not wait for the verdict.
    expect((await ask()).upstream).toBe("primary");
    await headWatch.inFlight;
    expect(headWatch.lagging).toBe(true);

    const before = fetchImpl.mock.calls.length;
    const out = await ask();
    expect(out.upstream).toBe("fallback");
    expect(JSON.parse(out.body).result).toBe("from-fastnear");
    // Straight to FastNEAR: no read on the primary, no second check inside the interval.
    expect(fetchImpl.mock.calls.slice(before).map((c) => String(c[0]))).toEqual([FALLBACK_RPC_URL]);
    await ask();
    expect(lines).toEqual(["[near-rpc] primary rpc.primary.example head is 120s behind — skipping it"]);
    expect(lines.join()).not.toContain(KEY);
  });

  it("checks again after the interval and returns to the primary once it caught up", async () => {
    const { clock, headWatch, ask, lines } = setup(MAX_HEAD_LAG_MS + 60_000);
    await ask();
    await headWatch.inFlight;

    clock.lagMs = 2_000;
    clock.now += HEAD_CHECK_INTERVAL_MS - 1;
    await ask();
    expect(headWatch.inFlight).toBeNull();

    clock.now += 1;
    expect((await ask()).upstream).toBe("fallback");
    await headWatch.inFlight;
    expect((await ask()).upstream).toBe("primary");
    expect(lines.at(-1)).toBe("[near-rpc] primary rpc.primary.example head caught up — using it again");
  });

  it("reads the head at most once per interval, with the key, however many requests arrive", async () => {
    const { clock, ask, fetchImpl } = setup(3_000);
    await Promise.all([ask(), ask(), ask()]);
    clock.now += HEAD_CHECK_INTERVAL_MS / 2;
    await ask();
    expect(headCalls(fetchImpl)).toHaveLength(1);
    expect((headCalls(fetchImpl)[0][1] as RequestInit).headers).toMatchObject({ "X-API-Key": KEY });
  });

  it.each([
    ["times out", timeout],
    ["answers 401", () => new Response("Unauthorized", { status: 401 })],
    ["answers without a header", () => rpcResult({})],
  ] as const)("a check that %s changes nothing", async (_label, head) => {
    const { headWatch, ask } = setup(0, head);
    headWatch.lagging = true;
    await ask();
    await headWatch.inFlight;
    expect(headWatch.lagging).toBe(true);
  });

  it("never skips the only upstream, and checks nothing without a primary", async () => {
    const onlyPrimary: NearRpcConfig = { upstreams: bothUpstreams.upstreams.filter((u) => u.role === "primary") };
    const headWatch = { ...createPrimaryHeadWatch(), lagging: true };
    const fetchImpl = fakeFetch({ [PRIMARY_URL]: primary({ now: T0, lagMs: MAX_HEAD_LAG_MS * 2 }) });
    const out = await handleNearRpcRequest(callFunction("current_salt"), {
      config: onlyPrimary, fetchImpl, log: () => {}, headWatch, now: () => T0,
    });
    expect(out.upstream).toBe("primary");

    const keyless = fakeFetch({ [FALLBACK_RPC_URL]: () => rpcResult("x") });
    await handleNearRpcRequest(callFunction("current_salt"), {
      config: readNearRpcConfig({}), fetchImpl: keyless, headWatch: createPrimaryHeadWatch(),
    });
    expect(keyless).toHaveBeenCalledTimes(1);
  });
});

// STRUCTURAL guard: it reads source text. A view method called from the browser but missing
// from ALLOWED_VIEW_METHODS would fail in production with HTTP 400 and nothing else in the suite
// would notice — so the allowlist is checked against every call site. The inverse check keeps
// the list from accumulating methods nobody reads any more.
describe("ALLOWED_VIEW_METHODS matches the call sites", () => {
  const SRC = resolve(__dirname, "../../..");

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
  }

  const PATTERNS = [
    /viewCall\s*(?:<[^>(]*(?:<[^>]*>[^>(]*)*>)?\(\s*[\w.]+,\s*"([a-z0-9_]+)"/g,
    /vaultView\s*(?:<[^>(]*(?:<[^>]*>[^>(]*)*>)?\(\s*"([a-z0-9_]+)"/g,
    /method_name:\s*"([a-z0-9_]+)"/g,
  ];

  const called = new Set<string>();
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const pattern of PATTERNS) for (const m of text.matchAll(pattern)) called.add(m[1]);
  }

  it("BROWSER_RPC_URL is the route that serves this proxy", () => {
    expect(existsSync(join(SRC, "app", BROWSER_RPC_URL, "route.ts"))).toBe(true);
  });

  it("viewCall refuses, at compile time, a method the route would refuse (checked by tsc)", () => {
    // @ts-expect-error — "get_everything" is not in ALLOWED_VIEW_METHODS
    const call = () => viewCall("x.near", "get_everything");
    expect(call).toBeTypeOf("function");
  });

  // The browser must read through BROWSER_RPC_URL. A reader that goes back to an RPC host
  // would silently skip the keyed primary and its fallback.
  it("no browser reader uses RPC_ENDPOINTS or a hardcoded NEAR RPC host", () => {
    const RPC_HOST = /https?:\/\/[^"'`\s/]*rpc[^"'`\s/]*/g;
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = file.slice(SRC.length + 1);
      const text = readFileSync(file, "utf8");
      // Allowed: the config (near-connect's public list), near-connect's provider, this proxy.
      if (/import[^;]*\bRPC_ENDPOINTS\b/.test(text) && rel !== "features/wallet/adapter/near-wallet-provider.tsx") {
        offenders.push(`${rel}: imports RPC_ENDPOINTS`);
      }
      for (const [url] of text.matchAll(RPC_HOST)) {
        if (!/near|fastnear|metapool/.test(url)) continue;
        if (["features/wallet/config/network.ts", "features/wallet/lib/near-rpc-proxy.ts"].includes(rel)) continue;
        offenders.push(`${rel}: ${url}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("finds the call sites at all (guards against a scan that silently matches nothing)", () => {
    expect(called.size).toBeGreaterThanOrEqual(15);
  });

  it("every method the app reads is allowed", () => {
    expect([...called].filter((m) => !ALLOWED_VIEW_METHODS.has(m))).toEqual([]);
  });

  it("every allowed method is still read somewhere", () => {
    expect([...ALLOWED_VIEW_METHODS].filter((m) => !called.has(m))).toEqual([]);
  });
});
