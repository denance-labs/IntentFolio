// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { FundableGeneralBalance } from "../hooks/use-fundable-general-balance";
import type { NewPortfolioDraft } from "../lib/new-portfolio-draft";
import { shellTranslations } from "../lib/translations";

// 019-5 (D-393 Q4): every card opens the New Portfolio Draft editor, with funds or without;
// the signature comes later, from the draft's confirmation. The balance only decides where a
// SAVED draft opens (016 blocks 2.3/2.4).

const state = vi.hoisted(() => ({
  fundable: { status: "loading" } as FundableGeneralBalance,
  draft: null as NewPortfolioDraft | null,
  available: new Map<string, number>(),
  portfolios: [] as { name: string }[],
}));

vi.mock("../context/language-context", () => ({ useLanguage: () => ({ lang: "en", setLang: vi.fn() }) }));
vi.mock("../context/portfolio-context", () => ({ usePortfolio: () => ({ portfolios: state.portfolios }) }));
vi.mock("../hooks/use-available-general-balance", () => ({ useAvailableGeneralBalance: () => state.available }));
vi.mock("../hooks/use-fundable-general-balance", () => ({ useFundableGeneralBalance: () => state.fundable }));
vi.mock("../hooks/use-new-portfolio-draft", () => ({
  useNewPortfolioDraft: () => ({ draft: state.draft, save: vi.fn(), discard: vi.fn() }),
}));
vi.mock("@/features/market/hooks/use-token-prices", () => ({ useTokenPrices: () => ({ prices: {} }) }));
vi.mock("./preset-review-modal", () => ({
  PresetReviewModal: ({
    source,
    onBack,
    onCreated,
  }: {
    source: { kind: "preset"; presetId: string } | { kind: "draft"; draft: { name: string } };
    onBack?: () => void;
    onCreated?: () => void;
  }) => (
    <div>
      {source.kind === "preset" ? `review:${source.presetId}` : `confirm:${source.draft.name}`}
      <span>{onBack ? "with-back" : "no-back"}</span>
      <button type="button" onClick={onCreated}>created</button>
    </div>
  ),
}));
vi.mock("@/features/portfolio-editor/components/add-funds-modal", () => ({
  AddFundsModal: () => <div>funded-scratch</div>,
}));
vi.mock("./new-portfolio-draft-editor", () => ({
  NewPortfolioDraftEditor: ({
    presetId,
    draft,
    existingNames,
    onSaved,
    onBack,
    funded,
  }: {
    presetId: string | null;
    draft?: { name: string } | null;
    existingNames: string[];
    onSaved: () => void;
    onBack?: () => void;
    funded?: boolean;
  }) => (
    <div>
      {draft ? `resume:${draft.name}` : `draft:${presetId ?? "scratch"}`}
      <span>{onBack ? "with-back" : "no-back"}</span>
      <span>{`funded:${funded ? "yes" : "no"}`}</span>
      <span>{`names:${existingNames.join(",")}`}</span>
      <button type="button" onClick={onSaved}>save-draft</button>
      {onBack ? <button type="button" onClick={onBack}>back</button> : null}
    </div>
  ),
}));

import { AFTER_DEPOSIT_WAIT_MS, CreatePortfolioFlow } from "./create-portfolio-flow";

const t = shellTranslations.en;
const card = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) });

function renderFlow({
  afterDeposit,
  signedOut,
}: {
  afterDeposit?: { tokenId: string; qty: number };
  signedOut?: boolean;
} = {}) {
  const onClose = vi.fn();
  const onDraftSaved = vi.fn();
  const onCreated = vi.fn();
  const flow = () => (
    <CreatePortfolioFlow
      onClose={onClose}
      onDraftSaved={onDraftSaved}
      afterDeposit={afterDeposit}
      onCreated={onCreated}
      signedOut={signedOut}
    />
  );
  const view = render(flow());
  return { onClose, onDraftSaved, onCreated, rerender: () => view.rerender(flow()) };
}

const SAVED: NewPortfolioDraft = {
  v: 1,
  name: "My mix",
  presetId: "balanced",
  rows: [{ tokenId: "near", targetPct: 100, tolerancePct: 8, locked: false }],
  updatedAt: 1,
};

beforeEach(() => {
  state.fundable = { status: "loading" };
  state.draft = null;
  state.available = new Map();
  state.portfolios = [];
});
afterEach(cleanup);

describe("CreatePortfolioFlow — every card builds a draft first", () => {
  it("with funds ≥ $1: a preset opens the draft editor with it, scratch opens it empty — never a signature", () => {
    state.fundable = { status: "known", fundable: true, tokenIds: ["near"], usd: 5 };
    renderFlow();
    fireEvent.click(card(t.presetBalancedName));
    expect(screen.getByText("draft:balanced")).toBeTruthy();
    expect(screen.getByText("with-back")).toBeTruthy();
    // D-400: its subtitle does not wait on a deposit.
    expect(screen.getByText("funded:yes")).toBeTruthy();
    expect(screen.queryByText(/review:|confirm:|funded-scratch/)).toBeNull();

    cleanup();
    renderFlow();
    fireEvent.click(card(t.presetScratchName));
    expect(screen.getByText("draft:scratch")).toBeTruthy();
    expect(screen.queryByText(/review:|confirm:|funded-scratch/)).toBeNull();
  });

  it("without funds: a preset opens the draft editor with it, scratch opens it empty", () => {
    state.fundable = { status: "known", fundable: false, tokenIds: [], usd: 0 };
    renderFlow();
    fireEvent.click(card(t.presetSatoshiName));
    expect(screen.getByText("draft:satoshi")).toBeTruthy();
    expect(screen.getByText("funded:no")).toBeTruthy();

    cleanup();
    renderFlow();
    fireEvent.click(card(t.presetScratchName));
    expect(screen.getByText("draft:scratch")).toBeTruthy();
  });

  // The editor is the same either way, so there is nothing to wait for.
  it("while the balance loads: a card opens the editor at once", () => {
    renderFlow();
    fireEvent.click(card(t.presetConservativeName));
    expect(screen.getByText("draft:conservative")).toBeTruthy();
  });

  it("the editor's Back returns to the chooser", () => {
    state.fundable = { status: "known", fundable: true, tokenIds: ["near"], usd: 5 };
    renderFlow();
    fireEvent.click(card(t.presetSatoshiName));
    expect(screen.getByText("draft:satoshi")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "back" }));
    expect(card(t.presetSatoshiName)).toBeTruthy();
  });

  // 019-4: saving no longer opens the deposit — the shell lands on the draft's tab.
  it("'Create portfolio' closes the flow and hands over to the landing", () => {
    state.fundable = { status: "known", fundable: false, tokenIds: [], usd: 0 };
    const { onClose, onDraftSaved } = renderFlow();
    fireEvent.click(card(t.presetBalancedName));
    fireEvent.click(screen.getByRole("button", { name: "save-draft" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onDraftSaved).toHaveBeenCalledTimes(1);
  });
});

// 016 block 2.3: one draft per account. While one is saved, "+" resumes it rather than
// offering a new one that would overwrite it.
describe("CreatePortfolioFlow — with a saved New Portfolio Draft", () => {
  beforeEach(() => {
    state.draft = SAVED;
  });

  it("without funds: opens the draft in the editor, no chooser and no Back", () => {
    state.fundable = { status: "known", fundable: false, tokenIds: [], usd: 0 };
    renderFlow();
    expect(screen.getByText("resume:My mix")).toBeTruthy();
    expect(screen.getByText("no-back")).toBeTruthy();
    expect(screen.queryByText(t.presetSelectTitle)).toBeNull();
  });

  it("while loading: says it is checking, then resumes once the balance is known", () => {
    const { rerender } = renderFlow();
    expect(screen.getByRole("status").textContent).toBe(t.draftCheckingBalance);
    expect(screen.queryByText(/resume:|draft:/)).toBeNull();

    state.fundable = { status: "known", fundable: false, tokenIds: [], usd: 0 };
    rerender();
    expect(screen.getByText("resume:My mix")).toBeTruthy();
  });

  it("the checking step can be cancelled", () => {
    const { onClose } = renderFlow();
    fireEvent.click(screen.getByRole("button", { name: t.cancel }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // 016 block 2.4: with funds, "+" / the card / the strip all confirm the draft.
  it("with funds: confirms the draft — no chooser, no Back", () => {
    state.fundable = { status: "known", fundable: true, tokenIds: ["near"], usd: 5 };
    renderFlow();
    expect(screen.getByText("confirm:My mix")).toBeTruthy();
    expect(screen.getByText("no-back")).toBeTruthy();
    expect(screen.queryByText(t.presetSelectTitle)).toBeNull();
    expect(screen.queryByText(/resume:/)).toBeNull();
  });

  it("while loading, then funds: says it is checking, then confirms", () => {
    const { rerender } = renderFlow();
    expect(screen.getByRole("status").textContent).toBe(t.draftCheckingBalance);
    state.fundable = { status: "known", fundable: true, tokenIds: ["near"], usd: 5 };
    rerender();
    expect(screen.getByText("confirm:My mix")).toBeTruthy();
  });

  // What is signed is what is on screen: the snapshot taken when the confirmation opened.
  it("an edit to the stored draft from another tab does not change the open confirmation", () => {
    state.fundable = { status: "known", fundable: true, tokenIds: ["near"], usd: 5 };
    const { rerender } = renderFlow();
    state.draft = { ...SAVED, name: "Changed elsewhere" };
    rerender();
    expect(screen.getByText("confirm:My mix")).toBeTruthy();
    // Nor does a discard: the modal ends its own way (its success or its terminal notice).
    state.draft = null;
    rerender();
    expect(screen.getByText("confirm:My mix")).toBeTruthy();
  });

  it("hands the landing callback to the confirmation", () => {
    state.fundable = { status: "known", fundable: true, tokenIds: ["near"], usd: 5 };
    const { onCreated } = renderFlow();
    fireEvent.click(screen.getByRole("button", { name: "created" }));
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it("a draft discarded while checking falls back to the chooser", () => {
    const { rerender } = renderFlow();
    state.draft = null;
    rerender();
    expect(screen.getByText(t.presetSelectTitle)).toBeTruthy();
  });

  it("funds arriving while the draft is open do not swap the editor away", () => {
    state.fundable = { status: "known", fundable: false, tokenIds: [], usd: 0 };
    const { rerender } = renderFlow();
    state.fundable = { status: "known", fundable: true, tokenIds: ["near"], usd: 5 };
    rerender();
    expect(screen.getByText("resume:My mix")).toBeTruthy();
  });

  it("saving the resumed draft closes the flow and hands over to the landing", () => {
    state.fundable = { status: "known", fundable: false, tokenIds: [], usd: 0 };
    const { onClose, onDraftSaved } = renderFlow();
    fireEvent.click(screen.getByRole("button", { name: "save-draft" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onDraftSaved).toHaveBeenCalledTimes(1);
  });
});

// B1 (016 block 2.4): "Confirm my portfolio" right after a wallet deposit. The balance on
// screen may predate the deposit for a few seconds, so the confirmation waits to see it.
describe("CreatePortfolioFlow — confirming right after a wallet deposit", () => {
  const DEPOSIT = { tokenId: "near", qty: 2 };

  beforeEach(() => {
    vi.useFakeTimers();
    state.draft = SAVED;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("says it is updating the balance until the deposit shows, then confirms", () => {
    // The old read: funds, but not the deposit — it must not open on that.
    state.fundable = { status: "known", fundable: true, tokenIds: ["near"], usd: 5 };
    state.available = new Map([["near", 1]]);
    const { rerender } = renderFlow({ afterDeposit: DEPOSIT });
    expect(screen.getByRole("status").textContent).toBe(t.draftUpdatingBalance);
    expect(screen.queryByText(/confirm:/)).toBeNull();

    state.available = new Map([["near", 3]]);
    rerender();
    expect(screen.getByText("confirm:My mix")).toBeTruthy();
  });

  it("opens at once when the balance already shows it", () => {
    state.fundable = { status: "known", fundable: true, tokenIds: ["near"], usd: 5 };
    state.available = new Map([["near", 2]]);
    renderFlow({ afterDeposit: DEPOSIT });
    expect(screen.getByText("confirm:My mix")).toBeTruthy();
  });

  it("gives up waiting after the cap and opens the confirmation anyway — never the editor", () => {
    state.fundable = { status: "known", fundable: false, tokenIds: [], usd: 0 };
    renderFlow({ afterDeposit: DEPOSIT });
    act(() => {
      vi.advanceTimersByTime(AFTER_DEPOSIT_WAIT_MS - 1);
    });
    expect(screen.queryByText(/confirm:/)).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByText("confirm:My mix")).toBeTruthy();
    expect(screen.queryByText(/resume:/)).toBeNull();
  });

  it("the wait can be cancelled", () => {
    const { onClose } = renderFlow({ afterDeposit: DEPOSIT });
    fireEvent.click(screen.getByRole("button", { name: t.cancel }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// D-359 — no wallet connected: nothing to sign with and nowhere to deposit.
describe("CreatePortfolioFlow — signed out", () => {
  it("every card opens the editor, even with a balance read that says there are funds", () => {
    state.fundable = { status: "known", fundable: true, tokenIds: ["near"], usd: 5 };
    renderFlow({ signedOut: true });
    fireEvent.click(card(t.presetBalancedName));
    expect(screen.getByText("draft:balanced")).toBeTruthy();
    expect(screen.getByText("funded:no")).toBeTruthy();

    cleanup();
    renderFlow({ signedOut: true });
    fireEvent.click(card(t.presetScratchName));
    expect(screen.getByText("draft:scratch")).toBeTruthy();
  });

  it("does not wait on a balance read", () => {
    state.fundable = { status: "loading" };
    renderFlow({ signedOut: true });
    fireEvent.click(card(t.presetBalancedName));
    expect(screen.getByText("draft:balanced")).toBeTruthy();
  });

  it("a saved draft opens in the editor, never the confirmation", () => {
    state.fundable = { status: "known", fundable: true, tokenIds: ["near"], usd: 5 };
    state.draft = SAVED;
    renderFlow({ signedOut: true });
    expect(screen.getByText("resume:My mix")).toBeTruthy();
    expect(screen.queryByText(/confirm:/)).toBeNull();
  });

  it("saving closes the flow and hands over to the landing, as signed in", () => {
    const { onClose, onDraftSaved } = renderFlow({ signedOut: true });
    fireEvent.click(card(t.presetBalancedName));
    fireEvent.click(screen.getByRole("button", { name: "save-draft" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onDraftSaved).toHaveBeenCalledTimes(1);
  });

  it("checks the name against no portfolios (there is no account to read them from)", () => {
    state.portfolios = [{ name: "Savings" }];
    renderFlow({ signedOut: true });
    fireEvent.click(card(t.presetBalancedName));
    expect(screen.getByText("names:")).toBeTruthy();

    cleanup();
    state.fundable = { status: "known", fundable: false, tokenIds: [], usd: 0 };
    renderFlow();
    fireEvent.click(card(t.presetBalancedName));
    expect(screen.getByText("names:Savings")).toBeTruthy();
  });
});
