import { describe, expect, it } from "vitest";
import { PORTFOLIO_NAME_MAX_LENGTH, validatePortfolioName } from "./portfolio-validation";
import { shellTranslations } from "./translations";

describe("validatePortfolioName", () => {
  it("returns nameEmpty for empty string", () => {
    const result = validatePortfolioName("", []);
    expect(result).toEqual({ ok: false, error: "nameEmpty" });
  });

  it("returns nameEmpty for whitespace-only string", () => {
    const result = validatePortfolioName("   ", []);
    expect(result).toEqual({ ok: false, error: "nameEmpty" });
  });

  it("caps names at 25 characters", () => {
    expect(PORTFOLIO_NAME_MAX_LENGTH).toBe(25);
  });

  it("returns nameTooLong for 26-character name", () => {
    const name = "a".repeat(26);
    const result = validatePortfolioName(name, []);
    expect(result).toEqual({ ok: false, error: "nameTooLong" });
  });

  it("returns ok for exactly 25-character name", () => {
    const name = "a".repeat(25);
    const result = validatePortfolioName(name, []);
    expect(result).toEqual({ ok: true });
  });

  // The create modals prefill the preset name (or "Portfolio N"), de-duplicated with a
  // numeric suffix. A default that failed validation would block creation until edited.
  it("accepts every prefilled default name, with a de-dupe suffix, in both languages", () => {
    for (const t of Object.values(shellTranslations)) {
      for (const key of [
        "presetConservativeName",
        "presetBalancedName",
        "presetAggressiveName",
        "presetStablesName",
        "presetSatoshiName",
      ] as const) {
        expect(validatePortfolioName(`${t[key]} 99`, [])).toEqual({ ok: true });
      }
    }
  });

  it("returns nameDuplicate for case-insensitive duplicate", () => {
    const result = validatePortfolioName("Conservador", ["conservador", "Agresivo"]);
    expect(result).toEqual({ ok: false, error: "nameDuplicate" });
  });

  it("returns ok when name matches currentName (rename to same name)", () => {
    const result = validatePortfolioName("Conservador", ["Conservador", "Agresivo"], "Conservador");
    expect(result).toEqual({ ok: true });
  });

  it("returns ok for a different name with no conflict", () => {
    const result = validatePortfolioName("Moderado", ["Conservador", "Agresivo"]);
    expect(result).toEqual({ ok: true });
  });
});
