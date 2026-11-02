import { describe, it, expect } from "vitest";
import {
  formatDecimalForInput,
  parseDecimalInput,
  percentChipAmount,
  sanitizeDecimalInput,
} from "./decimal-input";

describe("sanitizeDecimalInput", () => {
  // THE bug: under a comma-decimal locale, `<input type="number">` reported "" for a typed
  // point, the state fell to 0 and the controlled input erased the amount mid-entry —
  // in a withdrawal dialog (008.plan Phase 2, reported from a mainnet session).
  it("accepts a POINT as the decimal separator", () => {
    expect(sanitizeDecimalInput("1.75")).toBe("1.75");
  });

  it("accepts a COMMA and normalises it", () => {
    expect(sanitizeDecimalInput("1,75")).toBe("1.75");
  });

  it("keeps a trailing separator so a number can still be typed", () => {
    // "1." is what exists between "1" and "1.75". Rewriting it strands the user.
    expect(sanitizeDecimalInput("1.")).toBe("1.");
    expect(sanitizeDecimalInput("1,")).toBe("1.");
  });

  it("keeps a leading separator", () => {
    expect(sanitizeDecimalInput(".5")).toBe(".5");
  });

  it("strips leading zeros", () => {
    expect(sanitizeDecimalInput("01,75")).toBe("1.75");
    expect(sanitizeDecimalInput("007")).toBe("7");
  });

  it("keeps the meaningful zero", () => {
    expect(sanitizeDecimalInput("0")).toBe("0");
    expect(sanitizeDecimalInput("0.5")).toBe("0.5");
    expect(sanitizeDecimalInput("0,00013")).toBe("0.00013");
  });

  it("keeps only the first separator", () => {
    expect(sanitizeDecimalInput("1.7.5")).toBe("1.75");
    expect(sanitizeDecimalInput("1,7,5")).toBe("1.75");
  });

  it("drops anything that is not a digit or a separator", () => {
    expect(sanitizeDecimalInput("1 234abc.5")).toBe("1234.5");
    expect(sanitizeDecimalInput("-5")).toBe("5"); // no negative withdrawal
    expect(sanitizeDecimalInput("1e9")).toBe("19"); // exponent is not input grammar
  });

  it("allows an empty field", () => {
    expect(sanitizeDecimalInput("")).toBe("");
  });
});

describe("parseDecimalInput", () => {
  it("parses a complete number", () => {
    expect(parseDecimalInput("1.75", 3.5)).toBe(1.75);
  });

  it("treats an incomplete entry as 0 without producing NaN", () => {
    expect(parseDecimalInput("", 10)).toBe(0);
    expect(parseDecimalInput(".", 10)).toBe(0);
  });

  it("reads a trailing separator as the number so far", () => {
    expect(parseDecimalInput("1.", 10)).toBe(1);
  });

  it("clamps to the available balance", () => {
    expect(parseDecimalInput("99", 3.5)).toBe(3.5);
  });

  it("never returns a negative", () => {
    expect(parseDecimalInput("0", 3.5)).toBe(0);
  });
});

describe("formatDecimalForInput", () => {
  // String(1e-9) is "1e-9"; the sanitizer would strip the "e-" and leave "19" — a dust
  // balance rendered as nineteen tokens. 18-decimal tokens make this ordinary.
  it("never emits exponential notation", () => {
    expect(formatDecimalForInput(1e-9)).toBe("0.000000001");
    expect(formatDecimalForInput(0.0000001)).toBe("0.0000001");
  });

  it("round-trips through the sanitizer unchanged", () => {
    for (const value of [1e-9, 0.00013, 1.75, 3.5, 1234]) {
      expect(sanitizeDecimalInput(formatDecimalForInput(value))).toBe(
        formatDecimalForInput(value)
      );
    }
  });

  it("keeps integers plain", () => {
    expect(formatDecimalForInput(3)).toBe("3");
    expect(formatDecimalForInput(0)).toBe("0");
  });

  it("does not leave trailing zeros", () => {
    expect(formatDecimalForInput(3.5)).toBe("3.5");
    expect(formatDecimalForInput(0.00013)).toBe("0.00013");
  });
});

describe("percentChipAmount (D-485)", () => {
  it("cuts to the token's decimals: half of 0.351649 USDC is 0.175824, not 0.1758245", () => {
    expect(percentChipAmount(0.351649, 50, 6)).toBe("0.175824");
    expect(percentChipAmount(0.17582450, 50, 6)).toBe("0.087912");
  });

  it("never rounds up", () => {
    expect(percentChipAmount(0.000003, 50, 6)).toBe("0.000001");
    expect(percentChipAmount(0.000001, 25, 6)).toBe("0");
  });

  it("does not lose a unit to float noise", () => {
    expect(percentChipAmount(0.3, 100, 6)).toBe("0.3");
    expect(percentChipAmount(1.1, 50, 6)).toBe("0.55");
    expect(percentChipAmount(0.075, 50, 6)).toBe("0.0375");
  });

  it("caps at 8 decimals for tokens that carry more (NEAR: 24)", () => {
    expect(percentChipAmount(0.0553413, 50, 24)).toBe("0.02767065");
    expect(percentChipAmount(0.123456789, 100, 24)).toBe("0.12345678");
  });

  it("keeps integers whole and never writes exponent form", () => {
    expect(percentChipAmount(10, 75, 6)).toBe("7.5");
    expect(percentChipAmount(0.0000004, 50, 8)).toBe("0.0000002");
  });
});
