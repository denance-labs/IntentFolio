// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { TokenPriceMap } from "@/features/market/types";
import type { NewPortfolioDraftRow } from "../lib/new-portfolio-draft";
import { shellTranslations } from "../lib/translations";

// D-358. The "This is how $100 would be split…" block (copy D-504): the same amount format as
// the rest of the app, and no units from a price that is not real. D-457: it opens on the
// draft's amount and reports every usable amount typed. D-503: whole dollars, grouped.

const BTC = "nep141:btc.omft.near";
const ETH = "nep141:eth.omft.near";
const NEAR = "near";
const quote = (usdPrice: number, source = "chaindefuser") => ({ symbol: "X", usdPrice, updatedAt: "", source });

const state = vi.hoisted(() => ({
  lang: "en" as "en" | "es",
  prices: {} as TokenPriceMap,
  isLoading: false,
}));
vi.mock("../context/language-context", () => ({ useLanguage: () => ({ lang: state.lang, setLang: vi.fn() }) }));
vi.mock("@/features/market/hooks/use-token-prices", () => ({
  useTokenPrices: () => ({ prices: state.prices, isLoading: state.isLoading }),
}));

import { NewPortfolioDraftSimulation } from "./new-portfolio-draft-simulation";

const row = (tokenId: string, targetPct: number): NewPortfolioDraftRow => ({
  tokenId,
  targetPct,
  tolerancePct: 5,
  locked: false,
});
const ROWS = [row(BTC, 70), row(ETH, 20), row(NEAR, 10)];

function renderSim(rows = ROWS, initialUsd = 100) {
  const onAmountChange = vi.fn();
  render(
    <NewPortfolioDraftSimulation
      rows={rows}
      colorOf={() => ({ hex: "#fff" })}
      initialUsd={initialUsd}
      onAmountChange={onAmountChange}
    />
  );
  return { onAmountChange };
}

describe.each(["en", "es"] as const)("NewPortfolioDraftSimulation (%s)", (lang) => {
  const t = shellTranslations[lang];
  const amountField = () => screen.getByLabelText(t.draftSimAmountLabel) as HTMLInputElement;
  const items = () => within(screen.getByRole("list", { name: t.draftSimListLabel })).getAllByRole("listitem");

  beforeEach(() => {
    state.lang = lang;
    state.isLoading = false;
    state.prices = { [BTC]: quote(80_000), [ETH]: quote(4_000), [NEAR]: quote(5) };
  });
  afterEach(cleanup);

  it("opens at $100 and shows each token's units and USD share, in the mix's order", () => {
    renderSim();
    expect(amountField().value).toBe("100");
    expect(items().map((li) => li.textContent)).toEqual([
      "BTC0.00088≈ $70.00",
      "ETH0.005≈ $20.00",
      "NEAR2≈ $10.00",
    ]);
    // D-504: one note under the list (it reverses D-456's "no note").
    expect(screen.getByText(t.draftSimNote)).toBeTruthy();
  });

  it("D-503: groups thousands with a comma while typing, in both languages, and reports it", () => {
    const { onAmountChange } = renderSim();
    fireEvent.change(amountField(), { target: { value: "12500" } });
    expect(amountField().value).toBe("12,500");
    expect(items()[2].textContent).toBe("NEAR250≈ $1,250.00");
    expect(onAmountChange).toHaveBeenLastCalledWith(12_500);
    // A comma typed in the middle is a grouping, not a decimal: it is re-laid.
    fireEvent.change(amountField(), { target: { value: "1,25,00" } });
    expect(amountField().value).toBe("12,500");
  });

  it("D-457: opens on the amount it is given, in whole dollars", () => {
    renderSim(ROWS, 10_000.4);
    expect(amountField().value).toBe("10,000");
    expect(items()[2].textContent).toBe("NEAR200≈ $1,000.00");
  });

  it("cuts what follows a point and drops what is not a number", () => {
    renderSim();
    fireEvent.change(amountField(), { target: { value: "$12.3456abc" } });
    expect(amountField().value).toBe("12");
  });

  it("asks for an amount when the field is empty or zero, and reports neither", () => {
    const { onAmountChange } = renderSim();
    fireEvent.change(amountField(), { target: { value: "" } });
    expect(screen.getByText(t.draftSimEnterAmount)).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
    fireEvent.change(amountField(), { target: { value: "0" } });
    expect(screen.getByText(t.draftSimEnterAmount)).toBeTruthy();
    expect(onAmountChange).not.toHaveBeenCalled();
  });

  it("says a token has no price right now instead of inventing units from the fallback", () => {
    state.prices = { ...state.prices, [ETH]: quote(1.58, "fallback") };
    renderSim();
    const [btc, eth] = items();
    expect(btc.textContent).toBe("BTC0.00088≈ $70.00");
    expect(eth.textContent).toBe(`ETH${t.draftSimNoPrice}≈ $20.00`);
  });

  it("hides the list with one line when no token has a real price", () => {
    state.prices = { [BTC]: quote(1, "fallback"), [ETH]: quote(1, "fallback"), [NEAR]: quote(1.58, "fallback") };
    renderSim();
    expect(screen.getByText(t.draftSimNoPrices)).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("says prices are loading until the first answer", () => {
    state.isLoading = true;
    renderSim();
    expect(screen.getByText(t.draftSimLoading)).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("marks dust the way the rest of the app does", () => {
    renderSim([row(BTC, 1), row(ETH, 99)]);
    fireEvent.change(amountField(), { target: { value: "1" } });
    expect(items()[0].textContent).toBe("BTC<0.00001≈ $0.01");
  });
});
