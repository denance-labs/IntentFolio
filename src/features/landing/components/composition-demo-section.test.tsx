// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/features/dashboard-shell/context/language-context", () => ({
  useLanguage: () => ({ lang: "en", setLang: vi.fn() }),
}));

import { CompositionDemoSection } from "./composition-demo-section";

beforeAll(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});
afterEach(cleanup);

describe("CompositionDemoSection — the way out of the demo (D-561)", () => {
  const cta = () => screen.getByRole("link", { name: "Start with this mix" });

  it("links to the app with the preset on screen, and follows the switcher", () => {
    render(<CompositionDemoSection comingSoon={false} />);
    expect(cta().getAttribute("href")).toBe("/dashboard?preset=satoshi");
    fireEvent.click(screen.getByRole("button", { name: "Aggressive" }));
    expect(cta().getAttribute("href")).toBe("/dashboard?preset=aggressive");
  });

  it("is not a link while the app is coming soon", () => {
    render(<CompositionDemoSection comingSoon />);
    expect(screen.queryByRole("link", { name: "Start with this mix" })).toBeNull();
    expect(screen.getByTestId("app-cta-disabled").textContent).toContain("Start with this mix");
  });
});
