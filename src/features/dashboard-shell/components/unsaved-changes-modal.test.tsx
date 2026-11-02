// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { shellTranslations } from "../lib/translations";

// 027 A-10: the same question for a portfolio and for the draft's tab, each naming its own.

vi.mock("../context/language-context", () => ({ useLanguage: () => ({ lang: "es", setLang: vi.fn() }) }));

import { UnsavedChangesModal } from "./unsaved-changes-modal";

const t = shellTranslations.es;

describe("UnsavedChangesModal", () => {
  afterEach(cleanup);

  it("speaks of the portfolio by default", () => {
    render(<UnsavedChangesModal onDiscard={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText(t.unsavedChangesBody)).toBeTruthy();
  });

  it("speaks of the draft for the draft's tab", () => {
    render(<UnsavedChangesModal draft onDiscard={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText(t.unsavedDraftChangesBody)).toBeTruthy();
    expect(screen.queryByText(t.unsavedChangesBody)).toBeNull();
  });
});
