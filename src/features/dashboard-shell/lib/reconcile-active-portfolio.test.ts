import { describe, it, expect } from "vitest";
import { reconcileActivePortfolio } from "./reconcile-active-portfolio";

describe("reconcileActivePortfolio", () => {
  // THE regression. On every page load the side-table restores a selection before the vault
  // read resolves, so there is a window of (loading, portfolios=[], activeId=restored).
  // Treating that window as "no portfolios" wiped the restored id, and the fill-in below
  // then adopted portfolios[0] — so a reload silently moved the user to a portfolio they
  // never chose, and the next commit went there (observed on mainnet, 008.plan Phase 2).
  describe("while the vault read is in flight", () => {
    it("does NOT discard a restored selection just because the list is still empty", () => {
      expect(
        reconcileActivePortfolio({ loading: true, portfolioIds: [], activeId: "p_6" })
      ).toEqual({ change: false });
    });

    it("does not adopt a first portfolio from a partially-filled list either", () => {
      expect(
        reconcileActivePortfolio({ loading: true, portfolioIds: ["p_5"], activeId: null })
      ).toEqual({ change: false });
    });

    it("keeps the restored selection once the read lands", () => {
      expect(
        reconcileActivePortfolio({
          loading: false,
          portfolioIds: ["p_5", "p_6"],
          activeId: "p_6",
        })
      ).toEqual({ change: false });
    });
  });

  describe("once loaded", () => {
    it("adopts the first portfolio when nothing is selected", () => {
      expect(
        reconcileActivePortfolio({ loading: false, portfolioIds: ["p_5", "p_6"], activeId: null })
      ).toEqual({ change: true, next: "p_5" });
    });

    it("adopts the first portfolio when the selection no longer exists", () => {
      expect(
        reconcileActivePortfolio({
          loading: false,
          portfolioIds: ["p_5", "p_6"],
          activeId: "p_deleted",
        })
      ).toEqual({ change: true, next: "p_5" });
    });

    it("clears the selection when the account has no portfolios", () => {
      expect(
        reconcileActivePortfolio({ loading: false, portfolioIds: [], activeId: "p_6" })
      ).toEqual({ change: true, next: null });
    });

    it("reports no change when there is nothing selected and nothing to select", () => {
      expect(
        reconcileActivePortfolio({ loading: false, portfolioIds: [], activeId: null })
      ).toEqual({ change: false });
    });
  });
});
