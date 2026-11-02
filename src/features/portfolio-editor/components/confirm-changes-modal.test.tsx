// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConfirmChangesModal } from "./confirm-changes-modal";
import { translations } from "../lib/translations";
import type { ChangeSummary } from "../lib/changeset";
import { VaultCommitRevertedError } from "@/features/vault/lib/vault-errors";
import { normalizeWalletError } from "@/features/wallet/adapter/normalize-error";
import type { PrecheckBlock } from "@/features/vault/lib/vault-precheck";

// The vault's pre-check (017-9b) is pinned per test; its reads are covered in vault-precheck.test.ts.
const precheck = vi.hoisted(() => ({ block: null as PrecheckBlock | null, ops: [] as unknown[] }));
vi.mock("@/features/vault/hooks/use-vault-precheck", () => ({
  useVaultPrecheck: (op: unknown) => {
    precheck.ops.push(op);
    return op ? precheck.block : null;
  },
}));

// The in-flight trade wait (D-471) is pinned per test; its polling is covered in use-trade-in-flight.test.tsx.
const trade = vi.hoisted(() => ({ secs: null as number | null, asked: [] as Array<string | null> }));
vi.mock("@/features/vault/hooks/use-trade-in-flight", () => ({
  useTradeInFlight: (portfolioId: string | null) => {
    trade.asked.push(portfolioId);
    return portfolioId ? trade.secs : null;
  },
}));

const t = translations.en;

// A minimal non-empty summary so the modal renders its body; the error/retry behavior
// under test is independent of which sections are present.
const summary: ChangeSummary = {
  removals: [],
  additions: [],
  targetChanges: [{ tokenId: "near", symbol: "NEAR", fromPct: 60, toPct: 70, fromBand: 10, toBand: 10 }],
  allocations: [],
  unallocations: [],
};

function renderModal(props: Partial<React.ComponentProps<typeof ConfirmChangesModal>> = {}) {
  return render(
    <ConfirmChangesModal
      summary={summary}
      portfolioName="My Portfolio"
      t={t}
      isSigning={false}
      error={null}
      onCancel={vi.fn()}
      onConfirm={vi.fn()}
      {...props}
    />,
  );
}

describe("ConfirmChangesModal — signing states", () => {
  afterEach(cleanup);

  it("shows the sign label and no alert when there is no error", () => {
    renderModal();
    expect(screen.getByRole("button", { name: t.confirmSign })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the waiting label while signing", () => {
    renderModal({ isSigning: true });
    expect(screen.getByRole("button", { name: t.inFlightAwaitingSignature })).toBeTruthy();
  });

  // D-308: past the wallet, the button follows the chain's turn instead of "waiting for signature".
  it("says it is processing once the signature is in", () => {
    renderModal({ isSigning: true, isLiveRoute: true, realStage: "awaiting-settlement" });
    expect(screen.getByRole("button", { name: t.inFlightProcessing })).toBeTruthy();
  });

  // D-314: the outcome is not shown as still in progress.
  it("shows the settled stage without a spinner", () => {
    renderModal({
      isSigning: true,
      isLiveRoute: true,
      realStage: "settled",
      summary: { ...summary, unallocations: [{ tokenId: "near", symbol: "NEAR", qty: 1 }] },
    });
    const status = screen.getByText(t.realUnallocateSettled).closest("[role=status]") as HTMLElement;
    expect(status.querySelector(".animate-spin")).toBeNull();
  });

  it("a rejection shows the cancelled copy + Retry, and hides the raw message", () => {
    renderModal({ error: { kind: "cancel", message: "User rejected the request" } });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(t.confirmErrorCancelled);
    expect(alert.textContent).not.toContain("User rejected the request");
    expect(screen.getByRole("button", { name: t.confirmRetry })).toBeTruthy();
  });

  it("an unavailable wallet shows the unlock copy + Retry, and hides the raw message", () => {
    renderModal({ error: { kind: "unavailable", message: "Wallet not connected" } });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(t.confirmErrorWalletUnavailable);
    expect(alert.textContent).not.toContain("Wallet not connected");
    expect(screen.getByRole("button", { name: t.confirmRetry })).toBeTruthy();
  });

  it("an unexpected error shows the generic copy + the raw technical detail", () => {
    renderModal({ error: { kind: "error", message: "RPC timeout" } });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(t.confirmError);
    expect(alert.textContent).toContain("RPC timeout");
  });

  // D-301, end to end through the real pieces: the error the commit path throws when the
  // chain reverts, classified the way the editor classifies it, rendered in both languages.
  // It used to land on the "you cancelled" copy, because its message said "rejected".
  it.each(["en", "es"] as const)(
    "a commit the chain reverted is not a cancel (%s)",
    (lang) => {
      const lt = translations[lang];
      // "rejected" on purpose: only the class, not the text, can keep this off the cancel copy.
      const reverted = new VaultCommitRevertedError("Smart contract panicked: rejected, E_PAUSED");
      renderModal({ t: lt, error: normalizeWalletError(reverted) });
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain(lt.confirmError);
      expect(alert.textContent).not.toContain(lt.confirmErrorCancelled);
      expect(alert.textContent).toContain("E_PAUSED");
    }
  );

  it("Retry stays disabled while a re-sign is in flight", () => {
    renderModal({ error: { kind: "cancel", message: "rejected" }, isSigning: true });
    const button = screen.getByRole("button", { name: t.inFlightAwaitingSignature }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});

// Both kinds of commit ride the same `commit_portfolio_changes` and the same stage machine,
// but only one moves money. Composition-only used to announce "Your funds are back in your
// balance" over a commit where nothing moved — reported from a mainnet session (008.plan
// Phase 2). The split is on `summary.unallocations`, the modal's own record of what moves.
describe("ConfirmChangesModal — stage copy follows whether funds actually move", () => {
  afterEach(cleanup);

  const withLegs: ChangeSummary = {
    ...summary,
    unallocations: [{ tokenId: "near", symbol: "NEAR", qty: 5 }],
  };

  function stageText(): string {
    return screen.getAllByRole("status").map((n) => n.textContent ?? "").join(" ");
  }

  it("a composition-only commit never claims funds came back", () => {
    renderModal({ realStage: "settled" });
    expect(stageText()).toContain(t.realCommitSettled);
    expect(stageText()).not.toContain(t.realUnallocateSettled);
  });

  it("a composition-only commit says it is saving, not returning", () => {
    renderModal({ realStage: "awaiting-settlement" });
    expect(stageText()).toContain(t.realCommitAwaiting);
    expect(stageText()).not.toContain(t.realUnallocateAwaiting);
  });

  it("a commit that DOES withdraw keeps the funds wording", () => {
    renderModal({ summary: withLegs, realStage: "settled" });
    expect(stageText()).toContain(t.realUnallocateSettled);
  });

  it("an unconfirmed composition-only commit does not talk about funds in the portfolio", () => {
    renderModal({ realStage: "pending-unconfirmed" });
    expect(stageText()).toContain(t.realCommitPending);
    expect(stageText()).not.toContain(t.realUnallocatePending);
  });

  it("stages that describe the transaction read the same either way", () => {
    renderModal({ realStage: "signing" });
    const readMode = stageText();
    cleanup();
    renderModal({ summary: withLegs, realStage: "signing" });
    expect(stageText()).toBe(readMode);
  });
});

// 017-1: a commit that was sent but not seen applied (D-329). It may have landed, so the modal
// must not invite a second signature: the notice replaces the error, and only "Close" remains.
describe("ConfirmChangesModal — unconfirmed commit", () => {
  afterEach(cleanup);

  const withLegs: ChangeSummary = {
    ...summary,
    unallocations: [{ tokenId: "near", symbol: "NEAR", qty: 5 }],
  };

  it("shows the withdrawal's pending copy, no Retry, and Close instead of Cancel", () => {
    renderModal({ summary: withLegs, vaultNotice: { kind: "unconfirmed" } });
    expect(screen.getByRole("status").textContent).toContain(t.realUnallocatePending);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: t.confirmRetry })).toBeNull();
    expect(screen.queryByRole("button", { name: t.confirmSign })).toBeNull();
    expect(screen.getByRole("button", { name: t.confirmClose })).toBeTruthy();
  });

  it("a composition-only commit gets the composition copy", () => {
    renderModal({ vaultNotice: { kind: "unconfirmed" } });
    expect(screen.getByRole("status").textContent).toContain(t.realCommitPending);
    expect(screen.getByRole("status").textContent).not.toContain(t.realUnallocatePending);
  });

  it("a withdrawal that could not be sent says the funds stayed, with Close only (D-385 a)", () => {
    renderModal({ summary: withLegs, vaultNotice: { kind: "transfer-failed" } });
    expect(screen.getByRole("status").textContent).toContain(t.realUnallocateTransferFailed);
    expect(screen.queryByRole("button", { name: t.confirmRetry })).toBeNull();
    expect(screen.getByRole("button", { name: t.confirmClose })).toBeTruthy();
  });

  it("Close calls onCancel", () => {
    const onCancel = vi.fn();
    renderModal({ vaultNotice: { kind: "unconfirmed" }, onCancel });
    fireEvent.click(screen.getByRole("button", { name: t.confirmClose }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("ConfirmChangesModal — the relayer (017-2, D-365)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("a paused relay on a live commit: the notice, and Confirm disabled", async () => {
    const fetchMock = vi.fn(async () => Response.json({ paused: true }));
    vi.stubGlobal("fetch", fetchMock);
    renderModal({ isLiveRoute: true, sendsThroughRelay: true });

    expect(await screen.findByText(t.relayPausedTitle)).toBeTruthy();
    expect((screen.getByRole("button", { name: t.confirmSign }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("asks nothing for a mock portfolio or a self-submitting login", async () => {
    const fetchMock = vi.fn(async () => Response.json({ paused: true }));
    vi.stubGlobal("fetch", fetchMock);
    renderModal({ isLiveRoute: false, sendsThroughRelay: true });
    cleanup();
    renderModal({ isLiveRoute: true, sendsThroughRelay: false });

    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["paused", t.confirmErrorRelayPaused, true],
    ["rate-limited", t.confirmErrorRelayBusy, false],
    ["check-failed", t.confirmErrorRelayCheckFailed, false],
    ["would-fail", t.confirmErrorRelayWouldFail, false],
  ] as const)("a %s refusal from the relayer reads as its own copy, never its raw text", async (code, copy, retryBlocked) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { RelayError } = await import("@/features/vault/lib/relay-client");
    renderModal({ error: normalizeWalletError(new RelayError("E_NOT_OWNER on intents.near", code, 422)) });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(copy);
    expect(alert.textContent).not.toContain("E_NOT_OWNER");
    expect((screen.getByRole("button", { name: t.confirmRetry }) as HTMLButtonElement).disabled).toBe(retryBlocked);
  });

  it("the unconfirmed notice wins over a pause: no paused notice, only Close", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ paused: true })));
    renderModal({ isLiveRoute: true, sendsThroughRelay: true, vaultNotice: { kind: "unconfirmed" } as never });
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.queryByText(t.relayPausedTitle)).toBeNull();
    expect(screen.getByRole("button", { name: t.confirmClose })).toBeTruthy();
    expect(screen.queryByRole("button", { name: t.confirmSign })).toBeNull();
  });
});

describe("ConfirmChangesModal — the Modal pass (017-5)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  // D-325: the same guard `add-funds-modal` and `preset-review-modal` have.
  it("Escape and the backdrop do nothing while signing, and close it otherwise", () => {
    const onCancel = vi.fn();
    const { container, rerender } = renderModal({ isSigning: true, onCancel });
    const backdrop = container.firstElementChild as HTMLElement;
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.mouseDown(backdrop);
    expect(onCancel).not.toHaveBeenCalled();

    rerender(
      <ConfirmChangesModal summary={summary} portfolioName="My Portfolio" t={t} isSigning={false} error={null} onCancel={onCancel} onConfirm={vi.fn()} />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  // D-309: the attempt disabled the focused button; the answer brings the focus back.
  it("after a failed signature the focus lands on Retry", () => {
    const props = { summary, portfolioName: "My Portfolio", t, onCancel: vi.fn(), onConfirm: vi.fn() };
    const { rerender } = render(<ConfirmChangesModal {...props} isSigning error={null} />);
    (document.activeElement as HTMLElement | null)?.blur();

    rerender(<ConfirmChangesModal {...props} isSigning={false} error={{ kind: "cancel", message: "rejected" }} />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: t.confirmRetry }));
  });

  it("with no retry to press, the focus lands on the way out", () => {
    const props = { summary, portfolioName: "My Portfolio", t, onCancel: vi.fn(), onConfirm: vi.fn() };
    const { rerender } = render(<ConfirmChangesModal {...props} isSigning error={null} />);
    (document.activeElement as HTMLElement | null)?.blur();

    rerender(<ConfirmChangesModal {...props} isSigning={false} error={{ kind: "relay-paused", message: "paused" }} />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: t.cancel }));
  });

  // D-373: paused, there is no signature to promise.
  it("a paused relay drops the signature from the intro", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ paused: true })));
    renderModal({ isLiveRoute: true, sendsThroughRelay: true });
    expect(await screen.findByText(t.confirmIntroPaused)).toBeTruthy();
    expect(screen.queryByText(t.confirmIntro)).toBeNull();
  });

  it("a pause the click ran into drops it too", () => {
    renderModal({ error: { kind: "relay-paused", message: "paused" } });
    expect(screen.getByText(t.confirmIntroPaused)).toBeTruthy();
  });

  it("not paused, the intro still says one signature", () => {
    renderModal();
    expect(screen.getByText(t.confirmIntro)).toBeTruthy();
  });
});

describe("ConfirmChangesModal — the vault's answers (017-9b)", () => {
  afterEach(() => {
    cleanup();
    precheck.block = null;
    precheck.ops = [];
  });

  it.each([
    ["paused", "confirmRefusalPaused"],
    ["token-frozen", "confirmRefusalFrozen"],
    ["insufficient-balance", "confirmRefusalBalance"],
    ["portfolio-not-found", "confirmRefusalNotFound"],
  ] as const)("a %s revert reads as its own copy, without the raw panic", (refusal, key) => {
    for (const lang of ["en", "es"] as const) {
      const lt = translations[lang];
      renderModal({ t: lt, error: { kind: "error", message: "Smart contract panicked: E_X", refusal } });
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain(lt[key]);
      expect(alert.textContent).not.toContain("E_X");
      cleanup();
    }
  });

  it("a refusal blocks the retry: the same signature would meet the same answer", () => {
    renderModal({ error: { kind: "error", message: "x", refusal: "paused" } });
    expect((screen.getByRole("button", { name: t.confirmRetry }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    renderModal({ error: { kind: "error", message: "boom" } });
    expect((screen.getByRole("button", { name: t.confirmRetry }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("asks the vault about the withdrawn tokens only on a live commit", () => {
    const withLegs = { ...summary, unallocations: [{ tokenId: "usdc", symbol: "USDC", qty: 1 }] };
    renderModal({ summary: withLegs, isLiveRoute: false });
    expect(precheck.ops.at(-1)).toBeNull();
    renderModal({ summary: withLegs, isLiveRoute: true });
    expect(precheck.ops.at(-1)).toEqual({ kind: "commit", legTokenIds: ["usdc"] });
  });

  it("a vault that would refuse: the notice, and Confirm disabled and pointing at it", () => {
    precheck.block = { reason: "unavailable" };
    renderModal({ isLiveRoute: true });
    expect(screen.getByText(t.precheckUnavailableTitle)).toBeTruthy();
    const confirm = screen.getByRole("button", { name: t.confirmSign }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(document.getElementById(confirm.getAttribute("aria-describedby") ?? "")?.textContent).toContain(
      t.precheckUnavailableTitle
    );
  });

  it("a frozen token is named", () => {
    precheck.block = { reason: "token-frozen", tokenId: "near" };
    renderModal({ isLiveRoute: true });
    expect(screen.getByText(t.precheckFrozenTitle.replace("{token}", "NEAR"))).toBeTruthy();
  });
});

describe("ConfirmChangesModal — a trade settling in the portfolio (D-471)", () => {
  afterEach(() => {
    cleanup();
    trade.secs = null;
    trade.asked.length = 0;
  });

  it("holds Confirm with a countdown while a trade settles, and says why", () => {
    trade.secs = 27;
    renderModal({ isLiveRoute: true, portfolioId: "p_00000000000a" });
    expect(screen.getByText(t.tradeInFlightTitle)).toBeTruthy();
    expect(screen.getByText("(27 s)")).toBeTruthy();
    const confirm = screen.getByRole("button", { name: t.confirmSign });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    expect(confirm.getAttribute("aria-describedby")).toBe("confirm-changes-relay-paused");
  });

  it("nothing settling: Confirm works as before", () => {
    renderModal({ isLiveRoute: true, portfolioId: "p_00000000000a" });
    expect(screen.queryByText(t.tradeInFlightTitle)).toBeNull();
    expect((screen.getByRole("button", { name: t.confirmSign }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("asks only for a live commit, and never while signing", () => {
    trade.secs = 27;
    renderModal({ isLiveRoute: false, portfolioId: "p_00000000000a" });
    cleanup();
    renderModal({ isLiveRoute: true, portfolioId: "p_00000000000a", isSigning: true });
    expect(trade.asked.every((id) => id === null)).toBe(true);
    expect(screen.queryByText(t.tradeInFlightTitle)).toBeNull();
  });

  it("a vault refusal speaks first: one notice at a time", () => {
    trade.secs = 27;
    precheck.block = { reason: "unavailable" } as PrecheckBlock;
    renderModal({ isLiveRoute: true, portfolioId: "p_00000000000a" });
    expect(screen.getByText(t.precheckUnavailableTitle)).toBeTruthy();
    expect(screen.queryByText(t.tradeInFlightTitle)).toBeNull();
    precheck.block = null;
  });
});

describe("ConfirmChangesModal — a 0% target shows no tolerance (D-514)", () => {
  it("drops the tolerance of a token going to 0% or added at 0%, keeps the others'", () => {
    renderModal({
      summary: {
        removals: [],
        additions: [{ tokenId: "usdc", symbol: "USDC", toPct: 0, toBand: 10 }],
        targetChanges: [
          { tokenId: "near", symbol: "NEAR", fromPct: 40, toPct: 0, fromBand: 10, toBand: 10 },
          { tokenId: "eth", symbol: "ETH", fromPct: 60, toPct: 100, fromBand: 10, toBand: 10 },
        ],
        allocations: [],
        unallocations: [],
      },
    });
    expect(screen.getAllByText(new RegExp(`${t.confirmBand} 10%`))).toHaveLength(1);
  });
});
