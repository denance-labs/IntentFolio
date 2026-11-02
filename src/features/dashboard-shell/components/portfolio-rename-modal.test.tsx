// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { shellTranslations } from "../lib/translations";
import type { ValidationResult } from "../lib/portfolio-validation";
import { RealPortfolioMetaUnconfirmedError } from "@/features/vault/lib/run-real-portfolio-meta";

// 017-9c: a rename is signed, so the modal waits for it and says how it ended.

const h = vi.hoisted(() => ({ renamePortfolio: vi.fn() }));
vi.mock("../context/portfolio-context", () => ({
  usePortfolio: () => ({ renamePortfolio: h.renamePortfolio }),
}));
vi.mock("../context/language-context", () => ({ useLanguage: () => ({ lang: "en" }) }));
const limits = vi.hoisted(() => ({ loadPreflightLimits: vi.fn(async () => ({})) }));
vi.mock("@/features/vault/lib/vault-limits", () => limits);
const vault = vi.hoisted(() => ({ id: "" }));
vi.mock("@/features/wallet/config/network", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/wallet/config/network")>()),
  get VAULT_CONTRACT_ID() {
    return vault.id;
  },
}));

import { PortfolioRenameModal } from "./portfolio-rename-modal";

const t = shellTranslations.en;

function open(onClose = vi.fn()) {
  render(
    <PortfolioRenameModal portfolioId="p_1" currentName="Old" existingNames={["Old"]} onClose={onClose} />
  );
  return onClose;
}
const input = () => document.getElementById("rename-portfolio-name") as HTMLInputElement;
const save = () => screen.getByRole("button", { name: t.portfolioRenameAction });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vault.id = "";
});

describe("PortfolioRenameModal (017-9c)", () => {
  it("warms the vault's limits on open, and reads nothing without a vault", () => {
    open();
    expect(limits.loadPreflightLimits).not.toHaveBeenCalled();
    cleanup();
    vault.id = "intentfolio-vault.near";
    open();
    expect(limits.loadPreflightLimits).toHaveBeenCalledTimes(1);
  });

  it("saving the same name closes without asking for a signature", () => {
    const onClose = open();
    fireEvent.submit(input().form!);
    expect(h.renamePortfolio).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("renames with the trimmed name and closes once it resolves", async () => {
    h.renamePortfolio.mockResolvedValue(undefined);
    const onClose = open();
    fireEvent.change(input(), { target: { value: "  New  " } });
    await act(async () => {
      fireEvent.click(save());
    });
    expect(h.renamePortfolio).toHaveBeenCalledWith("p_1", "New");
    expect(onClose).toHaveBeenCalled();
  });

  it("a second submit while saving is ignored, and Escape cannot close it", async () => {
    let resolve!: () => void;
    h.renamePortfolio.mockReturnValue(new Promise<void>((r) => (resolve = r)));
    const onClose = open();
    fireEvent.change(input(), { target: { value: "New" } });
    act(() => {
      fireEvent.submit(input().form!);
      fireEvent.submit(input().form!);
    });
    expect(h.renamePortfolio).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: t.portfolioRenameSaving })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => resolve());
    expect(onClose).toHaveBeenCalled();
  });

  it("an unconfirmed rename says so and stays open", async () => {
    h.renamePortfolio.mockRejectedValue(new RealPortfolioMetaUnconfirmedError("timeout", null));
    const onClose = open();
    fireEvent.change(input(), { target: { value: "New" } });
    await act(async () => {
      fireEvent.click(save());
    });
    expect(screen.getByText(t.portfolioMetaUnconfirmed)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a cancelled signature reads as a cancel", async () => {
    h.renamePortfolio.mockRejectedValue(new Error("User rejected the request"));
    open();
    fireEvent.change(input(), { target: { value: "New" } });
    await act(async () => {
      fireEvent.click(save());
    });
    expect(screen.getByText(t.portfolioMetaCancelled)).toBeTruthy();
  });
});

// 022-G (D-458): the New Portfolio Draft's name is saved in this browser — no signature, no
// read of the vault — and checked as the draft's editor checks it.
describe("PortfolioRenameModal — the draft (022-G)", () => {
  function openDraft(
    onSave: Mock<(name: string) => ValidationResult> = vi.fn(() => ({ ok: true as const })),
    existingNames = ["Old"]
  ) {
    const onClose = vi.fn();
    render(<PortfolioRenameModal currentName="My mix" existingNames={existingNames} onSave={onSave} onClose={onClose} />);
    return { onSave, onClose };
  }

  it("reads no vault limits, even with a vault", () => {
    vault.id = "intentfolio-vault.near";
    openDraft();
    expect(limits.loadPreflightLimits).not.toHaveBeenCalled();
  });

  it("saves the trimmed name without a signature and closes", () => {
    const { onSave, onClose } = openDraft();
    fireEvent.change(input(), { target: { value: "  Renamed  " } });
    fireEvent.click(save());
    expect(onSave).toHaveBeenCalledWith("Renamed");
    expect(h.renamePortfolio).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("the same name closes without saving", () => {
    const { onSave, onClose } = openDraft();
    fireEvent.submit(input().form!);
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the name errors, and a portfolio's name is a duplicate in any case", () => {
    openDraft();
    fireEvent.change(input(), { target: { value: "old" } });
    expect(screen.getByText(t.portfolioNameDuplicate)).toBeTruthy();
    expect((save() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input(), { target: { value: "   " } });
    expect(screen.getByText(t.portfolioNameEmpty)).toBeTruthy();
  });

  it("a name a portfolio took since reads as a duplicate on open", () => {
    cleanup();
    openDraft(undefined, ["My mix"]);
    expect(screen.getByText(t.portfolioNameDuplicate)).toBeTruthy();
  });

  it("a refused save says why and stays open", () => {
    const { onClose } = openDraft(vi.fn(() => ({ ok: false, error: "nameDuplicate" })));
    fireEvent.change(input(), { target: { value: "Renamed" } });
    fireEvent.click(save());
    expect(screen.getAllByText(t.portfolioNameDuplicate).length).toBeGreaterThan(0);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a refusal with no name error falls back to the generic one", () => {
    openDraft(vi.fn(() => ({ ok: false, error: "" })));
    fireEvent.change(input(), { target: { value: "Renamed" } });
    fireEvent.click(save());
    expect(screen.getByText(t.portfolioMetaError)).toBeTruthy();
  });
});
