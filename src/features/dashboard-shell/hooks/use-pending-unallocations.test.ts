import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mockContract } from "@/features/intents-account/mock-contract";
import type { Signature, PendingUnallocationRecord } from "@/features/intents-account/mock-contract/types";
import { isFailPath, isExtendedPath, resolveAt, FAST_SETTLE_MS } from "./use-pending-unallocations";

// C1 — async, non-atomic unallocation leg. Mirrors use-pending-withdrawals.test: the data
// layer (mock contract methods) is tested directly; the deterministic settlement buckets are
// tested as pure functions. Hook timer wiring is verified via visual QA.

const mockSig: Signature = { scheme: "nep413", payload: "p", signature: "s", publicKey: "k" };
const ACCOUNT = "0xabc";

// Two funded tokens so unallocating one never trips the "must keep ≥1 funded token" gate.
async function setupPortfolio(): Promise<string> {
  const { portfolioId } = await mockContract.initialSetup(
    ACCOUNT, mockSig, "P",
    [{ tokenId: "USDC", targetPct: 50, tolerancePct: 5 }, { tokenId: "NEAR", targetPct: 50, tolerancePct: 5 }],
    [{ tokenId: "USDC", qty: 100 }, { tokenId: "NEAR", qty: 100 }]
  );
  return portfolioId;
}

describe("mockContract pending unallocations (C1)", () => {
  beforeEach(() => mockContract._reset());
  afterEach(() => mockContract._reset());

  it("commit defers the unallocation: funds stay reserved in the portfolio, General Balance unchanged", async () => {
    const portfolioId = await setupPortfolio();

    await mockContract.commitPortfolioChanges(ACCOUNT, portfolioId, {
      unallocations: [{ tokenId: "NEAR", qty: 40 }],
    }, mockSig);

    // Funds remain in the portfolio (reserved) — not moved to General Balance yet.
    expect(mockContract.getPortfolioBalance(ACCOUNT, portfolioId).get("NEAR")).toBe(100);
    expect(mockContract.getGeneralBalance(ACCOUNT).get("NEAR") ?? 0).toBe(0);

    const pending = mockContract.getPendingUnallocations(ACCOUNT);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ tokenId: "NEAR", qty: 40, status: "PENDING" });
    expect(pending[0].reserveDeadline).toBeGreaterThan(pending[0].ts);
  });

  it("does NOT emit the unallocate event at commit time (deferred to settle)", async () => {
    const portfolioId = await setupPortfolio();
    await mockContract.commitPortfolioChanges(ACCOUNT, portfolioId, {
      unallocations: [{ tokenId: "NEAR", qty: 40 }],
    }, mockSig);

    expect(mockContract.getEvents(ACCOUNT).some((e) => e.kind === "unallocate")).toBe(false);
  });

  it("settleUnallocation moves funds portfolio → General Balance and emits unallocate with the original commit_id", async () => {
    const portfolioId = await setupPortfolio();
    await mockContract.commitPortfolioChanges(ACCOUNT, portfolioId, {
      unallocations: [{ tokenId: "NEAR", qty: 40 }],
    }, mockSig);
    const { unallocationId, commitId } = mockContract.getPendingUnallocations(ACCOUNT)[0];

    mockContract.settleUnallocation(ACCOUNT, unallocationId);

    expect(mockContract.getPortfolioBalance(ACCOUNT, portfolioId).get("NEAR")).toBe(60);
    expect(mockContract.getGeneralBalance(ACCOUNT).get("NEAR")).toBe(40);
    // Record is dropped once settled.
    expect(mockContract.getPendingUnallocations(ACCOUNT)).toHaveLength(0);
    // The deferred event carries the original commit's id (D-082 grouping preserved).
    const evt = mockContract.getEvents(ACCOUNT).find((e) => e.kind === "unallocate");
    expect(evt && evt.kind === "unallocate" && evt.commit_id).toBe(commitId);
    expect(evt && evt.kind === "unallocate" && evt.qty).toBe(40);
  });

  it("failUnallocation marks FAILED and leaves the funds in the portfolio (retry-safe)", async () => {
    const portfolioId = await setupPortfolio();
    await mockContract.commitPortfolioChanges(ACCOUNT, portfolioId, {
      unallocations: [{ tokenId: "NEAR", qty: 40 }],
    }, mockSig);
    const { unallocationId } = mockContract.getPendingUnallocations(ACCOUNT)[0];

    mockContract.failUnallocation(ACCOUNT, unallocationId);

    // Funds never left the portfolio; General Balance stays empty.
    expect(mockContract.getPortfolioBalance(ACCOUNT, portfolioId).get("NEAR")).toBe(100);
    expect(mockContract.getGeneralBalance(ACCOUNT).get("NEAR") ?? 0).toBe(0);
    const record = mockContract.getPendingUnallocations(ACCOUNT)[0];
    expect(record.status).toBe("FAILED");
    // No unallocate event for a reverted leg.
    expect(mockContract.getEvents(ACCOUNT).some((e) => e.kind === "unallocate")).toBe(false);
  });

  it("settle clamps at the available reserved balance", async () => {
    const portfolioId = await setupPortfolio();
    await mockContract.commitPortfolioChanges(ACCOUNT, portfolioId, {
      unallocations: [{ tokenId: "NEAR", qty: 40 }],
    }, mockSig);
    const { unallocationId } = mockContract.getPendingUnallocations(ACCOUNT)[0];

    // Settling twice must not over-credit (record is already gone the second time → no-op).
    mockContract.settleUnallocation(ACCOUNT, unallocationId);
    mockContract.settleUnallocation(ACCOUNT, unallocationId);

    expect(mockContract.getGeneralBalance(ACCOUNT).get("NEAR")).toBe(40);
  });

  it("isolates pending unallocations by account and returns newest first", async () => {
    const portfolioId = await setupPortfolio();
    await mockContract.commitPortfolioChanges(ACCOUNT, portfolioId, {
      unallocations: [{ tokenId: "USDC", qty: 10 }],
    }, mockSig);
    await mockContract.commitPortfolioChanges(ACCOUNT, portfolioId, {
      unallocations: [{ tokenId: "NEAR", qty: 20 }],
    }, mockSig);

    const pending = mockContract.getPendingUnallocations(ACCOUNT);
    expect(pending).toHaveLength(2);
    expect(pending[0].ts).toBeGreaterThanOrEqual(pending[1].ts);
    expect(mockContract.getPendingUnallocations("other.near")).toHaveLength(0);
  });

  it("is a no-op for an unknown unallocationId", () => {
    expect(() => mockContract.settleUnallocation(ACCOUNT, "nope")).not.toThrow();
    expect(() => mockContract.failUnallocation(ACCOUNT, "nope")).not.toThrow();
  });
});

describe("usePendingUnallocations deterministic buckets", () => {
  const make = (id: string, ts = 1_000, reserveDeadline = 91_000): PendingUnallocationRecord => ({
    unallocationId: id,
    accountId: ACCOUNT,
    portfolioId: "p1",
    tokenId: "NEAR",
    qty: 1,
    commitId: "c1",
    status: "PENDING",
    ts,
    reserveDeadline,
  });

  it("routes ~25% of ids to the FAILED path (first char 0–3)", () => {
    expect(["0", "1", "2", "3"].every((c) => isFailPath(`${c}xyz`))).toBe(true);
    expect(["4", "5", "6", "a", "f"].some((c) => isFailPath(`${c}xyz`))).toBe(false);
  });

  it("routes ids with first char 4–5 to the extended path", () => {
    expect(isExtendedPath("4abc")).toBe(true);
    expect(isExtendedPath("5abc")).toBe(true);
    expect(isExtendedPath("6abc")).toBe(false);
    expect(isExtendedPath("0abc")).toBe(false); // fail path, not extended
  });

  it("fast legs resolve a fixed delay after commit; extended/failed legs resolve at the reserve deadline", () => {
    expect(resolveAt(make("9fast"))).toBe(1_000 + FAST_SETTLE_MS); // fast
    expect(resolveAt(make("4ext"))).toBe(91_000);                  // extended → deadline
    expect(resolveAt(make("0fail"))).toBe(91_000);                 // failed → deadline
  });
});
