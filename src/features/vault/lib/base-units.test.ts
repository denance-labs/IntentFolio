import { describe, it, expect } from "vitest";
import { AmountExceedsBalanceError, capToHeld, toBaseUnits, fromBaseUnits } from "./base-units";

// The mock/contract unit boundary. The cases that matter are the ones naive
// `qty * 10 ** decimals` gets wrong (007.plan Phase 1).

describe("toBaseUnits", () => {
  it("converts whole and fractional amounts", () => {
    expect(toBaseUnits(1, 6)).toBe("1000000");
    expect(toBaseUnits(1.5, 6)).toBe("1500000");
    expect(toBaseUnits(0.000001, 6)).toBe("1");
  });

  it("survives the floating-point traps (1.1 * 1e6 = 1100000.0000000002)", () => {
    expect(toBaseUnits(1.1, 6)).toBe("1100000");
    expect(toBaseUnits(0.29, 2)).toBe("29");
    expect(toBaseUnits(0.07, 2)).toBe("7");
    expect(toBaseUnits(8.7, 1)).toBe("87");
  });

  it("handles 24-decimal NEAR without exponential notation", () => {
    expect(toBaseUnits(1, 24)).toBe("1000000000000000000000000");
    expect(toBaseUnits(0.5, 24)).toBe("500000000000000000000000");
  });

  it("TRUNCATES excess precision instead of rounding up", () => {
    // Rounding up could exceed the user's balance and fail the Transfer.
    expect(toBaseUnits(1.9999999, 6)).toBe("1999999");
    expect(toBaseUnits(0.0000009, 6)).toBe("0");
  });

  it("returns a canonical zero and strips leading zeros", () => {
    expect(toBaseUnits(0, 6)).toBe("0");
    expect(toBaseUnits(0.1, 6)).toBe("100000");
  });

  it("handles decimals = 0", () => {
    expect(toBaseUnits(5.9, 0)).toBe("5");
  });

  it("rejects nonsense inputs rather than emitting a wrong amount", () => {
    expect(() => toBaseUnits(NaN, 6)).toThrow();
    expect(() => toBaseUnits(-1, 6)).toThrow();
    expect(() => toBaseUnits(1, -1)).toThrow();
  });
});

describe("toBaseUnits — the number the user saw, not the double's expansion (D-303)", () => {
  // The wet test that found it: 0.3 NEAR signed 299999999999999988897769 yocto, because
  // `toFixed(25)` spelled out 0.29999999999999998889776975… before truncating.
  it("signs 0.3 NEAR as exactly 3 × 10^23 yocto", () => {
    expect(toBaseUnits(0.3, 24)).toBe("300000000000000000000000");
    expect(toBaseUnits(0.1, 18)).toBe("100000000000000000");
    expect(toBaseUnits(1.23, 24)).toBe("1230000000000000000000000");
  });

  it("expands exponential notation instead of misreading it", () => {
    expect(toBaseUnits(1e-7, 18)).toBe("100000000000");
    expect(toBaseUnits(1.5e-9, 18)).toBe("1500000000");
    expect(toBaseUnits(1e-24, 24)).toBe("1");
    expect(toBaseUnits(1e21, 0)).toBe("1000000000000000000000");
    expect(toBaseUnits(1.234e22, 2)).toBe("1234000000000000000000000");
  });
});

describe("capToHeld — never sign more than the account holds (D-303)", () => {
  const held = BigInt("123456789012345678901234");

  it("leaves a partial amount untouched", () => {
    expect(capToHeld(BigInt(5), BigInt(10))).toBe(BigInt(5));
    expect(capToHeld(BigInt(999_999), BigInt(1_000_000))).toBe(BigInt(999_999));
    expect(capToHeld(held, held)).toBe(held);
  });

  // The threshold, pinned from both sides and in both directions: within 10^-12 of the
  // balance is "everything"; past it is a real partial amount, or a real excess.
  it("snaps to the balance within 1 part in 10^12, and not beyond", () => {
    const e24 = BigInt(10) ** BigInt(24);
    const e12 = BigInt(10) ** BigInt(12);
    expect(capToHeld(e24 + e12, e24)).toBe(e24);
    expect(() => capToHeld(e24 + BigInt(2) * e12, e24)).toThrow(AmountExceedsBalanceError);
    expect(capToHeld(e24, e24 + e12)).toBe(e24 + e12);
    expect(capToHeld(e24 - e12, e24 + e12)).toBe(e24 - e12);
  });

  it("gives exactly the balance when Max lands below it by float noise — no dust", () => {
    // 0.3 as a double read back through `toFixed` was 11102230246251565 yocto short.
    const raw = BigInt("300000000000000000000000");
    expect(capToHeld(BigInt("299999999999999988897769"), raw)).toBe(raw);
  });

  it("gives exactly the balance when the excess is float noise", () => {
    // Max on this balance: the float's shortest spelling lands 1098766 yocto over — noise.
    expect(capToHeld(BigInt("123456789012345680000000"), held)).toBe(held);
  });

  it("refuses a real excess instead of silently signing a smaller amount", () => {
    expect(() => capToHeld(BigInt(11), BigInt(10))).toThrow(AmountExceedsBalanceError);
    expect(() => capToHeld(held + BigInt(10) ** BigInt(13), held)).toThrow(
      AmountExceedsBalanceError
    );
    expect(() => capToHeld(BigInt(1), BigInt(0))).toThrow(AmountExceedsBalanceError);
  });

  // The property the operator asked for: "Max" — a float built from the exact balance the
  // way the app builds it (`use-intents-balances.ts`) — must NEVER come out above that
  // balance, and must never be refused. Before the cap, 50–60 % of these came out above and
  // most of the rest a few units below (dust). Now every one signs the balance exactly.
  it.each([24, 18, 8, 6])("Max signs exactly the balance at %i decimals", (decimals) => {
    let seed = 20260923 + decimals;
    const nextDigit = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % 10;
    };
    for (let n = 0; n < 2000; n++) {
      const length = 1 + (n % (decimals + 6));
      let digits = "";
      for (let i = 0; i < length; i++) digits += nextDigit();
      const raw = BigInt(digits) + BigInt(1);
      const maxAsTheAppHoldsIt = Number(raw) / 10 ** decimals;
      const signed = capToHeld(BigInt(toBaseUnits(maxAsTheAppHoldsIt, decimals)), raw);
      expect(signed).toBe(raw);
    }
  });
});

describe("fromBaseUnits", () => {
  it("round-trips the common cases", () => {
    expect(fromBaseUnits(BigInt(1_000_000), 6)).toBe(1);
    expect(fromBaseUnits(BigInt(1_500_000), 6)).toBe(1.5);
    expect(fromBaseUnits(BigInt(1), 6)).toBe(0.000001);
    expect(fromBaseUnits(BigInt(0), 6)).toBe(0);
    expect(fromBaseUnits(BigInt(5), 0)).toBe(5);
  });
});
