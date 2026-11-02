import { describe, expect, it } from "vitest";
import {
  bpsToPct,
  projectVaultPortfolio,
  projectVaultPortfolios,
  type RealPortfolioRead,
} from "./project-vault-portfolio";
import type { VaultPortfolio } from "./vault-read-client";

// The projection is the seam that replaced `mirrorRealPortfolio` (008.plan Phase 1, D-R6).
// Two conversions here can corrupt money or intent silently — basis points → percent and
// base units → human units — so both are pinned against the real on-chain shapes.

const USDT = "nep141:usdt.tether-token.near"; // 6 decimals in the registry
const BTC = "nep141:btc.omft.near"; // 8 decimals

// The composition the operator's `p_000000000005` actually carries on mainnet.
const record = (over: Partial<VaultPortfolio> = {}): VaultPortfolio => ({
  owner: "0xc8b1e10d011aceed84f4cdba66ca175bd6552a36",
  name: "Conservative USDT n ETH",
  composition: [
    { token_id: USDT, target_bps: 3000, tolerance_bps: 500 },
    { token_id: BTC, target_bps: 7000, tolerance_bps: 500 },
  ],
  held_tokens: [],
  created_at: 1785375284,
  deleted: false,
  deleted_at: 0,
  ...over,
});

const read = (over: Partial<RealPortfolioRead> = {}): RealPortfolioRead => ({
  id: "p_000000000005",
  portfolio: record(),
  balances: [],
  ...over,
});

describe("bpsToPct", () => {
  it("converts the contract's basis points to the UI's percent", () => {
    expect(bpsToPct(3000)).toBe(30);
    expect(bpsToPct(2500)).toBe(25);
    expect(bpsToPct(500)).toBe(5);
    expect(bpsToPct(10_000)).toBe(100);
  });
});

describe("projectVaultPortfolio", () => {
  it("carries the declared composition through unchanged — the whole point of D-174", () => {
    // The chain held 3000/7000 while the UI drew 0%/0%. Projecting from this record is
    // what makes that divergence unrepresentable.
    const targets = projectVaultPortfolio(read(), 10).targets;
    expect(targets.map((t) => t.targetPct)).toEqual([30, 70]);
    expect(targets.map((t) => t.tolerancePct)).toEqual([5, 5]);
  });

  it("shows the composition of an EMPTIED portfolio (D-R15: alive, not deleted)", () => {
    const projected = projectVaultPortfolio(read({ balances: [] }), 10);
    expect(projected.deposits).toEqual({});
    expect(projected.targets).toHaveLength(2);
  });

  // 017-9c: the delete offer keys on this, so it must come from the raw read, not `deposits`.
  it("flags a portfolio that holds nothing on chain, and only that one", () => {
    expect(projectVaultPortfolio(read({ balances: [] }), 10).holdsNothingOnChain).toBe(true);
    expect(
      projectVaultPortfolio(read({ balances: [[USDT, BigInt(1)]] }), 10).holdsNothingOnChain
    ).toBe(false);
    // A token the registry cannot price is invisible in `deposits` but still held.
    const unknown = projectVaultPortfolio(
      read({ balances: [["nep141:not-in-registry.near", BigInt(1)]] }),
      10
    );
    expect(unknown.deposits).toEqual({});
    expect(unknown.holdsNothingOnChain).toBe(false);
  });

  it("derives row ids from the tokenId so a re-read cannot remount the table row", () => {
    const first = projectVaultPortfolio(read(), 10).targets.map((t) => t.id);
    const second = projectVaultPortfolio(read(), 10).targets.map((t) => t.id);
    expect(first).toEqual([`target-${USDT}`, `target-${BTC}`]);
    expect(first).toEqual(second);
  });

  it("converts base units to human units with the token's own decimals", () => {
    const projected = projectVaultPortfolio(
      read({ balances: [[USDT, BigInt(3_500_000)], [BTC, BigInt(150_000_000)]] }),
      10
    );
    // 3_500_000 / 1e6 = 3.5 USDT (the wet test's exact amount); 1.5e8 / 1e8 = 1.5 BTC.
    expect(projected.deposits[USDT]).toBe(3.5);
    expect(projected.deposits[BTC]).toBe(1.5);
  });

  it("does not lose precision on a large 24-decimal-style balance", () => {
    const projected = projectVaultPortfolio(read({ balances: [[USDT, BigInt(1)]] }), 10);
    expect(projected.deposits[USDT]).toBe(0.000001);
  });

  it("skips a token outside the curated registry rather than inventing decimals", () => {
    const projected = projectVaultPortfolio(
      read({ balances: [["nep141:not-in-registry.near", BigInt(1)], [USDT, BigInt(1_000_000)]] }),
      10
    );
    expect(projected.deposits).toEqual({ [USDT]: 1 });
  });

  it("scales created_at from the contract's seconds to milliseconds", () => {
    expect(projectVaultPortfolio(read(), 10).createdAt).toBe(1785375284 * 1000);
  });

  it("marks the portfolio real so every write routes to the chain", () => {
    expect(projectVaultPortfolio(read(), 10).isReal).toBe(true);
  });

  it("takes the tolerance band from the UI side-table, not from the chain", () => {
    expect(projectVaultPortfolio(read(), 7).defaultTolerancePct).toBe(7);
  });
});

describe("projectVaultPortfolios", () => {
  it("gives every portfolio the same default band for new rows (016 Q4)", () => {
    const projected = projectVaultPortfolios([read({ id: "p_1" }), read({ id: "p_2" })], 10);
    expect(projected.map((p) => p.defaultTolerancePct)).toEqual([10, 10]);
  });

  it("keeps the vault's own ids — Phase 2 builds its changesets against them", () => {
    const projected = projectVaultPortfolios([read({ id: "p_000000000005" })], 10);
    expect(projected[0].id).toBe("p_000000000005");
  });
});
