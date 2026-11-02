// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  recordPendingWithdraw,
  updateWithdrawRecord,
  listWithdrawRecords,
  listUnresolvedWithdrawRecords,
  clearWithdrawRecords,
  dismissWithdrawRecord,
  DISMISS_AFTER_MS,
  RESOLVED_RETENTION_MS,
  type RecordPendingWithdrawParams,
} from "./withdraw-rescue-store";

// D-190. The record is the only durable trace of a withdrawal that may be in flight, so the
// invariants below are load-bearing rather than hygiene:
//   - a failed persist THROWS, so the caller can abort before publishing;
//   - an UNRESOLVED record is never dropped, at any age — our timeouts bound what we report,
//     not what the relay and the bridge do;
//   - RESOLVED records are evidence with a bounded life, so the store cannot grow forever.

const PARAMS: RecordPendingWithdrawParams = {
  signerId: "alice.near",
  tokenId: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
  amount: "1500000",
  qty: 1.5,
  route: "omft",
  chainId: "eth:42161",
  destinationAddress: "0xc8b1e10d011aceed84f4cdba66ca175bd6552a36",
};

beforeEach(() => {
  window.localStorage.clear();
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("recordPendingWithdraw", () => {
  it("keeps everything a person needs to retake the withdrawal, and starts unresolved", () => {
    const id = recordPendingWithdraw({ ...PARAMS, destinationMemo: "tag-42" });
    const [saved] = listWithdrawRecords();

    expect(saved.id).toBe(id);
    expect(saved).toMatchObject({
      signerId: "alice.near",
      tokenId: PARAMS.tokenId,
      amount: "1500000",
      qty: 1.5,
      route: "omft",
      chainId: "eth:42161",
      destinationAddress: PARAMS.destinationAddress,
      destinationMemo: "tag-42",
      status: "publishing",
    });
    // Written before the publish, so there is nothing to hash on yet.
    expect(saved.intentHash).toBeUndefined();
  });

  it("survives a reload (reads back from localStorage, not memory)", () => {
    const id = recordPendingWithdraw(PARAMS);
    const raw = window.localStorage.getItem("bridge.withdraw-rescue.v1") ?? "";
    expect(raw).toContain(PARAMS.destinationAddress);
    expect(listWithdrawRecords().find((r) => r.id === id)?.amount).toBe("1500000");
  });

  it("keeps multiple records instead of overwriting", () => {
    recordPendingWithdraw(PARAMS);
    recordPendingWithdraw({ ...PARAMS, qty: 2 });
    expect(listWithdrawRecords()).toHaveLength(2);
  });

  it("THROWS when persistence fails so the caller can abort before publishing", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => recordPendingWithdraw(PARAMS)).toThrow();
  });

  it("logs the record as an independent second channel", () => {
    recordPendingWithdraw(PARAMS);
    expect(console.log).toHaveBeenCalledWith(
      "[withdraw] rescue record persisted",
      expect.objectContaining({ amount: "1500000", status: "publishing" })
    );
  });
});

describe("updateWithdrawRecord", () => {
  it("attaches the relay hash, then the settlement tx, then the destination tx", () => {
    const id = recordPendingWithdraw(PARAMS);
    updateWithdrawRecord(id, { status: "published", intentHash: "0xIntent" });
    updateWithdrawRecord(id, { status: "settled", txHash: "TxNear" });
    updateWithdrawRecord(id, { status: "delivered", destinationTxHash: "0xArb" });

    expect(listWithdrawRecords()[0]).toMatchObject({
      status: "delivered",
      intentHash: "0xIntent",
      txHash: "TxNear",
      destinationTxHash: "0xArb",
    });
  });

  it("never reopens a record another tab already closed (D-435)", () => {
    for (const closed of ["delivered", "refunded", "failed", "dismissed"] as const) {
      const id = recordPendingWithdraw(PARAMS);
      updateWithdrawRecord(id, { status: closed });
      // The slower tab's live conversion catches up with progress the record is already past.
      updateWithdrawRecord(id, { status: "published", intentHash: "0xIntent" });
      updateWithdrawRecord(id, { status: "settled", txHash: "TxNear" });

      expect(listWithdrawRecords().find((r) => r.id === id)).toMatchObject({
        status: closed,
        intentHash: "0xIntent",
        txHash: "TxNear",
      });
    }
  });

  it("ignores an unknown id and never throws", () => {
    expect(() => updateWithdrawRecord("nope", { status: "delivered" })).not.toThrow();
  });

  it("never throws when storage fails: progress is a convenience, the record is not", () => {
    const id = recordPendingWithdraw(PARAMS);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => updateWithdrawRecord(id, { status: "settled" })).not.toThrow();
  });
});

describe("the worklist", () => {
  it("holds every withdrawal that may still be in flight, and no resolved one", () => {
    const delivered = recordPendingWithdraw(PARAMS);
    const rejected = recordPendingWithdraw(PARAMS);
    const inFlight = recordPendingWithdraw(PARAMS);
    const settledOnly = recordPendingWithdraw(PARAMS);
    updateWithdrawRecord(delivered, { status: "delivered" });
    updateWithdrawRecord(rejected, { status: "failed" });
    updateWithdrawRecord(settledOnly, { status: "settled" });

    expect(listWithdrawRecords()).toHaveLength(4); // resolved records are NOT deleted
    expect(listUnresolvedWithdrawRecords().map((r) => r.id).sort()).toEqual(
      [inFlight, settledOnly].sort()
    );
  });
});

describe("pruning — the store must not leak, and must not forget", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const T0 = 1_800_000_000_000;

  it("drops a RESOLVED record once it is past the retention window", () => {
    vi.spyOn(Date, "now").mockReturnValue(T0);
    const old = recordPendingWithdraw(PARAMS);
    updateWithdrawRecord(old, { status: "delivered" });

    vi.spyOn(Date, "now").mockReturnValue(T0 + RESOLVED_RETENTION_MS + DAY);
    recordPendingWithdraw(PARAMS); // pruning runs on WRITE, never on read

    expect(listWithdrawRecords().map((r) => r.id)).not.toContain(old);
  });

  it("keeps an UNRESOLVED record of the same age — old is not evidence of anything", () => {
    // The money case: our timeouts bound what we REPORT, not what the relay does, so an
    // ancient "published" record can still correspond to funds that arrived.
    vi.spyOn(Date, "now").mockReturnValue(T0);
    const stuck = recordPendingWithdraw(PARAMS);
    updateWithdrawRecord(stuck, { status: "published", intentHash: "0xIntent" });

    vi.spyOn(Date, "now").mockReturnValue(T0 + RESOLVED_RETENTION_MS * 10);
    recordPendingWithdraw(PARAMS);

    expect(listUnresolvedWithdrawRecords().map((r) => r.id)).toContain(stuck);
  });

  it("keeps a resolved record that is still inside the window", () => {
    vi.spyOn(Date, "now").mockReturnValue(T0);
    const recent = recordPendingWithdraw(PARAMS);
    updateWithdrawRecord(recent, { status: "delivered" });

    vi.spyOn(Date, "now").mockReturnValue(T0 + DAY);
    recordPendingWithdraw(PARAMS);

    expect(listWithdrawRecords().map((r) => r.id)).toContain(recent);
  });
});

// Plan 020 §5.4: Converting Withdrawals share the key, the write moment and the resolution rule,
// plus one resolved state of their own.
describe("conversion records (020-2)", () => {
  const CONVERSION: RecordPendingWithdrawParams = {
    kind: "conversion",
    signerId: "alice.near",
    tokenId: "nep141:eth.omft.near",
    amount: "5000000000000000",
    qty: 0.005,
    chainId: "near:mainnet",
    destinationAddress: "alice.near",
    conversion: {
      depositAddress: "5863efabda6c40d89b37aa899add569e32cb7a670e6b56a7f2cbb8d62c5333a0",
      deliveryTokenId: "nep141:eth.bridge.near",
      amountOut: "4998990052004899",
      minAmountOut: "4973995101744874",
      requestedDeadlineMs: 1_790_000_000_000,
      quoteSignature: "ed25519:quoteSignature",
    },
  };

  it("keeps the 1Click handle and the quote it promised, under the same key", () => {
    const id = recordPendingWithdraw(CONVERSION);
    const [saved] = listWithdrawRecords();

    expect(saved).toMatchObject({ ...CONVERSION, id, status: "publishing" });
    expect(window.localStorage.getItem("bridge.withdraw-rescue.v1")).toContain(
      CONVERSION.conversion.depositAddress
    );
  });

  it("resolves on refunded — off the worklist, kept as evidence with what came back", () => {
    const refunded = recordPendingWithdraw(CONVERSION);
    const open = recordPendingWithdraw(CONVERSION);
    updateWithdrawRecord(refunded, { status: "refunded", refundedAmount: "5000000000000000" });
    updateWithdrawRecord(open, { status: "settled" });

    expect(listWithdrawRecords().find((r) => r.id === refunded)).toMatchObject({
      status: "refunded",
      refundedAmount: "5000000000000000",
    });
    expect(listUnresolvedWithdrawRecords().map((r) => r.id)).toEqual([open]);
  });

  it("prunes a refunded record past the retention window, like any resolved one", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const old = recordPendingWithdraw(CONVERSION);
    updateWithdrawRecord(old, { status: "refunded" });

    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000 + RESOLVED_RETENTION_MS + 1);
    recordPendingWithdraw(CONVERSION);

    expect(listWithdrawRecords().map((r) => r.id)).not.toContain(old);
  });

  it("still reads a record written before conversions existed as direct", () => {
    // What a browser that withdrew before 020 has in storage: no `kind`.
    window.localStorage.setItem(
      "bridge.withdraw-rescue.v1",
      JSON.stringify({ legacy: { ...PARAMS, id: "legacy", createdAt: 1, status: "settled" } })
    );
    const [legacy] = listUnresolvedWithdrawRecords();
    expect(legacy.kind).toBeUndefined();
    expect(legacy.kind !== "conversion" && legacy.route).toBe("omft");
  });
});

describe("dismissWithdrawRecord (D-463, 023-B)", () => {
  const createdAt = (id: string) => listWithdrawRecords().find((r) => r.id === id)!.createdAt;

  it("closes an open record older than a day: off the worklist, kept as evidence", () => {
    const id = recordPendingWithdraw(PARAMS);
    updateWithdrawRecord(id, { status: "published", intentHash: "hash-1" });

    expect(dismissWithdrawRecord(id, createdAt(id) + DISMISS_AFTER_MS + 1)).toBe(true);

    expect(listUnresolvedWithdrawRecords()).toEqual([]);
    const [saved] = listWithdrawRecords();
    expect(saved).toMatchObject({ id, status: "dismissed", intentHash: "hash-1" });
  });

  it("refuses a record that has not been open for a full day", () => {
    const id = recordPendingWithdraw(PARAMS);
    expect(dismissWithdrawRecord(id, createdAt(id) + DISMISS_AFTER_MS)).toBe(false);
    expect(listUnresolvedWithdrawRecords()).toHaveLength(1);
  });

  it("never overwrites a verdict a re-check already wrote", () => {
    const id = recordPendingWithdraw(PARAMS);
    updateWithdrawRecord(id, { status: "delivered", destinationTxHash: "0xdest" });
    expect(dismissWithdrawRecord(id, createdAt(id) + DISMISS_AFTER_MS + 1)).toBe(false);
    expect(listWithdrawRecords()[0]).toMatchObject({ status: "delivered", destinationTxHash: "0xdest" });
  });

  it("answers false for an id it does not have", () => {
    expect(dismissWithdrawRecord("missing", Date.now() + DISMISS_AFTER_MS * 2)).toBe(false);
  });

  it("is pruned past the retention window, like any resolved record", () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const id = recordPendingWithdraw(PARAMS);
    dismissWithdrawRecord(id, now + DISMISS_AFTER_MS + 1);

    vi.spyOn(Date, "now").mockReturnValue(now + RESOLVED_RETENTION_MS + 1);
    recordPendingWithdraw(PARAMS);

    expect(listWithdrawRecords().map((r) => r.id)).not.toContain(id);
  });
});

describe("clearWithdrawRecords", () => {
  it("is the only thing that removes an unresolved record", () => {
    recordPendingWithdraw(PARAMS);
    clearWithdrawRecords();
    expect(listWithdrawRecords()).toEqual([]);
  });
});
