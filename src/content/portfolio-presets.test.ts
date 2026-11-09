import { describe, expect, it } from "vitest";
import { isPortfolioOfferable } from "@/features/bridge/lib/token-availability";
import { getTokenById } from "@/features/market/lib/token-registry";
import {
  TOLERANCE_MAX_PCT,
  TOLERANCE_MIN_PCT,
  evaluatePortfolioRules,
  firstError,
} from "@/features/intents-account/mock-contract/rules";
import { isStockToken } from "@/features/market/lib/stock-tokens";
import { getPreset, portfolioPresets, type PresetId, parsePresetId } from "./portfolio-presets";

// Locked percentages + bands (D-031). The token assignment is product content and may
// change; these assertions guard the locked numbers and structural validity only.
const LOCKED: Record<PresetId, { band: number; pcts: number[] }> = {
  conservative: { band: 5,  pcts: [30, 25, 15, 20, 10] },
  balanced:     { band: 8,  pcts: [30, 20, 20, 15, 15] },
  aggressive:   { band: 12, pcts: [35, 30, 25, 5, 5] },
  stables:      { band: 5,  pcts: [20, 20, 20, 20, 20] },
  satoshi:      { band: 10, pcts: [70, 20, 10] },
  pioneers:     { band: 10, pcts: [60, 40] },
  techTitans:   { band: 10, pcts: [30, 25, 25, 20] },
  nearStocks:   { band: 10, pcts: [40, 20, 20, 20] },
};

describe("portfolio presets", () => {
  it("exposes all presets", () => {
    expect(portfolioPresets.map((p) => p.id).sort()).toEqual(
      ["aggressive", "balanced", "conservative", "nearStocks", "pioneers", "satoshi", "stables", "techTitans"]
    );
  });

  for (const preset of portfolioPresets) {
    describe(preset.id, () => {
      const locked = LOCKED[preset.id];

      it("matches the locked band and percentages (D-031)", () => {
        expect(preset.tolerancePct).toBe(locked.band);
        expect([...preset.slots.map((s) => s.targetPct)].sort((a, b) => a - b)).toEqual(
          [...locked.pcts].sort((a, b) => a - b)
        );
      });

      it("sums to 100%", () => {
        expect(preset.slots.reduce((sum, s) => sum + s.targetPct, 0)).toBe(100);
      });

      it("uses bands inside the hard tolerance range (D-008)", () => {
        expect(preset.tolerancePct).toBeGreaterThanOrEqual(TOLERANCE_MIN_PCT);
        expect(preset.tolerancePct).toBeLessThanOrEqual(TOLERANCE_MAX_PCT);
      });

      it("references tokens that resolve in the registry", () => {
        for (const slot of preset.slots) {
          expect(getTokenById(slot.tokenId), slot.tokenId).not.toBeNull();
        }
      });

      // A preset offers only what the editor would let the user pick (D-396, D-389).
      it("uses only tokens a portfolio may hold", () => {
        for (const slot of preset.slots) {
          expect(isPortfolioOfferable(slot.tokenId), slot.tokenId).toBe(true);
        }
      });

      it("has no duplicate token slots", () => {
        const ids = preset.slots.map((s) => s.tokenId);
        expect(new Set(ids).size).toBe(ids.length);
      });

      it("passes the contract validation gate once one slot is funded", () => {
        const composition = preset.slots.map((s) => ({
          tokenId: s.tokenId,
          targetPct: s.targetPct,
          tolerancePct: preset.tolerancePct,
        }));
        // Fund a single slot (the realistic first-time case: one deposited token).
        const balances = { [preset.slots[0].tokenId]: 100 };
        expect(firstError(evaluatePortfolioRules(composition, balances))).toBeNull();
      });
    });
  }

  // D-390: ETH is the one that reaches a NEAR wallet, not the omft one.
  it("uses eth.bridge.near for ETH, never eth.omft.near", () => {
    const ids = portfolioPresets.flatMap((p) => p.slots.map((s) => s.tokenId));
    expect(ids).toContain("nep141:eth.bridge.near");
    expect(ids).not.toContain("nep141:eth.omft.near");
  });

  // D-558: /learn and the landing derive token colors from the array's order, and the chooser
  // lifts these presets to the top by itself, so they stay last here.
  it("keeps the presets holding a stock last, and only uses stocks with a route at every size", () => {
    const withStock = portfolioPresets.filter((p) => p.slots.some((s) => isStockToken(s.tokenId)));
    expect(withStock.map((p) => p.id)).toEqual(["techTitans", "nearStocks"]);
    expect(portfolioPresets.slice(-2)).toEqual(withStock);
    const symbols = withStock.flatMap((p) => p.slots.map((s) => getTokenById(s.tokenId)?.symbol));
    expect(symbols).not.toContain("TSLA");
    expect(symbols).not.toContain("GOOGL");
  });

  // Who funds with a token outside the mix is the common case for these two (D-319).
  it.each(["techTitans", "nearStocks"] as const)("%s passes the gate funded with a token outside its mix", (id) => {
    const preset = getPreset(id)!;
    const composition = preset.slots.map((s) => ({
      tokenId: s.tokenId,
      targetPct: s.targetPct,
      tolerancePct: preset.tolerancePct,
    }));
    const balances = { "nep141:usdt.tether-token.near": 100 };
    expect(firstError(evaluatePortfolioRules(composition, balances))).toBeNull();
  });

  it("getPreset resolves by id and returns undefined otherwise", () => {
    expect(getPreset("balanced")?.id).toBe("balanced");
    expect(getPreset("nope" as PresetId)).toBeUndefined();
  });
});

describe("parsePresetId (D-561)", () => {
  it("accepts only the ids of these templates", () => {
    expect(parsePresetId("balanced")).toBe("balanced");
    expect(parsePresetId("nope")).toBeNull();
    expect(parsePresetId("bigTech")).toBe("techTitans");
    expect(parsePresetId("toString")).toBeNull();
    expect(parsePresetId("")).toBeNull();
    expect(parsePresetId(null)).toBeNull();
  });
});
