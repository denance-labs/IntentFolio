// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { usePortfolioTargets } from "./use-portfolio-targets";
import type { TargetAllocation } from "../types";
import {
  RealChangeSetInvalidError,
  RealUnallocateTransferFailedError,
  VaultCommitRevertedError,
} from "@/features/vault/lib/vault-errors";
import { RealUnallocateUnconfirmedError } from "@/features/vault/lib/run-real-unallocate";
import { toBaseUnits } from "@/features/vault/lib/base-units";
import { unconfirmedWithdrawalUntil } from "../lib/unconfirmed-withdrawal-mark";

// Heavy provider deps are mocked: the hook reads its draft/commit surface through
// usePortfolio (5.4-A) and the available balance through useAvailableGeneralBalance.
const setDraftState = vi.fn();
const commitChangeSet = vi.fn<(...args: unknown[]) => Promise<void>>();

const COMMITTED: TargetAllocation[] = [
  { id: "row-near", tokenId: "near", targetPct: 60, tolerancePct: 10, locked: false },
  { id: "row-usdc", tokenId: "usdc", targetPct: 40, tolerancePct: 10, locked: false },
];
// Same rows with a composition change so the diff is a non-empty changeset.
const DRAFT_TARGETS: TargetAllocation[] = [
  { id: "row-near", tokenId: "near", targetPct: 70, tolerancePct: 10, locked: false },
  { id: "row-usdc", tokenId: "usdc", targetPct: 30, tolerancePct: 10, locked: false },
];

// The open draft, per test. Defaults to one with a real change so the diff is non-empty.
const draft = vi.hoisted(() => ({ state: undefined as unknown }));
// Committed portfolio balances, per test. Empty unless a test sets them.
const deposits = vi.hoisted(() => ({ value: {} as Record<string, number> }));

vi.mock("@/features/dashboard-shell/context/portfolio-context", () => ({
  usePortfolio: () => ({
    activePortfolio: { id: "p1", name: "P1", targets: COMMITTED, deposits: deposits.value, defaultTolerancePct: 10 },
    commitChangeSet,
    draftState:
      draft.state === undefined ? { id: "p1", targets: DRAFT_TARGETS, balanceDeltas: {} } : draft.state,
    setDraftState,
  }),
}));

vi.mock("@/features/dashboard-shell/hooks/use-available-general-balance", () => ({
  useAvailableGeneralBalance: () => new Map<string, number>(),
}));

function setup() {
  return renderHook(() => usePortfolioTargets({ lang: "en", setToast: vi.fn(), priceMap: {} }));
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  draft.state = undefined;
  deposits.value = {};
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("usePortfolioTargets — sign error handling (5.5)", () => {
  it("classifies a rejected signature and keeps the draft (never nulls draftState)", async () => {
    commitChangeSet.mockRejectedValueOnce(new Error("User rejected the request"));
    const { result } = setup();

    act(() => result.current.requestCommit());
    expect(result.current.preview).not.toBeNull();

    await act(async () => {
      await result.current.confirmCommit();
    });

    expect(result.current.signError).toEqual({ kind: "cancel", message: "User rejected the request" });
    // The draft is preserved: confirmCommit's catch must not clear it.
    expect(setDraftState).not.toHaveBeenCalledWith(null);
  });

  it("classifies a locked/unavailable wallet as 'unavailable'", async () => {
    commitChangeSet.mockRejectedValueOnce(new Error("Wallet not connected"));
    const { result } = setup();

    act(() => result.current.requestCommit());
    await act(async () => {
      await result.current.confirmCommit();
    });

    expect(result.current.signError?.kind).toBe("unavailable");
    expect(setDraftState).not.toHaveBeenCalledWith(null);
  });

  it("retry re-signs the same changeset without rebuilding it, then succeeds", async () => {
    commitChangeSet
      .mockRejectedValueOnce(new Error("User rejected the request"))
      .mockResolvedValueOnce(undefined);
    const { result } = setup();

    act(() => result.current.requestCommit());
    const firstChangeset = result.current.preview?.changeset;

    // First attempt: rejected.
    await act(async () => {
      await result.current.confirmCommit();
    });
    expect(result.current.signError?.kind).toBe("cancel");

    // Retry: same changeset reference, no requestCommit in between.
    await act(async () => {
      await result.current.confirmCommit();
    });

    expect(commitChangeSet).toHaveBeenCalledTimes(2);
    expect(commitChangeSet.mock.calls[0][0]).toBe(firstChangeset);
    expect(commitChangeSet.mock.calls[1][0]).toBe(firstChangeset);
    // On success the draft is cleared and the error reset.
    expect(setDraftState).toHaveBeenLastCalledWith(null);
    expect(result.current.signError).toBeNull();
    expect(result.current.preview).toBeNull();
  });

  it("survives repeated rejections with the draft intact each time", async () => {
    commitChangeSet
      .mockRejectedValueOnce(new Error("User rejected the request"))
      .mockRejectedValueOnce(new Error("Wallet not connected"))
      .mockRejectedValueOnce(new Error("RPC timeout"));
    const { result } = setup();

    act(() => result.current.requestCommit());

    for (const expected of ["cancel", "unavailable", "error"] as const) {
      await act(async () => {
        await result.current.confirmCommit();
      });
      expect(result.current.signError?.kind).toBe(expected);
    }
    expect(setDraftState).not.toHaveBeenCalledWith(null);
    expect(result.current.preview).not.toBeNull();
  });
});

// ── 017-9b: a commit the vault reverted, by code (D-302 f/j) ──────────────────
describe("usePortfolioTargets — a reverted commit, by code (017-9b)", () => {
  const revert = (code: string) =>
    new VaultCommitRevertedError(`{"ActionError":{"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: ${code}"}}}}`);

  it("E_PAUSED carries its refusal: nothing moved, and the modal says why", async () => {
    commitChangeSet.mockRejectedValueOnce(revert("E_PAUSED"));
    const { result } = setup();
    act(() => result.current.requestCommit());
    await act(async () => {
      await result.current.confirmCommit();
    });
    expect(result.current.signError).toMatchObject({ kind: "error", refusal: "paused" });
    expect(result.current.vaultNotice).toBeNull();
    expect(setDraftState).not.toHaveBeenCalledWith(null); // the draft survives for a retry
  });

  // A replay of a commit that already applied answers these: "nothing moved" would be a guess.
  it.each(["E_NONCE_CONSUMED", "E_EXPIRED_DEADLINE"])("%s is not confirmed, never a failure", async (code) => {
    commitChangeSet.mockRejectedValueOnce(revert(code));
    const { result } = setup();
    act(() => result.current.requestCommit());
    await act(async () => {
      await result.current.confirmCommit();
    });
    expect(result.current.vaultNotice).toEqual({ kind: "unconfirmed" });
    expect(result.current.signError).toBeNull();
  });

  // D-385 (a): the commit applied but its transfer failed — not a wallet error, no Retry.
  it("a withdrawal that could not be sent is a notice, not a signature error", async () => {
    commitChangeSet.mockRejectedValueOnce(new RealUnallocateTransferFailedError("mt_batch_transfer reverted"));
    const { result } = setup();
    act(() => result.current.requestCommit());
    await act(async () => {
      await result.current.confirmCommit();
    });
    expect(result.current.vaultNotice).toEqual({ kind: "transfer-failed" });
    expect(result.current.signError).toBeNull();
  });

  it("an unmapped code keeps the generic error, without a refusal", async () => {
    commitChangeSet.mockRejectedValueOnce(revert("E_INVALID_COMPOSITION"));
    const { result } = setup();
    act(() => result.current.requestCommit());
    await act(async () => {
      await result.current.confirmCommit();
    });
    expect(result.current.signError?.kind).toBe("error");
    expect(result.current.signError?.refusal).toBeUndefined();
  });
});

// ── D-174: a deposit must never rewrite a declared composition ────────────────
//
// The defect these pin: funding a token that is not yet in the composition promoted it to
// its post-deposit USD weight and rescaled everything else. On an emptied portfolio that
// weight is 100% by construction, so the five declared targets collapsed to 0.0% — while
// `get_portfolio` still returned 3000/2500/1500/2000/1000. The UI contradicted the chain
// about the user's own stated intent (008.plan Phase 1).

/** Runs the updater `allocateToPortfolio` handed to setDraftState against a given draft. */
function applyAllocate(
  result: { current: { allocateToPortfolio: (id: string, qty: number) => void } },
  draft: { id: string; targets: TargetAllocation[]; balanceDeltas: Record<string, number> },
  tokenId: string,
  qty: number
) {
  act(() => result.current.allocateToPortfolio(tokenId, qty));
  const updater = setDraftState.mock.lastCall?.[0] as (c: typeof draft) => typeof draft;
  return updater(draft);
}

const DECLARED: TargetAllocation[] = [
  { id: "t-a", tokenId: "nep141:usdt.tether-token.near", targetPct: 30, tolerancePct: 5, locked: false },
  { id: "t-b", tokenId: "nep141:btc.omft.near", targetPct: 25, tolerancePct: 5, locked: false },
  { id: "t-c", tokenId: "nep141:eth.omft.near", targetPct: 15, tolerancePct: 5, locked: false },
  { id: "t-d", tokenId: "nep141:usdc.near", targetPct: 20, tolerancePct: 5, locked: false },
  { id: "t-e", tokenId: "nep141:wrap.near", targetPct: 10, tolerancePct: 5, locked: false },
];

describe("allocateToPortfolio — D-174", () => {
  it("leaves a declared composition untouched when the portfolio is EMPTY", () => {
    const { result } = setup();
    const next = applyAllocate(
      result,
      { id: "p1", targets: DECLARED, balanceDeltas: {} },
      "near",
      5
    );

    // Before the fix these five were 0/0/0/0/0 and `near` was 100.
    expect(next.targets.slice(0, 5).map((t) => t.targetPct)).toEqual([30, 25, 15, 20, 10]);
    const added = next.targets.find((t) => t.tokenId === "near");
    expect(added?.targetPct).toBe(0);
    expect(next.balanceDeltas.near).toBe(5);
  });

  it("leaves it untouched on a FUNDED portfolio too — the rule is about intent, not balance", () => {
    const { result } = setup();
    const next = applyAllocate(
      result,
      { id: "p1", targets: DECLARED, balanceDeltas: { "nep141:usdc.near": 900 } },
      "near",
      100
    );
    expect(next.targets.slice(0, 5).map((t) => t.targetPct)).toEqual([30, 25, 15, 20, 10]);
    expect(next.targets.find((t) => t.tokenId === "near")?.targetPct).toBe(0);
  });

  it("still seeds target = weight on a BLANK composition (D-143(3) is preserved)", () => {
    const { result } = setup();
    const next = applyAllocate(result, { id: "p1", targets: [], balanceDeltas: {} }, "near", 5);
    expect(next.targets).toHaveLength(1);
    expect(Number(next.targets[0].targetPct)).toBeCloseTo(100, 1);
  });

  it("only moves funds when the token already has a target", () => {
    const { result } = setup();
    const next = applyAllocate(
      result,
      { id: "p1", targets: DECLARED, balanceDeltas: {} },
      "nep141:btc.omft.near",
      2
    );
    expect(next.targets).toHaveLength(5);
    expect(next.targets.map((t) => t.targetPct)).toEqual([30, 25, 15, 20, 10]);
    expect(next.balanceDeltas["nep141:btc.omft.near"]).toBe(2);
  });

  it("keeps the declared sum at 100 so the commit gate is unaffected", () => {
    const { result } = setup();
    const next = applyAllocate(
      result,
      { id: "p1", targets: DECLARED, balanceDeltas: {} },
      "near",
      5
    );
    const sum = next.targets.reduce((s, t) => s + (Number(t.targetPct) || 0), 0);
    expect(sum).toBe(100);
  });
});

// ── Live-vault notices (008.plan Phase 2) ────────────────────────────────────
// These are NOT sign errors: nothing was rejected, locked or broken. The modal shows them
// with its own copy and never runs them through normalizeWalletError, whose "cancelled" /
// "unavailable" wording would misdescribe what happened.
describe("usePortfolioTargets — live-vault notices", () => {
  // D-321 backstop: funds in a real draft (e.g. restored from storage) are refused before
  // signing — adding funds is its own signed step now — and the draft survives.
  it("classifies funds left in a real draft as a notice, not a wallet failure", async () => {
    commitChangeSet.mockRejectedValueOnce(
      new RealChangeSetInvalidError("allocation-in-draft", "near")
    );
    const { result } = setup();

    act(() => result.current.requestCommit());
    await act(async () => {
      await result.current.confirmCommit();
    });

    expect(result.current.vaultNotice).toEqual({
      kind: "change-set-invalid",
      reason: "allocation-in-draft",
    });
    expect(result.current.signError).toBeNull();
    expect(setDraftState).not.toHaveBeenCalledWith(null);
  });

  it("carries the pre-flight reason through so the modal can say WHY", async () => {
    commitChangeSet.mockRejectedValueOnce(
      new RealChangeSetInvalidError("targets-not-100", "Σ=9999bps, need 10000")
    );
    const { result } = setup();

    act(() => result.current.requestCommit());
    await act(async () => {
      await result.current.confirmCommit();
    });

    expect(result.current.vaultNotice).toEqual({
      kind: "change-set-invalid",
      reason: "targets-not-100",
    });
    expect(result.current.signError).toBeNull();
  });
});

// 017-1 (D-329): sent, not seen applied. A notice, not an error — and closing it drops the
// draft, which may already be on-chain: re-editing it would invite signing it twice.
describe("usePortfolioTargets — unconfirmed commit", () => {
  it("classifies it as a notice and drops the draft only when the modal is closed", async () => {
    commitChangeSet.mockRejectedValueOnce(new RealUnallocateUnconfirmedError("timed out", "SentTx"));
    const { result } = setup();

    act(() => result.current.requestCommit());
    await act(async () => {
      await result.current.confirmCommit();
    });

    expect(result.current.vaultNotice).toEqual({ kind: "unconfirmed" });
    expect(result.current.signError).toBeNull();
    expect(setDraftState).not.toHaveBeenCalledWith(null);

    act(() => result.current.cancelPreview());
    expect(setDraftState).toHaveBeenCalledWith(null);
    expect(result.current.preview).toBeNull();
    expect(result.current.vaultNotice).toBeNull();
  });

  // D-369: the warning outlives the modal, for a withdrawal only.
  it("marks the portfolio when the unconfirmed commit withdraws funds", async () => {
    window.localStorage.clear();
    draft.state = { id: "p1", targets: COMMITTED, balanceDeltas: { usdc: -50 } };
    commitChangeSet.mockRejectedValueOnce(new RealUnallocateUnconfirmedError("timed out", "SentTx"));
    const { result } = setup();

    act(() => result.current.requestCommit());
    await act(async () => {
      await result.current.confirmCommit();
    });

    expect(unconfirmedWithdrawalUntil("p1")).not.toBeNull();
  });

  it("leaves no mark for an unconfirmed composition-only commit", async () => {
    window.localStorage.clear();
    commitChangeSet.mockRejectedValueOnce(new RealUnallocateUnconfirmedError("timed out", "SentTx"));
    const { result } = setup();

    act(() => result.current.requestCommit());
    await act(async () => {
      await result.current.confirmCommit();
    });

    expect(result.current.vaultNotice).toEqual({ kind: "unconfirmed" });
    expect(unconfirmedWithdrawalUntil("p1")).toBeNull();
  });

  it("a plain cancel still keeps the draft (D-094)", () => {
    const { result } = setup();
    act(() => result.current.requestCommit());
    act(() => result.current.cancelPreview());
    expect(setDraftState).not.toHaveBeenCalledWith(null);
  });
});

// D-321 P6: `hasDraftChanges` is what blocks signing a top-up under an unsaved draft.
describe("usePortfolioTargets — hasDraftChanges (013.plan P6)", () => {
  function hasDraftChanges(state: unknown): boolean {
    draft.state = state;
    return setup().result.current.hasDraftChanges;
  }

  it("no draft: nothing to block", () => {
    expect(hasDraftChanges(null)).toBe(false);
  });
  it("an open draft identical to the portfolio does not block funding", () => {
    expect(hasDraftChanges({ id: "p1", targets: COMMITTED, balanceDeltas: {} })).toBe(false);
  });
  it("a draft with a real change does", () => {
    expect(hasDraftChanges({ id: "p1", targets: DRAFT_TARGETS, balanceDeltas: {} })).toBe(true);
  });
});

// D-343: a withdrawal that empties the position must sign exactly what the portfolio holds.
describe("unallocate — emptying the position signs the exact balance (D-343)", () => {
  // Runs the updater `unallocate` handed to `setDraftState` against `state`, as React would.
  function applyUnallocate(state: unknown, tokenId: string, qty: number) {
    draft.state = state;
    const { result } = setup();
    setDraftState.mockClear();
    act(() => result.current.unallocate(tokenId, qty));
    const updater = setDraftState.mock.calls[0][0] as (s: unknown) => {
      balanceDeltas: Record<string, number>;
    };
    return updater(state).balanceDeltas[tokenId];
  }

  it("partial then Max: the float ulp below the balance snaps to the committed figure", () => {
    // Measured case: 869.871164 − 135.450398 added back gives 869.8711639999999, which
    // truncates to 869871163 base units against 869871164 held.
    deposits.value = { usdc: 869.871164 };
    const afterPartial = { id: "p1", targets: COMMITTED, balanceDeltas: { usdc: -135.450398 } };
    const delta = applyUnallocate(afterPartial, "usdc", 869.871164 - 135.450398);
    expect(-135.450398 - (869.871164 - 135.450398)).toBe(-869.8711639999999); // the bug's premise
    expect(delta).toBe(-869.871164);
    expect(toBaseUnits(-delta, 6)).toBe("869871164");
  });

  it("a genuinely partial withdrawal is left as typed", () => {
    deposits.value = { usdc: 100 };
    const delta = applyUnallocate({ id: "p1", targets: COMMITTED, balanceDeltas: {} }, "usdc", 99.999);
    expect(delta).toBe(-99.999);
  });

  it("with no committed balance there is nothing to snap to", () => {
    const delta = applyUnallocate({ id: "p1", targets: COMMITTED, balanceDeltas: { usdc: 5 } }, "usdc", 5);
    expect(delta).toBe(0);
  });
});

// 021 R2: a removed row stays on screen with "Undo"; undoing must leave nothing to sign.
describe("removeTarget → undoRemoveTarget (021 R2)", () => {
  type Draft = {
    id: string;
    targets: TargetAllocation[];
    balanceDeltas: Record<string, number>;
    undoRemoval?: Record<string, TargetAllocation[]>;
  };
  // Runs the updater the last call handed to setDraftState against `state`, as React would.
  function apply(state: Draft, act_: (r: ReturnType<typeof setup>["result"]) => void): Draft {
    draft.state = state;
    const { result } = setup();
    setDraftState.mockClear();
    act(() => act_(result));
    return (setDraftState.mock.lastCall?.[0] as (s: Draft) => Draft)(state);
  }

  it("removing a committed token keeps a snapshot; undo restores it and drops its fund move", () => {
    deposits.value = { usdc: 50 };
    const start: Draft = { id: "p1", targets: COMMITTED.map((t) => ({ ...t })), balanceDeltas: { usdc: -50 } };
    const removed = apply(start, (r) => r.current.removeTarget("row-usdc"));
    expect(removed.targets.map((t) => [t.tokenId, t.targetPct])).toEqual([["near", 100]]);
    expect(removed.undoRemoval?.usdc).toBe(start.targets);

    const undone = apply(removed, (r) => r.current.undoRemoveTarget("usdc"));
    expect(undone.targets).toEqual(COMMITTED);
    expect(undone.balanceDeltas).toEqual({});
    expect(undone.undoRemoval).toEqual({});

    draft.state = undone;
    const { result } = setup();
    expect(result.current.hasDraftChanges).toBe(false);
    expect(result.current.pendingMarks?.removed).toEqual([]);
  });

  it("a token added in this same draft is not undoable: it simply goes", () => {
    const start: Draft = {
      id: "p1",
      targets: [...COMMITTED, { id: "row-new", tokenId: "eth", targetPct: 0, tolerancePct: 10, locked: false }],
      balanceDeltas: {},
    };
    const removed = apply(start, (r) => r.current.removeTarget("row-new"));
    expect(removed.targets).toHaveLength(2);
    expect(removed.undoRemoval).toBeUndefined();
  });

  it("pendingMarks reads the same diff the signature carries", () => {
    draft.state = { id: "p1", targets: [COMMITTED[0]], balanceDeltas: { usdc: -3 } };
    const { result } = setup();
    expect(result.current.pendingMarks?.removed.map((r) => r.tokenId)).toEqual(["usdc"]);
    expect(result.current.pendingMarks?.balanceMoves).toEqual({ usdc: -3 });
    draft.state = null;
    expect(setup().result.current.pendingMarks).toBeNull();
  });
});
