import { afterEach, describe, expect, it, vi } from "vitest";
import { getDepositAddress } from "./deposit-address-client";

const respond = (body: string, status = 200) => vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status })));

afterEach(() => vi.unstubAllGlobals());

describe("getDepositAddress", () => {
  it("asks our route for the account and network, uncached", async () => {
    respond(JSON.stringify({ ok: true, address: "0xabc" }));
    expect(await getDepositAddress("alice.near", "eth:1")).toEqual({ address: "0xabc" });
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/deposit-address?account=alice.near&chain=eth%3A1");
    expect(init.cache).toBe("no-store");
  });

  it("keeps the memo", async () => {
    respond(JSON.stringify({ ok: true, address: "GSTELLAR", memo: "238284403" }));
    expect(await getDepositAddress("alice.near", "stellar:mainnet")).toEqual({ address: "GSTELLAR", memo: "238284403" });
  });

  it("throws, with the route's message, instead of returning no address", async () => {
    respond(JSON.stringify({ ok: false, code: "upstream", error: "No memo for Stellar" }), 502);
    await expect(getDepositAddress("alice.near", "stellar:mainnet")).rejects.toThrow("No memo for Stellar");
    respond("<html>", 200);
    await expect(getDepositAddress("alice.near", "eth:1")).rejects.toThrow();
    respond(JSON.stringify({ ok: true, address: "" }));
    await expect(getDepositAddress("alice.near", "eth:1")).rejects.toThrow();
  });
});
