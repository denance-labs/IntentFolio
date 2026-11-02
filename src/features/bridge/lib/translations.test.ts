import { describe, it, expect } from "vitest";
import { bridgeTranslations } from "./translations";

// Same guard as dashboard-shell/lib/translations.test.ts, added in block 5.4 because this
// file had none: `satisfies Record<Language, Record<string, string>>` only checks that each
// language independently matches the shape, so a key added to `en` and forgotten in `es`
// type-checks cleanly and renders `undefined` to a Spanish-speaking user — on the screen
// that moves money out of the account.
//
// Key parity, not value equality: identical strings across languages are legitimate ("MAX").
describe("bridgeTranslations", () => {
  const languages = Object.keys(bridgeTranslations) as Array<keyof typeof bridgeTranslations>;

  it("defines the same keys in every language", () => {
    const [first, ...rest] = languages;
    const expected = Object.keys(bridgeTranslations[first]).sort();
    for (const lang of rest) {
      expect({ lang, keys: Object.keys(bridgeTranslations[lang]).sort() }).toEqual({
        lang,
        keys: expected,
      });
    }
  });

  // Every language fills the same {placeholders}: one dropped from a translation renders the
  // template without the value (016 block 2.4: a name or an amount missing only in Spanish).
  it("uses the same {placeholders} in every language", () => {
    const placeholders = (text: string) => [...new Set(text.match(/\{\w+\}/g) ?? [])].sort();
    const [first, ...rest] = languages;
    for (const [key, value] of Object.entries(bridgeTranslations[first])) {
      for (const lang of rest) {
        const other = (bridgeTranslations[lang] as Record<string, string>)[key] ?? "";
        expect({ lang, key, placeholders: placeholders(other) }).toEqual({ lang, key, placeholders: placeholders(value) });
      }
    }
  });

  it("has no empty strings", () => {
    for (const lang of languages) {
      for (const [key, value] of Object.entries(bridgeTranslations[lang])) {
        expect(`${lang}.${key}=${value}`).toMatch(/=\S/);
      }
    }
  });
});
