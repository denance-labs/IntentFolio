// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { shellTranslations } from "@/features/dashboard-shell/lib/translations";
import type { ReturnView } from "../lib/vault-read-client";

// D-302 h2: the My Account notice for funds on their way back. Which Returns are listed is
// tested in `vault-returns.test.ts` and the v2 gate in `use-scheduled-returns.test.tsx`;
// this is what the user reads.

const state = vi.hoisted(() => ({
  lang: "en" as "en" | "es",
  readable: true,
  returns: undefined as ReturnView[] | undefined,
}));

vi.mock("@/features/dashboard-shell/context/language-context", () => ({
  useLanguage: () => ({ lang: state.lang, setLang: vi.fn() }),
}));
vi.mock("../hooks/use-scheduled-returns", () => ({
  scheduledReturnsReadable: () => state.readable,
  useScheduledReturns: () => ({ returns: state.returns, isFetching: false }),
}));

import { formatReturnDate, ScheduledReturnsNotice } from "./scheduled-returns-notice";

const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
const IN_3_DAYS = NOW / 1000 + 3 * 86_400;

function ret(over: Partial<ReturnView> = {}): ReturnView {
  return {
    id: 0,
    token: "near",
    amount: "1250000000000000000000000",
    to: "alice.near",
    reason: "credit_to_deleted_portfolio",
    eta: IN_3_DAYS,
    executing: false,
    ...over,
  };
}

describe.each(["en", "es"] as const)("ScheduledReturnsNotice (%s)", (lang) => {
  const t = shellTranslations[lang];

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date", "setInterval", "clearInterval"] });
    state.lang = lang;
    state.readable = true;
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    state.returns = undefined;
  });

  it("one row per Return: amount in human units and the arrival date", () => {
    state.returns = [ret()];
    render(<ScheduledReturnsNotice accountId="alice.near" />);

    const section = screen.getByRole("region", { name: t.scheduledReturnsTitle });
    expect(section.textContent).toContain(t.scheduledReturnsBody);
    const [row] = within(section).getAllByRole("listitem");
    const date = formatReturnDate(IN_3_DAYS, lang);
    const expected = t.scheduledReturnArrivesOn.replace("{amount}", "1.25 NEAR").replace("{date}", date);
    expect(row.textContent).toBe(expected);
    expect(row.querySelector("time")?.getAttribute("dateTime")).toBe(new Date(IN_3_DAYS * 1000).toISOString());
  });

  it("past its date or executing: says soon, not a date in the past", () => {
    state.returns = [ret({ id: 0, eta: NOW / 1000 - 60 }), ret({ id: 1, executing: true })];
    render(<ScheduledReturnsNotice accountId="alice.near" />);
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.textContent).toBe(t.scheduledReturnArrivesSoon.replace("{amount}", "1.25 NEAR"));
      expect(row.querySelector("time")).toBeNull();
    }
  });

  it("an unknown token shows its id and no amount", () => {
    state.returns = [ret({ token: "nep141:mystery.near", amount: "123456789" })];
    render(<ScheduledReturnsNotice accountId="alice.near" />);
    const [row] = screen.getAllByRole("listitem");
    // Truncated like the pending-allocates legs.
    expect(row.textContent).toContain("nep141:mys…near");
    expect(row.textContent).not.toContain("123456789");
  });

  it("hidden when the list is empty, still loading, or the build cannot read Returns", () => {
    state.returns = [];
    const { container, rerender } = render(<ScheduledReturnsNotice accountId="alice.near" />);
    expect(container.firstChild).toBeNull();
    state.returns = undefined;
    rerender(<ScheduledReturnsNotice accountId="alice.near" />);
    expect(container.firstChild).toBeNull();
    state.returns = [ret()];
    state.readable = false;
    rerender(<ScheduledReturnsNotice accountId="alice.near" />);
    expect(container.firstChild).toBeNull();
  });
});
