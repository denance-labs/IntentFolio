// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  recordPendingAllocate,
  recordSignedEnvelope,
  updateAllocateRecord,
  listAllocateRecords,
  listUnresolvedAllocateRecords,
  clearAllocateRecords,
  type RecordPendingAllocateParams,
} from "./allocate-rescue-store";
import { VAULT_DEBUG_ENVELOPES_KEY } from "./vault-debug-log";

// This store is the only thing standing between an orphaned AuthCall and unrecoverable
// funds (007.plan Phase 1), so the invariants below are load-bearing, not hygiene:
// the raw msg must survive byte-identical, and a failed persist must THROW so the caller
// aborts before signing.

const PARAMS: RecordPendingAllocateParams = {
  signerId: "alice.near",
  msg: '{"deadline":1800000000,"nonce":[1,2],"op":{"setup":{"portfolio_name":"P"}}}',
  vaultId: "intentfolio-staging.near",
  portfolioName: "P",
  legs: [{ tokenId: "nep141:usdc.near", amount: "1000000" }],
};

beforeEach(() => {
  window.localStorage.clear();
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("recordPendingAllocate", () => {
  it("keeps EVERY funded leg, so a rescue is not decided on half the picture", () => {
    recordPendingAllocate({
      ...PARAMS,
      legs: [
        { tokenId: "nep141:usdc.near", amount: "3500000" },
        { tokenId: "nep141:eth.near", amount: "130000000000000" },
      ],
    });
    const [saved] = listAllocateRecords();
    expect(saved.legs).toEqual([
      { tokenId: "nep141:usdc.near", amount: "3500000" },
      { tokenId: "nep141:eth.near", amount: "130000000000000" },
    ]);
  });

  it("persists the raw msg byte-identically", () => {
    recordPendingAllocate(PARAMS);
    const [saved] = listAllocateRecords();
    // Identity, not equivalence: the contract sha256's these exact bytes.
    expect(saved.msg).toBe(PARAMS.msg);
    expect(saved.signerId).toBe("alice.near");
    expect(saved.status).toBe("signing");
  });

  it("survives a reload (reads back from localStorage, not memory)", () => {
    const id = recordPendingAllocate(PARAMS);
    // The msg is JSON-escaped inside the store envelope, so assert the escaped form is
    // what actually hit disk — then assert it decodes back byte-identically.
    const raw = window.localStorage.getItem("vault.allocate-rescue.v1");
    expect(raw).toContain(JSON.stringify(PARAMS.msg).slice(1, -1));
    expect(listAllocateRecords().find((r) => r.id === id)?.msg).toBe(PARAMS.msg);
  });

  it("keeps multiple records instead of overwriting", () => {
    recordPendingAllocate(PARAMS);
    recordPendingAllocate({ ...PARAMS, portfolioName: "Q" });
    expect(listAllocateRecords()).toHaveLength(2);
  });

  it("THROWS when persistence fails so the caller can abort before signing", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => recordPendingAllocate(PARAMS)).toThrow();
  });

  it("logs the record as an independent second channel", () => {
    recordPendingAllocate(PARAMS);
    expect(console.log).toHaveBeenCalledWith(
      "[vault] allocate rescue record persisted",
      expect.objectContaining({ msg: PARAMS.msg })
    );
  });
});

describe("updateAllocateRecord", () => {
  it("attaches the tx hash and status after submit", () => {
    const id = recordPendingAllocate(PARAMS);
    updateAllocateRecord(id, { status: "submitted", txHash: "7xTx" });
    const saved = listAllocateRecords().find((r) => r.id === id);
    expect(saved).toMatchObject({ status: "submitted", txHash: "7xTx" });
    expect(saved?.msg).toBe(PARAMS.msg); // msg untouched by the update
  });

  it("ignores an unknown id and never throws", () => {
    expect(() => updateAllocateRecord("nope", { status: "credited" })).not.toThrow();
  });
});

// The envelope is the second piece of evidence, and it follows the `msg` rule, not the
// status rule: it THROWS. Without it the solver's rescue tool will not sign a credit, so a
// silently dropped envelope is a record that looks fine and cannot be rescued (D-289).
describe("recordSignedEnvelope", () => {
  const ENVELOPE = { standard: "nep413", payload: { message: "{}" }, signature: "ed25519:x" };

  it("attaches the envelope to an existing record and survives a reload", () => {
    const id = recordPendingAllocate(PARAMS);
    recordSignedEnvelope(id, ENVELOPE);

    const raw = window.localStorage.getItem("vault.allocate-rescue.v1");
    expect(JSON.parse(raw as string)[id].signedEnvelope).toEqual(ENVELOPE);
  });

  it("leaves the msg untouched — the two are different evidence", () => {
    const id = recordPendingAllocate(PARAMS);
    recordSignedEnvelope(id, ENVELOPE);
    expect(listAllocateRecords()[0].msg).toBe(PARAMS.msg);
  });

  it("THROWS when the write fails, so the caller aborts before submitting", () => {
    const id = recordPendingAllocate(PARAMS);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => recordSignedEnvelope(id, ENVELOPE)).toThrow();
  });

  // Unlike `updateAllocateRecord`, which returns quietly. A missing record here means the
  // local copy of an IN-FLIGHT Allocate is gone, which is not a state to shrug at.
  it("THROWS on an unknown id instead of dropping the envelope on the floor", () => {
    expect(() => recordSignedEnvelope("no-such-id", ENVELOPE)).toThrow(/not in local storage/i);
  });

  // D-472: the envelope is submittable by any account until its deadline, so the console
  // copy is opt-in per browser, and no other line of the store carries it.
  it("keeps it out of the console unless this browser opted in", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const id = recordPendingAllocate(PARAMS);
    recordSignedEnvelope(id, ENVELOPE);
    updateAllocateRecord(id, { status: "submitted" });
    expect(JSON.stringify(log.mock.calls)).not.toContain(JSON.stringify(ENVELOPE));
    expect(listAllocateRecords()[0].signedEnvelope).toEqual(ENVELOPE); // stored all the same
  });

  it("logs it as an independent second channel when opted in", () => {
    window.localStorage.setItem(VAULT_DEBUG_ENVELOPES_KEY, "1");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const id = recordPendingAllocate(PARAMS);
    recordSignedEnvelope(id, ENVELOPE);
    expect(log.mock.calls.at(-1)?.[1]).toMatchObject({ signedEnvelope: ENVELOPE });
  });
});

describe("rescue worklist", () => {
  it("keeps everything not yet credited, and retains credited records as evidence", () => {
    const credited = recordPendingAllocate(PARAMS);
    const stuck = recordPendingAllocate({ ...PARAMS, portfolioName: "Stuck" });
    updateAllocateRecord(credited, { status: "credited" });
    updateAllocateRecord(stuck, { status: "failed" });

    expect(listAllocateRecords()).toHaveLength(2); // credited NOT deleted
    expect(listUnresolvedAllocateRecords().map((r) => r.id)).toEqual([stuck]);
  });

  it("clears only through the explicit operator call", () => {
    recordPendingAllocate(PARAMS);
    clearAllocateRecords();
    expect(listAllocateRecords()).toEqual([]);
  });
});
