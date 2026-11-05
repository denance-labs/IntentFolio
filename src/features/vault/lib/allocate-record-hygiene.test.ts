import { describe, it, expect, vi } from "vitest";
import {
  reconcileSuspectedOrphans,
  FAILED_CANDIDATE_MAX_AGE_MS,
  type ReconcileDeps,
} from "./allocate-record-hygiene";
import type { AllocateRescueRecord } from "./allocate-rescue-store";
import type { SealRead } from "./allocate-seal";

// The sweep is the one place that decides which record gets flipped. The dangerous direction
// is a `confirm` for a record whose seal is not on chain, so every test below pins WHICH ids
// reach `confirm`, not just how many.

function record(over: Partial<AllocateRescueRecord> & { id: string }): AllocateRescueRecord {
  return {
    signerId: "alice.near",
    msg: `{"nonce":"${over.id}"}`,
    vaultId: "intentfolio-staging.near",
    portfolioName: "Balanced",
    legs: [{ tokenId: "nep141:wrap.near", amount: "1" }],
    createdAt: 1_760_000_000_000,
    status: "suspected_orphan",
    ...over,
  };
}

const sealed: SealRead = { kind: "sealed", deadlineSecs: 1_788_466_431 };
const unsealed: SealRead = { kind: "unsealed" };

function deps(
  records: AllocateRescueRecord[],
  seals: Record<string, SealRead | Error>,
  confirmResult: (id: string) => boolean = () => true
) {
  const confirm = vi.fn(async (id: string) => confirmResult(id));
  const readSeal = vi.fn(async (_signer: string, msg: string) => {
    const id = JSON.parse(msg).nonce as string;
    const seal = seals[id];
    if (seal instanceof Error) throw seal;
    return seal ?? unsealed;
  });
  const log = vi.fn();
  // No record in these fixtures carries a V1 nonce, so the never-executed proof never holds
  // here; the D-295 flip has its own suite below.
  const readNonceWitness = vi.fn(async () => ({ nonceUsed: false, saltValid: true, blockTimestampMs: 0 }));
  const markNeverExecuted = vi.fn<(id: string) => Promise<boolean>>(async () => true);
  // An hour after the fixture's `createdAt`: well inside the `failed` candidate horizon.
  const d: ReconcileDeps = {
    records: () => records,
    readSeal,
    confirm,
    readNonceWitness,
    markNeverExecuted,
    log,
    now: () => 1_760_000_000_000 + 3_600_000,
  };
  return { d, confirm, readSeal, log, markNeverExecuted };
}

describe("reconcileSuspectedOrphans", () => {
  it("confirms a sealed suspected_orphan and a sealed sent record, and nothing else", async () => {
    // The envelope is written before the submit, so a real `submitted` / `credited` always
    // carries one. Since 026 A0 a sealed `submitted` is confirmed too: the tab that should have
    // seen the credit closed, and the seal may be purged once the AuthCall deadline passes.
    const envelope = { standard: "nep413", payload: {} };
    const { d, confirm, readSeal } = deps(
      [
        record({ id: "signing", status: "signing" }),
        record({ id: "submitted", status: "submitted", signedEnvelope: envelope }),
        record({ id: "orphan", status: "suspected_orphan", signedEnvelope: envelope }),
        record({ id: "credited", status: "credited", signedEnvelope: envelope }),
        // A `failed` WITHOUT an envelope was never sent (declined signature, lost record
        // write): nothing to check, whatever the seal says.
        record({ id: "failed", status: "failed" }),
      ],
      // Every one of them sealed on chain. `signing` has no envelope (never sent), `credited`
      // is done, `failed` without an envelope never left: none of them is read.
      { signing: sealed, submitted: sealed, orphan: sealed, credited: sealed, failed: sealed }
    );
    const summary = await reconcileSuspectedOrphans(d);

    // Two seal reads: the orphan, and the enveloped `submitted` as a sent candidate.
    expect(readSeal).toHaveBeenCalledTimes(2);
    expect(confirm.mock.calls.map(([id]) => id)).toEqual(["orphan", "submitted"]);
    expect(summary).toEqual({
      candidates: 1,
      flipped: 1,
      unsealed: 0,
      unreadable: 0,
      failed: 0,
      sentCandidates: 1,
      sentCredited: 1,
      neverExecuted: 0,
      verdicts: 0,
      verdictCredited: 0,
      verdictNeverExecuted: 0,
    });
  });

  it("confirms a sealed record, and only that one", async () => {
    const { d, confirm } = deps([record({ id: "a" }), record({ id: "b" })], { a: sealed });
    const summary = await reconcileSuspectedOrphans(d);
    expect(confirm.mock.calls.map(([id]) => id)).toEqual(["a"]);
    expect(summary).toMatchObject({ candidates: 2, flipped: 1, unsealed: 1 });
  });

  it("never calls confirm for an unsealed record", async () => {
    const { d, confirm } = deps([record({ id: "a" })], { a: unsealed });
    await reconcileSuspectedOrphans(d);
    expect(confirm).not.toHaveBeenCalled();
  });

  // Two Setups with the same name, legs and composition, of which only one was credited. The
  // seal is per msg (the nonce differs), so exactly the credited one flips — this is the case
  // a balance-based check could not decide and the reason the seal is the criterion.
  it("tells twins apart: same name and legs, sealed only the second — flips only the second", async () => {
    const twinA = record({ id: "twin-a", portfolioName: "Same", createdAt: 1 });
    const twinB = record({ id: "twin-b", portfolioName: "Same", createdAt: 2 });
    const { d, confirm } = deps([twinA, twinB], { "twin-b": sealed });
    await reconcileSuspectedOrphans(d);
    expect(confirm.mock.calls.map(([id]) => id)).toEqual(["twin-b"]);
  });

  // Mutation 7 (`allSettled` → `all`, or dropping the await) dies here: the throwing read
  // must neither stop the sealed one nor escape the sweep.
  it("keeps going when one seal read throws, and counts it unreadable", async () => {
    const { d, confirm } = deps(
      [record({ id: "boom" }), record({ id: "ok" })],
      { boom: new Error("RPC down"), ok: sealed }
    );
    const summary = await reconcileSuspectedOrphans(d);
    expect(confirm.mock.calls.map(([id]) => id)).toEqual(["ok"]);
    expect(summary).toEqual({
      candidates: 2,
      flipped: 1,
      unsealed: 0,
      unreadable: 1,
      failed: 0,
      sentCandidates: 0,
      sentCredited: 0,
      neverExecuted: 0,
      verdicts: 0,
      verdictCredited: 0,
      verdictNeverExecuted: 0,
    });
  });

  it("counts an unreadable seal without confirming it", async () => {
    const { d, confirm } = deps([record({ id: "a" })], {
      a: { kind: "unreadable", reason: "2 entries under one exact key" },
    });
    const summary = await reconcileSuspectedOrphans(d);
    expect(confirm).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ unreadable: 1, flipped: 0 });
  });

  it("counts a confirm that returns false as failed, without throwing", async () => {
    const { d } = deps([record({ id: "a" })], { a: sealed }, () => false);
    await expect(reconcileSuspectedOrphans(d)).resolves.toMatchObject({ failed: 1, flipped: 0 });
  });

  it("does nothing on an empty store — zero seal reads, zero confirms", async () => {
    const { d, readSeal, confirm, log } = deps([], {});
    await expect(reconcileSuspectedOrphans(d)).resolves.toEqual({
      candidates: 0,
      flipped: 0,
      unsealed: 0,
      unreadable: 0,
      failed: 0,
      sentCandidates: 0,
      sentCredited: 0,
      neverExecuted: 0,
      verdicts: 0,
      verdictCredited: 0,
      verdictNeverExecuted: 0,
    });
    expect(readSeal).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("logs counts only — never an id, a signer or an amount (ADR-0017 §8)", async () => {
    const { d, log } = deps([record({ id: "a" })], { a: sealed });
    await reconcileSuspectedOrphans(d);
    const line = log.mock.calls[0][0] as string;
    expect(line).toMatch(/1 candidate\(s\) checked/);
    expect(line).not.toContain("alice.near");
    expect(line).not.toContain('"a"');
  });
});

// FE #5 (`922` §8 #15). Before FE #5 the submit wrote `failed` for an Allocate whose Transfer
// had settled and whose `on_auth` had failed — the orphan itself. Those rows were rescued by
// hand and would otherwise stay `failed` here forever. The signed envelope is what marks a
// `failed` as "may have reached the chain"; the seal is what proves it was credited.
describe("reconcileSuspectedOrphans — failed rows with a signed envelope (FE #5)", () => {
  const envelope = { standard: "nep413", payload: {}, public_key: "ed25519:x", signature: "ed25519:y" };

  it("flips a failed record with an envelope whose seal is on chain", async () => {
    const { d, confirm } = deps(
      [record({ id: "old-orphan", status: "failed", signedEnvelope: envelope, error: "trap" })],
      { "old-orphan": sealed }
    );
    const summary = await reconcileSuspectedOrphans(d);
    expect(confirm.mock.calls.map(([id]) => id)).toEqual(["old-orphan"]);
    expect(summary).toMatchObject({ candidates: 1, flipped: 1 });
  });

  it("leaves a failed record with an envelope but no seal alone — a real revert", async () => {
    const { d, confirm, readSeal } = deps(
      [record({ id: "revert", status: "failed", signedEnvelope: envelope, error: "E_BAD_SALT" })],
      { revert: unsealed }
    );
    const summary = await reconcileSuspectedOrphans(d);
    expect(readSeal).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ candidates: 1, flipped: 0, unsealed: 1 });
  });

  it("stops checking a failed record once it is older than the rescue horizon", async () => {
    const createdAt = 1_760_000_000_000;
    const records = [record({ id: "stale", status: "failed", signedEnvelope: envelope, createdAt })];
    const fresh = deps(records, { stale: sealed });
    fresh.d.now = () => createdAt + FAILED_CANDIDATE_MAX_AGE_MS;
    expect((await reconcileSuspectedOrphans(fresh.d)).candidates).toBe(1);

    const old = deps(records, { stale: sealed });
    old.d.now = () => createdAt + FAILED_CANDIDATE_MAX_AGE_MS + 1;
    expect((await reconcileSuspectedOrphans(old.d)).candidates).toBe(0);
    expect(old.readSeal).not.toHaveBeenCalled();
  });

  it("never ages out a suspected_orphan — that state has no other exit", async () => {
    const createdAt = 1_700_000_000_000;
    const { d, confirm } = deps([record({ id: "orphan", status: "suspected_orphan", createdAt })], { orphan: sealed });
    d.now = () => createdAt + 10 * FAILED_CANDIDATE_MAX_AGE_MS;
    await reconcileSuspectedOrphans(d);
    expect(confirm.mock.calls.map(([id]) => id)).toEqual(["orphan"]);
  });

  it("does not read the seal of a failed record without an envelope", async () => {
    const { d, confirm, readSeal } = deps(
      [record({ id: "declined", status: "failed", error: "User rejected" })],
      { declined: sealed }
    );
    const summary = await reconcileSuspectedOrphans(d);
    expect(readSeal).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(summary.candidates).toBe(0);
  });
});

// D-295, on the real case: the canary `pablofork.near` left at `submitted` on 2026-09-20, from
// before D-312 (no `verifierNonce` field — the nonce and deadline are read from the envelope).
// Verified on chain on 2026-09-24: salt `252812b3` valid, nonce unused, nonce deadline
// 2026-09-30T23:24:46Z. The dangerous direction is a `failed` for an Allocate that DID run, so
// every guard below is pinned by the id that reaches `markNeverExecuted`.
describe("reconcileSuspectedOrphans — a sent record whose envelope never executed (D-295)", () => {
  const CANARY_NONCE = "Vij2xgAlKBKzAOwAr9Q82hgtbidRbTLp9YQUvUnPUdg=";
  const canaryEnvelope = {
    standard: "nep413",
    payload: {
      message: JSON.stringify({ signer_id: "pablofork.near", deadline: "2026-09-20T23:34:46.000Z", intents: [] }),
      nonce: CANARY_NONCE,
      recipient: "intents.near",
    },
    public_key: "ed25519:x",
    signature: "ed25519:y",
  };
  const ENVELOPE_DEADLINE_MS = Date.parse("2026-09-20T23:34:46.000Z");
  const NONCE_DEADLINE_MS = Date.parse("2026-09-30T23:24:46.000Z");
  const TODAY = Date.parse("2026-09-24T12:00:00.000Z");

  function canary(over: Partial<AllocateRescueRecord> = {}): AllocateRescueRecord {
    return record({
      id: "canary",
      signerId: "pablofork.near",
      status: "submitted",
      createdAt: Date.parse("2026-09-20T23:24:46.353Z"),
      signedEnvelope: canaryEnvelope,
      ...over,
    });
  }

  function sentDeps(
    records: AllocateRescueRecord[],
    opts: {
      seal?: SealRead | Error;
      witness?: { nonceUsed: boolean; saltValid: boolean; blockTimestampMs?: number } | Error;
      now?: number;
      mark?: boolean;
    } = {}
  ) {
    const readSeal = vi.fn(async () => {
      if (opts.seal instanceof Error) throw opts.seal;
      return opts.seal ?? unsealed;
    });
    const readNonceWitness = vi.fn(async () => {
      if (opts.witness instanceof Error) throw opts.witness;
      // The node is up to date unless a case says otherwise: its block carries this clock.
      return { nonceUsed: false, saltValid: true, blockTimestampMs: opts.now ?? TODAY, ...opts.witness };
    });
    const markNeverExecuted = vi.fn<(id: string) => Promise<boolean>>(async () => opts.mark ?? true);
    const confirm = vi.fn<(id: string) => Promise<boolean>>(async () => true);
    const d: ReconcileDeps = {
      records: () => records,
      readSeal,
      confirm,
      readNonceWitness,
      markNeverExecuted,
      log: vi.fn(),
      now: () => opts.now ?? TODAY,
    };
    return { d, readSeal, readNonceWitness, markNeverExecuted, confirm };
  }

  it("flips the real canary to failed, witnessing its own nonce and salt", async () => {
    const { d, readNonceWitness, markNeverExecuted, confirm } = sentDeps([canary()]);
    const summary = await reconcileSuspectedOrphans(d);

    expect(readNonceWitness).toHaveBeenCalledWith("pablofork.near", CANARY_NONCE, "252812b3");
    expect(markNeverExecuted.mock.calls.map(([id]) => id)).toEqual(["canary"]);
    expect(confirm).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ sentCandidates: 1, neverExecuted: 1 });
  });

  it("flips a `signing` record with an envelope too — signed, then the tab died before sending", async () => {
    const { d, markNeverExecuted } = sentDeps([canary({ status: "signing" })]);
    await reconcileSuspectedOrphans(d);
    expect(markNeverExecuted.mock.calls.map(([id]) => id)).toEqual(["canary"]);
  });

  it.each([
    ["the nonce was used — the envelope ran", { witness: { nonceUsed: true, saltValid: true } }],
    ["the salt was invalidated — its nonces may be swept", { witness: { nonceUsed: false, saltValid: false } }],
    ["the witness read failed", { witness: new Error("rpc down") }],
    // D-556: a `failed` written here leaves the solver's worklist and verdict queue for good.
    [
      "the node answering is behind: its block is from before the envelope closed",
      { witness: { nonceUsed: false, saltValid: true, blockTimestampMs: ENVELOPE_DEADLINE_MS } },
    ],
    ["the seal cannot be read", { seal: { kind: "unreadable", reason: "rpc" } as SealRead }],
    ["the seal read throws", { seal: new Error("rpc down") }],
    ["the envelope is still inside its finality margin", { now: ENVELOPE_DEADLINE_MS + 30_000 }],
    ["the nonce's own deadline has passed — `unused` is no evidence", { now: NONCE_DEADLINE_MS }],
  ] as const)("leaves it alone when %s", async (_why, opts) => {
    const { d, markNeverExecuted } = sentDeps([canary()], opts);
    const summary = await reconcileSuspectedOrphans(d);
    expect(markNeverExecuted).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ sentCandidates: 1, neverExecuted: 0 });
  });

  it("confirms a sealed one as credited, never failed, without reading the nonce (026 A0)", async () => {
    // The tab closed before the poll saw the credit. The seal is the proof, and it has to be
    // used while it exists: anyone may purge it once the AuthCall deadline passes.
    const { d, confirm, markNeverExecuted, readNonceWitness } = sentDeps([canary()], { seal: sealed });
    const summary = await reconcileSuspectedOrphans(d);
    expect(confirm.mock.calls.map(([id]) => id)).toEqual(["canary"]);
    expect(markNeverExecuted).not.toHaveBeenCalled();
    expect(readNonceWitness).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ sentCandidates: 1, sentCredited: 1, neverExecuted: 0 });
  });

  it("confirms a sealed `signing` record with an envelope too (026 A0)", async () => {
    const { d, confirm } = sentDeps([canary({ status: "signing" })], { seal: sealed });
    await reconcileSuspectedOrphans(d);
    expect(confirm.mock.calls.map(([id]) => id)).toEqual(["canary"]);
  });

  it("counts a sealed confirm the sink could not persist as not flipped (026 A0)", async () => {
    const { d, confirm } = sentDeps([canary()], { seal: sealed });
    confirm.mockResolvedValueOnce(false);
    await expect(reconcileSuspectedOrphans(d)).resolves.toMatchObject({ sentCredited: 0, neverExecuted: 0 });
  });

  it.each([
    ["the seal cannot be read", { seal: { kind: "unreadable", reason: "rpc" } as SealRead }],
    ["the seal read throws", { seal: new Error("rpc down") }],
    ["the seal is absent", { seal: unsealed, witness: { nonceUsed: true, saltValid: true } }],
  ] as const)("does not confirm a sent record when %s", async (_why, opts) => {
    const { d, confirm } = sentDeps([canary()], opts);
    await reconcileSuspectedOrphans(d);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("leaves it alone when the envelope carries no V1 nonce", async () => {
    const envelope = { ...canaryEnvelope, payload: { ...canaryEnvelope.payload, nonce: "AAAA" } };
    const { d, markNeverExecuted, readNonceWitness } = sentDeps([canary({ signedEnvelope: envelope })]);
    await reconcileSuspectedOrphans(d);
    expect(readNonceWitness).not.toHaveBeenCalled();
    expect(markNeverExecuted).not.toHaveBeenCalled();
  });

  it.each(["suspected_orphan", "failed", "credited"] as const)(
    "never marks a `%s` record as never executed — not this transition's to make",
    async (status) => {
      const { d, markNeverExecuted } = sentDeps([canary({ status })]);
      await reconcileSuspectedOrphans(d);
      expect(markNeverExecuted).not.toHaveBeenCalled();
    }
  );

  it("does not read anything for a sent record without an envelope — it never left", async () => {
    const { d, readSeal, readNonceWitness } = sentDeps([canary({ signedEnvelope: undefined })]);
    const summary = await reconcileSuspectedOrphans(d);
    expect(readSeal).not.toHaveBeenCalled();
    expect(readNonceWitness).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ sentCandidates: 0 });
  });

  it("counts a mark the sink could not persist as not flipped, without throwing", async () => {
    const { d } = sentDeps([canary()], { mark: false });
    await expect(reconcileSuspectedOrphans(d)).resolves.toMatchObject({ neverExecuted: 0 });
  });
});


// D-448: the solver's final verdict outlives both on-chain proofs, so the sweep reads it first
// and settles the record on it — and never reads the chain for a record it covers.
describe("reconcileSuspectedOrphans — the solver's final verdict (D-448)", () => {
  const envelope = { standard: "nep413", payload: {} };

  function verdictDeps(records: AllocateRescueRecord[], verdicts: Record<string, string> | Error) {
    const base = deps(records, {});
    const readVerdicts = vi.fn(async () => {
      if (verdicts instanceof Error) throw verdicts;
      return verdicts as never;
    });
    return { ...base, d: { ...base.d, readVerdicts }, readVerdicts };
  }

  it.each(["suspected_orphan", "submitted", "signing"] as const)(
    "credited ⇒ confirms a `%s` record without reading its seal",
    async (status) => {
      const { d, confirm, readSeal, markNeverExecuted } = verdictDeps(
        [record({ id: "a", status, signedEnvelope: envelope })],
        { a: "credited" }
      );
      const summary = await reconcileSuspectedOrphans(d);
      expect(confirm.mock.calls.map(([id]) => id)).toEqual(["a"]);
      expect(markNeverExecuted).not.toHaveBeenCalled();
      expect(readSeal).not.toHaveBeenCalled();
      expect(summary).toMatchObject({ verdicts: 1, verdictCredited: 1, verdictNeverExecuted: 0 });
    }
  );

  it.each(["suspected_orphan", "submitted", "signing"] as const)(
    "never_executed ⇒ marks a `%s` record failed, never credited",
    async (status) => {
      const { d, confirm, readSeal, markNeverExecuted } = verdictDeps(
        [record({ id: "a", status, signedEnvelope: envelope })],
        { a: "never_executed" }
      );
      const summary = await reconcileSuspectedOrphans(d);
      expect(markNeverExecuted.mock.calls.map(([id]) => id)).toEqual(["a"]);
      expect(confirm).not.toHaveBeenCalled();
      expect(readSeal).not.toHaveBeenCalled();
      expect(summary).toMatchObject({ verdicts: 1, verdictCredited: 0, verdictNeverExecuted: 1 });
    }
  );

  it("never_executed on a record already failed writes nothing", async () => {
    const { d, confirm, markNeverExecuted, readSeal } = verdictDeps(
      [record({ id: "a", status: "failed", signedEnvelope: envelope })],
      { a: "never_executed" }
    );
    await reconcileSuspectedOrphans(d);
    expect(markNeverExecuted).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(readSeal).not.toHaveBeenCalled();
  });

  it("orphan_escalated writes nothing and reads nothing on chain", async () => {
    const { d, confirm, markNeverExecuted, readSeal } = verdictDeps(
      [record({ id: "a", status: "suspected_orphan", signedEnvelope: envelope })],
      { a: "orphan_escalated" }
    );
    const summary = await reconcileSuspectedOrphans(d);
    expect(confirm).not.toHaveBeenCalled();
    expect(markNeverExecuted).not.toHaveBeenCalled();
    expect(readSeal).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ verdicts: 1, verdictCredited: 0, verdictNeverExecuted: 0 });
  });

  it("asks once for every candidate of both kinds, and only for them", async () => {
    const { d, readVerdicts } = verdictDeps(
      [
        record({ id: "orphan" }),
        record({ id: "sent", status: "submitted", signedEnvelope: envelope }),
        record({ id: "done", status: "credited", signedEnvelope: envelope }),
        record({ id: "unsent", status: "signing" }),
      ],
      {}
    );
    await reconcileSuspectedOrphans(d);
    expect(readVerdicts.mock.calls).toEqual([[["orphan", "sent"]]]);
  });

  it.each([
    ["no verdict yet", {}],
    ["a failed read", new Error("offline")],
  ])("falls back to the seal on %s", async (_why, verdicts) => {
    const { d, confirm, readSeal } = verdictDeps([record({ id: "a" })], verdicts as Record<string, string> | Error);
    readSeal.mockResolvedValueOnce(sealed);
    const summary = await reconcileSuspectedOrphans(d);
    expect(readSeal).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls.map(([id]) => id)).toEqual(["a"]);
    expect(summary).toMatchObject({ verdicts: 0, flipped: 1 });
  });

  it("a confirm the sink could not persist is not counted, and the others go on", async () => {
    const { d, confirm } = verdictDeps([record({ id: "a" }), record({ id: "b" })], { a: "credited", b: "credited" });
    confirm.mockResolvedValueOnce(false);
    await expect(reconcileSuspectedOrphans(d)).resolves.toMatchObject({ verdicts: 2, verdictCredited: 1 });
    expect(confirm).toHaveBeenCalledTimes(2);
  });
});
