import { describe, it, expect } from "vitest";
import bs58 from "bs58";
import { buildSolanaSignature } from "./solana-sign";

describe("buildSolanaSignature", () => {
  const MESSAGE = "Portfolio Commit\nAccount: So11111111111111111111111111111111111111112\nTimestamp: 2026-01-01T00:00:00Z";
  const SIG_BYTES = new Uint8Array(64).fill(0xab);
  const PUBKEY_B58 = "So11111111111111111111111111111111111111112";

  it("sets scheme to raw_ed25519", () => {
    const sig = buildSolanaSignature(SIG_BYTES, PUBKEY_B58, MESSAGE);
    expect(sig.scheme).toBe("raw_ed25519");
  });

  it("preserves message as payload", () => {
    const sig = buildSolanaSignature(SIG_BYTES, PUBKEY_B58, MESSAGE);
    expect(sig.payload).toBe(MESSAGE);
  });

  it("encodes signature bytes as base58", () => {
    const sig = buildSolanaSignature(SIG_BYTES, PUBKEY_B58, MESSAGE);
    expect(sig.signature).toBe(bs58.encode(SIG_BYTES));
  });

  it("preserves publicKey as base58 string", () => {
    const sig = buildSolanaSignature(SIG_BYTES, PUBKEY_B58, MESSAGE);
    expect(sig.publicKey).toBe(PUBKEY_B58);
  });
});
