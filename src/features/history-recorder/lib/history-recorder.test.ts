// The pass's contract that needs no database: it never throws, and how it classifies a refusal.
// Everything that touches SQL is proven against Postgres in history-recorder-db.integration.test.ts.

import { describe, expect, it, vi } from "vitest";
import type { TransactionalQueryable } from "@/features/vault/lib/ops-records-service";
import { isDataRefusal, isTransientConflict, runHistoryPass, swapsToAdd } from "./history-recorder";

const pgError = (code: string) => Object.assign(new Error("x"), { code });

describe("runHistoryPass — never throws", () => {
  it("a database that cannot be reached is a failed pass, not an exception", async () => {
    const down = {
      query: vi.fn(async () => Promise.reject(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }))),
      connect: vi.fn(),
    } as unknown as TransactionalQueryable;
    const fastnear = { indexedHeadMs: vi.fn(), listPage: vi.fn(), fetchTxs: vi.fn() };
    const r = await runHistoryPass({ db: down, vaultId: "v.near", fastnear, prices: async () => new Map() });
    expect(r).toMatchObject({ ran: true, ok: false, error: "ECONNREFUSED: connect ECONNREFUSED" });
    expect(fastnear.listPage).not.toHaveBeenCalled();
  });
});

describe("isDataRefusal — what may be dropped and what must be retried", () => {
  it("data, integrity and limit errors cannot succeed on a retry", () => {
    for (const code of ["22P02", "22P05", "22003", "23514", "54001"]) expect(isDataRefusal(pgError(code))).toBe(true);
  });

  it("timeouts, cancels and lost connections might", () => {
    for (const code of ["57014", "08006", "53300", "40001"]) expect(isDataRefusal(pgError(code))).toBe(false);
    expect(isDataRefusal(new Error("Query read timeout"))).toBe(false);
    expect(isDataRefusal("nope")).toBe(false);
  });
});

describe("isTransientConflict — a row lost to another writer, retried next pass (009 header)", () => {
  it("deadlock, serialization failure and lock timeout", () => {
    for (const code of ["40P01", "40001", "55P03"]) expect(isTransientConflict(pgError(code))).toBe(true);
  });

  it("nothing else: a refusal of the data, a timeout of the statement, a lost connection", () => {
    for (const code of ["23514", "22P05", "57014", "08006"]) expect(isTransientConflict(pgError(code))).toBe(false);
    expect(isTransientConflict(new Error("x"))).toBe(false);
  });
});

describe("swapsToAdd — the daily sums take what the table returned, once", () => {
  const row = (receiptId: string, ord: number, swapToken: string | null) => ({
    e: { receiptId, logIndex: 0, blockTsMs: 1 },
    p: { ord, portfolioId: `p_${ord}`, qtyIn: "1", qtyOut: "1", spread: "5", swapToken },
  });

  it("a row sent twice and returned once is added once; a row not returned is not added", () => {
    const a = row("r1", 0, "t");
    const b = row("r1", 1, "t");
    const added = swapsToAdd([a, a, b], [{ receipt_id: "r1", log_index: 0, ord: 0 }]);
    expect(added).toEqual([a]);
  });

  it("rows that are not swaps are never added", () => {
    expect(swapsToAdd([row("r1", 0, null)], [{ receipt_id: "r1", log_index: 0, ord: 0 }])).toEqual([]);
  });
});
