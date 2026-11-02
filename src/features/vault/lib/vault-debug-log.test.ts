// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { VAULT_DEBUG_ENVELOPES_KEY, logSignedEnvelope, vaultEnvelopeLogEnabled } from "./vault-debug-log";

// D-472: off unless this browser opted in with exactly "1"; a storage that throws means off.
afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("vaultEnvelopeLogEnabled", () => {
  it("is off by default, and for any value other than \"1\"", () => {
    expect(vaultEnvelopeLogEnabled()).toBe(false);
    window.localStorage.setItem(VAULT_DEBUG_ENVELOPES_KEY, "true");
    expect(vaultEnvelopeLogEnabled()).toBe(false);
  });

  it("is on with \"1\"", () => {
    window.localStorage.setItem(VAULT_DEBUG_ENVELOPES_KEY, "1");
    expect(vaultEnvelopeLogEnabled()).toBe(true);
  });

  it("is off when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(vaultEnvelopeLogEnabled()).toBe(false);
  });
});

describe("logSignedEnvelope", () => {
  it("logs only when opted in", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    logSignedEnvelope("[vault] x", { a: 1 });
    expect(log).not.toHaveBeenCalled();
    window.localStorage.setItem(VAULT_DEBUG_ENVELOPES_KEY, "1");
    logSignedEnvelope("[vault] x", { a: 1 });
    expect(log).toHaveBeenCalledWith("[vault] x", { a: 1 });
  });
});
