// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { shellTranslations } from "../lib/translations";

// 016 block 2.5 — the welcome itself. When it opens and what closing it records are the
// shell's (dashboard-shell.test.tsx); this is the dialog.

const lang = vi.hoisted(() => ({ value: "en" as "en" | "es" }));
vi.mock("../context/language-context", () => ({ useLanguage: () => ({ lang: lang.value, setLang: vi.fn() }) }));

import { WelcomeModal } from "./welcome-modal";

function renderWelcome(hasPortfolios = false, hasDraft = false) {
  const props = { onStart: vi.fn(), onClose: vi.fn(), onDeposit: vi.fn() };
  render(<WelcomeModal {...props} hasPortfolios={hasPortfolios} hasDraft={hasDraft} />);
  return props;
}

afterEach(() => {
  cleanup();
  lang.value = "en";
});

describe("WelcomeModal", () => {
  it("is a dialog named by its title, which takes the focus — Enter on arrival starts nothing", () => {
    renderWelcome();
    const dialog = screen.getByRole("dialog", { name: shellTranslations.en.welcomeTitle });
    expect(dialog).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: shellTranslations.en.welcomeTitle }));
  });

  it("the CTA closes it and starts the creation, once each", () => {
    const { onStart, onClose } = renderWelcome();
    fireEvent.click(screen.getByRole("button", { name: shellTranslations.en.welcomeCta }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("\"Not now\" and a click outside only close it", () => {
    const { onStart, onClose } = renderWelcome();
    fireEvent.click(screen.getByRole("button", { name: shellTranslations.en.welcomeNotNow }));
    const backdrop = screen.getByRole("dialog").parentElement!;
    fireEvent.mouseDown(backdrop, { target: backdrop });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onStart).not.toHaveBeenCalled();
  });

  it("with portfolios neither the CTA nor the build step says \"first\"", () => {
    renderWelcome(true);
    expect(screen.queryByRole("button", { name: shellTranslations.en.welcomeCta })).toBeNull();
    expect(screen.getByRole("button", { name: shellTranslations.en.welcomeCtaAnother })).toBeTruthy();
    expect(screen.getAllByRole("listitem")[0].textContent).toContain(shellTranslations.en.onboardingStep2TitleAnother);
    expect(screen.getByRole("dialog").textContent).not.toContain(shellTranslations.en.onboardingStep2Title);
  });

  // 022-D (D-455): one draft per account, so with one saved the CTA leads to it. The steps stay.
  it.each([
    ["no portfolio", false],
    ["with portfolios", true],
  ])("with a draft (%s), the CTA is \"View my portfolio\": it closes and goes on", (_label, hasPortfolios) => {
    const { onStart, onClose } = renderWelcome(hasPortfolios, true);
    expect(screen.queryByRole("button", { name: shellTranslations.en.welcomeCta })).toBeNull();
    expect(screen.queryByRole("button", { name: shellTranslations.en.welcomeCtaAnother })).toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: shellTranslations.en.draftCardView }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("a new account's build step says \"first\" and that it can come before depositing", () => {
    renderWelcome();
    const first = screen.getAllByRole("listitem")[0].textContent;
    expect(first).toContain(shellTranslations.en.onboardingStep2Title);
    expect(first).toContain(shellTranslations.en.onboardingBuildFirstBody);
  });

  it("speaks Spanish with the approved copy", () => {
    lang.value = "es";
    renderWelcome();
    expect(screen.getByRole("dialog", { name: "Te damos la bienvenida a IntentFolio" })).toBeTruthy();
    // 022-E (D-456): the line about risk is gone.
    expect(screen.queryByText(/sube y baja/)).toBeNull();
    // 022-I (D-459): step 1 says it; the separate line under the steps is gone.
    expect(
      screen.getByText(
        "Elige qué tokens y cuánto de cada uno. Puedes armarlo antes de depositar: queda guardado hasta que lleguen tus fondos."
      )
    ).toBeTruthy();
    expect(screen.queryByText(/lo confirmas cuando lleguen tus fondos/)).toBeNull();
    expect(screen.getByRole("button", { name: "Armar mi primer portfolio" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ahora no" })).toBeTruthy();
  });

  // 029 B-19: the build and deposit steps close the welcome and run their action, like the CTA;
  // the guide's steps leave it open (they open a new tab).
  it("the build and deposit steps close it and run their action; the guide's steps leave it open", () => {
    const { onStart, onClose, onDeposit } = renderWelcome();
    const items = screen.getAllByRole("listitem");
    fireEvent.click(within(items[0]).getByRole("button"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onStart).toHaveBeenCalledTimes(1);
    fireEvent.click(within(items[1]).getByRole("button"));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onDeposit).toHaveBeenCalledTimes(1);
    fireEvent.click(within(items[2]).getByRole("link"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
