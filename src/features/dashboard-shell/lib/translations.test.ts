import { describe, it, expect } from "vitest";
import { shellTranslations } from "./translations";
import { formatCrypto } from "@/features/portfolio-editor/lib/format";

// Same class of bug as portfolio-editor/lib/translations.test.ts, found by QA in this exact
// file: `subNavPerformance`/`subNavSettings` had the SAME literal value in `en` and `es`
// (untranslated "Performance"/"Settings"), and `satisfies Record<Language,
// Record<string,string>>` does not catch a key missing from one language — only that both
// objects independently match the shape. This guards key parity, not value equality
// (identical values across languages are legitimate — e.g. "Portfolios").
describe("shellTranslations", () => {
  const languages = Object.keys(shellTranslations) as Array<keyof typeof shellTranslations>;

  it("defines the same keys in every language", () => {
    const [first, ...rest] = languages;
    const expected = Object.keys(shellTranslations[first]).sort();
    for (const lang of rest) {
      expect({ lang, keys: Object.keys(shellTranslations[lang]).sort() }).toEqual({
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
    for (const [key, value] of Object.entries(shellTranslations[first])) {
      for (const lang of rest) {
        const other = (shellTranslations[lang] as Record<string, string>)[key] ?? "";
        expect({ lang, key, placeholders: placeholders(other) }).toEqual({ lang, key, placeholders: placeholders(value) });
      }
    }
  });

  it("has no empty strings", () => {
    for (const lang of languages) {
      for (const [key, value] of Object.entries(shellTranslations[lang])) {
        expect(`${lang}.${key}=${value}`).toMatch(/=\S/);
      }
    }
  });

  // D-235: the deposit-credited toast used to show only the asset ("USDC credited!"), with
  // no amount — a real deposit and an attacker's dust were visually indistinguishable
  // (D-234/D-236). `{amount}` must be present in every language and actually resolve to a
  // formatted quantity, the same way `handleCredited` builds the toast text.
  it("depositCredited includes an {amount} placeholder that resolves to a formatted quantity", () => {
    for (const lang of languages) {
      const template = shellTranslations[lang].depositCredited;
      expect(template).toContain("{amount}");
      const text = template.replace("{asset}", "USDC").replace("{amount}", formatCrypto(1234.5));
      expect(text).toContain(formatCrypto(1234.5));
      expect(text).not.toContain("{amount}");
    }
  });
});
