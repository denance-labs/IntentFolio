import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// `isWalletDepositRoute` is the only thing between the Receive step and a wallet transaction,
// and the flag is inlined at BUILD time — so each case re-imports the module with its own env.
// Its own switch since D-357, set in Production only, AND the vault switch, which is off in
// Preview (D-297) — a second lock there.

async function loadGate(flag: string, vault = "true") {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_WALLET_DEPOSIT", flag);
  vi.stubEnv("NEXT_PUBLIC_VAULT_ROUNDTRIP", vault);
  return (await import("./wallet-deposit-flag")).isWalletDepositRoute;
}

const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const open = { hasSender: true, loginChain: "near", accountId: "pablofork.near", tokenId: "near" } as const;

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllEnvs());

describe("isWalletDepositRoute", () => {
  it("opens with every condition met, for NEAR and for a near-native token", async () => {
    const gate = await loadGate("true");
    expect(gate(open)).toBe(true);
    expect(gate({ ...open, tokenId: USDC_NEAR })).toBe(true);
  });

  it("is closed with the flag absent or anything but the exact string \"true\"", async () => {
    for (const value of ["", "1", "TRUE", "yes", "false"]) {
      const gate = await loadGate(value);
      expect(gate(open), JSON.stringify(value)).toBe(false);
    }
  });

  // D-357: the vault switch alone no longer opens it, so this path can be turned off by itself.
  it("stays closed with only the vault switch on", async () => {
    const gate = await loadGate("", "true");
    expect(gate(open)).toBe(false);
  });

  // A stray Preview entry for this variable must still open nothing: the vault switch is off there.
  it("stays closed with its own switch on but the vault switch off (Preview)", async () => {
    for (const vault of ["", "false"]) {
      const gate = await loadGate("true", vault);
      expect(gate(open), JSON.stringify(vault)).toBe(false);
    }
  });

  it.each<[string, Partial<Parameters<Awaited<ReturnType<typeof loadGate>>>[0]>]>([
    ["an EVM login", { loginChain: "evm" }],
    ["a Solana login", { loginChain: "solana" }],
    ["no login family", { loginChain: null }],
    ["no sender (RealAllocateDisabled, /mock-dashboard)", { hasSender: false }],
    ["no account to sign as", { accountId: "" }],
    ["an undefined account", { accountId: undefined }],
    ["a token of another network", { tokenId: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near" }],
    ["a hot-omni token", { tokenId: "nep245:v2_1.omni.hot.tg:137_11111111111111111111" }],
    ["an unknown token", { tokenId: "nep141:nope.near" }],
  ])("is closed for %s", async (_label, override) => {
    const gate = await loadGate("true");
    expect(gate({ ...open, ...override })).toBe(false);
  });
});
