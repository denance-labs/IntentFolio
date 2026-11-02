import { describe, it, expect } from "vitest";
import { translations } from "./translations";

// `satisfies Record<Language, Record<string, string>>` types each language independently,
// so it does NOT catch a key added to one and forgotten in the other — the miss surfaces at
// runtime as `undefined` rendered into the UI. This closes that gap.
describe("translations", () => {
  const languages = Object.keys(translations) as Array<keyof typeof translations>;

  it("defines the same keys in every language", () => {
    const [first, ...rest] = languages;
    const expected = Object.keys(translations[first]).sort();
    for (const lang of rest) {
      expect({ lang, keys: Object.keys(translations[lang]).sort() }).toEqual({
        lang,
        keys: expected,
      });
    }
  });

  it("has no empty strings", () => {
    for (const lang of languages) {
      for (const [key, value] of Object.entries(translations[lang])) {
        expect(`${lang}.${key}=${value}`).toMatch(/=\S/);
      }
    }
  });
});
