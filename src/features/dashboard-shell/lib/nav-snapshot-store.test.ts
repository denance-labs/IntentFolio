// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { getNavSeries, takeSnapshot } from "./nav-snapshot-store";

describe("nav snapshot store", () => {
  beforeEach(() => localStorage.clear());

  // D-336: v1 holds the demo seed mixed into real portfolios; it must not come back.
  it("drops the legacy v1 data instead of reading it", () => {
    const today = new Date().toISOString().slice(0, 10);
    localStorage.setItem("nav-snapshots:v1", JSON.stringify({ p_real: { [today]: 999 } }));

    expect(getNavSeries("p_real", 60)).toEqual([]);
    expect(localStorage.getItem("nav-snapshots:v1")).toBeNull();
  });

  it("keeps the snapshots actually taken", () => {
    takeSnapshot("p_real", 12.5);
    expect(getNavSeries("p_real", 60)).toEqual([
      { date: new Date().toISOString().slice(0, 10), navUsd: 12.5 },
    ]);
  });
});
