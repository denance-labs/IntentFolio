import { describe, expect, it } from "vitest";
import { deriveWalletState } from "./use-near-wallet-adapter";
import { normalizeWalletError } from "./normalize-error";

const baseLib = { loading: false, signedAccountId: "", network: "mainnet" as const };
const idle = { kind: "idle" as const };

describe("deriveWalletState", () => {
  it("loading=true → initializing", () => {
    expect(deriveWalletState({ ...baseLib, loading: true }, idle).status).toBe("initializing");
  });

  it("loading=false, signedAccountId empty → signed-out", () => {
    expect(deriveWalletState(baseLib, idle).status).toBe("signed-out");
  });

  it("loading=false, signedAccountId truthy → signed-in with walletNetwork", () => {
    const s = deriveWalletState({ ...baseLib, signedAccountId: "alice.near" }, idle);
    expect(s.status).toBe("signed-in");
    if (s.status === "signed-in") {
      expect(s.signedAccountId).toBe("alice.near");
      expect(s.walletNetwork).toBe("mainnet");
    }
  });

  it("signing-in local → signing-in (overrides lib loading=false, signedAccountId empty)", () => {
    const s = deriveWalletState(baseLib, { kind: "signing-in" });
    expect(s.status).toBe("signing-in");
  });

  it("signing-in local overrides lib.loading=true", () => {
    const s = deriveWalletState({ ...baseLib, loading: true }, { kind: "signing-in" });
    expect(s.status).toBe("signing-in");
  });

  it("error local → status error with error message", () => {
    const s = deriveWalletState(baseLib, { kind: "error", message: "rpc timeout" });
    expect(s.status).toBe("error");
    if (s.status === "error") expect(s.error).toBe("rpc timeout");
  });

  it("idle after clearError (was error) → signed-out", () => {
    expect(deriveWalletState(baseLib, idle).status).toBe("signed-out");
  });

  it("idle after signOut → signed-out when signedAccountId empty", () => {
    expect(deriveWalletState({ ...baseLib, signedAccountId: "" }, idle).status).toBe("signed-out");
  });
});

describe("normalizeWalletError", () => {
  it("message containing 'cancel' → kind cancel", () => {
    expect(normalizeWalletError(new Error("user cancel")).kind).toBe("cancel");
  });

  it("message containing 'reject' → kind cancel", () => {
    expect(normalizeWalletError(new Error("Transaction rejected")).kind).toBe("cancel");
  });

  it("message containing 'denied' → kind cancel", () => {
    expect(normalizeWalletError(new Error("access denied")).kind).toBe("cancel");
  });

  it("unrelated error → kind error with truthy message", () => {
    const r = normalizeWalletError(new Error("RPC connection timeout"));
    expect(r.kind).toBe("error");
    expect(r.message).toBeTruthy();
  });

  it("non-Error unknown → kind error with fallback message", () => {
    const r = normalizeWalletError("something went wrong");
    expect(r.kind).toBe("error");
  });
});
