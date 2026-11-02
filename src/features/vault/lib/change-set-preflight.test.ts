import { describe, it, expect } from "vitest";
import {
  appPortfolioCap,
  APP_MAX_PORTFOLIOS_PER_ACCOUNT,
  assertAllocateIntoFits,
  assertAllocationLegIds,
  assertSetupFits,
  assertSetupLegCount,
  assertValidComposition,
  assertValidChangeSetShape,
  resultingComposition,
  pctToBps,
  ChangeSetPreflightError,
  type ChangeSetBps,
  type CompositionRowBps,
  type PreflightLimits,
  type PreflightReason,
  MIRRORED_LIMITS,
} from "./change-set-preflight";

const A = "nep141:a.omft.near";
const B = "nep141:b.omft.near";
const C = "nep141:c.omft.near";

const row = (tokenId: string, targetBps: number, toleranceBps = 500): CompositionRowBps => ({
  tokenId,
  targetBps,
  toleranceBps,
});

const changeSet = (over: Partial<ChangeSetBps> = {}): ChangeSetBps => ({
  targetChanges: [],
  tokenAdditions: [],
  tokenRemovals: [],
  unallocations: [],
  ...over,
});

/** Asserts the specific reason, not just that it threw — the reason drives the UI copy. */
function expectReason(fn: () => unknown, reason: PreflightReason) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ChangeSetPreflightError);
    expect((e as ChangeSetPreflightError).reason).toBe(reason);
    return;
  }
  throw new Error(`expected ${reason}, but nothing was thrown`);
}

describe("assertValidComposition", () => {
  it("accepts a composition whose targets sum to exactly 10000 bps", () => {
    expect(() => assertValidComposition([row(A, 6_000), row(B, 4_000)])).not.toThrow();
  });

  it("accepts a single token at full target", () => {
    expect(() => assertValidComposition([row(A, 10_000, 200)])).not.toThrow();
  });

  it("accepts a held-but-zero-target row as long as the rest carry the 100%", () => {
    // The state a deposit outside the declared strategy produces (D-186).
    expect(() => assertValidComposition([row(A, 10_000), row(B, 0)])).not.toThrow();
  });

  it("rejects an empty composition", () => {
    expectReason(() => assertValidComposition([]), "empty-composition");
  });

  it("rejects a duplicate token", () => {
    expectReason(() => assertValidComposition([row(A, 5_000), row(A, 5_000)]), "duplicate-token");
  });

  it("rejects a tolerance outside the hard band [200, 3000] bps", () => {
    expectReason(() => assertValidComposition([row(A, 10_000, 100)]), "tolerance-out-of-band");
    expectReason(() => assertValidComposition([row(A, 10_000, 3_100)]), "tolerance-out-of-band");
  });

  it("rejects more than 32 tokens", () => {
    const many = Array.from({ length: 33 }, (_, i) => row(`nep141:t${i}.near`, 0));
    many[0].targetBps = 10_000;
    expectReason(() => assertValidComposition(many), "too-many-tokens");
  });

  it("rejects a token id longer than 128 BYTES, measured in utf-8", () => {
    // 65 two-byte characters = 130 bytes, but only 65 JS "characters" — a .length check
    // would have let this through and the contract would not.
    expectReason(() => assertValidComposition([row("é".repeat(65), 10_000)]), "token-id-too-long");
  });

  describe("the rounding rule — why this module exists", () => {
    it("rejects a composition that sums to 100% in floats but 9999 bps", () => {
      // 33.333 + 33.333 + 33.334 = 100.0 exactly, so the editor's percent-space gate
      // (|sum - 100| > 0.001) passes it. In bps it is 3333 + 3333 + 3333 = 9999.
      const pcts = [33.333, 33.333, 33.334];
      expect(pcts.reduce((a, b) => a + b, 0)).toBe(100);
      const composition = pcts.map((pct, i) => row(`nep141:t${i}.near`, pctToBps(pct)));
      expectReason(() => assertValidComposition(composition), "targets-not-100");
    });

    it("accepts the two-decimal case, which converts exactly", () => {
      const composition = [33.33, 33.33, 33.34].map((pct, i) =>
        row(`nep141:t${i}.near`, pctToBps(pct))
      );
      expect(() => assertValidComposition(composition)).not.toThrow();
    });

    it("survives the float noise of a percentage that is not representable", () => {
      // 0.1 + 0.2 style drift: 70.1 * 100 = 7009.999999999999 in IEEE-754.
      expect(pctToBps(70.1)).toBe(7_010);
      expect(() => assertValidComposition([row(A, pctToBps(70.1)), row(B, pctToBps(29.9))])).not.toThrow();
    });
  });
});

describe("assertValidChangeSetShape", () => {
  it("accepts a pure withdrawal with no composition edits", () => {
    const cs = changeSet({ unallocations: [{ tokenId: A, amount: "1000" }] });
    expect(() => assertValidChangeSetShape(cs)).not.toThrow();
  });

  it("accepts an addition at exactly 0 bps", () => {
    expect(() =>
      assertValidChangeSetShape(changeSet({ tokenAdditions: [row(C, 0)] }))
    ).not.toThrow();
  });

  it("rejects a token named in two composition lists", () => {
    expectReason(
      () =>
        assertValidChangeSetShape(
          changeSet({ tokenAdditions: [row(C, 0)], tokenRemovals: [C] })
        ),
      "duplicate-token"
    );
  });

  it("allows removing a token and withdrawing its balance in the same commit", () => {
    // The intended coupling (§4.4.1) — unallocations are deliberately NOT checked against
    // the composition lists.
    expect(() =>
      assertValidChangeSetShape(
        changeSet({ tokenRemovals: [A], unallocations: [{ tokenId: A, amount: "500" }] })
      )
    ).not.toThrow();
  });

  it("rejects a zero-quantity withdrawal leg", () => {
    expectReason(
      () => assertValidChangeSetShape(changeSet({ unallocations: [{ tokenId: A, amount: "0" }] })),
      "zero-unallocation"
    );
  });

  it("rejects a non-integer amount string before it reaches the wire", () => {
    expectReason(
      () => assertValidChangeSetShape(changeSet({ unallocations: [{ tokenId: A, amount: "1.5" }] })),
      "zero-unallocation"
    );
  });

  it("rejects a duplicate withdrawal leg", () => {
    expectReason(
      () =>
        assertValidChangeSetShape(
          changeSet({
            unallocations: [
              { tokenId: A, amount: "1" },
              { tokenId: A, amount: "2" },
            ],
          })
        ),
      "duplicate-unallocation"
    );
  });

  it("rejects more than 64 composition changes", () => {
    const removals = Array.from({ length: 65 }, (_, i) => `nep141:t${i}.near`);
    expectReason(() => assertValidChangeSetShape(changeSet({ tokenRemovals: removals })), "too-many-changes");
  });

  it("rejects more than 32 withdrawal legs", () => {
    const legs = Array.from({ length: 33 }, (_, i) => ({
      tokenId: `nep141:t${i}.near`,
      amount: "1",
    }));
    expectReason(() => assertValidChangeSetShape(changeSet({ unallocations: legs })), "too-many-legs");
  });
});

// D-528: the app's own cap stops a composition from GROWING past 10; one above it still moves.
describe("resultingComposition — the app's 10-token cap (D-528)", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `nep141:t${i}.near`);
  const full = (n: number) => ids(n).map((id, i) => row(id, i === 0 ? 10_000 : 0));
  const extra = "nep141:extra.near";

  it("refuses an addition that takes 10 to 11, and passes 9 to 10", () => {
    expectReason(() => resultingComposition(full(10), changeSet({ tokenAdditions: [row(extra, 0)] })), "app-too-many-tokens");
    expect(resultingComposition(full(9), changeSet({ tokenAdditions: [row(extra, 0)] }))).toHaveLength(10);
  });

  it("lets a portfolio already above the cap retarget, shrink, and swap one for one", () => {
    const twelve = full(12);
    expect(resultingComposition(twelve, changeSet({ targetChanges: [row(ids(12)[1], 0, 800)] }))).toHaveLength(12);
    expect(resultingComposition(twelve, changeSet({ tokenRemovals: [ids(12)[11]] }))).toHaveLength(11);
    expect(
      resultingComposition(twelve, changeSet({ tokenRemovals: [ids(12)[11]], tokenAdditions: [row(extra, 0)] }))
    ).toHaveLength(12);
    expectReason(() => resultingComposition(twelve, changeSet({ tokenAdditions: [row(extra, 0)] })), "app-too-many-tokens");
  });
});

describe("resultingComposition", () => {
  const current = [row(A, 6_000), row(B, 4_000)];

  it("applies a retarget and keeps the sum at 10000", () => {
    const next = resultingComposition(
      current,
      changeSet({ targetChanges: [row(A, 7_000, 800), row(B, 3_000)] })
    );
    expect(next).toEqual([row(A, 7_000, 800), row(B, 3_000)]);
  });

  it("adds a token at 0% without disturbing the declared targets", () => {
    const next = resultingComposition(current, changeSet({ tokenAdditions: [row(C, 0, 1_000)] }));
    expect(next).toEqual([row(A, 6_000), row(B, 4_000), row(C, 0, 1_000)]);
  });

  it("removes a token and re-targets the survivor in one commit", () => {
    const next = resultingComposition(
      current,
      changeSet({ tokenRemovals: [B], targetChanges: [row(A, 10_000)] })
    );
    expect(next).toEqual([row(A, 10_000)]);
  });

  it("rejects a removal that leaves the targets short of 100%", () => {
    expectReason(() => resultingComposition(current, changeSet({ tokenRemovals: [B] })), "targets-not-100");
  });

  it("rejects a retarget of a token the chain does not hold in its composition", () => {
    expectReason(
      () => resultingComposition(current, changeSet({ targetChanges: [row(C, 5_000)] })),
      "retarget-absent-token"
    );
  });

  it("rejects a removal of a token that is not in the composition", () => {
    expectReason(
      () => resultingComposition(current, changeSet({ tokenRemovals: [C] })),
      "removal-absent-token"
    );
  });

  it("rejects adding a token the composition already has", () => {
    expectReason(
      () => resultingComposition(current, changeSet({ tokenAdditions: [row(A, 0)] })),
      "addition-present-token"
    );
  });

  it("does not mutate the caller's current composition", () => {
    const snapshot = structuredClone(current);
    resultingComposition(current, changeSet({ targetChanges: [row(A, 7_000), row(B, 3_000)] }));
    expect(current).toEqual(snapshot);
  });

  it("rejects a removal of the last token, which would empty the composition", () => {
    expectReason(
      () => resultingComposition([row(A, 10_000)], changeSet({ tokenRemovals: [A] })),
      "empty-composition"
    );
  });
});

// D-321: the caps an AllocateInto breaks inside `on_auth`, after the Transfer settled.
describe("assertAllocateIntoFits", () => {
  const tokens = (n: number) => Array.from({ length: n }, (_, i) => `nep141:t${i}.near`);
  const reasonOf = (fn: () => void): PreflightReason | null => {
    try {
      fn();
      return null;
    } catch (e) {
      return (e as ChangeSetPreflightError).reason;
    }
  };

  it("accepts a first credit while held_tokens has room", () => {
    expect(reasonOf(() => assertAllocateIntoFits(tokens(31), [A]))).toBeNull();
  });

  it("refuses a first credit that would push held_tokens past 32", () => {
    expect(reasonOf(() => assertAllocateIntoFits(tokens(32), [A]))).toBe("too-many-tokens");
    expect(reasonOf(() => assertAllocateIntoFits(tokens(31), [A, B]))).toBe("too-many-tokens");
  });

  it("counts only the tokens not already held", () => {
    const held = tokens(32);
    expect(reasonOf(() => assertAllocateIntoFits(held, [held[0], held[5]]))).toBeNull();
  });

  it("refuses more than 32 legs, as apply_allocate_into does before crediting any", () => {
    expect(reasonOf(() => assertAllocateIntoFits([], tokens(33)))).toBe("too-many-tokens");
    expect(reasonOf(() => assertAllocateIntoFits([], tokens(32)))).toBeNull();
  });

  it("does not count one token twice", () => {
    expect(reasonOf(() => assertAllocateIntoFits(tokens(31), [A, A]))).toBeNull();
  });
});

// ── 017-9a: the rules of the vault's `get_config().limits` ───────────────────
// `LIMITS` stands in for what `limitsFromConfig` (vault-limits.ts) builds from the contract's
// answer; the mirror is checked against that answer in vault-limits.test.ts.

const LIMITS: PreflightLimits = { ...MIRRORED_LIMITS };

describe("017-9a · addition with a target (FE #6)", () => {
  const current = [row(A, 10_000)];
  const withTarget = changeSet({
    targetChanges: [row(A, 6_000)],
    tokenAdditions: [row(B, 4_000, 300)],
  });

  it("folds it into a valid composition in one commit", () => {
    expect(resultingComposition(current, withTarget, LIMITS)).toEqual([row(A, 6_000), row(B, 4_000, 300)]);
  });

  it("still bounds the addition's target and still checks the total", () => {
    expectReason(
      () => assertValidChangeSetShape(changeSet({ tokenAdditions: [row(B, 10_001)] }), LIMITS),
      "target-above-max"
    );
    expectReason(
      () => resultingComposition(current, changeSet({ tokenAdditions: [row(B, 4_000)] }), LIMITS),
      "targets-not-100"
    );
  });

  it("keeps our tolerance floor on a 0% target, although the contract would take 0 (D-334)", () => {
    expectReason(
      () => assertValidChangeSetShape(changeSet({ tokenAdditions: [row(B, 0, 0)] }), LIMITS),
      "tolerance-out-of-band"
    );
  });
});

describe("017-9a · limits come from the caller, not the constants", () => {
  it("a vault with a higher tolerance floor is honoured", () => {
    const strict = { ...LIMITS, toleranceMinBps: 300 };
    expect(() => assertValidComposition([row(A, 10_000, 250)], LIMITS)).not.toThrow();
    expectReason(() => assertValidComposition([row(A, 10_000, 250)], strict), "tolerance-out-of-band");
  });

  it("the token cap of AllocateInto follows the limits", () => {
    const small = { ...LIMITS, maxTokensPerPortfolio: 2 };
    expectReason(() => assertAllocateIntoFits([A, B], [C], small), "too-many-tokens");
    expect(() => assertAllocateIntoFits([A, B], [C], LIMITS)).not.toThrow();
  });
});

describe("017-9a · assertSetupFits (what apply_setup checks besides the composition)", () => {
  const setup = (over: Partial<{ portfolioCount: number; portfolioName: string; loginWalletAddress: string }> = {}) => ({
    portfolioCount: 0,
    portfolioName: "Long term",
    loginWalletAddress: "alice.near",
    ...over,
  });

  it("under the vault's 16, the app's cap holds: the 7th passes, the 8th is refused (D-361, D-476)", () => {
    expect(LIMITS.maxPortfoliosPerAccount).toBe(16);
    expect(() => assertSetupFits(setup({ portfolioCount: 6 }), LIMITS)).not.toThrow();
    expectReason(() => assertSetupFits(setup({ portfolioCount: 7 }), LIMITS), "too-many-portfolios");
  });

  it("a vault cap below the app's wins (D-476)", () => {
    const tight = { ...LIMITS, maxPortfoliosPerAccount: 3 };
    expect(appPortfolioCap(tight)).toBe(3);
    expect(() => assertSetupFits(setup({ portfolioCount: 2 }), tight)).not.toThrow();
    expectReason(() => assertSetupFits(setup({ portfolioCount: 3 }), tight), "too-many-portfolios");
  });

  it("appPortfolioCap is min(app, vault)", () => {
    expect(appPortfolioCap()).toBe(APP_MAX_PORTFOLIOS_PER_ACCOUNT);
    expect(appPortfolioCap({ ...LIMITS, maxPortfoliosPerAccount: 7 })).toBe(7);
  });

  it("measures the name in UTF-8 bytes, not UTF-16 units (D-302 e)", () => {
    // 32 four-byte emoji = 64 UTF-16 units but 128 bytes: exactly at the cap.
    const atCap = "🙂".repeat(32);
    expect(() => assertSetupFits(setup({ portfolioName: atCap }), LIMITS)).not.toThrow();
    // One more byte ("a") and it is over, although `.length` (65) is far below 128.
    expectReason(() => assertSetupFits(setup({ portfolioName: `${atCap}a` }), LIMITS), "name-too-long");
  });

  it("caps the login wallet address in bytes", () => {
    expect(() => assertSetupFits(setup({ loginWalletAddress: "a".repeat(128) }), LIMITS)).not.toThrow();
    expectReason(
      () => assertSetupFits(setup({ loginWalletAddress: "a".repeat(129) }), LIMITS),
      "address-too-long"
    );
  });
});

describe("017-9a · assertAllocationLegIds (D-302 k)", () => {
  it("passes the registry's ids and refuses one past the byte cap", () => {
    expect(() => assertAllocationLegIds([A, "nep141:wrap.near"], LIMITS)).not.toThrow();
    expectReason(() => assertAllocationLegIds([`nep141:${"x".repeat(121)}.near`], LIMITS), "token-id-too-long");
  });
});

describe("017-9a · assertSetupLegCount (cross-review)", () => {
  it("32 legs pass, 33 are refused", () => {
    expect(() => assertSetupLegCount(32, LIMITS)).not.toThrow();
    expectReason(() => assertSetupLegCount(33, LIMITS), "too-many-tokens");
  });
});
