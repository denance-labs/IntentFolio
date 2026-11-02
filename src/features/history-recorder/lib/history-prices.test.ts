import { describe, expect, it, vi } from "vitest";
import { fetchPriceBook } from "./history-prices";

const answer = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe("fetchPriceBook — 1Click prices, never a stand-in", () => {
  it("keeps every token with a positive price and integer decimals, as 1Click spelled the price", async () => {
    const book = await fetchPriceBook(
      answer([
        { assetId: "nep141:wrap.near", decimals: 24, price: 5.19 },
        { assetId: "nep141:tiny.near", decimals: 18, price: 1.3462e-8 },
        { assetId: "nep141:zero.near", decimals: 18, price: 0 },
        { assetId: "nep141:nodec.near", price: 1 },
        { assetId: "nep141:text.near", decimals: 6, price: "1" },
        { decimals: 6, price: 1 },
      ])
    );
    expect([...book.entries()]).toEqual([
      ["nep141:wrap.near", { priceText: "5.19", decimals: 24 }],
      ["nep141:tiny.near", { priceText: "1.3462e-8", decimals: 18 }],
    ]);
  });

  it("throws when 1Click does not answer a list — the pass then values nothing", async () => {
    await expect(fetchPriceBook(answer({ error: "x" }))).rejects.toThrow("not a list");
    await expect(fetchPriceBook(answer([], 502))).rejects.toThrow("502");
  });
});
