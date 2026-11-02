import { describe, it, expect } from "vitest";
import { buildNearSignature } from "./near-sign";

const fixture = {
  accountId: "alice.near",
  publicKey: "ed25519:AAAA",
  signature: "base64sig==",
};

describe("buildNearSignature", () => {
  it("produces nep413 scheme", () => {
    const result = buildNearSignature(fixture, "hello");
    expect(result.scheme).toBe("nep413");
  });

  it("preserves signature and publicKey from raw result", () => {
    const result = buildNearSignature(fixture, "hello");
    expect(result.signature).toBe(fixture.signature);
    expect(result.publicKey).toBe(fixture.publicKey);
  });

  it("sets payload to the original message", () => {
    const result = buildNearSignature(fixture, "sign this please");
    if (result.scheme !== "nep413") throw new Error("unexpected scheme");
    expect(result.payload).toBe("sign this please");
  });

  it("accountId in raw result does not leak into Signature shape", () => {
    const result = buildNearSignature(fixture, "hello");
    expect("accountId" in result).toBe(false);
  });
});
