import type {
  IntentsAccountId,
  TokenId,
  PortfolioId,
  ChainKind,
  Signature,
  PortfolioChangeSet,
  ContractEvent,
  IntentsAccountRecord,
  PortfolioRecord,
  WithdrawalStatusKind,
  WithdrawalInFlightRecord,
  PendingUnallocationRecord,
} from "./types";
import {
  evaluatePortfolioRules,
  firstError,
  TOLERANCE_MIN_PCT,
  TOLERANCE_MAX_PCT,
  type CompositionEntry,
  type RuleViolation,
} from "./rules";
import { appPortfolioCap } from "@/features/vault/lib/change-set-preflight";
import { RealChangeSetInvalidError, VaultCommitRevertedError } from "@/features/vault/lib/vault-errors";

const STORAGE_KEY = "mock-contract:v1";

// Matched by name in `normalizeWalletError` so a contract refusal is never read as a wallet error.
export class ContractError extends Error {
  name = "ContractError";
}

// C1 — compressed reserve TTL for the mock. Real reserves on intents.near can be held for
// minutes (operator example: ~3 min); compressed here so demos/QA don't stall. The per-leg
// settle timing (fast vs. extended-to-deadline vs. failed) lives in use-pending-unallocations.
// This is exactly the variable B1 must pin down (reserve model / TTL) — C1 is its lab.
const RESERVE_TTL_MS = 90_000;

type PortfolioState = PortfolioRecord & {
  balances: Record<TokenId, number>;
};

type AccountState = {
  id: IntentsAccountId;
  registeredAt: number;
  generalBalance: Record<TokenId, number>;
  portfolios: PortfolioState[];
  events: ContractEvent[];
  // C1: persisted so a pending unallocation survives reload (the hook settles past-deadline
  // ones on load — durability guarantee). Older persisted accounts lack it → default to [].
  pendingUnallocations?: PendingUnallocationRecord[];
};

// Contract-facing English string for the first error-severity violation.
// Kept here (not in rules.ts) so the pure rules module stays message-agnostic.
function ruleViolationToMessage(v: RuleViolation): string {
  switch (v.code) {
    case "empty-composition":
      return "Composition must have at least 1 token";
    case "sum-not-100":
      return `Composition must sum to 100% (got ${(v.context?.sum ?? 0).toFixed(2)}%)`;
    case "no-target-above-zero":
      return "Portfolio must have at least 1 token with target > 0%";
    case "zero-target-zero-balance":
      return `Token ${v.tokenId} has 0% target and 0 balance — remove it from composition`;
    case "no-funded-token":
      return "Portfolio must have at least 1 token with balance > 0";
    case "tolerance-below-min":
      return `Token ${v.tokenId} tolerance must be at least ${TOLERANCE_MIN_PCT}%`;
    case "tolerance-above-max":
      return `Token ${v.tokenId} tolerance must be at most ${TOLERANCE_MAX_PCT}%`;
    case "tolerance-high":
      // Soft warning — never surfaced as a gate error (firstError skips it).
      return "";
  }
}

// Authoritative commit gate. Delegates the predicates to the shared rules module
// (single source of truth, anti-drift) and adapts the first error to a string.
// Exported so tests can validate invariants in isolation.
export function validatePortfolio(
  composition: CompositionEntry[],
  balances: Record<TokenId, number>
): string | null {
  const err = firstError(evaluatePortfolioRules(composition, balances));
  return err ? ruleViolationToMessage(err) : null;
}

type ApplyResult = {
  portfolio: PortfolioState;
  // positive = moved FROM general TO portfolio; negative = moved FROM portfolio TO general
  generalDelta: Record<TokenId, number>;
};

function applyChanges(portfolio: PortfolioState, changes: PortfolioChangeSet): ApplyResult {
  let composition = [...portfolio.composition];
  const balances = { ...portfolio.balances };
  const generalDelta: Record<TokenId, number> = {};

  for (const addition of changes.tokenAdditions ?? []) {
    if (!composition.find((c) => c.tokenId === addition.tokenId)) {
      composition.push({
        tokenId: addition.tokenId,
        targetPct: addition.initialTargetPct,
        tolerancePct: addition.initialTolerancePct,
      });
    }
  }

  for (const change of changes.targetChanges ?? []) {
    composition = composition.map((c) =>
      c.tokenId === change.tokenId
        ? { ...c, targetPct: change.newTargetPct, tolerancePct: change.newTolerancePct }
        : c
    );
  }

  const removedIds = new Set((changes.tokenRemovals ?? []).map((r) => r.tokenId));
  composition = composition.filter((c) => !removedIds.has(c.tokenId));

  for (const alloc of changes.allocations ?? []) {
    balances[alloc.tokenId] = (balances[alloc.tokenId] ?? 0) + alloc.qty;
    generalDelta[alloc.tokenId] = (generalDelta[alloc.tokenId] ?? 0) - alloc.qty;
  }

  for (const unalloc of changes.unallocations ?? []) {
    balances[unalloc.tokenId] = (balances[unalloc.tokenId] ?? 0) - unalloc.qty;
    generalDelta[unalloc.tokenId] = (generalDelta[unalloc.tokenId] ?? 0) + unalloc.qty;
  }

  return { portfolio: { ...portfolio, composition, balances }, generalDelta };
}

function applyGeneralDelta(
  general: Record<TokenId, number>,
  delta: Record<TokenId, number>
): Record<TokenId, number> {
  const result = { ...general };
  for (const [token, delta_] of Object.entries(delta)) {
    result[token as TokenId] = (result[token as TokenId] ?? 0) + delta_;
  }
  return result;
}

// uuid for both event_id (every event) and commit_id (per Portfolio Commit). 7.0.
const newId = (): string => crypto.randomUUID();

type CompositionRow = { tokenId: TokenId; targetPct: number; tolerancePct: number };

// Derives the composition-shape events of a Portfolio Commit (7.0). The mock used
// to mutate composition silently inside applyChanges; the event log now records each
// structural change so the History view (D-082) can replay a commit. Allocations and
// unallocations are emitted by the caller (they map 1:1 to the changeset). Emission
// order within a commit: token_added → target_change → token_removed (structure first).
function buildCompositionEvents(
  accountId: IntentsAccountId,
  portfolioId: PortfolioId,
  commitId: string,
  original: CompositionRow[],
  changes: PortfolioChangeSet,
  ts: number
): ContractEvent[] {
  const events: ContractEvent[] = [];
  const originalById = new Map(original.map((c) => [c.tokenId, c]));

  // Additions: only tokens not already present (mirrors applyChanges).
  for (const add of changes.tokenAdditions ?? []) {
    if (originalById.has(add.tokenId)) continue;
    events.push({
      kind: "token_added",
      event_id: newId(),
      commit_id: commitId,
      account_id: accountId,
      portfolio_id: portfolioId,
      token: add.tokenId,
      initial_target_pct: add.initialTargetPct,
      initial_tolerance_pct: add.initialTolerancePct,
      ts,
    });
  }

  // Target/band changes: old values come from the pre-change composition
  // (original plus any additions applied earlier in this same commit).
  const preChange = new Map(originalById);
  for (const add of changes.tokenAdditions ?? []) {
    if (!preChange.has(add.tokenId)) {
      preChange.set(add.tokenId, {
        tokenId: add.tokenId,
        targetPct: add.initialTargetPct,
        tolerancePct: add.initialTolerancePct,
      });
    }
  }
  for (const tc of changes.targetChanges ?? []) {
    const prev = preChange.get(tc.tokenId);
    events.push({
      kind: "target_change",
      event_id: newId(),
      commit_id: commitId,
      account_id: accountId,
      portfolio_id: portfolioId,
      token: tc.tokenId,
      old_target_pct: prev?.targetPct ?? 0,
      new_target_pct: tc.newTargetPct,
      old_tolerance_pct: prev?.tolerancePct ?? 0,
      new_tolerance_pct: tc.newTolerancePct,
      ts,
    });
  }

  // Removals.
  for (const rm of changes.tokenRemovals ?? []) {
    events.push({
      kind: "token_removed",
      event_id: newId(),
      commit_id: commitId,
      account_id: accountId,
      portfolio_id: portfolioId,
      token: rm.tokenId,
      ts,
    });
  }

  return events;
}

type WithdrawalTrackingData = {
  accountId: IntentsAccountId;
  tokenId: TokenId;
  qty: number;
  chainId: string;
  destinationAddress: string;
  status: WithdrawalStatusKind;
  ts: number;
  txHash?: string;
  destinationTxHash?: string;
  isReal?: boolean;
  deliveryTokenId?: TokenId;
  depositAddress?: string;
  deliveredAmountRaw?: string;
  leftBalance?: boolean;
};

class MockContractImpl {
  private accounts = new Map<IntentsAccountId, AccountState>();
  private loaded = false;
  private listeners = new Set<() => void>();
  private version = 0;
  // In-memory only — bridge status is authoritative; no LS persistence needed.
  private withdrawalTracking = new Map<string, WithdrawalTrackingData>();

  // Reactive subscription for useSyncExternalStore (5.3.0). Bound as arrow
  // properties so the identity stays stable across renders (a changing subscribe
  // identity would make React resubscribe every render) and `this` is correct
  // when the function is called detached from the instance.
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  // Monotonic version = the external-store snapshot. Bumped on every mutation so
  // consumers re-read the (otherwise non-reactive) localStorage-backed state.
  getVersion = (): number => this.version;

  private notify(): void {
    this.version++;
    this.listeners.forEach((listener) => listener());
  }

  private load(): void {
    if (this.loaded || typeof window === "undefined") return;
    this.loaded = true;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, AccountState>;
      for (const acc of Object.values(parsed)) this.accounts.set(acc.id, acc);
    } catch {
      // corrupt storage — start fresh
    }
  }

  private persist(): void {
    if (typeof window === "undefined") return;
    const obj: Record<string, AccountState> = {};
    for (const [id, acc] of this.accounts) obj[id] = acc;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  }

  private get(id: IntentsAccountId): AccountState | undefined {
    this.load();
    return this.accounts.get(id);
  }

  private push(acc: AccountState, ...events: ContractEvent[]): void {
    acc.events.push(...events);
    this.accounts.set(acc.id, acc);
    this.persist();
    this.notify();
  }

  _reset(): void {
    this.accounts.clear();
    this.withdrawalTracking.clear();
    this.loaded = true;
    if (typeof window !== "undefined") window.localStorage.removeItem(STORAGE_KEY);
    this.notify();
  }

  // ── Queries ──────────────────────────────────────────────────────────────

  getIntentsAccount(id: IntentsAccountId): IntentsAccountRecord | null {
    const acc = this.get(id);
    if (!acc) return null;
    return {
      id: acc.id,
      registeredAt: acc.registeredAt,
      // `isReal` must survive the projection: available-General-Balance math depends on it
      // to avoid double-subtracting a mirrored portfolio (007.plan Phase 1).
      portfolios: acc.portfolios.map(({ id, name, composition, isReal }) => ({
        id,
        name,
        composition,
        ...(isReal ? { isReal } : {}),
      })),
    };
  }

  getGeneralBalance(id: IntentsAccountId): Map<TokenId, number> {
    const acc = this.get(id);
    if (!acc) return new Map();
    return new Map(Object.entries(acc.generalBalance) as [TokenId, number][]);
  }

  getPortfolioBalance(id: IntentsAccountId, portfolioId: PortfolioId): Map<TokenId, number> {
    const portfolio = this.get(id)?.portfolios.find((p) => p.id === portfolioId);
    if (!portfolio) return new Map();
    return new Map(Object.entries(portfolio.balances) as [TokenId, number][]);
  }

  getEvents(id: IntentsAccountId, since?: number): ContractEvent[] {
    const events = this.get(id)?.events ?? [];
    return since !== undefined ? events.filter((e) => e.ts >= since) : [...events];
  }

  trackWithdrawal(
    intentId: string,
    data: {
      accountId: IntentsAccountId;
      tokenId: TokenId;
      qty: number;
      chainId: string;
      destinationAddress: string;
      ts: number;
      // Both optional and both defaulting to today's behaviour (block 5.4). `status` is
      // needed to hydrate a real withdrawal that was already past PENDING when the tab was
      // closed; `isReal` keeps the mock progression timers off it.
      status?: WithdrawalStatusKind;
      isReal?: boolean;
      /** Converting Withdrawals only (plan 020): the token that arrives. */
      deliveryTokenId?: TokenId;
      /** Converting Withdrawals only: 1Click's deposit address, shown as the row's code. */
      depositAddress?: string;
      /** Converting Withdrawals only: base units of the Delivery Token that arrived. */
      deliveredAmountRaw?: string;
      /** Known to have left the General Balance, settlement tx or not (D-463). */
      leftBalance?: boolean;
    }
  ): void {
    const { status = "PENDING", ...rest } = data;
    this.withdrawalTracking.set(intentId, { ...rest, status });
    this.notify();
  }

  getTrackedWithdrawals(accountId: IntentsAccountId): WithdrawalInFlightRecord[] {
    const result: WithdrawalInFlightRecord[] = [];
    for (const [intentId, data] of this.withdrawalTracking) {
      if (data.accountId !== accountId) continue;
      result.push({ intentId, ...data });
    }
    return result.sort((a, b) => b.ts - a.ts);
  }

  /** D-463 (023-B): the user hid this row. Its durable record says so; memory just forgets it. */
  untrackWithdrawal(intentId: string): void {
    if (!this.withdrawalTracking.delete(intentId)) return;
    this.notify();
  }

  refundWithdrawal(intentId: string): void {
    const data = this.withdrawalTracking.get(intentId);
    if (!data) return;
    const acc = this.accounts.get(data.accountId);
    if (acc) {
      // D-109: fee-on-failure open — return full qty; no fee deducted in mock.
      acc.generalBalance[data.tokenId] = (acc.generalBalance[data.tokenId] ?? 0) + data.qty;
      this.persist();
    }
    this.withdrawalTracking.set(intentId, { ...data, status: "FAILED" });
    this.notify();
  }

  setWithdrawalStatus(
    intentId: string,
    status: WithdrawalStatusKind,
    opts?: { txHash?: string; destinationTxHash?: string; deliveredAmountRaw?: string }
  ): void {
    const existing = this.withdrawalTracking.get(intentId);
    if (!existing) return;
    this.withdrawalTracking.set(intentId, {
      ...existing,
      status,
      ...(opts?.txHash !== undefined && { txHash: opts.txHash }),
      ...(opts?.destinationTxHash !== undefined && { destinationTxHash: opts.destinationTxHash }),
      ...(opts?.deliveredAmountRaw !== undefined && { deliveredAmountRaw: opts.deliveredAmountRaw }),
    });
    this.notify();
  }

  // ── Pending unallocations (C1: async settlement leg) ───────────────────────

  // All tracked pending unallocations for an account (PENDING + FAILED; SETTLED ones are
  // removed on settle). Newest first. The hook schedules per-record timers off reserveDeadline;
  // the balances UI reads it to show the "releasing inventory…" chip.
  getPendingUnallocations(accountId: IntentsAccountId): PendingUnallocationRecord[] {
    const acc = this.get(accountId);
    if (!acc) return [];
    return [...(acc.pendingUnallocations ?? [])].sort((a, b) => b.ts - a.ts);
  }

  // Completes a pending unallocation: moves the reserved qty from the portfolio to the General
  // Balance and emits the deferred `unallocate` event (original commit_id preserved). The record
  // is dropped once settled — the event log is now the record of truth.
  settleUnallocation(accountId: IntentsAccountId, unallocationId: string): void {
    const acc = this.get(accountId);
    if (!acc) return;
    const rec = acc.pendingUnallocations?.find((u) => u.unallocationId === unallocationId);
    if (!rec || rec.status !== "PENDING") return;

    const portfolio = acc.portfolios.find((p) => p.id === rec.portfolioId);
    if (portfolio) {
      // Clamp at the available reserved balance: a concurrent commit could have reduced it.
      const moved = Math.min(rec.qty, portfolio.balances[rec.tokenId] ?? 0);
      portfolio.balances[rec.tokenId] = (portfolio.balances[rec.tokenId] ?? 0) - moved;
      acc.generalBalance[rec.tokenId] = (acc.generalBalance[rec.tokenId] ?? 0) + moved;
    }
    acc.pendingUnallocations = (acc.pendingUnallocations ?? []).filter(
      (u) => u.unallocationId !== unallocationId
    );
    const event: ContractEvent = {
      kind: "unallocate",
      event_id: newId(),
      commit_id: rec.commitId,
      account_id: accountId,
      portfolio_id: rec.portfolioId,
      token: rec.tokenId,
      qty: rec.qty,
      ts: Date.now(),
    };
    this.push(acc, event);
  }

  // The async leg reverted (rare, ~25% deterministic by id). Funds stay in the portfolio (no
  // balance change → never lost); the record is marked FAILED so the UI can offer a retry.
  failUnallocation(accountId: IntentsAccountId, unallocationId: string): void {
    const acc = this.get(accountId);
    if (!acc) return;
    const rec = acc.pendingUnallocations?.find((u) => u.unallocationId === unallocationId);
    if (!rec || rec.status !== "PENDING") return;
    acc.pendingUnallocations = (acc.pendingUnallocations ?? []).map((u) =>
      u.unallocationId === unallocationId ? { ...u, status: "FAILED" as const } : u
    );
    this.persist();
    this.notify();
  }

  // ── Mutations ────────────────────────────────────────────────────────────

  // Receives the already-derived bare IntentsAccountId (D-133) — the mock no longer
  // re-derives; the single source of derivation is deriveIntentsAccountId (login-wallet lib).
  async initialSetup(
    accountId: IntentsAccountId,
    _signature: Signature,
    portfolioName: string,
    composition: Array<{ tokenId: TokenId; targetPct: number; tolerancePct: number }>,
    allocations: Array<{ tokenId: TokenId; qty: number }>
  ): Promise<{ accountId: IntentsAccountId; portfolioId: PortfolioId; events: ContractEvent[] }> {
    if (this.get(accountId)) throw new ContractError(`Account ${accountId} already exists`);

    const portfolioId = crypto.randomUUID();
    const balances: Record<TokenId, number> = {};
    const generalBalance: Record<TokenId, number> = {};

    for (const alloc of allocations) {
      balances[alloc.tokenId] = (balances[alloc.tokenId] ?? 0) + alloc.qty;
    }

    const err = validatePortfolio(composition, balances);
    if (err) throw new ContractError(err);

    const ts = Date.now();
    const commitId = newId();
    const events: ContractEvent[] = [
      { kind: "register_user", event_id: newId(), commit_id: commitId, account_id: accountId, ts },
      { kind: "portfolio_created", event_id: newId(), commit_id: commitId, account_id: accountId, portfolio_id: portfolioId, name: portfolioName, ts },
      // Initial composition tokens are additions to an empty portfolio.
      ...buildCompositionEvents(
        accountId,
        portfolioId,
        commitId,
        [],
        { tokenAdditions: composition.map((c) => ({ tokenId: c.tokenId, initialTargetPct: c.targetPct, initialTolerancePct: c.tolerancePct })) },
        ts
      ),
      ...allocations.map(
        (a): ContractEvent => ({
          kind: "allocate",
          event_id: newId(),
          commit_id: commitId,
          account_id: accountId,
          portfolio_id: portfolioId,
          token: a.tokenId,
          qty: a.qty,
          ts,
        })
      ),
    ];

    const acc: AccountState = {
      id: accountId,
      registeredAt: ts,
      generalBalance,
      portfolios: [{ id: portfolioId, name: portfolioName, composition, balances }],
      events: [],
    };
    this.push(acc, ...events);
    return { accountId, portfolioId, events };
  }

  async commitPortfolioChanges(
    id: IntentsAccountId,
    portfolioId: PortfolioId,
    changes: PortfolioChangeSet,
    _signature: Signature
  ): Promise<{ events: ContractEvent[] }> {
    const acc = this.get(id);
    if (!acc) throw new ContractError(`Account ${id} not found`);
    const portfolioIdx = acc.portfolios.findIndex((p) => p.id === portfolioId);
    if (portfolioIdx === -1) throw new ContractError(`Portfolio ${portfolioId} not found`);

    const originalComposition = acc.portfolios[portfolioIdx].composition;

    // The validation gate runs against the FINAL intended state (unallocations applied) — that
    // is what the user is committing to. The persisted state, however, DEFERS unallocations:
    // the funds stay RESERVED in the portfolio balance until each async leg settles (C1), so
    // the available General Balance does not rise yet (the realistic settlement lag).
    const { portfolio: finalState } = applyChanges(acc.portfolios[portfolioIdx], changes);
    const err = validatePortfolio(finalState.composition, finalState.balances);
    if (err) throw new ContractError(err);

    // Persisted now: composition + allocations only. Unallocations become pending claims below.
    const { portfolio: updated, generalDelta } = applyChanges(
      acc.portfolios[portfolioIdx],
      { ...changes, unallocations: undefined }
    );

    const ts = Date.now();
    const commitId = newId();
    // Composition-shape events (token_added / target_change / token_removed) first, then the
    // allocate moves — all sharing this commit_id (D-082). Unallocate events are emitted later,
    // when each pending leg settles (settleUnallocation), preserving this same commit_id.
    const events: ContractEvent[] = buildCompositionEvents(
      id,
      portfolioId,
      commitId,
      originalComposition,
      changes,
      ts
    );

    for (const alloc of changes.allocations ?? []) {
      events.push({ kind: "allocate", event_id: newId(), commit_id: commitId, account_id: id, portfolio_id: portfolioId, token: alloc.tokenId, qty: alloc.qty, ts });
    }

    // Each unallocation becomes a pending claim: the qty stays in the portfolio balance
    // (still counts as allocated → available General Balance unchanged) and settles async.
    const pending: PendingUnallocationRecord[] = (changes.unallocations ?? []).map((u) => ({
      unallocationId: newId(),
      accountId: id,
      portfolioId,
      tokenId: u.tokenId,
      qty: u.qty,
      commitId,
      status: "PENDING" as const,
      ts,
      reserveDeadline: ts + RESERVE_TTL_MS,
    }));

    acc.portfolios = acc.portfolios.map((p, i) => (i === portfolioIdx ? updated : p));
    acc.generalBalance = applyGeneralDelta(acc.generalBalance, generalDelta);
    acc.pendingUnallocations = [...(acc.pendingUnallocations ?? []), ...pending];
    this.push(acc, ...events);
    return { events };
  }

  async createPortfolio(
    id: IntentsAccountId,
    name: string,
    initialChanges: PortfolioChangeSet,
    _signature: Signature
  ): Promise<{ portfolioId: PortfolioId; events: ContractEvent[] }> {
    // Deferred registration (mirrors createEmptyPortfolio / creditReceive): a wallet
    // that already holds on-chain Intents balances but has not yet acted through the
    // mock (no deposit credited this session) has no account record. The atomic 5.6
    // create path is a valid first use, so register on demand instead of rejecting —
    // otherwise a real pre-funded account hits "Account … not found" right after signing.
    let acc = this.get(id);
    if (!acc) {
      acc = { id, registeredAt: Date.now(), generalBalance: {}, portfolios: [], events: [] };
    }

    // The real pre-flight's cap (D-361, D-476), with the same typed error it raises, so the
    // preview shows the same notice. Counts every portfolio the account holds, drafts included:
    // the mock keeps no separate list of confirmed ones.
    const cap = appPortfolioCap();
    if (acc.portfolios.length >= cap) {
      throw new RealChangeSetInvalidError("too-many-portfolios", `${acc.portfolios.length} >= ${cap}`);
    }

    const portfolioId = crypto.randomUUID();
    const empty: PortfolioState = { id: portfolioId, name, composition: [], balances: {} };
    const { portfolio: created, generalDelta } = applyChanges(empty, initialChanges);

    const err = validatePortfolio(created.composition, created.balances);
    if (err) throw new ContractError(err);

    const ts = Date.now();
    const commitId = newId();
    const events: ContractEvent[] = [
      { kind: "portfolio_created", event_id: newId(), commit_id: commitId, account_id: id, portfolio_id: portfolioId, name, ts },
      // Composition starts empty; initialChanges additions/target changes record the shape.
      ...buildCompositionEvents(id, portfolioId, commitId, [], initialChanges, ts),
      ...(initialChanges.allocations ?? []).map(
        (a): ContractEvent => ({
          kind: "allocate",
          event_id: newId(),
          commit_id: commitId,
          account_id: id,
          portfolio_id: portfolioId,
          token: a.tokenId,
          qty: a.qty,
          ts,
        })
      ),
    ];

    acc.portfolios.push(created);
    acc.generalBalance = applyGeneralDelta(acc.generalBalance, generalDelta);
    this.push(acc, ...events);
    return { portfolioId, events };
  }

  // Creates an in-progress (empty) portfolio with no validation and no signature
  // (5.3.0). The portfolio holds no funds, so there is nothing to value-check —
  // validatePortfolio is a commit gate, not a creation gate. This keeps the
  // "create → edit → Confirm" loop usable before the atomic preset/initialSetup
  // creation lands in 5.6, which supersedes this. Auto-registers the account on
  // first use, mirroring creditReceive's deferred registration.
  createEmptyPortfolio(id: IntentsAccountId, name: string): { portfolioId: PortfolioId } {
    this.load();
    let acc = this.get(id);
    if (!acc) {
      acc = { id, registeredAt: Date.now(), generalBalance: {}, portfolios: [], events: [] };
    }
    const portfolioId = crypto.randomUUID();
    const trimmed = name.trim();
    const ts = Date.now();
    acc.portfolios.push({ id: portfolioId, name: trimmed, composition: [], balances: {} });
    this.push(acc, { kind: "portfolio_created", event_id: newId(), commit_id: newId(), account_id: id, portfolio_id: portfolioId, name: trimmed, ts });
    return { portfolioId };
  }

  // `mirrorRealPortfolio` lived here (007.plan Phase 1) and was RETIRED in 008.plan Phase 1
  // (D-R6). It copied a live-vault portfolio into this ledger so the dashboard could render
  // it, which made the mock a second, writable source of truth for money that lives on
  // chain. The divergence that buys is not theoretical: D-174 is a composition shown at 0%
  // while `get_portfolio` returned all five targets intact. Real portfolios are now read
  // from the vault (`use-real-portfolios.ts`) and never written here.
  //
  // Records written by the old mirror may still sit in a returning user's localStorage.
  // They are inert: `portfolio-context` filters `isReal` out of the mock projection while
  // the round-trip flag is on, and `use-available-general-balance` still skips them so they
  // cannot double-count against the on-chain balance.

  // Signed, like the final contract's rename (017-9c: `name` in the change set). The mock
  // ignores the signature payload, as every other mock gesture does; taking it keeps the UI
  // flow — a wallet prompt per rename — the same on both paths.
  // No-op if the account or portfolio is unknown.
  renamePortfolio(
    id: IntentsAccountId,
    portfolioId: PortfolioId,
    name: string,
    _signature: Signature
  ): void {
    const acc = this.get(id);
    if (!acc) return;
    const portfolio = acc.portfolios.find((p) => p.id === portfolioId);
    if (!portfolio) return;
    portfolio.name = name.trim();
    this.push(acc);
  }

  async deletePortfolio(
    id: IntentsAccountId,
    portfolioId: PortfolioId,
    _signature: Signature
  ): Promise<{ events: ContractEvent[] }> {
    const acc = this.get(id);
    if (!acc) throw new ContractError(`Account ${id} not found`);
    const portfolio = acc.portfolios.find((p) => p.id === portfolioId);
    if (!portfolio) throw new ContractError(`Portfolio ${portfolioId} not found`);

    // The final contract's semantics (ADR-0023, C-9): only an EMPTY portfolio can be deleted,
    // and nothing is swept — emptying and deleting are two signatures. The refusal is the
    // contract's own code, so the UI reads both paths the same way.
    if (Object.values(portfolio.balances).some((qty) => qty > 0)) {
      throw new VaultCommitRevertedError("Smart contract panicked: E_PORTFOLIO_NOT_EMPTY");
    }
    acc.portfolios = acc.portfolios.filter((p) => p.id !== portfolioId);

    const ts = Date.now();
    const events: ContractEvent[] = [
      { kind: "portfolio_deleted", event_id: newId(), commit_id: newId(), account_id: id, portfolio_id: portfolioId, ts },
    ];
    this.push(acc, ...events);
    return { events };
  }

  async withdraw(
    id: IntentsAccountId,
    token: TokenId,
    qty: number,
    destinationChain: ChainKind,
    destinationAddress: string,
    _signature: Signature
  ): Promise<{ intentId: string; events: ContractEvent[] }> {
    const acc = this.get(id);
    if (!acc) throw new ContractError(`Account ${id} not found`);
    const current = acc.generalBalance[token] ?? 0;
    if (current < qty) throw new ContractError(`Insufficient balance: ${current} < ${qty}`);

    acc.generalBalance[token] = current - qty;
    const ts = Date.now();
    const intentId = crypto.randomUUID();
    const events: ContractEvent[] = [
      { kind: "withdraw", event_id: newId(), account_id: id, token, qty, destination_chain: destinationChain, destination_address: destinationAddress, ts },
    ];
    this.push(acc, ...events);
    return { intentId, events };
  }

  // Bulk-inserts pre-built rebalance events into an existing account's event log.
  // Only accepts external_rebalance and forced_internal_rebalance kinds; silently
  // drops anything else. Used by the 7.1 seeder to backfill history on the mock route.
  seedEvents(accountId: IntentsAccountId, events: ContractEvent[]): void {
    const acc = this.get(accountId);
    if (!acc) return;
    const allowed = new Set<ContractEvent["kind"]>(["external_rebalance", "forced_internal_rebalance"]);
    const valid = events.filter((e) => allowed.has(e.kind));
    if (!valid.length) return;
    this.push(acc, ...valid);
  }

  creditReceive(
    id: IntentsAccountId,
    token: TokenId,
    qty: number,
    chain: string, // BridgeChainId e.g. "eth:8453"; decoupled from ChainKind per D-135
    bridgeTx: string,
    source?: "wallet"
  ): boolean {
    this.load();
    let acc = this.get(id);
    if (!acc) {
      // Auto-register account on first credit (deferred registration).
      acc = {
        id,
        registeredAt: Date.now(),
        generalBalance: {},
        portfolios: [],
        events: [],
      };
    }
    // Idempotent by bridge tx: a CREDITED deposit stays in the bridge's
    // recent_deposits response, and the polling hook's in-memory dedup set does
    // not survive a page reload — so the same deposit would otherwise be
    // credited again on every refresh, inflating the balance. Skip if already seen.
    const alreadyCredited = acc.events.some(
      (e) => e.kind === "receive" && e.bridge_tx === bridgeTx
    );
    // `false` tells the caller this was a repeat, so it can skip the toast too (016 §5.3: the
    // wallet deposit and the bridge's poller may both report the same transaction).
    if (alreadyCredited) return false;
    acc.generalBalance[token] = (acc.generalBalance[token] ?? 0) + qty;
    const event: ContractEvent = {
      kind: "receive", event_id: newId(), account_id: id, token, qty, chain, bridge_tx: bridgeTx, ts: Date.now(),
      ...(source ? { source } : {}),
    };
    this.push(acc, event);
    return true;
  }
}

export const mockContract = new MockContractImpl();
