import { describe, expect, it } from "vitest";
import { logoOpacity, sliceLogos } from "./slice-logos";

const RING = { center: 120, ringRadius: 91 };
const row = (id: string, now: number) => ({ id, symbol: id, now });

describe("hero donut slice logos (D-575)", () => {
  it("fades a logo in between 7% and 10%, none below", () => {
    expect(logoOpacity(5)).toBe(0);
    expect(logoOpacity(7)).toBe(0);
    expect(logoOpacity(8.5)).toBeCloseTo(0.5);
    expect(logoOpacity(10)).toBe(1);
    expect(logoOpacity(70)).toBe(1);
  });

  it("puts a lone asset's logo at the bottom of the ring", () => {
    const [logo] = sliceLogos([row("USDC", 100)], RING);
    expect(logo.left).toBeCloseTo(50);
    expect(logo.top).toBeCloseTo(((120 + 91) / 240) * 100);
  });

  it("places each logo at its slice's middle, clockwise from 12 o'clock", () => {
    const logos = sliceLogos([row("A", 50), row("B", 25), row("C", 25)], RING);
    // A spans 0–180°: its middle is 3 o'clock. B spans 180–270°: middle at 225°.
    expect(logos[0].left).toBeCloseTo(((120 + 91) / 240) * 100);
    expect(logos[0].top).toBeCloseTo(50);
    expect(logos[1].left).toBeLessThan(50);
    expect(logos[1].top).toBeGreaterThan(50);
  });

  it("skips the slices with no room, without moving the others", () => {
    const logos = sliceLogos([row("BTC", 35), row("ETH", 30), row("SOL", 25), row("NEAR", 5), row("USDC", 5)], RING);
    expect(logos.map((l) => l.id)).toEqual(["BTC", "ETH", "SOL"]);
  });

  it("draws nothing for an empty mix", () => {
    expect(sliceLogos([row("A", 0)], RING)).toEqual([]);
  });
});
