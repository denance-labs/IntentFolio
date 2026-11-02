// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// --- Mock the leaf I/O modules so no network is hit ---------------------------
vi.mock("../lib/balance-fetcher", () => ({
  fetchNearUnified: vi.fn(),
  fetchMtBalance: vi.fn(),
  fetchFtBalance: vi.fn(),
}));
vi.mock("../lib/fastnear-client", () => ({
  fastnearListFts: vi.fn(),
}));
vi.mock("../lib/ft-metadata", () => ({
  fetchFtMetadata: vi.fn(),
}));
// Drive signedAccountId directly without the HOT Connect adapter chain.
vi.mock("@/features/dashboard-shell/context/wallet-context", () => ({
  useWallet: vi.fn(),
}));

import { useWalletBalances } from "./use-wallet-balances";
import { fetchNearUnified, fetchMtBalance, fetchFtBalance } from "../lib/balance-fetcher";
import { fastnearListFts } from "../lib/fastnear-client";
import { fetchFtMetadata } from "../lib/ft-metadata";
import { useWallet } from "@/features/dashboard-shell/context/wallet-context";

// Real registry rows the assertions rely on (see token-registry.ts):
const USDC_NEAR_CONTRACT = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const USDC_NEAR_ID = `nep141:${USDC_NEAR_CONTRACT}`; // decimals 6
const USDC_POL_ID = "nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L"; // decimals 6
const USDC_POL_CONTRACT = "v2_1.omni.hot.tg";
const USDC_POL_TOKEN_ID = "137_qiStmoQJDQPTebaPjgx5VBxZv6L";

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } }, // fail fast on the error test
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

async function renderBalances() {
  const hook = renderHook(() => useWalletBalances(), { wrapper });
  await waitFor(() => expect(hook.result.current.isSuccess || hook.result.current.isError).toBe(true));
  return hook;
}

afterEach(() => {
  cleanup(); // unmount each test's tree — config has no globals, so RTL auto-cleanup is off
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useWallet).mockReturnValue({
    status: "connected",
    signedAccountId: "alice.near",
    walletNetwork: "mainnet",
    signIn: vi.fn(),
    signOut: vi.fn(),
  });
  // Defaults: everything resolves to zero unless a test overrides it.
  vi.mocked(fetchNearUnified).mockResolvedValue(BigInt(0));
  vi.mocked(fetchMtBalance).mockResolvedValue(BigInt(0));
  vi.mocked(fetchFtBalance).mockResolvedValue(BigInt(0));
  vi.mocked(fastnearListFts).mockResolvedValue([]);
  vi.mocked(fetchFtMetadata).mockResolvedValue(null);
});

describe("useWalletBalances", () => {
  it("keys discovered registry balances by token.id, not by symbol", async () => {
    // FastNear reports the USDC(NEAR) contract with a non-zero balance.
    vi.mocked(fastnearListFts).mockResolvedValue([
      { contract_id: USDC_NEAR_CONTRACT, balance: "5000000", last_update_block_height: 1 },
    ]);

    const { result } = await renderBalances();
    const { balances } = result.current.data!;

    // 5_000_000 / 10^6 = 5
    expect(balances[USDC_NEAR_ID]).toBeCloseTo(5);
    // The collision-prone symbol must NOT be used as a key.
    expect(balances["USDC(NEAR)"]).toBeUndefined();
  });

  it("reads NEP-245 tokens via mt_balance_of with the decoded tokenId (C-003), keyed by full nep245 id", async () => {
    vi.mocked(fetchMtBalance).mockImplementation(async (_acct, contractId, tokenId) => {
      if (contractId === USDC_POL_CONTRACT && tokenId === USDC_POL_TOKEN_ID) return BigInt(2000000);
      return BigInt(0);
    });

    const { result } = await renderBalances();
    const { balances } = result.current.data!;

    // Decoded tokenId (everything after "nep245:contract:") was passed to mt_balance_of.
    expect(fetchMtBalance).toHaveBeenCalledWith(
      "alice.near",
      USDC_POL_CONTRACT,
      USDC_POL_TOKEN_ID,
      expect.any(String)
    );
    // 2_000_000 / 10^6 = 2, keyed by the full nep245 id.
    expect(balances[USDC_POL_ID]).toBeCloseTo(2);
    // NEP-245 must never be read through the NEP-141 path.
    expect(fetchFtBalance).not.toHaveBeenCalledWith(
      "alice.near",
      USDC_POL_CONTRACT,
      expect.any(String)
    );
  });

  it("sums native NEAR + wNEAR under the unified 'near' key", async () => {
    vi.mocked(fetchNearUnified).mockResolvedValue(BigInt("3000000000000000000000000")); // 3 NEAR (24 decimals)
    const { result } = await renderBalances();
    expect(result.current.data!.balances["near"]).toBeCloseTo(3);
  });

  it("resolves FastNear tokens outside the registry as unknownTokens (depositable: false)", async () => {
    const UNKNOWN = "blackdragon.tkn.near";
    vi.mocked(fastnearListFts).mockResolvedValue([
      { contract_id: UNKNOWN, balance: "1000000000000000000000000", last_update_block_height: 1 },
    ]);
    vi.mocked(fetchFtMetadata).mockResolvedValue({
      id: `nep141:${UNKNOWN}`,
      symbol: "BLACKDRAGON",
      name: "Black Dragon",
      contractId: UNKNOWN,
      decimals: 24,
      category: "Other",
      fallbackUsdPrice: 0,
      depositable: false,
    });

    const { result } = await renderBalances();
    const { balances, unknownTokens } = result.current.data!;

    expect(unknownTokens).toHaveLength(1);
    expect(unknownTokens[0].contractId).toBe(UNKNOWN);
    expect(unknownTokens[0].depositable).toBe(false);
    expect(balances[`nep141:${UNKNOWN}`]).toBeCloseTo(1);
  });

  it("skips wNEAR and zero-balance entries reported by FastNear", async () => {
    vi.mocked(fastnearListFts).mockResolvedValue([
      { contract_id: "wrap.near", balance: "9999999999999999999999999", last_update_block_height: 1 },
      { contract_id: USDC_NEAR_CONTRACT, balance: "0", last_update_block_height: 1 },
    ]);

    const { result } = await renderBalances();
    const { balances } = result.current.data!;

    // wNEAR is folded into the unified NEAR balance, never its own key.
    expect(balances["nep141:wrap.near"]).toBeUndefined();
    // Zero-balance discovered token is skipped entirely.
    expect(balances[USDC_NEAR_ID]).toBeUndefined();
    expect(fetchFtMetadata).not.toHaveBeenCalled();
  });

  it("falls back to registry RPC when FastNear returns no tokens", async () => {
    vi.mocked(fastnearListFts).mockResolvedValue([]); // FastNear down / new account
    vi.mocked(fetchNearUnified).mockResolvedValue(BigInt("1000000000000000000000000")); // 1 NEAR
    vi.mocked(fetchFtBalance).mockResolvedValue(BigInt(7000000)); // registry NEP-141 fallback

    const { result } = await renderBalances();
    expect(result.current.isSuccess).toBe(true);
    // RPC produced data, so it must not throw; the NEAR balance is present.
    expect(result.current.data!.balances["near"]).toBeCloseTo(1);
    expect(result.current.data!.unknownTokens).toEqual([]);
  });

  it("throws when FastNear is empty and every RPC source fails", async () => {
    vi.mocked(fastnearListFts).mockResolvedValue([]);
    vi.mocked(fetchNearUnified).mockRejectedValue(new Error("rpc down"));
    vi.mocked(fetchMtBalance).mockRejectedValue(new Error("rpc down"));
    vi.mocked(fetchFtBalance).mockRejectedValue(new Error("rpc down"));

    // The hook hardcodes retry: 3 with exponential backoff (~7s). Fake timers
    // flush the retry delays without the suite actually waiting.
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useWalletBalances(), { wrapper });
      await vi.runAllTimersAsync();
      expect(result.current.isError).toBe(true);
      expect(result.current.error).toEqual(new Error("All balance sources unavailable"));
    } finally {
      vi.useRealTimers();
    }
  });
});
