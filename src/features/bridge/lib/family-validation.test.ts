import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { familyForChainId, isFamilyValidated, getFamilyValidationMap } from "./family-validation";

describe("familyForChainId", () => {
  it("maps each of the six login families", () => {
    expect(familyForChainId("eth:1")).toBe("evm");
    expect(familyForChainId("near:mainnet")).toBe("near");
    expect(familyForChainId("sol:mainnet")).toBe("solana");
    expect(familyForChainId("ton:mainnet")).toBe("ton");
    expect(familyForChainId("tron:mainnet")).toBe("tron");
    expect(familyForChainId("stellar:mainnet")).toBe("stellar");
  });

  it("returns null for deposit-only chains with no login family", () => {
    expect(familyForChainId("btc:mainnet")).toBeNull();
    expect(familyForChainId("aptos:mainnet")).toBeNull();
  });
});

describe("isFamilyValidated", () => {
  const ENV_KEYS = [
    "BRIDGE_FAMILY_VALIDATED_NEAR",
    "BRIDGE_FAMILY_VALIDATED_EVM",
    "BRIDGE_FAMILY_VALIDATED_SOLANA",
    "BRIDGE_FAMILY_VALIDATED_TON",
    "BRIDGE_FAMILY_VALIDATED_STELLAR",
    "BRIDGE_FAMILY_VALIDATED_TRON",
  ];
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  // This test is the durable record, so it moves only when a family has ACTUALLY been
  // round-tripped with real funds — never to make a red suite green.
  it("defaults to the current empirical state (all but TON validated)", () => {
    for (const key of ENV_KEYS) delete process.env[key];
    expect(isFamilyValidated("near")).toBe(true);
    expect(isFamilyValidated("evm")).toBe(true);
    // Solana round-tripped with real funds on 2026-08-06 (008.plan F4.2), via Backpack.
    expect(isFamilyValidated("solana")).toBe(true);
    // Tron round-tripped with real funds on 2026-08-07 (008.plan F4.2), via TronLink:
    // deposit d8dc1a29…, withdrawal 26baa5d6…, both ledgers asserted to the base unit.
    expect(isFamilyValidated("tron")).toBe(true);
    // Stellar round-tripped with real funds on 2026-08-08 (008.plan F4.5), via Freighter:
    // seven memo deposits, Allocate + Unallocate asserted to the stroop on both ledgers, and a
    // withdrawal of 7.804 delivered as 7.704 XLM. The withdrawal only became reachable once
    // D-240 was fixed — the modal demanded a memo the HOT envelope rejects.
    expect(isFamilyValidated("stellar")).toBe(true);
    // TON is the last one. Block 4.5 built the code it was missing — the `encodeHotReceiver`
    // cell and the address validation (D-214) — but CODE IS NOT VALIDATION: this flag is a
    // claim about money that moved, and TON's round trip has not been run. It flips when the
    // operator runs it, in the same commit that writes the evidence into `family-validation.ts`.
    expect(isFamilyValidated("ton")).toBe(false);
  });

  it("an operator can flip a family via env var without changing the default", () => {
    process.env.BRIDGE_FAMILY_VALIDATED_TON = "true";
    expect(isFamilyValidated("ton")).toBe(true);
    // Untouched by the override above — TON is now the only family still false by default.
    expect(isFamilyValidated("evm")).toBe(true);
  });

  // The override has to work in BOTH directions — a family can be switched back off
  // without editing code if something turns up after it was validated.
  it("an operator can switch a validated family back off via env var", () => {
    process.env.BRIDGE_FAMILY_VALIDATED_SOLANA = "false";
    expect(isFamilyValidated("solana")).toBe(false);
  });

  it("getFamilyValidationMap returns all six families", () => {
    const map = getFamilyValidationMap();
    expect(Object.keys(map).sort()).toEqual(
      ["evm", "near", "solana", "stellar", "ton", "tron"].sort()
    );
  });
});
