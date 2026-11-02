import { describe, it, expect } from "vitest";
import { computeAvailableGeneralBalance, fundableTokenIds, MIN_FUNDED_USD } from "./general-balance";

describe("computeAvailableGeneralBalance", () => {
  it("falls back to a copy of the mock general balance while on-chain is loading", () => {
    const mock = new Map([["near", 5]]);
    const result = computeAvailableGeneralBalance(null, new Map(), mock);
    expect(result).toEqual(new Map([["near", 5]]));
    expect(result).not.toBe(mock); // defensive copy — callers must not mutate the source
  });

  it("subtracts committed portfolio allocations from the on-chain total", () => {
    const onChain = new Map([["btc", 1], ["eth", 2]]);
    const allocated = new Map([["btc", 0.3]]);
    expect(computeAvailableGeneralBalance(onChain, allocated, new Map())).toEqual(
      new Map([["btc", 0.7], ["eth", 2]])
    );
  });

  it("drops tokens that are fully allocated (zero or negative available)", () => {
    const onChain = new Map([["btc", 1], ["eth", 2]]);
    const allocated = new Map([["btc", 1], ["eth", 3]]);
    expect(computeAvailableGeneralBalance(onChain, allocated, new Map())).toEqual(new Map());
  });
});

// 016 block 2: "is there money to create a portfolio" — decides the whole creation path.
describe("fundableTokenIds", () => {
  // D-491: SWEAT could never be converted into the targets, so it never funds a new portfolio.
  it("leaves out the tokens with no sell route, whatever they are worth", () => {
    const available = new Map([
      ["nep141:token.sweat", 1_000],
      ["nep141:arb-0xca7dec8550f43a5e46e3dfb95801f64280e75b27.omft.near", 1_000],
      ["nep141:btc.omft.near", 1],
    ]);
    expect(fundableTokenIds(available, () => 1)).toEqual(["nep141:btc.omft.near"]);
  });

  const price = (table: Record<string, number>) => (id: string) => table[id] ?? 0;

  it("is one cent (027 A-2; D-007's $1 is gone)", () => {
    expect(MIN_FUNDED_USD).toBe(0.01);
  });

  it("compares in rounded cents: $0.004 is not enough, $0.005 and $0.01 are", () => {
    const at = (qty: number) => fundableTokenIds(new Map([["usdc", qty]]), price({ usdc: 1 }));
    expect(at(0.004)).toEqual([]);
    expect(at(0.005)).toEqual(["usdc"]);
    expect(at(0.01)).toEqual(["usdc"]);
  });

  it("counts what the $1 floor used to leave out", () => {
    expect(fundableTokenIds(new Map([["usdc", 0.45]]), price({ usdc: 1 }))).toEqual(["usdc"]);
  });

  it("never counts a token without a price", () => {
    expect(fundableTokenIds(new Map([["mystery", 1_000_000]]), price({}))).toEqual([]);
  });

  it("ignores zero and negative quantities", () => {
    expect(fundableTokenIds(new Map([["a", 0], ["b", -5]]), price({ a: 10, b: 10 }))).toEqual([]);
  });

  it("lists the fundable tokens most valuable first, dust left out", () => {
    const available = new Map([
      ["mpdao", 0.5], // ≈ $0.0047 → shows as $0.00: a remainder, not funds
      ["near", 2], // $6
      ["btc", 0.001], // $60
    ]);
    expect(fundableTokenIds(available, price({ mpdao: 0.0093, near: 3, btc: 60_000 }))).toEqual([
      "btc",
      "near",
    ]);
  });
});
