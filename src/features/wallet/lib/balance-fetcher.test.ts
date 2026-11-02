import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchNativeNearBalance,
  fetchNearAccountState,
  fetchFtBalance,
  fetchMtBalance,
  fetchMtBatchBalance,
  fetchNearUnified,
} from "./balance-fetcher";

const RPC_URL = "https://rpc.mainnet.near.org";
const ACCOUNT_ID = "alice.near";
const CONTRACT_ID = "token.near";

function mockRpcResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fetchNativeNearBalance", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("returns balance as bigint", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockRpcResponse({ result: { amount: "1000000000000000000000000" } })
    );
    expect(await fetchNativeNearBalance(ACCOUNT_ID, RPC_URL)).toBe(
      BigInt("1000000000000000000000000")
    );
  });

  it("throws on RPC error response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockRpcResponse({ error: { code: -32000, message: "Server error" } })
    );
    await expect(fetchNativeNearBalance(ACCOUNT_ID, RPC_URL)).rejects.toThrow("Server error");
  });

  it("throws on HTTP error", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("", { status: 500 }));
    await expect(fetchNativeNearBalance(ACCOUNT_ID, RPC_URL)).rejects.toThrow("RPC HTTP 500");
  });
});

describe("fetchNearAccountState", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("returns the liquid amount and the storage usage", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockRpcResponse({ result: { amount: "763873484929335630399995", locked: "0", storage_usage: 346 } })
    );
    expect(await fetchNearAccountState(ACCOUNT_ID, RPC_URL)).toEqual({
      amount: BigInt("763873484929335630399995"),
      storageUsage: BigInt(346),
    });
  });

  // Fail closed (memory feedback-verification-scripts-fail-closed): a body without the fields is
  // never read as a zero balance.
  it.each([
    ["a body with no result", {}],
    ["a missing amount", { result: { storage_usage: 346 } }],
    ["an empty amount", { result: { amount: "", storage_usage: 346 } }],
    ["a numeric amount", { result: { amount: 5, storage_usage: 346 } }],
    ["a missing storage_usage", { result: { amount: "1" } }],
    ["a string storage_usage", { result: { amount: "1", storage_usage: "346" } }],
    ["an RPC error", { error: { code: -32000, message: "Server error" } }],
  ])("throws on %s", async (_label, body) => {
    vi.mocked(fetch).mockResolvedValueOnce(mockRpcResponse(body));
    await expect(fetchNearAccountState(ACCOUNT_ID, RPC_URL)).rejects.toThrow();
  });
});

describe("fetchFtBalance", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("decodes and returns balance as bigint", async () => {
    const bytes = Array.from(new TextEncoder().encode('"1000000"'));
    vi.mocked(fetch).mockResolvedValueOnce(
      mockRpcResponse({
        result: { result: bytes, logs: [], block_height: 100, block_hash: "abc" },
      })
    );
    expect(await fetchFtBalance(ACCOUNT_ID, CONTRACT_ID, RPC_URL)).toBe(BigInt(1000000));
  });

  it("returns 0n for unregistered account (NEP-145 panic)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockRpcResponse({
        result: {
          result: [],
          logs: [],
          block_height: 100,
          block_hash: "abc",
          error:
            'wasm execution failed: FunctionCallError(HostError(GuestPanic { panic_msg: "The account alice.near is not registered" }))',
        },
      })
    );
    expect(await fetchFtBalance(ACCOUNT_ID, CONTRACT_ID, RPC_URL)).toBe(BigInt(0));
  });

  it("throws on RPC error response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockRpcResponse({ error: { code: -32000, message: "Server error" } })
    );
    await expect(fetchFtBalance(ACCOUNT_ID, CONTRACT_ID, RPC_URL)).rejects.toThrow("Server error");
  });
});

describe("fetchMtBalance", () => {
  const MT_CONTRACT_ID = "v2_1.omni.hot.tg";

  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("decodes and returns mt balance as bigint", async () => {
    const bytes = Array.from(new TextEncoder().encode('"5000000"'));
    vi.mocked(fetch).mockResolvedValueOnce(
      mockRpcResponse({
        result: { result: bytes, logs: [], block_height: 100, block_hash: "abc" },
      })
    );
    expect(await fetchMtBalance(ACCOUNT_ID, MT_CONTRACT_ID, "137_qiStmoQJDQPTebaPjgx5VBxZv6L", RPC_URL)).toBe(BigInt(5000000));
  });

  it("returns 0n when contract sets error (unregistered / unknown tokenId)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockRpcResponse({
        result: { result: [], logs: [], block_height: 100, block_hash: "abc", error: "wasm panic" },
      })
    );
    expect(await fetchMtBalance(ACCOUNT_ID, MT_CONTRACT_ID, "137_qiStmoQJDQPTebaPjgx5VBxZv6L", RPC_URL)).toBe(BigInt(0));
  });

  it("sends token_id in the request args (TON uses 1117_ format)", async () => {
    const bytes = Array.from(new TextEncoder().encode('"0"'));
    vi.mocked(fetch).mockResolvedValueOnce(
      mockRpcResponse({
        result: { result: bytes, logs: [], block_height: 100, block_hash: "abc" },
      })
    );
    await fetchMtBalance(ACCOUNT_ID, MT_CONTRACT_ID, "1117_", RPC_URL);
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    const args = JSON.parse(atob(body.params.args_base64));
    expect(args.token_id).toBe("1117_");
    expect(args.account_id).toBe(ACCOUNT_ID);
  });

  it("throws on RPC error response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockRpcResponse({ error: { code: -32000, message: "Server error" } })
    );
    await expect(fetchMtBalance(ACCOUNT_ID, MT_CONTRACT_ID, "1117_", RPC_URL)).rejects.toThrow("Server error");
  });
});

describe("fetchMtBatchBalance", () => {
  const INTENTS = "intents.near";

  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("returns array of balance strings in order", async () => {
    const bytes = Array.from(new TextEncoder().encode('["1000000","2000000","0"]'));
    vi.mocked(fetch).mockResolvedValueOnce(
      mockRpcResponse({
        result: { result: bytes, logs: [], block_height: 100, block_hash: "abc" },
      })
    );
    const result = await fetchMtBatchBalance(ACCOUNT_ID, INTENTS, ["nep141:a.near", "nep141:b.near", "nep141:c.near"], RPC_URL);
    expect(result).toEqual(["1000000", "2000000", "0"]);
  });

  it("returns empty array immediately for empty token list without network call", async () => {
    expect(await fetchMtBatchBalance(ACCOUNT_ID, INTENTS, [], RPC_URL)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns zeros array on contract wasm error", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockRpcResponse({
        result: { result: [], logs: [], block_height: 100, block_hash: "abc", error: "wasm panic" },
      })
    );
    const result = await fetchMtBatchBalance(ACCOUNT_ID, INTENTS, ["nep141:a.near", "nep141:b.near"], RPC_URL);
    expect(result).toEqual(["0", "0"]);
  });

  it("sends account_id and token_ids correctly in request args", async () => {
    const bytes = Array.from(new TextEncoder().encode('["0"]'));
    vi.mocked(fetch).mockResolvedValueOnce(
      mockRpcResponse({
        result: { result: bytes, logs: [], block_height: 100, block_hash: "abc" },
      })
    );
    await fetchMtBatchBalance(ACCOUNT_ID, INTENTS, ["nep141:wrap.near"], RPC_URL);
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    const args = JSON.parse(atob(body.params.args_base64));
    expect(args.account_id).toBe(ACCOUNT_ID);
    expect(args.token_ids).toEqual(["nep141:wrap.near"]);
  });

  it("throws on RPC error response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockRpcResponse({ error: { code: -32000, message: "Server error" } })
    );
    await expect(fetchMtBatchBalance(ACCOUNT_ID, INTENTS, ["nep141:a.near"], RPC_URL)).rejects.toThrow("Server error");
  });
});

describe("fetchNearUnified", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("sums native NEAR and wNEAR balance", async () => {
    const wnearBytes = Array.from(new TextEncoder().encode('"500000000000000000000000"'));
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        mockRpcResponse({ result: { amount: "2000000000000000000000000" } })
      )
      .mockResolvedValueOnce(
        mockRpcResponse({
          result: { result: wnearBytes, logs: [], block_height: 100, block_hash: "abc" },
        })
      );
    expect(await fetchNearUnified(ACCOUNT_ID, "wrap.near", RPC_URL)).toBe(
      BigInt("2500000000000000000000000")
    );
  });

  it("still returns native balance when wNEAR is unregistered", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        mockRpcResponse({ result: { amount: "1000000000000000000000000" } })
      )
      .mockResolvedValueOnce(
        mockRpcResponse({
          result: {
            result: [],
            logs: [],
            block_height: 100,
            block_hash: "abc",
            error: "wasm panic: account not registered",
          },
        })
      );
    expect(await fetchNearUnified(ACCOUNT_ID, "wrap.near", RPC_URL)).toBe(
      BigInt("1000000000000000000000000")
    );
  });
});
