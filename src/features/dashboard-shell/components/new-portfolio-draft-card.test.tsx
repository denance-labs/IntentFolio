// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { bridgeTranslations } from "@/features/bridge/lib/translations";
import { MIN_FUNDED_USD } from "../lib/general-balance";
import type { NewPortfolioDraft } from "../lib/new-portfolio-draft";
import { shellTranslations } from "../lib/translations";

vi.mock("../context/language-context", () => ({ useLanguage: () => ({ lang: "en", setLang: vi.fn() }) }));

import { NewPortfolioDraftCard } from "./new-portfolio-draft-card";

// 016 block 2.3: My Account's card for a New Portfolio Draft waiting for funds; 2.4: the same
// card once the funds arrived ("ready"); 019-4: a way to the draft's tab, which edits and
// discards it (the view's tests cover the discard question).

const t = shellTranslations.en;
const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

function draft(rows: Array<[string, number]>, name = "My mix"): NewPortfolioDraft {
  return {
    v: 1,
    name,
    presetId: null,
    rows: rows.map(([tokenId, targetPct]) => ({ tokenId, targetPct, tolerancePct: 10, locked: false })),
    updatedAt: 1,
  };
}

function renderCard(d = draft([["near", 60], [USDC, 40]])) {
  const props = { onDeposit: vi.fn(), onView: vi.fn() };
  render(<NewPortfolioDraftCard variant="waiting" draft={d} {...props} />);
  return props;
}

function renderReady(d = draft([["near", 60], [USDC, 40]])) {
  const props = { onConfirm: vi.fn(), onView: vi.fn() };
  render(<NewPortfolioDraftCard variant="ready" draft={d} amountUsd={2.46} {...props} />);
  return props;
}

const button = (name: string) => screen.getByRole("button", { name });

afterEach(cleanup);

describe("NewPortfolioDraftCard", () => {
  // D-486, s283 QA: while the balance loads, a placeholder holds the body line's place.
  it("loading: a placeholder takes the body line, with no money action", () => {
    render(<NewPortfolioDraftCard variant="loading" draft={draft([["near", 100]])} onView={vi.fn()} />);
    expect(screen.getByTestId("draft-loading-line")).toBeTruthy();
    expect(screen.queryByRole("button", { name: t.draftCardDeposit })).toBeNull();
  });

  it("names the draft, says what it needs, and shows its mix", () => {
    renderCard();
    expect(screen.getByRole("heading", { name: "Your portfolio “My mix” is waiting for funds" })).toBeTruthy();
    expect(screen.getByText(t.draftCardBody)).toBeTruthy();
    const mix = within(screen.getByRole("list", { name: t.presetReviewComposition }));
    expect(mix.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["NEAR 60%", "USDC(NEAR) 40%"]);
  });

  it("names six tokens and counts the rest", () => {
    const rows: Array<[string, number]> = [
      ["near", 20],
      [USDC, 20],
      ["nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near", 10],
      ["nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", 10],
      ["nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", 10],
      ["nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near", 10],
      ["nep141:sui-c1b81ecaf27933252d31a963bc5e9458f13c18ce.omft.near", 10],
      ["nep141:aptos-34ee497f210c5a511e8d5b53bc56d75b63612bb5.omft.near", 10],
    ];
    renderCard(draft(rows));
    const items = within(screen.getByRole("list", { name: t.presetReviewComposition })).getAllByRole("listitem");
    expect(items).toHaveLength(7);
    expect(items[6].textContent).toBe("+2");
  });

  it("deposits and goes to the draft's tab through its callbacks", () => {
    const { onDeposit, onView } = renderCard();
    fireEvent.click(button(t.draftCardDeposit));
    fireEvent.click(button(t.draftCardView));
    expect(onDeposit).toHaveBeenCalledTimes(1);
    expect(onView).toHaveBeenCalledTimes(1);
  });

  // 019-4: the draft's tab is the one place to edit or discard it.
  it("has no edit and no discard of its own", () => {
    renderCard();
    expect(screen.queryByRole("button", { name: t.draftCardDiscard })).toBeNull();
    expect(screen.queryByRole("button", { name: /edit/i })).toBeNull();
  });
});

describe("NewPortfolioDraftCard — ready (016 block 2.4)", () => {
  it("says how much the general balance puts in and asks for the confirmation: no deposit, no edit, no discard", () => {
    const { onConfirm, onView } = renderReady();
    expect(
      screen.getByRole("heading", { name: "You have $2.46 in your funding account — assign it to “My mix” to start it" })
    ).toBeTruthy();
    expect(screen.queryByText(t.draftCardBody)).toBeNull();
    expect(screen.queryByRole("button", { name: t.draftCardDeposit })).toBeNull();
    expect(screen.queryByRole("button", { name: t.draftCardDiscard })).toBeNull();
    // The mix is still what the card shows.
    const mix = within(screen.getByRole("list", { name: t.presetReviewComposition }));
    expect(mix.getAllByRole("listitem")).toHaveLength(2);

    fireEvent.click(button(t.draftReadyConfirm));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(button(t.draftCardView));
    expect(onView).toHaveBeenCalledTimes(1);
  });
});

// 022-B (D-453): My Account signed out — the draft lives in this browser and connecting is
// the one money action.
describe("NewPortfolioDraftCard — signed out (022-B)", () => {
  it("says the draft is saved here, connects, and goes to its tab: no deposit, no confirmation", () => {
    const props = { onConnect: vi.fn(), onView: vi.fn() };
    render(<NewPortfolioDraftCard variant="signed-out" draft={draft([["near", 60], [USDC, 40]])} {...props} />);
    expect(screen.getByRole("heading", { name: "Your portfolio “My mix” is saved in this browser" })).toBeTruthy();
    expect(screen.getByText(t.draftSignedOutCardBody)).toBeTruthy();
    expect(screen.queryByRole("button", { name: t.draftCardDeposit })).toBeNull();
    expect(screen.queryByRole("button", { name: t.draftReadyConfirm })).toBeNull();
    expect(within(screen.getByRole("list", { name: t.presetReviewComposition })).getAllByRole("listitem")).toHaveLength(2);

    fireEvent.click(button(t.walletConnect));
    expect(props.onConnect).toHaveBeenCalledTimes(1);
    fireEvent.click(button(t.draftCardView));
    expect(props.onView).toHaveBeenCalledTimes(1);
  });
});

// 027 A-2: the floor is one cent (MIN_FUNDED_USD), too small to be worth saying, so the draft's
// copy names no amount. A "$" here means a minimum crept back in without the rule.
describe("the draft's copy names no minimum", () => {
  it.each(["en", "es"] as const)("%s: card, deposit modal and the empty confirmation", (lang) => {
    expect(MIN_FUNDED_USD).toBe(0.01);
    for (const copy of [
      shellTranslations[lang].draftCardBody,
      shellTranslations[lang].draftSignedOutCardBody,
      bridgeTranslations[lang].receiveModalSubtitleDraft,
      // The confirmation with nothing worth a cent to fund it (016 block 2.4, C2).
      shellTranslations[lang].presetReviewNoFunds,
    ]) {
      expect(copy).not.toContain("$");
    }
  });
});

// D-360: confirming the draft removes the card with the focus in it.
describe("NewPortfolioDraftCard — where the focus goes (D-360)", () => {
  afterEach(cleanup);

  function Host() {
    const [saved, setSaved] = useState(true);
    return saved ? (
      <NewPortfolioDraftCard variant="ready" draft={draft([["near", 100]])} amountUsd={2.46} onConfirm={() => setSaved(false)} onView={vi.fn()} />
    ) : (
      <button type="button" data-focus-landing>
        landing
      </button>
    );
  }

  it("when the card goes, the focus goes to the landing", () => {
    render(<Host />);
    const confirm = screen.getByRole("button", { name: t.draftReadyConfirm });
    confirm.focus();
    fireEvent.click(confirm);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "landing" }));
  });

  it("its title is where the focus can land when the card appears", () => {
    renderCard();
    const title = screen.getByRole("heading", { level: 2 });
    expect(title.hasAttribute("data-focus-landing")).toBe(true);
    title.focus();
    expect(document.activeElement).toBe(title);
  });
});
