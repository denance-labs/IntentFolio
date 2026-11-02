import { describe, it, expect } from "vitest";
import { tokenRegistry } from "./token-registry";
import {
  toIntentsTokenId,
  toRegistryTokenId,
  NEAR_REGISTRY_TOKEN_ID,
  WNEAR_INTENTS_TOKEN_ID,
} from "./intents-token-id";

describe("registry id ↔ intents id", () => {
  it("translates NEAR in both directions", () => {
    expect(toIntentsTokenId(NEAR_REGISTRY_TOKEN_ID)).toBe(WNEAR_INTENTS_TOKEN_ID);
    expect(toRegistryTokenId(WNEAR_INTENTS_TOKEN_ID)).toBe(NEAR_REGISTRY_TOKEN_ID);
  });

  // The property the whole design rests on: NEAR is the ONLY row where the two spaces
  // disagree. If a second one ever appears, these functions stop being enough and the
  // callers that apply them once at a boundary have to be revisited.
  it("is the identity on every other registry token", () => {
    const differ = tokenRegistry
      .map((t) => t.id)
      .filter((id) => toIntentsTokenId(id) !== id);
    expect(differ).toEqual([NEAR_REGISTRY_TOKEN_ID]);
  });

  // Both directions are applied at boundaries, and a value can legitimately arrive already
  // converted (a caller that reads the vault and writes it straight back). Idempotence is
  // what makes that safe instead of a corruption.
  it("is idempotent in both directions", () => {
    expect(toIntentsTokenId(toIntentsTokenId(NEAR_REGISTRY_TOKEN_ID))).toBe(
      WNEAR_INTENTS_TOKEN_ID
    );
    expect(toRegistryTokenId(toRegistryTokenId(WNEAR_INTENTS_TOKEN_ID))).toBe(
      NEAR_REGISTRY_TOKEN_ID
    );
  });

  it("passes unknown ids through untouched, rather than guessing", () => {
    expect(toIntentsTokenId("nep141:not-a-token.near")).toBe("nep141:not-a-token.near");
    expect(toRegistryTokenId("")).toBe("");
  });

  // wNEAR is deliberately absent from the registry (D-011 unifies it with native NEAR), so
  // nothing may reintroduce it as a token of its own — that would give the General Balance
  // two rows for one balance.
  it("keeps wNEAR out of the registry", () => {
    expect(tokenRegistry.find((t) => t.id === WNEAR_INTENTS_TOKEN_ID)).toBeUndefined();
  });
});
