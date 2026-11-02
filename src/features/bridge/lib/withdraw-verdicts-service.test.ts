// @vitest-environment node
// The withdrawal-verdict read (024-D): what is selected, what is answered, and the failures.
// Against a stub, as the Allocate read's tests are.

import { describe, expect, it } from "vitest";
import type { Queryable } from "@/features/vault/lib/ops-records-service";
import { handleWithdrawVerdicts, toAnswers, WITHDRAW_VERDICTS_SQL } from "./withdraw-verdicts-service";

const A = "6f1c2a0e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
const B = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const NEAR_TX = "9xKcXGhT2qWvbnLmRtYpZsAeDfGhJkLmNoPqRsTuVwXy";
const DEST_TX = "0x5a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9";
const allow = { check: () => true };

function stub(result: Array<Record<string, unknown>> | Error) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const db: Queryable = {
    async query<R>(text: string, values?: unknown[]) {
      calls.push({ text, values: values ?? [] });
      if (result instanceof Error) throw result;
      return { rows: result as R[], rowCount: result.length };
    },
  };
  return { db, calls };
}

const run = (db: Queryable, body: unknown, limiter = allow) =>
  handleWithdrawVerdicts({ body, callerKey: "k", db, limiter });

describe("WITHDRAW_VERDICTS_SQL", () => {
  it("reads the final verdicts and the two hashes only — nothing of the record", () => {
    expect(WITHDRAW_VERDICTS_SQL).toMatch(/FROM withdraw_verdict\b/);
    expect(WITHDRAW_VERDICTS_SQL).not.toMatch(/withdraw_record|\*|decided_at|signer|destination_address|amount/);
    expect(WITHDRAW_VERDICTS_SQL).toMatch(/'delivered', 'refunded', 'never_executed'/);
  });
});

describe("toAnswers", () => {
  it("answers the verdict with the hashes it names", () => {
    expect(
      toAnswers([
        { record_id: A.toUpperCase(), verdict: "delivered", tx: NEAR_TX, destination_tx: DEST_TX },
        { record_id: B, verdict: "never_executed", tx: null, destination_tx: null },
      ])
    ).toEqual({
      [A]: { verdict: "delivered", txHash: NEAR_TX, destinationTxHash: DEST_TX },
      [B]: { verdict: "never_executed" },
    });
  });

  it("drops a hash that does not look like one, and a verdict it does not know", () => {
    expect(
      toAnswers([
        { record_id: A, verdict: "delivered", tx: "<script>", destination_tx: "https://evil.example/tx" },
        { record_id: B, verdict: "escalated_e1", tx: NEAR_TX, destination_tx: null },
        { record_id: 7, verdict: "delivered", tx: null, destination_tx: null },
      ])
    ).toEqual({ [A]: { verdict: "delivered" } });
  });
});

describe("handleWithdrawVerdicts", () => {
  it("asks for the given ids, lower-cased and de-duplicated", async () => {
    const { db, calls } = stub([]);
    await run(db, { ids: [A.toUpperCase(), A, B] });
    expect(calls).toEqual([{ text: WITHDRAW_VERDICTS_SQL, values: [[A, B]] }]);
  });

  it("answers the verdicts", async () => {
    const { db } = stub([{ record_id: A, verdict: "refunded", tx: NEAR_TX, destination_tx: null }]);
    expect((await run(db, { ids: [A, B] })).body).toEqual({
      ok: true,
      verdicts: { [A]: { verdict: "refunded", txHash: NEAR_TX } },
    });
  });

  it("400 on a bad body and 429 over budget, without touching the database", async () => {
    const { db, calls } = stub([]);
    expect((await run(db, { ids: ["nope"] })).status).toBe(400);
    expect((await run(db, { ids: [A] }, { check: () => false })).status).toBe(429);
    expect(calls).toHaveLength(0);
  });

  it("502 when the read fails", async () => {
    const { db } = stub(new Error("connection reset"));
    const res = await run(db, { ids: [A] });
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ ok: false, code: "read-failed" });
  });
});
