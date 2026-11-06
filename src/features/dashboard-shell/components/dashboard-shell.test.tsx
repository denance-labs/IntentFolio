// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { FundableGeneralBalance } from "../hooks/use-fundable-general-balance";
import {
  ANONYMOUS_DRAFT_SLOT,
  NEW_PORTFOLIO_DRAFT_KEY,
  readNewPortfolioDraft,
  type NewPortfolioDraft,
} from "../lib/new-portfolio-draft";
import {
  getDashboardSection,
  getSignedOutSection,
  setDashboardSection,
  setSignedOutSection,
} from "../lib/portfolio-ui-prefs";
import { shellTranslations } from "../lib/translations";

// 016 block 2.4 — the shell's part of confirming a New Portfolio Draft: no "ready" strip on
// the portfolio tabs (D-517), B1 (a wallet deposit continuing into the confirmation) and landing on
// the new portfolio. 016 block 2.5 — the welcome, which only the wallet menu opens (022-I). D-359 — signed out: the way into a draft, its card, and its move to the
// account on connecting. 019-4 — the draft as a tab: which section is on screen, where saving,
// discarding and connecting land. The children are stubs that record the props the shell
// hands them.

const ACCOUNT = "alice.near";

const state = vi.hoisted(() => ({
  pendingAllocates: undefined as undefined | Array<{ id: string; op: string; portfolioId: string | null }>,
  login: { status: "connected", intentsAccountId: "alice.near" },
  portfolios: [] as Array<{ id: string; name: string; deposits: Record<string, number> }>,
  portfoliosLoading: false,
  portfoliosError: null as Error | null,
  portfoliosRefreshFailed: false,
  refetchPortfolios: (() => {}) as () => void,
  // The on-chain General Balance read: `undefined` until it has answered once.
  balances: undefined as Map<string, number> | undefined,
  draft: null as NewPortfolioDraft | null,
  discardDraft: (() => {}) as () => void,
  saveDraft: (() => ({ ok: true })) as (...args: unknown[]) => unknown,
  fundable: { status: "known", fundable: false, tokenIds: [], usd: 0 } as FundableGeneralBalance,
  receiveProps: null as null | Record<string, unknown>,
  flowProps: null as null | Record<string, unknown>,
  tabsProps: null as null | Record<string, unknown>,
  viewProps: null as null | Record<string, unknown>,
  accountProps: null as null | Record<string, unknown>,
  withdrawalHooks: null as null | Record<string, (record: unknown) => void>,
  depositHooks: null as null | { onCredited: (deposit: unknown) => void },
  announce: vi.fn(),
  headerInWalletMenuOnly: undefined as boolean | undefined,
  routerPush: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: state.routerPush }) }));

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("../context/language-context", () => ({ useLanguage: () => ({ lang: "en", setLang: vi.fn() }) }));
vi.mock("@/features/vault/hooks/use-pending-allocates", () => ({
  usePendingAllocates: () => ({ pending: state.pendingAllocates, isFetching: false }),
}));
vi.mock("../context/portfolio-context", () => ({
  usePortfolio: () => ({
    portfolios: state.portfolios,
    portfoliosLoading: state.portfoliosLoading,
    portfoliosError: state.portfoliosError,
    portfoliosRefreshFailed: state.portfoliosRefreshFailed,
    refetchPortfolios: state.refetchPortfolios,
    draftState: null,
    activePortfolioId: state.portfolios[0]?.id ?? null,
    setActivePortfolioId: vi.fn(),
    setDraftState: vi.fn(),
  }),
}));
vi.mock("@/features/login-wallet", () => ({
  useLoginWallet: () => ({ ...state.login, keyVerification: null, verifyKey: vi.fn() }),
  ensureCanOperate: vi.fn(),
  NearKeyVerificationNotice: () => null,
  WalletPicker: () => <div>wallet-picker</div>,
}));
vi.mock("@/features/bridge", () => ({
  ReceiveModal: (props: Record<string, unknown>) => {
    state.receiveProps = props;
    return props.open ? <div>receive-open</div> : null;
  },
  WithdrawalModal: () => null,
  useRecentDeposits: (hooks: { onCredited: (deposit: unknown) => void }) => {
    state.depositHooks = hooks;
    return { deposits: [] };
  },
  usePendingWithdrawals: (hooks: Record<string, (record: unknown) => void>) => {
    state.withdrawalHooks = hooks;
    return [];
  },
  dismissWithdrawal: () => false,
}));
vi.mock("@/features/wallet/hooks/use-intents-balances", () => ({
  intentsBalancesQueryKey: (id: string) => ["intents-balances", id],
  useIntentsBalances: () => ({ data: state.balances }),
}));
vi.mock("@/features/vault/hooks/use-live-signer", () => ({ useLiveSigner: () => null }));
vi.mock("@/features/vault/hooks/use-real-portfolio-history", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/vault/hooks/use-real-portfolio-history")>()),
  announceOperation: (...args: unknown[]) => state.announce(...args),
  // 029 B-23: the "funds to assign" prompt reads the history route only after an answer.
  useAccountHistory: () => ({ data: undefined, isLoading: false, outOfDate: false }),
}));
vi.mock("../hooks/use-pending-unallocations", () => ({ usePendingUnallocations: () => [] }));
vi.mock("../hooks/use-new-portfolio-draft", () => ({
  useNewPortfolioDraft: () => ({ draft: state.draft, discard: state.discardDraft, save: state.saveDraft }),
}));
vi.mock("../hooks/use-fundable-general-balance", () => ({ useFundableGeneralBalance: () => state.fundable }));
vi.mock("./dashboard-header", () => ({
  DashboardHeader: ({
    onGettingStarted,
    inWalletMenuOnly,
  }: {
    onGettingStarted?: () => void;
    inWalletMenuOnly?: boolean;
  }) => {
    state.headerInWalletMenuOnly = inWalletMenuOnly;
    return onGettingStarted ? (
      <button type="button" onClick={onGettingStarted}>
        menu-getting-started
      </button>
    ) : null;
  },
}));
vi.mock("./sub-nav", () => ({ SubNav: ({ draft }: { draft?: boolean }) => <div>{draft ? "sub-nav-draft" : "sub-nav"}</div> }));
vi.mock("./unsaved-changes-modal", () => ({
  UnsavedChangesModal: (props: { draft?: boolean; onDiscard: () => void; onClose: () => void }) => (
    <div>
      {props.draft ? "unsaved-changes:draft" : "unsaved-changes:portfolio"}
      <button
        type="button"
        onClick={() => {
          props.onDiscard();
          props.onClose();
        }}
      >
        unsaved-discard
      </button>
    </div>
  ),
}));
vi.mock("./portfolio-tabs", () => ({
  PortfolioTabs: (props: {
    onMiCuentaClick: () => void;
    draftTab?: { name: string; active: boolean; onSelect: () => void };
    onNewPortfolio?: () => void;
  }) => {
    state.tabsProps = props;
    return (
      <div>
        <button type="button" onClick={props.onMiCuentaClick}>tab-my-account</button>
        {props.draftTab && (
          <button type="button" onClick={props.draftTab.onSelect}>
            tab-draft
          </button>
        )}
        <button type="button" onClick={props.onNewPortfolio}>tabs-new</button>
      </div>
    );
  },
}));
vi.mock("./new-portfolio-draft-view", () => ({
  NewPortfolioDraftView: (props: {
    variant: string;
    onConnect?: () => void;
    onDeposit?: () => void;
    onConfirm?: () => void;
    onSaveRows: (rows: unknown[]) => unknown;
    onUnsavedChange?: (unsaved: boolean) => void;
    onDiscard: () => void;
  }) => {
    state.viewProps = props;
    return (
      <div>
        {`draft-view:${props.variant}`}
        <button type="button" onClick={props.onConnect ?? props.onDeposit ?? props.onConfirm}>view-primary</button>
        <button type="button" onClick={() => props.onSaveRows(EDITED_ROWS)}>view-save</button>
        <button type="button" onClick={() => props.onUnsavedChange?.(true)}>view-edit-unsaved</button>
        <button type="button" onClick={props.onDiscard}>view-discard</button>
      </div>
    );
  },
}));
vi.mock("./intents-account-view", () => ({
  IntentsAccountView: (props: {
    onAddFunds?: () => void;
    onCreatePortfolio?: () => void;
    onDepositForDraft?: () => void;
    onViewDraft?: () => void;
    onConfirmDraft?: () => void;
    signedOut?: boolean;
    onConnect?: () => void;
  }) => {
    state.accountProps = props;
    return (
      <div>
        {props.signedOut ? "my-account-view:signed-out" : "my-account-view"}
        <button type="button" onClick={props.onAddFunds}>plain-deposit</button>
        <button type="button" onClick={props.onCreatePortfolio}>account-build</button>
        <button type="button" onClick={props.onConnect}>account-connect</button>
        <button type="button" onClick={props.onDepositForDraft}>card-deposit</button>
        <button type="button" onClick={props.onConfirmDraft}>card-confirm</button>
        <button type="button" onClick={props.onViewDraft}>card-view</button>
      </div>
    );
  },
}));
vi.mock("./create-portfolio-flow", () => ({
  CreatePortfolioFlow: (props: { onCreated?: () => void; onDraftSaved?: () => void; onClose: () => void }) => {
    state.flowProps = props;
    return (
      <div>
        create-flow
        <button type="button" onClick={props.onCreated}>flow-created</button>
        <button type="button" onClick={props.onDraftSaved}>flow-draft-saved</button>
      </div>
    );
  },
}));

import { DashboardShell } from "./dashboard-shell";

const t = shellTranslations.en;

const DRAFT: NewPortfolioDraft = {
  v: 1,
  name: "My mix",
  presetId: null,
  rows: [{ tokenId: "near", targetPct: 100, tolerancePct: 10, locked: false }],
  updatedAt: 1,
};
const EDITED_ROWS = [
  { tokenId: "near", targetPct: 60, tolerancePct: 10, locked: false },
  { tokenId: "nep141:btc.omft.near", targetPct: 40, tolerancePct: 10, locked: false },
];
const READY: FundableGeneralBalance = { status: "known", fundable: true, tokenIds: ["near"], usd: 5 };
const READY_LINE = t.draftReadyTitle.replace("{amount}", "$5.00").replace("{name}", "My mix");
// The strip, not the B-23 window with the same line.
const strip = () => screen.queryAllByRole("status").find((el) => el.textContent?.includes(READY_LINE)) ?? null;
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

function renderShell(basePath?: string) {
  const shell = () => (
    <DashboardShell basePath={basePath}>
      <div>portfolio-content</div>
    </DashboardShell>
  );
  const view = render(shell());
  return { rerender: () => view.rerender(shell()) };
}

beforeEach(() => {
  state.login = { status: "connected", intentsAccountId: ACCOUNT };
  state.discardDraft = vi.fn();
  state.saveDraft = vi.fn(() => ({ ok: true }));
  state.portfolios = [];
  state.portfoliosLoading = false;
  state.portfoliosError = null;
  state.portfoliosRefreshFailed = false;
  state.refetchPortfolios = vi.fn();
  state.balances = undefined;
  state.draft = null;
  state.fundable = { status: "known", fundable: false, tokenIds: [], usd: 0 };
  state.receiveProps = null;
  state.flowProps = null;
  state.tabsProps = null;
  state.pendingAllocates = undefined;
  state.routerPush.mockClear();
  state.viewProps = null;
  state.accountProps = null;
  state.headerInWalletMenuOnly = undefined;
  state.announce = vi.fn();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("DashboardShell — no ready strip on the portfolio tabs", () => {
  beforeEach(() => {
    state.portfolios = [{ id: "p1", name: "Old", deposits: {} }];
    state.draft = DRAFT;
    state.fundable = READY;
  });

  // D-517: the strip is gone from the portfolio tabs; My Account's card, the draft's tab and the
  // one-time prompt carry the line.
  it("is not on a portfolio tab (D-517)", () => {
    renderShell();
    expect(screen.getByText("portfolio-content")).toBeTruthy();
    expect(strip()).toBeNull();
  });
});

describe("DashboardShell — B1, a wallet deposit continuing into the confirmation", () => {
  beforeEach(() => {
    state.draft = DRAFT;
    // My Account's card; the draft's tab deposits the same way (below, 019-4).
    setDashboardSection(ACCOUNT, "account");
  });

  it("the deposit opened for the draft carries its context and the continuation", () => {
    renderShell();
    click("card-deposit");
    expect(state.receiveProps).toMatchObject({ open: true, draftContext: { name: "My mix", tokenIds: ["near"] } });
    expect(typeof state.receiveProps!.onConfirmDraft).toBe("function");
  });

  // The plain "Deposit" is not for the draft: no framing, so no continuation either.
  it("the plain deposit carries no draft context", () => {
    renderShell();
    click("plain-deposit");
    expect(state.receiveProps).toMatchObject({ open: true, draftContext: undefined });
  });

  it("closes the deposit and waits for the credited quantity, in whole tokens", () => {
    renderShell();
    click("card-deposit");
    const onConfirmDraft = state.receiveProps!.onConfirmDraft as (credit: unknown) => void;
    act(() => onConfirmDraft({ tokenId: "near", amount: BigInt(2) * BigInt(10) ** BigInt(24), txHash: "tx1" }));

    expect(screen.queryByText("receive-open")).toBeNull();
    expect(state.receiveProps).toMatchObject({ open: false });
    expect(screen.getByText("create-flow")).toBeTruthy();
    expect(state.flowProps).toMatchObject({ afterDeposit: { tokenId: "near", qty: 2 } });
  });
});

// 028-7 (d): a deposit credited or a withdrawal delivered tells the history, with the NEAR hash
// when there is one; without it the history is asked to catch up (`fresh`).
describe("DashboardShell — telling the history", () => {
  const told = () => state.announce.mock.calls.map(([, account, txHash]) => [account, txHash]);
  const walletDeposit = (txHash: string | null) =>
    act(() =>
      (state.receiveProps!.onWalletDepositCredited as (credit: unknown) => void)({
        tokenId: "near",
        amount: BigInt(10) ** BigInt(24),
        txHash,
      })
    );

  it("a wallet deposit hands over its NEAR hash", () => {
    renderShell();
    walletDeposit("9wDepositTx");
    expect(told()).toEqual([[ACCOUNT, "9wDepositTx"]]);
  });

  it("a wallet deposit without a hash asks for a catch-up, never its synthetic key", () => {
    renderShell();
    walletDeposit(null);
    expect(told()).toEqual([[ACCOUNT, null]]);
  });

  it("a bridge deposit asks for a catch-up: its hash is the origin chain's", () => {
    renderShell();
    act(() =>
      state.depositHooks!.onCredited({
        near_token_id: "nep141:wrap.near",
        amount: 10 ** 24,
        decimals: 24,
        chain: "eth:1",
        tx_hash: "0x" + "ab".repeat(32),
      })
    );
    expect(told()).toEqual([[ACCOUNT, null]]);
  });

  it("a delivered withdrawal hands over its settlement", () => {
    renderShell();
    act(() => state.withdrawalHooks!.onDelivered({ tokenId: "near", chainId: "near:mainnet", qty: 1, txHash: "SettleTx" }));
    expect(told()).toEqual([[ACCOUNT, "SettleTx"]]);
  });
});

describe("DashboardShell — landing on the new portfolio", () => {
  it("a confirmation from My Account leaves My Account for the portfolio", () => {
    state.portfolios = [{ id: "p1", name: "Old", deposits: {} }];
    state.draft = DRAFT;
    state.fundable = READY;
    setDashboardSection(ACCOUNT, "account");
    renderShell();
    expect(screen.getByText("my-account-view")).toBeTruthy();

    click("card-confirm");
    click("flow-created");
    expect(screen.getByText("portfolio-content")).toBeTruthy();
    expect(getDashboardSection(ACCOUNT)).toBe("portfolio");
  });

  it("so does a portfolio created from the tabs' \"+\"", () => {
    state.portfolios = [{ id: "p1", name: "Old", deposits: {} }];
    setDashboardSection(ACCOUNT, "account");
    renderShell();
    click("tabs-new");
    expect(state.flowProps).toMatchObject({ startNew: true });
    click("flow-created");
    expect(screen.getByText("portfolio-content")).toBeTruthy();
    expect(getDashboardSection(ACCOUNT)).toBe("portfolio");
  });
});

describe("DashboardShell — the welcome of a new account (016 block 2.5, 022-I)", () => {
  const welcome = () => screen.queryByRole("dialog", { name: t.welcomeTitle });

  // 022-I (D-459): a new account (portfolios read, none, balance read and empty, no draft) lands
  // on My Account, which shows the same steps and button. The welcome no longer opens on its own.
  it("does not open on its own for a new account: My Account is on screen", () => {
    state.balances = new Map();
    renderShell();
    expect(welcome()).toBeNull();
    expect(screen.getByText("my-account-view")).toBeTruthy();
  });

  it("nor when a restoring session of a new account connects", () => {
    state.balances = new Map();
    state.login = { status: "restoring", intentsAccountId: ACCOUNT };
    const { rerender } = renderShell();
    state.login = { status: "connected", intentsAccountId: ACCOUNT };
    rerender();
    expect(welcome()).toBeNull();
  });

  it.each([
    ["\"Not now\"", () => click(t.welcomeNotNow)],
    ["Escape", () => fireEvent.keyDown(document, { key: "Escape" })],
  ])("%s closes it without starting anything", (_label, close) => {
    renderShell();
    click("menu-getting-started");
    expect(welcome()).toBeTruthy();
    close();
    expect(welcome()).toBeNull();
    expect(state.flowProps).toBeNull();
  });

  it("its CTA closes it and opens the creation flow", () => {
    renderShell();
    click("menu-getting-started");
    expect(screen.getAllByText(t.onboardingStep1Title).length).toBeGreaterThan(0);
    click(t.welcomeCta);
    expect(welcome()).toBeNull();
    expect(screen.getByText("create-flow")).toBeTruthy();
    expect(state.flowProps).toMatchObject({ afterDeposit: undefined });
  });

  it("\"Getting started\" in the wallet menu opens it, whatever the account holds", () => {
    state.portfolios = [{ id: "p1", name: "Old", deposits: {} }];
    state.fundable = READY;
    renderShell();
    expect(welcome()).toBeNull();

    click("menu-getting-started");
    expect(welcome()).toBeTruthy();
    // Not their first portfolio.
    expect(screen.queryByRole("button", { name: t.welcomeCta })).toBeNull();
    click(t.welcomeCtaAnother);
    expect(screen.getByText("create-flow")).toBeTruthy();
  });

  // 022-D (D-455): one draft per account. Reopened with a draft saved, the CTA leads to its tab
  // and opens no creation.
  it("reopened with a draft, \"View my portfolio\" goes to the draft's tab", () => {
    state.portfolios = [{ id: "p1", name: "Old", deposits: {} }];
    state.draft = DRAFT;
    setDashboardSection(ACCOUNT, "account");
    renderShell();
    expect(screen.getByText("my-account-view")).toBeTruthy();

    click("menu-getting-started");
    expect(screen.queryByRole("button", { name: t.welcomeCtaAnother })).toBeNull();
    click(t.draftCardView);
    expect(welcome()).toBeNull();
    expect(screen.getByText("draft-view:waiting")).toBeTruthy();
    expect(getDashboardSection(ACCOUNT)).toBe("draft");
    expect(screen.queryByText("create-flow")).toBeNull();
  });

  // 022-J (D-460): "Getting started" is in the header without a wallet too.
  describe("signed out", () => {
    beforeEach(() => {
      state.login = { status: "idle", intentsAccountId: "" };
    });

    it("opens it, and its CTA opens the creation flow signed out", () => {
      renderShell();
      click("menu-getting-started");
      expect(welcome()).toBeTruthy();
      click(t.welcomeCta);
      expect(welcome()).toBeNull();
      expect(state.flowProps).toMatchObject({ signedOut: true });
    });

    it("with the anonymous draft, \"View my portfolio\" goes to its tab", () => {
      state.draft = DRAFT;
      renderShell();
      click("tab-my-account");
      expect(screen.getByText("my-account-view:signed-out")).toBeTruthy();
      click("menu-getting-started");
      click(t.draftCardView);
      expect(welcome()).toBeNull();
      expect(screen.getByText("draft-view:signed-out")).toBeTruthy();
      expect(screen.queryByText("create-flow")).toBeNull();
    });

    it("connecting closes it: it was not that account's", () => {
      const { rerender } = renderShell();
      click("menu-getting-started");
      expect(welcome()).toBeTruthy();
      state.login = { status: "connected", intentsAccountId: ACCOUNT };
      rerender();
      expect(welcome()).toBeNull();
    });

    it("while a session restores there is no way to open it", () => {
      state.login = { status: "restoring", intentsAccountId: ACCOUNT };
      renderShell();
      expect(screen.queryByText("menu-getting-started")).toBeNull();
    });
  });
});

describe("DashboardShell — signed out (D-359, 019-2, 022-A)", () => {
  const signedOutAccount = () => screen.queryByText("my-account-view:signed-out");

  beforeEach(() => {
    state.login = { status: "idle", intentsAccountId: "" };
  });

  // 022-A (D-453): My Account at $0 replaced 019-2's start screen.
  it("opens on My Account without a wallet, not on a wall of wallets", () => {
    renderShell();
    expect(signedOutAccount()).toBeTruthy();
    expect(screen.queryByText("wallet-picker")).toBeNull();
    // D-419's strip: My Account selected, no figure (no `values`), no draft tab.
    expect(state.tabsProps).toMatchObject({ miCuentaActive: true, signedOut: true });
    expect(state.tabsProps!.values).toBeUndefined();
    expect(state.tabsProps!.draftTab).toBeUndefined();
    expect(screen.queryByText("portfolio-content")).toBeNull();
  });

  it("builds a portfolio from My Account in the creation flow signed out", () => {
    renderShell();
    click("account-build");
    expect(screen.getByText("create-flow")).toBeTruthy();
    expect(state.flowProps).toMatchObject({ signedOut: true });
  });

  it("My Account's Connect Wallet opens the wallet dialog", () => {
    renderShell();
    click("account-connect");
    expect(screen.getByRole("dialog").textContent).toContain("wallet-picker");
  });

  it("signed in, My Account is not signed out (control)", () => {
    state.login = { status: "connected", intentsAccountId: ACCOUNT };
    renderShell();
    expect(screen.getByText("my-account-view")).toBeTruthy();
    expect(state.accountProps).toMatchObject({ signedOut: false });
  });

  // 019-4 (D-393 Q3): the same tab and view as with a wallet. With nothing stored, a draft is
  // what opens.
  it("with a saved draft: its tab and its view, not My Account", () => {
    state.draft = DRAFT;
    renderShell();
    expect(signedOutAccount()).toBeNull();
    expect(state.tabsProps).toMatchObject({ miCuentaActive: false, signedOut: true });
    expect(state.tabsProps!.draftTab).toMatchObject({ name: "My mix", active: true });
    expect(screen.getByText("sub-nav-draft")).toBeTruthy();
    expect(screen.getByText("draft-view:signed-out")).toBeTruthy();
    expect(screen.queryByText("portfolio-content")).toBeNull();
  });

  it("the view's main action connects", () => {
    state.draft = DRAFT;
    renderShell();
    click("view-primary");
    expect(screen.getByRole("dialog").textContent).toContain("wallet-picker");
  });

  // 027 A-10: the view edits in place; saving checks the name against no portfolio.
  it("the view's saved rows save the draft, signed out", () => {
    state.draft = DRAFT;
    state.saveDraft = vi.fn(() => ({ ok: true }));
    renderShell();
    click("view-save");
    expect(state.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ name: "My mix", rows: EDITED_ROWS }), []);
    expect(state.flowProps).toBeNull();
  });

  it("the view's discard discards (the view asks first)", () => {
    state.draft = DRAFT;
    renderShell();
    click("view-discard");
    expect(state.discardDraft).toHaveBeenCalledTimes(1);
  });

  it("while a session restores: no My Account, no tab", () => {
    state.login = { status: "restoring", intentsAccountId: ACCOUNT };
    state.draft = DRAFT;
    renderShell();
    expect(state.accountProps).toBeNull();
    expect(state.tabsProps).toBeNull();
    expect(state.viewProps).toBeNull();
  });

  // 022-A (E8): signing out goes back to My Account without a wallet, not to a start screen.
  it("signing out lands on My Account without a wallet", () => {
    state.login = { status: "connected", intentsAccountId: ACCOUNT };
    const { rerender } = renderShell();
    expect(screen.getByText("my-account-view")).toBeTruthy();

    state.login = { status: "idle", intentsAccountId: "" };
    rerender();
    expect(signedOutAccount()).toBeTruthy();
    expect(state.tabsProps).toMatchObject({ miCuentaActive: true, signedOut: true });
  });

  it("signed in, the creation flow is not signed out", () => {
    state.draft = DRAFT;
    state.login = { status: "connected", intentsAccountId: ACCOUNT };
    state.fundable = READY;
    renderShell();
    click("view-primary");
    expect(state.flowProps).toMatchObject({ signedOut: false });
  });
});

// 022-B (D-453) — signed out with a draft: My Account opens too, and the section survives a
// reload, stored apart from every account's.
describe("DashboardShell — signed out with a draft (022-B)", () => {
  const signedOutAccount = () => screen.queryByText("my-account-view:signed-out");

  beforeEach(() => {
    state.login = { status: "idle", intentsAccountId: "" };
    state.draft = DRAFT;
  });

  it("My Account and the draft's tab, back and forth, each remembered", () => {
    renderShell();
    click("tab-my-account");
    expect(signedOutAccount()).toBeTruthy();
    expect(screen.queryByText("draft-view:signed-out")).toBeNull();
    expect(state.tabsProps).toMatchObject({ miCuentaActive: true, draftTab: { active: false } });
    expect(getSignedOutSection()).toBe("account");

    click("tab-draft");
    expect(screen.getByText("draft-view:signed-out")).toBeTruthy();
    expect(state.tabsProps).toMatchObject({ miCuentaActive: false, draftTab: { active: true } });
    expect(getSignedOutSection()).toBe("draft");
  });

  it("My Account's view gets the draft's way in and connecting: its card", () => {
    setSignedOutSection("account");
    renderShell();
    click("card-view");
    expect(screen.getByText("draft-view:signed-out")).toBeTruthy();
    click("tab-my-account");
    click("account-connect");
    expect(screen.getByRole("dialog").textContent).toContain("wallet-picker");
  });

  // E7: a reload lands where the user was.
  it("a reload on My Account stays on My Account", () => {
    setSignedOutSection("account");
    renderShell();
    expect(signedOutAccount()).toBeTruthy();
    expect(state.tabsProps!.draftTab).toMatchObject({ name: "My mix", active: false });
  });

  it("the draft's tab stored with the draft gone: My Account", () => {
    setSignedOutSection("draft");
    state.draft = null;
    renderShell();
    expect(signedOutAccount()).toBeTruthy();
    expect(state.viewProps).toBeNull();
  });

  it("discarding leaves for My Account, and stays there on a reload", () => {
    renderShell();
    click("view-discard");
    expect(state.discardDraft).toHaveBeenCalledTimes(1);
    expect(getSignedOutSection()).toBe("account");
  });

  it("saving a draft from My Account lands on its tab", () => {
    setSignedOutSection("account");
    state.draft = null;
    const { rerender } = renderShell();
    click("account-build");
    state.draft = DRAFT;
    click("flow-draft-saved");
    rerender();
    expect(screen.getByText("draft-view:signed-out")).toBeTruthy();
    expect(getSignedOutSection()).toBe("draft");
  });

  it("the section signed out is not any account's", () => {
    setDashboardSection(ACCOUNT, "portfolio");
    renderShell();
    click("tab-my-account");
    expect(getDashboardSection(ACCOUNT)).toBe("portfolio");
  });
});

// 019-4 (D-393 Q3) — the New Portfolio Draft as a tab, signed in.
describe("DashboardShell — the draft's tab (019-4)", () => {
  beforeEach(() => {
    state.draft = DRAFT;
  });

  // 022-G (D-458): renaming saves the whole draft with the new name — its rows and the
  // simulation's amount stay — and a refused name comes back as its error key.
  it("renaming saves the whole draft with the new name, against the names it is given", () => {
    state.draft = { ...DRAFT, simulationUsd: 10 };
    renderShell();
    const rename = (state.tabsProps!.draftTab as {
      rename: (name: string, names: string[]) => unknown;
    }).rename;

    expect(rename("Renamed", ["Old"])).toEqual({ ok: true });
    expect(state.saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Renamed", presetId: null, rows: DRAFT.rows, simulationUsd: 10 }),
      ["Old"]
    );

    state.saveDraft = vi.fn(() => ({ ok: false, reason: "invalid-name", nameError: "nameDuplicate" }));
    renderShell();
    const again = (state.tabsProps!.draftTab as { rename: (name: string, names: string[]) => unknown }).rename;
    expect(again("Old", ["Old"])).toEqual({ ok: false, error: "nameDuplicate" });
  });

  it("an account with no portfolio yet: the draft alone brings the tabs, and opens on it", () => {
    renderShell();
    expect(state.tabsProps!.draftTab).toMatchObject({ name: "My mix", active: true });
    expect(screen.getByText("draft-view:waiting")).toBeTruthy();
    expect(screen.getByText("sub-nav-draft")).toBeTruthy();
    expect(screen.queryByText("my-account-view")).toBeNull();
  });

  // D-419: the strip stays — My Account selected, and "New portfolio" — so deleting the last
  // portfolio does not take the strip with it.
  it("without a draft or portfolios: My Account, with the strip and no draft tab", () => {
    state.draft = null;
    renderShell();
    expect(screen.getByText("my-account-view")).toBeTruthy();
    expect(state.tabsProps).toMatchObject({ miCuentaActive: true });
    expect(state.tabsProps?.draftTab).toBeUndefined();
  });

  it("on it the route does not matter: the view, never the portfolio's content", () => {
    state.portfolios = [{ id: "p1", name: "Old", deposits: {} }];
    setDashboardSection(ACCOUNT, "draft");
    renderShell();
    expect(screen.getByText("draft-view:waiting")).toBeTruthy();
    expect(screen.queryByText("portfolio-content")).toBeNull();
  });

  it("its main action deposits for the draft, framed around it", () => {
    renderShell();
    click("view-primary");
    expect(state.receiveProps).toMatchObject({ open: true, draftContext: { name: "My mix", tokenIds: ["near"] } });
  });

  it("with the funds in: 'ready', its main action confirms, and no ready strip over it", () => {
    state.portfolios = [{ id: "p1", name: "Old", deposits: {} }];
    state.fundable = READY;
    setDashboardSection(ACCOUNT, "draft");
    renderShell();
    expect(screen.getByText("draft-view:ready")).toBeTruthy();
    expect(strip()).toBeNull();
    click("view-primary");
    expect(state.flowProps).toMatchObject({ afterDeposit: undefined });
  });

  // 027 A-10: the view edits in place (no editor), and saves against the account's names.
  it("its saved rows save the whole draft with them, against the portfolios' names", () => {
    state.portfolios = [{ id: "p1", name: "Old", deposits: {} }];
    state.draft = { ...DRAFT, simulationUsd: 10 };
    state.saveDraft = vi.fn(() => ({ ok: false, reason: "invalid-name", nameError: "nameDuplicate" }));
    setDashboardSection(ACCOUNT, "draft");
    renderShell();
    click("view-save");
    expect(state.saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({ name: "My mix", rows: EDITED_ROWS, simulationUsd: 10 }),
      ["Old"]
    );
    // The view gets the result (it says what blocks the save).
    expect((state.viewProps!.onSaveRows as (rows: unknown[]) => unknown)(EDITED_ROWS)).toMatchObject({ ok: false });
    expect(state.flowProps).toBeNull();
  });

  it("leaving its tab with unsaved edits asks first; discarding goes on", () => {
    state.portfolios = [{ id: "p1", name: "Old", deposits: {} }];
    setDashboardSection(ACCOUNT, "draft");
    renderShell();
    click("view-edit-unsaved");

    click("tab-my-account");
    expect(screen.getByText("unsaved-changes:draft")).toBeTruthy();
    expect(screen.getByText("draft-view:waiting")).toBeTruthy();

    click("unsaved-discard");
    expect(screen.queryByText("draft-view:waiting")).toBeNull();
    expect(screen.queryByText(/unsaved-changes/)).toBeNull();
  });

  it("with no unsaved edits, leaving its tab does not ask", () => {
    state.portfolios = [{ id: "p1", name: "Old", deposits: {} }];
    setDashboardSection(ACCOUNT, "draft");
    renderShell();
    click("tab-my-account");
    expect(screen.queryByText(/unsaved-changes/)).toBeNull();
    expect(screen.queryByText("draft-view:waiting")).toBeNull();
  });

  it("choosing its tab from a portfolio goes there, and is remembered", () => {
    state.portfolios = [{ id: "p1", name: "Old", deposits: {} }];
    renderShell();
    expect(screen.getByText("portfolio-content")).toBeTruthy();
    click("tab-draft");
    expect(screen.getByText("draft-view:waiting")).toBeTruthy();
    expect(getDashboardSection(ACCOUNT)).toBe("draft");
  });

  // Control (022 §4.1, operator s243): with a wallet and a draft without funds, My Account can
  // be chosen, and the draft stays.
  it("My Account can be chosen, and the draft stays", () => {
    renderShell();
    click("tab-my-account");
    expect(screen.getByText("my-account-view")).toBeTruthy();
    expect(state.tabsProps!.draftTab).toMatchObject({ name: "My mix", active: false });
    expect(state.discardDraft).not.toHaveBeenCalled();
  });

  it("My Account's card goes to its tab", () => {
    setDashboardSection(ACCOUNT, "account");
    renderShell();
    click("card-view");
    expect(screen.getByText("draft-view:waiting")).toBeTruthy();
  });

  it.each([
    ["from My Account's creation", "account", "card-confirm"],
    ["from the tabs' '+'", "portfolio", "tabs-new"],
  ] as const)("saving a draft %s lands on its tab", (_label, from, open) => {
    state.portfolios = [{ id: "p1", name: "Old", deposits: {} }];
    setDashboardSection(ACCOUNT, from);
    renderShell();
    click(open);
    click("flow-draft-saved");
    expect(screen.getByText("draft-view:waiting")).toBeTruthy();
    expect(getDashboardSection(ACCOUNT)).toBe("draft");
  });

  // D-560: the tab's menu.
  it("deleting from the menu with the draft on screen leaves for My Account", () => {
    state.portfolios = [{ id: "p1", name: "Old", deposits: {} }];
    setDashboardSection(ACCOUNT, "draft");
    renderShell();
    act(() => (state.tabsProps!.draftTab as { discard: () => void }).discard());
    expect(state.discardDraft).toHaveBeenCalledTimes(1);
    expect(screen.getByText("my-account-view")).toBeTruthy();
    expect(getDashboardSection(ACCOUNT)).toBe("account");
  });

  it("deleting from the menu with a portfolio on screen stays there", () => {
    state.portfolios = [{ id: "p1", name: "Old", deposits: {} }];
    setDashboardSection(ACCOUNT, "portfolio");
    renderShell();
    act(() => (state.tabsProps!.draftTab as { discard: () => void }).discard());
    expect(state.discardDraft).toHaveBeenCalledTimes(1);
    expect(screen.getByText("portfolio-content")).toBeTruthy();
    expect(getDashboardSection(ACCOUNT)).toBe("portfolio");
  });

  it("discarding leaves for My Account", () => {
    state.portfolios = [{ id: "p1", name: "Old", deposits: {} }];
    setDashboardSection(ACCOUNT, "draft");
    renderShell();
    click("view-discard");
    expect(state.discardDraft).toHaveBeenCalledTimes(1);
    expect(screen.getByText("my-account-view")).toBeTruthy();
    expect(getDashboardSection(ACCOUNT)).toBe("account");
  });

  it.each([
    ["with portfolios, the portfolio", [{ id: "p1", name: "Old", deposits: {} }], "portfolio-content"],
    ["without, My Account", [], "my-account-view"],
  ])("a draft gone elsewhere (another tab, signed): %s", (_label, portfolios, shown) => {
    state.portfolios = portfolios;
    state.draft = null;
    setDashboardSection(ACCOUNT, "draft");
    renderShell();
    expect(screen.getByText(shown)).toBeTruthy();
    expect(state.viewProps).toBeNull();
  });
});

describe("DashboardShell — connecting with a draft built signed out (D-359)", () => {
  const seed = (entries: Record<string, NewPortfolioDraft>) =>
    localStorage.setItem(NEW_PORTFOLIO_DRAFT_KEY, JSON.stringify(entries));

  it("moves it to the account", () => {
    seed({ [ANONYMOUS_DRAFT_SLOT]: { ...DRAFT, name: "Built signed out" } });
    renderShell();
    expect(readNewPortfolioDraft(ACCOUNT)?.name).toBe("Built signed out");
    expect(readNewPortfolioDraft(ANONYMOUS_DRAFT_SLOT)).toBeNull();
  });

  // 019-4: connecting from the draft's tab keeps it on screen, whatever was stored before.
  it("stays on the draft's tab", () => {
    seed({ [ANONYMOUS_DRAFT_SLOT]: DRAFT });
    state.portfolios = [{ id: "p1", name: "Old", deposits: {} }];
    state.draft = DRAFT;
    setDashboardSection(ACCOUNT, "account");
    renderShell();
    expect(getDashboardSection(ACCOUNT)).toBe("draft");
    expect(screen.getByText("draft-view:waiting")).toBeTruthy();
  });

  it("connecting with no draft built signed out moves nothing and changes no tab", () => {
    state.portfolios = [{ id: "p1", name: "Old", deposits: {} }];
    setDashboardSection(ACCOUNT, "account");
    renderShell();
    expect(getDashboardSection(ACCOUNT)).toBe("account");
  });

  // Restoring → connected: the draft moves in the very render the session connects.
  it("a session that connects after restoring moves it", () => {
    seed({ [ANONYMOUS_DRAFT_SLOT]: DRAFT });
    state.login = { status: "restoring", intentsAccountId: ACCOUNT };
    const { rerender } = renderShell();
    expect(readNewPortfolioDraft(ANONYMOUS_DRAFT_SLOT)).not.toBeNull();

    state.login = { status: "connected", intentsAccountId: ACCOUNT };
    rerender();
    expect(readNewPortfolioDraft(ACCOUNT)?.name).toBe("My mix");
  });

  it("the account's own newer draft stays", () => {
    const own = { ...DRAFT, name: "Account's", updatedAt: 2 };
    seed({ [ANONYMOUS_DRAFT_SLOT]: { ...DRAFT, updatedAt: 1 }, [ACCOUNT]: own });
    state.draft = own;
    renderShell();
    expect(readNewPortfolioDraft(ACCOUNT)?.name).toBe("Account's");
    expect(readNewPortfolioDraft(ANONYMOUS_DRAFT_SLOT)).toBeNull();
    // Still a draft on screen — the account's.
    expect(getDashboardSection(ACCOUNT)).toBe("draft");
  });

  // 022-A (E4a): connecting from My Account without a wallet stays on My Account, even for an
  // account whose stored section is a portfolio. Told from a restore by the "idle" before it.
  it("connecting from My Account signed out stays on My Account", () => {
    state.portfolios = [{ id: "p1", name: "Old", deposits: {} }];
    setDashboardSection(ACCOUNT, "portfolio");
    state.login = { status: "idle", intentsAccountId: "" };
    const { rerender } = renderShell();

    state.login = { status: "connected", intentsAccountId: ACCOUNT };
    rerender();
    expect(getDashboardSection(ACCOUNT)).toBe("account");
    expect(screen.getByText("my-account-view")).toBeTruthy();
    expect(screen.queryByText("portfolio-content")).toBeNull();
  });

  // 022-B (S1, E4b): with a draft built signed out, connecting keeps the section on screen.
  it.each([
    ["My Account stays on My Account", "tab-my-account", "account", "my-account-view"],
    ["the draft's tab stays on the draft", "tab-draft", "draft", "draft-view:waiting"],
  ] as const)("connecting signed out with a draft: %s", (_label, from, section, shown) => {
    seed({ [ANONYMOUS_DRAFT_SLOT]: DRAFT });
    state.draft = DRAFT;
    state.portfolios = [{ id: "p1", name: "Old", deposits: {} }];
    setDashboardSection(ACCOUNT, "portfolio");
    state.login = { status: "idle", intentsAccountId: "" };
    const { rerender } = renderShell();
    click(from);

    state.login = { status: "connected", intentsAccountId: ACCOUNT };
    rerender();
    expect(readNewPortfolioDraft(ACCOUNT)?.name).toBe("My mix");
    expect(getDashboardSection(ACCOUNT)).toBe(section);
    expect(screen.getByText(shown)).toBeTruthy();
    expect(screen.queryByText("portfolio-content")).toBeNull();
  });

  // Control: a reload restores the session without passing through "idle", so it keeps the
  // section the user was on.
  it("restoring a session keeps the stored section", () => {
    state.portfolios = [{ id: "p1", name: "Old", deposits: {} }];
    setDashboardSection(ACCOUNT, "portfolio");
    state.login = { status: "restoring", intentsAccountId: ACCOUNT };
    const { rerender } = renderShell();

    state.login = { status: "connected", intentsAccountId: ACCOUNT };
    rerender();
    expect(getDashboardSection(ACCOUNT)).toBe("portfolio");
    expect(screen.getByText("portfolio-content")).toBeTruthy();
  });

  it("waits for the session: nothing moves while it restores", () => {
    seed({ [ANONYMOUS_DRAFT_SLOT]: DRAFT });
    state.login = { status: "restoring", intentsAccountId: ACCOUNT };
    renderShell();
    expect(readNewPortfolioDraft(ANONYMOUS_DRAFT_SLOT)?.name).toBe("My mix");
    expect(readNewPortfolioDraft(ACCOUNT)).toBeNull();
  });
});

// 022-C (D-453) — entering the app ("Open app": the index, `basePath` itself) lands on My
// Account; a reload, anywhere below the index, lands where the user was. The index is dropped
// from the address bar at once, so it counts once.
describe("DashboardShell — entering the app (022-C)", () => {
  const at = (path: string) => window.history.replaceState(null, "", path);
  const restore = () => {
    state.login = { status: "restoring", intentsAccountId: ACCOUNT };
    const { rerender } = renderShell();
    state.login = { status: "connected", intentsAccountId: ACCOUNT };
    rerender();
  };

  beforeEach(() => {
    state.portfolios = [{ id: "p1", name: "Old", deposits: {} }];
    setDashboardSection(ACCOUNT, "portfolio");
  });

  it("with a wallet: My Account, though a portfolio was last seen, and the mark is gone", () => {
    at("/dashboard");
    restore();
    expect(screen.getByText("my-account-view")).toBeTruthy();
    expect(screen.queryByText("portfolio-content")).toBeNull();
    expect(getDashboardSection(ACCOUNT)).toBe("account");
    expect(window.location.pathname).toBe("/dashboard/overview");
  });

  // Control (E6): a reload keeps the stored section, as before 022-C.
  it("a reload below the index keeps the stored section and the URL", () => {
    at("/dashboard/activity");
    restore();
    expect(screen.getByText("portfolio-content")).toBeTruthy();
    expect(getDashboardSection(ACCOUNT)).toBe("portfolio");
    expect(window.location.pathname).toBe("/dashboard/activity");
  });

  it("a session already connected (coming from the landing): My Account too", () => {
    at("/dashboard");
    renderShell();
    expect(screen.getByText("my-account-view")).toBeTruthy();
    expect(getDashboardSection(ACCOUNT)).toBe("account");
  });

  it("the mock dashboard's index is its own basePath, and the query stays", () => {
    at("/mock-dashboard?lang=es");
    renderShell("/mock-dashboard");
    expect(screen.getByText("my-account-view")).toBeTruthy();
    expect(window.location.pathname + window.location.search).toBe("/mock-dashboard/overview?lang=es");
  });

  // D-544: the index redirects on the server (D-527), so the mark rides on the redirect.
  it("the redirect's mark: My Account, and the mark leaves the URL with the rest of the query kept", () => {
    at("/dashboard/overview?account=x.near&entry=1#top");
    restore();
    expect(screen.getByText("my-account-view")).toBeTruthy();
    expect(getDashboardSection(ACCOUNT)).toBe("account");
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      "/dashboard/overview?account=x.near#top"
    );
  });

  // Control: the same URL without the mark is a reload.
  it("Overview without the mark keeps the stored section", () => {
    at("/dashboard/overview?account=x.near");
    restore();
    expect(screen.getByText("portfolio-content")).toBeTruthy();
    expect(getDashboardSection(ACCOUNT)).toBe("portfolio");
    expect(window.location.search).toBe("?account=x.near");
  });

  it("the mark under the other basePath is not an entry", () => {
    at("/dashboard/overview?entry=1");
    renderShell("/mock-dashboard");
    expect(screen.getByText("portfolio-content")).toBeTruthy();
    expect(window.location.search).toBe("?entry=1");
  });

  it("the other basePath's index is not an entry", () => {
    at("/dashboard");
    renderShell("/mock-dashboard");
    expect(screen.getByText("portfolio-content")).toBeTruthy();
    expect(window.location.pathname).toBe("/dashboard");
  });

  describe("signed out", () => {
    beforeEach(() => {
      state.login = { status: "idle", intentsAccountId: "" };
      state.portfolios = [];
    });

    it("with a draft: its tab, though My Account was last seen, and a reload stays there", () => {
      setSignedOutSection("account");
      state.draft = DRAFT;
      at("/dashboard");
      renderShell();
      expect(screen.getByText("draft-view:signed-out")).toBeTruthy();
      expect(getSignedOutSection()).toBeNull();
      expect(window.location.pathname).toBe("/dashboard/overview");

      cleanup();
      renderShell();
      expect(screen.getByText("draft-view:signed-out")).toBeTruthy();
    });

    it("without a draft: My Account", () => {
      setSignedOutSection("draft");
      at("/dashboard");
      renderShell();
      expect(screen.getByText("my-account-view:signed-out")).toBeTruthy();
    });

    // The entry was signed out; connecting afterwards keeps what is on screen (022-B, S1).
    it("then connecting from the draft's tab stays on the draft", () => {
      localStorage.setItem(NEW_PORTFOLIO_DRAFT_KEY, JSON.stringify({ [ANONYMOUS_DRAFT_SLOT]: DRAFT }));
      state.draft = DRAFT;
      at("/dashboard");
      state.login = { status: "restoring", intentsAccountId: "" };
      const { rerender } = renderShell();
      state.login = { status: "idle", intentsAccountId: "" };
      rerender();
      expect(screen.getByText("draft-view:signed-out")).toBeTruthy();

      state.login = { status: "connected", intentsAccountId: ACCOUNT };
      rerender();
      expect(getDashboardSection(ACCOUNT)).toBe("draft");
      expect(screen.getByText("draft-view:waiting")).toBeTruthy();
    });
  });
});

// D-327 — a re-read that fails over a list already on screen keeps it (and whatever editor and
// modal are open on it), with a notice; only a first read with nothing to show takes the page.
describe("DashboardShell — the portfolio read fails", () => {
  it("over portfolios already read: they stay, with a notice and a retry", () => {
    state.portfolios = [{ id: "p1", name: "Old", deposits: {} }];
    state.portfoliosRefreshFailed = true;
    renderShell();
    expect(screen.getByText("portfolio-content")).toBeTruthy();
    expect(screen.getByText(t.portfoliosRefreshError)).toBeTruthy();
    expect(screen.queryByText(t.portfoliosReadErrorTitle)).toBeNull();
    click(t.portfoliosReadErrorRetry);
    expect(state.refetchPortfolios).toHaveBeenCalledTimes(1);
  });

  it("with nothing read yet: the page says so instead", () => {
    state.portfoliosError = new Error("rpc");
    renderShell();
    expect(screen.getByText(t.portfoliosReadErrorTitle)).toBeTruthy();
    expect(screen.queryByText("portfolio-content")).toBeNull();
    expect(screen.queryByText(t.portfoliosRefreshError)).toBeNull();
  });

  it("no notice while the read is fine", () => {
    state.portfolios = [{ id: "p1", name: "Old", deposits: {} }];
    renderShell();
    expect(screen.queryByText(t.portfoliosRefreshError)).toBeNull();
  });
});

// D-466: a reload can close two withdrawals in one pass; the second one's toast used to hide
// the first. While one is on screen, the next turns it into a count.
describe("DashboardShell — withdrawals resolved on load (D-466)", () => {
  const record = (qty: number) => ({
    intentId: `w${qty}`,
    tokenId: "nep141:wrap.near",
    qty,
    chainId: "near",
    destinationAddress: "bob.near",
    status: "PUBLISHED",
    ts: 1,
    isReal: true,
  });
  const hooks = () => state.withdrawalHooks!;

  it("one resolution keeps its own toast", () => {
    renderShell();
    act(() => hooks().onNeverExecuted(record(2)));
    expect(screen.getByText(/Withdrawal not sent · 2/)).toBeTruthy();
  });

  it("two in the same pass become one summary, and a third raises the count", () => {
    renderShell();
    act(() => {
      hooks().onDelivered(record(1));
      hooks().onNeverExecuted(record(2));
    });
    expect(screen.getByText(t.withdrawalsResolvedToast.replace("{count}", "2"))).toBeTruthy();
    expect(screen.queryByText(/Withdrawal not sent/)).toBeNull();
    act(() => hooks().onFailed(record(3)));
    expect(screen.getByText(t.withdrawalsResolvedToast.replace("{count}", "3"))).toBeTruthy();
  });

  it("the count starts over once the toast is gone", () => {
    vi.useFakeTimers();
    try {
      renderShell();
      act(() => {
        hooks().onDelivered(record(1));
        hooks().onNeverExecuted(record(2));
      });
      act(() => vi.advanceTimersByTime(5_000));
      act(() => hooks().onNeverExecuted(record(4)));
      expect(screen.getByText(/Withdrawal not sent · 4/)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

// 027 A-3: with a created portfolio the language, "Getting started" and the guide live in the
// wallet menu only. The draft does not count; a read still loading does; a failed one does not.
describe("DashboardShell — header extras in the wallet menu only (027 A-3)", () => {
  it("with a portfolio: in the wallet menu only", () => {
    state.portfolios = [{ id: "p1", name: "Old", deposits: {} }];
    renderShell();
    expect(state.headerInWalletMenuOnly).toBe(true);
  });

  it("with only the draft: in the header too", () => {
    state.draft = DRAFT;
    renderShell();
    expect(state.headerInWalletMenuOnly).toBe(false);
  });

  it("while the list loads: in the wallet menu only, so they never show up and leave", () => {
    state.portfoliosLoading = true;
    renderShell();
    expect(state.headerInWalletMenuOnly).toBe(true);
  });

  it("when the list cannot be read: in the header too", () => {
    state.portfoliosError = new Error("rpc");
    renderShell();
    expect(state.headerInWalletMenuOnly).toBe(false);
  });
});

describe("DashboardShell — the funds-to-assign window (029 B-23)", () => {
  beforeEach(() => {
    state.portfolios = [{ id: "p1", name: "Old", deposits: {} }];
    state.draft = DRAFT;
    state.fundable = READY;
    setDashboardSection(ACCOUNT, "draft");
  });

  const prompt = () => screen.queryByRole("dialog");

  it("the draft on its tab with funds offers them; assigning opens the creation", () => {
    renderShell();
    expect(prompt()?.textContent).toContain(READY_LINE);
    click(t.draftReadyConfirm);
    expect(prompt()).toBeNull();
    expect(state.flowProps).toMatchObject({ afterDeposit: undefined });
  });

  // D-307's rule, needed since a portfolio created beside a saved draft leaves it here (D-397).
  it("stays shut with an Allocate still unconfirmed, and offers once nothing is in transit", () => {
    state.pendingAllocates = [{ id: "rec-1", op: "setup", portfolioId: null }];
    const { rerender } = renderShell();
    expect(prompt()).toBeNull();

    state.pendingAllocates = [];
    rerender();
    expect(prompt()?.textContent).toContain(READY_LINE);
  });

  // The other ways in are the shell's own, and they must keep confirming the saved draft.
  it("only the tabs' '+' asks for a new portfolio", () => {
    renderShell();
    click(t.draftReadyConfirm);
    expect(state.flowProps?.startNew).toBeFalsy();
  });

  it("'Not now' closes it, and it does not come back on the next visit", () => {
    renderShell();
    click(t.assignFundsNotNow);
    expect(prompt()).toBeNull();
    expect(state.flowProps).toBeNull();
    cleanup();
    renderShell();
    expect(prompt()).toBeNull();
  });

  it("coming back from the deposit window opened for the draft does not ask again", () => {
    state.fundable = { status: "known", fundable: false, tokenIds: [], usd: 0 };
    const { rerender } = renderShell();
    act(() => (state.viewProps!.onDeposit as () => void)());
    expect(screen.getByText("receive-open")).toBeTruthy();
    // The deposit lands while the window is open, and the user closes it.
    state.fundable = READY;
    rerender();
    act(() => (state.receiveProps!.onClose as () => void)());
    expect(prompt()).toBeNull();
  });

  it("only on the draft's tab: not on My Account", () => {
    setDashboardSection(ACCOUNT, "account");
    renderShell();
    expect(prompt()).toBeNull();
  });
});

// D-527: picking another portfolio opens it on Overview; the one already on screen keeps its tab.
describe("DashboardShell — another portfolio opens on Overview (D-527)", () => {
  it("another portfolio or from My Account: Overview; the one already on screen: no move", () => {
    state.portfolios = [
      { id: "p1", name: "One", deposits: {} },
      { id: "p2", name: "Two", deposits: {} },
    ];
    const { rerender } = renderShell("/mock-dashboard");
    const call = (name: string, ...args: string[]) => {
      act(() => (state.tabsProps![name] as (...a: string[]) => void)(...args));
      rerender();
    };
    // Signed in with portfolios the first one is on screen.
    call("onPortfolioTabSelect", "p1");
    expect(state.routerPush).not.toHaveBeenCalled();
    call("onPortfolioTabSelect", "p2");
    expect(state.routerPush).toHaveBeenLastCalledWith("/mock-dashboard/overview");
    state.routerPush.mockClear();
    call("onMiCuentaClick");
    call("onPortfolioTabSelect", "p1");
    expect(state.routerPush).toHaveBeenLastCalledWith("/mock-dashboard/overview");
  });
});
