// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  EXAMPLE_CUMULATIVE_SPREAD_USD as SERIES,
  EXAMPLE_SPREAD_AXIS_TICKS_USD as TICKS,
} from "@/content/example-spread";

const state = vi.hoisted(() => ({ lang: "en" as "en" | "es" }));

vi.mock("@/features/dashboard-shell/context/language-context", () => ({
  useLanguage: () => ({ lang: state.lang, setLang: vi.fn() }),
}));

import { PerformanceSection } from "./performance-section";

beforeAll(() => {
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

describe("PerformanceSection — the example spread chart (D-561)", () => {
  it("says it is an example, on which amount, and in Spanish when the page is", () => {
    state.lang = "es";
    render(<PerformanceSection />);
    expect(screen.getAllByText("Ejemplo")).toHaveLength(2);
    expect(screen.getByText("Spread acumulado")).toBeTruthy();
    expect(screen.getByText("Sobre un portfolio de $10,000")).toBeTruthy();
    expect(screen.getByText("Movimiento 15")).toBeTruthy();
    expect(screen.queryByText(/Resultados|Results|Cumulative/)).toBeNull();
  });

  it("describes the same figures it draws to a screen reader", () => {
    state.lang = "en";
    render(<PerformanceSection />);
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe(
      "Example chart. On a $10,000 portfolio, the cumulative spread goes from $1.10 after the first move to $13.17 after 15 moves."
    );
  });

  it("keeps the series cumulative and inside its axis", () => {
    SERIES.forEach((usd, i) => {
      if (i > 0) expect(usd).toBeGreaterThanOrEqual(SERIES[i - 1]);
    });
    expect(Math.min(...SERIES)).toBeGreaterThanOrEqual(TICKS[0]);
    expect(Math.max(...SERIES)).toBeLessThanOrEqual(TICKS[TICKS.length - 1]);
  });
});
