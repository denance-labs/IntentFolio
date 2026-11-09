// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { learnTranslations } from "../lib/translations";

const state = vi.hoisted(() => ({ lang: "en" as "en" | "es" }));
vi.mock("@/features/dashboard-shell/context/language-context", () => ({
  useLanguage: () => ({ lang: state.lang, setLang: vi.fn() }),
}));

import { PresetSection } from "./preset-section";

afterEach(cleanup);

// D-569: the guide says where stocks can't be bought, right under the presets that hold them.
describe.each(["en", "es"] as const)("PresetSection — where stocks can't be bought (%s)", (lang) => {
  it("says it under the presets", () => {
    state.lang = lang;
    render(<PresetSection />);
    const line = screen.getByText(learnTranslations[lang].presets.stocksUnavailable);
    const presets = screen.getAllByRole("list")[0];
    expect(presets.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
