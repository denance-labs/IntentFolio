// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RealAllocateUnconfirmedError } from "@/features/vault/lib/run-real-allocate";
import { translations as editorTranslations } from "@/features/portfolio-editor/lib/translations";
import { readNewPortfolioDraft, saveNewPortfolioDraft } from "../lib/new-portfolio-draft";
import { shellTranslations } from "../lib/translations";

// D-397 (plan 041). The walks of the plan with the real flow, editor and funds screen together:
// each one's own tests mock the others, so only here is the swap between them exercised.

const ACCOUNT = "alice.near";
const state = vi.hoisted(() => ({
  create: vi.fn(),
  fundable: { status: "known", fundable: true, tokenIds: ["near"], usd: 15 } as Record<string, unknown>,
}));

vi.mock("@/features/login-wallet", () => ({
  useLoginWallet: () => ({ connection: { address: "alice.near" }, intentsAccountId: "alice.near" }),
}));
vi.mock("@/features/vault/hooks/use-pending-allocates", () => ({
  usePendingAllocates: () => ({ pending: [], isFetching: false }),
}));
vi.mock("@/features/vault/hooks/use-vault-precheck", () => ({ useVaultPrecheck: () => null }));
vi.mock("../context/language-context", () => ({ useLanguage: () => ({ lang: "en", setLang: vi.fn() }) }));
vi.mock("../context/portfolio-context", () => ({
  usePortfolio: () => ({
    portfolios: [],
    createPortfolioWithChangeSet: state.create,
    realAllocateStage: null,
    relaySends: false,
    vaultLive: false,
    setupSigner: { accountId: "alice.near", loginAddress: "alice.near" },
  }),
}));
vi.mock("../hooks/use-available-general-balance", () => ({
  useAvailableGeneralBalance: () => new Map([["near", 5]]),
}));
vi.mock("../hooks/use-fundable-general-balance", () => ({ useFundableGeneralBalance: () => state.fundable }));
vi.mock("@/features/market/hooks/use-token-prices", async () => {
  const { tokenRegistry } = await vi.importActual<typeof import("@/features/market/lib/token-registry")>(
    "@/features/market/lib/token-registry"
  );
  return {
    useTokenPrices: () => ({
      prices: Object.fromEntries(
        tokenRegistry.map((t) => [t.id, { symbol: t.symbol, usdPrice: t.fallbackUsdPrice || 1, updatedAt: "", source: "chaindefuser" }])
      ),
      isLoading: false,
    }),
  };
});

import { CreatePortfolioFlow } from "./create-portfolio-flow";

const t = shellTranslations.en;
const te = editorTranslations.en;
const SAVED = {
  name: "My mix",
  presetId: null,
  rows: [{ tokenId: "near", targetPct: 100, tolerancePct: 10, locked: false }],
};

function walkToEditor() {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  const onDraftSaved = vi.fn();
  render(<CreatePortfolioFlow startNew onClose={onClose} onCreated={onCreated} onDraftSaved={onDraftSaved} />);
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${t.presetBalancedName}`) }));
  return { onClose, onCreated, onDraftSaved };
}
const create = () => fireEvent.click(screen.getByRole("button", { name: t.draftCreate }));
const nameField = () => screen.getByLabelText(t.portfolioNameLabel) as HTMLInputElement;
const fundsTitle = () => screen.queryByRole("heading", { name: t.presetReviewTitle });
const editorTitle = () => screen.queryByRole("heading", { name: t.draftEditorTitle });
const fillMax = () => fireEvent.click(screen.getAllByRole("button", { name: t.depositAmountMax })[0]);
const sign = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: t.presetReviewCreate }));
  });
};

beforeEach(() => {
  window.localStorage.clear();
  state.create.mockReset().mockResolvedValue(undefined);
  state.fundable = { status: "known", fundable: true, tokenIds: ["near"], usd: 15 };
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(cleanup);

describe("Creating directly with funds (D-397)", () => {
  it("walk 1: chooser, editor, funds screen, signature, on the portfolio, and no draft along the way", async () => {
    const { onClose, onCreated, onDraftSaved } = walkToEditor();
    create();
    expect(fundsTitle()).toBeTruthy();
    expect(editorTitle()).toBeNull();
    expect(readNewPortfolioDraft(ACCOUNT)).toBeNull();

    fillMax();
    await sign();
    expect(state.create).toHaveBeenCalledTimes(1);
    expect(state.create.mock.calls[0][0]).toBe(t.presetBalancedName);
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onDraftSaved).not.toHaveBeenCalled();
    expect(readNewPortfolioDraft(ACCOUNT)).toBeNull();
  });

  it("walk 2: 'Save draft' saves and lands on its tab, and nothing is signed", () => {
    const { onClose, onDraftSaved } = walkToEditor();
    fireEvent.click(screen.getByRole("button", { name: t.draftSaveDraft }));
    expect(readNewPortfolioDraft(ACCOUNT)?.name).toBe(t.presetBalancedName);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onDraftSaved).toHaveBeenCalledTimes(1);
    expect(state.create).not.toHaveBeenCalled();
  });

  it("walk 3: with a draft saved, signing leaves it as it was", async () => {
    saveNewPortfolioDraft(ACCOUNT, SAVED, []);
    const before = readNewPortfolioDraft(ACCOUNT);
    walkToEditor();
    expect(screen.queryByRole("button", { name: t.draftSaveDraft })).toBeNull();
    create();
    fillMax();
    await sign();
    expect(state.create).toHaveBeenCalledTimes(1);
    expect(readNewPortfolioDraft(ACCOUNT)).toEqual(before);
  });

  it("with the funds in transit, the draft stays and Close closes the whole flow", async () => {
    saveNewPortfolioDraft(ACCOUNT, SAVED, []);
    const before = readNewPortfolioDraft(ACCOUNT);
    state.create.mockRejectedValue(new RealAllocateUnconfirmedError("x", "rec-1", "unconfirmed"));
    const { onClose, onCreated } = walkToEditor();
    create();
    fillMax();
    await sign();
    expect(readNewPortfolioDraft(ACCOUNT)).toEqual(before);
    expect(onCreated).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: t.realAllocateClose }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(state.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["Back", () => fireEvent.click(screen.getByRole("button", { name: t.presetReviewBack }))],
    ["Escape", () => fireEvent.keyDown(document, { key: "Escape" })],
    ["a click outside", () => fireEvent.mouseDown(screen.getByRole("dialog").parentElement!)],
  ])("%s returns to the editor with everything as it was, the name changed there, and the focus on the main button", (_label, leave) => {
    const { onClose } = walkToEditor();
    const near = () => screen.getByLabelText(`${te.band} NEAR`) as HTMLInputElement;
    fireEvent.change(near(), { target: { value: "12" } });
    create();
    fireEvent.change(nameField(), { target: { value: "Renamed" } });

    leave();

    expect(editorTitle()).toBeTruthy();
    expect(fundsTitle()).toBeNull();
    expect(nameField().value).toBe("Renamed");
    expect(near().value).toBe("12");
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: t.draftCreate }));
    expect(state.create).not.toHaveBeenCalled();
  });

  it("the funds screen starts empty every time, also after going back", () => {
    walkToEditor();
    create();
    fillMax();
    fireEvent.click(screen.getByRole("button", { name: t.presetReviewBack }));
    create();
    expect(((screen.getAllByRole("spinbutton")[0]) as HTMLInputElement).value).toBe("");
  });

  it("a failed signature stays on the funds screen, and going back loses nothing", async () => {
    state.create.mockRejectedValue(new Error("User rejected the request"));
    const { onClose } = walkToEditor();
    create();
    fillMax();
    await sign();
    expect(screen.getByRole("button", { name: t.presetReviewRetry })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: t.presetReviewBack }));
    expect(nameField().value).toBe(t.presetBalancedName);
  });
});
