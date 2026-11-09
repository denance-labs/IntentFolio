// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { PortfolioBuildDemo } from "./portfolio-build-demo";
import { buildDemoPresets } from "../lib/demo-presets";

let reducedMotion = false;

beforeAll(() => {
  vi.stubGlobal("matchMedia", () => ({
    matches: reducedMotion,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  // Never fires: the demo stays on its starting point unless reduced motion skips to the end.
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});
afterEach(() => {
  cleanup();
  reducedMotion = false;
});

const satoshi = () => buildDemoPresets("en")[0];
const rowPcts = () => screen.getAllByRole("listitem").filter((li) => li.getAttribute("aria-hidden") !== "true").map((li) => li.textContent);

describe("PortfolioBuildDemo — moving from a starting point to the mix (D-564)", () => {
  it("starts fully in USDC, never as an empty donut", () => {
    expect(satoshi().start).toMatchObject({ label: "USDC", pct: 100 });
    render(<PortfolioBuildDemo presets={[satoshi()]} lang="en" />);
    expect(screen.getByText("From 100% USDC")).toBeTruthy();
    expect(rowPcts()).toEqual(["BTC0%", "ETH0%", "NEAR0%"]);
  });

  it("shows the target mix on target straight away under reduced motion", () => {
    reducedMotion = true;
    render(<PortfolioBuildDemo presets={[satoshi()]} lang="es" />);
    expect(screen.getByText("✓ En objetivo")).toBeTruthy();
    expect(rowPcts()).toEqual(["BTC70%", "ETH20%", "NEAR10%"]);
  });

  it("a preset that holds USDC starts its USDC row at 100%", () => {
    const balanced = buildDemoPresets("en").find((p) => p.id === "balanced")!;
    render(<PortfolioBuildDemo presets={[balanced]} lang="en" />);
    expect(rowPcts()).toContain("USDC100%");
  });

  it("server HTML (no JS) shows the target mix, since nothing could move it (D-566)", () => {
    const html = renderToString(<PortfolioBuildDemo presets={[satoshi()]} lang="en" />);
    expect(html).toContain("✓ On target");
    expect(html).toContain("70%");
    expect(html).not.toContain(">From 100% USDC<");
  });
});
