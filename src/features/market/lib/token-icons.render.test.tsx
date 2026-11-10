// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { ChainIcon, TokenIcon } from "./token-icons";

const fills = (container: HTMLElement) =>
  [...container.querySelectorAll("[fill]")].map((el) => el.getAttribute("fill"));

describe("black brand marks", () => {
  it("draws Stellar's chain mark in the ink color, not black", () => {
    const { container } = render(<ChainIcon chainId="stellar:mainnet" size={40} className="shrink-0" />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("class")).toContain("text-slate-100");
    expect(svg?.getAttribute("class")).toContain("shrink-0");
    expect(fills(container)).not.toContain("#000");
    expect(fills(container)).toContain("currentColor");
  });

  it("does the same for the XLM token mark", () => {
    const { container } = render(<TokenIcon symbol="XLM" />);
    expect(fills(container)).not.toContain("#000");
    expect(fills(container)).toContain("currentColor");
  });

  it("leaves other variants and other marks as they are", () => {
    const background = render(<ChainIcon chainId="stellar:mainnet" variant="background" />);
    expect(fills(background.container)).toContain("#000");
    const near = render(<ChainIcon chainId="near:mainnet" />);
    expect(fills(near.container)).toContain("#00EC97");
  });
});
