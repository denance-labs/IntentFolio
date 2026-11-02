// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MiniBand } from "./mini-band";
import type { BandState } from "../types";

// D-505: the bar's marks by shape — the "now" dot only when something is held, the dotted
// connector only out of the band, and never below it on a token that can only go down (D-491).

afterEach(cleanup);

function renderBand(state: BandState, currentPct: number, canRise = true) {
  render(<MiniBand minPct={17} targetPct={20} maxPct={23} currentPct={currentPct} state={state} canRise={canRise} label="bar" />);
  const bar = screen.getByRole("img", { name: "bar" });
  return {
    dot: bar.querySelector(".rounded-full.bg-slate-50") as HTMLElement | null,
    connector: bar.querySelector(".border-dotted") as HTMLElement | null,
  };
}

describe("MiniBand (D-505)", () => {
  it("inside the band: a dot and no connector", () => {
    const { dot, connector } = renderBand("inside", 19);
    expect(dot).not.toBeNull();
    expect(connector).toBeNull();
  });

  it("below the band: a connector from the dot up to the band's lower edge", () => {
    const { connector } = renderBand("below", 4);
    expect(connector?.style.left).toBe("4%");
    expect(connector?.style.width).toBe("13%");
  });

  it("above the band: a connector from the band's upper edge to the dot", () => {
    const { connector } = renderBand("above", 35);
    expect(connector?.style.left).toBe("23%");
    expect(connector?.style.width).toBe("12%");
  });

  it("a token that can only go down gets no connector below the band, but keeps it above", () => {
    expect(renderBand("below", 4, false).connector).toBeNull();
    cleanup();
    expect(renderBand("above", 35, false).connector).not.toBeNull();
  });

  it("with nothing held there is no dot (it used to show as a clipped half-circle at 0 %)", () => {
    expect(renderBand("empty", 0).dot).toBeNull();
  });

  it("keeps the dot whole at 0 % and at 100 %", () => {
    expect(renderBand("below", 0).dot?.style.left).toBe("calc(0% - 0px)");
    cleanup();
    expect(renderBand("above", 100).dot?.style.left).toBe("calc(100% - 10px)");
  });

  it("D-525: the arrowhead sits at the band's edge, pointing up below it and down above it", () => {
    renderBand("below", 4);
    expect(screen.getByRole("img", { name: "bar" }).querySelector("svg")?.style.left).toBe("calc(17% - 8px)");
    cleanup();
    renderBand("above", 35);
    const arrow = screen.getByRole("img", { name: "bar" }).querySelector("svg");
    expect(arrow?.style.left).toBe("calc(23% + 2px)");
    expect(arrow?.style.transform).toBe("scaleX(-1)");
  });

  it("D-525: no arrowhead when the connector is too short, or inside the band", () => {
    renderBand("below", 14);
    expect(screen.getByRole("img", { name: "bar" }).querySelector("svg")).toBeNull();
    cleanup();
    renderBand("inside", 19);
    expect(screen.getByRole("img", { name: "bar" }).querySelector("svg")).toBeNull();
  });
});
