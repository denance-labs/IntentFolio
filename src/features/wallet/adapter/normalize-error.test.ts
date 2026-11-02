import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { normalizeWalletError } from "./normalize-error";

describe("normalizeWalletError", () => {
  // Suppress the console.warn the function emits on the error path.
  beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it("classifies user-cancelled errors as kind 'cancel'", () => {
    for (const msg of [
      "User cancelled the request",
      "Request rejected",
      "Action denied by user",
      "User closed the popup",
    ]) {
      const result = normalizeWalletError(new Error(msg));
      expect(result.kind).toBe("cancel");
      expect(result.message).toBe(msg);
    }
  });

  // FE #5 (`922` §8 #15): the chain reverting an Allocate says "rejected" too, and read as a
  // cancel it offered a retry that signed again with nothing left to move. Origin first.
  it("never reads a VaultRejectedError as a cancel, whatever its message says", () => {
    const e = new Error("The Verifier rejected the allocation: E_BAD_SALT");
    e.name = "VaultRejectedError";
    const result = normalizeWalletError(e);
    expect(result.kind).toBe("error");
    expect(result.message).toBe("The Verifier rejected the allocation: E_BAD_SALT");
    // The wallet's own "rejected" is still the user declining.
    expect(normalizeWalletError(new Error("User rejected the request")).kind).toBe("cancel");
  });

  // D-301: the same trap on the commit path. A reverted withdrawal or composition change
  // showed "You cancelled the signature" in the editor.
  it("never reads a VaultCommitRevertedError as a cancel", () => {
    const e = new Error("The vault reverted the change: rejected by E_NONCE_CONSUMED");
    e.name = "VaultCommitRevertedError";
    const result = normalizeWalletError(e);
    expect(result.kind).toBe("error");
    expect(result.message).toBe("The vault reverted the change: rejected by E_NONCE_CONSUMED");
  });

  it("matches cancel keywords case-insensitively", () => {
    expect(normalizeWalletError(new Error("REJECTED")).kind).toBe("cancel");
    expect(normalizeWalletError(new Error("User CANCELled")).kind).toBe("cancel");
  });

  it("classifies non-cancel errors as kind 'error'", () => {
    const result = normalizeWalletError(new Error("RPC timeout"));
    expect(result.kind).toBe("error");
    expect(result.message).toBe("RPC timeout");
  });

  it("classifies wallet-not-usable errors as kind 'unavailable'", () => {
    // These mirror the exact messages the login adapters throw on their prechecks.
    for (const msg of [
      "Wallet not connected",
      "TronLink not available",
      "Freighter wallet not found. Install the extension.",
      "Wallet does not support signMessage",
      "Freighter returned null signature",
      "Wallet is locked",
    ]) {
      const result = normalizeWalletError(new Error(msg));
      expect(result.kind).toBe("unavailable");
      expect(result.message).toBe(msg);
    }
  });

  it("prioritizes cancel over unavailable when both keywords are present", () => {
    // A user-rejected sign on a wallet that also reports a connection hiccup is still
    // a cancel — user intent wins so we don't nag them to unlock.
    expect(normalizeWalletError(new Error("user rejected: wallet not connected")).kind).toBe(
      "cancel",
    );
  });

  it("does not warn on the cancel or unavailable path, warns on the error path", () => {
    normalizeWalletError(new Error("user rejected"));
    normalizeWalletError(new Error("Wallet not connected"));
    expect(console.warn).not.toHaveBeenCalled();
    normalizeWalletError(new Error("boom"));
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it("stringifies non-Error inputs", () => {
    expect(normalizeWalletError("plain rejected string").kind).toBe("cancel");
    expect(normalizeWalletError({ code: 500 }).message).toBe("[object Object]");
  });

  it("falls back to a generic message for an empty error string", () => {
    const result = normalizeWalletError(new Error(""));
    expect(result.kind).toBe("error");
    expect(result.message).toBe("Wallet error");
  });
});

describe("normalizeWalletError — relayer refusals (017-2, D-365)", () => {
  class RelayError extends Error {
    constructor(message: string, readonly code: string) {
      super(message);
      this.name = "RelayError";
    }
  }

  it("maps each refusal with copy of its own, before the cancel keywords", () => {
    // "rejected" would otherwise read as a cancel.
    expect(normalizeWalletError(new RelayError("the node rejected it", "paused")).kind).toBe("relay-paused");
    expect(normalizeWalletError(new RelayError("x", "blocked")).kind).toBe("relay-paused");
    expect(normalizeWalletError(new RelayError("x", "rate-limited")).kind).toBe("relay-busy");
    // The server's per-process brake is not the user's pace.
    expect(normalizeWalletError(new RelayError("x", "cap-exceeded")).kind).toBe("relay-paused");
    expect(normalizeWalletError(new RelayError("rejected: insufficient balance", "would-fail")).kind).toBe(
      "relay-would-fail"
    );
    expect(normalizeWalletError(new RelayError("x", "check-failed")).kind).toBe("relay-check-failed");
  });

  it("reads every other relay answer as a plain error, whatever keyword its text carries", () => {
    expect(normalizeWalletError(new RelayError("every upstream down", "send-failed")).kind).toBe("error");
    expect(normalizeWalletError(new RelayError("Access key not found", "send-failed")).kind).toBe("error");
    expect(normalizeWalletError(new RelayError("the node rejected it", "not-configured")).kind).toBe("error");
  });

  it("maps by origin, not by a `code` field any error might carry", () => {
    const lookalike = Object.assign(new Error("Wallet not connected"), { code: "paused" });
    expect(normalizeWalletError(lookalike).kind).toBe("unavailable");
  });

  // D-145: a contract/domain error is not a wallet state, whatever words its text contains.
  it("does not read a ContractError's 'not found' as an unavailable wallet", () => {
    const e = new Error("Account bob.near not found");
    e.name = "ContractError";
    const result = normalizeWalletError(e);
    expect(result.kind).toBe("error");
    expect(result.message).toBe("Account bob.near not found");
  });

  it("still reads a wallet 'not found' as unavailable", () => {
    expect(normalizeWalletError(new Error("Freighter wallet not found")).kind).toBe("unavailable");
  });
});
