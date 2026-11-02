import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@defuse-protocol/internal-utils", () => ({
  authIdentity: {
    // Real lib returns the bare identifier with NO chain prefix (D-133): lowercase for
    // near/evm/ton, a hex transform for solana/stellar/tron. This mock approximates it as a
    // lowercase passthrough — the wrapper's contract is "forward the method + return lib output",
    // not to reproduce the lib's per-family transform (verified by source inspection, D-133).
    authHandleToIntentsUserId: vi.fn(
      (identifier?: string) => (identifier ?? "").toLowerCase(),
    ),
  },
}));

// Import after mock is set up.
const { deriveIntentsAccountId, WalletAccountMismatchError } = await import("./identity");
const { authIdentity } = await import("@defuse-protocol/internal-utils");

const spy = authIdentity.authHandleToIntentsUserId as ReturnType<typeof vi.fn>;

describe("deriveIntentsAccountId", () => {
  beforeEach(() => spy.mockClear());

  it("passes 'near' method for NEAR addresses", () => {
    const result = deriveIntentsAccountId("bob.near", "near");
    expect(spy).toHaveBeenCalledWith("bob.near", "near");
    expect(result).toBe("bob.near");
  });

  it("passes 'evm' method for EVM addresses", () => {
    const result = deriveIntentsAccountId("0xabc123", "evm");
    expect(spy).toHaveBeenCalledWith("0xabc123", "evm");
    expect(result).toBe("0xabc123");
  });

  it("passes 'solana' method for Solana addresses", () => {
    const addr = "9vNNzVbHV1SqEaJGf9ZkJCJMKdJ7bJBh2XqA6N5xKHn";
    const result = deriveIntentsAccountId(addr, "solana");
    expect(spy).toHaveBeenCalledWith(addr, "solana");
    expect(result).toBe(addr.toLowerCase());
  });

  it("passes 'ton' method with hex publicKey (not the EQ address)", () => {
    const pk = "a".repeat(64);
    const result = deriveIntentsAccountId(pk, "ton");
    expect(spy).toHaveBeenCalledWith(pk, "ton");
    expect(result).toBe(pk);
  });

  it("passes 'stellar' method for Stellar G… addresses", () => {
    const result = deriveIntentsAccountId("GDXY4WR5STELLAR", "stellar");
    expect(spy).toHaveBeenCalledWith("GDXY4WR5STELLAR", "stellar");
    expect(result).toBe("gdxy4wr5stellar");
  });

  it("passes 'tron' method for Tron T… addresses", () => {
    const result = deriveIntentsAccountId("TXjxDCLkHMcx", "tron");
    expect(spy).toHaveBeenCalledWith("TXjxDCLkHMcx", "tron");
    expect(result).toBe("txjxdclkhmcx");
  });

  it("returns the value from authHandleToIntentsUserId as IntentsAccountId", () => {
    spy.mockReturnValueOnce("custom-derived-id");
    const result = deriveIntentsAccountId("any", "near");
    expect(result).toBe("custom-derived-id");
  });
});

// The operator hit this for real on 2026-08-06 (008.plan F4.2): the guard correctly stopped
// a withdrawal, but the message named two 64-hex derived account ids — values that appear
// nowhere in the wallet UI — so it did not say which wallet to switch back to.
describe("WalletAccountMismatchError message", () => {
  const EXPECTED = "aa2a80ecd2b9857d07dae2ca23a60d3f72cf8b6432e207c55827e118ca84dceb";
  const CONNECTED = "32ec4badb6c92bef959aa13dc45cefea3d8dc1f9a4430ac0eebb1668106db325";
  const W1 = "CTFu9LhCQ63WyT4NcLyZ6Y6bfDE7ybr2f6jWFPbiCN58";
  const W2 = "4RnNDzg8swniEBpf7rxCYQQ4HfPGKmnEKbJZrXYoCAT6";

  it("names both wallets by address when addresses are supplied", () => {
    const e = new WalletAccountMismatchError(
      EXPECTED as never,
      CONNECTED,
      { expectedAddress: W1, connectedAddress: W2 },
    );
    expect(e.message).toContain("CTFu9LhC…biCN58");
    expect(e.message).toContain("4RnNDzg8…YoCAT6");
    // The raw derived ids must not be what the user is asked to reason about.
    expect(e.message).not.toContain(EXPECTED);
    expect(e.message).not.toContain(CONNECTED);
  });

  it("falls back to the account-id wording when no addresses are available", () => {
    const e = new WalletAccountMismatchError(EXPECTED as never, CONNECTED);
    expect(e.message).toContain(EXPECTED);
    expect(e.message).toContain(CONNECTED);
  });

  it("keeps the two addresses distinguishable after truncation", () => {
    const e = new WalletAccountMismatchError(
      EXPECTED as never,
      CONNECTED,
      { expectedAddress: W1, connectedAddress: W2 },
    );
    const shown = e.message.match(/[A-Za-z0-9]{8}…[A-Za-z0-9]{6}/g) ?? [];
    expect(new Set(shown).size).toBe(2);
  });
});
