import { describe, expect, it, vi } from "vitest";
import { findScheduledReturns } from "./vault-returns";
import type { ReturnView } from "./vault-read-client";

// D-302 h2: which scheduled Returns the My Account notice shows. The v2-only gate is in the
// hook and tested in `use-scheduled-returns.test.tsx`.

const ME = "alice.near";

function ret(over: Partial<ReturnView> = {}): ReturnView {
  return {
    id: 0,
    token: "near",
    amount: "1000000000000000000000000",
    to: ME,
    reason: "credit_to_deleted_portfolio",
    eta: 1_000,
    executing: false,
    ...over,
  };
}

function readsFrom(table: Record<number, ReturnView | null>) {
  return vi.fn(async (id: number) => table[id] ?? null);
}

describe("findScheduledReturns", () => {
  it("counter 0: no Return reads at all", async () => {
    const readReturn = vi.fn();
    const out = await findScheduledReturns({
      accountId: ME,
      readConfig: async () => ({ return_counter: 0 }),
      readReturn,
    });
    expect(out).toEqual([]);
    expect(readReturn).not.toHaveBeenCalled();
  });

  it("reads every id below the counter, keeps only this account's, skips nulls", async () => {
    const readReturn = readsFrom({
      0: ret({ id: 0 }),
      1: null, // executed or cancelled
      2: ret({ id: 2, to: "bob.near" }),
      3: ret({ id: 3, token: "usdc", amount: "5000000" }),
    });
    const out = await findScheduledReturns({
      accountId: ME,
      readConfig: async () => ({ return_counter: 4 }),
      readReturn,
    });
    expect(readReturn.mock.calls.map(([id]) => id).sort()).toEqual([0, 1, 2, 3]);
    expect(out.map((r) => r.id)).toEqual([0, 3]);
  });

  it("sorts by eta ascending, id as tie-break", async () => {
    const out = await findScheduledReturns({
      accountId: ME,
      readConfig: async () => ({ return_counter: 4 }),
      readReturn: readsFrom({
        0: ret({ id: 0, eta: 3_000 }),
        1: ret({ id: 1, eta: 1_000 }),
        2: ret({ id: 2, eta: 2_000 }),
        3: ret({ id: 3, eta: 1_000 }),
      }),
    });
    expect(out.map((r) => r.id)).toEqual([1, 3, 2, 0]);
  });

  it("keeps a Return that is executing: the funds have not arrived yet", async () => {
    const out = await findScheduledReturns({
      accountId: ME,
      readConfig: async () => ({ return_counter: 1 }),
      readReturn: readsFrom({ 0: ret({ executing: true }) }),
    });
    expect(out).toHaveLength(1);
  });

  it("a failed Return read rejects instead of resolving to a partial or empty list", async () => {
    const readReturn = vi.fn(async (id: number) => {
      if (id === 2) throw new Error("rpc down");
      return ret({ id });
    });
    await expect(
      findScheduledReturns({
        accountId: ME,
        readConfig: async () => ({ return_counter: 5 }),
        readReturn,
        concurrency: 1,
      })
    ).rejects.toThrow("rpc down");
    // With one worker, nothing after the failure is read.
    expect(readReturn.mock.calls.map(([id]) => id)).toEqual([0, 1, 2]);
  });

  it("a failed config read rejects", async () => {
    await expect(
      findScheduledReturns({
        accountId: ME,
        readConfig: async () => {
          throw new Error("rpc down");
        },
        readReturn: vi.fn(),
      })
    ).rejects.toThrow("rpc down");
  });

  it("a malformed counter rejects rather than reading as no Returns", async () => {
    await expect(
      findScheduledReturns({
        accountId: ME,
        readConfig: async () => ({ return_counter: undefined as unknown as number }),
        readReturn: vi.fn(),
      })
    ).rejects.toThrow(/return_counter/);
  });

  it("never runs more reads at once than the concurrency bound", async () => {
    let inFlight = 0;
    let peak = 0;
    const readReturn = vi.fn(async (id: number) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return ret({ id });
    });
    const out = await findScheduledReturns({
      accountId: ME,
      readConfig: async () => ({ return_counter: 10 }),
      readReturn,
      concurrency: 3,
    });
    expect(out).toHaveLength(10);
    expect(peak).toBe(3);
  });
});
