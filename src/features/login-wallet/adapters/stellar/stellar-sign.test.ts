import { describe, it, expect } from "vitest";
import { buildStellarSignature } from "./stellar-sign";

describe("buildStellarSignature", () => {
  const ADDRESS = "GBVNQXLCBYGQAQSYA2RXFGR4VHYF67PFEM7ZTKU26JJCHXVF5KDKHTX";
  const MESSAGE = "Portfolio Commit\nAccount: GBVNQXLCBYGQAQSYA2RXFGR4VHYF67PFEM7ZTKU26JJCHXVF5KDKHTX\nTimestamp: 2026-01-01T00:00:00Z";
  const SIGNED = "base64signedmessage==";

  it("sets scheme to sep53", () => {
    const sig = buildStellarSignature(ADDRESS, MESSAGE, SIGNED);
    expect(sig.scheme).toBe("sep53");
  });

  it("preserves message as payload", () => {
    const sig = buildStellarSignature(ADDRESS, MESSAGE, SIGNED);
    expect(sig.payload).toBe(MESSAGE);
  });

  it("preserves signedMessage as signature", () => {
    const sig = buildStellarSignature(ADDRESS, MESSAGE, SIGNED);
    expect(sig.signature).toBe(SIGNED);
  });

  it("uses signerAddress as publicKey", () => {
    const sig = buildStellarSignature(ADDRESS, MESSAGE, SIGNED);
    expect(sig.publicKey).toBe(ADDRESS);
  });
});
