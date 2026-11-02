import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { depositableTokens } from "@/features/market/lib/token-registry";
import { withdrawalRegistry } from "./withdrawal-registry";

// `isRealWithdrawalRoute` is the only predicate between a withdrawal gesture and funds
// leaving the system for good, and the flag is inlined at BUILD time — so each case
// re-imports the module with the env it is testing instead of mutating anything after load.

async function loadGate(env: { real?: string }) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_REAL_WITHDRAWAL", env.real ?? "");
  return (await import("./withdraw-flag")).isRealWithdrawalRoute;
}

const USDC_ARB = "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near"; // omft
const USDT_NEAR = "nep141:usdt.tether-token.near"; // near-native
const USDC_POLYGON = "nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L"; // hot-omni, EVM
const POL_NATIVE = "nep245:v2_1.omni.hot.tg:137_11111111111111111111"; // hot-omni, EVM native
const USDT_TON = "nep245:v2_1.omni.hot.tg:1117_3tsdfyziyc7EJbP2aULWSKU4toBaAcN4FdTgfm5W1mC4ouR"; // hot-omni, TON
const TON_NATIVE = "nep245:v2_1.omni.hot.tg:1117_"; // hot-omni, TON native

const signedIn = { hasSigner: true, loginChain: "near" } as const;

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllEnvs());

describe("isRealWithdrawalRoute — the master switch", () => {
  it("is closed with the flag off, for every family and every token", async () => {
    const gate = await loadGate({ real: "" });
    expect(gate({ ...signedIn, tokenId: USDC_ARB })).toBe(false);
    expect(gate({ hasSigner: true, loginChain: "evm", tokenId: USDT_NEAR })).toBe(false);
  });

  it("is closed for anything other than the exact string \"true\"", async () => {
    for (const value of ["1", "TRUE", "yes", "false"]) {
      const gate = await loadGate({ real: value });
      expect(gate({ ...signedIn, tokenId: USDC_ARB }), value).toBe(false);
    }
  });

  it("opens with the flag on for a supported route", async () => {
    const gate = await loadGate({ real: "true" });
    expect(gate({ ...signedIn, tokenId: USDC_ARB })).toBe(true);
    expect(gate({ ...signedIn, tokenId: USDT_NEAR })).toBe(true);
  });
});

describe("isRealWithdrawalRoute — who may withdraw", () => {
  it("opens for every login family: publishing needs no NEAR account and no relayer", async () => {
    // The difference from `isLiveVaultRoute`: a withdrawal is published over HTTP to the
    // relay, so the five non-NEAR families do NOT depend on the gas relayer here.
    const gate = await loadGate({ real: "true" });
    for (const chain of ["near", "evm", "solana", "ton", "stellar", "tron"]) {
      expect(gate({ hasSigner: true, loginChain: chain, tokenId: USDC_ARB }), chain).toBe(true);
    }
  });

  it("is closed without a signer, or with no login family at all", async () => {
    const gate = await loadGate({ real: "true" });
    expect(gate({ hasSigner: false, loginChain: "near", tokenId: USDC_ARB })).toBe(false);
    expect(gate({ hasSigner: true, loginChain: null, tokenId: USDC_ARB })).toBe(false);
    expect(gate({ hasSigner: true, loginChain: undefined, tokenId: USDC_ARB })).toBe(false);
    expect(gate({ hasSigner: true, loginChain: "", tokenId: USDC_ARB })).toBe(false);
  });
});

describe("isRealWithdrawalRoute — routes that cannot be built", () => {
  it("opens for hot-omni on every chain the receiver encoder covers — TON included since 4.5", async () => {
    // TON was the last `hot-omni` chain whose address did not go through `encodeHotReceiver`;
    // until 4.5 built its cell, opening for it would have routed the user into a path that
    // throws after they picked the token. Both of its tokens are live now.
    const gate = await loadGate({ real: "true" });
    expect(gate({ ...signedIn, tokenId: USDC_POLYGON })).toBe(true);
    expect(gate({ ...signedIn, tokenId: POL_NATIVE })).toBe(true);
    expect(gate({ ...signedIn, tokenId: USDT_TON })).toBe(true);
    expect(gate({ ...signedIn, tokenId: TON_NATIVE })).toBe(true);
  });

  it("stays closed for a token with no withdrawal route at all", async () => {
    const gate = await loadGate({ real: "true" });
    expect(gate({ ...signedIn, tokenId: "nep141:not-a-token.near" })).toBe(false);
  });
});

describe("the Deposit-only set (D-201) — what opening the gate actually moved", () => {
  // The count the plan's Done for 4.3 is written against, asserted where it is DECIDED: a
  // token is Deposit-only when we offer to take it in and this gate will not let it back out.
  // 14 before 4.3.6, 3 after, still 3 after 4.4, 1 after 4.5, and 0 since D-176 gave NEAR
  // native its `native_withdraw` route (2026-08-20).
  //
  // Curating Stellar's two assets (4.4) would have pushed this to 5, because a curated token
  // with no receiver encoder is exactly a token we take in and cannot give back. The set held
  // at 3 only because the same block built the encoder, the address validation and the fee;
  // 4.5 did the same for TON's two and the set finally moved. If a later change curates a
  // chain without those three, THIS is the test that says so.
  it("is empty: every token we take in can be sent back", async () => {
    const gate = await loadGate({ real: "true" });
    const depositOnly = depositableTokens
      .map((token) => token.id)
      .filter((tokenId) => !gate({ ...signedIn, tokenId }));

    expect(depositOnly).toEqual([]);
  });

  it("counts all 15 hot-omni tokens executable: 11 EVM, Stellar's two, TON's two", async () => {
    const gate = await loadGate({ real: "true" });
    const hotOmni = Object.keys(withdrawalRegistry).filter(
      (tokenId) => withdrawalRegistry[tokenId].bridgeRoute === "hot-omni"
    );
    expect(hotOmni).toHaveLength(15);
    // Named rather than counted, so a token going dark is a failure and not a smaller number.
    expect(hotOmni.filter((tokenId) => !gate({ ...signedIn, tokenId }))).toEqual([]);
    expect(gate({ ...signedIn, tokenId: USDT_TON })).toBe(true);
    expect(gate({ ...signedIn, tokenId: TON_NATIVE })).toBe(true);
  });
});

// D-392 (plan 020 §5.5): the conversion gate needs BOTH flags. On its own the universal flag
// opens nothing — a conversion is live money, and there is no mock to fall back to.
async function loadConversionGate(env: { real?: string; universal?: string }) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_REAL_WITHDRAWAL", env.real ?? "");
  vi.stubEnv("NEXT_PUBLIC_UNIVERSAL_WITHDRAWAL", env.universal ?? "");
  return (await import("./withdraw-flag")).isConversionRoute;
}

const USDT_POL = "nep245:v2_1.omni.hot.tg:137_3hpYoaLtt8MP1Z2GH1U473DMRKgr";
const NBTC = "nep141:nbtc.bridge.near";

describe("isConversionRoute", () => {
  const pair = { ...signedIn, heldTokenId: USDT_POL, chainId: "near:mainnet" };

  it("is closed unless both flags are exactly \"true\"", async () => {
    for (const env of [
      {},
      { real: "true" },
      { universal: "true" },
      { real: "true", universal: "1" },
      { real: "yes", universal: "true" },
    ]) {
      const gate = await loadConversionGate(env);
      expect(gate(pair), JSON.stringify(env)).toBe(false);
    }
  });

  it("opens for a conversion pair with both flags, a signer and a login family", async () => {
    const gate = await loadConversionGate({ real: "true", universal: "true" });
    expect(gate(pair)).toBe(true);
    expect(gate({ ...signedIn, heldTokenId: NBTC, chainId: "btc:mainnet" })).toBe(true);
    for (const chain of ["evm", "solana", "ton", "stellar", "tron"]) {
      expect(gate({ ...pair, loginChain: chain }), chain).toBe(true);
    }
  });

  it("is closed without a signer or a login family", async () => {
    const gate = await loadConversionGate({ real: "true", universal: "true" });
    expect(gate({ ...pair, hasSigner: false })).toBe(false);
    expect(gate({ ...pair, loginChain: null })).toBe(false);
    expect(gate({ ...pair, loginChain: "" })).toBe(false);
  });

  it("is closed for a pair that leaves directly, or not at all", async () => {
    const gate = await loadConversionGate({ real: "true", universal: "true" });
    // The Delivery Token of its own chain: a Direct Withdrawal, never priced by 1Click.
    expect(gate({ ...signedIn, heldTokenId: USDT_NEAR, chainId: "near:mainnet" })).toBe(false);
    expect(gate({ ...signedIn, heldTokenId: USDC_ARB, chainId: "eth:42161" })).toBe(false);
    // Not a family the delivery table converts, and a chain the family is not delivered to.
    expect(gate({ ...signedIn, heldTokenId: POL_NATIVE, chainId: "near:mainnet" })).toBe(false);
    expect(gate({ ...signedIn, heldTokenId: USDT_POL, chainId: "eth:137" })).toBe(false);
  });
});
