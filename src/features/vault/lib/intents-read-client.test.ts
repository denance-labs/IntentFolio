import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getCurrentSalt, getIntentsBalances, parseSalt, readNonceWitness } from "./intents-read-client";
import { INTENTS_CONTRACT_ID } from "@/features/wallet/config/network";

// The Allocate nonce embeds this salt and the Verifier validates it, so a decode bug here
// invalidates every real Allocate. Pinned offline with `fetch` mocked (007.plan Phase 1);
// the live shape was probed against mainnet first (8 hex chars, e.g. "252812b3").

function mockViewResult(value: unknown): Response {
  const bytes = Array.from(new TextEncoder().encode(JSON.stringify(value)));
  return new Response(
    JSON.stringify({ result: { result: bytes, logs: [], block_height: 1, block_hash: "h" } }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => vi.unstubAllGlobals());

describe("parseSalt", () => {
  it("decodes 8 hex chars into the 4 salt bytes", () => {
    expect([...parseSalt("252812b3")]).toEqual([0x25, 0x28, 0x12, 0xb3]);
  });

  it("accepts uppercase hex", () => {
    expect([...parseSalt("AB12CD34")]).toEqual([0xab, 0x12, 0xcd, 0x34]);
  });

  it("decodes the all-zero salt without collapsing it", () => {
    expect([...parseSalt("00000000")]).toEqual([0, 0, 0, 0]);
  });

  // Money-critical: never pad, truncate, or silently zero a malformed salt.
  it.each(["2528", "252812b345", "", "25 812b3", "zzzzzzzz"])(
    "throws on the malformed salt %j",
    (bad) => {
      expect(() => parseSalt(bad)).toThrow(/expected 8 hex chars/);
    }
  );
});

describe("getCurrentSalt", () => {
  it("reads current_salt from intents.near and returns 4 bytes", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockViewResult("252812b3"));
    const salt = await getCurrentSalt();
    expect(salt).toBeInstanceOf(Uint8Array);
    expect([...salt]).toEqual([0x25, 0x28, 0x12, 0xb3]);

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.params.account_id).toBe(INTENTS_CONTRACT_ID);
    expect(body.params.method_name).toBe("current_salt");
  });

  it("propagates a malformed on-chain value instead of signing with a bad salt", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockViewResult("nope"));
    await expect(getCurrentSalt()).rejects.toThrow(/expected 8 hex chars/);
  });
});

// The cap against which every signed amount is clamped (D-303). It must fail CLOSED: an
// answer it cannot read in full is a throw, never a zero and never "skip the cap".
describe("getIntentsBalances", () => {
  it("reads mt_batch_balance_of on intents.near, in the order asked", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockViewResult(["7", "300000000000000000000000"]));
    const held = await getIntentsBalances("alice.near", ["nep141:a", "nep141:wrap.near"]);
    expect(held).toEqual([BigInt(7), BigInt("300000000000000000000000")]);

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.params.account_id).toBe(INTENTS_CONTRACT_ID);
    expect(body.params.method_name).toBe("mt_batch_balance_of");
    expect(JSON.parse(atob(body.params.args_base64))).toEqual({
      account_id: "alice.near",
      token_ids: ["nep141:a", "nep141:wrap.near"],
    });
  });

  it.each([
    ["a short answer", ["1"]],
    ["a non-array", { "nep141:a": "1" }],
    ["a number instead of a U128 string", [1, "2"]],
    ["a negative figure", ["-1", "2"]],
    ["an empty string", ["", "2"]],
  ])("throws on %s", async (_label, answer) => {
    vi.mocked(fetch).mockResolvedValueOnce(mockViewResult(answer));
    await expect(getIntentsBalances("alice.near", ["nep141:a", "nep141:b"])).rejects.toThrow(
      /mt_batch_balance_of/
    );
  });

  it("throws when the RPC fails, rather than answering zero", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("nope", { status: 401 }));
    await expect(getIntentsBalances("alice.near", ["nep141:a"])).rejects.toThrow(/401/);
  });
});

// D-312: this pair is what may HIDE a record from the My Account notice, so it fails closed —
// anything but two booleans throws, and the caller reads a throw as "cannot tell".
describe("readNonceWitness", () => {
  const HEAD = { hash: "HeadHash", timestamp_nanosec: "1800000000123456789" };

  function bodies() {
    return vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
  }

  function answer(byMethod: Record<string, unknown>) {
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      if (body.method === "block") {
        return new Response(JSON.stringify({ result: { header: HEAD } }), { status: 200 });
      }
      return mockViewResult(byMethod[body.params.method_name as string]);
    });
  }

  it("asks intents.near for the nonce under the account and for the salt", async () => {
    answer({ is_nonce_used: false, is_valid_salt: true });
    await expect(readNonceWitness("alice.near", "Tk9OQ0U=", "252812b3")).resolves.toEqual({
      nonceUsed: false,
      saltValid: true,
      blockTimestampMs: 1_800_000_000_123,
    });
    const calls = bodies()
      .filter((b) => b.method === "query")
      .map((b) => b.params);
    expect(calls.map((c) => c.account_id)).toEqual([INTENTS_CONTRACT_ID, INTENTS_CONTRACT_ID]);
    const args = calls.map((c) => JSON.parse(atob(c.args_base64)));
    expect(args).toContainEqual({ account_id: "alice.near", nonce: "Tk9OQ0U=" });
    expect(args).toContainEqual({ salt: "252812b3" });
  });

  it.each([
    ["a non-boolean nonce answer", { is_nonce_used: "false", is_valid_salt: true }],
    ["a non-boolean salt answer", { is_nonce_used: false, is_valid_salt: null }],
  ])("throws on %s — never reads it as false", async (_, byMethod) => {
    answer(byMethod);
    await expect(readNonceWitness("alice.near", "Tk9OQ0U=", "252812b3")).rejects.toThrow(/two booleans/);
  });

  // D-556: the clock returned must be the clock of the block both answers describe.
  it("reads the FINAL head first and pins both views to that one block", async () => {
    answer({ is_nonce_used: false, is_valid_salt: true });
    await readNonceWitness("alice.near", "Tk9OQ0U=", "252812b3");

    const [first, ...views] = bodies();
    expect(first).toMatchObject({ method: "block", params: { finality: "final" } });
    expect(views).toHaveLength(2);
    for (const view of views) {
      expect(view.params.block_id).toBe("HeadHash");
      expect(view.params).not.toHaveProperty("finality");
    }
  });

  it.each([
    ["an RPC error", { error: { code: -32000, message: "node down" } }],
    ["no header", { result: {} }],
    ["a timestamp that is not a number", { result: { header: { hash: "H", timestamp_nanosec: "soon" } } }],
    ["no hash", { result: { header: { timestamp_nanosec: "1800000000123456789" } } }],
  ])("throws on a head with %s, and reads no view: no clock, no evidence", async (_, head) => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(head), { status: 200 }));
    await expect(readNonceWitness("alice.near", "Tk9OQ0U=", "252812b3")).rejects.toThrow(/final head/);
    expect(bodies().filter((b) => b.method === "query")).toEqual([]);
  });

  it("throws when the node does not hold the pinned block", async () => {
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      return new Response(
        JSON.stringify(
          body.method === "block"
            ? { result: { header: HEAD } }
            : { error: { code: -32000, message: "UNKNOWN_BLOCK", cause: { name: "UNKNOWN_BLOCK" } } }
        ),
        { status: 200 }
      );
    });
    await expect(readNonceWitness("alice.near", "Tk9OQ0U=", "252812b3")).rejects.toThrow(/UNKNOWN_BLOCK/);
  });
});
