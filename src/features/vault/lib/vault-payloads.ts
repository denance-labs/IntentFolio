// Builders for the money-critical, vault-specific message bodies that the FE must emit
// byte-for-byte as the contract's serde serialises them (007.plan, Phase 0). A single
// wrong field orphans funds (Transfer settles, on_auth fails), so these are pinned against
// Rust golden vectors (contract/crates/vault/tests/golden_vectors.rs) in the sibling test.
//
// Key ORDER matters: JSON.stringify emits string keys in insertion order, and the contract
// serialises struct fields in declaration order with no whitespace. Every object literal
// below mirrors the exact field order of the Rust type. Do not reorder.
//
// Attribution: see ATTRIBUTIONS.md #8 (IntentFolio vault contract serde — types.rs / golden_vectors.rs;
// AllocateInto against tag `vault-staging-v1`).
//
// These produce the vault-specific bodies only:
//   - AuthCallMsg (Setup or AllocateInto) → goes (as a string) into the `auth_call.msg` intent
//     of an Allocate.
//   - PortfolioChangeSet → the message of a `commit_portfolio_changes` (Unallocate, composition
//     edits, and on v2 a rename or a signed delete).
// The NEP-413 envelope + MultiPayload assembly around them is standard (contract-types).

// ChainKind serialises lowercase (types.rs #[serde(rename_all = "lowercase")]).
export type VaultChainKind = "near" | "evm" | "solana" | "ton" | "stellar" | "tron";

export type TokenCompositionInput = {
  tokenId: string;
  targetBps: number;
  toleranceBps: number;
};

// U128 amounts cross as decimal strings (base units), never JS numbers.
export type AllocationInput = { tokenId: string; amount: string };

export type BuildAuthCallSetupParams = {
  deadline: number; // unix seconds (u64)
  nonce: number[]; // [u8; 32] — 32 bytes as numbers
  chain: VaultChainKind;
  address: string;
  portfolioName: string;
  composition: TokenCompositionInput[];
  allocations: AllocationInput[];
};

// AuthCallMsg with op = AllocateOp::Setup. Returned as the canonical JSON STRING, because
// that is exactly what lands in `auth_call.msg` (and what the contract sha256's, D-160).
export function buildAuthCallSetupMsg(p: BuildAuthCallSetupParams): string {
  return JSON.stringify({
    deadline: p.deadline,
    nonce: p.nonce,
    op: {
      setup: {
        login_wallet: { chain: p.chain, address: p.address },
        portfolio_name: p.portfolioName,
        composition: p.composition.map((c) => ({
          token_id: c.tokenId,
          target_bps: c.targetBps,
          tolerance_bps: c.toleranceBps,
        })),
        allocations: p.allocations.map((a) => [a.tokenId, a.amount]),
      },
    },
  });
}

export type BuildAuthCallAllocateIntoParams = {
  deadline: number; // unix seconds (u64)
  nonce: number[]; // [u8; 32] — 32 bytes as numbers
  portfolioId: string;
  /** Retarget tokens ALREADY in the composition. */
  targetChanges?: TokenCompositionInput[];
  /** Add tokens NOT in the composition. `targetBps` must be 0 (rule 2, §7.1). */
  tokenAdditions?: TokenCompositionInput[];
  tokenRemovals?: string[];
  allocations: AllocationInput[];
};

// AuthCallMsg with op = AllocateOp::AllocateInto (D-321): funds into a portfolio the signer
// already owns, optionally with composition edits in the same signature. No `login_wallet`:
// the vault checks `portfolio.owner == signer_id`, and the Verifier authenticated the signer.
// Unlike Setup it carries the composition as a CHANGE SET (tuples, validated by
// `validate_change_set`), not as a full composition of objects — the same encoding as
// `buildCommitChangeSet`. Every list is emitted even when empty, in the Rust declaration order.
export function buildAuthCallAllocateIntoMsg(p: BuildAuthCallAllocateIntoParams): string {
  const composition = (rows: TokenCompositionInput[] | undefined) =>
    (rows ?? []).map((c) => [c.tokenId, c.targetBps, c.toleranceBps]);

  return JSON.stringify({
    deadline: p.deadline,
    nonce: p.nonce,
    op: {
      allocate_into: {
        portfolio_id: p.portfolioId,
        target_changes: composition(p.targetChanges),
        token_additions: composition(p.tokenAdditions),
        token_removals: p.tokenRemovals ?? [],
        allocations: p.allocations.map((a) => [a.tokenId, a.amount]),
      },
    },
  });
}

export type UnallocateInput = { tokenId: string; amount: string };

export type BuildCommitChangeSetParams = {
  portfolioId: string;
  /** Retarget tokens ALREADY in the composition. */
  targetChanges?: TokenCompositionInput[];
  /** Add tokens NOT in the composition, each with its target (Appendix D.2, FE #6). */
  tokenAdditions?: TokenCompositionInput[];
  /** Drop tokens from the composition; may be coupled to an unallocation of the same token. */
  tokenRemovals?: string[];
  unallocations?: UnallocateInput[];
  /**
   * Rename (v2 only, 017-9c). Emitted only when set: the contract declares it
   * `skip_serializing_if = "Option::is_none"`, so a change set without it is the v1 pre-image.
   */
  name?: string;
  /**
   * Delete the (empty) portfolio (v2 only, C-9 / ADR-0023). Must ride alone — the contract
   * answers `E_INVALID_COMPOSITION` to a delete carrying anything else. Emitted only when true.
   */
  delete?: boolean;
};

// PortfolioChangeSet for `commit_portfolio_changes`. Returned as a plain object: the commit
// envelope flattens it next to signer_id + deadline before signing, so the caller composes
// it — unlike AuthCallMsg it is not stringified on its own here.
//
// Every list is emitted even when empty, and ALWAYS in the declaration order of the Rust
// struct (types.rs `PortfolioChangeSet`). Both are load-bearing: serde needs the fields
// present, and the signed bytes are order-sensitive.
//
// A pure Unallocate is just this with the three composition lists empty — which is what
// Phase 2 (008.plan) turned from "the only shape" into "one shape".
//
// The two v2 fields are the exception to "every field, always": `name` and `delete` are
// optional on the Rust side (`skip_serializing_if`), so they appear only when set, after
// `unallocations` and in that order (types.rs; golden vectors `_rename_only` and `_delete`).
// Emitting `"delete":false` or `"name":null` would still parse, but it is not the pre-image
// the contract's own serializer produces, and the vectors pin that one.
export function buildCommitChangeSet(p: BuildCommitChangeSetParams): Record<string, unknown> {
  const composition = (rows: TokenCompositionInput[] | undefined) =>
    (rows ?? []).map((c) => [c.tokenId, c.targetBps, c.toleranceBps]);

  const changeSet: Record<string, unknown> = {
    portfolio_id: p.portfolioId,
    target_changes: composition(p.targetChanges),
    token_additions: composition(p.tokenAdditions),
    token_removals: p.tokenRemovals ?? [],
    unallocations: (p.unallocations ?? []).map((u) => [u.tokenId, u.amount]),
  };
  if (p.name !== undefined) changeSet.name = p.name;
  if (p.delete === true) changeSet.delete = true;
  return changeSet;
}
