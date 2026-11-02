import { describe, expect, it } from "vitest";
import { UserRejectsError } from "@tonconnect/sdk";
import { UserRejectedRequestError } from "viem";
import { isWalletRefusal } from "./wallet-refusal";
import { WithdrawPublishUnknownError, WithdrawRelayRejectedError } from "./withdraw-errors";

// What these tests defend (D-433, cross-review 020-4): each family's own refusal reads as the
// user's «no», and nothing else does — above all not a refusal by the relay, whose detail support needs.

describe("isWalletRefusal — each family's refusal", () => {
  it("EVM: viem's own UserRejectedRequestError", () => {
    expect(isWalletRefusal(new UserRejectedRequestError(new Error("User rejected the request.")))).toBe(true);
  });

  it("EVM / Solana: a bare EIP-1193 code 4001", () => {
    expect(isWalletRefusal(Object.assign(new Error("Request failed"), { code: 4001 }))).toBe(true);
  });

  it("Solana (Phantom): the message alone", () => {
    expect(isWalletRefusal(new Error("User rejected the request."))).toBe(true);
  });

  it("TON: the SDK's real UserRejectsError, whose `name` is just «Error»", () => {
    const e = new UserRejectsError();
    expect(e.name).toBe("Error");
    expect(isWalletRefusal(e)).toBe(true);
  });

  it("TronLink: a bare string, not an Error", () => {
    expect(isWalletRefusal("Confirmation declined by user")).toBe(true);
  });

  it("Freighter: «User declined access»", () => {
    expect(isWalletRefusal(new Error("User declined access"))).toBe(true);
  });

  it("a refusal wrapped by our own code, read through the cause chain", () => {
    const wrapped = new Error("signing failed", { cause: new UserRejectsError() });
    expect(isWalletRefusal(wrapped)).toBe(true);
  });
});

describe("isWalletRefusal — what is never the user's «no»", () => {
  it("a relay refusal, even when the reason it quotes mentions a user refusal", () => {
    const relay = new WithdrawRelayRejectedError("UNKNOWN_ERROR", "The user denied the request");
    expect(relay.message).toMatch(/user denied/i);
    expect(isWalletRefusal(relay)).toBe(false);
  });

  it("a relay refusal anywhere in the cause chain", () => {
    const relay = new WithdrawRelayRejectedError("UNKNOWN_ERROR", "User rejected");
    expect(isWalletRefusal(new Error("publish failed", { cause: relay }))).toBe(false);
  });

  it("ordinary failures", () => {
    expect(isWalletRefusal(new Error("Failed to fetch"))).toBe(false);
    expect(isWalletRefusal(new WithdrawPublishUnknownError("timeout"))).toBe(false);
    expect(isWalletRefusal("Network error")).toBe(false);
    expect(isWalletRefusal(undefined)).toBe(false);
    expect(isWalletRefusal(null)).toBe(false);
  });
});
