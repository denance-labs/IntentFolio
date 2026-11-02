// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import {
  ANONYMOUS_DRAFT_SLOT,
  NEW_PORTFOLIO_DRAFT_KEY,
  readNewPortfolioDraft,
  saveNewPortfolioDraft,
  type NewPortfolioDraftInput,
} from "../lib/new-portfolio-draft";

const ALICE_WALLET = { chainKind: "near", address: "alice.near" } as const;
const login = vi.hoisted(() => ({
  connection: null as { chainKind: string; address: string } | null,
  intentsAccountId: "alice.near",
}));
vi.mock("@/features/login-wallet", () => ({ useLoginWallet: () => login }));

import { useNewPortfolioDraft } from "./use-new-portfolio-draft";

const BTC = "nep141:nbtc.bridge.near"; // nBTC: `btc.omft.near` has no buy route (D-491)
const ETH = "nep141:eth.omft.near";

const input = (name = "Mine"): NewPortfolioDraftInput => ({
  name,
  presetId: null,
  rows: [
    { tokenId: BTC, targetPct: 60, tolerancePct: 10, locked: false },
    { tokenId: ETH, targetPct: 40, tolerancePct: 10, locked: false },
  ],
});

beforeEach(() => {
  window.localStorage.clear();
  login.connection = ALICE_WALLET;
  login.intentsAccountId = "alice.near";
});
afterEach(() => cleanup());

describe("useNewPortfolioDraft", () => {
  it("starts with no draft", () => {
    const { result } = renderHook(() => useNewPortfolioDraft());
    expect(result.current.draft).toBeNull();
  });

  it("save shows the draft to every reader; discard clears it for all", () => {
    const editor = renderHook(() => useNewPortfolioDraft());
    const card = renderHook(() => useNewPortfolioDraft());

    act(() => {
      expect(editor.result.current.save(input(), [])).toEqual({ ok: true });
    });
    expect(card.result.current.draft?.name).toBe("Mine");

    act(() => card.result.current.discard());
    expect(editor.result.current.draft).toBeNull();
  });

  it("an invalid save returns the reason and shows nothing", () => {
    const { result } = renderHook(() => useNewPortfolioDraft());
    let outcome: ReturnType<typeof result.current.save> | undefined;
    act(() => {
      outcome = result.current.save(input("Taken"), ["taken"]);
    });
    expect(outcome).toMatchObject({ ok: false, reason: "invalid-name", nameError: "nameDuplicate" });
    expect(result.current.draft).toBeNull();
  });

  it("picks up a draft another tab saved", () => {
    const { result } = renderHook(() => useNewPortfolioDraft());
    const stored = { v: 1, ...input("From the other tab"), updatedAt: 1 };
    act(() => {
      window.localStorage.setItem(NEW_PORTFOLIO_DRAFT_KEY, JSON.stringify({ "alice.near": stored }));
      window.dispatchEvent(new StorageEvent("storage", { key: NEW_PORTFOLIO_DRAFT_KEY }));
    });
    expect(result.current.draft?.name).toBe("From the other tab");
  });

  it("is scoped to the signed-in account", () => {
    const { result, rerender } = renderHook(() => useNewPortfolioDraft());
    act(() => {
      result.current.save(input("Alice's"), []);
    });

    login.intentsAccountId = "bob.near";
    rerender();
    expect(result.current.draft).toBeNull();

    login.intentsAccountId = "alice.near";
    rerender();
    expect(result.current.draft?.name).toBe("Alice's");
  });

  it("keeps the same draft object across unrelated re-renders", () => {
    const { result, rerender } = renderHook(() => useNewPortfolioDraft());
    act(() => {
      result.current.save(input(), []);
    });
    const first = result.current.draft;
    rerender();
    expect(result.current.draft).toBe(first);
  });

  it("an identity whose account id could not be derived has no draft and saves nothing", () => {
    login.intentsAccountId = "";
    saveNewPortfolioDraft(ANONYMOUS_DRAFT_SLOT, input("Anon"), []);
    const { result } = renderHook(() => useNewPortfolioDraft());
    expect(result.current.draft).toBeNull();
    expect(result.current.save(input(), [])).toEqual({ ok: false, reason: "no-account" });
  });

  // D-359
  describe("signed out", () => {
    beforeEach(() => {
      login.connection = null;
      login.intentsAccountId = "";
    });

    it("reads, saves and discards the anonymous draft", () => {
      const { result } = renderHook(() => useNewPortfolioDraft());
      act(() => {
        expect(result.current.save(input("Anon"), [])).toEqual({ ok: true });
      });
      expect(result.current.draft?.name).toBe("Anon");
      expect(readNewPortfolioDraft(ANONYMOUS_DRAFT_SLOT)?.name).toBe("Anon");
      expect(readNewPortfolioDraft("alice.near")).toBeNull();

      act(() => result.current.discard());
      expect(result.current.draft).toBeNull();
    });

    it("a session restoring from the saved identity reads the account's draft, not the anonymous one", () => {
      saveNewPortfolioDraft(ANONYMOUS_DRAFT_SLOT, input("Anon"), []);
      saveNewPortfolioDraft("alice.near", input("Alice's"), []);
      // Restoring: no live wallet yet, but `connection` already falls back to the saved identity.
      login.connection = ALICE_WALLET;
      login.intentsAccountId = "alice.near";
      const { result } = renderHook(() => useNewPortfolioDraft());
      expect(result.current.draft?.name).toBe("Alice's");
      act(() => {
        result.current.save(input("Edited"), []);
      });
      expect(readNewPortfolioDraft(ANONYMOUS_DRAFT_SLOT)?.name).toBe("Anon");
    });

    it("switches to the account's draft on connecting", () => {
      saveNewPortfolioDraft(ANONYMOUS_DRAFT_SLOT, input("Anon"), []);
      const { result, rerender } = renderHook(() => useNewPortfolioDraft());
      expect(result.current.draft?.name).toBe("Anon");

      login.connection = ALICE_WALLET;
      login.intentsAccountId = "alice.near";
      rerender();
      expect(result.current.draft).toBeNull();
    });
  });
});
