// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { useOmniDepositWatch } from "./use-omni-deposit-watch";
import {
  expectOmniDeposit,
  omniDepositExpectedSince,
  pickNewOmniDeposits,
  OMNI_CREDITED_DEPOSIT_TOKEN_IDS,
  OMNI_CREDITED_DEPOSIT_CHAIN_IDS,
  SINCE_SLACK_MS,
  WATCH_MS,
} from "../lib/omni-deposit-watch";
import { loadNotifiedDeposits } from "../lib/credited-deposits-store";

// D-580: ZEC deposits are credited by the Omni Bridge and PoA never lists them, so the notice
// reads the account's history while Receive has marked one as expected.

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

describe("which deposits are Omni-credited", () => {
  it("is ZEC on zec:mainnet only — the omni route", () => {
    expect([...OMNI_CREDITED_DEPOSIT_TOKEN_IDS]).toEqual([ZEC]);
    expect([...OMNI_CREDITED_DEPOSIT_CHAIN_IDS]).toEqual(["zec:mainnet"]);
  });
});

describe("the expectation Receive leaves", () => {
  it("lasts WATCH_MS from the last time Receive showed the address", () => {
    expectOmniDeposit(ACCOUNT, NOW);
    expect(omniDepositExpectedSince(ACCOUNT, NOW + WATCH_MS)).toBe(NOW);
    expect(omniDepositExpectedSince(ACCOUNT, NOW + WATCH_MS + 1)).toBeNull();
    expect(omniDepositExpectedSince("someone-else.near", NOW)).toBeNull();
  });
});

describe("pickNewOmniDeposits", () => {
  it("takes a ZEC deposit credited after the mark, keyed like the PoA poller", () => {
    expect(pickNewOmniDeposits([ZEC_DEPOSIT], NOW - 120_000, new Set())).toEqual([
      { key: "6ySKyKPVnmTh7Y:zec:mainnet", tokenId: ZEC, chainId: "zec:mainnet", amountRaw: "900000", txHash: "6ySKyKPVnmTh7Y" },
    ]);
  });

  it("skips what was announced, what is older than the slack, other tokens and withdrawals", () => {
    const usdc = { ...ZEC_DEPOSIT, txHash: "x", data: { token: "nep141:usdt.tether-token.near", amount: "1" } };
    const withdrawal = { ...ZEC_DEPOSIT, txHash: "w", event: "intents:withdrawal" };
    const old = { ...ZEC_DEPOSIT, txHash: "o", ts: NOW - SINCE_SLACK_MS - 1 };
    expect(
      pickNewOmniDeposits([usdc, withdrawal, old, ZEC_DEPOSIT], NOW, new Set(["6ySKyKPVnmTh7Y:zec:mainnet"]))
    ).toEqual([]);
  });
});

describe("useOmniDepositWatch", () => {
  it("does not read the history when no deposit is expected", async () => {
    const f = historyFetch([ZEC_DEPOSIT]);
    renderHook(() => useOmniDepositWatch({ intentsAccountId: ACCOUNT, onCredited: vi.fn(), fetchImpl: f }));
    await new Promise((r) => setTimeout(r, 0));
    expect(f).not.toHaveBeenCalled();
  });

  it("announces the deposit once, and remembers it across a remount", async () => {
    expectOmniDeposit(ACCOUNT, NOW - 120_000);
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const f = historyFetch([ZEC_DEPOSIT]);
    const onCredited = vi.fn();
    const first = renderHook(() => useOmniDepositWatch({ intentsAccountId: ACCOUNT, onCredited, fetchImpl: f }));
    await waitFor(() => expect(onCredited).toHaveBeenCalledTimes(1));
    expect(String(f.mock.calls[0][0])).toBe("/api/history/account?account=pablofork.near");
    expect(onCredited.mock.calls[0][0]).toMatchObject({ tokenId: ZEC, amountRaw: "900000" });
    expect(loadNotifiedDeposits(ACCOUNT).has("6ySKyKPVnmTh7Y:zec:mainnet")).toBe(true);
    first.unmount();

    const again = vi.fn();
    const f2 = historyFetch([ZEC_DEPOSIT]);
    renderHook(() => useOmniDepositWatch({ intentsAccountId: ACCOUNT, onCredited: again, fetchImpl: f2 }));
    await waitFor(() => expect(f2).toHaveBeenCalled());
    expect(again).not.toHaveBeenCalled();
  });

  it("survives a failed read", async () => {
    expectOmniDeposit(ACCOUNT, NOW - 120_000);
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const f = vi.fn(async () => ({ ok: false, json: async () => ({}) }) as Response) as unknown as typeof fetch;
    const onCredited = vi.fn();
    renderHook(() => useOmniDepositWatch({ intentsAccountId: ACCOUNT, onCredited, fetchImpl: f }));
    await waitFor(() => expect(f).toHaveBeenCalled());
    expect(onCredited).not.toHaveBeenCalled();
  });
});
