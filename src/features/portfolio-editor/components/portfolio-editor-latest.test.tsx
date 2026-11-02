// @vitest-environment jsdom
// D-321 (013.plan P5/P6): the wiring between the editor and the Add funds modal on a REAL
// portfolio. The editor hook and the modal are stubbed; the props handed over are under test.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { translations } from "../lib/translations";
import { shellTranslations } from "@/features/dashboard-shell/lib/translations";

const h = vi.hoisted(() => ({
  editor: {} as Record<string, unknown>,
  modalProps: null as null | Record<string, unknown>,
  targetsProps: null as null | Record<string, unknown>,
  summaryProps: null as null | Record<string, unknown>,
  portfolio: null as null | Record<string, unknown>,
  pending: [] as unknown[] | undefined,
  fundable: { status: "known", fundable: false, tokenIds: [], usd: 0 } as Record<string, unknown>,
}));
const PORTFOLIO = {
  id: "p_000000000017",
  name: "canary-931",
  defaultTolerancePct: 7,
  targets: [],
  deposits: {},
};

vi.mock("../hooks/use-portfolio-editor", () => ({ usePortfolioEditor: () => h.editor }));
vi.mock("./add-funds-modal", () => ({
  AddFundsModal: (props: Record<string, unknown>) => {
    h.modalProps = props;
    return <div data-testid="funds-modal" />;
  },
}));
vi.mock("./add-targets-modal", () => ({
  AddTargetsModal: (props: Record<string, unknown>) => {
    h.targetsProps = props;
    return null;
  },
}));
vi.mock("./portfolio-summary-panel", () => ({
  PortfolioSummaryPanel: (props: Record<string, unknown>) => {
    h.summaryProps = props;
    return <div data-testid="holdings" />;
  },
}));
vi.mock("@/features/vault/hooks/use-pending-allocates", () => ({
  usePendingAllocates: () => ({ pending: h.pending, isFetching: false }),
}));
vi.mock("@/features/dashboard-shell/context/portfolio-context", () => ({
  usePortfolio: () => ({
    activePortfolio: h.portfolio ?? PORTFOLIO,
    draftWasRestored: false,
    dismissRestoredDraft: vi.fn(),
  }),
}));
vi.mock("@/features/login-wallet", () => ({ useLoginWallet: () => ({ intentsAccountId: "alice.near" }) }));
// 029 B-23: what the funding account can put in, and the history the prompt reads after an answer.
vi.mock("@/features/dashboard-shell/hooks/use-fundable-general-balance", () => ({ useFundableGeneralBalance: () => h.fundable }));
vi.mock("@/features/vault/hooks/use-real-portfolio-history", () => ({
  useAccountHistory: () => ({ data: undefined, isLoading: false, outOfDate: false }),
}));
vi.mock("@/features/intents-account/mock-contract", () => ({
  mockContract: { subscribe: () => () => {}, getVersion: () => 0, getPendingUnallocations: () => [] },
}));

import { PortfolioEditorLatest } from "./portfolio-editor-latest";
import { DepositActionProvider } from "@/features/dashboard-shell/context/deposit-action-context";
import { markUnconfirmedWithdrawal } from "../lib/unconfirmed-withdrawal-mark";

const t = translations.en;

function stubEditor(over: Record<string, unknown>) {
  h.editor = {
    lang: "en",
    validation: { global: [], byTokenId: {}, hasErrors: false },
    chartRows: [],
    currentTotalUsd: 0,
    priceState: { prices: {}, error: null },
    isEditing: false,
    isLiveRoute: true,
    hasDraftChanges: false,
    beginEdit: vi.fn(),
    discardDraft: vi.fn(),
    setToast: vi.fn(),
    requestCommit: vi.fn(),
    generalBalanceAvailable: new Map(),
    effectiveCurrentPortfolioQty: {},
    selectedTokenIds: [],
    toast: null,
    preview: null,
    removeEmptyDialog: null,
    withdrawDialog: null,
    computedTargets: [],
    targetTotalPct: 0,
    targetTotalUsd: 0,
    ...over,
  };
}

function openAddTokens() {
  fireEvent.click(screen.getByRole("button", { name: t.addFundsButton }));
  if (!h.modalProps) throw new Error("Add funds modal did not open");
  return h.modalProps as {
    balanceLoading?: boolean;
    onRetryBalance?: () => void;
    onDeposit?: () => void;
    onAddTarget?: unknown;
    realFunding?: {
      blockedByDraft: boolean;
      defaultTolerancePct: number;
      onFunded: (c: Array<{ tokenId: string; qty: number }>) => void;
    };
  };
}

beforeEach(() => {
  h.modalProps = null;
  h.targetsProps = null;
  h.portfolio = null;
  h.pending = [];
  h.fundable = { status: "known", fundable: false, tokenIds: [], usd: 0 };
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("PortfolioEditorLatest → Add funds on a real portfolio (D-321 P5/P6)", () => {
  it("passes realFunding, and an unsaved draft blocks the signature (P6)", () => {
    // `isEditing` stays false so the table branch does not render; the prop is what is under test.
    stubEditor({ isLiveRoute: true, hasDraftChanges: true });
    render(<PortfolioEditorLatest />);
    const { realFunding } = openAddTokens();
    expect(realFunding?.blockedByDraft).toBe(true);
    expect(realFunding?.defaultTolerancePct).toBe(7);
  });

  it("does not open a draft on the way in, and discards the empty one once credited", () => {
    stubEditor({ isLiveRoute: true });
    render(<PortfolioEditorLatest />);
    const { realFunding } = openAddTokens();
    expect(h.editor.beginEdit).not.toHaveBeenCalled();
    act(() => realFunding!.onFunded([{ tokenId: "near", qty: 2 }]));
    expect(h.editor.discardDraft).toHaveBeenCalledTimes(1);
  });

  it("the credit toast shows formatted amounts, not float noise", () => {
    stubEditor({ isLiveRoute: true });
    render(<PortfolioEditorLatest />);
    const { realFunding } = openAddTokens();
    act(() =>
      realFunding!.onFunded([
        { tokenId: "near", qty: 0.6662737441174942 },
        { tokenId: "nep141:usdt.tether-token.near", qty: 2 },
      ])
    );
    expect(h.editor.setToast).toHaveBeenCalledWith({ kind: "neutral", text: "+0.666274\u00a0NEAR · +2.00\u00a0USDT(NEAR)" });
  });

  it("a mock portfolio gets no realFunding: funds keep going through the draft", () => {
    stubEditor({ isLiveRoute: false });
    render(<PortfolioEditorLatest />);
    expect(openAddTokens().realFunding).toBeUndefined();
  });
});

// D-529: the button below the table only adds targets, in a modal of its own; the funds one
// stays above, and offers the shell's Deposit.
describe("PortfolioEditorLatest → Add funds above, Add tokens below (D-529)", () => {
  it("Add funds carries no way to add a target", () => {
    stubEditor({});
    render(<PortfolioEditorLatest />);
    expect(openAddTokens().onAddTarget).toBeUndefined();
  });

  it("says the funding account is still loading, not that it is empty", () => {
    h.fundable = { status: "loading" };
    stubEditor({});
    render(<PortfolioEditorLatest />);
    expect(openAddTokens().balanceLoading).toBe(true);
  });

  it("passes the read's Retry when the funding account could not be read (D-541)", () => {
    const retry = vi.fn();
    h.fundable = { status: "error", retry };
    stubEditor({});
    render(<PortfolioEditorLatest />);
    const props = openAddTokens();
    expect(props.balanceLoading).toBe(false);
    expect(props.onRetryBalance).toBe(retry);
  });

  it("Deposit closes Add funds before the shell opens its own modal", () => {
    const openDeposit = vi.fn();
    stubEditor({});
    render(
      <DepositActionProvider value={openDeposit}>
        <PortfolioEditorLatest />
      </DepositActionProvider>
    );
    const { onDeposit } = openAddTokens();
    act(() => onDeposit!());
    expect(screen.queryByTestId("funds-modal")).toBeNull();
    expect(openDeposit).toHaveBeenCalledTimes(1);
  });

  // Both sets share a cell so "+ Add tokens" never moves; only the one in use can be reached.
  it("only the buttons of the current mode are reachable", () => {
    stubEditor({ isEditing: true });
    render(<PortfolioEditorLatest />);
    expect(screen.getByRole("button", { name: t.savePanel })).toBeTruthy();
    expect(screen.queryByRole("button", { name: t.editPanel })).toBeNull();
    cleanup();
    stubEditor({ currentTotalUsd: 5 });
    render(<PortfolioEditorLatest />);
    expect(screen.getByRole("button", { name: t.editPanel })).toBeTruthy();
    expect(screen.queryByRole("button", { name: t.savePanel })).toBeNull();
    expect(screen.queryByRole("button", { name: t.cancelEdit })).toBeNull();
  });

  it("offers no Deposit outside the shell", () => {
    stubEditor({});
    render(<PortfolioEditorLatest />);
    expect(openAddTokens().onDeposit).toBeUndefined();
  });

  it("opens the targets modal with the composition, and adds through the draft", () => {
    // `isEditing` renders the table branch, where the button lives.
    stubEditor({ isEditing: true, selectedTokenIds: ["near"], addTargetToken: vi.fn() });
    render(<PortfolioEditorLatest />);
    fireEvent.click(screen.getByRole("button", { name: `+ ${t.addTokensButton}` }));
    expect(h.modalProps).toBeNull();
    expect(h.targetsProps?.compositionTokenIds).toEqual(["near"]);
    expect(h.targetsProps?.onAddTarget).toBe(h.editor.addTargetToken);
    expect(h.editor.beginEdit).not.toHaveBeenCalled();
  });
});

// 027 A-9a: deleting lives only in the tab menu; the holdings are always there, and an empty
// portfolio says so instead of showing nothing.
describe("PortfolioEditorLatest → holdings, with no delete offer", () => {
  it("an empty real portfolio shows its holdings, labelled as empty", () => {
    h.portfolio = { ...PORTFOLIO, isReal: true, holdsNothingOnChain: true };
    stubEditor({});
    render(<PortfolioEditorLatest />);
    expect(screen.queryByTestId("holdings")).not.toBeNull();
    expect(h.summaryProps?.emptyLabel).toBe(t.holdingsEmpty);
  });
});

// D-326: a top-up of THIS portfolio sent and not yet seen credited.
describe("PortfolioEditorLatest → a top-up still unconfirmed", () => {
  it("shows the strip for a top-up of this portfolio, and the editor stays usable", () => {
    h.pending = [{ id: "rec-1", op: "allocate_into", portfolioId: PORTFOLIO.id }];
    stubEditor({});
    render(<PortfolioEditorLatest />);
    expect(screen.getByText(t.pendingTopUpStrip)).toBeTruthy();
    expect((screen.getByRole("button", { name: t.addFundsButton }) as HTMLButtonElement).disabled).toBe(false);
  });

  it.each([
    ["another portfolio's top-up", { id: "rec-1", op: "allocate_into", portfolioId: "p_000000000099" }],
    ["a portfolio being created", { id: "rec-1", op: "setup", portfolioId: null }],
  ])("says nothing for %s", (_label, record) => {
    h.pending = [record];
    stubEditor({});
    render(<PortfolioEditorLatest />);
    expect(screen.queryByText(t.pendingTopUpStrip)).toBeNull();
  });
});

// D-369: a withdrawal of THIS portfolio that ended unconfirmed, while its signature can still execute.
describe("PortfolioEditorLatest → a withdrawal still unconfirmed", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.useRealTimers());

  it("warns until the signature expires, and the editor stays usable", () => {
    vi.useFakeTimers();
    markUnconfirmedWithdrawal(PORTFOLIO.id);
    stubEditor({});
    render(<PortfolioEditorLatest />);
    expect(screen.getByText(t.unconfirmedWithdrawalStrip)).toBeTruthy();
    expect((screen.getByRole("button", { name: t.addFundsButton }) as HTMLButtonElement).disabled).toBe(false);

    act(() => vi.advanceTimersByTime(600_000));
    expect(screen.queryByText(t.unconfirmedWithdrawalStrip)).toBeNull();
  });

  it("appears without a reload when the mark is set, and says nothing for another portfolio", () => {
    stubEditor({});
    render(<PortfolioEditorLatest />);
    act(() => markUnconfirmedWithdrawal("p_000000000099"));
    expect(screen.queryByText(t.unconfirmedWithdrawalStrip)).toBeNull();
    act(() => markUnconfirmedWithdrawal(PORTFOLIO.id));
    expect(screen.getByText(t.unconfirmedWithdrawalStrip)).toBeTruthy();
  });
});

// 029 B-23: a $0 portfolio with funds in the funding account offers them, once.
describe("PortfolioEditorLatest → the funds-to-assign window", () => {
  const shellT = shellTranslations.en;
  const line = shellT.assignFundsPortfolioTitle.replace("{amount}", "$5.00").replace("{name}", PORTFOLIO.name);
  beforeEach(() => {
    h.fundable = { status: "known", fundable: true, tokenIds: ["near"], usd: 5 };
  });

  it("offers the funds of a $0 portfolio; assigning opens Add funds", () => {
    stubEditor({});
    render(<PortfolioEditorLatest />);
    expect(screen.getByRole("dialog").textContent).toContain(line);
    // Out of the editor's section, whose entry animation would pin `fixed` to it (s8).
    expect(screen.getByRole("dialog").closest("section")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: shellT.draftReadyConfirm }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(h.modalProps).not.toBeNull();
  });

  it("'Not now' closes it, and it does not come back on the next visit", () => {
    stubEditor({});
    render(<PortfolioEditorLatest />);
    fireEvent.click(screen.getByRole("button", { name: shellT.assignFundsNotNow }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(h.modalProps).toBeNull();
    cleanup();
    render(<PortfolioEditorLatest />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each([
    ["a portfolio worth something", () => stubEditor({ currentTotalUsd: 0.02 })],
    ["no funds to assign", () => { stubEditor({}); h.fundable = { status: "known", fundable: false, tokenIds: [], usd: 0 }; }],
    ["the balance still loading", () => { stubEditor({}); h.fundable = { status: "loading" }; }],
    ["a top-up of it on its way", () => { stubEditor({}); h.pending = [{ id: "rec-1", op: "allocate_into", portfolioId: PORTFOLIO.id }]; }],
    ["an edit in progress", () => stubEditor({ isEditing: true })],
  ])("says nothing for %s", (_label, arrange) => {
    arrange();
    render(<PortfolioEditorLatest />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
