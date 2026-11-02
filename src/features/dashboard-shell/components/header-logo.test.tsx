// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { HeaderLogo } from "./header-logo";

// jsdom has no layout: the slot's room is set per test, and the copies' natural widths are those
// measured at 390 ES (s248): "IntentFolio.app" 134 px, "IntentFolio" ~105 px.
let room = 0;
const widthOf = (el: HTMLElement) => (el.textContent?.includes(".app") ? 134 : 105);

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly cb: () => void) {}
      observe() {
        this.cb();
      }
      disconnect() {}
    }
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => room);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return widthOf(this);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// The visible logo: whatever is not inside the aria-hidden copies.
const visible = () => screen.getByRole("link");

describe("HeaderLogo (022-J, D-460)", () => {
  it.each([
    [200, "IntentFolio.app", false],
    [134, "IntentFolio.app", false],
    [120, "IntentFolio", false],
    [60, "IntentFolio.app", true],
  ])("with %i px it shows %s (icon: %s)", (width, text, icon) => {
    room = width;
    render(<HeaderLogo home />);
    expect(visible().textContent).toBe(text);
    expect(visible().querySelector("svg") !== null).toBe(icon);
  });

  it("signed in, the logo is not a link", () => {
    room = 200;
    render(<HeaderLogo home={false} />);
    expect(screen.queryByRole("link")).toBeNull();
  });
});
