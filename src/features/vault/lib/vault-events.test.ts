import { describe, it, expect } from "vitest";
import {
  collectLogs,
  findExecutionFailure,
  classifyAllocateOutcome,
  findUnallocateDeferred,
  findUnallocateFailure,
  hasPendingUnallocation,
  parseVaultEvents,
} from "./vault-events";

// The wire format is pinned to the contract's emitter (events.rs `emit_event`). What must
// not regress: the deferred event is found in a RECEIPT (the vault runs one hop away from
// the wallet's transaction), and a log we cannot read never throws.

function eventLog(event: string, data: Record<string, unknown>): string {
  return `EVENT_JSON:${JSON.stringify({
    standard: "intentfolio-vault",
    version: "1.0.0",
    event,
    data: [data],
  })}`;
}

const DEFERRED_DATA = {
  account_id: "denance02.near",
  portfolio_id: "p_000000000000",
  token: "nep141:usdt.tether-token.near",
  qty_requested: "1000000",
  qty_available: "1000000",
  next_release_at: 1_800_000_300,
  reason: "maturity",
};

function outcomeWithReceiptLogs(logs: string[]): unknown {
  return {
    transaction_outcome: { outcome: { logs: [] } },
    receipts_outcome: [
      { outcome: { logs: [], status: { SuccessReceiptId: "r" } } },
      { outcome: { logs, status: { SuccessValue: "" } } },
    ],
  };
}

describe("collectLogs", () => {
  it("reads both the transaction outcome and every receipt", () => {
    const logs = collectLogs({
      transaction_outcome: { outcome: { logs: ["tx"] } },
      receipts_outcome: [
        { outcome: { logs: ["r1"], status: { SuccessReceiptId: "r" } } },
        { outcome: { logs: ["r2"], status: { SuccessValue: "" } } },
      ],
    });
    expect(logs).toEqual(["tx", "r1", "r2"]);
  });

  // D-324: a panicking receipt keeps the logs it wrote before the panic, but its state rolled
  // back — an event read from it reports something that never happened.
  it("skips the logs of a FAILED receipt, and of one whose status is unknown", () => {
    const outcome = {
      receipts_outcome: [
        {
          outcome: {
            logs: [eventLog("pending_unallocation_opened", { commit_id: "c1" })],
            status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "E_LEDGER_ARITHMETIC" } } } } },
          },
        },
        { outcome: { logs: ["no status"] } },
        { outcome: { logs: ["ok"], status: { SuccessValue: "" } } },
      ],
    };
    expect(collectLogs(outcome)).toEqual(["ok"]);
    expect(hasPendingUnallocation(outcome)).toBe(false);
  });

  it("tolerates an outcome shape it does not recognise", () => {
    expect(collectLogs(null)).toEqual([]);
    expect(collectLogs({ receipts_outcome: [{}] })).toEqual([]);
    expect(collectLogs({ transaction_outcome: { outcome: { logs: "nope" } } })).toEqual([]);
  });
});

describe("parseVaultEvents", () => {
  it("skips foreign standards and unparseable lines", () => {
    const events = parseVaultEvents(
      outcomeWithReceiptLogs([
        "EVENT_JSON:{not json",
        `EVENT_JSON:${JSON.stringify({ standard: "nep141", event: "ft_transfer", data: [{}] })}`,
        "a plain log line",
        eventLog("unallocate", { portfolio_id: "p_000000000000" }),
      ])
    );
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("unallocate");
  });
});

describe("findUnallocateDeferred", () => {
  it("finds the defer emitted in a receipt and reads the contract's own deadline", () => {
    const deferred = findUnallocateDeferred(
      outcomeWithReceiptLogs([eventLog("unallocate_deferred", DEFERRED_DATA)])
    );
    expect(deferred).toEqual({
      portfolioId: "p_000000000000",
      token: "nep141:usdt.tether-token.near",
      nextReleaseAt: 1_800_000_300,
      reason: "maturity",
    });
  });

  it("accepts a stringified u64, in case serde changes upstream", () => {
    const deferred = findUnallocateDeferred(
      outcomeWithReceiptLogs([
        eventLog("unallocate_deferred", { ...DEFERRED_DATA, next_release_at: "1800000300" }),
      ])
    );
    expect(deferred?.nextReleaseAt).toBe(1_800_000_300);
  });

  it("returns null when the deadline is unreadable rather than inventing one", () => {
    const deferred = findUnallocateDeferred(
      outcomeWithReceiptLogs([
        eventLog("unallocate_deferred", { ...DEFERRED_DATA, next_release_at: null }),
      ])
    );
    expect(deferred).toBeNull();
  });

  it("returns null for a settled commit", () => {
    expect(
      findUnallocateDeferred(
        outcomeWithReceiptLogs([
          eventLog("pending_unallocation_opened", { commit_id: "c1" }),
          eventLog("unallocate", { qty: "1000000" }),
        ])
      )
    ).toBeNull();
  });
});

describe("hasPendingUnallocation / findUnallocateFailure", () => {
  it("detects an accepted withdrawal", () => {
    expect(
      hasPendingUnallocation(
        outcomeWithReceiptLogs([eventLog("pending_unallocation_opened", { commit_id: "c1" })])
      )
    ).toBe(true);
  });

  it("surfaces the reason a batch transfer reverted", () => {
    expect(
      findUnallocateFailure(
        outcomeWithReceiptLogs([
          eventLog("unallocate_failed", { commit_id: "c1", reason: "mt_batch_transfer reverted" }),
        ])
      )
    ).toBe("mt_batch_transfer reverted");
  });

  it("reports no failure on a clean settle", () => {
    expect(findUnallocateFailure(outcomeWithReceiptLogs([eventLog("unallocate", {})]))).toBeNull();
  });
});

describe("findExecutionFailure", () => {
  // A panic emits NO vault event, so the status is the only thing that carries it.
  const panic = (message: string) => ({
    ActionError: {
      index: 0,
      kind: { FunctionCallError: { ExecutionError: message } },
    },
  });

  it("extracts the panic message from a reverted transaction", () => {
    expect(
      findExecutionFailure({ status: { Failure: panic("Smart contract panicked: E_NONCE_CONSUMED") } })
    ).toBe("Smart contract panicked: E_NONCE_CONSUMED");
  });

  it("finds a revert that only shows up in the receipt that ran the vault", () => {
    expect(
      findExecutionFailure({
        status: { SuccessValue: "" },
        receipts_outcome: [
          { outcome: { status: { SuccessValue: "" } } },
          { outcome: { status: { Failure: panic("E_NOT_PORTFOLIO_OWNER") } } },
        ],
      })
    ).toBe("E_NOT_PORTFOLIO_OWNER");
  });

  it("falls back to the raw failure when the shape is unfamiliar", () => {
    expect(findExecutionFailure({ status: { Failure: { Weird: 1 } } })).toBe('{"Weird":1}');
  });

  it("returns null for a successful transaction — including a DEFERRED one", () => {
    expect(findExecutionFailure({ status: { SuccessValue: "" } })).toBeNull();
    expect(
      findExecutionFailure({
        status: { SuccessValue: "" },
        receipts_outcome: [
          {
            outcome: {
              status: { SuccessValue: "" },
              logs: [eventLog("unallocate_deferred", DEFERRED_DATA)],
            },
          },
        ],
      })
    ).toBeNull();
  });

  it("tolerates an outcome with no status at all", () => {
    expect(findExecutionFailure(null)).toBeNull();
    expect(findExecutionFailure({})).toBeNull();
  });
});

// FE #5 (`922` §8 #15). The Allocate payload is `[Transfer, AuthCall → on_auth]`: the
// Transfer settles inside the `execute_intents` receipt (whose status is the tx's top-level
// status) and `on_auth` runs in a separate receipt executed BY THE VAULT. A failure in that
// second receipt is the orphan, not a revert — and the old reader wrote it off as `failed`,
// which took it off the rescue worklist. Seen twice in the wet test. The shapes below are
// the ones the chain produced (`WebAssembly trap: An \`unreachable\` opcode was executed.`).
describe("classifyAllocateOutcome", () => {
  const VAULT = "intentfolio-staging.near";
  const panic = (message: string) => ({
    ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: message } } },
  });
  const ok = { SuccessValue: "" };
  const receipt = (executor_id: string, status: unknown) => ({ outcome: { executor_id, status } });

  it("REGRESSION: top-level success + the vault's receipt failed ⇒ vault_failed, never reverted", () => {
    const trap = "WebAssembly trap: An `unreachable` opcode was executed.";
    expect(
      classifyAllocateOutcome(
        {
          status: ok,
          receipts_outcome: [receipt("intents.near", ok), receipt(VAULT, { Failure: panic(trap) })],
        },
        VAULT
      )
    ).toEqual({ kind: "vault_failed", error: trap, byVault: true });
  });

  it("a top-level Failure is a revert whatever the receipts say — execute_intents rolled back", () => {
    // A failed VAULT receipt under it too, so this pins the precedence of the top-level
    // status and not just the fallback for a foreign executor.
    expect(
      classifyAllocateOutcome(
        {
          status: { Failure: panic("E_BAD_SALT") },
          receipts_outcome: [
            receipt("intents.near", { Failure: panic("E_BAD_SALT") }),
            receipt(VAULT, { Failure: panic("trap") }),
          ],
        },
        VAULT
      )
    ).toEqual({ kind: "reverted", error: "E_BAD_SALT" });
  });

  it("a failed receipt under a successful top-level status is post-Transfer even without an executor_id", () => {
    // The Transfer settled in the receipt that produced the top-level success; whoever
    // failed after it, the funds are in the vault and the record belongs on the worklist.
    expect(
      classifyAllocateOutcome(
        { status: ok, receipts_outcome: [{ outcome: { status: { Failure: panic("E_ON_AUTH") } } }] },
        VAULT
      )
    ).toEqual({ kind: "vault_failed", error: "E_ON_AUTH", byVault: false });
  });

  it("the vault's executor_id decides when the top-level status is missing", () => {
    const trimmed = (executor: string) => ({
      receipts_outcome: [receipt(executor, { Failure: panic("boom") })],
    });
    expect(classifyAllocateOutcome(trimmed(VAULT), VAULT)).toEqual({ kind: "vault_failed", error: "boom", byVault: true });
    // A foreign failure with no proof either way is NOT a revert on a guess: only a top-level
    // Failure may take a record off the worklist. The poll decides.
    expect(classifyAllocateOutcome(trimmed("intents.near"), VAULT)).toEqual({
      kind: "undecided",
      error: "boom",
    });
    expect(classifyAllocateOutcome({ receipts_outcome: [{ outcome: { status: { Failure: panic("boom") } } }] }, VAULT))
      .toEqual({ kind: "undecided", error: "boom" });
  });

  it("prefers the vault's failure over a foreign one when both are present", () => {
    expect(
      classifyAllocateOutcome(
        {
          status: ok,
          receipts_outcome: [
            receipt("someone.near", { Failure: panic("first") }),
            receipt(VAULT, { Failure: panic("vault") }),
          ],
        },
        VAULT
      )
    ).toEqual({ kind: "vault_failed", error: "vault", byVault: true });
  });

  it("reports executed when nothing failed — including an empty or missing outcome", () => {
    expect(
      classifyAllocateOutcome({ status: ok, receipts_outcome: [receipt("intents.near", ok), receipt(VAULT, ok)] }, VAULT)
    ).toEqual({ kind: "executed" });
    expect(classifyAllocateOutcome(null, VAULT)).toEqual({ kind: "executed" });
    expect(classifyAllocateOutcome({}, VAULT)).toEqual({ kind: "executed" });
  });

  it("falls back to the raw failure when the shape is unfamiliar", () => {
    expect(classifyAllocateOutcome({ status: { Failure: { Weird: 1 } } }, VAULT)).toEqual({
      kind: "reverted",
      error: '{"Weird":1}',
    });
  });
});
