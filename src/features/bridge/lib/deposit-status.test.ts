import { describe, it, expect } from "vitest";
import { isDepositCredited } from "./deposit-status";

// Regression for D-226, diagnosed with real money on Stellar (2026-08-08). The credited branch
// asked for "CREDITED" while the PoA bridge answers "COMPLETED"; both spellings are in the
// SDK's own union, so the dead branch typechecked and shipped. These tests exist to pin the
// value the bridge actually sends — a type that permits both cannot do it.
describe("isDepositCredited", () => {
  it('treats "COMPLETED" as credited — the value the PoA bridge really sends', () => {
    // Measured, not assumed: three Stellar deposits came back COMPLETED while a view call on
    // intents.near confirmed the funds were already in the Verifier.
    expect(isDepositCredited("COMPLETED")).toBe(true);
  });

  it('still treats "CREDITED" as credited', () => {
    // Kept rather than swapped: it remains legal in the SDK union, and a deployment using the
    // other word would otherwise reintroduce the same permanently-dead branch.
    expect(isDepositCredited("CREDITED")).toBe(true);
  });

  it("does not fire early on a pending deposit", () => {
    expect(isDepositCredited("PENDING")).toBe(false);
  });

  it("does not fire on a failed deposit", () => {
    expect(isDepositCredited("FAILED")).toBe(false);
  });
});
