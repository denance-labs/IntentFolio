import { describe, expect, it } from "vitest";
import { portfolioColor } from "./portfolio-color";

// 021 R5: a portfolio's color comes from its id alone, so it is the same everywhere.
describe("portfolioColor", () => {
  it("is stable for the same id", () => {
    expect(portfolioColor("p_00000000002a")).toEqual(portfolioColor("p_00000000002a"));
    expect(portfolioColor("mock-1700000000000")).toEqual(portfolioColor("mock-1700000000000"));
  });

  it("gives vault ids issued one after another different colors", () => {
    const ids = Array.from({ length: 8 }, (_, i) => `p_${(40 + i).toString(16).padStart(12, "0")}`);
    expect(new Set(ids.map((id) => portfolioColor(id).text)).size).toBe(8);
  });

  it("pairs each name color with a dot of the same hue", () => {
    for (const id of ["p_000000000000", "p_000000000007", "mock-1", "anything"]) {
      const { text, dot } = portfolioColor(id);
      expect(dot).toBe(text.replace(/^text-/, "bg-"));
    }
  });
});
