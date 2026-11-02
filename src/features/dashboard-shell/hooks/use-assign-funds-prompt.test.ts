// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { ACCOUNT_DEPOSIT_EVENT, type ChainHistoryEvent } from "@/features/vault/lib/vault-history";
import { DRAFT_SUBJECT, getAssignFundsPromptSeenAt, markAssignFundsPromptSeen } from "../lib/assign-funds-prompt";

type History = {
  data?: { events: ChainHistoryEvent[]; upToDate: boolean; loading: boolean };
  isLoading: boolean;
  outOfDate: boolean;
};

const state = vi.hoisted(() => ({
  history: { isLoading: false, outOfDate: false } as History,
  enabled: [] as boolean[],
}));

vi.mock("@/features/vault/hooks/use-real-portfolio-history", () => ({
  useAccountHistory: (_account: string | null, enabled: boolean) => {
    state.enabled.push(enabled);
    return state.history;
  },
}));

import { useAssignFundsPrompt } from "./use-assign-funds-prompt";

const deposit = (ts: number): ChainHistoryEvent => ({ txHash: `d${ts}`, index: 0, ts, event: ACCOUNT_DEPOSIT_EVENT, data: {} });
const settled = (events: ChainHistoryEvent[]): History => ({ data: { events, upToDate: true, loading: false }, isLoading: false, outOfDate: false });

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.body.innerHTML = "";
  state.history = { isLoading: false, outOfDate: false };
  state.enabled = [];
});

describe("useAssignFundsPrompt", () => {
  it("opens once eligible, without reading the history, and an answer closes it for good", () => {
    const { result, rerender } = renderHook(({ eligible }) => useAssignFundsPrompt("alice.near", DRAFT_SUBJECT, eligible), {
      initialProps: { eligible: false },
    });
    expect(result.current.open).toBe(false);
    rerender({ eligible: true });
    expect(result.current.open).toBe(true);
    expect(state.enabled.every((e) => !e)).toBe(true);

    act(() => result.current.markSeen());
    expect(result.current.open).toBe(false);
    expect(getAssignFundsPromptSeenAt("alice.near", DRAFT_SUBJECT)).not.toBeNull();
    rerender({ eligible: true });
    expect(result.current.open).toBe(false);
  });

  it("stays shut when another window is open at that instant, and does not pop up after it closes", () => {
    const other = document.createElement("div");
    other.setAttribute("role", "dialog");
    document.body.appendChild(other);
    const { result, rerender } = renderHook(() => useAssignFundsPrompt("alice.near", DRAFT_SUBJECT, true));
    expect(result.current.open).toBe(false);
    other.remove();
    rerender();
    expect(result.current.open).toBe(false);
  });

  // The operator's journey (s8): a draft with $5, "Not now", then a deposit from the phone.
  it("comes back when a deposit newer than the answer reaches the history, without a reload", () => {
    markAssignFundsPromptSeen("alice.near", DRAFT_SUBJECT, 1_000);
    state.history = settled([deposit(500)]);
    const { result, rerender } = renderHook(() => useAssignFundsPrompt("alice.near", DRAFT_SUBJECT, true));
    expect(result.current.open).toBe(false);
    expect(state.enabled.at(-1)).toBe(true);

    // The history is behind at first (the deposit was made outside this browser)…
    state.history = { data: { events: [deposit(500)], upToDate: false, loading: false }, isLoading: false, outOfDate: false };
    rerender();
    expect(result.current.open).toBe(false);
    // …and a re-read brings it.
    state.history = settled([deposit(500), deposit(2_000)]);
    rerender();
    expect(result.current.open).toBe(true);

    // Answered again: the same deposit no longer counts.
    act(() => result.current.markSeen());
    rerender();
    expect(result.current.open).toBe(false);
  });

  it("an answer is never older than a deposit already known (a browser clock behind the chain's)", () => {
    state.history = settled([deposit(Date.now() + 60_000)]);
    const { result, rerender } = renderHook(() => useAssignFundsPrompt("alice.near", DRAFT_SUBJECT, true));
    expect(result.current.open).toBe(true);
    act(() => result.current.markSeen());
    rerender();
    expect(result.current.open).toBe(false);
  });

  it("a history that failed, or is off, counts as no new deposit", () => {
    markAssignFundsPromptSeen("alice.near", "p_1", 1_000);
    state.history = { isLoading: false, outOfDate: false };
    const { result } = renderHook(() => useAssignFundsPrompt("alice.near", "p_1", true));
    expect(result.current.open).toBe(false);
  });

  it("each subject is asked on its own", () => {
    markAssignFundsPromptSeen("alice.near", "p_1", 1_000);
    const { result, rerender } = renderHook(({ subject }) => useAssignFundsPrompt("alice.near", subject, true), {
      initialProps: { subject: "p_1" },
    });
    expect(result.current.open).toBe(false);
    rerender({ subject: "p_2" });
    expect(result.current.open).toBe(true);
  });
});
