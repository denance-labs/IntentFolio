import { describe, it, expect } from "vitest";
import { shellTranslations } from "./translations";
import { translations as editorTranslations } from "@/features/portfolio-editor/lib/translations";
import { bridgeTranslations } from "@/features/bridge/lib/translations";
import { learnTranslations } from "@/features/learn/lib/translations";
import { landingTranslations } from "@/features/landing/lib/translations";

// Triage 016, block 1.1: the Spanish UI drifted from CONTEXT.md — about 25 strings said
// "cartera" (the term is "portfolio" in both languages) and a few said "billetera" (the
// term is "wallet"). A key-parity test cannot see a wrong word, so this guards the words.
const TABLES = {
  shell: shellTranslations.es,
  editor: editorTranslations.es,
  bridge: bridgeTranslations.es,
} as const;

const FORBIDDEN_ES = [/\bcarteras?\b/i, /\bbilleteras?\b/i];

describe("Spanish copy uses the CONTEXT.md terms", () => {
  for (const [table, strings] of Object.entries(TABLES)) {
    it(`${table}: never says "cartera" or "billetera"`, () => {
      for (const [key, value] of Object.entries(strings)) {
        for (const pattern of FORBIDDEN_ES) {
          expect(`${table}.${key}=${value}`).not.toMatch(pattern);
        }
      }
    });
  }

  // One verb family per level (CONTEXT.md, triage 016 Q1): the per-token action of the
  // composition table is an Unallocation, so it must never borrow the Withdrawal's verb.
  it("the composition table's per-token action names the funding account, not a withdrawal", () => {
    expect(editorTranslations.es.remove).not.toMatch(/retir/i);
    expect(editorTranslations.en.remove).not.toMatch(/withdraw/i);
    expect(editorTranslations.es.remove).toMatch(/cuenta de fondos/i);
    expect(editorTranslations.en.remove).toMatch(/funding account/i);
  });
});

// Triage 029, B-15: the General Balance is called "Funding account" / "Cuenta de fondos" in the
// UI (CONTEXT.md). The code keeps the GeneralBalance identifiers; only the copy changed, so the
// old name must not come back in a string.
describe("the copy never uses the old General Balance name", () => {
  const tables = {
    shell: shellTranslations,
    editor: editorTranslations,
    bridge: bridgeTranslations,
    learn: learnTranslations,
    landing: landingTranslations,
  } as const;

  for (const [name, table] of Object.entries(tables)) {
    it(`${name}: never says "general balance" or "saldo general"`, () => {
      const text = JSON.stringify(table);
      expect(text).not.toMatch(/general balance/i);
      expect(text).not.toMatch(/saldo general/i);
    });
  }
});

// Triage 029, B-1: the Spanish UI is neutral Spanish with "tú" (CONTEXT.md, "Spanish register").
// It was written in Rioplatense voseo; this list holds the forms that kept coming back, so new
// copy fails here instead of in review.
describe("Spanish copy uses tú, not voseo", () => {
  const VOSEO = [
    "vos", "podés", "tenés", "querés", "sabés", "hacés", "necesitás", "elegís", "llegás", "ganás",
    "armá", "elegí", "probá", "revisá", "conectá", "depositá", "confirmá", "volvé", "ingresá",
    "seleccioná", "asigná", "agregá", "usá", "mirá", "retirá", "reintentá", "esperá", "guardá",
    "dejalo", "desbloqueala", "fijate", "acá", "recién",
  ];
  const pattern = new RegExp(`(?<!\\p{L})(${VOSEO.join("|")})(?!\\p{L})`, "iu");
  const tables = {
    shell: shellTranslations.es,
    editor: editorTranslations.es,
    bridge: bridgeTranslations.es,
    learn: learnTranslations.es,
    landing: landingTranslations.es,
  } as const;

  for (const [name, table] of Object.entries(tables)) {
    it(`${name}: no voseo forms`, () => {
      expect(JSON.stringify(table)).not.toMatch(pattern);
    });
  }

  it("the guard catches a voseo string", () => {
    expect("Armá tu portfolio").toMatch(pattern);
    expect("Podés cambiarlo.").toMatch(pattern);
    expect("Arma tu portfolio").not.toMatch(pattern);
  });
});

// Triage 016, block 1b: "Portfolio Commit" is the source-facing name of the signed operation
// (CONTEXT.md). The History used it as a badge; it now names what the user did instead.
describe("the History never shows the internal operation name", () => {
  it.each(["en", "es"] as const)("%s shell strings never say \"Portfolio Commit\"", (lang) => {
    expect(JSON.stringify(shellTranslations[lang])).not.toMatch(/portfolio commit/i);
  });
});

// D-346: /learn and the landing promised "your funds stay yours / are always yours". While
// allocated, funds sit in the vault (ADR-0005), so the promise is false — and since 1.3 the
// guide is one click away from the dashboard. Outcome copy ("withdraw anytime") is fine.
describe("marketing and guide copy make no custody promise", () => {
  const FORBIDDEN = [
    /stay(s)? yours/i,
    /always yours/i,
    /siguen? siendo tuyos/i,
    /siempre tuyos/i,
  ];
  const sources = { learn: learnTranslations, landing: landingTranslations } as const;

  for (const [name, table] of Object.entries(sources)) {
    it(`${name}: never says the funds stay the user's`, () => {
      const text = JSON.stringify(table);
      for (const pattern of FORBIDDEN) expect(text).not.toMatch(pattern);
    });
  }
});
