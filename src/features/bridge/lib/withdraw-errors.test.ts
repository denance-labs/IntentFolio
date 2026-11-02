import { describe, it, expect } from "vitest";
import {
  WithdrawDeliveryCancelledError,
  WithdrawDeliveryUnconfirmedError,
  WithdrawDestinationUnusableError,
  WithdrawError,
  WithdrawPublishUnknownError,
  WithdrawRelayRejectedError,
  WithdrawSettlementFailedError,
  WithdrawSettlementUnconfirmedError,
  type WithdrawFundsState,
} from "./withdraw-errors";

// `fundsState` is the contract of this file. Every one of these errors is a moment where
// the UI has to tell someone what happened to their money, and the class name alone does
// not say it — a "settlement failed" is safe while a "delivery unconfirmed" is money in
// flight. So the matrix below is pinned: changing any row changes what the product claims
// about funds it may not have.

const CASES: Array<[string, WithdrawError, WithdrawFundsState]> = [
  [
    "destination unusable",
    new WithdrawDestinationUnusableError("missing-account", "nope.near", "usdt.tether-token.near"),
    "untouched",
  ],
  ["relay rejected", new WithdrawRelayRejectedError("NONCE_USED", "nonce was already used"), "untouched"],
  ["publish unknown", new WithdrawPublishUnknownError("socket closed"), "unknown"],
  ["settlement failed", new WithdrawSettlementFailedError("0xintent"), "untouched"],
  ["settlement unconfirmed", new WithdrawSettlementUnconfirmedError("0xintent", "deadline"), "unknown"],
  ["delivery unconfirmed", new WithdrawDeliveryUnconfirmedError("0xtx", "nep141:t.near", "deadline"), "left-balance"],
  ["delivery cancelled", new WithdrawDeliveryCancelledError("0xtx", "4242"), "left-balance"],
];

describe("fundsState — what the copy is allowed to claim", () => {
  it.each(CASES)("%s", (_name, error, expected) => {
    expect(error.fundsState).toBe(expected);
  });

  it("marks only post-settlement outcomes as money already out of the balance", () => {
    const outbound = CASES.filter(([, error]) => error.fundsState === "left-balance");
    // Only a post-settlement failure may say the funds left. Both of these fire strictly
    // after the delivery wait has begun; a third entry here is a deliberate decision, not a
    // drive-by edit. HOT's cancellation joined in 4.3.4 — same funds state, different
    // certainty, which is why it is a separate class and not a separate state.
    expect(outbound.map(([name]) => name)).toEqual(["delivery unconfirmed", "delivery cancelled"]);
  });
});

describe("the errors behave like errors", () => {
  it.each(CASES)("%s is catchable as WithdrawError and as Error", (_name, error) => {
    expect(error).toBeInstanceOf(WithdrawError);
    expect(error).toBeInstanceOf(Error);
    // `name` is what shows up in logs and in `err.name` checks; the base value would make
    // every withdrawal failure look identical.
    expect(error.name).toBe(error.constructor.name);
    expect(error.message.length).toBeGreaterThan(0);
  });

  it("keeps the underlying cause reachable", () => {
    const cause = new Error("ECONNRESET");
    expect(new WithdrawPublishUnknownError("socket closed", cause).cause).toBe(cause);
    expect(new WithdrawSettlementFailedError("0xintent", cause).cause).toBe(cause);
    expect(new WithdrawDeliveryUnconfirmedError("0xtx", "nep141:t.near", "x", cause).cause).toBe(cause);
  });
});

describe("messages carry the handle needed to follow it up", () => {
  it("names the hash a settlement can be re-checked with", () => {
    expect(new WithdrawSettlementUnconfirmedError("0xintent", "deadline").message).toContain("0xintent");
  });

  it("names the tx an unconfirmed delivery can be traced with, and does not claim a loss", () => {
    const error = new WithdrawDeliveryUnconfirmedError("0xtx", "nep141:t.near", "deadline");
    expect(error.message).toContain("0xtx");
    expect(error.message).toMatch(/may still arrive/i);
    expect(error.message).not.toMatch(/lost|failed/i);
  });

  it("names the nonce a cancelled HOT delivery is re-checked with, and still claims no loss", () => {
    const error = new WithdrawDeliveryCancelledError("0xtx", "4242");
    expect(error.message).toContain("4242");
    expect(error.message).toContain("0xtx");
    // Definite non-delivery is still not a loss claim: the funds left the balance, and what
    // the bridge did with them afterwards is not something this code observed.
    expect(error.message).not.toMatch(/lost/i);
  });

  it("distinguishes a missing NEAR account from an unregistered one", () => {
    const missing = new WithdrawDestinationUnusableError("missing-account", "nope.near", "usdt.tether-token.near");
    const unregistered = new WithdrawDestinationUnusableError("not-registered", "bob.near", "usdt.tether-token.near");
    expect(missing.message).toMatch(/does not exist/i);
    // The user-actionable part: it is not a typo, the account just has no storage there.
    expect(unregistered.message).toMatch(/not registered/i);
    expect(unregistered.message).toMatch(/without a refund/i);
  });

  it("keeps the relay's own code, not just its prose", () => {
    const error = new WithdrawRelayRejectedError("INSUFFICIENT_BALANCE", "insufficient balance or overflow");
    expect(error.code).toBe("INSUFFICIENT_BALANCE");
    expect(error.message).toContain("insufficient balance or overflow");
  });
});
