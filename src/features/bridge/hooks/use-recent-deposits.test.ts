// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, cleanup, act } from "@testing-library/react";

vi.mock("../lib/bridge-client", () => ({
  getDepositStatus: vi.fn(),
}));

import { getDepositStatus } from "../lib/bridge-client";
import { useRecentDeposits } from "./use-recent-deposits";
import { markDepositBaseline } from "../lib/credited-deposits-store";

const mockedStatus = vi.mocked(getDepositStatus);

// Defaults to "COMPLETED" because that is what the PoA bridge actually answers. It used to
// default to "CREDITED" — a value this bridge never sends — so every test here exercised a
// branch production could not reach, and the dead credited-path shipped green. See D-226.
function deposit(txHash: string, status = "COMPLETED") {
  return {
    tx_hash: txHash,
    chain: "sol:mainnet",
    status,
    amount: "1000000",
    decimals: 6,
  } as unknown as Awaited<ReturnType<typeof getDepositStatus>>["deposits"][number];
}

// Every suite before the D-475 one tests what happens to an account this browser already knows:
// a never-seen account's first read is a silent baseline, covered on its own below.
function knownAccounts(...ids: string[]) {
  for (const id of ids) markDepositBaseline(id);
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Another poll on demand: the hook polls again whenever the window regains focus.
async function pollAgain() {
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
}

function reply(deposits: ReturnType<typeof deposit>[]) {
  return { deposits, total: deposits.length, limit: 10, offset: 0 } as Awaited<
    ReturnType<typeof getDepositStatus>
  >;
}

// The hook skips polling unless the window has focus, and jsdom reports `false`. Without
// this the suite would pass by never polling at all — the emptiest kind of green.
//
// localStorage is also cleared per test: the D-265 fix persists the notified set there, and a
// leftover entry from a previous test would silently make a "first time ever" case look like a
// repeat.
beforeEach(() => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

// Regression for D-226, found with real money on Stellar (2026-08-08). The credited branch
// asked for `status === "CREDITED"` while the bridge answers `"COMPLETED"`, so it never ran:
// no balance invalidation, no toast, no badge — while the feed updated normally, which is why
// the failure read as "the balance is stale" rather than as a dead branch.
describe("useRecentDeposits — credited detection", () => {
  beforeEach(() => knownAccounts("account-A"));

  it('notifies on "COMPLETED", the status the bridge actually sends', async () => {
    const onCredited = vi.fn();
    mockedStatus.mockResolvedValue(reply([deposit("tx-completed", "COMPLETED")]));

    renderHook(() => useRecentDeposits({ intentsAccountId: "account-A", onCredited }));

    await waitFor(() => expect(onCredited).toHaveBeenCalledTimes(1));
  });

  it('still notifies on "CREDITED"', async () => {
    const onCredited = vi.fn();
    mockedStatus.mockResolvedValue(reply([deposit("tx-credited", "CREDITED")]));

    renderHook(() => useRecentDeposits({ intentsAccountId: "account-A", onCredited }));

    await waitFor(() => expect(onCredited).toHaveBeenCalledTimes(1));
  });

  it("stays quiet while the deposit is still pending", async () => {
    const onCredited = vi.fn();
    mockedStatus.mockResolvedValue(reply([deposit("tx-pending", "PENDING")]));

    const { result } = renderHook(() =>
      useRecentDeposits({ intentsAccountId: "account-A", onCredited }),
    );

    // The feed still shows it — that separation is the whole point: a visible row is not a
    // credited balance.
    await waitFor(() => expect(result.current.deposits).toHaveLength(1));
    expect(onCredited).not.toHaveBeenCalled();
  });
});

// Regression for the cross-account leak observed on 2026-08-06 (008.plan F4.2): after
// switching to a second Backpack account, IntentFolio listed the FIRST account's deposits
// under the second account's name.
describe("useRecentDeposits — account switching", () => {
  beforeEach(() => knownAccounts("account-A", "account-B"));

  it("drops the previous account's deposits as soon as the identity changes", async () => {
    mockedStatus.mockResolvedValueOnce(reply([deposit("tx-from-account-A")]));
    const onCredited = vi.fn();

    const { result, rerender } = renderHook(
      ({ id }) => useRecentDeposits({ intentsAccountId: id, onCredited }),
      { initialProps: { id: "account-A" } },
    );

    await waitFor(() => expect(result.current.deposits).toHaveLength(1));

    // Account B's poll never resolves — exactly the case the silent `catch` used to leave
    // the old list on screen for.
    mockedStatus.mockReturnValueOnce(new Promise(() => {}));
    rerender({ id: "account-B" });

    expect(result.current.deposits).toEqual([]);
  });

  it("ignores an in-flight response that belongs to the previous account", async () => {
    let resolveA: (v: Awaited<ReturnType<typeof getDepositStatus>>) => void = () => {};
    mockedStatus.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveA = resolve;
      }),
    );
    const onCredited = vi.fn();

    const { result, rerender } = renderHook(
      ({ id }) => useRecentDeposits({ intentsAccountId: id, onCredited }),
      { initialProps: { id: "account-A" } },
    );

    mockedStatus.mockResolvedValueOnce(reply([]));
    rerender({ id: "account-B" });

    // A's request lands late, after the switch. It must not paint over B.
    resolveA(reply([deposit("tx-from-account-A")]));

    await waitFor(() => expect(mockedStatus).toHaveBeenCalledTimes(2));
    expect(result.current.deposits).toEqual([]);
  });

  it("re-notifies a credited tx hash under a new account", async () => {
    const onCredited = vi.fn();
    mockedStatus.mockResolvedValueOnce(reply([deposit("shared-hash")]));

    const { rerender } = renderHook(
      ({ id }) => useRecentDeposits({ intentsAccountId: id, onCredited }),
      { initialProps: { id: "account-A" } },
    );
    await waitFor(() => expect(onCredited).toHaveBeenCalledTimes(1));

    // The dedupe set is per-account: the same hash under a different identity is a
    // different event, not a repeat.
    mockedStatus.mockResolvedValueOnce(reply([deposit("shared-hash")]));
    rerender({ id: "account-B" });

    await waitFor(() => expect(onCredited).toHaveBeenCalledTimes(2));
  });
});

// Regression for D-265, found in session 121 (2026-08-10): a toast re-fired for a deposit
// that had actually landed two days earlier. The in-memory `creditedRef` Set only ever lived
// for the hook's mount, and dashboard-shell.tsx's `intentsAccountId: loginConnected ? id : ""`
// makes this identity-change effect fire on basically every page load (loginConnected starts
// false and flips true once wallet-session restore resolves) — wiping the set and making every
// already-COMPLETED deposit look unseen again.
describe("useRecentDeposits — durable notified-set (D-265)", () => {
  beforeEach(() => knownAccounts("account-A", "account-B"));

  it("does not re-notify an already-COMPLETED deposit across a remount with the same account", async () => {
    const onCredited = vi.fn();
    mockedStatus.mockResolvedValue(reply([deposit("tx-old")]));

    const { unmount } = renderHook(() =>
      useRecentDeposits({ intentsAccountId: "account-A", onCredited }),
    );
    await waitFor(() => expect(onCredited).toHaveBeenCalledTimes(1));
    unmount();

    // Mirrors what dashboard-shell.tsx actually does on every reload: the hook mounts with
    // intentsAccountId "" while the wallet session restore is in flight, then the identity
    // changes to the real account once it resolves — a fresh mount, not a rerender.
    const onCredited2 = vi.fn();
    const { rerender } = renderHook(
      ({ id }) => useRecentDeposits({ intentsAccountId: id, onCredited: onCredited2 }),
      { initialProps: { id: "" } },
    );
    rerender({ id: "account-A" });

    await waitFor(() => expect(mockedStatus).toHaveBeenCalledTimes(2));
    expect(onCredited2).not.toHaveBeenCalled();
  });

  it("still notifies another known account for a hash it has not announced", async () => {
    mockedStatus.mockResolvedValueOnce(reply([deposit("tx-seen-by-A")]));
    const onCreditedA = vi.fn();
    const { unmount } = renderHook(() =>
      useRecentDeposits({ intentsAccountId: "account-A", onCredited: onCreditedA }),
    );
    await waitFor(() => expect(onCreditedA).toHaveBeenCalledTimes(1));
    unmount();

    mockedStatus.mockResolvedValueOnce(reply([deposit("tx-seen-by-B")]));
    const onCreditedB = vi.fn();
    renderHook(() =>
      useRecentDeposits({ intentsAccountId: "account-B", onCredited: onCreditedB }),
    );

    await waitFor(() => expect(onCreditedB).toHaveBeenCalledTimes(1));
  });
});

// Regression for D-475, seen at the public opening (s264): an account's first visit to
// intentfolio.app toasted a deposit made days earlier on staging. The notified set is per
// origin, so for an account this browser never saw it started empty and every deposit the bridge
// still listed as COMPLETED looked new.
describe("useRecentDeposits — silent baseline for a never-seen account (D-475)", () => {
  it("does not announce deposits that were already COMPLETED at the first read", async () => {
    const onCredited = vi.fn();
    mockedStatus.mockResolvedValue(reply([deposit("tx-old-1"), deposit("tx-old-2")]));

    const { result } = renderHook(() =>
      useRecentDeposits({ intentsAccountId: "account-new", onCredited }),
    );

    // The feed still lists them; only the "credited!" announcement is withheld.
    await waitFor(() => expect(result.current.deposits).toHaveLength(2));
    await pollAgain();
    await waitFor(() => expect(mockedStatus).toHaveBeenCalledTimes(2));
    expect(onCredited).not.toHaveBeenCalled();
  });

  it("announces a deposit that completes after the first read", async () => {
    const onCredited = vi.fn();
    mockedStatus.mockResolvedValueOnce(reply([deposit("tx-old"), deposit("tx-arriving", "PENDING")]));

    renderHook(() => useRecentDeposits({ intentsAccountId: "account-new", onCredited }));
    await waitFor(() => expect(mockedStatus).toHaveBeenCalledTimes(1));

    mockedStatus.mockResolvedValueOnce(reply([deposit("tx-old"), deposit("tx-arriving")]));
    await pollAgain();

    await waitFor(() => expect(onCredited).toHaveBeenCalledTimes(1));
    expect(onCredited.mock.calls[0][0].tx_hash).toBe("tx-arriving");
  });

  // The case a "notified set is empty" check would get wrong: nothing was COMPLETED at the first
  // read, so nothing was written to the notified set, and the reload would re-baseline.
  it("announces a deposit that completes after a reload, when the first read had only a pending one", async () => {
    mockedStatus.mockResolvedValueOnce(reply([deposit("tx-arriving", "PENDING")]));
    const { unmount } = renderHook(() =>
      useRecentDeposits({ intentsAccountId: "account-new", onCredited: vi.fn() }),
    );
    await waitFor(() => expect(mockedStatus).toHaveBeenCalledTimes(1));
    unmount();

    mockedStatus.mockResolvedValueOnce(reply([deposit("tx-arriving")]));
    const onCredited = vi.fn();
    const { rerender } = renderHook(
      ({ id }) => useRecentDeposits({ intentsAccountId: id, onCredited }),
      { initialProps: { id: "" } },
    );
    rerender({ id: "account-new" });

    await waitFor(() => expect(onCredited).toHaveBeenCalledTimes(1));
  });

  it("does not take the baseline from a failed read", async () => {
    mockedStatus.mockRejectedValueOnce(new Error("Internal server error"));
    const onCredited = vi.fn();
    renderHook(() => useRecentDeposits({ intentsAccountId: "account-new", onCredited }));
    await waitFor(() => expect(mockedStatus).toHaveBeenCalledTimes(1));

    // The first read that works is still the baseline, so this old deposit stays quiet...
    mockedStatus.mockResolvedValueOnce(reply([deposit("tx-old")]));
    await pollAgain();
    await waitFor(() => expect(mockedStatus).toHaveBeenCalledTimes(2));
    expect(onCredited).not.toHaveBeenCalled();

    // ...and what completes after it is news.
    mockedStatus.mockResolvedValueOnce(reply([deposit("tx-old"), deposit("tx-new")]));
    await pollAgain();
    await waitFor(() => expect(onCredited).toHaveBeenCalledTimes(1));
  });

  it("announces a brand-new user's first deposit when it completes with the app open", async () => {
    mockedStatus.mockResolvedValueOnce(reply([]));
    const onCredited = vi.fn();
    renderHook(() => useRecentDeposits({ intentsAccountId: "account-new", onCredited }));
    await waitFor(() => expect(mockedStatus).toHaveBeenCalledTimes(1));

    mockedStatus.mockResolvedValueOnce(reply([deposit("tx-first")]));
    await pollAgain();

    await waitFor(() => expect(onCredited).toHaveBeenCalledTimes(1));
  });

  it("keeps announcing after the first read when storage cannot be written", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    mockedStatus.mockResolvedValueOnce(reply([]));
    const onCredited = vi.fn();
    renderHook(() => useRecentDeposits({ intentsAccountId: "account-new", onCredited }));
    await waitFor(() => expect(mockedStatus).toHaveBeenCalledTimes(1));

    mockedStatus.mockResolvedValueOnce(reply([deposit("tx-first")]));
    await pollAgain();

    await waitFor(() => expect(onCredited).toHaveBeenCalledTimes(1));
  });

  it("treats an account with notified deposits from before the baseline marker as known", async () => {
    window.localStorage.setItem(
      "bridge.credited-deposits.v1",
      JSON.stringify({ "account-old": { "tx-before:sol:mainnet": Date.now() } }),
    );
    mockedStatus.mockResolvedValue(reply([deposit("tx-before"), deposit("tx-while-away")]));
    const onCredited = vi.fn();

    renderHook(() => useRecentDeposits({ intentsAccountId: "account-old", onCredited }));

    await waitFor(() => expect(onCredited).toHaveBeenCalledTimes(1));
    expect(onCredited.mock.calls[0][0].tx_hash).toBe("tx-while-away");
  });
});

// Same symptom by another road: notified entries are pruned after RETENTION_MS, and the bridge
// keeps listing an account's last deposits for as long as there are no newer ones.
describe("useRecentDeposits — retention while the bridge still lists a deposit (D-475)", () => {
  it("does not re-announce a still-listed deposit once its first notification is past retention", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    knownAccounts("account-A");
    mockedStatus.mockResolvedValue(reply([deposit("tx-old")]));

    const onCredited = vi.fn();
    const { unmount } = renderHook(() =>
      useRecentDeposits({ intentsAccountId: "account-A", onCredited }),
    );
    await waitFor(() => expect(onCredited).toHaveBeenCalledTimes(1));

    // Seen again by a poll three weeks later, then the app reopened two more weeks after that:
    // five weeks since the toast, two since the bridge last listed it.
    vi.setSystemTime(Date.now() + 21 * DAY_MS);
    await pollAgain();
    await waitFor(() => expect(mockedStatus).toHaveBeenCalledTimes(2));
    unmount();
    vi.setSystemTime(Date.now() + 14 * DAY_MS);

    const onCreditedLater = vi.fn();
    renderHook(() => useRecentDeposits({ intentsAccountId: "account-A", onCredited: onCreditedLater }));
    await waitFor(() => expect(mockedStatus).toHaveBeenCalledTimes(3));
    expect(onCreditedLater).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
