// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { FundableGeneralBalance } from "../hooks/use-fundable-general-balance";
import type { GeneralBalanceRead } from "../hooks/use-general-balance-read";
import { ANONYMOUS_DRAFT_SLOT, discardNewPortfolioDraft, saveNewPortfolioDraft } from "../lib/new-portfolio-draft";
import { shellTranslations } from "../lib/translations";
import { formatUsd } from "@/features/portfolio-editor/lib/format";
import { getTokenById } from "@/features/market/lib/token-registry";
import type { DepositStatusEntry } from "@/features/bridge";
import type { WithdrawalInFlightRecord } from "@/features/intents-account/mock-contract/types";
import { extractAccountEvents, type ChainHistoryEvent } from "@/features/vault/lib/vault-history";
import {
  DEPOSIT_USDT,
  V2_COMPOSITION,
  V2_CREATE,
  V2_DELETE,
  V2_RENAME,
  V2_UNALLOCATE,
  WITHDRAW_USDT,
} from "@/features/vault/lib/vault-history-v2.fixtures";

// 016 block 2.3: where My Account shows a New Portfolio Draft waiting for funds. The draft
// store is the real one (localStorage), so saving, discarding and reloading go through it.

const ACCOUNT = "near:alice.near";

const state = vi.hoisted(() => ({
  fundable: { status: "known", fundable: false, tokenIds: [], usd: 0 } as FundableGeneralBalance,
  balance: new Map<string, number>(),
  balanceRead: { status: "read" } as GeneralBalanceRead,
  portfolios: [] as Array<{ id: string; name: string; deposits: Record<string, number>; isReal?: boolean }>,
  vaultOn: false,
  pendingAllocates: [] as unknown[],
  accountId: "near:alice.near",
  // The history route's answer (028-7); `data` given as events is one settled page's worth.
  chainHistory: { data: undefined, isError: false, refetch: () => {} } as {
    data: unknown;
    isError: boolean;
    refetch: () => void;
    hasNextPage?: boolean;
    fetchNextPage?: () => void;
    outOfDate?: boolean;
  },
}));

vi.mock("../context/language-context", () => ({ useLanguage: () => ({ lang: "en", setLang: vi.fn() }) }));
// No account = no wallet connected: the draft hook then reads the anonymous draft (D-359).
vi.mock("@/features/login-wallet", () => ({
  useLoginWallet: () => ({ intentsAccountId: state.accountId, connection: state.accountId ? {} : null }),
}));
vi.mock("@/features/market/hooks/use-token-prices", () => ({
  useTokenPrices: () => ({ prices: {}, pricesUnavailable: false }),
}));
vi.mock("@/features/vault/components/pending-allocates-banner", () => ({ PendingAllocatesBanner: () => null }));
vi.mock("@/features/vault/hooks/use-pending-allocates", () => ({
  usePendingAllocates: () => ({ pending: state.pendingAllocates }),
}));
vi.mock("../context/portfolio-context", () => ({ usePortfolio: () => ({ portfolios: state.portfolios }) }));
vi.mock("../hooks/use-available-general-balance", () => ({ useAvailableGeneralBalance: () => state.balance }));
vi.mock("@/features/vault/hooks/use-real-portfolio-history", () => ({
  useAccountHistory: () => ({
    isFetchingNextPage: false,
    hasNextPage: false,
    fetchNextPage: () => {},
    outOfDate: false,
    ...state.chainHistory,
    data: Array.isArray(state.chainHistory.data)
      ? { events: state.chainHistory.data, names: {}, loading: false, upToDate: true, unavailable: false }
      : state.chainHistory.data,
  }),
}));
vi.mock("@/features/vault/lib/vault-flag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/vault/lib/vault-flag")>()),
  get VAULT_ROUNDTRIP_ENABLED() {
    return state.vaultOn;
  },
}));
vi.mock("../hooks/use-fundable-general-balance", () => ({ useFundableGeneralBalance: () => state.fundable }));
vi.mock("../hooks/use-general-balance-read", () => ({ useGeneralBalanceRead: () => state.balanceRead }));

import { IntentsAccountView } from "./intents-account-view";

const t = shellTranslations.en;
const CARD_TITLE = "Your portfolio “My mix” is waiting for funds";

function saveDraft(slot = ACCOUNT) {
  const result = saveNewPortfolioDraft(
    slot,
    { name: "My mix", presetId: null, rows: [{ tokenId: "near", targetPct: 100, tolerancePct: 10, locked: false }] },
    []
  );
  expect(result.ok).toBe(true);
}

function renderView({ withPortfolios = false, signedOut = false } = {}) {
  const props = {
    onAddFunds: vi.fn(),
    onWithdraw: vi.fn(),
    onConnect: vi.fn(),
    onDepositForDraft: vi.fn(),
    onViewDraft: vi.fn(),
    onConfirmDraft: vi.fn(),
    onCreatePortfolio: vi.fn(),
  };
  // The shell passes `onCreatePortfolio` only while the account has no portfolio.
  const { onCreatePortfolio, ...rest } = props;
  const view = () => (
    <IntentsAccountView
      {...rest}
      onCreatePortfolio={withPortfolios ? undefined : onCreatePortfolio}
      signedOut={signedOut}
    />
  );
  const { rerender } = render(view());
  return { ...props, rerender: () => rerender(view()) };
}

const card = () => screen.queryByRole("heading", { name: CARD_TITLE });
const emptyState = () => screen.queryByRole("heading", { name: t.myAccountTitle });
const banner = () => screen.queryByText(t.createPortfolioCtaBody);
// The empty state's own Deposit — the account summary above it carries another (021 R3).
const emptyStateDeposit = () =>
  within(emptyState()!.parentElement!.parentElement!).getByRole("button", { name: t.myAccountAddFunds });

beforeEach(() => {
  state.fundable = { status: "known", fundable: false, tokenIds: [], usd: 0 };
  state.balance = new Map();
  state.balanceRead = { status: "read" };
  state.portfolios = [];
  state.vaultOn = false;
  state.pendingAllocates = [];
  state.accountId = ACCOUNT;
  state.chainHistory = { data: undefined, isError: false, refetch: () => {} };
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("IntentsAccountView — a New Portfolio Draft waiting for funds", () => {
  it("a new account with a draft: the card replaces the empty state", () => {
    saveDraft();
    renderView();
    expect(card()).toBeTruthy();
    expect(emptyState()).toBeNull();
    // The steps belong to the empty state; the card says what comes next itself.
    expect(screen.queryByText(t.onboardingStepsLabel)).toBeNull();
  });

  it("no draft: the empty state, as before", () => {
    renderView();
    expect(card()).toBeNull();
    expect(emptyState()).toBeTruthy();
  });

  it("the card's buttons deposit for the draft and go to its tab — not the plain deposit", () => {
    saveDraft();
    const { onDepositForDraft, onViewDraft, onAddFunds } = renderView();
    fireEvent.click(screen.getByRole("button", { name: t.draftCardDeposit }));
    fireEvent.click(screen.getByRole("button", { name: t.draftCardView }));
    expect(onDepositForDraft).toHaveBeenCalledTimes(1);
    expect(onViewDraft).toHaveBeenCalledTimes(1);
    expect(onAddFunds).not.toHaveBeenCalled();
  });

  // 019-4: discarded on its tab (or in another browser tab), the card goes by itself.
  it("discarding it brings the empty state back, and it stays discarded", () => {
    saveDraft();
    renderView();
    act(() => discardNewPortfolioDraft(ACCOUNT));
    expect(card()).toBeNull();
    expect(emptyState()).toBeTruthy();

    cleanup();
    renderView();
    expect(card()).toBeNull();
  });

  it("a reload reads the draft back from this browser", () => {
    saveDraft();
    renderView();
    cleanup();
    renderView();
    expect(card()).toBeTruthy();
  });

  it("appears when the draft is saved elsewhere (the editor, another tab)", () => {
    renderView();
    expect(card()).toBeNull();
    act(() => saveDraft());
    expect(card()).toBeTruthy();
  });

  it("with dust in the balance: the card replaces 'Create your first portfolio'", () => {
    state.balance = new Map([["near", 0.1]]);
    renderView();
    expect(banner()).toBeTruthy();

    cleanup();
    saveDraft();
    renderView();
    expect(card()).toBeTruthy();
    expect(banner()).toBeNull();
  });

  it("next to portfolios: the card leads, the empty balance note stays", () => {
    state.portfolios = [{ id: "p1", name: "Old", deposits: {} }];
    saveDraft();
    renderView({ withPortfolios: true });
    expect(card()).toBeTruthy();
    expect(screen.getByText(t.myAccountEmptyBodyWithPortfolios)).toBeTruthy();
  });

  // D-353: the card's deposit is the one primary; the empty state's steps down to outlined.
  it("next to portfolios: only the card's deposit is filled cyan", () => {
    const plainDeposit = emptyStateDeposit;
    state.portfolios = [{ id: "p1", name: "Old", deposits: {} }];
    renderView({ withPortfolios: true });
    expect(plainDeposit().className).toContain("bg-cyan-500");

    cleanup();
    saveDraft();
    renderView({ withPortfolios: true });
    expect(screen.getByRole("button", { name: t.draftCardDeposit }).className).toContain("bg-cyan-500");
    expect(plainDeposit().className).not.toContain("bg-cyan-500");
    expect(plainDeposit().className).toContain("border-slate-600");
  });

  // D-486: the card stays (the draft exists) but claims nothing about funds until the read ends.
  it("while the first balance read is in flight the card stays, without the waiting claim or a money action", () => {
    state.fundable = { status: "loading" };
    saveDraft();
    renderView();
    expect(screen.getByRole("heading", { name: "My mix" })).toBeTruthy();
    expect(screen.queryByText(CARD_TITLE)).toBeNull();
    expect(screen.queryByRole("button", { name: t.draftCardDeposit })).toBeNull();
    expect(screen.getByRole("button", { name: t.draftCardView })).toBeTruthy();
  });

  it("control: once the read ends with no funds, the waiting claim and the deposit action are back", () => {
    state.fundable = { status: "known", fundable: false, tokenIds: [], usd: 0 };
    saveDraft();
    renderView();
    expect(card()).toBeTruthy();
    expect(screen.getByRole("button", { name: t.draftCardDeposit })).toBeTruthy();
  });

  // With ≥ $1 the draft is ready to confirm: the "ready" card below, not this one.
  it("with funds for it: no waiting card", () => {
    state.fundable = { status: "known", fundable: true, tokenIds: ["near"], usd: 5 };
    state.balance = new Map([["near", 5]]);
    saveDraft();
    renderView();
    expect(card()).toBeNull();
  });

  it("is another account's draft, not this one's: nothing", () => {
    saveNewPortfolioDraft(
      "near:bob.near",
      { name: "My mix", presetId: null, rows: [{ tokenId: "near", targetPct: 100, tolerancePct: 10, locked: false }] },
      []
    );
    renderView();
    expect(card()).toBeNull();
  });
});

// 016 block 2.4: the same draft once the General Balance can fund it.
describe("IntentsAccountView — a New Portfolio Draft ready to confirm", () => {
  const READY_TITLE = "You have $5.00 in your funding account — assign funds to “My mix” to start it";
  const ready = () => screen.queryByRole("heading", { name: READY_TITLE });

  beforeEach(() => {
    state.fundable = { status: "known", fundable: true, tokenIds: ["near"], usd: 5 };
    state.balance = new Map([["near", 5]]);
  });

  it("a new account: the ready card instead of 'Create your first portfolio'", () => {
    saveDraft();
    const { onConfirmDraft, onCreatePortfolio } = renderView();
    expect(ready()).toBeTruthy();
    expect(card()).toBeNull();
    expect(banner()).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: t.draftReadyConfirm }));
    expect(onConfirmDraft).toHaveBeenCalledTimes(1);
    expect(onCreatePortfolio).not.toHaveBeenCalled();
  });

  it("next to portfolios: the ready card leads", () => {
    state.portfolios = [{ id: "p1", name: "Old", deposits: {} }];
    saveDraft();
    renderView({ withPortfolios: true });
    expect(ready()).toBeTruthy();
  });

  it("discarding it leaves the funds and brings the invitation back", () => {
    saveDraft();
    renderView();
    act(() => discardNewPortfolioDraft(ACCOUNT));
    expect(ready()).toBeNull();
    expect(banner()).toBeTruthy();
  });

  it("no draft: the invitation, as before", () => {
    renderView();
    expect(ready()).toBeNull();
    expect(banner()).toBeTruthy();
  });

  it("turns from waiting to ready in place when the funds show up", () => {
    state.fundable = { status: "known", fundable: false, tokenIds: [], usd: 0 };
    state.balance = new Map();
    saveDraft();
    const { rerender } = renderView();
    expect(card()).toBeTruthy();

    state.fundable = { status: "known", fundable: true, tokenIds: ["near"], usd: 5 };
    state.balance = new Map([["near", 5]]);
    rerender();
    expect(card()).toBeNull();
    expect(ready()).toBeTruthy();
  });
});

// 016 block 2.5: before 2.5 an account with no portfolio, no balance and no draft had no way
// into creation at all — only "Deposit". 022-A (D-453): building leads, Deposit sits beside it.
describe("IntentsAccountView — D-307: no «funds are ready» next to an unconfirmed Allocate", () => {
  it("control: a funded account with no portfolio and nothing pending shows the banner", () => {
    state.balance = new Map([["near", 5]]);
    renderView();
    expect(banner()).toBeTruthy();
  });

  it("with an Allocate still unconfirmed the banner is hidden, the onboarding step is not", () => {
    state.balance = new Map([["near", 5]]);
    renderView();
    const stepsWithoutPending = screen.getAllByRole("listitem").map((li) => li.textContent);
    cleanup();
    state.pendingAllocates = [{}];
    renderView();
    expect(banner()).toBeNull();
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(stepsWithoutPending);
  });
});

describe("IntentsAccountView — a new account can build its portfolio first", () => {
  const buildFirst = () => screen.queryByRole("button", { name: t.myAccountBuild });

  // D-450: the Deposit that sat beside Build was the third way in to the same step.
  it("a new account: Build is the empty state's one button; Deposit lives in the summary", () => {
    const { onCreatePortfolio, onAddFunds } = renderView();
    const summaryButtons = () => screen.getByText(t.myAccountTotalValue).closest("dl")!.parentElement!.parentElement!;
    const build = buildFirst()!;
    const emptyStateButtons = within(emptyState()!.parentElement!.parentElement!).getAllByRole("button");
    expect(emptyStateButtons.map((b) => b.textContent)).not.toContain(t.myAccountAddFunds);
    expect(build.className).toContain("bg-cyan-500");
    expect(build.hasAttribute("data-focus-landing")).toBe(true);

    fireEvent.click(build);
    expect(onCreatePortfolio).toHaveBeenCalledTimes(1);
    expect(onAddFunds).not.toHaveBeenCalled();
    fireEvent.click(within(summaryButtons()).getByRole("button", { name: t.myAccountAddFunds }));
    expect(onAddFunds).toHaveBeenCalledTimes(1);
  });

  it("a new account's steps build first, with building as the next step", () => {
    renderView();
    const steps = screen.getAllByRole("listitem");
    expect(steps.map((li) => li.textContent ?? "")[0]).toContain(t.onboardingStep2Title);
    expect(steps[0].textContent).toContain(t.onboardingBuildFirstBody); // 022-I
    expect(steps[1].textContent).toContain(t.onboardingStep1Title);
    expect(steps[0].getAttribute("aria-current")).toBe("step");
  });

  it("not with a draft: its card is the way in", () => {
    saveDraft();
    renderView();
    expect(card()).toBeTruthy();
    expect(buildFirst()).toBeNull();
  });

  it("not next to portfolios: the tabs' \"+\" is the way in", () => {
    state.portfolios = [{ id: "p1", name: "Old", deposits: {} }];
    renderView({ withPortfolios: true });
    expect(buildFirst()).toBeNull();
  });

  // D-412: a credited deposit with an empty balance — everything was withdrawn since, or the
  // read has not caught up yet. Either way the banner would say funds arrived over nothing.
  it("a credited deposit over an empty balance: no 'Create your first portfolio'", () => {
    const deposit = {
      tx_hash: "0xabc",
      chain: "eth:1",
      near_token_id: "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near",
      decimals: 6,
      amount: 5_000_000,
      status: "COMPLETED",
      address: "0xdef",
    } as unknown as DepositStatusEntry;
    render(<IntentsAccountView onAddFunds={vi.fn()} onCreatePortfolio={vi.fn()} deposits={[deposit]} />);
    expect(emptyState()).toBeTruthy();
    expect(banner()).toBeNull();
    expect(buildFirst()).toBeTruthy();
  });

  it("not once funds are there: 'Create your first portfolio' is the way in", () => {
    state.balance = new Map([["near", 5]]);
    renderView();
    expect(banner()).toBeTruthy();
    expect(buildFirst()).toBeNull();
  });
});

// ── 017-7: the finished history in Recent activity (D-364) and D-335 ─────────

const S217_EVENTS = [V2_CREATE, V2_RENAME, V2_UNALLOCATE, V2_DELETE, V2_COMPOSITION, DEPOSIT_USDT, WITHDRAW_USDT].flatMap(
  (tx) => extractAccountEvents(tx, { vaultId: "intentfolio-vault.near", accountId: "pablofork.near" })
);

describe("IntentsAccountView — Recent activity with the finished history", () => {
  beforeEach(() => {
    state.vaultOn = true;
    state.balance = new Map([["near", 5]]);
    state.portfolios = [{ id: "p_000000000001", name: "Portfolio 1", deposits: {}, isReal: true }];
  });

  const ready = (data: ChainHistoryEvent[]) => {
    state.chainHistory = { data, isError: false, refetch: vi.fn() };
  };

  it("lists what was done to each portfolio, by name, with no amount", () => {
    ready(S217_EVENTS);
    render(<IntentsAccountView onOpenPortfolio={vi.fn()} />);
    for (const text of [
      "Created “AgrRenamed”",
      "Renamed “Aggressive” to “AgrRenamed”",
      "Moved funds from “AgrRenamed” to your funding account",
      "Deleted “AgrRenamed”",
      "Changed the mix of “Portfolio 1”",
    ]) {
      expect(screen.getByText(text)).toBeTruthy();
    }
  });

  it("a row of a portfolio that exists opens it; a deleted one's rows open nothing", () => {
    ready(S217_EVENTS);
    const onOpenPortfolio = vi.fn();
    render(<IntentsAccountView onOpenPortfolio={onOpenPortfolio} />);
    fireEvent.click(screen.getByRole("button", { name: /Changed the mix of “Portfolio 1”/ }));
    expect(onOpenPortfolio).toHaveBeenCalledWith("p_000000000001");
    expect(screen.queryByRole("button", { name: /Deleted “AgrRenamed”/ })).toBeNull();
  });

  it("a finished withdrawal says Withdrawal, like a deposit says Deposit, and survives a reload", () => {
    // A reload is exactly this: nothing tracked in memory, only the chain read (s217).
    ready(S217_EVENTS);
    render(<IntentsAccountView />);
    const feed = within(screen.getByRole("region", { name: t.recentActivityHeading }));
    expect(feed.getByText(t.historyEventWithdrawal)).toBeTruthy();
    expect(feed.getByText(t.historyEventDeposit)).toBeTruthy();
  });

  it("each finished row says how it ended, at the start of its date line (027 A-5)", () => {
    ready(S217_EVENTS);
    render(<IntentsAccountView />);
    const feed = within(screen.getByRole("region", { name: t.recentActivityHeading }));
    for (const label of [t.depositStatusCredited, t.activityDoneSent, t.activityDoneConfirmed]) {
      const first = feed.getAllByText(label)[0];
      // On the date line, not a chip beside the row.
      expect(first.parentElement?.className).toContain("text-xs");
      expect(first.className).not.toContain("rounded-full");
    }
  });

  it("while the read is in flight it says so, and a failed read offers a retry — never 'nothing'", () => {
    state.chainHistory = { data: undefined, isError: false, refetch: vi.fn() };
    const { unmount } = render(<IntentsAccountView />);
    expect(screen.getByText(t.activityHistoryLoading)).toBeTruthy();
    unmount();

    const refetch = vi.fn();
    state.chainHistory = { data: undefined, isError: true, refetch };
    render(<IntentsAccountView />);
    expect(screen.getByText(t.activityHistoryError)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t.activityHistoryRetry }));
    expect(refetch).toHaveBeenCalled();
  });

  it("shows 20 finished rows, and 'Show more' adds the next ones", () => {
    const many: ChainHistoryEvent[] = Array.from({ length: 25 }, (_, i) => ({
      txHash: `h${i}`,
      index: 0,
      ts: 1_000 + i,
      event: "intents:deposit",
      data: { account_id: "pablofork.near", token: "nep141:usdt.tether-token.near", amount: "1000000" },
    }));
    ready(many);
    render(<IntentsAccountView />);
    const feed = () => within(screen.getByRole("region", { name: t.recentActivityHeading }));
    expect(feed().getAllByText(t.historyEventDeposit)).toHaveLength(20);
    fireEvent.click(screen.getByRole("button", { name: t.activityShowMore }));
    expect(feed().getAllByText(t.historyEventDeposit)).toHaveLength(25);
    expect(screen.queryByRole("button", { name: t.activityShowMore })).toBeNull();
  });

  // 028-7: the history route's own states.
  const route = (over: Record<string, unknown>, data: Record<string, unknown> = {}) => {
    state.chainHistory = {
      data: { events: S217_EVENTS, names: {}, loading: false, upToDate: true, unavailable: false, ...data },
      isError: false,
      refetch: vi.fn(),
      ...over,
    };
  };

  it("while the account's history still loads, the rows show and so does the note", () => {
    route({}, { loading: true });
    render(<IntentsAccountView />);
    expect(screen.getByText("Changed the mix of “Portfolio 1”")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(t.activityHistoryLoading);
  });

  it("still behind after the re-reads: the latest may be missing", () => {
    route({ outOfDate: true }, { upToDate: false });
    render(<IntentsAccountView />);
    expect(screen.getByText(t.historyMayBeBehind)).toBeTruthy();
  });

  it("past the cap the history is not available: no finished rows, a note instead", () => {
    route({}, { unavailable: true });
    render(<IntentsAccountView />);
    expect(screen.getByText(t.historyUnavailable)).toBeTruthy();
    expect(screen.queryByText("Changed the mix of “Portfolio 1”")).toBeNull();
  });

  it("with more pages on the server, 'Show more' asks for the next one once the loaded rows run out", () => {
    const fetchNextPage = vi.fn();
    route({ hasNextPage: true, fetchNextPage });
    render(<IntentsAccountView />);
    fireEvent.click(screen.getByRole("button", { name: t.activityShowMore }));
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it("with the vault round-trip off (Preview) there is no history read and no history state", () => {
    state.vaultOn = false;
    render(<IntentsAccountView />);
    expect(screen.queryByText(t.activityHistoryLoading)).toBeNull();
    expect(screen.queryByRole("heading", { name: t.recentActivityHeading })).toBeNull();
  });
});

// 021 R3 + R4: the summary is the same in every state, and "In portfolios" says how many.
// Priced at the registry fallback (no live prices in these tests): NEAR = $1.58.
describe("IntentsAccountView — the account summary (021 R3 + R4)", () => {
  const summary = () => screen.getByText(t.myAccountTotalValue).closest("dl")!;
  // Each figure is the <dd> right after its label's <dt>.
  const figure = (label: string) =>
    within(summary())
      .getAllByRole("term")
      .find((dt) => dt.textContent!.startsWith(label))!.nextElementSibling!.textContent;
  const inPortfoliosLabel = () =>
    within(summary())
      .getAllByRole("term")
      .find((dt) => dt.textContent!.startsWith(t.myAccountInPortfolios))!.textContent;
  // The summary's buttons, not the empty state's Deposit below it.
  const summaryButtons = () => summary().parentElement!.parentElement!;
  const withdraw = () => within(summaryButtons()).getByRole("button", { name: t.myAccountWithdraw }) as HTMLButtonElement;

  it("an empty account: every figure at $0, both buttons, Withdraw disabled", () => {
    const { onAddFunds } = renderView();
    expect(figure(t.myAccountTotalValue)).toBe(formatUsd(0));
    expect(figure(t.myAccountGeneralBalance)).toBe(formatUsd(0));
    expect(figure(t.myAccountInPortfolios)).toBe(formatUsd(0));
    expect(inPortfoliosLabel()).toBe(`${t.myAccountInPortfolios} (0)`);
    fireEvent.click(within(summaryButtons()).getByRole("button", { name: t.myAccountAddFunds }));
    expect(onAddFunds).toHaveBeenCalledTimes(1);
    expect(withdraw().disabled).toBe(true);
    // The onboarding below it is unchanged.
    expect(emptyState()).toBeTruthy();
  });

  it("only a General Balance: it is the total, and Withdraw is enabled", () => {
    state.balance = new Map([["near", 1]]);
    renderView();
    expect(figure(t.myAccountTotalValue)).toBe(formatUsd(1.58));
    expect(figure(t.myAccountGeneralBalance)).toBe(formatUsd(1.58));
    expect(figure(t.myAccountInPortfolios)).toBe(formatUsd(0));
    expect(inPortfoliosLabel()).toBe(`${t.myAccountInPortfolios} (0)`);
    expect(withdraw().disabled).toBe(false);
  });

  it("only portfolios: they are the total, counted, and Withdraw is disabled", () => {
    state.portfolios = [
      { id: "p1", name: "One", deposits: { near: 2 } },
      { id: "p2", name: "Two", deposits: { near: 1 } },
    ];
    renderView({ withPortfolios: true });
    expect(figure(t.myAccountTotalValue)).toBe(formatUsd(4.74));
    expect(figure(t.myAccountGeneralBalance)).toBe(formatUsd(0));
    expect(figure(t.myAccountInPortfolios)).toBe(formatUsd(4.74));
    expect(inPortfoliosLabel()).toBe(`${t.myAccountInPortfolios} (2)`);
    expect(withdraw().disabled).toBe(true);
  });

  // D-406: a draft card's button is the one primary — waiting (deposit for it) or ready
  // (confirm it) — so the summary's deposit is outlined while the card is there.
  it("with a draft card, the summary's deposit is outlined, not a second cyan primary", () => {
    const deposit = () => within(summaryButtons()).getByRole("button", { name: t.myAccountAddFunds });
    renderView();
    expect(deposit().className).toContain("bg-cyan-500");

    cleanup();
    saveDraft();
    renderView();
    expect(card()).toBeTruthy();
    expect(deposit().className).not.toContain("bg-cyan-500");
    expect(deposit().className).toContain("border-slate-600");

    cleanup();
    state.balance = new Map([["near", 5]]);
    state.fundable = { status: "known", fundable: true, tokenIds: ["near"], usd: 7.9 };
    renderView();
    expect(screen.getByRole("button", { name: t.draftReadyConfirm }).className).toContain("bg-cyan-500");
    expect(deposit().className).not.toContain("bg-cyan-500");
  });

  // A New Portfolio Draft holds no funds and is not a portfolio until its signature creates
  // it — neither its value nor its existence enters the summary.
  it("a New Portfolio Draft is not counted, waiting or ready", () => {
    state.portfolios = [{ id: "p1", name: "One", deposits: { near: 1 } }];
    saveDraft();
    renderView({ withPortfolios: true });
    expect(card()).toBeTruthy();
    expect(inPortfoliosLabel()).toBe(`${t.myAccountInPortfolios} (1)`);
    expect(figure(t.myAccountInPortfolios)).toBe(formatUsd(1.58));

    cleanup();
    state.balance = new Map([["near", 5]]);
    state.fundable = { status: "known", fundable: true, tokenIds: ["near"], usd: 7.9 };
    renderView({ withPortfolios: true });
    expect(screen.getByRole("button", { name: t.draftReadyConfirm })).toBeTruthy();
    expect(inPortfoliosLabel()).toBe(`${t.myAccountInPortfolios} (1)`);
    expect(figure(t.myAccountTotalValue)).toBe(formatUsd(9.48));
  });
});

// 022-A (D-453): no wallet connected. The same summary at $0, a note that says why, and the
// only money action is connecting.
describe("IntentsAccountView — signed out (022-A)", () => {
  const summary = () => screen.getByText(t.myAccountTotalValue).closest("dl")!;
  const summaryButtons = () => summary().parentElement!.parentElement!;
  const note = () => screen.queryByText(t.myAccountSignedOutNote);

  beforeEach(() => {
    state.accountId = "";
  });

  it("$0 with the note under the figures, Connect Wallet instead of Deposit, Withdraw disabled", () => {
    const { onConnect, onWithdraw, onAddFunds } = renderView({ signedOut: true });
    expect(within(summary()).getAllByRole("definition")[0].textContent).toBe(formatUsd(0));
    // In line, inside the totals' card: not a banner of its own.
    expect(note()).toBeTruthy();
    expect(summary().parentElement!.contains(note())).toBe(true);

    fireEvent.click(within(summaryButtons()).getByRole("button", { name: t.walletConnect }));
    expect(onConnect).toHaveBeenCalledTimes(1);

    const withdraw = within(summaryButtons()).getByRole("button", { name: t.myAccountWithdraw }) as HTMLButtonElement;
    expect(withdraw.disabled).toBe(true);
    expect(withdraw.title).toBe(t.myAccountWithdrawSignedOutHint);
    fireEvent.click(withdraw);
    expect(onWithdraw).not.toHaveBeenCalled();

    // No Deposit anywhere on the screen.
    expect(screen.queryByRole("button", { name: t.myAccountAddFunds })).toBeNull();
    expect(onAddFunds).not.toHaveBeenCalled();
  });

  it("the empty state: build first, with the signed-out steps", () => {
    const { onCreatePortfolio } = renderView({ signedOut: true });
    expect(emptyState()).toBeTruthy();
    const steps = screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
    // The same build-first steps as a new account with a wallet (022-A, operator s242).
    expect(steps[0]).toContain(t.onboardingStep2Title);
    expect(steps[0]).toContain(t.onboardingBuildFirstBody); // 022-I
    expect(steps[1]).toContain(t.onboardingStep1Title);
    // No step marked as current: nothing has been done yet, and nothing can be signed out.
    expect(screen.getAllByRole("listitem").some((li) => li.getAttribute("aria-current"))).toBe(false);

    const build = screen.getByRole("button", { name: t.myAccountBuild });
    expect(build.className).toContain("bg-cyan-500");
    expect(build.hasAttribute("data-focus-landing")).toBe(true);
    fireEvent.click(build);
    expect(onCreatePortfolio).toHaveBeenCalledTimes(1);
    // No Deposit beside it: there is no wallet to deposit from.
    expect(screen.queryByRole("button", { name: t.myAccountAddFunds })).toBeNull();
  });

  // 022-B: My Account opens signed out with a draft too. Its card connects; there is no
  // balance to deposit to or confirm from yet.
  it("with a draft: its signed-out card instead of the empty state, connecting or going to its tab", () => {
    saveDraft(ANONYMOUS_DRAFT_SLOT);
    // Whatever the balance hook says: signed out it reads no account.
    state.fundable = { status: "known", fundable: true, tokenIds: ["near"], usd: 5 };
    const { onConnect, onViewDraft, onDepositForDraft, onConfirmDraft } = renderView({ signedOut: true });
    expect(screen.getByRole("heading", { name: "Your portfolio “My mix” is saved in this browser" })).toBeTruthy();
    expect(card()).toBeNull();
    expect(emptyState()).toBeNull();
    // 022-D (D-455): one draft per account, so the steps are not offered again here either.
    expect(screen.queryByText(t.onboardingStepsLabel)).toBeNull();
    expect(screen.queryByRole("button", { name: t.draftCardDeposit })).toBeNull();
    expect(screen.queryByRole("button", { name: t.draftReadyConfirm })).toBeNull();
    expect(screen.queryByRole("button", { name: t.myAccountAddFunds })).toBeNull();
    // The note stays with the $0: the card does not replace it.
    expect(note()).toBeTruthy();

    // Two Connect Wallet: the summary's (outlined) and the card's (the one primary, D-406).
    const connects = screen.getAllByRole("button", { name: t.walletConnect });
    expect(connects).toHaveLength(2);
    const cardConnect = connects.find((b) => b.className.includes("bg-cyan-500"))!;
    expect(summaryButtons().contains(cardConnect)).toBe(false);
    fireEvent.click(cardConnect);
    expect(onConnect).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: t.draftCardView }));
    expect(onViewDraft).toHaveBeenCalledTimes(1);
    expect(onDepositForDraft).not.toHaveBeenCalled();
    expect(onConfirmDraft).not.toHaveBeenCalled();
  });

  it("signed in (control): Deposit in the summary only, no note", () => {
    state.accountId = ACCOUNT;
    renderView();
    expect(note()).toBeNull();
    expect(within(summaryButtons()).getByRole("button", { name: t.myAccountAddFunds })).toBeTruthy();
    expect(within(summaryButtons()).queryByRole("button", { name: t.walletConnect })).toBeNull();
    // Build is the empty state's own button; no Deposit beside it (D-450).
    expect(screen.getByRole("button", { name: t.myAccountBuild })).toBeTruthy();
  });
});

describe("IntentsAccountView — D-335: other tokens inside the General Balance", () => {
  it("lists them as a subsection of the same section, not a section of their own", () => {
    state.balance = new Map([
      ["near", 5],
      ["nep141:usn", 1],
    ]);
    render(<IntentsAccountView />);
    const section = screen.getByRole("region", { name: t.myAccountGeneralBalance });
    expect(section.querySelector("h3")?.textContent).toBe(t.myAccountOtherBalances);
    expect(screen.queryAllByRole("heading", { level: 2, name: t.myAccountOtherBalances })).toHaveLength(0);
  });
});

describe("IntentsAccountView — Converting Withdrawal rows (D-392, plan 020 §5.4)", () => {
  const USDT_POL = "nep245:v2_1.omni.hot.tg:137_3hpYoaLtt8MP1Z2GH1U473DMRKgr";
  const row = (status: WithdrawalInFlightRecord["status"], extra: Partial<WithdrawalInFlightRecord> = {}) =>
    ({
      intentId: `w-${status}`,
      tokenId: USDT_POL,
      qty: 5,
      chainId: "near:mainnet",
      destinationAddress: "alice.near",
      status,
      ts: 1_000,
      isReal: true,
      deliveryTokenId: "nep141:usdt.tether-token.near",
      depositAddress: "abcdef" + "0".repeat(54) + "9b1c",
      ...extra,
    }) as WithdrawalInFlightRecord;
  const feed = () => within(screen.getByRole("region", { name: t.recentActivityHeading }));

  it("names what arrives, and says Converting once the transfer settled", () => {
    render(<IntentsAccountView pendingWithdrawals={[row("SETTLED")]} />);
    expect(feed().getByText(t.withdrawalStatusConverting)).toBeTruthy();
    expect(feed().getByText(/as USDT/)).toBeTruthy();
    expect(feed().queryByText(t.withdrawalStatusSettled)).toBeNull();
  });

  it("a refund has its own label, never Failed or Pending", () => {
    render(<IntentsAccountView pendingWithdrawals={[row("REFUNDED")]} />);
    expect(feed().getByText(t.withdrawalStatusRefunded)).toBeTruthy();
    expect(feed().queryByText(t.withdrawalStatusFailed)).toBeNull();
    expect(feed().queryByText(t.withdrawalStatusPending)).toBeNull();
  });

  it("an unconfirmed conversion shows the code to quote instead of the hash; other states do not", () => {
    const txHash = "9xT" + "1".repeat(40) + "abc";
    render(<IntentsAccountView pendingWithdrawals={[row("UNCONFIRMED", { txHash })]} />);
    expect(feed().getByText("ref. abcdef…9b1c")).toBeTruthy();
    expect(feed().queryByText(/^9xT/)).toBeNull();
    cleanup();
    render(<IntentsAccountView pendingWithdrawals={[row("SETTLED", { txHash })]} />);
    expect(feed().queryByText(/^ref\. /)).toBeNull();
    expect(feed().getByText(/^9xT/)).toBeTruthy();
  });

  // D-440: a finished conversion has no chain row to hand over to, so its own row is filed with
  // the finished ones by date — and pages with them — instead of pinning on top for a month.
  describe("once it is over", () => {
    const deposits: ChainHistoryEvent[] = Array.from({ length: 25 }, (_, i) => ({
      txHash: `h${i}`,
      index: 0,
      ts: 1_000 + i,
      event: "intents:deposit",
      data: { account_id: "pablofork.near", token: "nep141:usdt.tether-token.near", amount: "1000000" },
    }));
    beforeEach(() => {
      state.vaultOn = true;
      state.chainHistory = { data: deposits, isError: false, refetch: vi.fn() };
    });

    it("sits among the finished rows by its date", () => {
      render(<IntentsAccountView pendingWithdrawals={[row("DELIVERED", { ts: 1_012 })]} />);
      const conversion = feed().getByText(/as USDT/);
      const deposit = (n: number) => feed().getAllByText(t.historyEventDeposit)[n];
      // Newest first: deposits 1024…1013 above it, 1012 (chain row wins the tie) and older below.
      expect(deposit(11).compareDocumentPosition(conversion) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(deposit(13).compareDocumentPosition(conversion) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
      // Its label opens the date line, like the chain's finished rows (027 A-5).
      expect(feed().getByText(t.withdrawalStatusDelivered).closest("p")?.textContent).toMatch(/as USDT/);
    });

    it("an old one pages with them, a refund too", () => {
      render(<IntentsAccountView pendingWithdrawals={[row("REFUNDED", { ts: 1 })]} />);
      expect(feed().queryByText(t.withdrawalStatusRefunded)).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: t.activityShowMore }));
      expect(feed().getByText(t.withdrawalStatusRefunded)).toBeTruthy();
    });

    it("while in progress it stays on top, whatever its date", () => {
      render(<IntentsAccountView pendingWithdrawals={[row("SETTLED", { ts: 1 })]} />);
      const conversion = feed().getByText(/as USDT/);
      const firstDeposit = feed().getAllByText(t.historyEventDeposit)[0];
      expect(firstDeposit.compareDocumentPosition(conversion) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    });
  });

  it("a direct withdrawal's row is unchanged", () => {
    render(
      <IntentsAccountView
        pendingWithdrawals={[row("SETTLED", { deliveryTokenId: undefined, depositAddress: undefined })]}
      />
    );
    expect(feed().getByText(t.withdrawalStatusSettled)).toBeTruthy();
    expect(feed().queryByText(/as USDT/)).toBeNull();
  });

  it("SOL sent to NEAR names the NEAR token it lands as (D-386 a)", () => {
    render(
      <IntentsAccountView
        pendingWithdrawals={[
          row("SETTLED", { tokenId: "nep141:sol.omft.near", deliveryTokenId: undefined, depositAddress: undefined }),
        ]}
      />
    );
    expect(feed().getByText(/as sol\.omft\.near/)).toBeTruthy();
  });
});

describe("IntentsAccountView — «Hide» on a withdrawal nothing could close (D-463, 023-B)", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = 1_000 + DAY + 1;
  const row = (status: WithdrawalInFlightRecord["status"], extra: Partial<WithdrawalInFlightRecord> = {}) =>
    ({
      intentId: `w-${status}`,
      tokenId: "nep141:wrap.near",
      qty: 1,
      chainId: "near:mainnet",
      destinationAddress: "towanda187.near",
      status,
      ts: 1_000,
      isReal: true,
      ...extra,
    }) as WithdrawalInFlightRecord;
  const feed = () => within(screen.getByRole("region", { name: t.recentActivityHeading }));
  const hide = () => feed().queryByRole("button", { name: t.withdrawalHide });

  beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(NOW));
  afterEach(() => vi.restoreAllMocks());

  it("says it is unknown, names the destination, and hides on one click", () => {
    const onDismiss = vi.fn();
    render(<IntentsAccountView pendingWithdrawals={[row("TX_BROADCASTED")]} onDismissWithdrawal={onDismiss} />);
    expect(feed().getByText(/couldn't confirm this withdrawal yet/)).toBeTruthy();
    expect(feed().getByText("towand…near")).toBeTruthy();
    fireEvent.click(hide()!);
    expect(onDismiss).toHaveBeenCalledWith("w-TX_BROADCASTED");
  });

  it("says it left the balance when that is known", () => {
    render(
      <IntentsAccountView
        pendingWithdrawals={[row("UNCONFIRMED", { leftBalance: true })]}
        onDismissWithdrawal={vi.fn()}
      />
    );
    expect(feed().getByText(/Left your funding account; delivery to/)).toBeTruthy();
    expect(feed().queryByText(/couldn't confirm/)).toBeNull();
  });

  it("not before a full day, not on a mock row (the rest of the rule: withdrawals-in-flight.test)", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000 + DAY);
    render(<IntentsAccountView pendingWithdrawals={[row("UNCONFIRMED")]} onDismissWithdrawal={vi.fn()} />);
    expect(hide()).toBeNull();
    cleanup();
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    render(
      <IntentsAccountView
        pendingWithdrawals={[row("SETTLED", { isReal: false })]}
        onDismissWithdrawal={vi.fn()}
      />
    );
    expect(hide()).toBeNull();
  });
});

// D-421 (a): the PoA bridge names NEAR `wrap.near`, which the registry keys `near`.
describe("IntentsAccountView — a bridge deposit row names its token (D-421)", () => {
  const depositRowText = (near_token_id: string) => {
    const deposit = {
      tx_hash: "0xabc",
      chain: "near:mainnet",
      near_token_id,
      decimals: 24,
      amount: 5e23,
      status: "COMPLETED",
      address: "alice.near",
    } as unknown as DepositStatusEntry;
    render(<IntentsAccountView onAddFunds={vi.fn()} onCreatePortfolio={vi.fn()} deposits={[deposit]} />);
    // The onboarding step "Deposit" is a span too (029 B-19): only the activity row counts.
    return screen.getByText(t.historyEventDeposit, { selector: "span:not([data-step-title])" }).parentElement?.textContent;
  };

  it("wrap.near reads as NEAR", () => {
    expect(depositRowText("wrap.near")).toBe(`${t.historyEventDeposit}0.50 NEAR`);
  });

  it("an id the registry does not know still falls back to the id", () => {
    expect(depositRowText("unknown.near")).toBe(`${t.historyEventDeposit}0.50 unknown.near`);
  });
});

// D-524: each Funding account row shows what one token is worth, under its name.
describe("IntentsAccountView — the price of one token on each row (D-524)", () => {
  it("shows the unit price, and nothing for a token without one", () => {
    const near = getTokenById("near")!;
    state.balance = new Map([
      ["near", 2],
      ["unknown.near", 3],
    ]);
    renderView({ withPortfolios: true });
    const nearRow = screen.getByText(near.name).parentElement!;
    expect(within(nearRow).getByText(formatUsd(near.fallbackUsdPrice!))).toBeTruthy();
    const unknownRow = screen.getAllByText("unknown.near")[0].parentElement!;
    expect(unknownRow.querySelectorAll("p")).toHaveLength(2);
  });
});

// D-541: with the balance read down, the mock fallback (empty for a real account) was shown as a
// $0 funding account and "your funding account is empty".
describe("IntentsAccountView — the funding account not read yet", () => {
  const totalsCard = () => screen.getByText(t.myAccountTotalValue).closest("dl")!;

  it("a failed first read: no $0 and no empty state — the error, with a Retry that re-reads", () => {
    const retry = vi.fn();
    state.balanceRead = { status: "error", retry };
    state.portfolios = [{ id: "p1", name: "Mine", deposits: {} }];
    renderView({ withPortfolios: true });
    expect(screen.getByRole("alert").textContent).toContain(t.myAccountBalanceUnreadable);
    expect(screen.queryByText(t.myAccountEmptyBodyWithPortfolios)).toBeNull();
    expect(within(totalsCard()).getAllByText("—")).toHaveLength(2); // total and funding account
    fireEvent.click(screen.getByRole("button", { name: t.myAccountBalanceRetry }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("while the first read is in flight: says it is reading, not that it is empty", () => {
    state.balanceRead = { status: "loading" };
    renderView();
    expect(screen.getByRole("status").textContent).toBe(t.myAccountBalanceChecking);
    expect(emptyState()).toBeNull();
    expect(within(totalsCard()).getAllByText("—")).toHaveLength(2);
  });

  it("a balance on screen (a refresh failed after a read) stays as it is", () => {
    state.balanceRead = { status: "error", retry: vi.fn() };
    state.balance = new Map([["near", 2]]);
    renderView();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(within(totalsCard()).queryByText("—")).toBeNull();
  });

  it("a draft with the read failed: the card waits, it does not ask for a deposit", () => {
    saveDraft();
    state.fundable = { status: "error", retry: vi.fn() };
    state.balanceRead = { status: "error", retry: vi.fn() };
    renderView();
    expect(card()).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain(t.myAccountBalanceUnreadable);
  });

  it("signed out: the signed-out $0 as before, no read error", () => {
    state.balanceRead = { status: "error", retry: vi.fn() };
    renderView({ signedOut: true });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("IntentsAccountView — selling a stock (plan 039)", () => {
  const NVDA_ID = "nep141:bnb-0xa9ee28c80f960b889dfbd1902055218cba016f75.omdep.near";
  const holdings = () =>
    new Map([
      [NVDA_ID, 0.05],
      ["nep141:usdt.tether-token.near", 10],
    ]);

  it("offers Sell on a stock and on nothing else, and asks the shell for that stock", () => {
    state.balance = holdings();
    const onSellStock = vi.fn();
    render(<IntentsAccountView onSellStock={onSellStock} />);
    expect(screen.getAllByRole("button", { name: /^Sell / })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Sell NVDA" }));
    expect(onSellStock).toHaveBeenCalledWith(NVDA_ID);
  });

  it("offers no Sell when the shell has none to give", () => {
    state.balance = holdings();
    render(<IntentsAccountView />);
    expect(screen.queryByRole("button", { name: /^Sell / })).toBeNull();
  });
});
