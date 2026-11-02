// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearIdentity,
  readNearKeyProof,
  writeNearKeyProof,
} from "./persistence";

describe("NEAR key proof persistence", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips only the public account, wallet and key tuple", () => {
    const proof = {
      accountId: "alice.near",
      walletId: "meteor-wallet",
      publicKey: "ed25519:key",
    };

    writeNearKeyProof(proof);

    expect(readNearKeyProof()).toEqual(proof);
  });

  it("rejects malformed stored values instead of partially trusting them", () => {
    localStorage.setItem(
      "intentfolio.near-key-proof.v1",
      JSON.stringify({ accountId: "alice.near", walletId: "meteor-wallet" }),
    );

    expect(readNearKeyProof()).toBeNull();
  });

  it("clears the proof with the signed-in identity but preserves the recent family", () => {
    localStorage.setItem("intentfolio.identity", "identity");
    localStorage.setItem("intentfolio.lastUsedWalletFamily", "near");
    writeNearKeyProof({
      accountId: "alice.near",
      walletId: "meteor-wallet",
      publicKey: "ed25519:key",
    });

    clearIdentity();

    expect(localStorage.getItem("intentfolio.identity")).toBeNull();
    expect(readNearKeyProof()).toBeNull();
    expect(localStorage.getItem("intentfolio.lastUsedWalletFamily")).toBe("near");
  });
});
