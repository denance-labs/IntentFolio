// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { Queryable } from "@/features/vault/lib/ops-records-service";
import type { RelayResponseBody } from "@/features/vault/lib/relay-types";
import { noteRelayedTxHash, relayedTxHash } from "./withdraw-relay-tx-hash";

const SIGNER = "alice.near";
const NONCE = Buffer.alloc(32, 7).toString("base64");
const TX = "8sQacxtuTx";

const payload = {
  standard: "nep413",
  payload: { message: JSON.stringify({ signer_id: SIGNER, intents: [] }), nonce: NONCE, recipient: "intents.near" },
  signature: "ed25519:x",
};

function executed(opts: { status?: unknown; nonce?: string; tail?: unknown } = {}): RelayResponseBody {
  const event = {
    standard: "dip4",
    event: "intents_executed",
    data: [{ intent_hash: "HASH", account_id: SIGNER, nonce: opts.nonce ?? NONCE }],
  };
  const reverted = opts.status !== undefined;
  return {
    ok: true,
    txHash: TX,
    gasBurntNear: "0.001",
    outcome: {
      // The final status follows the last promise: a failing tail reads as a Failure here.
      status: opts.tail ?? opts.status ?? { SuccessValue: "" },
      transaction_outcome: { id: TX, outcome: { receipt_ids: ["R1"] } },
      receipts_outcome: [
        {
          id: "R1",
          outcome: {
            executor_id: "intents.near",
            status: opts.status ?? { SuccessValue: "" },
            logs: reverted ? [] : [`EVENT_JSON:${JSON.stringify(event)}`],
          },
        },
        ...(opts.tail ? [{ id: "R2", outcome: { executor_id: "usdt.tether-token.near", status: opts.tail, logs: [] } }] : []),
      ],
    },
  };
}

const unknownOutcome: RelayResponseBody = { ok: false, code: "unknown-outcome", error: "cut off", txHash: TX };
const FAILURE = { Failure: { ActionError: {} } };

function run(response: RelayResponseBody, rowCount: number | Error = 1) {
  const query = vi.fn(async () => {
    if (rowCount instanceof Error) throw rowCount;
    return { rows: [], rowCount };
  });
  const log = vi.fn<(message: string) => void>();
  const resolveDb = vi.fn(() => ({ ok: true as const, db: { query } as unknown as Queryable }));
  return { query, log, resolveDb, done: noteRelayedTxHash({ payload, response, resolveDb, log }) };
}

describe("relayedTxHash — what is worth noting (D-593)", () => {
  it("is proved when the Verifier's event names this signer and nonce", () => {
    expect(relayedTxHash(payload, executed())).toEqual({ signerId: SIGNER, nonce: NONCE, txHash: TX, proved: true });
  });

  it("is proved when execute_intents ran and a LATER receipt failed: the case the solver needs most", () => {
    expect(relayedTxHash(payload, executed({ tail: FAILURE }))).toMatchObject({ txHash: TX, proved: true });
  });

  it("is nothing when execute_intents reverted, or ran somebody else's nonce", () => {
    expect(relayedTxHash(payload, executed({ status: FAILURE }))).toBeNull();
    expect(relayedTxHash(payload, executed({ nonce: Buffer.alloc(32, 1).toString("base64") }))).toBeNull();
  });

  it("is an unproved candidate on unknown-outcome, and nothing on any other refusal", () => {
    expect(relayedTxHash(payload, unknownOutcome)).toEqual({ signerId: SIGNER, nonce: NONCE, txHash: TX, proved: false });
    for (const code of ["would-fail", "check-failed", "send-failed", "paused", "cap-exceeded"] as const) {
      expect(relayedTxHash(payload, { ok: false, code, error: "x" }), code).toBeNull();
    }
  });

  it("is nothing without a hash or with an unreadable envelope", () => {
    expect(relayedTxHash(payload, { ...executed(), txHash: null } as RelayResponseBody)).toBeNull();
    expect(relayedTxHash(null, unknownOutcome)).toBeNull();
    expect(relayedTxHash({ standard: "nep413" }, unknownOutcome)).toBeNull();
  });

  it("keeps the signer and nonce exactly as signed, whatever the family", () => {
    const text = JSON.stringify({ signer_id: "0xAbC", nonce: NONCE });
    const asSigned = { signerId: "0xAbC", nonce: NONCE };
    expect(relayedTxHash({ standard: "erc191", payload: text }, unknownOutcome)).toMatchObject(asSigned);
    expect(relayedTxHash({ standard: "ton_connect", payload: { type: "text", text } }, unknownOutcome)).toMatchObject(asSigned);
  });
});

describe("noteRelayedTxHash", () => {
  it("replaces another hash when proved", async () => {
    const { done, query, log } = run(executed());
    await done;
    const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/SET tx_hash = \$3 WHERE signer_id = \$1 AND nonce = \$2 AND tx_hash IS DISTINCT FROM \$3$/);
    expect(values).toEqual([SIGNER, NONCE, TX]);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("fills only an empty column on unknown-outcome", async () => {
    const { done, query } = run(unknownOutcome);
    await done;
    expect((query.mock.calls[0] as unknown as [string])[0]).toMatch(/AND tx_hash IS NULL$/);
  });

  it("touches no database when there is nothing to note", async () => {
    const { done, resolveDb } = run({ ok: false, code: "would-fail", error: "x" });
    await done;
    expect(resolveDb).not.toHaveBeenCalled();
  });

  it("is silent when no row matches: an Allocate has none", async () => {
    const { done, log } = run(executed(), 0);
    await done;
    expect(log).not.toHaveBeenCalled();
  });

  it("only logs when the database is down, without the signer or the nonce", async () => {
    const { done, log } = run(executed(), new Error("connect ECONNREFUSED"));
    await expect(done).resolves.toBeUndefined();
    expect(log.mock.calls[0][0]).toContain("ECONNREFUSED");
    expect(log.mock.calls[0][0]).not.toContain(SIGNER);
    expect(log.mock.calls[0][0]).not.toContain(NONCE);
  });

  it("only logs when the database is not configured, or resolving it throws", async () => {
    const log = vi.fn<(message: string) => void>();
    await noteRelayedTxHash({ payload, response: executed(), log, resolveDb: () => ({ ok: false, issues: ["missing URL"] }) });
    expect(log.mock.calls[0][0]).toContain("missing URL");
    await expect(
      noteRelayedTxHash({
        payload,
        response: executed(),
        log,
        resolveDb: () => {
          throw new Error("bad pool");
        },
      })
    ).resolves.toBeUndefined();
    expect(log.mock.calls[1][0]).toContain("bad pool");
  });
});
