import { describe, expect, it } from "vitest";
import { portfolioPresets } from "@/content/portfolio-presets";
import { mixLabels } from "./mix-labels";

const slotsOf = (id: string) => portfolioPresets.find((p) => p.id === id)!.slots.map((s) => s.tokenId);

// D-429: a preset's donut named Stablecoins' five slices "USDC, USDT, USDC, USDT, USDC".
describe("mixLabels", () => {
  it("keeps the clean ticker when it is the only one of its kind in the mix", () => {
    expect([...mixLabels(slotsOf("satoshi")).values()]).toEqual(["BTC", "ETH", "NEAR"]);
  });

  it("names the network when the same ticker appears more than once", () => {
    const labels = [...mixLabels(slotsOf("stables")).values()];
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toEqual(["USDC(NEAR)", "USDT(ETH)", "USDC(ETH)", "USDT(SOL)", "USDC(BASE)"]);
  });

  it("does not change a mix with one USDC among other tokens", () => {
    expect(mixLabels(slotsOf("aggressive")).get(slotsOf("aggressive").at(-1)!)).toBe("USDC");
  });
});
