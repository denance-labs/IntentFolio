import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchFtMetadata, _clearFtMetadataCache } from "./ft-metadata";

const RPC_URL = "https://rpc.mainnet.near.org";
const CONTRACT_ID = "token.near";

function encodeResult(obj: unknown): number[] {
  return Array.from(new TextEncoder().encode(JSON.stringify(obj)));
}

function mockRpcSuccess(result: unknown): Response {
  return new Response(
    JSON.stringify({
      result: {
        result: encodeResult(result),
        logs: [],
        block_height: 100,
        block_hash: "abc",
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function mockRpcError(message: string): Response {
  return new Response(
    JSON.stringify({ error: { code: -32000, message } }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

describe("fetchFtMetadata", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    _clearFtMetadataCache();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns a TokenDefinition built from ft_metadata", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockRpcSuccess({ name: "My Token", symbol: "MTK", decimals: 8 })
    );
    const def = await fetchFtMetadata(CONTRACT_ID, RPC_URL);
    expect(def).toMatchObject({
      id: `nep141:${CONTRACT_ID}`,
      symbol: "MTK",
      name: "My Token",
      contractId: CONTRACT_ID,
      decimals: 8,
      category: "Other",
      depositable: false,
      fallbackUsdPrice: 0,
    });
  });

  it("returns null on RPC error", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockRpcError("Server error"));
    expect(await fetchFtMetadata(CONTRACT_ID, RPC_URL)).toBeNull();
  });

  it("returns null on HTTP error", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("", { status: 500 }));
    expect(await fetchFtMetadata(CONTRACT_ID, RPC_URL)).toBeNull();
  });

  it("returns null on network error", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("Network error"));
    expect(await fetchFtMetadata(CONTRACT_ID, RPC_URL)).toBeNull();
  });

  it("serves from in-memory cache on second call without hitting RPC", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockRpcSuccess({ name: "My Token", symbol: "MTK", decimals: 8 })
    );
    const first = await fetchFtMetadata(CONTRACT_ID, RPC_URL);
    const second = await fetchFtMetadata(CONTRACT_ID, RPC_URL);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });
});
