import { describe, it, expect } from "vitest";
import {
  depositGroupKeyFor,
  depositGroups,
  depositTokenIdFor,
  orderDepositGroups,
  type DepositGroup,
} from "./deposit-registry";
import { chainRegistry } from "./chain-registry";
import { withdrawalRegistry } from "./withdrawal-registry";
import { isStockToken } from "@/features/market/lib/stock-tokens";
import { depositableTokens as allDepositableTokens } from "@/features/market/lib/token-registry";

// A stock is a portfolio target, never a deposit (plan 039).
const depositableTokens = allDepositableTokens.filter((t) => !isStockToken(t.id));

function group(assetName: string) {
  const g = depositGroups.find((x) => x.assetName === assetName);
  if (!g) throw new Error(`no deposit group named ${assetName}`);
  return g;
}

describe("depositGroups", () => {
  it("groups every depositable token exactly once", () => {
    const keys = new Set(depositableTokens.map((t) => t.assetName ?? t.symbol));
    expect(depositGroups).toHaveLength(keys.size);
    expect(new Set(depositGroups.map((g) => g.assetName))).toEqual(keys);
  });

  it("preserves registry order, so the picker order is the curated order", () => {
    const firstAppearance: string[] = [];
    for (const t of depositableTokens) {
      const key = t.assetName ?? t.symbol;
      if (!firstAppearance.includes(key)) firstAppearance.push(key);
    }
    expect(depositGroups.map((g) => g.assetName)).toEqual(firstAppearance);
  });

  // The whole point of ADR-0016: a chain reaches the picker only if we curated a token
  // for that (asset, chain) pair, which is what makes the balance readable afterwards.
  it("only offers chains backed by a curated token with a withdrawal route", () => {
    for (const g of depositGroups) {
      for (const chainId of g.chainIds) {
        expect(chainRegistry[chainId], `${g.assetName} → ${chainId} has no chain metadata`).toBeDefined();
        const backing = depositableTokens.filter(
          (t) => (t.assetName ?? t.symbol) === g.assetName && withdrawalRegistry[t.id]?.chainId === chainId
        );
        expect(backing.length, `${g.assetName} → ${chainId} has no curated token`).toBeGreaterThan(0);
      }
    }
  });

  it("offers every curated (asset, chain) pair — nothing is silently dropped", () => {
    for (const token of depositableTokens) {
      const chainId = withdrawalRegistry[token.id]?.chainId;
      if (!chainId || !chainRegistry[chainId]) continue;
      expect(group(token.assetName ?? token.symbol).chainIds).toContain(chainId);
    }
  });

  it("never repeats a chain within a group", () => {
    for (const g of depositGroups) {
      expect(new Set(g.chainIds).size).toBe(g.chainIds.length);
    }
  });

  // Regression guard for D-178: these pairs are listed by the live PoA catalog but have
  // no curated token, and used to be offered — the deposit landed and the balance was
  // never read. They must stay out until someone curates the token.
  it("excludes the live-catalog pairs we cannot read (D-178)", () => {
    expect(group("ETH").chainIds).not.toContain("eth:8453"); // ETH on Base
    expect(group("ETH").chainIds).not.toContain("eth:10"); // ETH on Optimism
    expect(group("USDC").chainIds).not.toContain("eth:100"); // USDC on Gnosis
    expect(group("USDT").chainIds).not.toContain("eth:100"); // USDT on Gnosis
  });

  // USDC on Stellar was in the list above until 4.4, which is the curation the guard was
  // waiting for (D-184). It flips from excluded to offered — the guard is satisfied, not
  // weakened: the token is now curated, so the deposit can be read and given back.
  it("offers Stellar now that both of its assets are curated (D-184, 4.4)", () => {
    expect(group("USDC").chainIds).toContain("stellar:mainnet");
    expect(group("XLM").chainIds).toEqual(["stellar:mainnet"]);
  });

  // D-176: NEAR used to be the one group with no chain at all, and the modal answered that
  // by showing the user their own NEAR account — an address intents.near never watches.
  // It is an ordinary single-chain group now, which is what makes the address come from the
  // bridge like everyone else's.
  it("gives NEAR native its own deposit chain instead of a direct transfer", () => {
    const near = group("NEAR");
    expect(near.chainIds).toEqual(["near:mainnet"]);
    expect(near.availableChainIds).toEqual(["near:mainnet"]);
  });

  it("leaves no group without a deposit chain", () => {
    expect(depositGroups.filter((g) => g.chainIds.length === 0)).toEqual([]);
  });

  it("strips the chain suffix from the ticker", () => {
    // Registry symbols are "USDC(ARB)", "USDT(NEAR)"… the picker shows the bare asset.
    expect(group("USDC").ticker).toBe("USDC");
    for (const g of depositGroups) expect(g.ticker).not.toContain("(");
  });

  // D-182 rests on this shape: if it changes, revisit whether skipping step 2 still
  // pays for itself.
  it("leaves only USDC, USDT, ETH, BTC and SWEAT with a real network choice", () => {
    const multi = depositGroups.filter((g) => g.chainIds.length > 1).map((g) => g.assetName);
    expect(multi.sort()).toEqual(["BTC", "ETH", "SWEAT", "USDC", "USDT"]);
  });
});

describe("depositTokenIdFor", () => {
  it("maps the NEAR pairs the wallet deposit serves back to their token ids", () => {
    expect(depositTokenIdFor("NEAR", "near:mainnet")).toBe("near");
    expect(depositTokenIdFor("USDC", "near:mainnet")).toBe(
      "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"
    );
    expect(depositTokenIdFor("USDC", "eth:42161")).toBe("nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near");
  });

  it("is null for a pair the registry does not curate", () => {
    expect(depositTokenIdFor("USDC", "gnosis:100")).toBeNull();
    expect(depositTokenIdFor("NOPE", "near:mainnet")).toBeNull();
  });

  it("every (group, chain) the picker offers maps to exactly one token", () => {
    for (const g of depositGroups) {
      for (const chainId of g.chainIds) {
        const matches = depositableTokens.filter(
          (t) => (t.assetName ?? t.symbol) === g.assetName && withdrawalRegistry[t.id]?.chainId === chainId
        );
        expect(matches, `${g.assetName} · ${chainId}`).toHaveLength(1);
        expect(depositTokenIdFor(g.assetName, chainId)).toBe(matches[0].id);
      }
    }
  });
});

describe("depositGroupKeyFor", () => {
  it("names the picker group of a curated token, by asset", () => {
    expect(depositGroupKeyFor("near")).toBe("NEAR");
    // Two USDC tokens on different chains share one group.
    expect(depositGroupKeyFor("nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1")).toBe("USDC");
    expect(depositGroupKeyFor("nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near")).toBe("USDC");
  });

  it("is null for a token the registry does not curate", () => {
    expect(depositGroupKeyFor("nep141:not-a-token.near")).toBeNull();
  });

  it("agrees with the groups for every depositable token", () => {
    const keys = new Set(depositGroups.map((g) => g.assetName));
    for (const t of depositableTokens) expect(keys.has(depositGroupKeyFor(t.id)!)).toBe(true);
  });
});

// 016 block 2.3: a deposit made for a New Portfolio Draft lists the draft's assets first.
describe("orderDepositGroups", () => {
  const g = (assetName: string, live = true): DepositGroup => ({
    assetName,
    ticker: assetName,
    chainIds: ["c"],
    availableChainIds: live ? ["c"] : [],
  });
  const GROUPS = [g("A"), g("B", false), g("C"), g("D"), g("E")];
  const names = (list: DepositGroup[]) => list.map((x) => x.assetName);

  it("without a draft: selectable first, then deferred, the last used leading", () => {
    expect(names(orderDepositGroups(GROUPS, { lastUsed: null }))).toEqual(["A", "C", "D", "E", "B"]);
    expect(names(orderDepositGroups(GROUPS, { lastUsed: "D" }))).toEqual(["D", "A", "C", "E", "B"]);
  });

  it("does not lead with a last used group that is no longer selectable", () => {
    expect(names(orderDepositGroups(GROUPS, { lastUsed: "B" }))).toEqual(["A", "C", "D", "E", "B"]);
  });

  it("puts the draft's groups first, in the draft's order", () => {
    expect(names(orderDepositGroups(GROUPS, { lastUsed: null, preferred: ["E", "C"] }))).toEqual([
      "E", "C", "A", "D", "B",
    ]);
  });

  it("keeps a deferred draft group last within the draft's part", () => {
    expect(names(orderDepositGroups(GROUPS, { lastUsed: null, preferred: ["B", "D"] }))).toEqual([
      "D", "B", "A", "C", "E",
    ]);
  });

  it("the last used leads the draft's part when it is in the draft", () => {
    expect(names(orderDepositGroups(GROUPS, { lastUsed: "C", preferred: ["E", "C"] }))).toEqual([
      "C", "E", "A", "D", "B",
    ]);
  });

  it("the last used outside the draft leads the rest, never above the draft's groups", () => {
    expect(names(orderDepositGroups(GROUPS, { lastUsed: "D", preferred: ["E", "C"] }))).toEqual([
      "E", "C", "D", "A", "B",
    ]);
  });

  it("a repeated key keeps its first place, an unknown one is ignored (two USDC tokens are one group)", () => {
    expect(names(orderDepositGroups(GROUPS, { lastUsed: null, preferred: ["C", "Z", "A", "C"] }))).toEqual([
      "C", "A", "D", "E", "B",
    ]);
  });

  it("drops and duplicates nothing", () => {
    const out = orderDepositGroups(depositGroups, { lastUsed: "USDC", preferred: ["NEAR", "USDC", "BTC"] });
    expect(out).toHaveLength(depositGroups.length);
    expect(new Set(names(out))).toEqual(new Set(names(depositGroups)));
  });
});
