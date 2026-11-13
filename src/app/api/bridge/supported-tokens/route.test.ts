import { describe, it, expect, vi } from "vitest";

vi.mock("@/features/bridge/lib/bridge-client", () => ({
  getSupportedTokens: vi.fn(async (chains: string[]) =>
    chains[0] === "zec:mainnet"
      ? [
          {
            intents_token_id: "nep141:zec.omft.near",
            asset_name: "ZEC",
            decimals: 8,
            min_deposit_amount: "1000000", // what PoA lists (0.01)
          },
        ]
      : chains[0] === "sol:mainnet"
      ? [{ intents_token_id: "nep141:sol.omft.near", asset_name: "SOL", decimals: 9, min_deposit_amount: "1000000" }]
      : []
  ),
}));

import { GET } from "./route";

describe("GET /api/bridge/supported-tokens — minimum deposit", () => {
  it("states ZEC's real minimum, 0.001, not PoA's 0.01 (D-580)", async () => {
    const body = await (await GET()).json();
    const zecKey = Object.keys(body.minDeposit).find((k) => body.minDeposit[k]["zec:mainnet"]);
    expect(zecKey).toBeDefined();
    expect(body.minDeposit[zecKey!]["zec:mainnet"]).toBe("0.001");
  });

  it("leaves every other token at what PoA lists", async () => {
    const body = await (await GET()).json();
    const solKey = Object.keys(body.minDeposit).find((k) => body.minDeposit[k]["sol:mainnet"]);
    expect(body.minDeposit[solKey!]["sol:mainnet"]).toBe("0.001");
  });
});
