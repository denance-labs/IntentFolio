// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import {
  buildPatchStatement,
  handleCreateRecord,
  handlePatchRecord,
  validateCreateBody,
  validatePatchBody,
} from "./withdraw-records-service";
import type { Queryable } from "@/features/vault/lib/ops-records-service";

const ID = "2f1c8a4e-6b3d-4c2a-9e1f-0a1b2c3d4e5f";

const direct = {
  id: ID,
  kind: "direct",
  signerId: "alice.near",
  tokenId: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
  amount: "1000000",
  chainId: "eth:1",
  route: "omft",
  destinationAddress: "0x000000000000000000000000000000000000dEaD",
  nonce: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
  deadline: 1_760_011_800_000,
  signedPayload: { standard: "nep413", payload: { message: "{}" }, signature: "ed25519:sig" },
  createdAt: 1_760_011_200_000,
};

const conversionDetails = {
  depositAddress: "0x1111111111111111111111111111111111111111",
  deliveryTokenId: "nep141:eth.bridge.near",
  amountOut: "990000",
  minAmountOut: "980000",
  requestedDeadlineMs: 1_760_011_800_000,
  quoteSignature: "ed25519:abc",
};

const conversion = {
  ...direct,
  kind: "conversion",
  route: undefined,
  chainId: "near:mainnet",
  conversion: conversionDetails,
};

const allow = { check: () => true };
const noLog = () => {};

function stubDb(rowCount: number | Error = 1) {
  const query = vi.fn(async () => {
    if (rowCount instanceof Error) throw rowCount;
    return { rows: [], rowCount };
  });
  return { db: { query } as unknown as Queryable, query };
}

describe("validateCreateBody", () => {
  // D-580: the solver's ops DB takes `omni` since its migration 011.
  it("accepts a direct ZEC withdrawal on the omni route", () => {
    expect(
      validateCreateBody({
        ...direct,
        tokenId: "nep141:zec.omft.near",
        amount: "500000",
        chainId: "zec:mainnet",
        route: "omni",
        destinationAddress: "t1T5yEngwgBC6VSSHhTQKtr7pKtX3CSokSX",
      })
    ).toMatchObject({ ok: true });
  });

  it("accepts a direct withdrawal and a conversion as the sink builds them", () => {
    expect(validateCreateBody(direct)).toEqual({ ok: true, value: direct });
    const { route: _route, ...noRoute } = conversion;
    void _route;
    expect(validateCreateBody(noRoute)).toEqual({ ok: true, value: noRoute });
  });

  it("refuses what 006 would refuse, with a readable message", () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ id: "not-a-uuid" }, /UUID/],
      [{ kind: "swap" }, /kind/],
      [{ signerId: "a" }, /signerId/],
      [{ amount: "1.5" }, /amount/],
      [{ amount: 1000000 }, /amount/],
      [{ amount: "1".repeat(79) }, /amount/],
      [{ route: "wormhole" }, /route/],
      [{ route: undefined }, /route/],
      [{ conversion: conversionDetails }, /direct withdrawal carries no conversion/],
      [{ nonce: undefined }, /nonce/],
      [{ deadline: "soon" }, /deadline/],
      [{ destinationAddress: "" }, /destinationAddress/],
      [{ destinationMemo: "m".repeat(257) }, /destinationMemo/],
      [{ destinationMemo: "" }, /destinationMemo/],
      [{ signedPayload: undefined }, /signedPayload/],
      [{ signedPayload: "signed" }, /signedPayload/],
      [{ signedPayload: [1, 2] }, /signedPayload/],
      [{ signedPayload: { blob: "x".repeat(33_000) } }, /signedPayload/],
    ];
    for (const [override, message] of cases) {
      const result = validateCreateBody({ ...direct, ...override });
      expect(result.ok, JSON.stringify(override)).toBe(false);
      if (!result.ok) expect(result.error).toMatch(message);
    }
  });

  // Everything the TABLE would refuse must be refused here: past validation a refusal is a 502
  // that alerts the operator, and a stranger must not be able to provoke that.
  it("refuses what Postgres would refuse after validation: NUL, pre-epoch dates, astral lengths", () => {
    const cases: Array<Record<string, unknown>> = [
      { destinationAddress: "bob\u0000.near" },
      { signedPayload: { message: "a\u0000b" } },
      { deadline: -1 },
      { createdAt: -8e15 },
      // One astral character: 2 UTF-16 units, 1 Postgres character — under the 2-char minimum.
      { signerId: "\u{1F600}" },
    ];
    for (const override of cases) {
      expect(validateCreateBody({ ...direct, ...override }).ok, JSON.stringify(override)).toBe(false);
    }
  });

  it("refuses a conversion that names a route or carries a malformed quote", () => {
    expect(validateCreateBody({ ...conversion, route: "omft" })).toMatchObject({ ok: false });
    expect(validateCreateBody({ ...conversion, route: undefined, conversion: "quote" })).toMatchObject({ ok: false });
    expect(
      validateCreateBody({ ...conversion, route: undefined, conversion: { ...conversionDetails, amountOut: 1 } })
    ).toMatchObject({ ok: false });
    expect(
      validateCreateBody({
        ...conversion,
        route: undefined,
        conversion: { ...conversionDetails, quoteSignature: "s".repeat(3_000) },
      })
    ).toMatchObject({ ok: false });
  });

  it("drops a stray key inside the quote instead of storing it", () => {
    const result = validateCreateBody({
      ...conversion,
      route: undefined,
      conversion: { ...conversionDetails, injected: "x" },
    });
    expect(result.ok && result.value.conversion).toEqual(conversionDetails);
  });
});

describe("validatePatchBody", () => {
  it("accepts the lifecycle hints and truncates a long error", () => {
    const result = validatePatchBody({ id: ID, status: "settled", txHash: "Gx1", error: "e".repeat(5_000) });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("settled");
      expect(result.value.error).toHaveLength(2_000);
    }
  });

  it("strips a NUL from the error rather than losing the status with it", () => {
    const result = validatePatchBody({ id: ID, status: "failed", error: "bad\u0000 thing" });
    expect(result).toEqual({ ok: true, value: { id: ID, status: "failed", error: "bad thing" } });
  });

  it("never accepts `dismissed`: hiding a record is not a fact about the money", () => {
    expect(validatePatchBody({ id: ID, status: "dismissed" })).toMatchObject({ ok: false });
  });

  it("refuses an empty patch and unknown-only fields", () => {
    expect(validatePatchBody({ id: ID })).toMatchObject({ ok: false });
    expect(validatePatchBody({ id: ID, amount: "1" })).toMatchObject({ ok: false });
  });
});

describe("buildPatchStatement — the allowlist on its own", () => {
  it("writes only the five granted columns, whatever the object carries", () => {
    const { sql, columns } = buildPatchStatement({
      id: ID,
      status: "settled",
      amount: "999",
      destinationAddress: "attacker",
      signer_id: "x",
      destinationTxHash: "0xdest",
    });
    expect(columns).toEqual(["status", "destination_tx_hash"]);
    expect(sql).toBe("UPDATE withdraw_record SET status = $2, destination_tx_hash = $3 WHERE id = $1 RETURNING id");
  });
});

describe("handleCreateRecord", () => {
  it("inserts every column in the DDL's order and reports a new row", async () => {
    const { db, query } = stubDb(1);
    const result = await handleCreateRecord({ body: direct, callerKey: "ip", db, limiter: allow, log: noLog });

    expect(result).toEqual({ status: 200, body: { ok: true, id: ID, created: true } });
    const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO withdraw_record/);
    expect(sql).toMatch(/ON CONFLICT \(id\) DO NOTHING/);
    expect(sql).toMatch(/signed_payload/);
    expect(values).toEqual([
      ID,
      "direct",
      "alice.near",
      direct.tokenId,
      "1000000",
      "eth:1",
      "omft",
      direct.destinationAddress,
      null,
      direct.nonce,
      new Date(direct.deadline),
      null,
      JSON.stringify(direct.signedPayload),
      new Date(direct.createdAt),
    ]);
  });

  it("stores a conversion's quote as JSON and no route", async () => {
    const { db, query } = stubDb(1);
    const { route: _route, ...body } = conversion;
    void _route;
    await handleCreateRecord({ body, callerKey: "ip", db, limiter: allow, log: noLog });
    const values = (query.mock.calls[0] as unknown as [string, unknown[]])[1];
    expect(values[6]).toBeNull();
    expect(JSON.parse(values[11] as string)).toEqual(conversionDetails);
  });

  it("answers a retried POST with created: false", async () => {
    const { db } = stubDb(0);
    const result = await handleCreateRecord({ body: direct, callerKey: "ip", db, limiter: allow, log: noLog });
    expect(result.body).toEqual({ ok: true, id: ID, created: false });
  });

  it("maps a database error to write-failed and logs no user data", async () => {
    const { db } = stubDb(new Error("relation \"withdraw_record\" does not exist"));
    const log = vi.fn();
    const result = await handleCreateRecord({ body: direct, callerKey: "ip", db, limiter: allow, log });

    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ ok: false, code: "write-failed" });
    const line = log.mock.calls.map((c) => c[0]).join("\n");
    expect(line).toContain(ID);
    for (const secret of ["alice.near", direct.destinationAddress, "1000000"]) {
      expect(line).not.toContain(secret);
    }
  });

  it("refuses before the database on a bad body or a spent rate limit", async () => {
    const { db, query } = stubDb(1);
    expect(
      (await handleCreateRecord({ body: { ...direct, amount: "x" }, callerKey: "ip", db, limiter: allow, log: noLog }))
        .status
    ).toBe(400);
    expect(
      (await handleCreateRecord({ body: direct, callerKey: "ip", db, limiter: { check: () => false }, log: noLog }))
        .status
    ).toBe(429);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("handlePatchRecord", () => {
  it("updates the hints", async () => {
    const { db, query } = stubDb(1);
    const result = await handlePatchRecord({
      body: { id: ID, status: "published", intentHash: "ih" },
      callerKey: "ip",
      db,
      limiter: allow,
      log: noLog,
    });
    expect(result).toEqual({ status: 200, body: { ok: true, id: ID, updated: true } });
    expect(query.mock.calls[0]).toEqual([
      "UPDATE withdraw_record SET status = $2, intent_hash = $3 WHERE id = $1 RETURNING id",
      [ID, "published", "ih"],
    ]);
  });

  it("answers 404 for a record the table never received", async () => {
    const { db } = stubDb(0);
    const result = await handlePatchRecord({
      body: { id: ID, status: "settled" },
      callerKey: "ip",
      db,
      limiter: allow,
      log: noLog,
    });
    expect(result.status).toBe(404);
    expect(result.body).toMatchObject({ ok: false, code: "not-found" });
  });
});
