import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fastnearListFts } from "./fastnear-client";

const ACCOUNT_ID = "alice.near";

function mockResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fastnearListFts", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("returns token list on success", async () => {
    const tokens = [
      { contract_id: "token.near", balance: "1000000", last_update_block_height: 123 },
    ];
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse(200, { account_id: ACCOUNT_ID, tokens })
    );
    expect(await fastnearListFts(ACCOUNT_ID)).toEqual(tokens);
  });

  it("returns [] on HTTP error", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("", { status: 500 }));
    expect(await fastnearListFts(ACCOUNT_ID)).toEqual([]);
  });

  it("returns [] on network error", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("Network error"));
    expect(await fastnearListFts(ACCOUNT_ID)).toEqual([]);
  });

  it("returns [] when tokens field is missing from response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse(200, { account_id: ACCOUNT_ID })
    );
    expect(await fastnearListFts(ACCOUNT_ID)).toEqual([]);
  });

  it("returns empty array for account with no FT history", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse(200, { account_id: ACCOUNT_ID, tokens: [] })
    );
    expect(await fastnearListFts(ACCOUNT_ID)).toEqual([]);
  });
});
