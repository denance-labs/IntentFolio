// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, within } from "@testing-library/react";
import { LanguageProvider } from "../context/language-context";
import { shellTranslations } from "../lib/translations";
import { OnboardingSteps } from "./onboarding-steps";

afterEach(cleanup);

function steps(current?: 1 | 2) {
  const { container } = render(
    <LanguageProvider>
      <OnboardingSteps current={current} />
    </LanguageProvider>
  );
  return Array.from(container.querySelectorAll("li"));
}

describe("OnboardingSteps", () => {
  it("marks deposit as the next step on an empty account", () => {
    const items = steps(1);
    expect(items).toHaveLength(4);
    expect(items[0].getAttribute("aria-current")).toBe("step");
    expect(items[0].textContent).toContain("next step");
    expect(items[1].hasAttribute("aria-current")).toBe(false);
  });

  it("marks deposit done and building the portfolio next once funds arrived", () => {
    const items = steps(2);
    expect(items[0].textContent).toContain("done");
    expect(items[1].getAttribute("aria-current")).toBe("step");
    // Steps 3 and 4 are what happens without the user: never current, never done.
    for (const item of items.slice(2)) {
      expect(item.hasAttribute("aria-current")).toBe(false);
      expect(item.textContent).not.toMatch(/done|next step/);
    }
  });

  // The welcome (016 block 2.5) describes the model, so no step may claim to be next or done.
  it("without a current step marks none", () => {
    const items = steps();
    expect(items).toHaveLength(4);
    for (const item of items) {
      expect(item.hasAttribute("aria-current")).toBe(false);
      expect(item.textContent).not.toMatch(/done|next step/);
    }
  });

  // D-399 + 022-A: the welcome and a new account's My Account start building, so their steps
  // read build → deposit; the funded account with no portfolio keeps deposit first (done).
  it("build-first reads build → deposit and can mark building as next; the account's order deposits first", () => {
    const { container } = render(
      <LanguageProvider>
        <OnboardingSteps variant="build-first" current={1} />
        <OnboardingSteps current={2} />
      </LanguageProvider>
    );
    const [buildFirst, account] = Array.from(container.querySelectorAll("ol")).map((ol) =>
      Array.from(ol.querySelectorAll("[data-step-title]")).map((p) => p.textContent?.replace(/\s*\(.*\)$/, ""))
    );
    expect(buildFirst).toEqual(["1.Build your first portfolio", "2.Deposit", "3.It moves toward your targets", "4.Earn along the way"]);
    expect(account).toEqual(["1.Deposit", "2.Build your first portfolio", "3.It moves toward your targets", "4.Earn along the way"]);
    const first = container.querySelector("ol li")!;
    expect(first.getAttribute("aria-current")).toBe("step");
    // 022-I (D-459): only the build-first order says building can come before depositing; in
    // the account's order the deposit is already done, so it keeps the plain line.
    const [buildFirstOl, accountOl] = Array.from(container.querySelectorAll("ol"));
    const buildFirstBuild = buildFirstOl.querySelectorAll("li")[0].textContent;
    const accountBuild = accountOl.querySelectorAll("li")[1].textContent;
    expect(buildFirstBuild).toContain(shellTranslations.en.onboardingBuildFirstBody);
    expect(accountBuild).toContain(shellTranslations.en.onboardingStep2Body);
    expect(accountBuild).not.toContain(shellTranslations.en.onboardingBuildFirstBody);
  });

  // 022-A: the welcome reopened by someone who already has portfolios is not about their first.
  it("drops \"first\" from the build step when it is not the first portfolio", () => {
    const { container } = render(
      <LanguageProvider>
        <OnboardingSteps variant="build-first" firstPortfolio={false} />
      </LanguageProvider>
    );
    expect(container.querySelector("[data-step-title]")!.textContent).toBe("1.Build your portfolio");
  });

  it("two on one screen do not share a heading id", () => {
    const { container } = render(
      <LanguageProvider>
        <OnboardingSteps current={1} />
        <OnboardingSteps />
      </LanguageProvider>
    );
    const ids = Array.from(container.querySelectorAll("h3")).map((h) => h.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const section of Array.from(container.querySelectorAll("section"))) {
      expect(document.getElementById(section.getAttribute("aria-labelledby")!)).toBeTruthy();
    }
  });

  // 029 B-19: every step is clickable. Building and depositing run the screen's actions — a
  // step marked done included — and steps 3 and 4 open the guide's section in a new tab.
  it("building and depositing run the screen's actions; steps 3 and 4 open the guide in a new tab", () => {
    const onBuild = vi.fn();
    const onDeposit = vi.fn();
    const { container } = render(
      <LanguageProvider>
        <OnboardingSteps current={2} onBuild={onBuild} onDeposit={onDeposit} />
      </LanguageProvider>
    );
    const items = Array.from(container.querySelectorAll("li"));
    // Deposit is done here and still deposits again.
    fireEvent.click(within(items[0]).getByRole("button"));
    expect(onDeposit).toHaveBeenCalledTimes(1);
    fireEvent.click(within(items[1]).getByRole("button"));
    expect(onBuild).toHaveBeenCalledTimes(1);
    // The done / next-step mark stays in the accessible name.
    expect(within(items[0]).getByRole("button").textContent).toContain("done");
    const [moves, earn] = items.slice(2).map((li) => within(li).getByRole("link"));
    expect(moves.getAttribute("href")).toBe("/learn#rebalancing");
    expect(earn.getAttribute("href")).toBe("/learn#tips");
    for (const link of [moves, earn]) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.textContent).toContain(shellTranslations.en.opensInNewTab);
    }
  });

  it("a step whose action the screen does not pass stays plain", () => {
    const { container } = render(
      <LanguageProvider>
        <OnboardingSteps variant="build-first" onBuild={vi.fn()} />
      </LanguageProvider>
    );
    const items = Array.from(container.querySelectorAll("li"));
    expect(within(items[0]).getByRole("button")).toBeTruthy();
    expect(within(items[1]).queryByRole("button")).toBeNull();
    expect(within(items[1]).queryByRole("link")).toBeNull();
  });
});
