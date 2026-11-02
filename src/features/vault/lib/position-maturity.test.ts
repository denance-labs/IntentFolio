import { describe, it, expect } from "vitest";
import { maturityFromPositions } from "./position-maturity";
import type { PortfolioPosition } from "./vault-read-client";

const pos = (tokenId: string, maturesAtSecs: number): PortfolioPosition => ({
  tokenId,
  qtyHeld: BigInt(10),
  lockedQty: BigInt(0),
  available: BigInt(10),
  maturesAtSecs,
});

describe("maturityFromPositions", () => {
  const NOW = 1_000;

  it("the latest deadline among the watched tokens gates the withdrawal", () => {
    const status = maturityFromPositions([pos("near", 1_100), pos("usdc", 1_300), pos("eth", 5_000)], ["near", "usdc"], NOW);
    expect(status).toEqual({ matured: false, remainingSecs: 300, known: true });
  });

  it("a past deadline is matured", () => {
    expect(maturityFromPositions([pos("near", 900)], ["near"], NOW)).toEqual({ matured: true, remainingSecs: 0, known: true });
  });

  it("no clock (0) and no position both stay out of the way", () => {
    expect(maturityFromPositions([pos("near", 0)], ["near", "usdc"], NOW)).toEqual({
      matured: true,
      remainingSecs: 0,
      known: false,
    });
  });
});
