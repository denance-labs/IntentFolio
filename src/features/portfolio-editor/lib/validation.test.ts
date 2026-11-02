import { describe, it, expect } from "vitest";
import { validateComposition, RULE_MESSAGE_KEYS } from "./validation";
import type { ComputedTargetAllocation } from "../types";

// The adapter only reads tokenId/targetPct/tolerancePct off each row.
const row = (tokenId: string, targetPct: number, tolerancePct = 5): ComputedTargetAllocation =>
  ({ tokenId, targetPct, tolerancePct } as unknown as ComputedTargetAllocation);

describe("validateComposition", () => {
  it("returns no violations and hasErrors=false for a valid composition", () => {
    const v = validateComposition([row("USDC", 100)], { USDC: 10 });
    expect(v.violations).toEqual([]);
    expect(v.hasErrors).toBe(false);
    expect(v.global).toEqual([]);
    expect(v.byTokenId).toEqual({});
  });

  it("splits a global rule (sum) from per-row rules (tolerance) and sets hasErrors", () => {
    const v = validateComposition([row("USDC", 60, 1), row("NEAR", 30, 1)], { USDC: 6, NEAR: 3 });
    expect(v.hasErrors).toBe(true);
    expect(v.global.map((x) => x.code)).toContain("sum-not-100");
    expect(v.byTokenId["USDC"]?.some((x) => x.code === "tolerance-below-min")).toBe(true);
    expect(v.byTokenId["NEAR"]?.some((x) => x.code === "tolerance-below-min")).toBe(true);
  });

  it("keeps soft warnings out of hasErrors", () => {
    const v = validateComposition([row("USDC", 100, 20)], { USDC: 10 });
    expect(v.hasErrors).toBe(false);
    expect(v.byTokenId["USDC"]?.[0]).toMatchObject({ code: "tolerance-high", severity: "warning" });
  });

  it("attributes zero-target-zero-balance to the offending row", () => {
    const v = validateComposition([row("USDC", 100), row("NEAR", 0)], { USDC: 10, NEAR: 0 });
    expect(v.byTokenId["NEAR"]?.some((x) => x.code === "zero-target-zero-balance")).toBe(true);
    expect(v.hasErrors).toBe(true);
  });
});

// A live-vault portfolio answers to the vault's rules, not the mock's. The vault keeps an
// emptied portfolio alive (composition intact, qty_held pruned), so a full withdrawal must
// be signable — otherwise the round-trip has no last step (007.plan Phase 2, D-R15).
describe("validateComposition — allowEmptyPortfolio", () => {
  const drained = [row("USDC", 60), row("NEAR", 40)];

  it("blocks an emptied portfolio by default (the mock deletes it instead)", () => {
    const v = validateComposition(drained, { USDC: 0, NEAR: 0 });
    expect(v.global.map((x) => x.code)).toContain("no-funded-token");
    expect(v.hasErrors).toBe(true);
  });

  it("allows an emptied portfolio on the live-vault path", () => {
    const v = validateComposition(drained, { USDC: 0, NEAR: 0 }, { allowEmptyPortfolio: true });
    expect(v.global.map((x) => x.code)).not.toContain("no-funded-token");
    expect(v.hasErrors).toBe(false);
  });

  it("still enforces every OTHER rule — the exemption is one rule wide", () => {
    // Targets that do not sum to 100 stay rejected even with an empty balance allowed.
    const v = validateComposition(
      [row("USDC", 60), row("NEAR", 30)],
      { USDC: 0, NEAR: 0 },
      { allowEmptyPortfolio: true }
    );
    expect(v.global.map((x) => x.code)).toContain("sum-not-100");
    expect(v.hasErrors).toBe(true);
  });

  it("does not change a funded portfolio's verdict", () => {
    const v = validateComposition(drained, { USDC: 6, NEAR: 4 }, { allowEmptyPortfolio: true });
    expect(v.violations).toEqual([]);
    expect(v.hasErrors).toBe(false);
  });
});

// The chain REQUIRES a token addition to carry target 0 ("token addition must start at
// target_bps 0", verified in the deployed WASM DSh3nUNP…m7ou) and does NOT implement the
// mock's dead-row rule. With both gates on, a token could never join a real portfolio:
// the only shape the chain accepts is the one the editor rejected (008.plan Phase 2, D-187).
describe("validateComposition — allowZeroTargetZeroBalance", () => {
  // A token joining a funded portfolio: 0% target, no balance yet.
  const joining = [row("USDC", 100), row("SOL", 0)];

  it("blocks a 0%/0-balance row by default (the mock's rule 4)", () => {
    const v = validateComposition(joining, { USDC: 10, SOL: 0 });
    expect(v.byTokenId["SOL"]?.some((x) => x.code === "zero-target-zero-balance")).toBe(true);
    expect(v.hasErrors).toBe(true);
  });

  it("allows the joining token on the live-vault path", () => {
    const v = validateComposition(joining, { USDC: 10, SOL: 0 }, { allowZeroTargetZeroBalance: true });
    expect(v.byTokenId["SOL"] ?? []).toEqual([]);
    expect(v.hasErrors).toBe(false);
  });

  it("still enforces every OTHER rule — the exemption is one rule wide", () => {
    const v = validateComposition(
      [row("USDC", 90), row("SOL", 0)],
      { USDC: 10, SOL: 0 },
      { allowZeroTargetZeroBalance: true }
    );
    expect(v.global.map((x) => x.code)).toContain("sum-not-100");
    expect(v.hasErrors).toBe(true);
  });

  it("does not drop the sibling exemption's rule", () => {
    // Only zero/zero is waived: an unfunded portfolio still trips no-funded-token.
    const v = validateComposition(joining, { USDC: 0, SOL: 0 }, { allowZeroTargetZeroBalance: true });
    expect(v.global.map((x) => x.code)).toContain("no-funded-token");
    expect(v.hasErrors).toBe(true);
  });

  it("waives both rules when both are set (the live-vault editor)", () => {
    const v = validateComposition(
      joining,
      { USDC: 0, SOL: 0 },
      { allowEmptyPortfolio: true, allowZeroTargetZeroBalance: true }
    );
    expect(v.violations).toEqual([]);
    expect(v.hasErrors).toBe(false);
  });
});

describe("RULE_MESSAGE_KEYS", () => {
  it("maps every rule code to a translation key", () => {
    const codes = [
      "empty-composition",
      "sum-not-100",
      "no-target-above-zero",
      "zero-target-zero-balance",
      "no-funded-token",
      "tolerance-below-min",
      "tolerance-above-max",
      "tolerance-high",
    ] as const;
    for (const code of codes) {
      expect(RULE_MESSAGE_KEYS[code]).toBeTruthy();
    }
  });
});
