import { describe, it, expect } from "vitest";
import { depositGroups } from "@/features/bridge/lib/deposit-registry";
import { tokenRegistry } from "@/features/market/lib/token-registry";
import { MIN_DEPOSIT_RAW } from "@/features/bridge/lib/deposit-minimums";
import { GET } from "./route";

describe("GET /api/bridge/supported-tokens — minimum deposit (D-584, measured on 1Click)", () => {
  it("states ZEC's minimum, 0.001 (D-580)", async () => {
    const body = await (await GET()).json();
    expect(body.minDeposit.ZEC["zec:mainnet"]).toBe("0.001");
  });

  it("states the measured minimums in human units", async () => {
    const body = await (await GET()).json();
    expect(body.minDeposit.SOL["sol:mainnet"]).toBe("0.00089088");
    expect(body.minDeposit.BTC["btc:mainnet"]).toBe("0.000064");
    expect(body.minDeposit.USDT["tron:mainnet"]).toBe("1");
  });

  it("only names tokens the registry carries, on a network Receive offers for that asset", async () => {
    const body = await (await GET()).json();
    const ids = new Set(tokenRegistry.map((t) => t.id));
    for (const id of Object.keys(MIN_DEPOSIT_RAW)) expect(ids.has(id), id).toBe(true);
    for (const [asset, chains] of Object.entries(body.minDeposit as Record<string, Record<string, string>>)) {
      const group = depositGroups.find((g) => g.assetName === asset);
      for (const chain of Object.keys(chains)) expect(group?.chainIds, `${asset}@${chain}`).toContain(chain);
    }
  });

  it("emits every minimum of the table", async () => {
    const body = await (await GET()).json();
    const emitted = Object.values(body.minDeposit as Record<string, Record<string, string>>).reduce((n, c) => n + Object.keys(c).length, 0);
    expect(emitted).toBe(Object.keys(MIN_DEPOSIT_RAW).length);
  });
});
