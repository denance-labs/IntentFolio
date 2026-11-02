import { describe, it, expect } from "vitest";
import type { WithdrawalInFlightRecord } from "@/features/intents-account/mock-contract/types";
import { canDismissWithdrawal, countWithdrawalsInFlight } from "./withdrawals-in-flight";
import { DISMISS_AFTER_MS } from "@/features/bridge/lib/withdraw-rescue-store";

// D-264. The rule that decides whether a user who reloads mid-withdrawal is shown anything at
// all from the portfolio view. Both halves have a wrong answer that costs something: counting
// mock rows puts an alarm over a demo, and NOT counting UNCONFIRMED hides the one state where
// the money has left the balance and nobody has seen it land.

const row = (over: Partial<WithdrawalInFlightRecord> = {}): WithdrawalInFlightRecord => ({
  intentId: "id-1",
  tokenId: "nep141:usdt.tether-token.near" as WithdrawalInFlightRecord["tokenId"],
  qty: 1,
  chainId: "eth:42161",
  destinationAddress: "0xabc",
  status: "SETTLED",
  ts: 1_000,
  isReal: true,
  ...over,
});

describe("countWithdrawalsInFlight", () => {
  it("counts every real withdrawal that has not ended", () => {
    const open: Array<WithdrawalInFlightRecord["status"]> = [
      "PENDING",
      "TX_BROADCASTED",
      "SETTLED",
      "UNCONFIRMED",
    ];
    for (const status of open) {
      expect({ status, n: countWithdrawalsInFlight([row({ status })]) }).toEqual({ status, n: 1 });
    }
  });

  it("does not count a withdrawal that ended, either way", () => {
    expect(countWithdrawalsInFlight([row({ status: "DELIVERED" }), row({ status: "FAILED" })]))
      .toBe(0);
  });

  it("does not count a conversion 1Click refunded: the money is back, nothing is in flight", () => {
    expect(countWithdrawalsInFlight([row({ status: "REFUNDED" })])).toBe(0);
  });

  it("ignores the mock progression's own rows", () => {
    // They resolve on a 90-second timer by construction; a strip over them would be an alarm
    // about nothing, on a screen where nothing moved.
    expect(countWithdrawalsInFlight([row({ isReal: false }), row({ isReal: undefined })])).toBe(0);
  });

  it("counts each open withdrawal separately", () => {
    expect(
      countWithdrawalsInFlight([
        row({ intentId: "a", status: "SETTLED" }),
        row({ intentId: "b", status: "UNCONFIRMED" }),
        row({ intentId: "c", status: "DELIVERED" }),
      ])
    ).toBe(2);
  });

  it("is zero for an empty feed", () => {
    expect(countWithdrawalsInFlight([])).toBe(0);
  });
});

describe("canDismissWithdrawal (D-463, 023-B)", () => {
  const later = 1_000 + DISMISS_AFTER_MS + 1;

  it("offers «Hide» on a real, open withdrawal older than a day", () => {
    for (const status of ["PENDING", "TX_BROADCASTED", "SETTLED", "UNCONFIRMED"] as const) {
      expect({ status, ok: canDismissWithdrawal(row({ status }), later) }).toEqual({ status, ok: true });
    }
  });

  it("not before a full day has passed", () => {
    expect(canDismissWithdrawal(row({ status: "UNCONFIRMED" }), 1_000 + DISMISS_AFTER_MS)).toBe(false);
  });

  it("not on a withdrawal that ended, nor on a mock row", () => {
    expect(canDismissWithdrawal(row({ status: "DELIVERED" }), later)).toBe(false);
    expect(canDismissWithdrawal(row({ status: "FAILED" }), later)).toBe(false);
    expect(canDismissWithdrawal(row({ status: "REFUNDED" }), later)).toBe(false);
    expect(canDismissWithdrawal(row({ isReal: false, status: "UNCONFIRMED" }), later)).toBe(false);
  });
});
