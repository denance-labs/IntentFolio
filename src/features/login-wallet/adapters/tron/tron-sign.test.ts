import { describe, it, expect } from "vitest";
import { buildTronSignature } from "./tron-sign";

describe("buildTronSignature", () => {
  const MESSAGE = "Portfolio Commit\nAccount: TRFLnv4vTFBbX8HuFpD1tznmAmBXWNpT7C\nTimestamp: 2026-01-01T00:00:00Z";
  const SIGNATURE = "0xdeadbeefdeadbeefdeadbeef0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001c";

  it("sets scheme to tip191", () => {
    const sig = buildTronSignature(MESSAGE, SIGNATURE);
    expect(sig.scheme).toBe("tip191");
  });

  it("preserves message as payload", () => {
    const sig = buildTronSignature(MESSAGE, SIGNATURE);
    expect(sig.payload).toBe(MESSAGE);
  });

  it("preserves signature unchanged", () => {
    const sig = buildTronSignature(MESSAGE, SIGNATURE);
    expect(sig.signature).toBe(SIGNATURE);
  });

  it("does not include publicKey", () => {
    const sig = buildTronSignature(MESSAGE, SIGNATURE);
    expect("publicKey" in sig).toBe(false);
  });
});
