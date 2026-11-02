// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../lib/balance-fetcher", () => ({
  fetchMtBatchBalance: vi.fn(),
}));

import { useIntentsBalances } from "./use-intents-balances";
import { fetchMtBatchBalance } from "../lib/balance-fetcher";
import { INTENTS_CONTRACT_ID } from "../config/network";

// Real registry rows the assertions rely on (see token-registry.ts):
const USDC_ARB_ID = "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near"; // decimals 6
const USDC_POL_ID = "nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L"; // decimals 6
const USDC_BSC_ID = "nep245:v2_1.omni.hot.tg:56_2w93GqMcEmQFDru84j3HZZWt557r"; // decimals 18
const TON_ID = "nep245:v2_1.omni.hot.tg:1117_3tsdfyziyc7EJbP2aULWSKU4toBaAcN4FdTgfm5W1mC4ouR";
const WNEAR_ID = "nep141:wrap.near";

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** Requested token ids of the single batch call the hook makes. */
function requestedIds(): string[] {
  return vi.mocked(fetchMtBatchBalance).mock.calls[0][2];
}

/** Answer the batch with `raw` for the given ids and "0" for every other. */
function answerWith(balances: Record<string, string>) {
  vi.mocked(fetchMtBatchBalance).mockImplementation(async (_a, _c, tokenIds) =>
    tokenIds.map((id) => balances[id] ?? "0")
  );
}

async function renderBalances() {
  const hook = renderHook(() => useIntentsBalances("alice.near"), { wrapper });
  await waitFor(() => expect(hook.result.current.isSuccess || hook.result.current.isError).toBe(true));
  return hook;
}

afterEach(() => cleanup());

beforeEach(() => {
  vi.clearAllMocks();
  answerWith({});
});

describe("useIntentsBalances", () => {
  it("asks intents.near for the NEP-245 tokens too (D-175)", async () => {
    await renderBalances();
    expect(vi.mocked(fetchMtBatchBalance).mock.calls[0][1]).toBe(INTENTS_CONTRACT_ID);
    const ids = requestedIds();
    // The exact tokens the old nep245 skip made invisible.
    expect(ids).toContain(USDC_POL_ID);
    expect(ids).toContain(USDC_BSC_ID);
    expect(ids).toContain(TON_ID);
    expect(ids.filter((id) => id.startsWith("nep245:"))).toHaveLength(15); // +2 Stellar (4.4)
  });

  it("surfaces a NEP-245 balance under its registry id, scaled by its own decimals", async () => {
    answerWith({
      [USDC_POL_ID]: "118180568294", // 6 decimals
      [USDC_BSC_ID]: "77863263098232899637658", // 18 decimals
    });
    const { result } = await renderBalances();
    expect(result.current.data!.get(USDC_POL_ID)).toBeCloseTo(118180.568294, 6);
    expect(result.current.data!.get(USDC_BSC_ID)).toBeCloseTo(77863.263098, 4);
  });

  it("still reads NEP-141 balances", async () => {
    answerWith({ [USDC_ARB_ID]: "5128107" });
    const { result } = await renderBalances();
    expect(result.current.data!.get(USDC_ARB_ID)).toBeCloseTo(5.128107, 6);
  });

  it("asks for wNEAR but reports it under the 'near' registry key", async () => {
    answerWith({ [WNEAR_ID]: "1500000000000000000000000" }); // 1.5 NEAR, 24 decimals
    const { result } = await renderBalances();
    expect(requestedIds()).toContain(WNEAR_ID);
    expect(result.current.data!.get("near")).toBeCloseTo(1.5, 6);
    expect(result.current.data!.has(WNEAR_ID)).toBe(false);
  });

  it("omits zero balances so the map only holds what the account actually has", async () => {
    answerWith({ [USDC_POL_ID]: "1" });
    const { result } = await renderBalances();
    expect([...result.current.data!.keys()]).toEqual([USDC_POL_ID]);
  });

  it("never asks for the same token id twice", async () => {
    await renderBalances();
    const ids = requestedIds();
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("does not query at all without an intents account", async () => {
    const hook = renderHook(() => useIntentsBalances(""), { wrapper });
    await waitFor(() => expect(hook.result.current.isPending).toBe(true));
    expect(fetchMtBatchBalance).not.toHaveBeenCalled();
  });
});
