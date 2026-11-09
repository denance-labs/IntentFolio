// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { AppCta } from "./app-cta";

const baseProps = {
  href: "/dashboard" as const,
  label: "Open app",
  soonBadge: "Soon",
  soonSrLabel: "coming soon",
  className: "cta-class",
};

describe("AppCta", () => {
  it("renders a real link to /dashboard when not coming-soon", () => {
    const { container } = render(<AppCta {...baseProps} comingSoon={false} />);
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/dashboard");
    expect(link?.textContent).toBe("Open app");
  });

  it("renders a disabled, non-navigable control with the soon badge when coming-soon", () => {
    const { container } = render(<AppCta {...baseProps} comingSoon />);
    expect(container.querySelector("a")).toBeNull();
    const disabled = container.querySelector('[data-testid="app-cta-disabled"]');
    expect(disabled?.getAttribute("aria-disabled")).toBe("true");
    expect(container.textContent).toContain("Soon");
  });

  it("gives screen readers the soon label alongside the visible label", () => {
    const { container } = render(<AppCta {...baseProps} comingSoon />);
    const srText = container.querySelector(".sr-only")?.textContent?.trim();
    expect(srText).toBe("(coming soon)");
  });
});
