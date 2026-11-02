import { describe, expect, it } from "vitest";
import { formatAxisUsd, niceYAxis } from "./chart-axis";

describe("formatAxisUsd", () => {
  it("tells apart gridlines a few cents apart (s224: a $4.88 portfolio read '$5' on every line)", () => {
    const step = 0.04;
    const labels = [4.8, 4.84, 4.88, 4.92].map((v) => formatAxisUsd(v, step));
    expect(labels).toEqual(["$4.80", "$4.84", "$4.88", "$4.92"]);
    expect(new Set(labels).size).toBe(4);
  });

  it("drops the decimals when the lines are dollars apart", () => {
    expect(formatAxisUsd(250, 50)).toBe("$250");
  });

  it("keeps the k form for thousands, with a decimal only when the step needs it", () => {
    expect(formatAxisUsd(12_500, 500)).toBe("$12.5k");
    expect(formatAxisUsd(12_000, 2_000)).toBe("$12k");
  });

  it("does not collapse thousands that sit a few dollars apart into one 'k' label", () => {
    expect(formatAxisUsd(10_204, 3)).toBe("$10,204");
    expect(formatAxisUsd(10_207, 3)).toBe("$10,207");
  });

  it("never shows more than 4 decimals, and survives a zero step", () => {
    expect(formatAxisUsd(0.123456, 0.000001)).toBe("$0.1235");
    expect(formatAxisUsd(5, 0)).toBe("$5.00");
  });
});

describe("niceYAxis", () => {
  it("puts the gridlines of a ~$4.85 portfolio on whole cents, evenly spaced", () => {
    const axis = niceYAxis(4.8329, 4.8781);
    expect(axis.step).toBe(0.02);
    expect(axis.ticks).toEqual([4.82, 4.84, 4.86, 4.88]);
    const labels = axis.ticks.map((v) => formatAxisUsd(v, axis.step));
    expect(labels).toEqual(["$4.82", "$4.84", "$4.86", "$4.88"]);
  });

  it("covers the range it was given", () => {
    const axis = niceYAxis(123.4, 987.6);
    expect(axis.min).toBeLessThanOrEqual(123.4);
    expect(axis.max).toBeGreaterThanOrEqual(987.6);
    expect(axis.ticks[0]).toBe(axis.min);
    expect(axis.ticks[axis.ticks.length - 1]).toBe(axis.max);
  });

  it("starts at zero when asked to, and never dips below it", () => {
    const axis = niceYAxis(0, 0.037);
    expect(axis.min).toBe(0);
    expect(axis.ticks.every((v) => v >= 0)).toBe(true);
  });

  it("labels a $0.19 cumulative spread with distinct ticks, not '$0' on every line (D-341)", () => {
    // The spread chart's own range: from zero to the total earned plus 10%.
    const axis = niceYAxis(0, 0.19 * 1.1);
    const labels = axis.ticks.map((v) => formatAxisUsd(v, axis.step));
    expect(labels).toEqual(["$0.0", "$0.1", "$0.2", "$0.3"]);
  });

  it("survives a flat series", () => {
    const axis = niceYAxis(5, 5);
    expect(axis.max).toBeGreaterThan(axis.min);
  });
});
