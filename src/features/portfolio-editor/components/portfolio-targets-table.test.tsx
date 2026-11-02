// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { PortfolioTargetsTable } from "./portfolio-targets-table";
import { translations } from "../lib/translations";
import { buildHeldNoTargetRows, computeTargets } from "../lib/calculations";
import { distributeUnlockedTargetPct } from "../lib/allocation";
import { formatCrypto } from "../lib/format";
import { buildChangeSet, buildPendingMarks, summarizeChangeSet } from "../lib/changeset";
import { validateComposition } from "../lib/validation";
import { tokenRegistry } from "@/features/market/lib/token-registry";
import { isPortfolioOfferable } from "@/features/bridge/lib/token-availability";
import type { TargetAllocation } from "../types";

const t = translations.en as Record<string, string>;
const [A, B, C, D] = tokenRegistry.slice(0, 4);
const row = (token: typeof A, targetPct: number, tolerancePct = 10): TargetAllocation => ({
  id: `row-${token.id}`,
  tokenId: token.id,
  targetPct,
  tolerancePct,
  locked: false,
});
const COMMITTED = [row(A, 40), row(B, 30), row(C, 30)];

afterEach(cleanup);

// Renders the table in edit mode for `draft`, marked against COMMITTED as the editor does.
function renderDraft(draft: TargetAllocation[], deltas: Record<string, number> = {}) {
  const qty = { [A.id]: 1, [B.id]: 1, [C.id]: 1 };
  const rows = computeTargets(draft, tokenRegistry, {}, qty, 300);
  const summary = summarizeChangeSet(buildChangeSet(COMMITTED, draft, deltas), COMMITTED, (id) =>
    tokenRegistry.find((x) => x.id === id)?.symbol ?? id
  );
  const onUndoRemove = vi.fn();
  render(
    <PortfolioTargetsTable
      t={t}
      rows={rows}
      isEditing
      allLocked={false}
      allUnlocked
      pending={buildPendingMarks(summary, COMMITTED)}
      onUndoRemove={onUndoRemove}
      onUpdateTarget={vi.fn()}
      onUpdateTargetPct={vi.fn()}
      onPromoteHeld={vi.fn()}
      onToggleLock={vi.fn()}
      onLockAll={vi.fn()}
      onUnlockAll={vi.fn()}
      onWithdraw={vi.fn()}
    />
  );
  return { onUndoRemove };
}

// The table's rows, top to bottom, by symbol (the removed one carries data-pending).
function rowOrder(): string[] {
  return Array.from(document.querySelectorAll(".divide-y > div")).map((el) => {
    const symbol = el.querySelector("p")?.textContent ?? "";
    return el.getAttribute("data-pending") === "removed" ? `-${symbol}` : symbol;
  });
}

describe("PortfolioTargetsTable — pending changes (021 R2)", () => {
  it("an untouched draft marks nothing", () => {
    renderDraft(COMMITTED);
    expect(screen.queryByText(t.pendingNew)).toBeNull();
    expect(screen.queryByText(t.pendingRemoving)).toBeNull();
    expect(document.querySelector("s")).toBeNull();
  });

  it("a removed token stays in its place, struck, with Undo", () => {
    const { onUndoRemove } = renderDraft([row(A, 57.14), row(C, 42.86)], { [B.id]: -1 });
    expect(rowOrder()).toEqual([A.symbol, `-${B.symbol}`, C.symbol]);
    const removed = document.querySelector('[data-pending="removed"]') as HTMLElement;
    expect(within(removed).getByText(t.pendingRemoving)).toBeTruthy();
    expect(within(removed).getByText("30.0%").tagName).toBe("S");
    // Its funds go back to the general balance with the same commit.
    expect(within(removed).getByTitle(`−${formatCrypto(1)} ${B.symbol}`)).toBeTruthy();
    fireEvent.click(within(removed).getByRole("button", { name: t.pendingUndoAria.replace("{symbol}", B.symbol) }));
    expect(onUndoRemove).toHaveBeenCalledWith(B.id);
  });

  it("a changed target or band shows the old value struck; a new token says so", () => {
    renderDraft([row(A, 50), row(B, 30, 15), row(C, 20), row(D, 0)]);
    const struck = Array.from(document.querySelectorAll("s")).map((s) => s.textContent);
    expect(struck).toEqual(["40.0%", "±10%", "30.0%"]);
    expect(screen.getAllByText(t.pendingNew)).toHaveLength(1);
  });

  it("funds moving in show as + next to the holding", () => {
    renderDraft(COMMITTED, { [A.id]: 0.5 });
    const move = screen.getByTitle(`+${formatCrypto(0.5)} ${A.symbol}`);
    // Screen readers hear which way the funds go, not just a sign.
    expect(move.textContent).toContain(t.pendingMoveIn);
  });
});

// D-451: redistributing leaves values like 54.5454…, which the narrow field cut to "54.!".
describe("PortfolioTargetsTable — a funds-only token withdrawn whole (D-536)", () => {
  it("stays on screen struck, at 0% with no tolerance, with Undo", () => {
    // D is held outside the composition and the draft moves all of it out.
    const qty = { [A.id]: 1, [B.id]: 1, [C.id]: 1 };
    const rows = computeTargets(COMMITTED, tokenRegistry, {}, qty, 300);
    const deltas = { [D.id]: -4 };
    const summary = summarizeChangeSet(buildChangeSet(COMMITTED, COMMITTED, deltas), COMMITTED, (id) =>
      tokenRegistry.find((x) => x.id === id)?.symbol ?? id
    );
    const onUndoRemove = vi.fn();
    render(
      <PortfolioTargetsTable
        t={t}
        rows={rows}
        isEditing
        allLocked={false}
        allUnlocked
        pending={buildPendingMarks(summary, COMMITTED, { [D.id]: 4 })}
        onUndoRemove={onUndoRemove}
        onUpdateTarget={vi.fn()}
        onUpdateTargetPct={vi.fn()}
        onPromoteHeld={vi.fn()}
        onToggleLock={vi.fn()}
        onLockAll={vi.fn()}
        onUnlockAll={vi.fn()}
        onWithdraw={vi.fn()}
      />
    );
    expect(rowOrder()).toEqual([A.symbol, B.symbol, C.symbol, `-${D.symbol}`]);
    const removed = document.querySelector('[data-pending="removed"]') as HTMLElement;
    expect(within(removed).getByText(t.pendingRemoving)).toBeTruthy();
    expect(within(removed).getByText("0.0%").tagName).toBe("S");
    expect(within(removed).queryByText(/±/)).toBeNull();
    fireEvent.click(within(removed).getByRole("button", { name: t.pendingUndoAria.replace("{symbol}", D.symbol) }));
    expect(onUndoRemove).toHaveBeenCalledWith(D.id);
  });
});

describe("PortfolioTargetsTable — the target % field (D-451)", () => {
  const field = (token: typeof A) =>
    screen.getByRole("spinbutton", { name: `${t.target} ${token.symbol}` }) as HTMLInputElement;

  function renderStateful(initial: TargetAllocation[], onUpdateTargetPct = vi.fn()) {
    function Harness() {
      const [targets, setTargets] = useState(initial);
      const rows = computeTargets(targets, tokenRegistry, {}, { [A.id]: 1, [B.id]: 1, [C.id]: 1 }, 300);
      return (
        <PortfolioTargetsTable
          t={t}
          rows={rows}
          isEditing
          allLocked={false}
          allUnlocked
          onUpdateTarget={vi.fn()}
          onUpdateTargetPct={(id, pct) => {
            onUpdateTargetPct(id, pct);
            setTargets((current) => distributeUnlockedTargetPct(current, id, pct).targets);
          }}
          onPromoteHeld={vi.fn()}
          onToggleLock={vi.fn()}
          onLockAll={vi.fn()}
          onUnlockAll={vi.fn()}
          onWithdraw={vi.fn()}
        />
      );
    }
    render(<Harness />);
  }

  it("shows at most two decimals and saves nothing by showing them", () => {
    const onUpdateTargetPct = vi.fn();
    renderStateful([row(A, 54.545454), row(B, 27.272727), row(C, 18.181819)], onUpdateTargetPct);
    expect([field(A).value, field(B).value, field(C).value]).toEqual(["54.55", "27.27", "18.18"]);
    fireEvent.focus(field(A));
    fireEvent.blur(field(A));
    expect(onUpdateTargetPct).not.toHaveBeenCalled();
  });

  it("typing still saves what was typed, and the others redistribute rounded", () => {
    renderStateful([row(A, 40), row(B, 30), row(C, 30)]);
    fireEvent.change(field(A), { target: { value: "45.5" } });
    expect(field(A).value).toBe("45.5");
    expect([field(B).value, field(C).value]).toEqual(["27.25", "27.25"]);
  });
});

describe("PortfolioTargetsTable — the last target (027 A-11)", () => {
  function renderRows(draft: TargetAllocation[], qty: Record<string, number>) {
    const onWithdraw = vi.fn();
    render(
      <PortfolioTargetsTable
        t={t}
        rows={computeTargets(draft, tokenRegistry, {}, qty, 100)}
        isEditing
        allLocked={false}
        allUnlocked
        onUpdateTarget={vi.fn()}
        onUpdateTargetPct={vi.fn()}
        onPromoteHeld={vi.fn()}
        onToggleLock={vi.fn()}
        onLockAll={vi.fn()}
        onUnlockAll={vi.fn()}
        onWithdraw={onWithdraw}
      />
    );
    return { onWithdraw };
  }
  const removeButton = (symbol: string) => screen.getByRole("button", { name: `${t.removeEmpty} ${symbol}` });

  it("blocks removing the only target when nothing is held, and says why on focus", () => {
    const { onWithdraw } = renderRows([row(A, 100)], {});
    const button = removeButton(A.symbol);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(button);
    expect(onWithdraw).not.toHaveBeenCalled();
    fireEvent.focus(button);
    expect(screen.getByText(t.removeLastTargetBlocked).getAttribute("role")).toBe("tooltip");
  });

  it("keeps the only target's button live when it holds funds (it moves them out)", () => {
    const { onWithdraw } = renderRows([row(A, 100)], { [A.id]: 1 });
    const button = screen.getByRole("button", { name: t.unallocateTitle.replace("{symbol}", A.symbol) });
    expect(button.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(button);
    expect(onWithdraw).toHaveBeenCalledTimes(1);
  });

  it("does not block an empty row while another target remains", () => {
    const { onWithdraw } = renderRows([row(A, 60), row(B, 40)], {});
    fireEvent.click(removeButton(A.symbol));
    expect(onWithdraw).toHaveBeenCalledTimes(1);
  });
});

describe("PortfolioTargetsTable — held tokens outside the catalog (D-477)", () => {
  const DOGE = tokenRegistry.find((x) => x.id === "nep141:doge.omft.near")!;
  const OFFERABLE = tokenRegistry.find((x) => x.id !== A.id && x.id !== B.id && isPortfolioOfferable(x.id))!;

  function renderHeld(isEditing: boolean) {
    const draft = [row(A, 50), row(B, 50)];
    const qty = { [A.id]: 1, [B.id]: 1, [DOGE.id]: 1000, [OFFERABLE.id]: 1000 };
    const computed = computeTargets(draft, tokenRegistry, {}, qty, 300);
    const onPromoteHeld = vi.fn();
    render(
      <PortfolioTargetsTable
        t={t}
        rows={[...computed, ...buildHeldNoTargetRows(computed, tokenRegistry, {}, qty, 300)]}
        isEditing={isEditing}
        allLocked={false}
        allUnlocked
        onUpdateTarget={vi.fn()}
        onUpdateTargetPct={vi.fn()}
        onPromoteHeld={onPromoteHeld}
        onToggleLock={vi.fn()}
        onLockAll={vi.fn()}
        onUnlockAll={vi.fn()}
        onWithdraw={vi.fn()}
      />
    );
    return { onPromoteHeld };
  }
  const field = (symbol: string) => screen.queryByRole("spinbutton", { name: `${t.target} ${symbol}` });

  it("offers no % field for a held token the catalog doesn't offer, and says why", () => {
    expect(isPortfolioOfferable(DOGE.id)).toBe(false);
    renderHeld(true);
    expect(field(DOGE.symbol)).toBeNull();
    expect(screen.getAllByText(t.addTokensNotAvailableYet)).toHaveLength(1);
  });

  it("still lets an offerable held token be promoted (control)", () => {
    const { onPromoteHeld } = renderHeld(true);
    const input = field(OFFERABLE.symbol) as HTMLInputElement;
    // D-513: as the user types, not on blur — the row keeps its place.
    fireEvent.change(input, { target: { value: "10" } });
    expect(onPromoteHeld).toHaveBeenCalledWith(OFFERABLE.id, "10");
  });

  it("D-513: draws the offerable held row as a 0% target: bar, mini-band, status, no tolerance, no lock", () => {
    const { onPromoteHeld } = renderHeld(true);
    const heldRow = field(OFFERABLE.symbol)!.closest(".grid") as HTMLElement;
    expect((field(OFFERABLE.symbol) as HTMLInputElement).value).toBe("0");
    expect(within(heldRow).getByLabelText(`${t.status}: ${t.zeroTargetSelling}`)).toBeTruthy();
    expect(within(heldRow).getByRole("img", { name: /^Now / })).toBeTruthy();
    expect(within(heldRow).queryByText("—")).toBeNull();
    expect(within(heldRow).queryByLabelText(`${t.band} ${OFFERABLE.symbol}`)).toBeNull();
    expect(within(heldRow).queryByRole("button", { name: `${t.unlocked} ${OFFERABLE.symbol}` })).toBeNull();
    fireEvent.change(within(heldRow).getByRole("slider", { name: `${t.slider} ${OFFERABLE.symbol}` }), { target: { value: "15" } });
    expect(onPromoteHeld).toHaveBeenCalledWith(OFFERABLE.id, 15);
  });

  it("D-513: a held token the catalog doesn't offer gets no bar either", () => {
    renderHeld(true);
    expect(screen.queryByRole("slider", { name: `${t.slider} ${DOGE.symbol}` })).toBeNull();
  });

  it("says nothing outside edit mode", () => {
    renderHeld(false);
    expect(screen.queryByText(t.addTokensNotAvailableYet)).toBeNull();
  });
});

describe("PortfolioTargetsTable — Lock all / Unlock all point the way out (027 A-1)", () => {
  function renderLocks() {
    const draft = [{ ...row(A, 40), locked: true }, row(B, 30), row(C, 30)];
    render(
      <PortfolioTargetsTable
        t={t}
        rows={computeTargets(draft, tokenRegistry, {}, { [A.id]: 1, [B.id]: 1, [C.id]: 1 }, 300)}
        isEditing
        allLocked={false}
        allUnlocked={false}
        onUpdateTarget={vi.fn()}
        onUpdateTargetPct={vi.fn()}
        onPromoteHeld={vi.fn()}
        onToggleLock={vi.fn()}
        onLockAll={vi.fn()}
        onUnlockAll={vi.fn()}
        onWithdraw={vi.fn()}
      />
    );
  }
  const headerButtons = () => [
    screen.getByRole("button", { name: t.lockAll }),
    screen.getByRole("button", { name: t.unlockAll }),
  ];

  it("both flash when a row lock says it can't be toggled, and again the next time", () => {
    renderLocks();
    expect(headerButtons().some((b) => b.classList.contains("lock-flash"))).toBe(false);
    const blocked = screen.getByRole("button", { name: `${t.unlocked} ${B.symbol}` });
    expect((blocked as HTMLButtonElement).disabled).toBe(true);
    fireEvent.focus(blocked);
    expect(screen.getByText(t.minTwoUnlocked)).toBeTruthy();
    const first = headerButtons();
    expect(first.every((b) => b.classList.contains("lock-flash"))).toBe(true);
    fireEvent.blur(blocked);
    fireEvent.focus(blocked);
    // Remounted, so the one-shot animation replays.
    expect(headerButtons()[0]).not.toBe(first[0]);
  });

  it("a lock that can be toggled flashes nothing", () => {
    renderLocks();
    fireEvent.focus(screen.getByRole("button", { name: `${t.locked} ${A.symbol}` }));
    expect(headerButtons().some((b) => b.classList.contains("lock-flash"))).toBe(false);
  });
});

describe("PortfolioTargetsTable — column rules (027 A-8)", () => {
  function renderTable(draft: TargetAllocation[]) {
    render(
      <PortfolioTargetsTable
        t={t}
        rows={computeTargets(draft, tokenRegistry, {}, { [A.id]: 1, [B.id]: 1 }, 200)}
        isEditing={false}
        allLocked={false}
        allUnlocked
        onUpdateTarget={vi.fn()}
        onUpdateTargetPct={vi.fn()}
        onPromoteHeld={vi.fn()}
        onToggleLock={vi.fn()}
        onLockAll={vi.fn()}
        onUnlockAll={vi.fn()}
        onWithdraw={vi.fn()}
      />
    );
  }

  it("rules every column but the first and the slider, which stays grouped with its %", () => {
    renderTable([row(A, 50), row(B, 50)]);
    const cells = Array.from(document.querySelectorAll('[aria-hidden="true"].grid > div'));
    expect(cells).toHaveLength(9);
    expect(cells.map((c) => c.hasAttribute("data-column-rule"))).toEqual([false, true, true, true, false, true, true, true, true]);
  });

  it("draws no rules over the empty state", () => {
    renderTable([]);
    expect(document.querySelector("[data-column-rule]")).toBeNull();
  });
});

describe("PortfolioTargetsTable — a 0% row with no balance (D-341)", () => {
  function renderZeroRow() {
    const draft = [row(A, 100), row(B, 0)];
    const qty = { [A.id]: 1 };
    const rows = computeTargets(draft, tokenRegistry, {}, qty, 100);
    render(
      <PortfolioTargetsTable
        t={t}
        rows={rows}
        isEditing
        allLocked={false}
        allUnlocked
        rowViolations={validateComposition(rows, qty).byTokenId}
        onUpdateTarget={vi.fn()}
        onUpdateTargetPct={vi.fn()}
        onPromoteHeld={vi.fn()}
        onToggleLock={vi.fn()}
        onLockAll={vi.fn()}
        onUnlockAll={vi.fn()}
        onWithdraw={vi.fn()}
      />
    );
  }

  it("keeps the status pill on one line", () => {
    renderZeroRow();
    const zeroRow = screen.getByText(t.ruleZeroTargetZeroBalance).closest(".grid") as HTMLElement;
    const pill = within(zeroRow).getByLabelText(`${t.status}: ${t.insideBand}`);
    expect(pill.className).toContain("whitespace-nowrap");
  });

  it("gives the hint the target and slider columns, not the 84 px field", () => {
    renderZeroRow();
    const hint = screen.getByText(t.ruleZeroTargetZeroBalance);
    expect(hint.className).toContain("w-[285px]");
    expect(hint.className).toContain("absolute");
  });
});

describe("PortfolioTargetsTable — a 0% target still held (D-514)", () => {
  // B is at 0% but holds a third of the portfolio; A and C share the targets.
  function renderZeroHeld(isEditing: boolean, bTolerance = 10) {
    const draft = [row(A, 50), row(B, 0, bTolerance), row(C, 50)];
    const qty = { [A.id]: 1, [B.id]: 1, [C.id]: 1 };
    const rows = computeTargets(draft, tokenRegistry, {}, qty, 300);
    render(
      <PortfolioTargetsTable
        t={t}
        rows={rows}
        isEditing={isEditing}
        allLocked={false}
        allUnlocked
        rowViolations={validateComposition(rows, qty).byTokenId}
        onUpdateTarget={vi.fn()}
        onUpdateTargetPct={vi.fn()}
        onPromoteHeld={vi.fn()}
        onToggleLock={vi.fn()}
        onLockAll={vi.fn()}
        onUnlockAll={vi.fn()}
        onWithdraw={vi.fn()}
      />
    );
  }
  const rowOf = (symbol: string) =>
    Array.from(document.querySelectorAll(".divide-y > div")).find(
      (el) => el.querySelector("p")?.textContent === symbol
    ) as HTMLElement;

  it("says, in plain text, that it is sold for the other tokens, not that it is over", () => {
    renderZeroHeld(false);
    const zero = rowOf(B.symbol);
    const status = within(zero).getByLabelText(`${t.status}: ${t.zeroTargetSelling}`);
    expect(status.textContent).toBe(t.zeroTargetSelling);
    expect(status.className).not.toContain("rounded-full");
    expect(within(zero).queryByText(t.aboveTarget)).toBeNull();
  });

  it("hides its tolerance in both modes, and only its own", () => {
    renderZeroHeld(false);
    expect(within(rowOf(B.symbol)).queryByText("±10%")).toBeNull();
    expect(within(rowOf(A.symbol)).getByText("±10%")).toBeTruthy();
    cleanup();
    renderZeroHeld(true);
    expect(screen.queryByLabelText(`${t.band} ${B.symbol}`)).toBeNull();
    expect(screen.getByLabelText(`${t.band} ${A.symbol}`)).toBeTruthy();
  });

  it("still shows the field when its tolerance would block Save", () => {
    renderZeroHeld(true, 1);
    expect(screen.getByLabelText(`${t.band} ${B.symbol}`)).toBeTruthy();
    expect(screen.getByText(t.ruleToleranceBelowMin)).toBeTruthy();
  });
});

describe("the mini band's label and key (D-505)", () => {
  function renderRead(tt: Record<string, string>, total: number) {
    const rows = computeTargets(COMMITTED, tokenRegistry, {}, total > 0 ? { [A.id]: 1 } : {}, total);
    render(
      <PortfolioTargetsTable
        t={tt}
        rows={rows}
        isEditing={false}
        allLocked={false}
        allUnlocked
        onUpdateTarget={vi.fn()}
        onUpdateTargetPct={vi.fn()}
        onPromoteHeld={vi.fn()}
        onToggleLock={vi.fn()}
        onLockAll={vi.fn()}
        onUnlockAll={vi.fn()}
        onWithdraw={vi.fn()}
      />
    );
  }

  it("reads the bar in the active language, with its numbers, and shows the key once", () => {
    const es = translations.es as Record<string, string>;
    renderRead(es, 300);
    const bars = screen.getAllByRole("img", { name: /^Ahora / });
    expect(bars).toHaveLength(3);
    expect(bars[1].getAttribute("aria-label")).toMatch(/objetivo 30\.0%, en objetivo entre 20\.0% y 40\.0%$/);
    expect(screen.getAllByText(es.bandLegendRange)).toHaveLength(1);
  });

  it("says nothing is held yet when the portfolio holds nothing", () => {
    renderRead(t, 0);
    expect(screen.getAllByRole("img", { name: /^Not held yet\. Target / })).toHaveLength(3);
  });
});
