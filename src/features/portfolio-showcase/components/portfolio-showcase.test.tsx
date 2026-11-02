// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { PortfolioShowcase } from "./portfolio-showcase";
import type { ShowcaseDayChange, ShowcaseLabels, ShowcaseToken } from "../types";

// A token lit by a click stays lit ("pinned") only for touch, pen and keyboard: a mouse follows by
// hover, so its click must not leave a token lit after the pointer leaves. A tap off every token
// lets the pinned one go.

const labels = new Proxy({}, { get: (_, key) => String(key) }) as ShowcaseLabels;

function token(tokenId: string, currentPct: number, targetPct: number, color: string): ShowcaseToken {
  return {
    tokenId,
    label: tokenId.toUpperCase(),
    name: tokenId,
    symbol: tokenId.toUpperCase(),
    color,
    currentPct,
    targetPct,
    currentUsd: currentPct,
    targetUsd: targetPct,
    bandState: "inside",
  };
}

const TOKENS = [token("near", 60, 50, "#22d3ee"), token("usdc", 40, 50, "#a78bfa")];

function renderShowcase(tokens = TOKENS, totalUsd = 100) {
  const view = render(
    <PortfolioShowcase
      tokens={tokens}
      totalUsd={totalUsd}
      earnings={{ status: "loading" }}
      networks={[]}
      createdAt={null}
      todayDay="2026-10-23"
      lang="en"
      labels={labels}
    />,
  );
  // The desktop legend chips: the first button of each token (the phone list repeats them).
  const chip = (label: string) =>
    Array.from(view.container.querySelectorAll<HTMLButtonElement>("button[data-showcase-token]")).find((b) =>
      b.textContent?.startsWith(label),
    )!;
  return { ...view, chip };
}

function click(el: Element, pointerType: string) {
  fireEvent(el, new PointerEvent("click", { bubbles: true, cancelable: true, pointerType }));
}

beforeEach(() => {
  window.matchMedia = ((query: string) => ({ matches: false, media: query })) as unknown as typeof window.matchMedia;
});

afterEach(cleanup);

describe("PortfolioShowcase pinning", () => {
  it("does not pin a token on a mouse click", () => {
    const { chip } = renderShowcase();
    click(chip("NEAR"), "mouse");
    expect(chip("NEAR").getAttribute("aria-pressed")).toBe("false");
  });

  it("pins a token on a tap and lets it go on a tap outside", () => {
    const { chip } = renderShowcase();
    click(chip("NEAR"), "touch");
    expect(chip("NEAR").getAttribute("aria-pressed")).toBe("true");

    click(document.body, "touch");
    expect(chip("NEAR").getAttribute("aria-pressed")).toBe("false");
  });

  it("moves the pin to another token on a tap, not letting it go", () => {
    const { chip } = renderShowcase();
    click(chip("NEAR"), "touch");
    click(chip("USDC"), "touch");
    expect(chip("NEAR").getAttribute("aria-pressed")).toBe("false");
    expect(chip("USDC").getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps the pin through a scroll swipe, which fires no click", () => {
    const { chip } = renderShowcase();
    click(chip("NEAR"), "touch");
    fireEvent.pointerDown(document.body, { pointerType: "touch" });
    fireEvent.pointerUp(document.body, { pointerType: "touch" });
    expect(chip("NEAR").getAttribute("aria-pressed")).toBe("true");
  });

  it("still pins from the keyboard", () => {
    const { chip } = renderShowcase();
    fireEvent.click(chip("NEAR"));
    expect(chip("NEAR").getAttribute("aria-pressed")).toBe("true");
  });
});

describe("PortfolioShowcase edge states", () => {
  it("names a lone target token instead of counting '1 of 1'", () => {
    const { container } = renderShowcase([token("near", 100, 100, "#22d3ee")]);
    expect(container.textContent).toContain("oneOnTarget");
    expect(container.textContent).not.toContain("onTargetCount");
  });

  it("drops the follow hint when there is a single token", () => {
    const { container } = renderShowcase([token("near", 100, 100, "#22d3ee")]);
    expect(container.textContent).not.toContain("hoverHint");
  });

  it("opens the phone's donut on the target while nothing is held", () => {
    const empty = [token("near", 0, 60, "#22d3ee"), token("usdc", 0, 40, "#a78bfa")];
    const { getByRole } = renderShowcase(empty, 0);
    expect(getByRole("button", { name: "target", pressed: true })).toBeTruthy();
  });

  it("opens the phone's donut on now once something is held", () => {
    const { getByRole } = renderShowcase();
    expect(getByRole("button", { name: "now", pressed: true })).toBeTruthy();
  });
});

describe("PortfolioShowcase labels beside the donuts", () => {
  const labelTexts = (container: HTMLElement) =>
    Array.from(container.querySelectorAll("svg g[aria-hidden='true'] text")).map((t) => t.textContent);

  it("labels each slice with its share and symbol, in both donuts", () => {
    const { container } = renderShowcase();
    // Two desktop donuts × two tokens × (share + symbol).
    expect(labelTexts(container)).toEqual(["60.0%", "NEAR", "40.0%", "USDC", "50.0%", "NEAR", "50.0%", "USDC"]);
  });

  it("adds the network to a symbol another token shares", () => {
    const eth = (id: string, network: string, pct: number) => ({ ...token(id, pct, pct, "#84cc16"), symbol: "ETH", network });
    const { container } = renderShowcase([eth("eth-near", "NEAR", 60), eth("eth-eth", "Ethereum", 40)]);
    expect(labelTexts(container)).toContain("ETH · NEAR");
    expect(labelTexts(container)).toContain("ETH · Ethereum");
  });

  it("lights a token from its label, as a chip does", () => {
    const { container, chip } = renderShowcase();
    const label = Array.from(container.querySelectorAll("svg g[data-showcase-token]")).find((g) => g.textContent?.includes("USDC"))!;
    fireEvent.pointerEnter(label, { pointerType: "mouse" });
    expect(chip("USDC").getAttribute("aria-pressed")).toBe("true");
  });
});

describe("PortfolioShowcase chips beside the labels", () => {
  const xlChips = (container: HTMLElement) =>
    Array.from(container.querySelectorAll("[data-unlabeled-legend] button")).map((b) => b.textContent);

  it("keeps a chip only for a token neither donut could label", () => {
    const { container } = renderShowcase([
      token("near", 60, 60, "#22d3ee"),
      token("usdc", 38, 40, "#a78bfa"),
      token("dust", 2, 0, "#f59e0b"),
    ]);
    expect(xlChips(container)).toEqual(["DUST2.0% → 0%"]);
    expect(container.querySelector("[data-unlabeled-legend]")?.textContent).toMatch(/^underShare/);
  });

  it("names the row plainly when a token lost its label for room, not for its size", () => {
    // Six 4% slices from 12 o'clock crowd the inner side of Current, and their targets are 0.
    const crowd = Array.from({ length: 6 }, (_, i) => token(`t${i}`, 4, 0, "#f59e0b"));
    const { container } = renderShowcase([...crowd, token("rest", 76, 100, "#22d3ee")]);
    const row = container.querySelector("[data-unlabeled-legend]");
    expect(row).not.toBeNull();
    expect(row?.textContent).toMatch(/^alsoInPortfolio/);
  });

  it("shows no extra chip row when every token has a label", () => {
    const { container } = renderShowcase();
    expect(container.querySelector("[data-unlabeled-legend]")).toBeNull();
  });

  it("counts a label in either donut: a thin share now with a real target needs no chip", () => {
    const { container } = renderShowcase([token("near", 98, 90, "#22d3ee"), token("new", 2, 10, "#a78bfa")]);
    expect(container.querySelector("[data-unlabeled-legend]")).toBeNull();
  });
});

describe("PortfolioShowcase change today (D-523)", () => {
  const renderChange = (dayChange: ShowcaseDayChange | null) =>
    render(
      <PortfolioShowcase
        tokens={TOKENS}
        totalUsd={100}
        dayChange={dayChange}
        earnings={{ status: "loading" }}
        networks={[]}
        createdAt={null}
        todayDay="2026-10-23"
        lang="en"
        labels={labels}
      />,
    );
  const line = (container: HTMLElement) =>
    Array.from(container.querySelectorAll("p")).find((p) => p.textContent?.includes("dayChangeToday"));
  const SINCE = Date.UTC(2026, 9, 23, 0, 5);

  it("shows a rise in green with an up arrow", () => {
    const { container } = renderChange({ usd: 0.42, pct: 3.214, since: SINCE });
    expect(line(container)?.textContent).toMatch(/^▲\+\$0\.42 \(\+3\.21%\)dayChangeToday/);
    expect(line(container)?.querySelector(".text-emerald-400")).not.toBeNull();
  });

  it("shows a fall in red with a down arrow and a minus sign", () => {
    const { container } = renderChange({ usd: -1.5, pct: -2, since: SINCE });
    expect(line(container)?.textContent).toMatch(/^▼−\$1\.50 \(−2\.00%\)/);
    expect(line(container)?.querySelector(".text-rose-400")).not.toBeNull();
  });

  it("shows a move that rounds to nothing without an arrow, in grey", () => {
    const { container } = renderChange({ usd: 0.0001, pct: 0.001, since: SINCE });
    expect(line(container)?.textContent).toMatch(/^\$0\.00 \(0\.00%\)/);
    expect(line(container)?.querySelector(".text-slate-400")).not.toBeNull();
  });

  it("draws nothing without a change", () => {
    expect(line(renderChange(null).container)).toBeUndefined();
  });
});
