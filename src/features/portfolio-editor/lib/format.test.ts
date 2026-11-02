import { describe, expect, it } from "vitest";
import { formatTokenAmount, formatCrypto } from "./format";

describe("formatTokenAmount", () => {
  it("uses 5 decimals for high-price tokens (>= $1000)", () => {
    expect(formatTokenAmount(0.00647, 80328)).toBe("0.00647");
  });

  it("uses up to 4 decimals for mid-price tokens ($100–$999), trailing zeros trimmed", () => {
    expect(formatTokenAmount(1.5, 500)).toBe("1.5");
  });

  it("uses up to 3 decimals for low-price tokens ($1–$99)", () => {
    expect(formatTokenAmount(140.625, 1.28)).toBe("140.625");
  });

  it("trims trailing zeros for sub-dollar tokens (< $1)", () => {
    expect(formatTokenAmount(4200, 0.5)).toBe("4,200");
  });

  it("trims trailing zeros for stablecoins at $1 price", () => {
    expect(formatTokenAmount(4200, 1)).toBe("4,200");
  });

  it("returns plain 0 when value is 0", () => {
    expect(formatTokenAmount(0, 80000)).toBe("0");
  });

  it("returns dust prefix for positive value that rounds to zero — high-price token (5 decimals)", () => {
    expect(formatTokenAmount(0.000001, 80000)).toBe("<0.00001");
  });

  it("returns dust prefix for positive value that rounds to zero — sub-dollar token (2 decimals)", () => {
    expect(formatTokenAmount(0.001, 0.5)).toBe("<0.01");
  });

  it("returns dust prefix for positive value that rounds to zero — low-price token (3 decimals)", () => {
    expect(formatTokenAmount(0.0001, 4)).toBe("<0.001");
  });
});

describe("formatCrypto", () => {
  it("uses 2 decimals for large values (>= 1000)", () => {
    expect(formatCrypto(1500)).toBe("1,500.00");
  });

  it("uses 3 decimals for medium values (100–999)", () => {
    expect(formatCrypto(140.625)).toBe("140.625");
  });

  it("uses up to 6 decimals for small values (< 100), no trailing zeros", () => {
    // maximumFractionDigits: 6 — trailing zeros are trimmed by Intl.NumberFormat
    expect(formatCrypto(0.00647)).toBe("0.00647");
    expect(formatCrypto(0.123456)).toBe("0.123456");
  });
});
