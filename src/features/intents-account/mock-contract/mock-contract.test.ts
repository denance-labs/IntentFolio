// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import { validatePortfolio, mockContract } from "./mock-contract";
import type { Signature } from "./types";

// ── validatePortfolio (pure) ─────────────────────────────────────────────

describe("validatePortfolio", () => {
  const comp = (pct: number) => [{ tokenId: "USDC", targetPct: pct, tolerancePct: 5 }];
  const bal = (qty: number) => ({ USDC: qty });

  it("accepts valid single-token portfolio", () => {
    expect(validatePortfolio(comp(100), bal(10))).toBeNull();
  });

  it("rejects empty composition", () => {
    expect(validatePortfolio([], bal(10))).toMatch(/at least 1 token/);
  });

  it("rejects composition that does not sum to 100%", () => {
    const c = [
      { tokenId: "USDC", targetPct: 60, tolerancePct: 5 },
      { tokenId: "NEAR", targetPct: 30, tolerancePct: 5 },
    ];
    expect(validatePortfolio(c, { USDC: 6, NEAR: 3 })).toMatch(/sum to 100/);
  });

  it("rejects when no token has target > 0% (all zeros but summing to 100 is impossible — guard for edge)", () => {
    // Artificially: one token with 100% target and 0 balance, another with 0%/0 → invariant 3 triggers first
    const c = [
      { tokenId: "USDC", targetPct: 100, tolerancePct: 5 },
      { tokenId: "NEAR", targetPct: 0, tolerancePct: 5 },
    ];
    expect(validatePortfolio(c, { USDC: 0, NEAR: 0 })).toMatch(/0% target and 0 balance/);
  });

  it("rejects token with 0% target AND 0 balance (invariant 3)", () => {
    const c = [
      { tokenId: "USDC", targetPct: 100, tolerancePct: 5 },
      { tokenId: "NEAR", targetPct: 0, tolerancePct: 5 },
    ];
    expect(validatePortfolio(c, { USDC: 10, NEAR: 0 })).toMatch(/NEAR.*0% target and 0 balance/);
  });

  it("allows token with 0% target when it still has balance (transitional state)", () => {
    const c = [
      { tokenId: "USDC", targetPct: 100, tolerancePct: 5 },
      { tokenId: "NEAR", targetPct: 0, tolerancePct: 5 },
    ];
    expect(validatePortfolio(c, { USDC: 10, NEAR: 5 })).toBeNull();
  });

  it("rejects portfolio with no tokens having balance > 0 (invariant 4)", () => {
    expect(validatePortfolio(comp(100), bal(0))).toMatch(/at least 1 token with balance > 0/);
  });

  it("accepts multi-token portfolio summing to 100%", () => {
    const c = [
      { tokenId: "USDC", targetPct: 60, tolerancePct: 5 },
      { tokenId: "NEAR", targetPct: 40, tolerancePct: 5 },
    ];
    expect(validatePortfolio(c, { USDC: 60, NEAR: 40 })).toBeNull();
  });
});

// ── MockContract queries ─────────────────────────────────────────────────

const mockSig: Signature = { scheme: "erc191", payload: "test", signature: "0x1234" };
// Bare IntentsAccountId (EVM = lowercase address, no chain prefix) — D-133.
const account = "0xabc";

describe("mockContract queries", () => {
  beforeEach(() => mockContract._reset());

  it("getIntentsAccount returns null for unknown id", () => {
    expect(mockContract.getIntentsAccount("evm:0xunknown")).toBeNull();
  });

  it("getGeneralBalance returns empty map for unknown id", () => {
    expect(mockContract.getGeneralBalance("evm:0xunknown").size).toBe(0);
  });

  it("getPortfolioBalance returns empty map for unknown id", () => {
    expect(mockContract.getPortfolioBalance("evm:0xunknown", "p1").size).toBe(0);
  });

  it("getEvents returns empty array for unknown id", () => {
    expect(mockContract.getEvents("evm:0xunknown")).toEqual([]);
  });
});

// ── MockContract mutations ───────────────────────────────────────────────

describe("mockContract.initialSetup", () => {
  beforeEach(() => mockContract._reset());

  it("registers account and portfolio", async () => {
    const composition = [{ tokenId: "USDC", targetPct: 100, tolerancePct: 5 }];
    const allocations = [{ tokenId: "USDC", qty: 100 }];

    const result = await mockContract.initialSetup(account, mockSig, "My Portfolio", composition, allocations);

    expect(result.accountId).toBe("0xabc");
    expect(result.portfolioId).toBeTruthy();
    expect(result.events.find((e) => e.kind === "register_user")).toBeTruthy();
    expect(result.events.find((e) => e.kind === "portfolio_created")).toBeTruthy();
  });

  it("getIntentsAccount returns the account after setup", async () => {
    const composition = [{ tokenId: "USDC", targetPct: 100, tolerancePct: 5 }];
    await mockContract.initialSetup(account, mockSig, "My Portfolio", composition, [{ tokenId: "USDC", qty: 50 }]);

    const acc = mockContract.getIntentsAccount("0xabc");
    expect(acc).not.toBeNull();
    expect(acc!.portfolios).toHaveLength(1);
    expect(acc!.portfolios[0].name).toBe("My Portfolio");
  });

  it("getPortfolioBalance reflects allocated tokens", async () => {
    const composition = [{ tokenId: "USDC", targetPct: 100, tolerancePct: 5 }];
    const { portfolioId } = await mockContract.initialSetup(account, mockSig, "P", composition, [
      { tokenId: "USDC", qty: 77 },
    ]);

    const bal = mockContract.getPortfolioBalance("0xabc", portfolioId);
    expect(bal.get("USDC")).toBe(77);
  });

  it("rejects invalid composition (sum != 100)", async () => {
    const composition = [{ tokenId: "USDC", targetPct: 50, tolerancePct: 5 }];
    await expect(
      mockContract.initialSetup(account, mockSig, "P", composition, [{ tokenId: "USDC", qty: 50 }])
    ).rejects.toThrow(/sum to 100/);
  });

  it("rejects duplicate setup for the same account", async () => {
    const composition = [{ tokenId: "USDC", targetPct: 100, tolerancePct: 5 }];
    await mockContract.initialSetup(account, mockSig, "P", composition, [{ tokenId: "USDC", qty: 10 }]);
    await expect(
      mockContract.initialSetup(account, mockSig, "P2", composition, [{ tokenId: "USDC", qty: 10 }])
    ).rejects.toThrow(/already exists/);
  });
});

describe("mockContract.creditReceive", () => {
  beforeEach(() => mockContract._reset());

  it("credits general balance and emits receive event", () => {
    mockContract.creditReceive("evm:0xnew", "USDT", 200, "evm", "0xbridge");

    const bal = mockContract.getGeneralBalance("evm:0xnew");
    expect(bal.get("USDT")).toBe(200);

    const events = mockContract.getEvents("evm:0xnew");
    expect(events.find((e) => e.kind === "receive")).toBeTruthy();
  });

  it("auto-registers account on first credit", () => {
    mockContract.creditReceive("evm:0xnew", "NEAR", 5, "near", "tx123");
    expect(mockContract.getIntentsAccount("evm:0xnew")).not.toBeNull();
  });

  it("accumulates multiple credits for same token", () => {
    mockContract.creditReceive("evm:0xacc", "USDC", 100, "evm", "tx1");
    mockContract.creditReceive("evm:0xacc", "USDC", 50, "evm", "tx2");
    expect(mockContract.getGeneralBalance("evm:0xacc").get("USDC")).toBe(150);
  });

  it("is idempotent by bridge tx (no double-credit on re-observe)", () => {
    // The polling hook re-observes a still-CREDITED deposit after a page reload,
    // when its in-memory dedup set is gone. Crediting the same bridge tx twice
    // must not inflate the balance or duplicate the receive event.
    mockContract.creditReceive("evm:0xidem", "USDC", 100, "evm", "tx-same");
    mockContract.creditReceive("evm:0xidem", "USDC", 100, "evm", "tx-same");
    expect(mockContract.getGeneralBalance("evm:0xidem").get("USDC")).toBe(100);
    expect(
      mockContract.getEvents("evm:0xidem").filter((e) => e.kind === "receive")
    ).toHaveLength(1);
  });
});

describe("mockContract.createEmptyPortfolio", () => {
  beforeEach(() => mockContract._reset());

  it("creates an empty portfolio and auto-registers the account", () => {
    const { portfolioId } = mockContract.createEmptyPortfolio("0xempty", "Draft");
    const acc = mockContract.getIntentsAccount("0xempty");
    expect(acc).not.toBeNull();
    expect(acc!.portfolios).toHaveLength(1);
    expect(acc!.portfolios[0].name).toBe("Draft");
    expect(acc!.portfolios[0].composition).toEqual([]);
    expect(mockContract.getPortfolioBalance("0xempty", portfolioId).size).toBe(0);
  });

  it("emits a portfolio_created event", () => {
    const { portfolioId } = mockContract.createEmptyPortfolio("0xempty2", "Draft");
    const ev = mockContract.getEvents("0xempty2").find((e) => e.kind === "portfolio_created");
    expect(ev).toBeTruthy();
    expect(ev && ev.kind === "portfolio_created" && ev.portfolio_id).toBe(portfolioId);
  });

  it("adds to an existing account without wiping prior portfolios", () => {
    mockContract.createEmptyPortfolio("0xmulti", "A");
    mockContract.createEmptyPortfolio("0xmulti", "B");
    expect(mockContract.getIntentsAccount("0xmulti")!.portfolios).toHaveLength(2);
  });
});

describe("mockContract.createPortfolio (atomic, signed — 5.6)", () => {
  beforeEach(() => mockContract._reset());

  // Composition USDC 100% funded with 50 — sums to 100 and has a funded token,
  // so it clears validatePortfolio.
  const validChanges = {
    tokenAdditions: [{ tokenId: "USDC", initialTargetPct: 100, initialTolerancePct: 5 }],
    allocations: [{ tokenId: "USDC", qty: 50 }],
  };

  // Regression: a wallet that already holds on-chain Intents balances but has no prior
  // mock activity (no deposit credited this session) has no account record. createPortfolio
  // must register on demand instead of throwing "Account … not found" right after the user
  // signs — the bug that broke first-portfolio creation for real pre-funded NEAR accounts.
  it("auto-registers an unknown account on first use", async () => {
    const { portfolioId } = await mockContract.createPortfolio("pablow.near", "Aggressive", validChanges, mockSig);
    const acc = mockContract.getIntentsAccount("pablow.near");
    expect(acc).not.toBeNull();
    expect(acc!.portfolios).toHaveLength(1);
    expect(acc!.portfolios[0].name).toBe("Aggressive");
    expect(mockContract.getPortfolioBalance("pablow.near", portfolioId).get("USDC")).toBe(50);
  });

  it("emits portfolio_created and allocate events", async () => {
    const { portfolioId, events } = await mockContract.createPortfolio("0xnew", "P", validChanges, mockSig);
    expect(events.find((e) => e.kind === "portfolio_created")).toBeTruthy();
    const alloc = events.find((e) => e.kind === "allocate");
    expect(alloc && alloc.kind === "allocate" && alloc.portfolio_id).toBe(portfolioId);
  });

  it("rejects invalid composition (sum != 100)", async () => {
    await expect(
      mockContract.createPortfolio(
        "0xbad",
        "P",
        {
          tokenAdditions: [{ tokenId: "USDC", initialTargetPct: 50, initialTolerancePct: 5 }],
          allocations: [{ tokenId: "USDC", qty: 50 }],
        },
        mockSig
      )
    ).rejects.toThrow(/sum to 100/);
  });

  // D-361 at the app's cap (D-476), with the same typed reason the real pre-flight raises, so the
  // preview shows its notice.
  it("refuses the 8th portfolio of an account", async () => {
    for (let i = 0; i < 7; i += 1) {
      await mockContract.createPortfolio("0xcap", `P${i}`, validChanges, mockSig);
    }
    await expect(mockContract.createPortfolio("0xcap", "P7", validChanges, mockSig)).rejects.toMatchObject({
      name: "RealChangeSetInvalidError",
      reason: "too-many-portfolios",
    });
    expect(mockContract.getIntentsAccount("0xcap")!.portfolios).toHaveLength(7);
  });

  it("adds to an already-registered account without wiping prior portfolios", async () => {
    mockContract.createEmptyPortfolio("0xmix", "Existing");
    await mockContract.createPortfolio("0xmix", "Funded", validChanges, mockSig);
    expect(mockContract.getIntentsAccount("0xmix")!.portfolios).toHaveLength(2);
  });
});

describe("mockContract.renamePortfolio", () => {
  beforeEach(() => mockContract._reset());

  it("renames an existing portfolio", () => {
    const { portfolioId } = mockContract.createEmptyPortfolio("0xren", "Old");
    mockContract.renamePortfolio("0xren", portfolioId, "New", mockSig);
    expect(mockContract.getIntentsAccount("0xren")!.portfolios[0].name).toBe("New");
  });

  it("is a no-op for unknown account or portfolio", () => {
    expect(() => mockContract.renamePortfolio("0xnope", "p1", "X", mockSig)).not.toThrow();
    mockContract.createEmptyPortfolio("0xren2", "Keep");
    mockContract.renamePortfolio("0xren2", "wrong-id", "X", mockSig);
    expect(mockContract.getIntentsAccount("0xren2")!.portfolios[0].name).toBe("Keep");
  });
});

// 017-9c: the mock follows the final contract (ADR-0023) — delete only when empty, no sweep.
describe("mockContract.deletePortfolio", () => {
  beforeEach(() => mockContract._reset());

  const funded = {
    tokenAdditions: [{ tokenId: "USDC", initialTargetPct: 100, initialTolerancePct: 5 }],
    allocations: [{ tokenId: "USDC", qty: 50 }],
  };

  it("refuses a portfolio that still holds funds, with the contract's code", async () => {
    const { portfolioId } = await mockContract.createPortfolio("0xdel", "Funded", funded, mockSig);
    const before = mockContract.getGeneralBalance("0xdel");
    await expect(mockContract.deletePortfolio("0xdel", portfolioId, mockSig)).rejects.toThrow(
      /E_PORTFOLIO_NOT_EMPTY/
    );
    expect(mockContract.getIntentsAccount("0xdel")!.portfolios).toHaveLength(1);
    expect(mockContract.getPortfolioBalance("0xdel", portfolioId).get("USDC")).toBe(50);
    expect(mockContract.getGeneralBalance("0xdel")).toEqual(before);
  });

  it("deletes an empty portfolio without touching the General Balance", async () => {
    const { portfolioId } = mockContract.createEmptyPortfolio("0xdel2", "Empty");
    const before = mockContract.getGeneralBalance("0xdel2");
    const { events } = await mockContract.deletePortfolio("0xdel2", portfolioId, mockSig);
    expect(mockContract.getIntentsAccount("0xdel2")!.portfolios).toHaveLength(0);
    expect(mockContract.getGeneralBalance("0xdel2")).toEqual(before);
    expect(events.map((e) => e.kind)).toEqual(["portfolio_deleted"]);
  });
});

describe("mockContract subscribe / version", () => {
  beforeEach(() => mockContract._reset());

  it("notifies subscribers on mutation and bumps the version", () => {
    let calls = 0;
    const before = mockContract.getVersion();
    const unsub = mockContract.subscribe(() => {
      calls++;
    });
    mockContract.creditReceive("0xsub", "USDC", 10, "evm", "tx1");
    expect(calls).toBe(1);
    expect(mockContract.getVersion()).toBeGreaterThan(before);
    unsub();
    mockContract.creditReceive("0xsub", "USDC", 10, "evm", "tx2");
    expect(calls).toBe(1);
  });
});

describe("mockContract.commitPortfolioChanges", () => {
  beforeEach(() => mockContract._reset());

  it("moves allocation from general to portfolio", async () => {
    const composition = [{ tokenId: "USDC", targetPct: 100, tolerancePct: 5 }];
    const { portfolioId } = await mockContract.initialSetup(
      account, mockSig, "P", composition, [{ tokenId: "USDC", qty: 50 }]
    );
    mockContract.creditReceive("0xabc", "USDC", 30, "evm", "tx1");

    await mockContract.commitPortfolioChanges("0xabc", portfolioId, {
      allocations: [{ tokenId: "USDC", qty: 30 }],
    }, mockSig);

    expect(mockContract.getPortfolioBalance("0xabc", portfolioId).get("USDC")).toBe(80);
    expect(mockContract.getGeneralBalance("0xabc").get("USDC") ?? 0).toBe(0);
  });

  it("rejects change that would violate invariant 4 (no funds)", async () => {
    const composition = [{ tokenId: "USDC", targetPct: 100, tolerancePct: 5 }];
    const { portfolioId } = await mockContract.initialSetup(
      account, mockSig, "P", composition, [{ tokenId: "USDC", qty: 50 }]
    );

    await expect(
      mockContract.commitPortfolioChanges("0xabc", portfolioId, {
        unallocations: [{ tokenId: "USDC", qty: 50 }],
      }, mockSig)
    ).rejects.toThrow(/balance > 0/);
  });
});

describe("mockContract.refundWithdrawal", () => {
  beforeEach(() => mockContract._reset());

  it("marks status FAILED and returns qty to generalBalance", async () => {
    const mockSig: Signature = { scheme: "nep413", payload: "p", signature: "s", publicKey: "k" };
    await mockContract.initialSetup(
      "alice.near", mockSig, "P", [{ tokenId: "USDC", targetPct: 100, tolerancePct: 5 }],
      [{ tokenId: "USDC", qty: 500 }]
    );
    // Fund the General Balance directly (unallocation is now an async pending leg — C1 — so it
    // no longer credits the General Balance synchronously; this test exercises refundWithdrawal).
    mockContract.creditReceive("alice.near", "USDC", 100, "evm", "fund-tx");

    const { intentId } = await mockContract.withdraw("alice.near", "USDC", 100, "evm", "0xabc", mockSig);
    mockContract.trackWithdrawal(intentId, {
      accountId: "alice.near", tokenId: "USDC", qty: 100, chainId: "eth:1",
      destinationAddress: "0xabc", ts: Date.now(),
    });

    // Before refund: general balance is 0 (qty was deducted by withdraw)
    expect(mockContract.getGeneralBalance("alice.near").get("USDC")).toBe(0);

    mockContract.refundWithdrawal(intentId);

    expect(mockContract.getTrackedWithdrawals("alice.near")[0].status).toBe("FAILED");
    expect(mockContract.getGeneralBalance("alice.near").get("USDC")).toBe(100);
  });

  it("is a no-op for unknown intentId", () => {
    expect(() => mockContract.refundWithdrawal("nonexistent")).not.toThrow();
  });
});

// ── Event log shape (7.0) ─────────────────────────────────────────────────

describe("mockContract event log shape (7.0)", () => {
  beforeEach(() => mockContract._reset());

  it("emits token_added and target_change on a composition commit", async () => {
    const { portfolioId } = await mockContract.initialSetup(
      account, mockSig, "P", [{ tokenId: "USDC", targetPct: 100, tolerancePct: 5 }], [{ tokenId: "USDC", qty: 100 }]
    );
    mockContract.creditReceive("0xabc", "NEAR", 50, "near", "txn");

    const { events } = await mockContract.commitPortfolioChanges("0xabc", portfolioId, {
      tokenAdditions: [{ tokenId: "NEAR", initialTargetPct: 30, initialTolerancePct: 5 }],
      targetChanges: [{ tokenId: "USDC", newTargetPct: 70, newTolerancePct: 5 }],
      allocations: [{ tokenId: "NEAR", qty: 50 }],
    }, mockSig);

    const added = events.find((e) => e.kind === "token_added");
    expect(added && added.kind === "token_added" && added.token).toBe("NEAR");
    expect(added && added.kind === "token_added" && added.initial_target_pct).toBe(30);

    const tc = events.find((e) => e.kind === "target_change");
    expect(tc && tc.kind === "target_change" && tc.old_target_pct).toBe(100);
    expect(tc && tc.kind === "target_change" && tc.new_target_pct).toBe(70);
  });

  it("emits token_removed when a token is dropped from composition", async () => {
    const { portfolioId } = await mockContract.initialSetup(
      account, mockSig, "P",
      [{ tokenId: "USDC", targetPct: 60, tolerancePct: 5 }, { tokenId: "NEAR", targetPct: 40, tolerancePct: 5 }],
      [{ tokenId: "USDC", qty: 60 }, { tokenId: "NEAR", qty: 40 }]
    );

    const { events } = await mockContract.commitPortfolioChanges("0xabc", portfolioId, {
      targetChanges: [{ tokenId: "USDC", newTargetPct: 100, newTolerancePct: 5 }],
      unallocations: [{ tokenId: "NEAR", qty: 40 }],
      tokenRemovals: [{ tokenId: "NEAR" }],
    }, mockSig);

    const removed = events.find((e) => e.kind === "token_removed");
    expect(removed && removed.kind === "token_removed" && removed.token).toBe("NEAR");
  });

  it("shares a single commit_id across all events of one Portfolio Commit", async () => {
    await mockContract.initialSetup(
      account, mockSig, "P", [{ tokenId: "USDC", targetPct: 100, tolerancePct: 5 }], [{ tokenId: "USDC", qty: 100 }]
    );
    const events = mockContract.getEvents("0xabc"); // register_user + portfolio_created + token_added + allocate
    const commitIds = new Set(events.map((e) => ("commit_id" in e ? e.commit_id : "NONE")));
    expect(commitIds.size).toBe(1);
    expect(commitIds.has("NONE")).toBe(false);
    // register_user carries the commit_id of its setup commit.
    const reg = events.find((e) => e.kind === "register_user");
    expect(reg && "commit_id" in reg && reg.commit_id.length > 0).toBe(true);
  });

  it("assigns a unique non-empty event_id to every event", async () => {
    await mockContract.initialSetup(
      account, mockSig, "P", [{ tokenId: "USDC", targetPct: 100, tolerancePct: 5 }], [{ tokenId: "USDC", qty: 100 }]
    );
    const ids = mockContract.getEvents("0xabc").map((e) => e.event_id);
    expect(ids.length).toBeGreaterThan(1);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
  });

  it("does not attach commit_id to bridge deposits or withdrawals", async () => {
    await mockContract.initialSetup(
      "alice.near", mockSig, "P", [{ tokenId: "USDC", targetPct: 100, tolerancePct: 5 }], [{ tokenId: "USDC", qty: 500 }]
    );
    mockContract.creditReceive("alice.near", "USDC", 100, "evm", "txr");
    await mockContract.withdraw("alice.near", "USDC", 50, "evm", "0xdest", mockSig);

    const events = mockContract.getEvents("alice.near");
    const receive = events.find((e) => e.kind === "receive");
    const withdraw = events.find((e) => e.kind === "withdraw");
    expect(receive && "commit_id" in receive).toBe(false);
    expect(withdraw && "commit_id" in withdraw).toBe(false);
  });
});

// `mirrorRealPortfolio` was retired in 008.plan Phase 1 (D-R6) — real portfolios are read
// from the vault, never mirrored into this ledger. Its tests went with it; the projection
// that replaced it is covered in `vault/lib/project-vault-portfolio.test.ts`.
