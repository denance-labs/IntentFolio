import { describe, it, expect, vi } from "vitest";
import { signerForFamily } from "./use-live-signer";
import type { VaultChainKind } from "../lib/vault-payloads";

// The wiring, not the signers (those have their own vectors in vault-signer.test.ts).
// A family pointed at the wrong signer fails loudly rather than losing funds — the scheme
// guard inside each signer catches it — but it fails AFTER the user approved a signature in
// their wallet, which is a bad place to discover a typo in a switch.

const deps = {
  intentsAccountId: "deadbeef",
  address: "wallet-address",
  signMessage: vi.fn(),
  realAllocateSigner: {
    signNEP413Message: vi.fn(),
    signAndSendTransaction: vi.fn(),
  },
};

describe("signerForFamily", () => {
  const cases: Array<[VaultChainKind, string]> = [
    ["near", "nep413"],
    ["evm", "erc191"],
    ["tron", "tip191"],
    ["solana", "raw_ed25519"],
    ["stellar", "sep53"],
    ["ton", "ton_connect"],
  ];

  it.each(cases)("maps %s to the %s scheme", (family, scheme) => {
    expect(signerForFamily(family, deps).scheme).toBe(scheme);
  });

  it("covers every family the vault knows about", () => {
    // Guards the switch against a family added to VaultChainKind and forgotten here. The
    // compiler already rejects a missing case; this catches a case wired to the wrong one.
    const families: VaultChainKind[] = ["near", "evm", "solana", "ton", "stellar", "tron"];
    const schemes = families.map((f) => signerForFamily(f, deps).scheme);
    expect(new Set(schemes).size).toBe(families.length);
  });
});
