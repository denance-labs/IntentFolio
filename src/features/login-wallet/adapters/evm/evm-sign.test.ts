import { describe, it, expect } from "vitest";
import { buildEvmSignature } from "./evm-sign";

describe("buildEvmSignature", () => {
  const MESSAGE = "Portfolio Commit\nAccount: 0xabc\nTimestamp: 2026-01-01T00:00:00Z";
  const HEX_SIG = "0xaabbccdd" + "00".repeat(29) + "1b";

  it("sets scheme to erc191", () => {
    const sig = buildEvmSignature(HEX_SIG, MESSAGE);
    expect(sig.scheme).toBe("erc191");
  });

  it("preserves raw signature", () => {
    const sig = buildEvmSignature(HEX_SIG, MESSAGE);
    expect(sig.signature).toBe(HEX_SIG);
  });

  it("preserves message as payload", () => {
    const sig = buildEvmSignature(HEX_SIG, MESSAGE);
    expect(sig.payload).toBe(MESSAGE);
  });

  it("does not include publicKey (recovered at verify time)", () => {
    const sig = buildEvmSignature(HEX_SIG, MESSAGE);
    expect("publicKey" in sig).toBe(false);
  });
});
