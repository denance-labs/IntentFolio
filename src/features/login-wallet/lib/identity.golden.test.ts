import { describe, expect, it } from "vitest";
import { deriveIntentsAccountId, walletMatchesAccount } from "./identity";

// Unlike identity.test.ts (which mocks @defuse-protocol/internal-utils to test the
// wrapper's forwarding contract), this file makes NO mock — it exercises the real,
// pinned `authHandleToIntentsUserId@0.34.0` (see package.json / ATTRIBUTIONS.md #4).
//
// Purpose (H8.1a, portfolios/.claude/plans/006.h8.1-derivation-validation.md §4.A):
//   1. Pin the real per-family output (golden vectors) so a library version bump that
//      silently changes the derivation breaks CI instead of shipping.
//   2. Assert the structural shape the contract's binding depends on (H8.0,
//      contract/H8-KICKOFF.md §11): implicit-account families reduce to
//      hex(ed25519_pubkey) (64 lowercase hex), EVM-family families reduce to a
//      0x + 40-hex address — the same bytes `defuse_core::PublicKey::to_implicit_account_id()`
//      derives from the recovered signing key on-chain.

describe("deriveIntentsAccountId — golden vectors (real internal-utils@0.34.0)", () => {
  it("evm: lowercases the 0x address (secp256k1 family, converges with contract EVM-implicit binding)", () => {
    const result = deriveIntentsAccountId(
      "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      "evm",
    );
    expect(result).toBe("0xd8da6bf26964af9d7eed9e03e53415d37aa96045");
    expect(result).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it("solana: hex-encodes the base58 pubkey (ed25519 family, converges with contract near-implicit binding)", () => {
    const result = deriveIntentsAccountId(
      "So11111111111111111111111111111111111111112",
      "solana",
    );
    expect(result).toBe(
      "069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001",
    );
    // Not a fixed 64-hex length here: base58-decoded byte length varies with the
    // address's leading-zero encoding. The contract-relevant invariant is that
    // it's the raw hex of the decoded ed25519 pubkey bytes, lowercase.
    expect(result).toMatch(/^[0-9a-f]+$/);
  });

  it("ton: passes through the 64-char hex pubkey unchanged (identifier must be pubkey, not EQ/UQ address)", () => {
    const pubkeyHex = "a".repeat(64);
    const result = deriveIntentsAccountId(pubkeyHex, "ton");
    expect(result).toBe(pubkeyHex);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ton: rejects a non-64-char identifier (guards against the EQ/UQ-address mixup the adapter works around)", () => {
    expect(() => deriveIntentsAccountId("EQD4FPq-PRDieyQKkizFTRtSDyucUIqrj0v_zXJmqaDp6em7", "ton")).toThrow();
  });

  it("stellar: hex-encodes the decoded G… address (ed25519 family, converges with contract near-implicit binding)", () => {
    // "GAIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCF6M" is the real StrKey
    // (@stellar/stellar-base `encodeEd25519PublicKey`) of the 32-byte pubkey 0x11×32 —
    // generated once via the SDK already vendored for this project, not hand-typed.
    const result = deriveIntentsAccountId(
      "GAIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCF6M",
      "stellar",
    );
    expect(result).toBe("11".repeat(32));
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it("tron: converts the base58check T… address to the 0x-prefixed EVM-shape hex (secp256k1 family, converges with contract EVM-implicit binding)", () => {
    const result = deriveIntentsAccountId("TXjxDCLkHMcxErA2Wf7t3vB9F5C4bY3q7q", "tron");
    expect(result).toBe("0xeed103579d60dff646b9c1dd598e37c9ea20c2b0");
    expect(result).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it("near: lowercases a named account id as-is (no implicit-key reduction, matches the H8.0 named-account residual)", () => {
    const result = deriveIntentsAccountId("Bob.Near", "near");
    expect(result).toBe("bob.near");
  });

  it("near: passes a 64-hex implicit account id through unchanged (same shape as ed25519-family ids)", () => {
    const implicitId = "b".repeat(64);
    const result = deriveIntentsAccountId(implicitId, "near");
    expect(result).toBe(implicitId);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it("evm and tron addresses for the same underlying key converge to the same IntentsAccountId shape", () => {
    const evmId = deriveIntentsAccountId("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "evm");
    const tronId = deriveIntentsAccountId("TXjxDCLkHMcxErA2Wf7t3vB9F5C4bY3q7q", "tron");
    expect(evmId).toMatch(/^0x[0-9a-f]{40}$/);
    expect(tronId).toMatch(/^0x[0-9a-f]{40}$/);
  });
});

// Anti-squat pre-check (H8.1c): the FE mirror of the contract's apply_setup guard
// (`authHandleToIntentsUserId(login_wallet) == signer_id`, allocate.rs:154). Exercised
// against the real derivation — a false here is the fail-fast that stops a signature the
// contract would bounce.
describe("walletMatchesAccount — anti-squat pre-check (real internal-utils@0.34.0)", () => {
  it("returns true when the wallet derives to the expected account (EVM)", () => {
    const address = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
    const expected = deriveIntentsAccountId(address, "evm");
    expect(walletMatchesAccount(address, "evm", expected)).toBe(true);
  });

  it("is case-insensitive on the expected id (EVM derivation lowercases the address)", () => {
    // The wallet may hand back a checksummed 0x address while the account in scope is the
    // already-lowercased derived id — they must still match.
    expect(
      walletMatchesAccount(
        "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
        "evm",
        "0xD8DA6BF26964AF9D7EED9E03E53415D37AA96045" as never,
      ),
    ).toBe(true);
  });

  it("returns false when the live wallet resolves to a DIFFERENT account (the A-vs-B seam)", () => {
    // Restored identity A (a Solana account) but the live wallet is EVM B — the mismatch
    // the pre-check exists to catch before signing.
    const accountA = deriveIntentsAccountId("So11111111111111111111111111111111111111112", "solana");
    expect(
      walletMatchesAccount("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "evm", accountA),
    ).toBe(false);
  });

  it("returns false when derivation throws (TON identifier that is not a 64-hex pubkey)", () => {
    expect(
      walletMatchesAccount("EQD4FPq-PRDieyQKkizFTRtSDyucUIqrj0v_zXJmqaDp6em7", "ton", "anything" as never),
    ).toBe(false);
  });

  it("matches a named NEAR account against itself (named accounts are accepted, H8.1c)", () => {
    // Named accounts are a nuisance-only residual (H8.0): the binding does not reduce them
    // to an implicit key, but the FE check still holds — login `alice.near` for account
    // `alice.near` is a valid match, so onboarding does not block them.
    expect(walletMatchesAccount("Alice.Near", "near", "alice.near" as never)).toBe(true);
  });
});
