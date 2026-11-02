import { describe, it, expect, vi } from "vitest";
import {
  NEVER_EXECUTED_MARGIN_MS,
  checkPublication,
  nonceToBase64,
  type PublicationCheckDeps,
} from "./withdraw-publication-check";
import { VERSIONED_NONCE_MAGIC } from "@/features/vault/lib/vault-envelope";

// The nonce of the withdrawal measured in s254 (023 §1): legacy, random, burnt on chain.
const LEGACY_NONCE = "6RB+1r+c2m86XOwmAuOjQ23QcHTVBaOv9ykJXPv/DsI=";
const VERSIONED_NONCE = nonceToBase64(
  Uint8Array.from({ length: 32 }, (_, i) => (i < 4 ? VERSIONED_NONCE_MAGIC[i] : i))
);
const DEADLINE = Date.parse("2026-09-30T14:21:55Z");
const LONG_AFTER = DEADLINE + NEVER_EXECUTED_MARGIN_MS + 1;

function deps(overrides: Partial<PublicationCheckDeps> = {}): PublicationCheckDeps {
  return {
    getRelayStatus: vi.fn().mockResolvedValue({ status: "NOT_FOUND_OR_NOT_VALID" }),
    isNonceUsed: vi.fn().mockResolvedValue(false),
    now: () => LONG_AFTER,
    ...overrides,
  };
}

const record = {
  signerId: "towanda187.near",
  intentHash: "31ZbWCWyereLgymhdDt8HVameKShvjtkk9fShACFmXeL",
  nonce: LEGACY_NONCE,
  deadline: DEADLINE,
};

describe("checkPublication (D-463)", () => {
  it("takes the relay's SETTLED and its tx hash without reading the nonce", async () => {
    const d = deps({ getRelayStatus: vi.fn().mockResolvedValue({ status: "SETTLED", txHash: "tx1" }) });
    await expect(checkPublication(record, d)).resolves.toEqual({ kind: "settled", txHash: "tx1" });
    expect(d.isNonceUsed).not.toHaveBeenCalled();
  });

  // A relay that keeps an old intent at PENDING must not keep the record open forever: the nonce
  // still decides (cross-review 023-A).
  it.each(["PENDING", "TX_BROADCASTED"] as const)("relay %s: the nonce decides", async (status) => {
    const relay = vi.fn().mockResolvedValue({ status, txHash: "tx" });
    await expect(
      checkPublication(record, deps({ getRelayStatus: relay, isNonceUsed: vi.fn().mockResolvedValue(true) }))
    ).resolves.toEqual({ kind: "executed" });
    await expect(
      checkPublication(record, deps({ getRelayStatus: relay, now: () => DEADLINE }))
    ).resolves.toMatchObject({ kind: "unknown" });
    await expect(checkPublication(record, deps({ getRelayStatus: relay }))).resolves.toEqual({
      kind: "never-executed",
    });
  });

  // The s254 case: the relay forgot, the chain did not.
  it("relay NOT_FOUND + nonce used: executed", async () => {
    const d = deps({ isNonceUsed: vi.fn().mockResolvedValue(true) });
    await expect(checkPublication(record, d)).resolves.toEqual({ kind: "executed" });
    expect(d.isNonceUsed).toHaveBeenCalledWith("towanda187.near", LEGACY_NONCE);
  });

  it("a relay that throws does not hide the nonce's answer", async () => {
    const d = deps({
      getRelayStatus: vi.fn().mockRejectedValue(new Error("502")),
      isNonceUsed: vi.fn().mockResolvedValue(true),
    });
    await expect(checkPublication(record, d)).resolves.toEqual({ kind: "executed" });
  });

  it("legacy nonce unused past deadline + margin: never executed", async () => {
    await expect(checkPublication(record, deps())).resolves.toEqual({ kind: "never-executed" });
  });

  it("nonce unused before deadline + margin: unknown, it may still run", async () => {
    const d = deps({ now: () => DEADLINE + NEVER_EXECUTED_MARGIN_MS });
    await expect(checkPublication(record, d)).resolves.toMatchObject({ kind: "unknown" });
  });

  it("a burnt nonce is proof even before the deadline", async () => {
    const d = deps({ now: () => DEADLINE - 1, isNonceUsed: vi.fn().mockResolvedValue(true) });
    await expect(checkPublication(record, d)).resolves.toEqual({ kind: "executed" });
  });

  // A versioned nonce past its deadline may have been swept: `false` proves nothing.
  it("versioned nonce unused: unknown, never 'never executed'", async () => {
    const d = deps();
    await expect(checkPublication({ ...record, nonce: VERSIONED_NONCE }, d)).resolves.toMatchObject({
      kind: "unknown",
    });
  });

  it("versioned nonce used: executed", async () => {
    const d = deps({ isNonceUsed: vi.fn().mockResolvedValue(true) });
    await expect(checkPublication({ ...record, nonce: VERSIONED_NONCE }, d)).resolves.toEqual({
      kind: "executed",
    });
  });

  // Fails closed: a read that fails must never become "the funds are intact".
  it("an is_nonce_used read that throws is unknown", async () => {
    const d = deps({ isNonceUsed: vi.fn().mockRejectedValue(new Error("RPC HTTP 429")) });
    await expect(checkPublication(record, d)).resolves.toMatchObject({ kind: "unknown" });
  });

  it("a record written before D-463 (no nonce) is unknown", async () => {
    const legacy = { signerId: record.signerId, intentHash: record.intentHash };
    const d = deps();
    await expect(checkPublication(legacy, d)).resolves.toMatchObject({ kind: "unknown" });
    expect(d.isNonceUsed).not.toHaveBeenCalled();
  });

  it.each([null, Number.NaN, "1790000000000"])("an unusable stored deadline (%s) is unknown", async (deadline) => {
    const d = deps();
    await expect(
      checkPublication({ ...record, deadline: deadline as unknown as number }, d)
    ).resolves.toMatchObject({ kind: "unknown" });
    expect(d.isNonceUsed).not.toHaveBeenCalled();
  });

  it("an unreadable nonce is unknown and is not sent to the chain", async () => {
    const d = deps();
    await expect(checkPublication({ ...record, nonce: "not-base64!" }, d)).resolves.toMatchObject({
      kind: "unknown",
    });
    await expect(checkPublication({ ...record, nonce: btoa("short") }, d)).resolves.toMatchObject({
      kind: "unknown",
    });
    expect(d.isNonceUsed).not.toHaveBeenCalled();
  });

  it("`publishing` (no intent hash) skips the relay and goes to the nonce", async () => {
    const d = deps();
    const publishing = { ...record, intentHash: undefined };
    await expect(checkPublication(publishing, d)).resolves.toEqual({ kind: "never-executed" });
    expect(d.getRelayStatus).not.toHaveBeenCalled();
  });

  it("nonceToBase64 round-trips the measured nonce", () => {
    const bytes = Uint8Array.from(atob(LEGACY_NONCE), (c) => c.charCodeAt(0));
    expect(nonceToBase64(bytes)).toBe(LEGACY_NONCE);
  });
});
