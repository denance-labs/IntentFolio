import { describe, it, expect, vi } from "vitest";
import { waitForGasArrival, type GasArrivalDeps } from "./gas-arrival";

// This runs AFTER money has already been spent, so what it says is the last thing the user
// hears about a completed purchase. The distinction it exists to draw: "the gas has not
// arrived yet" (true, and a reason to wait) versus "we cannot see your balance" (a bug here,
// and never a reason to buy again).

/** A clock the test drives, so a 2-minute budget costs no real time. */
function fakeClock(start = 1_800_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function deps(over: Partial<GasArrivalDeps> = {}): GasArrivalDeps {
  const clock = fakeClock();
  return {
    read: () => 0,
    refresh: async () => {},
    // Sleeping advances the clock the loop reads, which is what makes the budget expire.
    sleep: async (ms) => clock.advance(ms),
    now: clock.now,
    ...over,
  };
}

const PARAMS = { pollMs: 3_000, budgetMs: 120_000 };

describe("waitForGasArrival", () => {
  it("reports arrival as soon as the balance goes up", async () => {
    let held = 0;
    const refresh = vi.fn(async () => {
      held = 0.08; // the gas landed on the first refresh
    });
    const outcome = await waitForGasArrival({
      ...PARAMS,
      deps: deps({ read: () => held, refresh }),
    });

    expect(outcome).toEqual({ kind: "arrived" });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("keeps waiting through refreshes that change nothing", async () => {
    let held = 0;
    let ticks = 0;
    const refresh = vi.fn(async () => {
      if (++ticks === 5) held = 0.08;
    });
    const outcome = await waitForGasArrival({
      ...PARAMS,
      deps: deps({ read: () => held, refresh }),
    });

    expect(outcome).toEqual({ kind: "arrived" });
    expect(refresh).toHaveBeenCalledTimes(5);
  });

  // Compares against BEFORE, not against an expected total: gas that was already there is not
  // gas that arrived. (The screen only offers a purchase when the balance is short, so this is
  // the leftover-from-last-time case.)
  it("does not mistake a balance that was already there for an arrival", async () => {
    const outcome = await waitForGasArrival({
      ...PARAMS,
      deps: deps({ read: () => 0.02 }), // never moves
    });
    expect(outcome).toEqual({ kind: "timeout" });
  });

  it("gives up after the budget, and calls it a timeout rather than a failure", async () => {
    const refresh = vi.fn(async () => {});
    const outcome = await waitForGasArrival({
      ...PARAMS,
      deps: deps({ read: () => 0, refresh }),
    });

    expect(outcome).toEqual({ kind: "timeout" });
    // 120_000 / 3_000 — the loop neither spins forever nor gives up early.
    expect(refresh).toHaveBeenCalledTimes(40);
  });

  // 🔴 The finding this module was extracted for. Inside the component, an unreadable balance
  // was indistinguishable from an unarrived one, so a key that stopped matching would tell
  // every user that their completed purchase had not landed.
  it("says nothing was observed when the balance cannot be read at all", async () => {
    const outcome = await waitForGasArrival({
      ...PARAMS,
      deps: deps({ read: () => null }),
    });
    expect(outcome).toEqual({ kind: "unobservable" });
  });

  it("refuses to even start when the balance is unreadable before the purchase", async () => {
    const refresh = vi.fn(async () => {});
    const outcome = await waitForGasArrival({
      ...PARAMS,
      deps: deps({ read: () => null, refresh }),
    });

    expect(outcome).toEqual({ kind: "unobservable" });
    // Not one poll: there is no baseline to compare against, so waiting would prove nothing.
    expect(refresh).not.toHaveBeenCalled();
  });

  it("treats a single unreadable poll as a flake, not a verdict", async () => {
    let ticks = 0;
    const reads: (number | null)[] = [0, null, null, 0.08];
    const outcome = await waitForGasArrival({
      ...PARAMS,
      deps: deps({
        read: () => reads[Math.min(ticks, reads.length - 1)],
        refresh: async () => {
          ticks += 1;
        },
      }),
    });

    expect(outcome).toEqual({ kind: "arrived" });
  });
});
