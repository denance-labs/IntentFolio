// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { translations as editorTranslations } from "@/features/portfolio-editor/lib/translations";
import { NEW_PORTFOLIO_DRAFT_KEY, type NewPortfolioDraft, type NewPortfolioDraftValidation } from "../lib/new-portfolio-draft";
import { shellTranslations } from "../lib/translations";
import { SIMULATION_DEFAULT_USD } from "../lib/new-portfolio-draft-simulation";

// 019-3 (D-393 Q2). A New Portfolio Draft with the shape of a portfolio at $0: every row at
// $0 with no band status, the main action the caller chose, and the simulation's amount
// stored as typed (D-457). 027 A-10: "Edit targets" edits the table in place, with
// Composition's rules; "Save draft" hands the rows to the caller, "Cancel" drops them.

const state = vi.hoisted(() => ({ lang: "en" as "en" | "es" }));
vi.mock("../hooks/use-fundable-general-balance", () => ({
  useFundableGeneralBalance: () => ({ status: "known", fundable: false, tokenIds: [], usd: 0 }),
}));
vi.mock("../context/language-context", () => ({
  useLanguage: () => ({ lang: state.lang, setLang: vi.fn() }),
}));
vi.mock("@/features/market/hooks/use-token-prices", () => {
  const q = (usdPrice: number) => ({ symbol: "X", usdPrice, updatedAt: "", source: "chaindefuser" });
  return {
    useTokenPrices: () => ({ prices: { "nep141:nbtc.bridge.near": q(80_000), near: q(5) }, isLoading: false }),
  };
});

import { NewPortfolioDraftView } from "./new-portfolio-draft-view";
import { COUNTRY_COOKIE } from "@/features/stocks/lib/stock-region";

// D-569: the cookie the middleware writes from Vercel's country header.
const setCountry = (code: string | null) => {
  document.cookie = code ? `${COUNTRY_COOKIE}=${code}; path=/` : `${COUNTRY_COOKIE}=; path=/; max-age=0`;
};
afterEach(() => setCountry(null));

const BTC = "nep141:nbtc.bridge.near";
const NEAR = "near";
const SOL = "nep141:sol.omft.near";

const DRAFT: NewPortfolioDraft = {
  v: 1,
  name: "My mix",
  presetId: null,
  rows: [
    { tokenId: BTC, targetPct: 60, tolerancePct: 10, locked: false },
    { tokenId: NEAR, targetPct: 40, tolerancePct: 5, locked: false },
  ],
  updatedAt: 1,
};

const THREE: NewPortfolioDraft = {
  ...DRAFT,
  rows: [
    { tokenId: BTC, targetPct: 50, tolerancePct: 10, locked: false },
    { tokenId: NEAR, targetPct: 30, tolerancePct: 10, locked: false },
    { tokenId: SOL, targetPct: 20, tolerancePct: 10, locked: false },
  ],
};

function renderView(
  variant: "signed-out" | "waiting" | "loading" | "ready" = "waiting",
  draft: NewPortfolioDraft = DRAFT,
  saveResult: NewPortfolioDraftValidation = { ok: true }
) {
  const common = {
    onSaveRows: vi.fn(() => saveResult),
    onUnsavedChange: vi.fn(),
    onDiscard: vi.fn(),
    onSimulationUsdChange: vi.fn(),
  };
  const primary = vi.fn();
  const byVariant =
    variant === "signed-out"
      ? { variant, onConnect: primary }
      : variant === "waiting"
        ? { variant, onDeposit: primary }
        : variant === "loading"
          ? { variant }
          : { variant, onConfirm: primary, amountUsd: 2.46 };
  const view = render(<NewPortfolioDraftView draft={draft} {...common} {...byVariant} />);
  const rerender = (next: NewPortfolioDraft) =>
    view.rerender(<NewPortfolioDraftView draft={next} {...common} {...byVariant} />);
  return { ...common, primary, rerender };
}

describe.each(["en", "es"] as const)("NewPortfolioDraftView (%s)", (lang) => {
  const t = shellTranslations[lang];
  const te = editorTranslations[lang];

  beforeEach(() => {
    state.lang = lang;
  });
  afterEach(cleanup);

  // D-486: while the General Balance is being read, neither "waiting for funds" nor "ready" is true.
  it("loading: names the draft, claims nothing about funds, offers no money action", () => {
    renderView("loading");
    expect(screen.getByRole("heading", { name: DRAFT.name })).toBeTruthy();
    // s283 QA: a placeholder holds the body line's place, so nothing grows when it resolves.
    expect(screen.getByTestId("draft-loading-line")).toBeTruthy();
    expect(screen.queryByRole("button", { name: t.draftCardDeposit })).toBeNull();
    expect(screen.queryByRole("button", { name: t.draftReadyConfirm })).toBeNull();
    expect(screen.getByRole("button", { name: t.draftCardDiscard })).toBeTruthy();
  });

  it("shows the value at $0 and no holdings", () => {
    renderView();
    expect(screen.getByText(te.totalCurrent).nextElementSibling?.textContent).toBe("$0.00");
    expect(screen.queryByText(te.holdings)).toBeNull();
  });

  it("every row is at $0 with no band status ('—'), its target and tolerance as saved", () => {
    renderView();
    expect(screen.getAllByLabelText(`${te.status}: —`)).toHaveLength(2);
    expect(screen.queryByLabelText(new RegExp(`${te.status}: (${te.belowTarget}|${te.aboveTarget}|${te.insideBand})`))).toBeNull();
    expect(screen.getByText("60.0%")).toBeTruthy();
    expect(screen.getByText("±5%")).toBeTruthy();
    // Read-only: no field to type a target in (changes go through the editor).
    expect(screen.queryByLabelText(`${te.target} nBTC`)).toBeNull();
  });

  it("S2: the Target donut still draws the mix at $0", () => {
    renderView();
    // The slices are only drawn for the target side; "Current" has nothing to show.
    expect(screen.getAllByRole("button", { name: "nBTC: 60.0%, $0.00" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "NEAR: 40.0%, $0.00" }).length).toBeGreaterThan(0);
  });

  it.each([
    ["signed-out", "walletConnect"],
    ["waiting", "draftCardDeposit"],
    ["ready", "draftReadyConfirm"],
  ] as const)("%s: the main action is the one the caller gave, above and under the table", (variant, key) => {
    const { primary } = renderView(variant);
    // 029 B-13: the same action twice — in the header and next to "Edit targets".
    const buttons = screen.getAllByRole("button", { name: t[key] });
    expect(buttons).toHaveLength(2);
    buttons.forEach((button) => fireEvent.click(button));
    expect(primary).toHaveBeenCalledTimes(2);
  });

  it("B-13: under the table, 'Delete draft', 'Edit targets' and the main action, in that order", () => {
    renderView("ready");
    const row = screen.getByRole("button", { name: te.editPanel }).parentElement!;
    expect(
      within(row)
        .getAllByRole("button")
        .map((b) => b.textContent)
    ).toEqual([`+ ${te.addTarget}`, t.draftCardDiscard, te.editPanel, t.draftReadyConfirm]);
    // "Delete draft" is only here, not in the header.
    expect(screen.getAllByRole("button", { name: t.draftCardDiscard })).toHaveLength(1);
  });

  it("B-13 ready: the balance line sits over the actions under the table", () => {
    renderView("ready");
    expect(screen.getByText(t.draftReadyBalanceLine.replace("{amount}", "$2.46"))).toBeTruthy();
  });

  it.each(["waiting", "signed-out", "loading"] as const)("B-13 %s: no balance line", (variant) => {
    renderView(variant);
    expect(screen.queryByText(t.draftReadyBalanceLine.split("{amount}")[0], { exact: false })).toBeNull();
  });

  it.each([
    ["signed-out", "draftSignedOutCardTitle"],
    ["waiting", "draftCardTitle"],
    ["ready", "draftReadyTitle"],
  ] as const)("%s: the title names the draft with that state's copy", (variant, key) => {
    renderView(variant);
    expect(screen.getByRole("heading", { name: t[key].replace("{amount}", "$2.46").replace("{name}", "My mix") })).toBeTruthy();
  });

  describe("027 A-10: editing in the table", () => {
    const pctField = (symbol: string) => screen.getByLabelText(`${te.target} ${symbol}`) as HTMLInputElement;
    const simUsd = (symbol: string) =>
      within(screen.getByRole("list", { name: t.draftSimListLabel }))
        .getByText(symbol)
        .closest("li")!
        .textContent!.split("≈ ")[1];

    it("'Edit targets' turns the table editable; the main action and 'Delete draft' step aside", () => {
      const { primary } = renderView();
      fireEvent.click(screen.getByRole("button", { name: te.editPanel }));
      expect(pctField("nBTC").value).toBe("60");
      expect(screen.getByText(t.draftEditModeBanner)).toBeTruthy();
      expect(screen.getByRole("button", { name: te.lockAll })).toBeTruthy();
      expect(screen.queryByRole("button", { name: t.draftCardDeposit })).toBeNull();
      expect(screen.queryByRole("button", { name: t.draftCardDiscard })).toBeNull();
      expect(screen.queryByRole("button", { name: te.editPanel })).toBeNull();
      expect(primary).not.toHaveBeenCalled();
    });

    it("a typed target re-spreads the free rows, and the charts and simulation follow", () => {
      const { onUnsavedChange } = renderView();
      fireEvent.click(screen.getByRole("button", { name: te.editPanel }));
      expect(simUsd("nBTC")).toBe("$6,000.00");
      fireEvent.change(pctField("nBTC"), { target: { value: "70" } });
      expect(pctField("NEAR").value).toBe("30");
      expect(simUsd("nBTC")).toBe("$7,000.00");
      expect(simUsd("NEAR")).toBe("$3,000.00");
      expect(screen.getAllByRole("button", { name: "nBTC: 70.0%, $0.00" }).length).toBeGreaterThan(0);
      expect(onUnsavedChange).toHaveBeenLastCalledWith(true);
    });

    it("'Save draft' hands over the edited rows and leaves edit mode", () => {
      const { onSaveRows, onUnsavedChange } = renderView();
      fireEvent.click(screen.getByRole("button", { name: te.editPanel }));
      fireEvent.change(pctField("nBTC"), { target: { value: "70" } });
      fireEvent.click(screen.getByRole("button", { name: t.draftSaveDraft }));
      expect(onSaveRows).toHaveBeenCalledWith([
        { tokenId: BTC, targetPct: 70, tolerancePct: 10, locked: false },
        { tokenId: NEAR, targetPct: 30, tolerancePct: 5, locked: false },
      ]);
      expect(screen.queryByLabelText(`${te.target} nBTC`)).toBeNull();
      expect(screen.getAllByRole("button", { name: t.draftCardDeposit })).toHaveLength(2);
      expect(document.activeElement).toBe(screen.getByRole("button", { name: te.editPanel }));
      expect(onUnsavedChange).toHaveBeenLastCalledWith(false);
    });

    it("'Cancel' drops the edits", () => {
      const { onSaveRows, onUnsavedChange } = renderView();
      fireEvent.click(screen.getByRole("button", { name: te.editPanel }));
      fireEvent.change(pctField("nBTC"), { target: { value: "70" } });
      fireEvent.click(screen.getByRole("button", { name: te.cancelEdit }));
      expect(onSaveRows).not.toHaveBeenCalled();
      expect(screen.getByText("60.0%")).toBeTruthy();
      expect(simUsd("nBTC")).toBe("$6,000.00");
      expect(onUnsavedChange).toHaveBeenLastCalledWith(false);
    });

    it("a save the caller refuses says why, and stays in edit mode", () => {
      renderView("waiting", DRAFT, { ok: false, reason: "target-not-positive", tokenId: NEAR });
      fireEvent.click(screen.getByRole("button", { name: te.editPanel }));
      fireEvent.click(screen.getByRole("button", { name: t.draftSaveDraft }));
      const dialog = screen.getByRole("dialog", { name: te.saveBlockedTitle });
      expect(dialog.textContent).toContain(`NEAR: ${t.draftTargetNotPositive}`);
      fireEvent.click(within(dialog).getByRole("button", { name: te.saveBlockedClose }));
      expect(pctField("nBTC")).toBeTruthy();
    });

    it("a 0% row says what a draft needs, not '…or a balance'", () => {
      renderView();
      fireEvent.click(screen.getByRole("button", { name: te.editPanel }));
      fireEvent.change(pctField("nBTC"), { target: { value: "100" } });
      expect(screen.getByText(t.draftTargetNotPositive)).toBeTruthy();
      expect(screen.queryByText(te.ruleZeroTargetZeroBalance)).toBeNull();
    });

    it("'Remove' from read mode starts editing and asks first; confirming re-spreads", () => {
      renderView();
      fireEvent.click(screen.getByRole("button", { name: `${te.removeEmpty} NEAR` }));
      const dialog = screen.getByRole("dialog", { name: new RegExp(`^${te.removeEmptyTitle.replace("{symbol}", "NEAR")}`) });
      expect(pctField("nBTC").value).toBe("60");
      fireEvent.click(within(dialog).getByRole("button", { name: te.removeEmptyConfirm }));
      expect(screen.queryByLabelText(`${te.target} NEAR`)).toBeNull();
      expect(pctField("nBTC").value).toBe("100");
      // The last row cannot go (A-11).
      expect(screen.getByRole("button", { name: `${te.removeEmpty} nBTC` }).getAttribute("aria-disabled")).toBe("true");
    });

    it("cancelling the remove dialog keeps the row (and edit mode)", () => {
      renderView();
      fireEvent.click(screen.getByRole("button", { name: `${te.removeEmpty} NEAR` }));
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: te.cancel }));
      expect(pctField("NEAR").value).toBe("40");
    });

    it("Composition's lock rule: a removal that leaves one free row locks them all, and says so", () => {
      renderView("waiting", THREE);
      fireEvent.click(screen.getByRole("button", { name: te.editPanel }));
      fireEvent.click(screen.getByRole("button", { name: `${te.unlocked} SOL` }));
      fireEvent.click(screen.getByRole("button", { name: `${te.removeEmpty} NEAR` }));
      // BTC is the only other free row: it takes NEAR's %, and is left alone free.
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: te.removeEmptyConfirm }));
      expect(pctField("nBTC").value).toBe("80");
      expect(screen.getByText(te.autoLockedAfterRemove)).toBeTruthy();
      expect(pctField("nBTC").disabled).toBe(true);
      // "Unlock all" brings them back.
      fireEvent.click(screen.getByRole("button", { name: te.unlockAll }));
      expect(pctField("nBTC").disabled).toBe(false);
    });

    it("the remove dialog warns when the % spreads over locked rows (A-11)", () => {
      renderView("waiting", THREE);
      fireEvent.click(screen.getByRole("button", { name: te.editPanel }));
      fireEvent.click(screen.getByRole("button", { name: te.lockAll }));
      fireEvent.click(screen.getByRole("button", { name: `${te.removeEmpty} SOL` }));
      expect(screen.getByRole("dialog").textContent).toContain(te.removeSpreadsOverLocked.split("{pct}")[0]);
    });

    it("'+ Add token' starts editing on the picker; an added token takes a share of the free part", () => {
      renderView();
      fireEvent.click(screen.getByRole("button", { name: `+ ${te.addTarget}` }));
      const picker = screen.getByRole("dialog", { name: t.draftAddToken });
      expect(document.activeElement).toBe(within(picker).getByLabelText(te.searchToken));
      fireEvent.change(within(picker).getByLabelText(te.searchToken), { target: { value: "sol" } });
      fireEvent.click(within(picker).getAllByRole("button", { name: new RegExp(`^${te.addTokensAddAction} SOL — `) })[0]);
      fireEvent.click(within(picker).getByRole("button", { name: t.presetReviewBack }));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(pctField("SOL").value).toBe("33.33");
      expect(screen.getByRole("button", { name: t.draftSaveDraft })).toBeTruthy();
    });

    it("leaving the view says there is nothing unsaved any more", () => {
      const { onUnsavedChange } = renderView();
      fireEvent.click(screen.getByRole("button", { name: te.editPanel }));
      fireEvent.change(pctField("nBTC"), { target: { value: "70" } });
      act(() => cleanup());
      expect(onUnsavedChange).toHaveBeenLastCalledWith(false);
    });
  });

  it("shows the simulation under the table (D-358)", () => {
    renderView();
    expect(screen.getByRole("heading", { name: t.draftSimTitle })).toBeTruthy();
    expect(screen.getByRole("list", { name: t.draftSimListLabel })).toBeTruthy();
  });

  it("D-457: the simulation opens on the draft's amount ($100 without one) and stores what is typed", () => {
    const amount = () => (screen.getByLabelText(t.draftSimAmountLabel) as HTMLInputElement).value;
    const { onSimulationUsdChange, rerender } = renderView("waiting", { ...DRAFT, simulationUsd: 10 });
    expect(amount()).toBe("10");
    fireEvent.change(screen.getByLabelText(t.draftSimAmountLabel), { target: { value: "25" } });
    expect(onSimulationUsdChange).toHaveBeenLastCalledWith(25);

    // The store echoing the amount back (same save) leaves the field as typed…
    rerender({ ...DRAFT, simulationUsd: 25 });
    expect(amount()).toBe("25");
    // …and a save in the editor, open over this view, shows the amount saved there.
    rerender({ ...DRAFT, simulationUsd: 7, updatedAt: 2 });
    expect(amount()).toBe("7");
    rerender({ ...DRAFT, updatedAt: 3 });
    expect(amount()).toBe(SIMULATION_DEFAULT_USD.toLocaleString("en-US"));
  });

  it("'Delete draft' asks first, under the table; 'No' keeps it and gives the focus back", () => {
    const { onDiscard } = renderView();
    const discard = screen.getByRole("button", { name: t.draftCardDiscard });
    fireEvent.click(discard);
    const question = screen.getByRole("group", { name: t.draftCardDiscardQuestion });
    // The question takes the actions' place next to "+ Add target".
    expect(within(question.parentElement!).getByRole("button", { name: `+ ${te.addTarget}` })).toBeTruthy();
    expect(screen.queryByRole("button", { name: te.editPanel })).toBeNull();
    expect(document.activeElement).toBe(within(question).getByRole("button", { name: t.draftCardDiscardNo }));

    fireEvent.click(within(question).getByRole("button", { name: t.draftCardDiscardNo }));
    expect(onDiscard).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: t.draftCardDiscard }));

    fireEvent.click(screen.getByRole("button", { name: t.draftCardDiscard }));
    fireEvent.click(screen.getByRole("button", { name: t.draftCardDiscardYes }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it("ready: deleting says the funds stay in the funding account", () => {
    renderView("ready");
    fireEvent.click(screen.getByRole("button", { name: t.draftCardDiscard }));
    expect(screen.getByRole("group", { name: t.draftReadyDiscardQuestion })).toBeTruthy();
  });
});

// D-397 (plan 041, P3): next to "Connect", while connecting the wrong account can still be avoided.
describe("NewPortfolioDraftView — the draft that connecting would replace", () => {
  const t = shellTranslations.en;
  const stored = (name: string, updatedAt: number) => ({ ...DRAFT, name, updatedAt });
  const seed = (store: Record<string, unknown>) =>
    window.localStorage.setItem(NEW_PORTFOLIO_DRAFT_KEY, JSON.stringify(store));
  const view = (variant: "signed-out" | "waiting") => (
    <NewPortfolioDraftView
      draft={stored("Anon", 100)}
      onSaveRows={() => ({ ok: true })}
      onDiscard={vi.fn()}
      onSimulationUsdChange={vi.fn()}
      {...(variant === "signed-out" ? { variant, onConnect: vi.fn() } : { variant, onDeposit: vi.fn() })}
    />
  );

  beforeEach(() => {
    state.lang = "en";
    window.localStorage.clear();
  });
  afterEach(cleanup);

  it("names the draft and the account", () => {
    seed({ "*anonymous": stored("Anon", 100), "alice.near": stored("Her mix", 50) });
    render(view("signed-out"));
    expect(
      screen.getByText(t.draftReplacedOnConnect.replace("{name}", "Her mix").replace("{account}", "alice.near"))
    ).toBeTruthy();
  });

  it("with several: the most recent, and how many more", () => {
    seed({ "*anonymous": stored("Anon", 100), "a.near": stored("Old", 10), "b.near": stored("Recent", 90), "c.near": stored("Mid", 50) });
    render(view("signed-out"));
    expect(
      screen.getByText(
        t.draftReplacedOnConnectMany.replace("{name}", "Recent").replace("{account}", "b.near").replace("{count}", "2")
      )
    ).toBeTruthy();
  });

  it("a name with placeholders or replacement patterns reads as typed", () => {
    seed({ "*anonymous": stored("Anon", 100), "alice.near": stored("{count} $& mix", 50), "bob.near": stored("Older", 10) });
    render(view("signed-out"));
    const shown = screen.getByText(/This browser already has/).textContent;
    expect(shown).toContain("“{count} $& mix” from alice.near and 1 more");
  });

  it("follows the store: a draft discarded elsewhere takes the notice with it", () => {
    seed({ "*anonymous": stored("Anon", 100), "alice.near": stored("Her mix", 50) });
    render(view("signed-out"));
    expect(screen.getByText(/This browser already has/)).toBeTruthy();
    act(() => {
      seed({ "*anonymous": stored("Anon", 100) });
      window.dispatchEvent(new StorageEvent("storage", { key: NEW_PORTFOLIO_DRAFT_KEY }));
    });
    expect(screen.queryByText(/This browser already has/)).toBeNull();
  });

  it("cuts a long account", () => {
    const id = `0x${"a".repeat(40)}`;
    seed({ "*anonymous": stored("Anon", 100), [id]: stored("Her mix", 50) });
    render(view("signed-out"));
    expect(screen.queryByText(new RegExp(id))).toBeNull();
    expect(screen.getByText(new RegExp(`${id.slice(0, 12)}…${id.slice(-8)}`))).toBeTruthy();
  });

  it("says nothing with no other draft, or with a wallet connected", () => {
    seed({ "*anonymous": stored("Anon", 100) });
    render(view("signed-out"));
    expect(screen.queryByText(/This browser already has/)).toBeNull();
    cleanup();
    seed({ "*anonymous": stored("Anon", 100), "alice.near": stored("Her mix", 50) });
    render(view("waiting"));
    expect(screen.queryByText(/This browser already has/)).toBeNull();
  });
});

// D-569: a saved mix with stocks says, before any deposit, that it can't be created from here.
describe("NewPortfolioDraftView — where stocks can't be bought (D-569)", () => {
  const NVDA = "nep141:bnb-0xa9ee28c80f960b889dfbd1902055218cba016f75.omdep.near";
  const WITH_STOCK: NewPortfolioDraft = {
    ...DRAFT,
    rows: [
      { tokenId: NVDA, targetPct: 60, tolerancePct: 10, locked: false },
      { tokenId: NEAR, targetPct: 40, tolerancePct: 5, locked: false },
    ],
  };
  const te = editorTranslations.en;
  beforeEach(() => {
    state.lang = "en";
  });
  afterEach(cleanup);

  it("says so under the title, signed out or waiting for funds", () => {
    setCountry("US");
    renderView("signed-out", WITH_STOCK);
    expect(screen.getByText(te.stockRegionBlockedCreate)).toBeTruthy();
    cleanup();
    renderView("waiting", WITH_STOCK);
    expect(screen.getByText(te.stockRegionBlockedCreate)).toBeTruthy();
  });

  it("says nothing for a mix without stocks, or from anywhere else (control)", () => {
    setCountry("US");
    renderView("waiting", DRAFT);
    expect(screen.queryByText(te.stockRegionBlockedCreate)).toBeNull();
    cleanup();
    setCountry("AR");
    renderView("waiting", WITH_STOCK);
    expect(screen.queryByText(te.stockRegionBlockedCreate)).toBeNull();
  });
});
