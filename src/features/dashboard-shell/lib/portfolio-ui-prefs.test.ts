// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  getActivePortfolioId,
  getDashboardSection,
  getSignedOutSection,
  setActivePortfolioId,
  setDashboardSection,
  setSignedOutSection,
} from "./portfolio-ui-prefs";

describe("portfolio UI preferences", () => {
  beforeEach(() => localStorage.clear());

  it("restores My Account instead of falling through to a portfolio after reload", () => {
    setDashboardSection("alice.near", "account");

    expect(getDashboardSection("alice.near")).toBe("account");
  });

  // 019-4: the New Portfolio Draft's tab is a section too.
  it("restores the draft's tab after reload", () => {
    setDashboardSection("alice.near", "draft");

    expect(getDashboardSection("alice.near")).toBe("draft");
  });

  it("an unknown stored section falls back to the portfolio view", () => {
    localStorage.setItem("portfolio.ui-prefs.v1", JSON.stringify({ active: {}, section: { "alice.near": "settings" } }));

    expect(getDashboardSection("alice.near")).toBe("portfolio");
  });

  it("restores the exact portfolio and its section for each account", () => {
    setActivePortfolioId("alice.near", "p_2");
    setDashboardSection("alice.near", "portfolio");
    setActivePortfolioId("bob.near", "p_7");
    setDashboardSection("bob.near", "account");

    expect(getDashboardSection("alice.near")).toBe("portfolio");
    expect(getActivePortfolioId("alice.near")).toBe("p_2");
    expect(getDashboardSection("bob.near")).toBe("account");
    expect(getActivePortfolioId("bob.near")).toBe("p_7");
  });

  it("defaults old sessions without a section preference to the existing portfolio view", () => {
    localStorage.setItem(
      "portfolio.ui-prefs.v1",
      JSON.stringify({ tolerance: {}, active: { "alice.near": "p_2" } }),
    );

    expect(getDashboardSection("alice.near")).toBe("portfolio");
    expect(getActivePortfolioId("alice.near")).toBe("p_2");
  });

  // 022-B: signed out, the section survives a reload too, apart from every account's.
  it("keeps the section signed out, apart from the accounts'", () => {
    expect(getSignedOutSection()).toBeNull();
    setDashboardSection("alice.near", "portfolio");
    setSignedOutSection("account");

    expect(getSignedOutSection()).toBe("account");
    expect(getDashboardSection("alice.near")).toBe("portfolio");
    setSignedOutSection("draft");
    expect(getSignedOutSection()).toBe("draft");
  });

  it("an unknown section stored signed out reads as none chosen", () => {
    localStorage.setItem("portfolio.ui-prefs.v1", JSON.stringify({ active: {}, section: { "*anonymous": "portfolio" } }));

    expect(getSignedOutSection()).toBeNull();
  });
});
