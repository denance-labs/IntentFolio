// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { translations } from "../lib/translations";
import { COUNTRY_COOKIE } from "@/features/stocks/lib/stock-region";
import { AddTargetsModal } from "./add-targets-modal";

// D-529: "Add tokens" only adds targets to the draft (at 0%); funds come in through "Add funds".
// D-534: a marked token reads apart from the rest.

const USDC_ETH = "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near";
type Opts = {
  lang?: "en" | "es";
  compositionTokenIds?: string[];
  existingBalances?: Record<string, number>;
};

function renderModal(opts: Opts = {}) {
  const calls = { onAddTarget: vi.fn(), onClose: vi.fn() };
  render(
    <AddTargetsModal
      t={translations[opts.lang ?? "en"]}
      compositionTokenIds={opts.compositionTokenIds ?? []}
      existingBalances={opts.existingBalances ?? {}}
      onAddTarget={calls.onAddTarget}
      onClose={calls.onClose}
    />
  );
  return calls;
}

function rowOf(symbol: string, name?: string): HTMLElement {
  const row = screen
    .getAllByRole("listitem")
    .find(
      (li) =>
        li.querySelector("span.font-semibold")?.textContent === symbol &&
        (name === undefined || li.querySelector("span.truncate")?.textContent === name)
    );
  if (!row) throw new Error(`no row for ${symbol}`);
  return row;
}

const symbols = () =>
  screen.getAllByRole("listitem").map((li) => li.querySelector("span.font-semibold")?.textContent);

// D-569: the cookie the middleware writes from Vercel's country header.
const setCountry = (code: string | null) => {
  document.cookie = code ? `${COUNTRY_COOKIE}=${code}; path=/` : `${COUNTRY_COOKIE}=; path=/; max-age=0`;
};
afterEach(() => setCountry(null));

describe.each(["en", "es"] as const)("AddTargetsModal — %s", (lang) => {
  const t = translations[lang];
  afterEach(cleanup);

  // D-558: the stocks lead, in a section that holds their note once.
  it("lists the stocks first, with the note once and each one marked", () => {
    renderModal({ lang });
    expect(symbols().slice(0, 6)).toEqual(["AAPL", "AMZN", "GOOGL", "NVDA", "QQQ", "TSLA"]);
    expect(screen.getAllByText(t.stockSectionNote)).toHaveLength(1);
    expect(screen.getByRole("list", { name: t.stockSectionTitle })).toBeTruthy();
    expect(screen.getByRole("list", { name: t.stockOtherTokens })).toBeTruthy();
    expect(rowOf("NVDA").textContent).toContain(t.stockChipStock);
    expect(rowOf("QQQ").textContent).toContain(t.stockChipEtf);
    expect(rowOf("NEAR", "NEAR Protocol").textContent).not.toContain(t.stockChipStock);
  });

  it("drops both headings when a search finds no stock, and keeps the section when it finds one", () => {
    renderModal({ lang });
    const search = screen.getByRole("textbox", { name: t.searchToken });
    fireEvent.change(search, { target: { value: "usdc" } });
    expect(screen.queryByText(t.stockSectionTitle)).toBeNull();
    expect(screen.queryByText(t.stockOtherTokens)).toBeNull();
    fireEvent.change(search, { target: { value: "nvda" } });
    expect(screen.getByText(t.stockSectionTitle)).toBeTruthy();
    expect(screen.queryByText(t.stockOtherTokens)).toBeNull();
    expect(symbols()).toEqual(["NVDA"]);
  });

  it("offers «Add» on a token outside the portfolio, with no amount field", () => {
    renderModal({ lang });
    expect(within(rowOf("NEAR")).getByRole("button", { name: /NEAR/ }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByRole("spinbutton")).toBeNull();
  });

  it("a token in the composition reads «In portfolio» and has no button", () => {
    renderModal({ lang, compositionTokenIds: ["near"] });
    const row = rowOf("NEAR");
    expect(row.textContent).toContain(t.addTokensInPortfolio);
    expect(within(row).queryByRole("button")).toBeNull();
  });

  it("a token held outside the composition is in the portfolio too", () => {
    renderModal({ lang, existingBalances: { near: 1 } });
    expect(within(rowOf("NEAR")).queryByRole("button")).toBeNull();
  });

  it("a token that can't be a target is listed, never offered", () => {
    renderModal({ lang });
    const row = rowOf("BTC");
    expect(row.textContent).toContain(t.addTokensNotAvailableYet);
    expect(within(row).queryByRole("button")).toBeNull();
  });

  it("lists the ones that can't be a target last", () => {
    renderModal({ lang });
    const list = symbols();
    expect(list.indexOf("BTC")).toBeGreaterThan(list.indexOf("NEAR"));
    expect(list.indexOf("BTC")).toBeGreaterThan(list.indexOf("USDC(ETH)"));
  });

  it("marking a token presses its button and says «Added»; tapping again unmarks it", () => {
    renderModal({ lang });
    const button = within(rowOf("NEAR")).getByRole("button", { name: /NEAR/ });
    fireEvent.click(button);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.textContent).toBe(t.addTokensAdded);
    fireEvent.click(button);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.textContent).toBe(t.addTokensAddAction);
  });

  it("the confirm button counts what it adds, and is off with nothing marked", () => {
    renderModal({ lang });
    expect((screen.getByRole("button", { name: t.addTargetsConfirm }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(rowOf("NEAR")).getByRole("button", { name: /NEAR/ }));
    expect((screen.getByRole("button", { name: t.addTargetsConfirmOne }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(within(rowOf("USDC(ETH)")).getByRole("button", { name: /USDC\(ETH\)/ }));
    expect(screen.getByRole("button", { name: t.addTargetsConfirmMany.replace("{n}", "2") })).toBeTruthy();
  });

  it("confirm adds each marked token once, at a click, and closes", () => {
    const calls = renderModal({ lang });
    fireEvent.click(within(rowOf("NEAR")).getByRole("button", { name: /NEAR/ }));
    fireEvent.click(within(rowOf("USDC(ETH)")).getByRole("button", { name: /USDC\(ETH\)/ }));
    fireEvent.click(screen.getByRole("button", { name: t.addTargetsConfirmMany.replace("{n}", "2") }));
    expect(calls.onAddTarget.mock.calls).toEqual([["near"], [USDC_ETH]]);
    expect(calls.onClose).toHaveBeenCalledTimes(1);
  });

  it("Cancel adds nothing", () => {
    const calls = renderModal({ lang });
    fireEvent.click(within(rowOf("NEAR")).getByRole("button", { name: /NEAR/ }));
    fireEvent.click(screen.getByRole("button", { name: t.cancel }));
    expect(calls.onAddTarget).not.toHaveBeenCalled();
    expect(calls.onClose).toHaveBeenCalledTimes(1);
  });

  it("at the 10-token cap the rest can't be marked, and it says why", () => {
    renderModal({ lang, compositionTokenIds: Array.from({ length: 9 }, (_, i) => `x-${i}`) });
    expect(document.body.textContent).not.toContain(t.appTooManyTokens.split("{")[0]);
    fireEvent.click(within(rowOf("NEAR")).getByRole("button", { name: /NEAR/ }));
    expect(document.body.textContent).toContain(t.appTooManyTokens.split("{")[0]);
    expect((within(rowOf("USDC(ETH)")).getByRole("button") as HTMLButtonElement).disabled).toBe(true);
    // The one already marked can still be taken back out.
    expect((within(rowOf("NEAR")).getByRole("button") as HTMLButtonElement).disabled).toBe(false);
  });

  it("search narrows the list by symbol or name", () => {
    renderModal({ lang });
    fireEvent.change(screen.getByLabelText(t.searchToken), { target: { value: "bitcoin" } });
    expect(symbols()).toContain("BTC");
    expect(symbols()).toContain("nBTC");
    expect(symbols()).not.toContain("NEAR");
    fireEvent.change(screen.getByLabelText(t.searchToken), { target: { value: "zzz-none" } });
    expect(document.body.textContent).toContain(t.noTokensFound);
  });
});

// D-558: the category only says "Stocks", so the Spanish word needs its own search term.
it("finds the stocks by the Spanish word", () => {
  renderModal({ lang: "es" });
  fireEvent.change(screen.getByRole("textbox", { name: translations.es.searchToken }), { target: { value: "acciones" } });
  expect(symbols()).toEqual(["AAPL", "AMZN", "GOOGL", "NVDA", "QQQ", "TSLA"]);
  cleanup();
});

// D-569: where stocks can't be bought, they are listed last and never offered. A stock the
// portfolio already has is left as it is: only adding one is blocked.
describe.each(["en", "es"] as const)("AddTargetsModal — where stocks can't be bought (%s)", (lang) => {
  const t = translations[lang];
  const NVDA = "nep141:bnb-0xa9ee28c80f960b889dfbd1902055218cba016f75.omdep.near";
  afterEach(cleanup);

  it("lists the stocks last, says why once, and offers none of them", () => {
    setCountry("US");
    renderModal({ lang });
    const lists = screen.getAllByRole("list");
    expect(lists[lists.length - 1]).toBe(screen.getByRole("list", { name: t.stockSectionTitle }));
    expect(symbols().slice(-6)).toEqual(["AAPL", "AMZN", "GOOGL", "NVDA", "QQQ", "TSLA"]);
    expect(screen.getAllByText(t.stockRegionBlockedNote)).toHaveLength(1);
    expect(screen.queryByText(t.stockSectionNote)).toBeNull();
    for (const symbol of ["AAPL", "NVDA", "QQQ"]) {
      expect(within(rowOf(symbol)).queryByRole("button")).toBeNull();
      expect(rowOf(symbol).textContent).toContain(t.stockRegionBlockedRow);
    }
    expect(within(rowOf("NEAR", "NEAR Protocol")).getByRole("button", { name: new RegExp(t.addTokensAddAction) })).toBeTruthy();
  });

  it("leaves a stock the portfolio already has as it is", () => {
    setCountry("CA");
    renderModal({ lang, compositionTokenIds: [NVDA] });
    expect(rowOf("NVDA").textContent).toContain(t.addTokensInPortfolio);
    expect(rowOf("NVDA").textContent).not.toContain(t.stockRegionBlockedRow);
  });

  it("offers them as always from anywhere else (control)", () => {
    setCountry("AR");
    renderModal({ lang });
    expect(symbols().slice(0, 6)).toEqual(["AAPL", "AMZN", "GOOGL", "NVDA", "QQQ", "TSLA"]);
    expect(within(rowOf("NVDA")).getByRole("button")).toBeTruthy();
    expect(screen.queryByText(t.stockRegionBlockedNote)).toBeNull();
  });
});
