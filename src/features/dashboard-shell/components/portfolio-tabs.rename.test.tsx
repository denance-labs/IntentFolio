// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

// 017-9c: the "···" (Rename) shows on real portfolios as on mock ones — the vault signs it.

vi.mock("../context/language-context", () => ({ useLanguage: () => ({ lang: "en", setLang: vi.fn() }) }));
vi.mock("../hooks/use-fundable-general-balance", () => ({
  useFundableGeneralBalance: () => ({ status: "known", fundable: false, tokenIds: [], usd: 0 }),
}));
vi.mock("../context/portfolio-context", () => ({
  usePortfolio: () => ({
    portfolios: [
      { id: "p_000000000001", name: "Real", isReal: true },
      { id: "mock-1", name: "Mock", isReal: false },
    ],
    activePortfolioId: "p_000000000001",
    activePortfolio: { id: "p_000000000001", name: "Real", isReal: true },
    setActivePortfolioId: vi.fn(),
  }),
}));
vi.mock("./portfolio-tab-menu", () => ({
  PortfolioTabMenu: ({
    portfolioId,
    onRename,
    onDelete,
  }: {
    portfolioId: string;
    onRename: () => void;
    onDelete?: () => void;
  }) => (
    <>
      <button type="button" data-testid={`menu-${portfolioId}`} onClick={onRename} />
      {onDelete && <button type="button" data-testid={`delete-${portfolioId}`} onClick={onDelete} />}
    </>
  ),
}));
const deleteModal = vi.hoisted(() => ({ props: null as null | Record<string, unknown> }));
vi.mock("./portfolio-delete-modal", () => ({
  PortfolioDeleteModal: (props: Record<string, unknown>) => {
    deleteModal.props = props;
    return null;
  },
}));
const modal = vi.hoisted(() => ({ props: null as null | Record<string, unknown> }));
vi.mock("./portfolio-rename-modal", () => ({
  PortfolioRenameModal: (props: Record<string, unknown>) => {
    modal.props = props;
    return null;
  },
}));

import { PortfolioTabs } from "./portfolio-tabs";

afterEach(() => {
  cleanup();
  modal.props = null;
  deleteModal.props = null;
});

// 027 A-9a: "Delete portfolio" lives in each portfolio's menu, and only there; not the draft's.
describe("PortfolioTabs — Delete from the menu (027 A-9a)", () => {
  it("each portfolio's menu opens the delete dialog for THAT portfolio", () => {
    render(<PortfolioTabs />);
    fireEvent.click(within(screen.getByRole("tablist")).getByTestId("delete-mock-1"));
    expect(deleteModal.props).toMatchObject({ portfolioId: "mock-1" });
  });

  it("the draft's menu has its own delete (D-560)", () => {
    render(
      <PortfolioTabs draftTab={{ name: "My mix", active: true, onSelect: vi.fn(), rename: vi.fn(), discard: vi.fn() }} />
    );
    expect(screen.queryAllByTestId("delete-*new-portfolio-draft").length).toBeGreaterThan(0);
  });
});

describe("PortfolioTabs — Rename on real portfolios (017-9c)", () => {
  it("a real portfolio gets its menu, like a mock one", () => {
    render(<PortfolioTabs />);
    expect(screen.queryAllByTestId("menu-p_000000000001").length).toBeGreaterThan(0);
    expect(screen.queryAllByTestId("menu-mock-1").length).toBeGreaterThan(0);
  });
});

// 022-G (D-458): the draft's tab gets the same "···", with only Rename, saved unsigned. On mobile
// it stands next to the select while the draft is the one on screen.
describe("PortfolioTabs — Rename on the draft's tab (022-G)", () => {
  const DRAFT_MENU = "menu-*new-portfolio-draft";
  const draftTab = (active: boolean, rename = vi.fn(() => ({ ok: true as const }))) => ({
    name: "My mix",
    active,
    onSelect: vi.fn(),
    rename,
    discard: vi.fn(),
  });

  it("on desktop the draft's tab has its menu; on mobile only while the draft is on screen", () => {
    render(<PortfolioTabs draftTab={draftTab(false)} />);
    expect(within(screen.getByRole("tablist")).getAllByTestId(DRAFT_MENU)).toHaveLength(1);
    expect(screen.getAllByTestId(DRAFT_MENU)).toHaveLength(1);
    cleanup();

    render(<PortfolioTabs draftTab={draftTab(true)} />);
    // Desktop's and mobile's; the mobile one stands in for the portfolio's.
    expect(screen.getAllByTestId(DRAFT_MENU)).toHaveLength(2);
    expect(within(screen.getByRole("tablist")).queryAllByTestId("menu-p_000000000001")).toHaveLength(1);
    expect(screen.getAllByTestId("menu-p_000000000001")).toHaveLength(1);
  });

  it("Rename opens the unsigned modal on the draft, checked against the account's portfolios", () => {
    const rename = vi.fn(() => ({ ok: true as const }));
    render(<PortfolioTabs draftTab={draftTab(true, rename)} />);
    fireEvent.click(screen.getAllByTestId(DRAFT_MENU)[1]);

    expect(modal.props).toMatchObject({ currentName: "My mix", existingNames: ["Real", "Mock"] });
    expect(modal.props).not.toHaveProperty("portfolioId");
    (modal.props!.onSave as (name: string) => unknown)("Renamed");
    expect(rename).toHaveBeenCalledWith("Renamed", ["Real", "Mock"]);
  });

  it("signed out, against no names, as in the draft's editor", () => {
    const rename = vi.fn(() => ({ ok: true as const }));
    render(<PortfolioTabs signedOut draftTab={draftTab(false, rename)} />);
    fireEvent.click(screen.getByTestId(DRAFT_MENU));

    expect(modal.props).toMatchObject({ existingNames: [] });
    (modal.props!.onSave as (name: string) => unknown)("Renamed");
    expect(rename).toHaveBeenCalledWith("Renamed", []);
  });
});
