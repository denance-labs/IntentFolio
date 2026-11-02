// @vitest-environment node
// The rescue-verdict read (D-448): validation, the query's parameters and the 005 reader's rule.
// Against a stub; the SQL and the grants are proven by `ops-records-db.integration.test.ts`.

import { describe, expect, it } from "vitest";
import type { Queryable } from "./ops-records-service";
import {
  ALLOCATE_VERDICTS_SQL,
  foldVerdicts,
  handleAllocateVerdicts,
  validateVerdictIds,
} from "./allocate-verdicts-service";
import { ALLOCATE_VERDICT_IDS_MAX } from "./ops-records-types";

const A = "6f1c2a0e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
const B = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const allow = { check: () => true };

function stub(result: Array<{ record_id: unknown; verdict: unknown }> | Error) {
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
  handleAllocateVerdicts({ body, callerKey: "k", db, limiter });

describe("validateVerdictIds", () => {
  it("lower-cases and de-duplicates", () => {
    expect(validateVerdictIds({ ids: [A.toUpperCase(), A, B] })).toEqual({ ok: true, ids: [A, B] });
  });

  it.each([
    ["no body", null],
    ["no ids", {}],
    ["an empty list", { ids: [] }],
    ["too many ids", { ids: Array.from({ length: ALLOCATE_VERDICT_IDS_MAX + 1 }, () => A) }],
    ["a non-uuid", { ids: [A, "p_000000000001"] }],
    ["a number", { ids: [1] }],
  ])("refuses %s", (_why, body) => {
    expect(validateVerdictIds(body).ok).toBe(false);
  });
});

describe("foldVerdicts — the reader's rule in 005", () => {
  it("credited wins over a negative, in either order", () => {
    expect(
      foldVerdicts([
        { record_id: A, verdict: "orphan_escalated" },
        { record_id: A, verdict: "credited" },
        { record_id: B, verdict: "credited" },
        { record_id: B, verdict: "never_executed" },
      ])
    ).toEqual({ [A]: "credited", [B]: "credited" });
  });

  it("keeps a single negative as it is", () => {
    expect(foldVerdicts([{ record_id: A, verdict: "never_executed" }])).toEqual({ [A]: "never_executed" });
    expect(foldVerdicts([{ record_id: A, verdict: "orphan_escalated" }])).toEqual({ [A]: "orphan_escalated" });
  });

  it("prefers the verdict that keeps the record on screen if two negatives ever appear", () => {
    expect(
      foldVerdicts([
        { record_id: A, verdict: "never_executed" },
        { record_id: A, verdict: "orphan_escalated" },
      ])
    ).toEqual({ [A]: "orphan_escalated" });
  });

  it("drops a verdict it does not know — read as not decided yet", () => {
    expect(foldVerdicts([{ record_id: A, verdict: "returned" }, { record_id: 7, verdict: "credited" }])).toEqual({});
  });
});

describe("handleAllocateVerdicts", () => {
  it("asks for the given ids only, verdict and id only", async () => {
    const { db, calls } = stub([]);
    await run(db, { ids: [A, B] });
    expect(calls).toEqual([{ text: ALLOCATE_VERDICTS_SQL, values: [[A, B]] }]);
    // `detail` and `decided_at` are the solver role's free text: never selected, never sent.
    expect(ALLOCATE_VERDICTS_SQL).not.toMatch(/detail|decided_at|\*/);
  });

  it("answers the folded verdicts", async () => {
    const { db } = stub([
      { record_id: A, verdict: "never_executed" },
      { record_id: A, verdict: "credited" },
    ]);
    expect((await run(db, { ids: [A, B] })).body).toEqual({ ok: true, verdicts: { [A]: "credited" } });
  });

  it("400 on a bad body, without touching the database", async () => {
    const { db, calls } = stub([]);
    expect((await run(db, { ids: ["nope"] })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("429 when the caller is over its budget, without touching the database", async () => {
    const { db, calls } = stub([]);
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
