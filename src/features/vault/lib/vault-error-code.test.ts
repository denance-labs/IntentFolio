import { describe, expect, it } from "vitest";
import { classifyCommitFailure, parseVaultErrorCode } from "./vault-error-code";

// The panic is exactly the code (Appendix D.8), wrapped by the runtime. 017-9b, D-302 f/j.
const panic = (code: string) => `{"ActionError":{"index":0,"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: ${code}"}}}}`;

describe("parseVaultErrorCode", () => {
  it("reads the bare code out of the runtime's wrapper, wherever it sits in the text", () => {
    expect(parseVaultErrorCode("Smart contract panicked: E_PAUSED")).toBe("E_PAUSED");
    expect(parseVaultErrorCode(panic("E_INSUFFICIENT_PORTFOLIO_BALANCE"))).toBe("E_INSUFFICIENT_PORTFOLIO_BALANCE");
  });

  it("answers null for a failure that carries no vault code", () => {
    expect(parseVaultErrorCode("WebAssembly trap: An `unreachable` opcode was executed.")).toBeNull();
    expect(parseVaultErrorCode("E_PAUSED")).toBeNull(); // not the runtime's wording
    expect(parseVaultErrorCode("Smart contract panicked: requires attached deposit")).toBeNull();
  });
});

describe("classifyCommitFailure", () => {
  it.each([
    ["E_PORTFOLIO_NOT_EMPTY", "portfolio-not-empty"],
    ["E_PORTFOLIO_NOT_FOUND", "portfolio-not-found"],
    ["E_INSUFFICIENT_RESERVOIR", "reservoir"],
    ["E_PAUSED", "paused"],
    ["E_TOKEN_FROZEN", "token-frozen"],
    ["E_INSUFFICIENT_PORTFOLIO_BALANCE", "insufficient-balance"],
  ])("%s has its own copy", (code, refusal) => {
    expect(classifyCommitFailure(panic(code))).toBe(refusal);
  });

  // A replay of a commit that already applied answers exactly these (D-302 j).
  it.each(["E_NONCE_CONSUMED", "E_EXPIRED_DEADLINE"])("%s is not confirmed, never 'nothing moved'", (code) => {
    expect(classifyCommitFailure(panic(code))).toBe("unconfirmed");
  });

  it.each(["E_INVALID_COMPOSITION", "E_ACCOUNT_ID_MISMATCH", "E_CAP_EXCEEDED", "E_SOMETHING_NEW"])(
    "%s falls back to the generic line",
    (code) => {
      expect(classifyCommitFailure(panic(code))).toBeNull();
    }
  );

  it("a failure with no code at all is generic", () => {
    expect(classifyCommitFailure("Exceeded the prepaid gas.")).toBeNull();
  });
});
