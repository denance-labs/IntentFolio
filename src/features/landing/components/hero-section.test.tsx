// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";

vi.mock("@/features/dashboard-shell/context/language-context", () => ({
  useLanguage: () => ({ lang: "en", setLang: vi.fn() }),
}));

import { HeroSection } from "./hero-section";

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

describe("HeroSection — the working demo on the first screen (D-568)", () => {
  const cta = () => screen.getByRole("link", { name: "Start with this mix" });

  it("leads with the stock presets and opens on Tech Titans", () => {
    render(<HeroSection comingSoon={false} />);
    const order = ["Tech Titans", "NEAR + Stocks", "Satoshi", "Balanced", "Aggressive", "Conservative"].map((name) =>
      screen.getByRole("button", { name })
    );
    order.slice(1).forEach((button, i) => {
      expect(order[i].compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
    expect(screen.getByRole("button", { name: "Tech Titans", pressed: true })).toBeTruthy();
    expect(cta().getAttribute("href")).toBe("/dashboard?preset=techTitans");
  });

  it("links to the app with the preset on screen, and follows the switcher", () => {
    render(<HeroSection comingSoon={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Satoshi" }));
    expect(cta().getAttribute("href")).toBe("/dashboard?preset=satoshi");
  });

  it("is not a link while the app is coming soon", () => {
    render(<HeroSection comingSoon />);
    expect(screen.queryByRole("link", { name: "Start with this mix" })).toBeNull();
    expect(screen.getByTestId("app-cta-disabled").textContent).toContain("Start with this mix");
  });

  it("serves the starting point to JavaScript, and the finished mix to a visitor without it (D-566)", () => {
    const html = renderToString(<HeroSection comingSoon={false} />);
    // The live copy (hidden without JS) starts at 100% USDC, so nothing jumps when the page hydrates.
    expect(html).toMatch(/data-needs-js[^]*From 100% USDC/);
    // The still copy only shows without JS, already on target.
    expect(html).toMatch(/data-nojs-only[^]*✓ On target/);
  });
});

// D-569: where stocks can't be bought, said on the first screen, in the server HTML too.
describe("HeroSection — where stocks can't be bought (D-569)", () => {
  it("says it under the presets, before anyone opens the app", () => {
    render(<HeroSection comingSoon={false} />);
    expect(screen.getByText("Stocks aren't available in the United States or Canada.")).toBeTruthy();
    expect(renderToString(<HeroSection comingSoon={false} />)).toContain("Stocks aren&#x27;t available in the United States or Canada.");
  });
});

// D-569: where stocks can't be bought, the hero opens on the first preset that can be picked, with
// the stock ones last and off.
describe("HeroSection — the stock presets where stocks can't be bought (D-569)", () => {
  const names = ["Satoshi", "Balanced", "Aggressive", "Conservative", "Tech Titans", "NEAR + Stocks"];

  it("puts them last, off, and opens on Satoshi", () => {
    render(<HeroSection comingSoon={false} stocksBlocked />);
    const buttons = names.map((name) => screen.getByRole("button", { name }) as HTMLButtonElement);
    buttons.slice(1).forEach((button, i) => {
      expect(buttons[i].compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
    expect(buttons.slice(-2).every((button) => button.disabled)).toBe(true);
    expect(buttons.slice(0, 4).some((button) => button.disabled)).toBe(false);
    expect(screen.getByRole("button", { name: "Satoshi", pressed: true })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Start with this mix" }).getAttribute("href")).toBe("/dashboard?preset=satoshi");
    fireEvent.click(screen.getByRole("button", { name: "Tech Titans" }));
    expect(screen.getByRole("button", { name: "Satoshi", pressed: true })).toBeTruthy();
  });

  it("does the same in the server HTML, so the first paint already has them last", () => {
    const html = renderToString(<HeroSection comingSoon={false} stocksBlocked />);
    expect(html.indexOf(">Satoshi<")).toBeLessThan(html.indexOf(">Tech Titans<"));
    expect(html).toContain("/dashboard?preset=satoshi");
  });
});
