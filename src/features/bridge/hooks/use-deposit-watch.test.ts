// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { useDepositWatch } from "./use-deposit-watch";
import { depositExpectedSince, expectDeposit, pickNewDeposits, SINCE_SLACK_MS, WATCH_MS } from "../lib/deposit-watch";
import { loadNotifiedDeposits } from "../lib/credited-deposits-store";

// D-580 / D-584: no bridge lists Receive's deposits any more (ZEC through the Omni Bridge, every
// other one through a 1Click address set), so the notice reads the account's history while
// Receive has marked one as expected.

const ZEC = "nep141:zec.omft.near";
const ACCOUNT = "pablofork.near";
const NOW = 1_794_541_800_000;

/** The real history row of the 2026-11-13 real-money deposit (0.009 ZEC). */
const ZEC_DEPOSIT = {
  event: "intents:deposit",
  txHash: "6ySKyKPVnmTh7Y",
  ts: NOW - 60_000,
  data: { token: ZEC, amount: "900000", account_id: ACCOUNT },
};

function historyFetch(events: unknown[]) {
  return vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, events }) }) as Response) as unknown as
    typeof fetch & ReturnType<typeof vi.fn>;
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the expectation Receive leaves", () => {
  it("lasts WATCH_MS from the last time Receive showed the address", () => {
    expectDeposit(ACCOUNT, NOW);
    expect(depositExpectedSince(ACCOUNT, NOW + WATCH_MS)).toBe(NOW);
    expect(depositExpectedSince(ACCOUNT, NOW + WATCH_MS + 1)).toBeNull();
    expect(depositExpectedSince("someone-else.near", NOW)).toBeNull();
  });
});

/** The history row of the 2026-11-15 real-money deposit to a 1Click address set (0.494880 USDC on Base). */
const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const RDA_DEPOSIT = {
  event: "intents:deposit",
  txHash: "Ao6iFwBQ2Ltui7PbZ54Qe6JC5qP9iEZJ15wRjrBJY4Mr",
  ts: NOW - 30_000,
  data: { token: BASE_USDC, amount: "494880", account_id: ACCOUNT },
};

describe("pickNewDeposits", () => {
  it("takes every deposit credited after the mark — the Omni Bridge's ZEC and a 1Click set's — keyed by tx and the token's network", () => {
    expect(pickNewDeposits([ZEC_DEPOSIT, RDA_DEPOSIT], NOW - 120_000, new Set())).toEqual([
      { key: "6ySKyKPVnmTh7Y:zec:mainnet", tokenId: ZEC, chainId: "zec:mainnet", amountRaw: "900000", txHash: "6ySKyKPVnmTh7Y", ts: NOW - 60_000 },
      {
        key: "Ao6iFwBQ2Ltui7PbZ54Qe6JC5qP9iEZJ15wRjrBJY4Mr:eth:8453",
        tokenId: BASE_USDC,
        chainId: "eth:8453",
        amountRaw: "494880",
        txHash: "Ao6iFwBQ2Ltui7PbZ54Qe6JC5qP9iEZJ15wRjrBJY4Mr",
        ts: NOW - 30_000,
      },
    ]);
  });

  it("a NEAR wallet deposit is keyed as the wallet tab marks it, so it is never announced twice", () => {
    const wnear = { ...ZEC_DEPOSIT, txHash: "nearTx", data: { token: "nep141:wrap.near", amount: "1" } };
    expect(pickNewDeposits([wnear], NOW, new Set())).toEqual([expect.objectContaining({ tokenId: "near", key: "nearTx:near:mainnet" })]);
    expect(pickNewDeposits([wnear], NOW, new Set(["nearTx:near:mainnet"]))).toEqual([]);
  });

  it("skips what was announced, what is older than the slack, withdrawals and unreadable rows", () => {
    const withdrawal = { ...ZEC_DEPOSIT, txHash: "w", event: "intents:withdrawal" };
    const old = { ...ZEC_DEPOSIT, txHash: "o", ts: NOW - SINCE_SLACK_MS - 1 };
    const noAmount = { ...ZEC_DEPOSIT, txHash: "n", data: { token: ZEC, amount: "1.5" } };
    expect(
      pickNewDeposits([withdrawal, old, noAmount, ZEC_DEPOSIT], NOW, new Set(["6ySKyKPVnmTh7Y:zec:mainnet"]))
    ).toEqual([]);
  });
});

describe("useDepositWatch", () => {
  it("does not read the history when no deposit is expected", async () => {
    const f = historyFetch([ZEC_DEPOSIT]);
    renderHook(() => useDepositWatch({ intentsAccountId: ACCOUNT, onCredited: vi.fn(), fetchImpl: f }));
    await new Promise((r) => setTimeout(r, 0));
    expect(f).not.toHaveBeenCalled();
  });

  it("announces the deposit once, and remembers it across a remount", async () => {
    expectDeposit(ACCOUNT, NOW - 120_000);
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const f = historyFetch([ZEC_DEPOSIT]);
    const onCredited = vi.fn();
    const first = renderHook(() => useDepositWatch({ intentsAccountId: ACCOUNT, onCredited, fetchImpl: f }));
    await waitFor(() => expect(onCredited).toHaveBeenCalledTimes(1));
    expect(String(f.mock.calls[0][0])).toBe("/api/history/account?account=pablofork.near");
    expect(onCredited.mock.calls[0][0]).toMatchObject({ tokenId: ZEC, amountRaw: "900000" });
    expect(loadNotifiedDeposits(ACCOUNT).has("6ySKyKPVnmTh7Y:zec:mainnet")).toBe(true);
    first.unmount();

    const again = vi.fn();
    const f2 = historyFetch([ZEC_DEPOSIT]);
    renderHook(() => useDepositWatch({ intentsAccountId: ACCOUNT, onCredited: again, fetchImpl: f2 }));
    await waitFor(() => expect(f2).toHaveBeenCalled());
    expect(again).not.toHaveBeenCalled();
  });

  it("survives a failed read", async () => {
    expectDeposit(ACCOUNT, NOW - 120_000);
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const f = vi.fn(async () => ({ ok: false, json: async () => ({}) }) as Response) as unknown as typeof fetch;
    const onCredited = vi.fn();
    renderHook(() => useDepositWatch({ intentsAccountId: ACCOUNT, onCredited, fetchImpl: f }));
    await waitFor(() => expect(f).toHaveBeenCalled());
    expect(onCredited).not.toHaveBeenCalled();
  });
});
