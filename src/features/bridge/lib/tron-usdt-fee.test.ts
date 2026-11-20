import { describe, it, expect, vi } from "vitest";
import { readTronUsdtBalance, tronUsdtFeeRaw } from "./tron-usdt-fee";

// D-584: the one `omft` fee that depends on the destination. Measured 2026-11-19 (046 §3).

const HOLDER = "TMPUeGeNvHxThYZ9TLStGG369ZxqXNBSHd";

const answering = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("tronUsdtFeeRaw", () => {
  it("0.81 with any USDT at the destination, 1.53 with none, and 1.53 when unknown", () => {
    expect(tronUsdtFeeRaw(BigInt(1))).toBe("810000");
    expect(tronUsdtFeeRaw(BigInt(0))).toBe("1530000");
    expect(tronUsdtFeeRaw(null)).toBe("1530000");
  });
});

describe("readTronUsdtBalance", () => {
  it("asks the USDT contract's balanceOf with the address as one ABI word", async () => {
    const fetchImpl = answering({ result: { result: true }, constant_result: ["0".repeat(57) + "a7b85c1"] });
    expect(await readTronUsdtBalance(HOLDER, { fetchImpl })).toBe(BigInt(0xa7b85c1));

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.trongrid.io/wallet/triggerconstantcontract");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({
      contract_address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
      function_selector: "balanceOf(address)",
      visible: true,
    });
    // The 20 bytes after the 0x41 prefix, left-padded to 32 — decoded independently of `bs58`
    // (Python, 2026-11-19), so an off-by-one that keeps the prefix cannot pass.
    expect(body.owner_address).toBe(HOLDER);
    expect(body.parameter).toBe("0000000000000000000000007d406c73733cfdf23a1380187444566e779aaaee");
  });

  it("reads a zero balance as zero — an empty address, not a failure", async () => {
    const fetchImpl = answering({ result: { result: true }, constant_result: ["0".repeat(64)] });
    expect(await readTronUsdtBalance(HOLDER, { fetchImpl })).toBe(BigInt(0));
  });

  // Fails closed: none of these may read as a balance, or the screen would price an empty
  // address at the holder's 0.81.
  it.each([
    ["an HTTP error", answering({}, 503)],
    ["a reverted call", answering({ result: { result: false }, constant_result: ["0".repeat(63) + "1"] })],
    ["no result word", answering({ result: { result: true }, constant_result: [] })],
    ["a malformed word", answering({ result: { result: true }, constant_result: ["xyz"] })],
    ["an empty word", answering({ result: { result: true }, constant_result: [""] })],
    ["no constant_result", answering({ result: { result: true } })],
    ["no result flag", answering({ constant_result: ["0".repeat(63) + "1"] })],
    ["an empty body", answering({})],
    ["a body that is not JSON", vi.fn(async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch],
    ["a network error", vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch],
  ])("%s ⇒ null", async (_label, fetchImpl) => {
    expect(await readTronUsdtBalance(HOLDER, { fetchImpl })).toBeNull();
  });

  it("gives up after its timeout ⇒ null, so a hung TronGrid prices at 1.53", async () => {
    const hanging = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        })
    ) as unknown as typeof fetch;
    expect(await readTronUsdtBalance(HOLDER, { fetchImpl: hanging, timeoutMs: 20 })).toBeNull();
  });

  it("does not ask at all for an address that is not a Tron address", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(await readTronUsdtBalance("0x195d287fB6E1fbBaaC18cB6C7DB0050388Ed8B00", { fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
