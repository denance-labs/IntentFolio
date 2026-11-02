// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { ACCOUNT_DEPOSIT_EVENT, ACCOUNT_WITHDRAWAL_EVENT, type ChainHistoryEvent } from "@/features/vault/lib/vault-history";
import {
  DRAFT_SUBJECT,
  forgetAssignFundsPrompt,
  getAssignFundsPromptSeenAt,
  latestDepositTs,
  markAssignFundsPromptSeen,
  shouldOfferAssignFunds,
} from "./assign-funds-prompt";
import { discardNewPortfolioDraft, saveNewPortfolioDraft } from "./new-portfolio-draft";

const event = (event: string, ts: number): ChainHistoryEvent => ({ txHash: `t${ts}`, index: 0, ts, event, data: {} });

afterEach(() => localStorage.clear());

describe("the stored answer", () => {
  it("is kept per account and subject", () => {
    markAssignFundsPromptSeen("alice.near", DRAFT_SUBJECT, 100);
    markAssignFundsPromptSeen("alice.near", "p_1", 200);
    expect(getAssignFundsPromptSeenAt("alice.near", DRAFT_SUBJECT)).toBe(100);
    expect(getAssignFundsPromptSeenAt("alice.near", "p_1")).toBe(200);
    expect(getAssignFundsPromptSeenAt("bob.near", DRAFT_SUBJECT)).toBeNull();
    forgetAssignFundsPrompt("alice.near", DRAFT_SUBJECT);
    expect(getAssignFundsPromptSeenAt("alice.near", DRAFT_SUBJECT)).toBeNull();
    expect(getAssignFundsPromptSeenAt("alice.near", "p_1")).toBe(200);
  });

  it("reads corrupt storage as never answered", () => {
    localStorage.setItem("portfolio.assign-funds-prompt.v1", "{not json");
    expect(getAssignFundsPromptSeenAt("alice.near", DRAFT_SUBJECT)).toBeNull();
  });

  it("goes with a discarded draft, so the next draft is offered it again", () => {
    const saved = saveNewPortfolioDraft(
      "alice.near",
      { name: "Mine", presetId: null, rows: [{ tokenId: "near", targetPct: 100, tolerancePct: 10, locked: false }] },
      []
    );
    expect(saved.ok).toBe(true);
    markAssignFundsPromptSeen("alice.near", DRAFT_SUBJECT, 100);
    discardNewPortfolioDraft("alice.near");
    expect(getAssignFundsPromptSeenAt("alice.near", DRAFT_SUBJECT)).toBeNull();
  });
});

describe("latestDepositTs", () => {
  it("reads only deposits: funds out of a portfolio and withdrawals do not count", () => {
    expect(latestDepositTs([event("unallocate", 900), event(ACCOUNT_WITHDRAWAL_EVENT, 800), event(ACCOUNT_DEPOSIT_EVENT, 300), event(ACCOUNT_DEPOSIT_EVENT, 500)])).toBe(500);
    expect(latestDepositTs([event("unallocate", 900)])).toBeNull();
  });
});

describe("shouldOfferAssignFunds", () => {
  it("never answered: on offer whenever eligible", () => {
    expect(shouldOfferAssignFunds({ eligible: true, seenAt: null, latestDeposit: "pending" })).toBe(true);
    expect(shouldOfferAssignFunds({ eligible: false, seenAt: null, latestDeposit: null })).toBe(false);
  });

  it("answered: back only with a deposit after the answer", () => {
    expect(shouldOfferAssignFunds({ eligible: true, seenAt: 1000, latestDeposit: 1001 })).toBe(true);
    expect(shouldOfferAssignFunds({ eligible: true, seenAt: 1000, latestDeposit: 999 })).toBe(false);
    expect(shouldOfferAssignFunds({ eligible: false, seenAt: 1000, latestDeposit: 1001 })).toBe(false);
  });

  it("answered: not while the history is read, nor when it failed or is off", () => {
    expect(shouldOfferAssignFunds({ eligible: true, seenAt: 1000, latestDeposit: "pending" })).toBe(false);
    expect(shouldOfferAssignFunds({ eligible: true, seenAt: 1000, latestDeposit: null })).toBe(false);
  });
});
