import { describe, it, expect } from "vitest";
import { portfolioDeleteStatus, type DeleteOfferInput } from "./portfolio-delete-offer";
import type { PendingAllocate } from "@/features/vault/lib/pending-allocates";

const PID = "p_00000000002a";

const pending = (portfolioId: string | null): PendingAllocate => ({
  id: "r",
  portfolioName: "x",
  op: portfolioId ? "allocate_into" : "setup",
  portfolioId,
  legs: [],
  createdAt: 0,
  kind: "confirming",
});

const real = (over: Partial<DeleteOfferInput> = {}): DeleteOfferInput => ({
  portfolio: { id: PID, isReal: true, deposits: {}, holdsNothingOnChain: true },
  pendingAllocates: [],
  mockPendingUnallocations: 0,
  ...over,
});

describe("portfolioDeleteStatus — real portfolio", () => {
  it("empty with nothing on its way", () => {
    expect(portfolioDeleteStatus(real())).toBe("empty");
  });

  it("funded while it holds anything on chain", () => {
    const portfolio = { id: PID, isReal: true, deposits: {}, holdsNothingOnChain: false };
    expect(portfolioDeleteStatus(real({ portfolio }))).toBe("funded");
    // Funds are the first thing to clear, whatever else is still loading.
    expect(portfolioDeleteStatus(real({ portfolio, pendingAllocates: undefined }))).toBe("funded");
  });

  it("incoming while a credit is on its way to THIS portfolio (D-302 g)", () => {
    expect(portfolioDeleteStatus(real({ pendingAllocates: [pending(PID)] }))).toBe("incoming");
  });

  it("ignores credits to other portfolios and new-portfolio setups", () => {
    expect(
      portfolioDeleteStatus(real({ pendingAllocates: [pending("p_000000000001"), pending(null)] }))
    ).toBe("empty");
  });

  it("checking while the pending credits or the chain balance are unknown", () => {
    expect(portfolioDeleteStatus(real({ pendingAllocates: undefined }))).toBe("checking");
    const portfolio = { id: PID, isReal: true, deposits: {} };
    expect(portfolioDeleteStatus(real({ portfolio }))).toBe("checking");
  });

  // Empty is the chain's word: a deposit the registry cannot price is not counted there.
  it("reads the chain, not the priced deposits", () => {
    const portfolio = { id: PID, isReal: true, deposits: { USDC: 3 }, holdsNothingOnChain: true };
    expect(portfolioDeleteStatus(real({ portfolio }))).toBe("empty");
  });
});

describe("portfolioDeleteStatus — mock portfolio", () => {
  const mock = (deposits: Record<string, number>, over: Partial<DeleteOfferInput> = {}) =>
    real({ portfolio: { id: "m1", isReal: false, deposits }, pendingAllocates: undefined, ...over });

  it("empty when every deposit is zero", () => {
    expect(portfolioDeleteStatus(mock({ USDC: 0 }))).toBe("empty");
    expect(portfolioDeleteStatus(mock({}))).toBe("empty");
  });

  it("funded while it holds funds or a withdrawal is still settling", () => {
    expect(portfolioDeleteStatus(mock({ USDC: 1 }))).toBe("funded");
    expect(portfolioDeleteStatus(mock({}, { mockPendingUnallocations: 1 }))).toBe("funded");
  });
});
