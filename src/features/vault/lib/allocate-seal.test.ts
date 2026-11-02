// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { readAllocateSeal, toPrefixBase64 } from "./allocate-seal";
import { buildAuthCallSetupMsg } from "./vault-payloads";
import { VAULT_CONTRACT_ID } from "@/features/wallet/config/network";

// The seal decides whether a `suspected_orphan` record is flipped to `credited` and dropped
// from every rescue worklist. The only answer this module may ever invent is "unreadable": a
// lenient read of the reply means calling an orphan credited, and a re-serialised msg means
// asking the chain about a different record.

const SIGNER = "0x195d287fb6e1fbbaac18cb6c7db0050388ed8b00";

/** A Setup msg with a NON-ASCII `portfolio_name`: it must reach the view byte for byte. */
const NON_ASCII_MSG = buildAuthCallSetupMsg({
  deadline: 1_790_000_000,
  nonce: Array.from({ length: 32 }, (_, i) => i),
  chain: "evm",
  address: SIGNER,
  portfolioName: "Cartera ñ 🚀",
  composition: [{ tokenId: "nep141:wrap.near", targetBps: 10_000, toleranceBps: 100 }],
  allocations: [{ tokenId: "nep141:wrap.near", amount: "1000000" }],
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("toPrefixBase64", () => {
  it("encodes raw bytes ≥ 0x80 — the reason `btoa(string)` cannot be used", () => {
    expect(toPrefixBase64(new Uint8Array([0xff, 0xd4, 0x99, 0x6a, 0, 0, 0, 0]))).toBe("/9SZagAAAAA=");
  });
});

describe("readAllocateSeal", () => {
  it("asks the vault's `get_allocate_seal` for the raw msg, with finality final", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ result: { result: Array.from(new TextEncoder().encode("null")), logs: [] } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(readAllocateSeal(SIGNER, NON_ASCII_MSG)).resolves.toEqual({ kind: "unsealed" });

    const body = JSON.parse(vi.mocked(fetchMock).mock.calls[0][1].body as string);
    expect(body.params).toMatchObject({
      request_type: "call_function",
      finality: "final",
      account_id: VAULT_CONTRACT_ID,
      method_name: "get_allocate_seal",
    });
    const bytes = Uint8Array.from(atob(body.params.args_base64), (c) => c.charCodeAt(0));
    const args = JSON.parse(new TextDecoder().decode(bytes));
    expect(args).toEqual({ signer_id: SIGNER, msg: NON_ASCII_MSG });
    expect(args.msg).toContain("Cartera ñ 🚀");
  });

  it("passes the raw msg and the signer, and reads null as unsealed", async () => {
    const view = vi.fn().mockResolvedValue(null);
    await expect(readAllocateSeal("alice.near", '{"op":1}', view)).resolves.toEqual({ kind: "unsealed" });
    expect(view).toHaveBeenCalledWith("alice.near", '{"op":1}');
  });

  it("reads a seal as sealed, with its deadline", async () => {
    const view = vi.fn().mockResolvedValue({ msg_hash: "11111111111111111111111111111111", deadline: 1_700_000_000 });
    await expect(readAllocateSeal("alice.near", "m", view)).resolves.toEqual({
      kind: "sealed",
      deadlineSecs: 1_700_000_000,
    });
  });

  // ── Everything below must NOT read as sealed. ────────────────────────────────────────
  it("a failed read or an unknown shape is unreadable, never sealed", async () => {
    const failing = vi.fn().mockRejectedValue(new Error("RPC HTTP 502"));
    await expect(readAllocateSeal("a.near", "m", failing)).resolves.toMatchObject({ kind: "unreadable" });
    const odd = vi.fn().mockResolvedValue({ msg_hash: "x" });
    await expect(readAllocateSeal("a.near", "m", odd)).resolves.toMatchObject({ kind: "unreadable" });
  });

  it.each([
    ["an RPC error object", { error: { code: -32000, message: "Server error" } }, 200],
    ["an empty result", {}, 200],
    ["a non-2xx response", "<html>502</html>", 502],
  ])("treats %s from the RPC as unreadable and never throws", async (_label, body, status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
      )
    );
    await expect(readAllocateSeal(SIGNER, "msg")).resolves.toMatchObject({
      kind: "unreadable",
      reason: expect.any(String),
    });
  });

  it("treats a rejected fetch as unreadable and never throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    await expect(readAllocateSeal(SIGNER, "msg")).resolves.toMatchObject({ kind: "unreadable" });
  });
});
