import { describe, expect, it } from "vitest";
import { conicStops, cumulativeStepPath, dailyWindow, leaderLabels, ringSegments, type LeaderLayout } from "./showcase-geometry";

describe("ringSegments", () => {
  it("lays the dashes end to end, each shortened by the gap", () => {
    const { circumference, segments } = ringSegments(
      [
        { tokenId: "a", pct: 25 },
        { tokenId: "b", pct: 75 },
      ],
      100,
      4
    );
    expect(circumference).toBeCloseTo(2 * Math.PI * 100, 6);
    expect(segments[0].dash).toBeCloseTo(circumference / 4 - 4, 6);
    expect(segments[0].offset).toBeCloseTo(-2, 6);
    expect(segments[1].dash).toBeCloseTo((circumference * 3) / 4 - 4, 6);
    expect(segments[1].offset).toBeCloseTo(-(circumference / 4 + 2), 6);
  });

  it("keeps a token with no share in its place with nothing painted", () => {
    const { segments } = ringSegments(
      [
        { tokenId: "a", pct: 0 },
        { tokenId: "b", pct: 100 },
      ],
      100,
      4
    );
    expect(segments[0]).toEqual({ tokenId: "a", dash: 0, offset: -0 });
    expect(segments[1].dash).toBeGreaterThan(0);
  });

  it("closes the ring with no gap when one token holds it all", () => {
    const { circumference, segments } = ringSegments(
      [
        { tokenId: "a", pct: 0 },
        { tokenId: "b", pct: 100 },
      ],
      100,
      4
    );
    expect(segments[1].dash).toBeCloseTo(circumference, 6);
    expect(segments[1].offset).toBeCloseTo(0, 6);
  });

  it("paints nothing when every share is 0", () => {
    const { segments } = ringSegments([{ tokenId: "a", pct: 0 }], 100, 4);
    expect(segments[0].dash).toBe(0);
  });
});

describe("conicStops", () => {
  it("skips empty shares and normalises to 100%", () => {
    expect(
      conicStops([
        { color: "#000", pct: 1 },
        { color: "#111", pct: 0 },
        { color: "#222", pct: 3 },
      ])
    ).toBe("#000 0.00% 25.00%, #222 25.00% 100.00%");
  });
});

describe("dailyWindow", () => {
  it("fills the days with no swaps and ends on the given day", () => {
    const window = dailyWindow(
      [
        { day: "2026-10-01", swaps: 1, spreadUsd: 0.1 },
        { day: "2026-10-03", swaps: 3, spreadUsd: 0.2 },
      ],
      "2026-10-04",
      5
    );
    expect(window).toEqual([
      { day: "2026-09-30", swaps: 0 },
      { day: "2026-10-01", swaps: 1 },
      { day: "2026-10-02", swaps: 0 },
      { day: "2026-10-03", swaps: 3 },
      { day: "2026-10-04", swaps: 0 },
    ]);
  });
});

describe("cumulativeStepPath", () => {
  it("climbs from 0 to the total and ends at the top right", () => {
    const path = cumulativeStepPath(
      [
        { day: "2026-10-01", swaps: 1, spreadUsd: 1 },
        { day: "2026-10-03", swaps: 1, spreadUsd: 3 },
      ],
      "2026-10-05",
      100,
      50,
      0
    );
    expect(path).not.toBeNull();
    expect(path!.line.startsWith("M0.0 50.0")).toBe(true);
    expect(path!.end).toEqual({ x: 100, y: 0 });
  });

  it("has nothing to draw with no entries", () => {
    expect(cumulativeStepPath([], "2026-10-05", 100, 50)).toBeNull();
  });
});

describe("leaderLabels", () => {
  const layout: LeaderLayout = {
    center: 120,
    ringRadius: 94,
    lineStart: 120,
    labelRadius: 128,
    tail: 6,
    textGap: 2.5,
    innerSide: "right",
    keepOut: 42,
    minGap: 17,
    minShare: 3,
  };
  const ys = (labels: ReturnType<typeof leaderLabels>) => Object.fromEntries(labels.map((l) => [l.tokenId, l.text.y]));

  it("puts each label beside its slice's middle, on that slice's side", () => {
    // a holds 12→6 o'clock (middle at 3, right); b holds 6→12 (middle at 9, left).
    const labels = leaderLabels(
      [
        { tokenId: "a", pct: 50 },
        { tokenId: "b", pct: 50 },
      ],
      { ...layout, innerSide: "left", keepOut: 0 },
    );
    expect(labels.map((l) => l.side)).toEqual(["right", "left"]);
    expect(labels[0].dot.x).toBeCloseTo(214, 6);
    expect(labels[0].dot.y).toBeCloseTo(120, 6);
    expect(labels[0].text.x).toBeCloseTo(120 + 128 + 6 + 2.5, 6);
    expect(labels[1].text.x).toBeCloseTo(120 - 128 - 6 - 2.5, 6);
  });

  it("moves a label on the inner side out of the band kept for the move between donuts", () => {
    const labels = leaderLabels(
      [
        { tokenId: "a", pct: 50 },
        { tokenId: "b", pct: 50 },
      ],
      layout,
    );
    // a sits level with the middle on the inner (right) side: it goes down to the band's edge.
    expect(ys(labels).a).toBeCloseTo(120 + 42, 6);
    expect(ys(labels).b).toBeCloseTo(120, 6);
  });

  it("keeps labels on one side at least minGap apart", () => {
    const labels = leaderLabels(
      [
        { tokenId: "big", pct: 70 },
        { tokenId: "x", pct: 10 },
        { tokenId: "y", pct: 10 },
        { tokenId: "z", pct: 10 },
      ],
      layout,
    );
    const left = labels.filter((l) => l.side === "left").map((l) => l.text.y).sort((a, b) => a - b);
    expect(left.length).toBe(3);
    for (let i = 1; i < left.length; i++) expect(left[i] - left[i - 1]).toBeGreaterThanOrEqual(17 - 1e-9);
  });

  it("labels no slice thinner than minShare, and none with no share", () => {
    const labels = leaderLabels(
      [
        { tokenId: "a", pct: 97.5 },
        { tokenId: "thin", pct: 2.5 },
        { tokenId: "none", pct: 0 },
      ],
      layout,
    );
    expect(labels.map((l) => l.tokenId)).toEqual(["a"]);
  });

  it("drops a label pushed past the label circle instead of drawing it off the donut", () => {
    // Six thin slices from 12 o'clock all land on the inner side's top and stack upward from the
    // band: the two nearest it keep a place, the rest would end above the label circle.
    const shares = [
      ...Array.from({ length: 6 }, (_, i) => ({ tokenId: `t${i}`, pct: 3 })),
      { tokenId: "rest", pct: 82 },
    ];
    const labels = leaderLabels(shares, { ...layout, minGap: 40 });
    for (const l of labels) expect(Math.abs(l.text.y - 120)).toBeLessThanOrEqual(128);
    expect(labels.map((l) => l.tokenId)).toEqual(["t4", "t5", "rest"]);
  });

  it("returns nothing for an empty mix", () => {
    expect(leaderLabels([{ tokenId: "a", pct: 0 }], layout)).toEqual([]);
  });

  it("routes a pushed label's line along the label circle, never through the ring", () => {
    const [label] = leaderLabels(
      [
        { tokenId: "a", pct: 50 },
        { tokenId: "b", pct: 50 },
      ],
      layout,
    ).filter((l) => l.tokenId === "a");
    expect(label.path).toMatch(/A128 128 0 0 1 /);
  });
});
