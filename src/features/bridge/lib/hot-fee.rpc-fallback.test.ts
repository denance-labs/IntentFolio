import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultEvmGas } from "./hot-fee";

// D-383 / D-207: the destination chain's gas price is read from an ORDERED list of endpoints.
// A tester's DNS answered a loopback for the first Polygon endpoint (s200); the fee lookup must
// move to the next one instead of blocking the withdrawal.

const PUBLICNODE = "https://polygon-bor-rpc.publicnode.com";
const ZAN = "https://api.zan.top/polygon-mainnet";

function rpcAnswer(body: string): Response {
  const { id, method } = JSON.parse(body) as { id: number; method: string };
  const result = method === "eth_gasPrice" ? "0x41b757cbfe" : "0x10";
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("defaultEvmGas — endpoint fallback", () => {
  it("reads Polygon gas from the backup when the first endpoint cannot be reached", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      if (String(url).startsWith(PUBLICNODE)) throw new TypeError("fetch failed");
      return rpcAnswer(init.body as string);
    });
    vi.stubGlobal("fetch", fetchMock);

    const gas = await defaultEvmGas("eth:137");

    expect(gas).toEqual({ gasPriceWei: BigInt("0x41b757cbfe"), blockNumber: BigInt(16) });
    const hosts = fetchMock.mock.calls.map(([url]) => String(url));
    expect(hosts.some((u) => u.startsWith(PUBLICNODE))).toBe(true);
    expect(hosts.some((u) => u.startsWith(ZAN))).toBe(true);
  });

  it("fails closed when every endpoint is down — no gas price, no quote", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(defaultEvmGas("eth:137")).rejects.toThrow();
  });

  it("uses the first endpoint alone when it answers", async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => rpcAnswer(init.body as string));
    vi.stubGlobal("fetch", fetchMock);

    await defaultEvmGas("eth:137");

    expect(fetchMock.mock.calls.every(([url]) => String(url).startsWith(PUBLICNODE))).toBe(true);
  });

  // The 2026-08 outage was an HTTP 401 ("API key disabled"), not a network error.
  it.each([
    ["an HTTP 401", () => new Response(JSON.stringify({ error: "API key disabled" }), { status: 401 })],
    [
      "a JSON-RPC error with no result",
      () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "limit" } }), { status: 200 }),
    ],
  ])("moves to the backup on %s from the first endpoint", async (_label, bad) => {
    const fetchMock = vi.fn().mockImplementation(async (url: string, init: RequestInit) =>
      String(url).startsWith(PUBLICNODE) ? bad() : rpcAnswer(init.body as string)
    );
    vi.stubGlobal("fetch", fetchMock);

    const gas = await defaultEvmGas("eth:137");
    expect(gas.gasPriceWei).toBe(BigInt("0x41b757cbfe"));
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith(ZAN))).toBe(true);
  });

  it("an env override goes first and keeps the defaults behind it", async () => {
    vi.stubEnv("NEXT_PUBLIC_EVM_RPC_POLYGON", "https://custom.example/polygon");
    vi.resetModules();
    const { defaultEvmGas: fresh } = await import("./hot-fee");
    const fetchMock = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      if (String(url).startsWith("https://custom.example")) throw new TypeError("fetch failed");
      return rpcAnswer(init.body as string);
    });
    vi.stubGlobal("fetch", fetchMock);

    await fresh("eth:137");
    const hosts = fetchMock.mock.calls.map(([url]) => String(url));
    expect(hosts[0]).toMatch(/^https:\/\/custom\.example/);
    expect(hosts.some((u) => u.startsWith(PUBLICNODE))).toBe(true);
  });
});
