import { describe, it, expect } from "vitest";
import { buildTonSignature } from "./ton-sign";

describe("buildTonSignature", () => {
  const ADDRESS = "EQA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8S9T0U1";
  const DOMAIN = "localhost";
  const TIMESTAMP = 1748649600; // 2026-05-30T16:00:00Z unix
  const TEXT = "Portfolio Commit\nAccount: EQA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8S9T0U1\nTimestamp: 2026-01-01T00:00:00Z";
  const SIGNATURE = "base64signaturestring==";
  const PUBLIC_KEY = "deadbeefdeadbeefdeadbeef";

  it("sets scheme to ton_connect", () => {
    const sig = buildTonSignature(ADDRESS, DOMAIN, TIMESTAMP, TEXT, SIGNATURE, PUBLIC_KEY);
    expect(sig.scheme).toBe("ton_connect");
  });

  it("serialises timestamp as string", () => {
    const sig = buildTonSignature(ADDRESS, DOMAIN, TIMESTAMP, TEXT, SIGNATURE, PUBLIC_KEY);
    expect(sig.timestamp).toBe(String(TIMESTAMP));
    expect(typeof sig.timestamp).toBe("string");
  });

  it("preserves text as the signed message", () => {
    const sig = buildTonSignature(ADDRESS, DOMAIN, TIMESTAMP, TEXT, SIGNATURE, PUBLIC_KEY);
    expect(sig.text).toBe(TEXT);
  });

  it("passes through address, domain, signature, publicKey unchanged", () => {
    const sig = buildTonSignature(ADDRESS, DOMAIN, TIMESTAMP, TEXT, SIGNATURE, PUBLIC_KEY);
    expect(sig.address).toBe(ADDRESS);
    expect(sig.domain).toBe(DOMAIN);
    expect(sig.signature).toBe(SIGNATURE);
    expect(sig.publicKey).toBe(PUBLIC_KEY);
  });
});
