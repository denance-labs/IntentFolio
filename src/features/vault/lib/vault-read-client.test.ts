import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getSolverPubkey,
  getPauseState,
  getAccount,
  getPortfolio,
  listPortfoliosFor,
  readPortfoliosFor,
  getPortfolioBalance,
  getPoolTotal,
} from "./vault-read-client";
import { VAULT_CONTRACT_ID } from "@/features/wallet/config/network";

// Committable coverage for the vault read adapter with `fetch` mocked — no live network
// (007.plan Phase 0). Complements the in-vivo probe (already deleted) by pinning the
// decode logic (Vec<(token, U128)> -> [token, bigint], U128 string -> bigint) and the
// error surfaces (RPC error, wasm callResult.error, HTTP non-2xx).

function mockRpcResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// Wrap a view return value as the byte-array `CallFunctionResult` the RPC produces.
function mockViewResult(value: unknown): Response {
  const bytes = Array.from(new TextEncoder().encode(JSON.stringify(value)));
  return mockRpcResponse({
    result: { result: bytes, logs: [], block_height: 100, block_hash: "abc" },
  });
}

beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => vi.unstubAllGlobals());

describe("getPortfolioBalance", () => {
  it("decodes Vec<(token, U128)> into [token, bigint] pairs", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockViewResult([
        ["nep141:usdc.near", "1000000"],
        ["nep141:wrap.near", "250000000000000000000000"],
      ])
    );
    // `nep141:wrap.near` comes back as `near`: this client is the read boundary, and the
    // rest of the app — projection, polls, maturity clock — only knows registry ids.
    expect(await getPortfolioBalance("pf-1")).toEqual([
      ["nep141:usdc.near", BigInt(1000000)],
      ["near", BigInt("250000000000000000000000")],
    ]);
  });

  it("returns [] for an empty portfolio", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockViewResult([]));
    expect(await getPortfolioBalance("pf-empty")).toEqual([]);
  });

  it("targets the vault contract and sends portfolio_id in base64 args", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockViewResult([]));
    await getPortfolioBalance("pf-42");
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.params.account_id).toBe(VAULT_CONTRACT_ID);
    expect(body.params.method_name).toBe("get_portfolio_balance");
    const args = JSON.parse(atob(body.params.args_base64));
    expect(args.portfolio_id).toBe("pf-42");
  });
});

describe("getPoolTotal", () => {
  it("decodes a U128 string into a bigint", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockViewResult("999999999999"));
    expect(await getPoolTotal("nep141:usdc.near")).toBe(BigInt(999999999999));
  });
});

describe("listPortfoliosFor", () => {
  it("returns the portfolio id list and sends account_id in args", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockViewResult(["pf-1", "pf-2"]));
    expect(await listPortfoliosFor("alice.near")).toEqual(["pf-1", "pf-2"]);
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    const args = JSON.parse(atob(body.params.args_base64));
    expect(args.account_id).toBe("alice.near");
  });
});

// 008.plan Phase 1 (D-R6). The fixtures below are the VERBATIM shapes returned by
// `intentfolio-staging.near` on mainnet (checked 2026-07-30 against p_000000000005), not
// shapes inferred from the contract source — the read-model is only as right as this.
describe("getPortfolio", () => {
  const onChain = {
    owner: "0xc8b1e10d011aceed84f4cdba66ca175bd6552a36",
    name: "Conservative USDT n ETH",
    composition: [
      { token_id: "nep141:usdt.tether-token.near", target_bps: 2500, tolerance_bps: 500 },
      { token_id: "nep141:btc.omft.near", target_bps: 2000, tolerance_bps: 500 },
    ],
    held_tokens: [],
    created_at: 1785375284,
    deleted: false,
    deleted_at: 0,
  };

  it("returns the record verbatim, in the contract's own snake_case + bps", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockViewResult(onChain));
    expect(await getPortfolio("p_000000000005")).toEqual(onChain);
  });

  it("returns null for an unknown id — the contract answers null, it does not panic", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockViewResult(null));
    expect(await getPortfolio("p_999999999999")).toBeNull();
  });

  it("keeps an emptied-but-alive portfolio distinguishable from a deleted one (D-R15)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockViewResult(onChain));
    const emptied = await getPortfolio("p_000000000005");
    // No funds, five targets, deleted:false — the state a full withdrawal leaves behind.
    expect(emptied?.held_tokens).toEqual([]);
    expect(emptied?.deleted).toBe(false);
    expect(emptied?.composition).toHaveLength(2);
  });

  it("sends portfolio_id in base64 args", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockViewResult(null));
    await getPortfolio("p_42");
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.params.method_name).toBe("get_portfolio");
    expect(JSON.parse(atob(body.params.args_base64)).portfolio_id).toBe("p_42");
  });
});

describe("getAccount", () => {
  it("decodes linked_wallets as [chain, address] pairs", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockViewResult({
        linked_wallets: [["evm", "0xc8B1e10d011ACeEd84F4CDBa66ca175bD6552A36"]],
        portfolios: ["p_000000000005"],
        created_at: 1785375284,
      })
    );
    const account = await getAccount("0xc8b1e10d011aceed84f4cdba66ca175bd6552a36");
    expect(account?.linked_wallets[0][0]).toBe("evm");
    expect(account?.portfolios).toEqual(["p_000000000005"]);
  });

  it("returns null for an account the vault never registered", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockViewResult(null));
    expect(await getAccount("nobody.near")).toBeNull();
  });
});

describe("readPortfoliosFor", () => {
  const record = (over: Record<string, unknown> = {}) => ({
    owner: "alice.near",
    name: "Wet",
    composition: [{ token_id: "nep141:usdc.near", target_bps: 10_000, tolerance_bps: 500 }],
    held_tokens: [],
    created_at: 1785375284,
    deleted: false,
    deleted_at: 0,
    ...over,
  });

  it("pairs every listed id with its record and its balances", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockViewResult(["p_1"]))
      .mockResolvedValueOnce(mockViewResult(record({ name: "Conservative" })))
      .mockResolvedValueOnce(mockViewResult([["nep141:usdc.near", "3500000"]]));

    const reads = await readPortfoliosFor("alice.near");
    expect(reads).toHaveLength(1);
    expect(reads[0].id).toBe("p_1");
    expect(reads[0].portfolio.name).toBe("Conservative");
    expect(reads[0].balances).toEqual([["nep141:usdc.near", BigInt(3_500_000)]]);
  });

  it("keeps an emptied-but-alive portfolio, drops a deleted one", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockViewResult(["p_alive", "p_gone"]))
      // The two get_portfolio / get_portfolio_balance pairs are fanned out with
      // Promise.all, so the four calls interleave per id in listing order.
      .mockResolvedValueOnce(mockViewResult(record()))
      .mockResolvedValueOnce(mockViewResult([]))
      .mockResolvedValueOnce(mockViewResult(record({ deleted: true, deleted_at: 1785375999 })))
      .mockResolvedValueOnce(mockViewResult([]));

    const reads = await readPortfoliosFor("alice.near");
    expect(reads.map((r) => r.id)).toEqual(["p_alive"]);
    // Alive with zero balances is a first-class state (D-R15), not an absence.
    expect(reads[0].balances).toEqual([]);
    expect(reads[0].portfolio.composition).toHaveLength(1);
  });

  it("REJECTS on a failed read instead of resolving to an empty list", async () => {
    // The rule this pins: `[]` renders as "you have no portfolios". Returning it after a
    // failed read would tell someone who just deposited that their funds are gone.
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockViewResult(["p_1"]))
      .mockResolvedValueOnce(mockRpcResponse({ error: { code: -32000, message: "node down" } }))
      .mockResolvedValueOnce(mockViewResult([]));
    await expect(readPortfoliosFor("alice.near")).rejects.toThrow("node down");
  });

  it("REJECTS rather than returning a partial list when one portfolio fails", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockViewResult(["p_ok", "p_broken"]))
      .mockResolvedValueOnce(mockViewResult(record()))
      .mockResolvedValueOnce(mockViewResult([]))
      .mockResolvedValueOnce(mockRpcResponse({ error: { code: -32000, message: "node down" } }))
      .mockResolvedValueOnce(mockViewResult([]));
    // A partial list looks exactly like a portfolio that disappeared.
    await expect(readPortfoliosFor("alice.near")).rejects.toThrow("node down");
  });

  it("returns [] for an account that genuinely owns no portfolio", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockViewResult([]));
    expect(await readPortfoliosFor("newbie.near")).toEqual([]);
  });
});

describe("health-check reads", () => {
  it("getSolverPubkey returns the decoded string", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockViewResult("ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp")
    );
    expect(await getSolverPubkey()).toBe("ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp");
  });

  it("getPauseState returns the areas structure", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockViewResult({ areas: [null, "allocate"] }));
    expect(await getPauseState()).toEqual({ areas: [null, "allocate"] });
  });
});

describe("error surfaces", () => {
  it("throws on an RPC-level error", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockRpcResponse({ error: { code: -32000, message: "Server error" } })
    );
    await expect(getPoolTotal("nep141:usdc.near")).rejects.toThrow("Server error");
  });

  it("throws (does not swallow) a wasm callResult.error — money-adjacent, no silent zero", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockRpcResponse({
        result: { result: [], logs: [], block_height: 100, block_hash: "abc", error: "wasm panic" },
      })
    );
    await expect(getPortfolioBalance("pf-x")).rejects.toThrow(/get_portfolio_balance.*wasm panic/);
  });

  it("throws on an HTTP non-2xx", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("", { status: 503 }));
    await expect(getSolverPubkey()).rejects.toThrow("RPC HTTP 503");
  });
});
