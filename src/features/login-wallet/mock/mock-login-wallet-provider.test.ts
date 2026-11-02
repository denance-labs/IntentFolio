// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { deterministicSign } from "./mock-login-wallet-provider";

function setSignParam(value: string | null) {
  const search = value === null ? "" : `?sign=${value}`;
  window.history.replaceState({}, "", `/mock-dashboard/composition${search}`);
}

afterEach(() => setSignParam(null));

describe("deterministicSign (mock signer, 5.5-D)", () => {
  it("returns a deterministic signature on the default/ok path", async () => {
    setSignParam(null);
    const sig = await deterministicSign("hello");
    expect(sig).toEqual({
      scheme: "nep413",
      payload: "hello",
      signature: "mock-signature",
      publicKey: "ed25519:mock",
    });

    setSignParam("ok");
    await expect(deterministicSign("again")).resolves.toMatchObject({ payload: "again" });
  });

  it("throws a user-rejection error for ?sign=reject (→ cancel state)", async () => {
    setSignParam("reject");
    await expect(deterministicSign("x")).rejects.toThrow(/rejected/i);
  });

  it("throws a wallet-unavailable error for ?sign=locked (→ unavailable state)", async () => {
    setSignParam("locked");
    await expect(deterministicSign("x")).rejects.toThrow(/not connected/i);
  });

  it("throws an unexpected error for ?sign=error (→ error state)", async () => {
    setSignParam("error");
    await expect(deterministicSign("x")).rejects.toThrow(/failure/i);
  });
});
