// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { shellTranslations } from "@/features/dashboard-shell/lib/translations";
import type { NotExecutedAllocate, PendingAllocate } from "../lib/pending-allocates";

// D-293: the My Account notice. The deciding rule is tested in `pending-allocates.test.ts`
// and the re-evaluation in `use-pending-allocates.test.tsx`; this is what the user reads.

const state = vi.hoisted(() => ({
  lang: "en" as "en" | "es",
  pending: undefined as PendingAllocate[] | undefined,
  notExecuted: [] as NotExecutedAllocate[],
  dismissNotExecuted: vi.fn(),
}));

vi.mock("@/features/dashboard-shell/context/language-context", () => ({
  useLanguage: () => ({ lang: state.lang, setLang: vi.fn() }),
}));
vi.mock("../hooks/use-pending-allocates", () => ({
  usePendingAllocates: () => ({
    pending: state.pending,
    notExecuted: state.notExecuted,
    dismissNotExecuted: state.dismissNotExecuted,
    isFetching: false,
  }),
}));

import { PendingAllocatesBanner } from "./pending-allocates-banner";

const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);
const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

function entry(over: Partial<PendingAllocate> = {}): PendingAllocate {
  return {
    id: "rec-1",
    portfolioName: "Mi cartera",
    op: "setup",
    portfolioId: null,
    // The record holds INTENTS ids: NEAR is `nep141:wrap.near`, not the registry's "near".
    legs: [{ tokenId: "nep141:wrap.near", amount: "300000000000000000000000" }],
    createdAt: NOW - 60_000,
    kind: "completing",
    ...over,
  };
}

describe.each(["en", "es"] as const)("PendingAllocatesBanner (%s)", (lang) => {
  const t = shellTranslations[lang];

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date", "setInterval", "clearInterval"] });
    state.lang = lang;
    state.notExecuted = [];
    state.dismissNotExecuted.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("one entry: its name, amounts in human units, age and status", () => {
    state.pending = [entry()];
    render(<PendingAllocatesBanner signerId="alice.near" />);

    const section = screen.getByRole("region", { name: t.pendingAllocatesTitleOne });
    expect(section.textContent).toContain(t.pendingAllocatesBodyOne);
    const [row] = within(section).getAllByRole("listitem");
    expect(row.textContent).toContain("Mi cartera");
    expect(row.textContent).toContain("0.30 NEAR");
    expect(row.textContent).not.toContain("300000000000000000000000");
    expect(row.textContent).toContain(t.pendingAllocateCompleting);
    expect(row.querySelector("time")?.textContent).toBe(lang === "en" ? "1 minute ago" : "hace 1 minuto");
  });

  it("a record under the team's review: its pill, and the note said once (D-448)", () => {
    state.pending = [entry({ id: "r1", kind: "review" }), entry({ id: "r2", kind: "review", portfolioName: "Otra" })];
    render(<PendingAllocatesBanner signerId="alice.near" />);

    const section = screen.getByRole("region");
    const rows = within(section).getAllByRole("listitem");
    for (const row of rows) {
      expect(row.textContent).toContain(t.pendingAllocateReview);
      expect(row.textContent).not.toContain(t.pendingAllocateCompleting);
    }
    expect(section.textContent?.split(t.pendingAllocatesReviewNote)).toHaveLength(2);
    // Amber, like "not confirmed yet" — never red.
    expect(within(section).getAllByText(t.pendingAllocateReview)[0].className).toContain("amber");
  });

  it("no review note without a record under review", () => {
    state.pending = [entry(), entry({ id: "rec-2", kind: "confirming" })];
    render(<PendingAllocatesBanner signerId="alice.near" />);
    expect(screen.getByRole("region").textContent).not.toContain(t.pendingAllocatesReviewNote);
  });

  it("two entries: the plural copy, every row, each with its own status and legs", () => {
    state.pending = [
      entry({
        id: "rec-2",
        portfolioName: "Stables",
        kind: "confirming",
        createdAt: NOW - 10_000,
        legs: [
          { tokenId: USDC, amount: "12500000" },
          { tokenId: "nep141:wrap.near", amount: "1000000000000000000000000" },
        ],
      }),
      entry(),
    ];
    render(<PendingAllocatesBanner signerId="alice.near" />);

    // D-552: one unproven row is enough for the notice not to say the funds left.
    const title = t.pendingAllocatesTitleMixedMany.replace("{count}", "2");
    const section = screen.getByRole("region", { name: title });
    expect(section.textContent).toContain(t.pendingAllocatesBodyUnconfirmedMany);
    expect(section.textContent).not.toContain(t.pendingAllocatesBodyMany);
    const rows = within(section).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Stables");
    expect(rows[0].textContent).toContain("12.50 USDC(NEAR)");
    expect(rows[0].textContent).toContain("1.00 NEAR");
    expect(rows[0].textContent).toContain(t.pendingAllocateConfirming);
    expect(rows[0].querySelector("time")?.textContent).toBe(t.pendingAllocateJustNow);
    expect(rows[1].textContent).toContain(t.pendingAllocateCompleting);
  });

  // D-321: funds added to a portfolio that exists are not "being created".
  it("one top-up: its own title and body, and the row says where the funds are going", () => {
    state.pending = [entry({ op: "allocate_into", portfolioName: "canary-931" })];
    render(<PendingAllocatesBanner signerId="alice.near" />);

    const section = screen.getByRole("region", { name: t.pendingAllocatesTitleAddOne });
    expect(section.textContent).toContain(t.pendingAllocatesBodyAddOne);
    expect(section.textContent).not.toContain(t.pendingAllocatesTitleOne);
    const row = within(section).getByRole("listitem");
    expect(row.textContent).toContain(t.pendingAllocateAddingTo.replace("{name}", "canary-931"));
    expect(row.textContent).toContain(t.pendingAllocateCompletingAdd);
  });

  it("a creation and a top-up together: the neutral plural, each row worded by its own op", () => {
    state.pending = [
      entry({ id: "rec-2", op: "allocate_into", portfolioName: "canary-931", kind: "confirming" }),
      entry(),
    ];
    render(<PendingAllocatesBanner signerId="alice.near" />);

    const title = t.pendingAllocatesTitleMixedMany.replace("{count}", "2");
    const section = screen.getByRole("region", { name: title });
    expect(section.textContent).toContain(t.pendingAllocatesBodyUnconfirmedMany);
    const rows = within(section).getAllByRole("listitem");
    expect(rows[0].textContent).toContain(t.pendingAllocateAddingTo.replace("{name}", "canary-931"));
    expect(rows[0].textContent).toContain(t.pendingAllocateConfirming);
    expect(rows[1].textContent).toContain("Mi cartera");
    expect(rows[1].textContent).not.toContain(t.pendingAllocateAddingTo.replace("{name}", "Mi cartera"));
    expect(rows[1].textContent).toContain(t.pendingAllocateCompleting);
  });

  it("two proven entries: the plural that says the funds left", () => {
    state.pending = [entry(), entry({ id: "rec-2", portfolioName: "Stables" })];
    render(<PendingAllocatesBanner signerId="alice.near" />);
    const section = screen.getByRole("region", { name: t.pendingAllocatesTitleMany.replace("{count}", "2") });
    expect(section.textContent).toContain(t.pendingAllocatesBodyMany);
  });

  // D-552: the real case. A deposit that never ran read "these funds already left your account".
  it.each(["setup", "allocate_into"] as const)("one unproven %s claims nothing about the funds", (op) => {
    state.pending = [entry({ op, kind: "confirming" })];
    render(<PendingAllocatesBanner signerId="alice.near" />);

    const section = screen.getByRole("region", { name: t.pendingAllocatesTitleUnconfirmedOne });
    expect(section.textContent).toContain(t.pendingAllocatesBodyUnconfirmedOne);
    expect(section.textContent).not.toContain(t.pendingAllocatesBodyOne);
    expect(section.textContent).not.toContain(t.pendingAllocatesBodyAddOne);
    expect(within(section).getByRole("listitem").textContent).toContain(t.pendingAllocateConfirming);
  });

  describe("an Allocate that never ran (D-556)", () => {
    const never = (over: Partial<NotExecutedAllocate> = {}): NotExecutedAllocate => ({
      id: "gone-1",
      portfolioName: "Largo plazo",
      op: "allocate_into",
      portfolioId: "p_4",
      legs: [{ tokenId: USDC, amount: "25000000" }],
      createdAt: NOW - 60_000,
      ...over,
    });

    it("says it did not happen, where the funds are, and what was attempted", () => {
      state.pending = [];
      state.notExecuted = [never()];
      render(<PendingAllocatesBanner signerId="alice.near" />);

      const section = screen.getByRole("region", { name: t.notExecutedAllocatesTitleOne });
      expect(section.textContent).toContain(t.notExecutedAllocatesBody);
      const row = within(section).getByRole("listitem");
      expect(row.textContent).toContain("Largo plazo");
      expect(row.textContent).toContain("25.00 USDC(NEAR)");
      expect(row.querySelector("time")?.textContent).toBe(lang === "en" ? "1 minute ago" : "hace 1 minuto");
      // It is not on its way: none of the wording of a move in progress.
      expect(row.textContent).not.toContain(t.pendingAllocateAddingTo.replace("{name}", "Largo plazo"));
      expect(section.textContent).not.toContain(t.pendingAllocateConfirming);
    });

    it("the plural, and one dismissal covers every row shown", () => {
      state.pending = [];
      state.notExecuted = [never(), never({ id: "gone-2", portfolioName: "Otra" })];
      render(<PendingAllocatesBanner signerId="alice.near" />);

      const section = screen.getByRole("region", { name: t.notExecutedAllocatesTitleMany.replace("{count}", "2") });
      fireEvent.click(within(section).getByRole("button", { name: t.notExecutedAllocatesDismiss }));
      expect(state.dismissNotExecuted).toHaveBeenCalledWith(["gone-1", "gone-2"]);
    });

    it("sits above the moves still in progress, each in its own section", () => {
      state.pending = [entry()];
      state.notExecuted = [never()];
      render(<PendingAllocatesBanner signerId="alice.near" />);

      const sections = screen.getAllByRole("region");
      expect(sections.map((s) => s.getAttribute("aria-labelledby"))).toEqual([
        "not-executed-allocates-heading",
        "pending-allocates-heading",
      ]);
    });

    it("still shows while the pending list is being re-evaluated", () => {
      state.pending = undefined;
      state.notExecuted = [never()];
      render(<PendingAllocatesBanner signerId="alice.near" />);
      expect(screen.getByRole("region", { name: t.notExecutedAllocatesTitleOne })).toBeTruthy();
    });
  });

  it("a token the registry does not know shows its id, truncated, and no amount", () => {
    const unknown = "nep245:v2_1.omni.hot.tg:9999_notInTheRegistryXXXXXXXXXXXXXXXXXXXXXXXXXXzzQ";
    state.pending = [entry({ legs: [{ tokenId: unknown, amount: "999999" }] })];
    render(<PendingAllocatesBanner signerId="alice.near" />);

    const row = screen.getByRole("listitem");
    expect(row.textContent).toContain("nep245:v2_…XzzQ");
    expect(row.textContent).not.toContain(unknown);
    expect(row.textContent).not.toContain("999999");
  });

  it.each([
    ["empty", []],
    ["loading", undefined],
  ] as const)("renders nothing when %s", (_, pending) => {
    state.pending = pending as PendingAllocate[] | undefined;
    const { container } = render(<PendingAllocatesBanner signerId="alice.near" />);
    expect(container.innerHTML).toBe("");
  });
});
