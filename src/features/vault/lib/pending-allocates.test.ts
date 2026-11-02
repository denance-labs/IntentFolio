import { describe, it, expect, vi } from "vitest";
import type { AllocateRecordStatus, AllocateRescueRecord } from "./allocate-rescue-store";
import type { SealRead } from "./allocate-seal";
import { buildVersionedV1Nonce } from "./vault-envelope";
import {
  allocateOpOf,
  findPendingAllocates,
  formatAllocateAge,
  isPendingCandidate,
} from "./pending-allocates";

const ME = "alice.near";

function record(over: Partial<AllocateRescueRecord> = {}): AllocateRescueRecord {
  return {
    id: "rec-1",
    signerId: ME,
    msg: '{"deadline":"1"}',
    vaultId: "intentfolio-staging.near",
    portfolioName: "Mi cartera",
    legs: [{ tokenId: "nep141:wrap.near", amount: "300000000000000000000000" }],
    createdAt: 1_000,
    status: "suspected_orphan",
    signedEnvelope: { standard: "nep413" },
    ...over,
  };
}

const unsealed = async (): Promise<SealRead> => ({ kind: "unsealed" });
// Records without a stored nonce never reach the witness; if one does, it cannot tell.
const noWitness = () => Promise.reject(new Error("no witness in this test"));

describe("isPendingCandidate", () => {
  it.each<[AllocateRecordStatus, boolean]>([
    ["signing", true],
    ["submitted", true],
    ["suspected_orphan", true],
    ["failed", false],
    ["credited", false],
  ])("status %s with a signed envelope → %s", (status, expected) => {
    expect(isPendingCandidate(record({ status }), ME)).toBe(expected);
  });

  it("never counts a record without an envelope — it was never sent", () => {
    expect(isPendingCandidate(record({ signedEnvelope: undefined }), ME)).toBe(false);
  });

  it("never counts another signer's record kept in the same browser", () => {
    expect(isPendingCandidate(record({ signerId: "bob.near" }), ME)).toBe(false);
  });
});

describe("findPendingAllocates", () => {
  it("drops a candidate whose seal is on chain — the status alone would keep it forever", async () => {
    // The tab-closed-during-the-poll case: `submitted` locally, credited on chain.
    const pending = await findPendingAllocates({ readNonceWitness: noWitness,
      signerId: ME,
      records: () => [record({ status: "submitted" })],
      readSeal: async () => ({ kind: "sealed", deadlineSecs: 1 }),
    });
    expect(pending).toEqual([]);
  });

  it("keeps an unsealed candidate, with what the notice shows", async () => {
    const pending = await findPendingAllocates({ readNonceWitness: noWitness,
      signerId: ME,
      records: () => [record()],
      readSeal: unsealed,
    });
    expect(pending).toEqual([
      {
        id: "rec-1",
        portfolioName: "Mi cartera",
        op: "setup",
        portfolioId: null,
        legs: [{ tokenId: "nep141:wrap.near", amount: "300000000000000000000000" }],
        createdAt: 1_000,
        kind: "completing",
      },
    ]);
  });

  it("tells a top-up from a creation by the op in its raw msg (D-321)", async () => {
    const pending = await findPendingAllocates({
      readNonceWitness: noWitness,
      signerId: ME,
      records: () => [
        record({ id: "into", msg: '{"deadline":1,"nonce":[],"op":{"allocate_into":{"portfolio_id":"p_1"}}}' }),
        record({ id: "setup", msg: '{"deadline":1,"nonce":[],"op":{"setup":{"portfolio_name":"x"}}}' }),
      ],
      readSeal: unsealed,
    });
    expect(Object.fromEntries(pending.map((p) => [p.id, p.op]))).toEqual({
      into: "allocate_into",
      setup: "setup",
    });
    // D-302 g: the funded portfolio's id comes from the same msg; a setup has none.
    expect(Object.fromEntries(pending.map((p) => [p.id, p.portfolioId]))).toEqual({
      into: "p_1",
      setup: null,
    });
  });

  it.each<[string, (s: string, m: string) => Promise<SealRead>]>([
    ["an unreadable seal", async () => ({ kind: "unreadable", reason: "rpc 503" })],
    ["a seal read that rejects", () => Promise.reject(new Error("network"))],
  ])("shows the record on %s — money in transit is never hidden on a doubt", async (_, readSeal) => {
    const pending = await findPendingAllocates({ readNonceWitness: noWitness, signerId: ME, records: () => [record()], readSeal });
    expect(pending.map((p) => p.id)).toEqual(["rec-1"]);
  });

  it("words a sent-but-unseen record as confirming, and a worklist one as completing", async () => {
    const pending = await findPendingAllocates({ readNonceWitness: noWitness,
      signerId: ME,
      records: () => [
        record({ id: "a", status: "submitted", createdAt: 1 }),
        record({ id: "b", status: "signing", createdAt: 2 }),
        record({ id: "c", status: "suspected_orphan", createdAt: 3 }),
      ],
      readSeal: unsealed,
    });
    expect(pending.map((p) => [p.id, p.kind])).toEqual([
      ["c", "completing"],
      ["b", "confirming"],
      ["a", "confirming"],
    ]);
  });

  it("reads no seal for a record that is not a candidate", async () => {
    const readSeal = vi.fn(unsealed);
    await findPendingAllocates({ readNonceWitness: noWitness,
      signerId: ME,
      records: () => [record({ status: "credited" }), record({ status: "failed" })],
      readSeal,
    });
    expect(readSeal).not.toHaveBeenCalled();
  });

  it("asks for each seal under the record's own signer and raw msg", async () => {
    const readSeal = vi.fn(unsealed);
    await findPendingAllocates({ readNonceWitness: noWitness, signerId: ME, records: () => [record()], readSeal });
    expect(readSeal).toHaveBeenCalledWith(ME, '{"deadline":"1"}');
  });

  it("keeps a pre-Phase-2 record without legs, as an empty list", async () => {
    const legacy = record({ legs: undefined as unknown as AllocateRescueRecord["legs"] });
    const [pending] = await findPendingAllocates({ readNonceWitness: noWitness, signerId: ME, records: () => [legacy], readSeal: unsealed });
    expect(pending.legs).toEqual([]);
  });
});

describe("formatAllocateAge", () => {
  const NOW = 10 * 24 * 60 * 60_000;
  const MIN = 60_000;
  const HOUR = 60 * MIN;

  it.each<[string, number, string, string]>([
    ["under a minute", 59_999, "just now", "hace un momento"],
    ["exactly a minute", MIN, "1 minute ago", "hace 1 minuto"],
    ["minutes, floored", 5 * MIN + 59_000, "5 minutes ago", "hace 5 minutos"],
    ["an hour", HOUR, "1 hour ago", "hace 1 hora"],
    ["hours up to 48 h", 47 * HOUR + 59 * MIN, "47 hours ago", "hace 47 horas"],
    ["days from 48 h", 48 * HOUR, "2 days ago", "hace 2 días"],
    ["several days", 3 * 24 * HOUR + 5 * HOUR, "3 days ago", "hace 3 días"],
  ])("%s", (_, elapsed, en, es) => {
    expect(formatAllocateAge(NOW - elapsed, NOW, "en")).toBe(en);
    expect(formatAllocateAge(NOW - elapsed, NOW, "es")).toBe(es);
  });

  it("a createdAt in the future reads as just now, never a negative age", () => {
    expect(formatAllocateAge(NOW + 5 * MIN, NOW, "en")).toBe("just now");
  });
});

// D-312: the ONE thing that hides an unsealed record is proof its envelope never ran. Each
// condition of that proof is pinned by a case where it alone fails — and the record shows.
describe("findPendingAllocates — the never-executed proof", () => {
  const NOW = 1_800_000_000_000;
  const ENVELOPE_DEADLINE = NOW / 1000 - 3600; // an hour past
  const NONCE_DEADLINE = NOW / 1000 + 86_400; // a day ahead

  function v1Nonce(deadlineSecs: number): string {
    return Buffer.from(
      buildVersionedV1Nonce({ deadlineSecs, salt: Uint8Array.of(0x25, 0x28, 0x12, 0xb3), tail: new Uint8Array(15) })
    ).toString("base64");
  }

  function neverRan(over: Partial<AllocateRescueRecord> = {}) {
    return record({
      status: "submitted",
      verifierNonce: v1Nonce(NONCE_DEADLINE),
      envelopeDeadlineSecs: ENVELOPE_DEADLINE,
      ...over,
    });
  }

  async function shown(
    rec: AllocateRescueRecord,
    witness: () => Promise<{ nonceUsed: boolean; saltValid: boolean }>,
    readSeal: () => Promise<SealRead> = unsealed
  ): Promise<boolean> {
    const pending = await findPendingAllocates({
      signerId: ME,
      records: () => [rec],
      readSeal,
      readNonceWitness: witness,
      now: () => NOW,
    });
    return pending.length === 1;
  }

  const unused = async () => ({ nonceUsed: false, saltValid: true });

  it("hides an unsealed record whose nonce was never used, past its envelope deadline", async () => {
    expect(await shown(neverRan(), unused)).toBe(false);
  });

  it("hides it even when the seal cannot be read — the nonce alone proves it", async () => {
    expect(await shown(neverRan(), unused, async () => ({ kind: "unreadable", reason: "x" }))).toBe(false);
  });

  it("asks under the signer, the stored nonce and the salt decoded from it", async () => {
    const witness = vi.fn(unused);
    const rec = neverRan();
    await shown(rec, witness);
    expect(witness).toHaveBeenCalledWith(ME, rec.verifierNonce, "252812b3");
  });

  it.each<[string, Partial<AllocateRescueRecord>, () => Promise<{ nonceUsed: boolean; saltValid: boolean }>]>([
    ["the nonce WAS used (it executed: an orphan)", {}, async () => ({ nonceUsed: true, saltValid: true })],
    ["the salt was invalidated (false is no evidence)", {}, async () => ({ nonceUsed: false, saltValid: false })],
    ["the witness read fails", {}, () => Promise.reject(new Error("rpc down"))],
    ["the envelope can still execute", { envelopeDeadlineSecs: NOW / 1000 + 300 }, unused],
    ["the envelope deadline is inside the finality margin", { envelopeDeadlineSecs: NOW / 1000 - 30 }, unused],
    ["the nonce's own deadline passed (it may have been swept)", { verifierNonce: v1Nonce(NOW / 1000 - 1) }, unused],
    ["the record has no stored nonce (written before D-312)", { verifierNonce: undefined }, unused],
    ["the record has no envelope deadline", { envelopeDeadlineSecs: undefined }, unused],
    ["the stored nonce is not a V1 nonce", { verifierNonce: Buffer.from(new Uint8Array(32)).toString("base64") }, unused],
  ])("keeps showing it when %s", async (_, over, witness) => {
    expect(await shown(neverRan(over), witness)).toBe(true);
  });

  // D-295: a record from before D-312 has no fields, but its envelope carries both.
  it("hides a pre-D-312 record, reading the nonce and deadline from its NEP-413 envelope", async () => {
    const nonce = v1Nonce(NONCE_DEADLINE);
    const witness = vi.fn(unused);
    const legacy = neverRan({
      verifierNonce: undefined,
      envelopeDeadlineSecs: undefined,
      signedEnvelope: {
        standard: "nep413",
        payload: {
          message: JSON.stringify({ signer_id: ME, deadline: new Date(ENVELOPE_DEADLINE * 1000).toISOString() }),
          nonce,
          recipient: "intents.near",
        },
      },
    });
    expect(await shown(legacy, witness)).toBe(false);
    expect(witness).toHaveBeenCalledWith(ME, nonce, "252812b3");
  });

  it("never reads the nonce for a sealed record", async () => {
    const witness = vi.fn(unused);
    await shown(neverRan(), witness, async () => ({ kind: "sealed", deadlineSecs: 1 }));
    expect(witness).not.toHaveBeenCalled();
  });
});

describe("allocateOpOf", () => {
  it.each([
    ['{"op":{"allocate_into":{}}}', "allocate_into"],
    ['{"op":{"setup":{}}}', "setup"],
    // Unreadable reads as the only op that existed before D-321; the row is shown either way.
    ["not json", "setup"],
    ['{"deadline":"1"}', "setup"],
    ['{"op":null}', "setup"],
  ] as const)("%s → %s", (msg, op) => {
    expect(allocateOpOf(msg)).toBe(op);
  });
});

// D-448: the solver's verdict outlives both on-chain proofs (the seal can be purged after the
// AuthCall deadline, the nonce witness expires a week later), so it is asked first and decides
// without any chain read. No verdict ⇒ the chain reads decide, exactly as before.
describe("findPendingAllocates — the solver's verdict (D-448)", () => {
  const sealRead = vi.fn(unsealed);
  const verdicts = (map: Record<string, string>) => vi.fn(async () => map as never);

  it.each(["credited", "never_executed"])("hides a record whose verdict is %s, without reading the chain", async (v) => {
    sealRead.mockClear();
    const pending = await findPendingAllocates({
      readNonceWitness: noWitness,
      signerId: ME,
      records: () => [record({ status: "submitted" })],
      readSeal: sealRead,
      readVerdicts: verdicts({ "rec-1": v }),
    });
    expect(pending).toEqual([]);
    expect(sealRead).not.toHaveBeenCalled();
  });

  it("keeps an orphan_escalated record as under review, without reading the chain", async () => {
    sealRead.mockClear();
    const pending = await findPendingAllocates({
      readNonceWitness: noWitness,
      signerId: ME,
      records: () => [record({ status: "submitted" })],
      readSeal: sealRead,
      readVerdicts: verdicts({ "rec-1": "orphan_escalated" }),
    });
    expect(pending.map((p) => [p.id, p.kind])).toEqual([["rec-1", "review"]]);
    expect(sealRead).not.toHaveBeenCalled();
  });

  it("matches the verdict whatever case the store holds the id in", async () => {
    const pending = await findPendingAllocates({
      readNonceWitness: noWitness,
      signerId: ME,
      records: () => [record({ id: "REC-1" })],
      readSeal: unsealed,
      readVerdicts: verdicts({ "rec-1": "credited" }),
    });
    expect(pending).toEqual([]);
  });

  it("asks once, for this signer's candidates only", async () => {
    const readVerdicts = verdicts({});
    await findPendingAllocates({
      readNonceWitness: noWitness,
      signerId: ME,
      records: () => [
        record({ id: "a" }),
        record({ id: "b", status: "credited" }),
        record({ id: "c", signerId: "bob.near" }),
        record({ id: "d", status: "submitted" }),
      ],
      readSeal: unsealed,
      readVerdicts,
    });
    expect(readVerdicts.mock.calls).toEqual([[["a", "d"]]]);
  });

  it("does not ask when there is nothing to ask about", async () => {
    const readVerdicts = verdicts({});
    await findPendingAllocates({ readNonceWitness: noWitness, signerId: ME, records: () => [], readSeal: unsealed, readVerdicts });
    expect(readVerdicts).not.toHaveBeenCalled();
  });

  it.each([
    ["no verdict yet", verdicts({})],
    ["a failed read", vi.fn(async () => Promise.reject(new Error("offline")))],
  ])("falls back to the chain reads on %s", async (_why, readVerdicts) => {
    const pending = await findPendingAllocates({
      readNonceWitness: noWitness,
      signerId: ME,
      records: () => [record({ id: "x" }), record({ id: "y", status: "submitted" })],
      readSeal: unsealed,
      readVerdicts,
    });
    expect(pending.map((p) => [p.id, p.kind])).toEqual([
      ["x", "completing"],
      ["y", "confirming"],
    ]);
  });

  it("mixes decided and undecided rows, newest first", async () => {
    const pending = await findPendingAllocates({
      readNonceWitness: noWitness,
      signerId: ME,
      records: () => [
        record({ id: "old-review", createdAt: 1_000 }),
        record({ id: "new-chain", createdAt: 3_000 }),
        record({ id: "gone", createdAt: 2_000 }),
      ],
      readSeal: unsealed,
      readVerdicts: verdicts({ "old-review": "orphan_escalated", gone: "never_executed" }),
    });
    expect(pending.map((p) => [p.id, p.kind])).toEqual([
      ["new-chain", "completing"],
      ["old-review", "review"],
    ]);
  });
});
