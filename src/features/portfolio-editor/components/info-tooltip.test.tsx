// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { InfoTooltip } from "./portfolio-primitives";

// D-574: a closed bubble used to stay in the layout at opacity 0 and widen the page at 320 px.
describe("InfoTooltip", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("draws no bubble while closed", () => {
    render(<InfoTooltip label="What is this?">Explained</InfoTooltip>);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(screen.queryByText("Explained")).toBeNull();
  });

  it("opens on hover and on focus, and closes again", () => {
    render(<InfoTooltip label="What is this?">Explained</InfoTooltip>);
    const button = screen.getByRole("button", { name: "What is this?" });

    fireEvent.mouseEnter(button);
    expect(screen.getByRole("tooltip").textContent).toBe("Explained");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    fireEvent.mouseLeave(button);
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.focus(button);
    expect(screen.getByRole("tooltip")).not.toBeNull();
    fireEvent.blur(button);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("nudges an open bubble back inside a narrow viewport", () => {
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(320);
    render(<InfoTooltip label="What is this?">Explained</InfoTooltip>);
    const button = screen.getByRole("button", { name: "What is this?" });
    // A "?" whose center sits at x = 195, as the Overview's "today" one did at 320 px.
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({ left: 187, width: 16 } as DOMRect);

    fireEvent.mouseEnter(button);
    // Centered, the 256 px bubble would end at 323; fitted, it ends at 312 (8 px from the edge).
    expect(screen.getByRole("tooltip").style.transform).toBe("translateX(calc(-50% + -11px))");
  });

  it("leaves a bubble that fits centered on its button", () => {
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(1440);
    render(<InfoTooltip label="What is this?">Explained</InfoTooltip>);
    const button = screen.getByRole("button", { name: "What is this?" });
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({ left: 600, width: 16 } as DOMRect);

    fireEvent.mouseEnter(button);
    expect(screen.getByRole("tooltip").style.transform).toBe("translateX(calc(-50% + 0px))");
  });
});
