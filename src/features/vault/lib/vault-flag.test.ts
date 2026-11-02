import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// `isLiveVaultRoute` is the ONLY predicate standing between a portfolio gesture and real
// funds, and both flags are inlined at build time — so each case re-imports the module with
// the env it is testing rather than mutating anything after load.

async function loadGate(env: { roundtrip?: string; relay?: string }) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_VAULT_ROUNDTRIP", env.roundtrip ?? "");
  vi.stubEnv("NEXT_PUBLIC_VAULT_RELAY", env.relay ?? "");
  return (await import("./vault-flag")).isLiveVaultRoute;
}

const live = { hasSigner: true, isRealPortfolio: true } as const;

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllEnvs());

describe("isLiveVaultRoute — the master switch", () => {
  it("is closed for every family when the roundtrip flag is off", async () => {
    const gate = await loadGate({ roundtrip: "", relay: "true" });
    expect(gate({ ...live, loginChain: "near" })).toBe(false);
    expect(gate({ ...live, loginChain: "evm" })).toBe(false);
  });

  it("is closed without a signer, and for a portfolio that is not real", async () => {
    const gate = await loadGate({ roundtrip: "true", relay: "true" });
    expect(gate({ hasSigner: false, isRealPortfolio: true, loginChain: "evm" })).toBe(false);
    expect(gate({ hasSigner: true, isRealPortfolio: false, loginChain: "evm" })).toBe(false);
    expect(gate({ hasSigner: true, isRealPortfolio: undefined, loginChain: "evm" })).toBe(false);
  });
});

describe("isLiveVaultRoute — NEAR keeps its own rules", () => {
  it("is open with the roundtrip flag alone: NEAR can self-submit", async () => {
    const gate = await loadGate({ roundtrip: "true", relay: "" });
    expect(gate({ ...live, loginChain: "near" })).toBe(true);
  });
});

describe("isLiveVaultRoute — the five non-NEAR families (Phase 0b)", () => {
  it("opens for every non-NEAR family once the relayer is on", async () => {
    const gate = await loadGate({ roundtrip: "true", relay: "true" });
    for (const chain of ["evm", "solana", "ton", "stellar", "tron"]) {
      expect(gate({ ...live, loginChain: chain }), chain).toBe(true);
    }
  });

  it("stays CLOSED with the relayer off — they would sign with no way to submit", async () => {
    // The regression this pins: without it an EVM user gets a wallet prompt, approves, and
    // only then discovers there is nothing to send the envelope with.
    const gate = await loadGate({ roundtrip: "true", relay: "" });
    expect(gate({ ...live, loginChain: "evm" })).toBe(false);
    expect(gate({ ...live, loginChain: "solana" })).toBe(false);
  });

  it("treats an unknown/absent login family as not signed in", async () => {
    const gate = await loadGate({ roundtrip: "true", relay: "true" });
    expect(gate({ ...live, loginChain: null })).toBe(false);
    expect(gate({ ...live, loginChain: undefined })).toBe(false);
    expect(gate({ ...live, loginChain: "" })).toBe(false);
  });
});
