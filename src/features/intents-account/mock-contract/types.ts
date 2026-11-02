// Contract-facing types shared by login-wallet (Signature) and the mock/vault contract (3.11+).
// Signature union verified against NEAR Intents Verifier docs (2026-05-27): 7 supported schemes.
// "ton_connect" is structured (separate fields) — the TON adapter serializes the human-readable
// message into the TonConnect proof shape; the Verifier reads each field individually.

export type ChainKind = "near" | "evm" | "solana" | "ton" | "stellar" | "tron";

export type IntentsAccountId = string;

// A token IS its Defuse asset id — `nep141:<contract>` (fungible) or
// `nep245:<contract>:<id>` (multi-token); the id the NEP-245 Verifier and bridge
// use. There is no "canonical" grouping: USDC(ETH) and USDC(SOL) are distinct
// TokenIds the user sees and targets separately. Display labels like
// "USDC (Ethereum)" are FE metadata only. Renamed from `TokenId`
// (a misnomer — the values were already asset ids) per root ADR-0007.
export type TokenId = string;

export type PortfolioId = string;

export type Signature =
  | { scheme: "nep413"; payload: string; signature: string; publicKey: string }
  | { scheme: "erc191"; payload: string; signature: string; publicKey?: string }
  | { scheme: "tip191"; payload: string; signature: string; publicKey?: string }
  | { scheme: "raw_ed25519"; payload: string; signature: string; publicKey: string }
  | { scheme: "sep53"; payload: string; signature: string; publicKey: string }
  | { scheme: "webauthn"; payload: string; signature: string; publicKey: string; clientDataJson: string; authenticatorData: string }
  | { scheme: "ton_connect"; address: string; domain: string; timestamp: string; text: string; signature: string; publicKey: string };

export type PortfolioChangeSet = {
  targetChanges?: Array<{ tokenId: TokenId; newTargetPct: number; newTolerancePct: number }>;
  tokenAdditions?: Array<{ tokenId: TokenId; initialTargetPct: number; initialTolerancePct: number }>;
  tokenRemovals?: Array<{ tokenId: TokenId }>;
  allocations?: Array<{ tokenId: TokenId; qty: number }>;
  unallocations?: Array<{ tokenId: TokenId; qty: number }>;
};

// Event log shape (7.0). Two cross-cutting identifiers on every event:
//   event_id  — unique per emitted event (React keys, filters, dedup).
//   commit_id — groups the events of a single Portfolio Commit (one signature =
//               one logical history entry, D-082). Present ONLY on the events that
//               belong to a Portfolio Commit; absent on bridge deposits (receive),
//               the separately-signed withdraw, and Solver-driven rebalances, which
//               are independent entries.
// Lean by design: no before/after composition snapshot, no `reason`, no USD price.
// Those are presentation-layer concerns (the indexer's job in E8) — see
// event-presentation-store.ts and history-mapper.ts.
export type ContractEvent =
  | { kind: "register_user"; event_id: string; commit_id: string; account_id: IntentsAccountId; ts: number }
  // `source: "wallet"`: sent from the user's NEAR wallet (016 §5.3), not through a bridge address.
  // The bridge never lists those, so this ledger is where My Account's activity reads them from.
  | { kind: "receive"; event_id: string; account_id: IntentsAccountId; token: TokenId; qty: number; chain: string; bridge_tx: string; ts: number; source?: "wallet" }
  | { kind: "allocate"; event_id: string; commit_id: string; account_id: IntentsAccountId; portfolio_id: PortfolioId; token: TokenId; qty: number; ts: number }
  | { kind: "unallocate"; event_id: string; commit_id: string; account_id: IntentsAccountId; portfolio_id: PortfolioId; token: TokenId; qty: number; ts: number }
  | { kind: "target_change"; event_id: string; commit_id: string; account_id: IntentsAccountId; portfolio_id: PortfolioId; token: TokenId; old_target_pct: number; new_target_pct: number; old_tolerance_pct: number; new_tolerance_pct: number; ts: number }
  | { kind: "token_added"; event_id: string; commit_id: string; account_id: IntentsAccountId; portfolio_id: PortfolioId; token: TokenId; initial_target_pct: number; initial_tolerance_pct: number; ts: number }
  | { kind: "token_removed"; event_id: string; commit_id: string; account_id: IntentsAccountId; portfolio_id: PortfolioId; token: TokenId; ts: number }
  // A real portfolio's new target as the user signed it (028-7, D-489): absolute, with no "before".
  | { kind: "target_set"; event_id: string; commit_id: string; account_id: IntentsAccountId; portfolio_id: PortfolioId; token: TokenId; target_pct: number; tolerance_pct: number; ts: number }
  // A real portfolio's composition edit as the final vault reports it: only the ids, no detail (D-422).
  | { kind: "composition_changed"; event_id: string; commit_id: string; account_id: IntentsAccountId; portfolio_id: PortfolioId; ts: number }
  | { kind: "portfolio_created"; event_id: string; commit_id: string; account_id: IntentsAccountId; portfolio_id: PortfolioId; name: string; ts: number }
  // A real Setup's Storage Cost (D-528, D-539): its `transfer` to the ops account, shown with the creation it paid for.
  | { kind: "storage_cost"; event_id: string; commit_id: string; account_id: IntentsAccountId; portfolio_id: PortfolioId; token: TokenId; qty: number; ts: number }
  | { kind: "portfolio_deleted"; event_id: string; commit_id: string; account_id: IntentsAccountId; portfolio_id: PortfolioId; ts: number }
  | { kind: "withdraw"; event_id: string; account_id: IntentsAccountId; token: TokenId; qty: number; destination_chain: ChainKind; destination_address: string; ts: number }
  | { kind: "external_rebalance"; event_id: string; account_id: IntentsAccountId; portfolio_id: PortfolioId; token_in: TokenId; qty_in: number; token_out: TokenId; qty_out: number; attributed_spread: number; ts: number }
  | { kind: "forced_internal_rebalance"; event_id: string; account_id: IntentsAccountId; portfolio_id: PortfolioId; token_in: TokenId; qty_in: number; token_out: TokenId; qty_out: number; ts: number };

export type PortfolioRecord = {
  id: PortfolioId;
  name: string;
  composition: Array<{ tokenId: TokenId; targetPct: number; tolerancePct: number }>;
  // Set only on a portfolio MIRRORED from the live vault (007.plan Phase 1, flag
  // NEXT_PUBLIC_VAULT_ROUNDTRIP). `id` is then the REAL on-chain portfolio id, and the
  // vault — not this mock — is the source of truth for its balances.
  //
  // Load-bearing beyond the badge: available General Balance is computed as
  // (real on-chain total − allocations recorded here). A real Allocate ALREADY moved the
  // funds out of the on-chain balance, so counting a mirrored portfolio's allocations
  // again would subtract them twice. Consumers must skip mirrored portfolios in that sum —
  // see use-available-general-balance.ts.
  isReal?: boolean;
};

export type IntentsAccountRecord = {
  id: IntentsAccountId;
  registeredAt: number;
  portfolios: PortfolioRecord[];
};

// UNCONFIRMED is the one status the mock never produces (005.plan §8, block 5.4). It exists
// because the real path has an outcome the mock has no concept of: published — possibly
// already settled — but no delivery observed before we stopped watching. Our timeouts bound
// what we REPORT, never what the relay and the bridge do, so this is NOT a failure and must
// never share FAILED's copy or colour. Reporting a loss that did not happen is the one
// mistake this whole phase is built to avoid.
export type WithdrawalStatusKind =
  | "PENDING"
  | "TX_BROADCASTED"
  | "SETTLED"
  | "DELIVERED"
  | "UNCONFIRMED"
  | "FAILED"
  // A Converting Withdrawal 1Click sent back to the General Balance (plan 020 §5.4). Resolved,
  // and never FAILED's copy: the money moved twice and is home, it did not fail to move.
  | "REFUNDED";

export type WithdrawalInFlightRecord = {
  intentId: string;
  tokenId: TokenId;
  qty: number;
  chainId: string;
  destinationAddress: string;
  status: WithdrawalStatusKind;
  ts: number;
  txHash?: string;            // the NEAR settlement transaction
  destinationTxHash?: string; // set when DELIVERED
  // Converting Withdrawals only: what arrives on `chainId` — another member of `tokenId`'s Asset
  // Family (plan 020). Absent on a direct withdrawal, where `tokenId` itself goes out.
  deliveryTokenId?: TokenId;
  // Converting Withdrawals only: 1Click's deposit address — the code a user quotes if the
  // withdrawal stays unconfirmed (plan 020 §5.4). It is what `/v0/status` is asked about.
  depositAddress?: string;
  // Converting Withdrawals only: base units of `deliveryTokenId` 1Click reports as delivered —
  // what the "delivered" toast shows, since `qty` is what was SENT (before network costs).
  deliveredAmountRaw?: string;
  // True when this row is a REAL withdrawal driven by `runRealWithdraw`. The only consumer
  // that must branch on it is `usePendingWithdrawals`, which schedules the mock progression
  // timers: firing those against a real withdrawal would overwrite an observed status with
  // an invented one. Absent/false keeps the mock behaviour bit for bit.
  isReal?: boolean;
  // D-463 (023-B): known to have LEFT the General Balance even without a settlement transaction
  // (`intents.near` says the nonce was used). Tells "delivery not confirmed" apart from "we do not
  // know whether it went through" on a row the user may hide. A `txHash` implies it too.
  leftBalance?: boolean;
};

// C1 — Unallocate as an asynchronous, non-atomic settlement leg.
// A Portfolio Commit applies composition + allocations atomically in the vault, but each
// unallocation moves funds in intents.near (cross-contract, async) so it settles separately.
// Until it settles, the qty stays RESERVED inside the portfolio balance (so the available
// General Balance does not rise yet — the realistic lag). See 002.proximos-pasos C1.
//   PENDING → SETTLED : funds move portfolio → General Balance; an `unallocate` event is emitted.
//   PENDING → FAILED  : the async leg reverted; funds stay safely in the portfolio (retry).
// Net invariant (R-006): a pending unallocation's funds always end up either available
// (SETTLED) or still in the portfolio (FAILED) — never in limbo, never consumed by a quote.
export type UnallocationStatusKind = "PENDING" | "SETTLED" | "FAILED";

export type PendingUnallocationRecord = {
  unallocationId: string;     // drives deterministic timing/failure (mirrors withdrawal intentId)
  accountId: IntentsAccountId;
  portfolioId: PortfolioId;
  tokenId: TokenId;
  qty: number;
  commitId: string;           // preserves the originating Portfolio Commit grouping (D-082)
  status: UnallocationStatusKind;
  ts: number;                 // when the commit registered the pending leg
  reserveDeadline: number;    // ts by which the solver reserve frees at the latest (= reserve TTL)
};
