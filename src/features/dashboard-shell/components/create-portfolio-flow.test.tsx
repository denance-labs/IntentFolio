// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { FundableGeneralBalance } from "../hooks/use-fundable-general-balance";
import type { NewPortfolioDraft } from "../lib/new-portfolio-draft";
import type { PresetId } from "@/content/portfolio-presets";
import { shellTranslations } from "../lib/translations";
import { COUNTRY_COOKIE } from "@/features/stocks/lib/stock-region";

// 019-5 (D-393 Q4): every card opens the editor, with funds or without. D-397: what its footer
// offers follows the props handed here (the editor's own tests cover the footer). The balance
// decides where a SAVED draft opens (016 blocks 2.3/2.4), unless "+" asks for a new one.

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
    source: { kind: "new" } | { kind: "draft"; draft: { name: string } };
    onBack?: () => void;
    onCreated?: () => void;
  }) => (
    <div>
      {source.kind === "new" ? "review:new" : `confirm:${source.draft.name}`}
      <span>{onBack ? "with-back" : "no-back"}</span>
      <button type="button" onClick={onCreated}>created</button>
    </div>
  ),
}));
vi.mock("./new-portfolio-draft-editor", () => ({
  NewPortfolioDraftEditor: ({
    presetId,
    draft,
    existingNames,
    onSaved,
    onBack,
    onCreated,
    funded,
    balanceUnreadable,
    signedOut,
    savedDraftName,
  }: {
    presetId: string | null;
    draft?: { name: string } | null;
    existingNames: string[];
    onSaved: () => void;
    onBack?: () => void;
    onCreated?: () => void;
    funded?: boolean | null;
    balanceUnreadable?: boolean;
    signedOut?: boolean;
    savedDraftName?: string | null;
  }) => (
    <div>
      {draft ? `resume:${draft.name}` : `draft:${presetId ?? "scratch"}`}
      <span>{onBack ? "with-back" : "no-back"}</span>
      <span>{`funded:${funded === null ? "unknown" : funded ? "yes" : "no"}`}</span>
      <span>{balanceUnreadable ? "unreadable" : "readable"}</span>
      <span>{signedOut ? "signed-out" : "signed-in"}</span>
      <span>{`saved:${savedDraftName ?? "none"}`}</span>
      <button type="button" onClick={onCreated}>editor-created</button>
      <span>{`names:${existingNames.join(",")}`}</span>
      <button type="button" onClick={onSaved}>save-draft</button>
      {onBack ? <button type="button" onClick={onBack}>back</button> : null}
    </div>
  ),
}));

import { AFTER_DEPOSIT_WAIT_MS, CreatePortfolioFlow } from "./create-portfolio-flow";

// D-569: the cookie the middleware writes from Vercel's country header.
const setCountry = (code: string | null) => {
  document.cookie = code ? `${COUNTRY_COOKIE}=${code}; path=/` : `${COUNTRY_COOKIE}=; path=/; max-age=0`;
};
afterEach(() => setCountry(null));

const t = shellTranslations.en;
const card = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) });

function renderFlow({
  afterDeposit,
  signedOut,
  startNew,
  startPresetId,
}: {
  afterDeposit?: { tokenId: string; qty: number };
  signedOut?: boolean;
  startNew?: boolean;
  startPresetId?: PresetId;
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
      startNew={startNew}
      startPresetId={startPresetId}
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

describe("CreatePortfolioFlow — every card opens the editor", () => {
  it("with funds: a preset opens the editor with it, scratch opens it empty, and the signature is the editor's to offer", () => {
    state.fundable = { status: "known", fundable: true, tokenIds: ["near"], usd: 5 };
    renderFlow();
    fireEvent.click(card(t.presetBalancedName));
    expect(screen.getByText("draft:balanced")).toBeTruthy();
    expect(screen.getByText("with-back")).toBeTruthy();
    // D-400: its subtitle does not wait on a deposit.
    expect(screen.getByText("funded:yes")).toBeTruthy();
    expect(screen.getByText("saved:none")).toBeTruthy();
    expect(screen.queryByText(/review:|confirm:/)).toBeNull();

    cleanup();
    renderFlow();
    fireEvent.click(card(t.presetScratchName));
    expect(screen.getByText("draft:scratch")).toBeTruthy();
    expect(screen.queryByText(/review:|confirm:/)).toBeNull();
  });

  it("hands the editor the landing for a portfolio signed from its funds screen", () => {
    state.fundable = { status: "known", fundable: true, tokenIds: ["near"], usd: 5 };
    const { onCreated } = renderFlow();
    fireEvent.click(card(t.presetBalancedName));
    fireEvent.click(screen.getByRole("button", { name: "editor-created" }));
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it("tells the editor an unknown balance from a read that failed", () => {
    renderFlow();
    fireEvent.click(card(t.presetBalancedName));
    expect(screen.getByText("funded:unknown")).toBeTruthy();
    expect(screen.getByText("readable")).toBeTruthy();

    cleanup();
    state.fundable = { status: "error", retry: vi.fn() };
    renderFlow();
    fireEvent.click(card(t.presetBalancedName));
    expect(screen.getByText("funded:unknown")).toBeTruthy();
    expect(screen.getByText("unreadable")).toBeTruthy();
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
  it("saving closes the flow and hands over to the landing", () => {
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

// D-397: "+" with funds builds another portfolio. The draft stays, and the editor is told about it.
describe("CreatePortfolioFlow — entering with a preset from the landing (D-561)", () => {
  it("opens the editor on it, and Back still reaches the chooser", () => {
    renderFlow({ signedOut: true, startPresetId: "aggressive" });
    expect(screen.getByText("draft:aggressive")).toBeTruthy();
    expect(screen.queryByText(t.presetSelectTitle)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "back" }));
    expect(screen.getByText(t.presetSelectTitle)).toBeTruthy();
  });

  it("with a draft saved it is a new mix, told the name of the draft it must not replace", () => {
    state.draft = SAVED;
    state.fundable = { status: "known", fundable: true, tokenIds: ["near"], usd: 5 };
    renderFlow({ startNew: true, startPresetId: "aggressive" });
    expect(screen.getByText("draft:aggressive")).toBeTruthy();
    expect(screen.getByText("saved:My mix")).toBeTruthy();
  });

  // D-569: where stocks can't be bought, a preset with stocks opens the chooser, which says why.
  it("where stocks can't be bought, a preset with stocks opens the chooser instead", () => {
    setCountry("US");
    renderFlow({ signedOut: true, startPresetId: "techTitans" });
    expect(screen.getByText(t.presetSelectTitle)).toBeTruthy();
    expect(screen.queryByText("draft:techTitans")).toBeNull();
  });

  it("where stocks can't be bought, a preset without stocks still opens the editor", () => {
    setCountry("US");
    renderFlow({ signedOut: true, startPresetId: "aggressive" });
    expect(screen.getByText("draft:aggressive")).toBeTruthy();
  });

  it("from anywhere else a preset with stocks opens the editor (control)", () => {
    setCountry("AR");
    renderFlow({ signedOut: true, startPresetId: "techTitans" });
    expect(screen.getByText("draft:techTitans")).toBeTruthy();
  });
});

describe("CreatePortfolioFlow — a new portfolio with a draft saved (startNew)", () => {
  beforeEach(() => {
    state.draft = SAVED;
    state.fundable = { status: "known", fundable: true, tokenIds: ["near"], usd: 5 };
  });

  it("opens the chooser, not the draft's confirmation", () => {
    renderFlow({ startNew: true });
    expect(screen.getByText(t.presetSelectTitle)).toBeTruthy();
    expect(screen.queryByText(/confirm:|resume:/)).toBeNull();
  });

  it("a card opens the editor as a new mix, told the name of the draft it must not replace", () => {
    renderFlow({ startNew: true });
    fireEvent.click(card(t.presetBalancedName));
    expect(screen.getByText("draft:balanced")).toBeTruthy();
    expect(screen.getByText("saved:My mix")).toBeTruthy();
    expect(screen.getByText("with-back")).toBeTruthy();
  });

  it("the other ways in still confirm the draft (control)", () => {
    renderFlow();
    expect(screen.getByText("confirm:My mix")).toBeTruthy();
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
    expect(screen.getByText("signed-out")).toBeTruthy();
    expect(screen.getByText("saved:none")).toBeTruthy();

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
