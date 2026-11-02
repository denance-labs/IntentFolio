// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { shellTranslations } from "../lib/translations";
import { VaultCommitRevertedError } from "@/features/vault/lib/vault-errors";
import { RealPortfolioMetaUnconfirmedError } from "@/features/vault/lib/run-real-portfolio-meta";

const h = vi.hoisted(() => ({
  deletePortfolio: vi.fn(),
  setDraftState: vi.fn(),
  portfolio: null as null | Record<string, unknown>,
  pending: [] as unknown[] | undefined,
}));
vi.mock("../context/portfolio-context", () => ({
  usePortfolio: () => ({
    portfolios: h.portfolio ? [h.portfolio] : [],
    deletePortfolio: h.deletePortfolio,
    setDraftState: h.setDraftState,
  }),
}));
vi.mock("../context/language-context", () => ({ useLanguage: () => ({ lang: "en" }) }));
vi.mock("@/features/login-wallet", () => ({ useLoginWallet: () => ({ intentsAccountId: "alice.near" }) }));
vi.mock("@/features/vault/hooks/use-pending-allocates", () => ({
  usePendingAllocates: () => ({ pending: h.pending, isFetching: false }),
}));
vi.mock("@/features/intents-account/mock-contract", () => ({
  mockContract: { subscribe: () => () => {}, getVersion: () => 0, getPendingUnallocations: () => [] },
}));

import { PortfolioDeleteModal } from "./portfolio-delete-modal";

const t = shellTranslations.en;
const PID = "p_00000000002a";
const EMPTY = { id: PID, name: "Growth", isReal: true, deposits: {}, holdsNothingOnChain: true };

beforeEach(() => {
  h.portfolio = EMPTY;
  h.pending = [];
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const confirmButton = () => screen.getByRole("button", { name: t.portfolioDeleteConfirmAction });

describe("PortfolioDeleteModal — what stands in the way (027 A-9a)", () => {
  it("a funded portfolio: says to move the funds first, and offers no delete", () => {
    h.portfolio = { ...EMPTY, holdsNothingOnChain: false };
    const onClose = vi.fn();
    render(<PortfolioDeleteModal portfolioId={PID} onClose={onClose} />);
    expect(screen.getByText(t.portfolioDeleteFunded)).toBeTruthy();
    expect(screen.queryByRole("button", { name: t.portfolioDeleteConfirmAction })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: t.portfolioDeleteClose }));
    expect(onClose).toHaveBeenCalled();
  });

  it("a credit on its way to it: says to wait", () => {
    h.pending = [{ id: "r", op: "allocate_into", portfolioId: PID }];
    render(<PortfolioDeleteModal portfolioId={PID} onClose={vi.fn()} />);
    expect(screen.getByText(t.portfolioDeleteIncoming)).toBeTruthy();
    expect(screen.queryByRole("button", { name: t.portfolioDeleteConfirmAction })).toBeNull();
  });

  it("still loading: checking, no delete", () => {
    h.pending = undefined;
    render(<PortfolioDeleteModal portfolioId={PID} onClose={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toBe(t.portfolioDeleteChecking);
    expect(screen.queryByRole("button", { name: t.portfolioDeleteConfirmAction })).toBeNull();
  });
});

describe("PortfolioDeleteModal — the delete itself", () => {
  it("an empty portfolio: warns it is final, then signs and closes", async () => {
    h.deletePortfolio.mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<PortfolioDeleteModal portfolioId={PID} onClose={onClose} />);
    expect(screen.getByText(t.portfolioDeleteTitle.replace("{name}", "Growth"))).toBeTruthy();
    expect(screen.getByText(t.portfolioDeleteImmediate)).toBeTruthy();
    expect(h.deletePortfolio).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(confirmButton());
    });
    expect(h.deletePortfolio).toHaveBeenCalledWith(PID);
    expect(onClose).toHaveBeenCalled();
    // A draft open on the deleted portfolio goes with it; any other one stays.
    const drop = h.setDraftState.mock.calls[0][0] as (d: { id: string } | null) => unknown;
    expect(drop({ id: PID })).toBeNull();
    expect(drop({ id: "other" })).toEqual({ id: "other" });
  });

  it("Cancel closes without deleting", () => {
    const onClose = vi.fn();
    render(<PortfolioDeleteModal portfolioId={PID} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: t.cancel }));
    expect(onClose).toHaveBeenCalled();
    expect(h.deletePortfolio).not.toHaveBeenCalled();
  });

  it("says why when the vault refuses, and stays open", async () => {
    h.deletePortfolio.mockRejectedValue(
      new VaultCommitRevertedError("Smart contract panicked: E_PORTFOLIO_NOT_EMPTY")
    );
    const onClose = vi.fn();
    render(<PortfolioDeleteModal portfolioId={PID} onClose={onClose} />);
    await act(async () => {
      fireEvent.click(confirmButton());
    });
    expect(screen.getByRole("alert").textContent).toBe(t.portfolioDeleteNotEmpty);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a cancelled signature reads as a cancel, not as a refusal", async () => {
    h.deletePortfolio.mockRejectedValue(new Error("User rejected the request"));
    render(<PortfolioDeleteModal portfolioId={PID} onClose={vi.fn()} />);
    await act(async () => {
      fireEvent.click(confirmButton());
    });
    expect(screen.getByRole("alert").textContent).toBe(t.portfolioMetaCancelled);
  });

  it("unconfirmed: says so, keeps the confirmation while the list re-reads, and a retry can finish", async () => {
    h.deletePortfolio
      .mockRejectedValueOnce(new RealPortfolioMetaUnconfirmedError("timeout", null))
      .mockResolvedValueOnce(undefined);
    const onClose = vi.fn();
    const { rerender } = render(<PortfolioDeleteModal portfolioId={PID} onClose={onClose} />);
    await act(async () => {
      fireEvent.click(confirmButton());
    });
    expect(screen.getByRole("alert").textContent).toBe(t.portfolioMetaUnconfirmed);
    // The re-read blinks the inputs: the confirmation and its error stay.
    h.pending = undefined;
    rerender(<PortfolioDeleteModal portfolioId={PID} onClose={onClose} />);
    expect(screen.getByRole("alert").textContent).toBe(t.portfolioMetaUnconfirmed);
    await act(async () => {
      fireEvent.click(confirmButton());
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a double click on Delete deletes once", async () => {
    let resolve!: () => void;
    h.deletePortfolio.mockReturnValue(new Promise<void>((r) => (resolve = r)));
    render(<PortfolioDeleteModal portfolioId={PID} onClose={vi.fn()} />);
    const confirm = confirmButton();
    act(() => {
      confirm.click();
      confirm.click();
    });
    expect(h.deletePortfolio).toHaveBeenCalledTimes(1);
    await act(async () => resolve());
  });
});
