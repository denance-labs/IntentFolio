"use client";

import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import type {
  CurrentPortfolioQty,
  TargetAllocation,
} from "@/features/portfolio-editor/types";
import type { BalanceDeltas } from "@/features/portfolio-editor/lib/changeset";
import { ensureCanOperate, useLoginWallet } from "@/features/login-wallet";
import {
  walletMatchesAccount,
  deriveIntentsAccountId,
  WalletAccountMismatchError,
} from "@/features/login-wallet/lib/identity";
import { isLiveVaultRoute, VAULT_ROUNDTRIP_ENABLED } from "@/features/vault/lib/vault-flag";
import { appPortfolioCap } from "@/features/vault/lib/change-set-preflight";
import { usesRelay } from "@/features/vault/lib/envelope-submitter";
import { useRealAllocateSigner } from "@/features/vault/context/real-allocate-context";
import {
  realPortfoliosQueryKey,
  useRealPortfolios,
} from "@/features/vault/hooks/use-real-portfolios";
import { pendingAllocatesQueryKey } from "@/features/vault/hooks/use-pending-allocates";
import { projectVaultPortfolios } from "@/features/vault/lib/project-vault-portfolio";
import {
  RealPortfolioMetaUnconfirmedError,
  runRealDeletePortfolio,
  runRealRenamePortfolio,
} from "@/features/vault/lib/run-real-portfolio-meta";
import { shellTranslations } from "../lib/translations";
import { announceOperation, realPortfolioHistoryQueryKey } from "@/features/vault/hooks/use-real-portfolio-history";
import { useLiveSigner } from "@/features/vault/hooks/use-live-signer";
import { runRealAllocate, type RealAllocateStage } from "@/features/vault/lib/run-real-allocate";
import type { SetupStorageCost } from "@/features/vault/lib/storage-cost";
import { runRealUnallocate, type RealUnallocateStage } from "@/features/vault/lib/run-real-unallocate";
import {
  runRealAllocateInto,
  type RealAllocateIntoResult,
} from "@/features/vault/lib/run-real-allocate-into";
import {
  RealChangeSetInvalidError,
  RealUnallocateDeferredError,
} from "@/features/vault/lib/vault-errors";
import { mockContract } from "@/features/intents-account/mock-contract";
import type { PortfolioChangeSet, Signature } from "@/features/intents-account/mock-contract/types";
import {
  DEFAULT_TOLERANCE_PCT,
  getActivePortfolioId,
  setActivePortfolioId as persistActivePortfolioId,
} from "../lib/portfolio-ui-prefs";
import { clearDraft, readDraft, writeDraft } from "../lib/portfolio-draft-store";
import { useLanguage } from "./language-context";
import { reconcileActivePortfolio } from "../lib/reconcile-active-portfolio";

export type Portfolio = {
  id: string;
  name: string;
  deposits: CurrentPortfolioQty;
  targets: TargetAllocation[];
  createdAt: number;
  defaultTolerancePct: number;
  // Read from the live vault (008.plan Phase 1, D-R6) — holds real funds. Drives the
  // "real" badge on the tab and routes every write to the chain instead of the mock.
  isReal?: boolean;
  // Real portfolios only: `get_portfolio_balance` came back with nothing held (017-9c). Read
  // from the raw base units, not from `deposits`, which skips a token the registry cannot
  // price — a portfolio holding one would look empty there and the vault would refuse it.
  holdsNothingOnChain?: boolean;
};

// The in-flight portfolio edit (5.0 snapshot→draft, 5.3.2 balances). It lives in the
// provider rather than the editor hook (5.4-A) so it survives route navigation: the
// provider sits in the persistent layout, whereas the composition page — and the
// editor hook mounted inside it — unmounts when the user navigates to another section.
// `id` tags the portfolio the draft belongs to, so switching portfolios drops it
// cleanly. The draft mutators stay in use-portfolio-targets.ts (they read committed
// composition, prices and tolerance via refs); only the raw state is hoisted here.
export type DraftState = {
  id: string;
  targets: TargetAllocation[];
  balanceDeltas: BalanceDeltas;
  // 021 R2: the targets right before each committed token was removed (tokenId → rows), so
  // "Undo" can put the draft back exactly. Display-only: it never reaches the changeset.
  undoRemoval?: Record<string, TargetAllocation[]>;
};


type PortfolioContextValue = {
  portfolios: Portfolio[];
  // Read-model status for the REAL portfolios (008.plan Phase 1). The mock read is
  // synchronous; the vault read is an RPC, so "I have no portfolios" and "I have not
  // finished asking" stop being the same state. Anything that renders an empty state MUST
  // distinguish them: to someone who just deposited, a false empty reads as lost funds.
  portfoliosLoading: boolean;
  // Non-null when the vault could not be read and there is no earlier read to show. Never
  // falls back to the mock — showing a stale portfolio as if it were live is worse than
  // saying the read failed.
  portfoliosError: Error | null;
  // D-327: a RE-read failed over a list already on screen. That list stays — with a notice
  // that it could not be updated, so it is not passed off as live — because blanking it would
  // unmount the editor and take an open modal's outcome (e.g. D-298's "no need to sign again")
  // with it.
  portfoliosRefreshFailed: boolean;
  refetchPortfolios: () => void;
  activePortfolio: Portfolio | null;
  activePortfolioId: string | null;
  setActivePortfolioId: (id: string) => void;
  commitChangeSet: (changeset: PortfolioChangeSet, signatureText: string) => Promise<void>;
  createPortfolio: (name: string) => void;
  // `changeset.allocations` are GROSS (what the user chose); `storage` is the Storage Cost the
  // confirmation showed (D-528, `quoteStorageCost`), deducted downstream from its token's leg.
  createPortfolioWithChangeSet: (
    name: string,
    changeset: PortfolioChangeSet,
    signatureText: string,
    storage: SetupStorageCost
  ) => Promise<void>;
  // New funds from the General Balance into the ACTIVE real portfolio, signed right away
  // (D-321, 013.plan P5): the Add tokens modal calls it; it never goes through the draft.
  // `tokenAdditions` join the composition at 0% in the same signature.
  allocateIntoPortfolio: (params: {
    allocations: Array<{ tokenId: string; qty: number }>;
    tokenAdditions: Array<{ tokenId: string; tolerancePct: number }>;
  }) => Promise<RealAllocateIntoResult>;
  // Both signed (017-9c). On a real portfolio they go to the vault as a `commit_portfolio_changes`
  // without legs and resolve once the chain shows the result; the mock asks for a signature too,
  // so the flow is the same on both paths. Delete only takes an EMPTY portfolio (ADR-0023).
  renamePortfolio: (id: string, name: string) => Promise<void>;
  deletePortfolio: (id: string) => Promise<void>;
  // Hoisted draft state (5.4-A). The editor hook owns the mutation logic and reads/writes
  // these; centralising the storage here is what lets the draft survive navigation.
  draftState: DraftState | null;
  setDraftState: Dispatch<SetStateAction<DraftState | null>>;
  // Restored-from-storage banner (5.4-B): true only when this load's draft came back from
  // localStorage and the user hasn't acknowledged it yet.
  draftWasRestored: boolean;
  dismissRestoredDraft: () => void;
  // Progress of an in-flight live-vault Allocate (007.plan Phase 1); null when idle or
  // when the flag is off. The real path is slower than the mock (sign → submit → wait for
  // the on-chain credit), so the UI reports which leg it is on instead of one long spinner.
  realAllocateStage: RealAllocateStage | null;
  // Same for the live-vault Unallocate (007.plan Phase 2): sign → submit → wait for the
  // vault to settle the batch transfer back into General Balance.
  realUnallocateStage: RealUnallocateStage | null;
  // Whether this login's live-vault operations are sent by the relayer (017-2): the
  // confirmation modals ask it whether it is paused before they ask for a signature. False on
  // the mock and for a NEAR login that self-submits.
  relaySends: boolean;
  // Whether a new portfolio or its funding would be signed against the live vault (any login
  // family): the confirmation modals ask the vault whether it would refuse first (017-9b).
  vaultLive: boolean;
  // Who a Setup is signed as, for pricing its Storage Cost (D-528): the INTENTS account and the
  // login address the Setup records — the same two `runRealAllocate` re-derives the bytes from.
  // On the mock the address is the account. Null before there is an account.
  setupSigner: { accountId: string; loginAddress: string } | null;
};

const PortfolioContext = createContext<PortfolioContextValue | null>(null);

// Map a contract composition entry to the editor's row shape. The id is derived
// deterministically from the tokenId so it stays stable across every re-derivation
// of the read-model (a changing id would remount the table row and drop focus).
function compositionToTargets(
  composition: { tokenId: string; targetPct: number; tolerancePct: number }[]
): TargetAllocation[] {
  return composition.map((c) => ({
    id: `target-${c.tokenId}`,
    tokenId: c.tokenId,
    targetPct: c.targetPct,
    tolerancePct: c.tolerancePct,
    locked: false,
  }));
}

export function PortfolioProvider({ children }: { children: ReactNode }) {
  const {
    intentsAccountId,
    signMessage,
    family: loginChainKind,
    connection,
    liveConnection,
    keyVerification,
    verifyKey,
  } = useLoginWallet();
  // Only for the refusal copy of the D-280 gate below. Same feature folder, and every tree
  // that mounts PortfolioProvider is already inside LanguageProvider (root layout).
  const { lang } = useLanguage();
  // null outside the RealAllocateProvider (e.g. /mock-dashboard) — the real path is then
  // simply unavailable and everything falls back to the mock.
  const realAllocateSigner = useRealAllocateSigner();

  // Which scheme signs this login's vault envelopes (008.plan Phase 0b). Extracted to a
  // hook in block 5.4 because the real WITHDRAWAL needs the identical trio, and two copies
  // of "who may move real funds" is the one duplication this path cannot afford.
  const liveVault = useLiveSigner();
  const vaultLive =
    Boolean(liveVault) &&
    isLiveVaultRoute({ hasSigner: true, loginChain: loginChainKind, isRealPortfolio: true });
  const relaySends = vaultLive && usesRelay(loginChainKind);

  /**
   * Fails BEFORE the wallet prompt when the connected wallet does not derive to the account
   * the operation would be recorded under. Mirrors the contract's own `apply_setup` guard
   * (allocate.rs:154, E_ACCOUNT_ID_MISMATCH), so a mismatch costs a clear error instead of
   * a signature the contract will bounce. The checksummed-vs-lowercase EVM address is the
   * everyday way to hit this.
   */
  const assertWalletMatchesAccount = useCallback(() => {
    if (!connection) throw new Error("No wallet connected");
    // MUST read `liveConnection`, not `connection`. Since the session-ownership filter landed
    // (008.plan F4.2), `connection` reports the session's OWN account whenever a foreign
    // wallet is active — so checking it here compared `intentsAccountId` against the address
    // it was derived from and could never fail. That silently turned this guard into a no-op
    // while it still read like protection; the signing-time check in login-wallet-context was
    // carrying it alone. `liveConnection` is what the extension actually has plugged in.
    const live = liveConnection ?? connection;
    if (!walletMatchesAccount(live.address, live.chainKind, intentsAccountId)) {
      let connectedAccountId = "unknown";
      try {
        connectedAccountId = deriveIntentsAccountId(live.address, live.chainKind);
      } catch {
        // underivable identifier (e.g. TON without a pubkey) → keep the placeholder
      }
      throw new WalletAccountMismatchError(intentsAccountId, connectedAccountId, {
        expectedAddress: connection.address,
        connectedAddress: live.address,
      });
    }
  }, [connection, liveConnection, intentsAccountId]);
  // Non-null only while a live-vault Allocate is in flight; drives the progress copy.
  const [realAllocateStage, setRealAllocateStage] = useState<RealAllocateStage | null>(null);
  // Same, for the return leg (007.plan Phase 2). Kept separate: the two flows have
  // different stages and can never overlap, so merging them would only blur the copy.
  const [realUnallocateStage, setRealUnallocateStage] = useState<RealUnallocateStage | null>(
    null
  );
  // The live General Balance is a cached on-chain query (5 min staleTime). A settled
  // withdrawal changes it, so the cache has to be dropped or the funds "arrive" minutes
  // after the vault already sent them.
  const queryClient = useQueryClient();

  // Re-derive whenever the mock-contract mutates (commit, create, delete, credit…).
  const version = useSyncExternalStore(
    mockContract.subscribe,
    mockContract.getVersion,
    () => 0
  );

  const [activePortfolioId, setActivePortfolioIdState] = useState<string | null>(null);
  // In-flight portfolio edit, hoisted from the editor hook (5.4-A) so it outlives route
  // navigation. The mutation logic still lives in use-portfolio-targets.ts.
  const [draftState, setDraftState] = useState<DraftState | null>(null);
  // True only when the current draft was restored from localStorage on this load (5.4-B2)
  // — the editor uses it to show a one-time "you have unsaved changes" banner. Cleared as
  // soon as the user acknowledges it (keep editing) or discards the draft.
  const [draftWasRestored, setDraftWasRestored] = useState(false);
  // Guards the persist/rehydrate pair (5.4-B1): tracks which account has already been
  // rehydrated from storage. Until rehydration runs for the active account, the persist
  // effect must NOT write — otherwise the initial draftState=null would clobber the
  // persisted draft before we ever read it back.
  const hydratedForAccount = useRef<string | null>(null);

  // One-time cleanup of the abandoned per-keystroke stores. Decision (5.3.0): the
  // mock-contract is the single source of truth; portfolio.portfolios.* is dropped.
  useEffect(() => {
    try {
      localStorage.removeItem("portfolio.state");
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key && key.startsWith("portfolio.portfolios.")) localStorage.removeItem(key);
      }
    } catch {
      /* ignore */
    }
  }, []);

  // Hydrate UI prefs from the side-table when the account changes.
  useEffect(() => {
    setActivePortfolioIdState(intentsAccountId ? getActivePortfolioId(intentsAccountId) : null);
  }, [intentsAccountId]);

  // Real portfolios, read from the vault (008.plan Phase 1, D-R6). Disabled — and
  // therefore never loading, never erroring — when the round-trip flag is off.
  const realQuery = useRealPortfolios(intentsAccountId);

  // The mock ledger. Source of truth for MOCK portfolios only.
  //
  // The `isReal` filter is the migration seam: accounts that used the live path before
  // Phase 1 still carry `mirrorRealPortfolio` records in localStorage. Those records are
  // now superseded by the vault read, so rendering them too would show every real
  // portfolio twice — and the stale copy would be the one lying about the composition.
  // Only applied when the vault read is actually replacing them; with the flag off the
  // mock stays exactly the source it was, so nothing disappears from a mock-only session.
  const mockPortfolios = useMemo<Portfolio[]>(() => {
    // `version` is read so the memo recomputes on every mock mutation.
    void version;
    if (!intentsAccountId) return [];
    const acc = mockContract.getIntentsAccount(intentsAccountId);
    if (!acc) return [];
    return acc.portfolios
      .filter((p) => !(VAULT_ROUNDTRIP_ENABLED && p.isReal))
      .map((p) => ({
        id: p.id,
        name: p.name,
        deposits: Object.fromEntries(mockContract.getPortfolioBalance(intentsAccountId, p.id)),
        targets: compositionToTargets(p.composition),
        createdAt: 0,
        defaultTolerancePct: DEFAULT_TOLERANCE_PCT,
        ...(p.isReal ? { isReal: true } : {}),
      }));
  }, [intentsAccountId, version]);

  // Projected from the chain's own record: composition in basis points, balances in base
  // units. Nothing here is read back from localStorage — that is the whole point of D-R6.
  const realPortfolios = useMemo<Portfolio[]>(
    () => projectVaultPortfolios(realQuery.data ?? [], DEFAULT_TOLERANCE_PCT),
    [realQuery.data]
  );

  const portfolios = useMemo<Portfolio[]>(
    () => [...mockPortfolios, ...realPortfolios],
    [mockPortfolios, realPortfolios]
  );

  // Keep the active selection valid as portfolios appear/disappear.
  //
  // The guard is load-bearing, not defensive. The vault read is ASYNC, so on every page
  // load there is a window where the hydrated selection is already set but `portfolios` is
  // still `[]`. Without the guard this effect read that window as "the account has no
  // portfolios", nulled the restored id, and then — once the read resolved — fell through
  // to `portfolios[0]`. Net effect: the persisted preference was written and read back
  // correctly, and then destroyed in between, so EVERY reload silently landed on the first
  // portfolio. Combined with a stale read-model that made users reload to see their own
  // save, that is how a commit reaches a portfolio the user is not looking at (008.plan
  // Phase 2 — observed on mainnet, not caught by any unit test).
  // `isLoading` and not `isPending`/`isFetching`, deliberately: it is true ONLY for a first
  // fetch that is actually in flight. A disabled query (flag off) reports `isPending` for
  // ever, so gating on that would freeze reconciliation in mock-only sessions; `isFetching`
  // would also cover background refetches, which already have data to reconcile against.
  const realPortfoliosLoading = realQuery.isLoading;
  useEffect(() => {
    const outcome = reconcileActivePortfolio({
      loading: realPortfoliosLoading,
      portfolioIds: portfolios.map((p) => p.id),
      activeId: activePortfolioId,
    });
    if (outcome.change) setActivePortfolioIdState(outcome.next);
  }, [portfolios, activePortfolioId, realPortfoliosLoading]);

  // Rehydrate a persisted draft once per account (5.4-B1), after portfolios are known so
  // we can validate the draft still targets a live portfolio. A draft whose portfolio was
  // deleted is dropped instead of resurrected. Runs once per account (guarded by the ref)
  // so it never clobbers an in-memory draft on a later re-render.
  useEffect(() => {
    if (!intentsAccountId) {
      hydratedForAccount.current = null;
      return;
    }
    if (hydratedForAccount.current === intentsAccountId) return;
    if (portfolios.length === 0) return; // wait until we can validate the portfolio id
    hydratedForAccount.current = intentsAccountId;
    const persisted = readDraft(intentsAccountId);
    if (persisted && portfolios.some((p) => p.id === persisted.id)) {
      setDraftState(persisted);
      setDraftWasRestored(true);
    } else if (persisted) {
      clearDraft(intentsAccountId); // stale draft for a portfolio that no longer exists
    }
  }, [intentsAccountId, portfolios]);

  // Persist the draft (5.4-B1), debounced so per-keystroke edits don't thrash storage.
  // Gated on rehydration having run for this account, so the initial null state can't
  // wipe the persisted draft before it's read back. draftState=null clears the entry,
  // which covers both Cancel (discardDraft) and a successful commit.
  useEffect(() => {
    if (!intentsAccountId) return;
    if (hydratedForAccount.current !== intentsAccountId) return;
    const timer = setTimeout(() => {
      if (draftState) writeDraft(intentsAccountId, draftState);
      else clearDraft(intentsAccountId);
    }, 400);
    return () => clearTimeout(timer);
  }, [intentsAccountId, draftState]);

  // Drop the restored flag once the draft is gone (discard or commit), so a fresh edit
  // started afterwards doesn't inherit the banner. Keyed on the non-null→null transition
  // (tracked via a ref) rather than on `!draftState`: the rehydrate effect sets the draft
  // and the flag in the same commit this effect also runs in, where the closure still sees
  // draftState === null — resetting there would race away the flag we just set.
  const prevHadDraft = useRef(false);
  useEffect(() => {
    const hasDraft = draftState !== null;
    if (prevHadDraft.current && !hasDraft) setDraftWasRestored(false);
    prevHadDraft.current = hasDraft;
  }, [draftState]);

  // Acknowledge the restored-draft banner without touching the draft (5.4-B2, "keep
  // editing"). Discarding is the editor's existing discardDraft, which nulls the draft and
  // lets the persist effect clear storage.
  const dismissRestoredDraft = useCallback(() => setDraftWasRestored(false), []);

  const activePortfolio = useMemo(
    () => portfolios.find((p) => p.id === activePortfolioId) ?? null,
    [portfolios, activePortfolioId]
  );

  const setActivePortfolioId = useCallback(
    (id: string) => {
      setActivePortfolioIdState(id);
      if (intentsAccountId) persistActivePortfolioId(intentsAccountId, id);
    },
    [intentsAccountId]
  );

  // Commit a signed composition changeset to the contract (5.3.1). Signing is a UI
  // gesture (wallet prompt), so it lives next to the account identity. Throws on a
  // rejected signature or a rejected commit — the editor surfaces it and keeps the
  // draft so the user can retry or cancel. The read-model re-derives via `version`.
  const commitChangeSet = useCallback(
    async (changeset: PortfolioChangeSet, signatureText: string): Promise<void> => {
      if (!intentsAccountId || !activePortfolioId) return;
      const current = portfolios.find((p) => p.id === activePortfolioId);

      // ── Live-vault path: `commit_portfolio_changes` ───────────────────────
      // ③ Unallocate (007.plan Phase 2) and composition edits (008.plan Phase 2), which
      // share one signature. Same gate as the Allocate leg, plus: only a REAL portfolio
      // (real funds, real on-chain id — D-R6) is routed. Everything else stays on the
      // mock, byte for byte.
      if (
        liveVault &&
        current &&
        isLiveVaultRoute({
          hasSigner: true,
          loginChain: loginChainKind,
          isRealPortfolio: current.isReal,
        })
      ) {
        const requests = (changeset.unallocations ?? []).map((u) => ({
          tokenId: u.tokenId,
          qty: u.qty,
        }));
        // Composition edits DO reach the chain now (008.plan Phase 2): they ride the same
        // `commit_portfolio_changes` as the withdrawal legs, alone or together. New funds do
        // not: they are `AllocateOp::AllocateInto`, a different envelope, signed from the Add
        // tokens modal through `allocateIntoPortfolio` (D-321). No contract op takes both in
        // one signature (013.plan P1), and the UI no longer puts funds in a real draft — this
        // is the backstop for one that still does (e.g. restored from storage).
        if ((changeset.allocations?.length ?? 0) > 0) {
          throw new RealChangeSetInvalidError(
            "allocation-in-draft",
            (changeset.allocations ?? []).map((a) => a.tokenId).join(",")
          );
        }

        // D-280 B4. Before the wallet guard on purpose: "this account cannot operate at all"
        // is the answer for a whole session, while a mismatch is about which extension window
        // happens to be open. A fresh tester hits this one, and hears the actionable thing.
        await ensureCanOperate(keyVerification, verifyKey, lang);
        assertWalletMatchesAccount();

        setRealUnallocateStage("preparing");
        try {
          const result = await runRealUnallocate({
            accountId: intentsAccountId,
            portfolioId: activePortfolioId,
            requests,
            composition: {
              targetChanges: (changeset.targetChanges ?? []).map((c) => ({
                tokenId: c.tokenId,
                targetPct: c.newTargetPct,
                tolerancePct: c.newTolerancePct,
              })),
              tokenAdditions: (changeset.tokenAdditions ?? []).map((a) => ({
                tokenId: a.tokenId,
                targetPct: a.initialTargetPct,
                tolerancePct: a.initialTolerancePct,
              })),
              tokenRemovals: (changeset.tokenRemovals ?? []).map((r) => r.tokenId),
            },
            signer: liveVault.signer,
            loginChain: liveVault.chain,
            nearWallet: realAllocateSigner,
            onStage: setRealUnallocateStage,
          });

          // Deferred = nothing happened on-chain. Throwing keeps the draft alive so the
          // same withdrawal can be re-signed once the window opens.
          if (result.kind === "deferred") {
            throw new RealUnallocateDeferredError(result.nextReleaseAt, result.tokenId);
          }

          void announceOperation(queryClient, intentsAccountId, result.txHash);

          // No mirror to re-sync any more (D-R6): the portfolio is re-read from the vault,
          // so `result.remaining` is not transcribed anywhere — the chain is asked again.
          // Awaited so the editor leaves the confirm modal onto fresh numbers instead of
          // the pre-withdrawal ones.
          await queryClient.invalidateQueries({
            queryKey: realPortfoliosQueryKey(intentsAccountId),
          });
          // The funds are back in the on-chain General Balance — drop the cached read.
          void queryClient.invalidateQueries({ queryKey: ["intents-balances", intentsAccountId] });
          return;
        } catch (e) {
          // Not confirmed is not "nothing happened": re-read the chain, so that closing the
          // modal (which drops the draft) lands on what it actually holds (017-1). A revert
          // too: `E_NONCE_CONSUMED` / `E_EXPIRED_DEADLINE` is what a commit that ALREADY
          // applied answers (017-9b, D-302 j). And a batch transfer that failed in intents.near
          // after the commit applied its composition (D-385 a). A re-read costs nothing, so
          // every failure gets one.
          void queryClient.invalidateQueries({ queryKey: realPortfoliosQueryKey(intentsAccountId) });
          void queryClient.invalidateQueries({ queryKey: ["intents-balances", intentsAccountId] });
          throw e;
        } finally {
          setRealUnallocateStage(null);
        }
      }

      const signature = await signMessage(signatureText, intentsAccountId);
      await mockContract.commitPortfolioChanges(intentsAccountId, activePortfolioId, changeset, signature);
    },
    [
      intentsAccountId,
      activePortfolioId,
      portfolios,
      signMessage,
      liveVault,
      assertWalletMatchesAccount,
      keyVerification,
      verifyKey,
      lang,
      realAllocateSigner,
      loginChainKind,
      queryClient,
    ]
  );

  const createPortfolio = useCallback(
    (name: string) => {
      if (!intentsAccountId) return;
      const { portfolioId } = mockContract.createEmptyPortfolio(intentsAccountId, name.trim());
      setActivePortfolioId(portfolioId);
    },
    [intentsAccountId, setActivePortfolioId]
  );

  // Atomic first-time creation (5.6): register (deferred, if needed) + create + allocate
  // in a single signed operation. Reuses createPortfolio — the preset composition becomes
  // tokenAdditions and the chosen funds become allocations debited from General Balance, so
  // the new portfolio is funded (the validation gate requires ≥1 funded token). Distinct
  // from createPortfolio() above, which still creates an empty portfolio for the scratch
  // path. Throws on a rejected signature or a rejected commit; the modal surfaces it and
  // keeps its inputs so the user can retry. Activates the new portfolio on success.
  const createPortfolioWithChangeSet = useCallback(
    async (name: string, changeset: PortfolioChangeSet, signatureText: string, storage: SetupStorageCost): Promise<void> => {
      if (!intentsAccountId) return;

      // ── Live-vault path (007.plan Phase 1; 008.plan Phase 0b) ─────────────
      // Default OFF. Requires the flags, a login family the gate admits, and the signer
      // provider in the tree. Anything missing falls through to the mock, unchanged.
      // `isRealPortfolio: true` — this IS the call that creates the real portfolio, so
      // there is no mirror to consult yet. Using the shared predicate anyway keeps the two
      // legs of the round-trip from drifting apart on which families are live.
      if (
        liveVault &&
        isLiveVaultRoute({
          hasSigner: true,
          loginChain: loginChainKind,
          isRealPortfolio: true,
        })
      ) {
        // D-280 B4 — same guard, and this is the door a new tester reaches FIRST: creating
        // the portfolio signs the vault envelope long before any withdrawal exists.
        await ensureCanOperate(keyVerification, verifyKey, lang);
        assertWalletMatchesAccount();

        setRealAllocateStage("preparing");
        try {
          const result = await runRealAllocate({
            accountId: intentsAccountId,
            portfolioName: name.trim(),
            changeset,
            storage,
            signer: liveVault.signer,
            loginChain: liveVault.chain,
            loginWalletAddress: liveVault.address,
            nearWallet: realAllocateSigner,
            onStage: setRealAllocateStage,
          });
          void announceOperation(queryClient, intentsAccountId, result.txHash);
          // The vault already holds the portfolio; re-read it instead of mirroring what we
          // believe we wrote (D-R6). AWAITED, and before setActivePortfolioId: the effect
          // that repairs the active selection drops any id it cannot find in `portfolios`,
          // so selecting the new portfolio before the refetch lands would bounce the user
          // straight back to the first tab.
          await queryClient.invalidateQueries({
            queryKey: realPortfoliosQueryKey(intentsAccountId),
          });
          // The allocation debited the on-chain General Balance.
          void queryClient.invalidateQueries({ queryKey: ["intents-balances", intentsAccountId] });
          // My Account's in-transit notice (D-293): this Allocate's record is now sealed.
          void queryClient.invalidateQueries({ queryKey: pendingAllocatesQueryKey(intentsAccountId) });
          setActivePortfolioId(result.portfolioId);
          return;
        } catch (e) {
          // A failed attempt can leave the screen wrong in both directions: funds that already
          // left (unconfirmed, the vault refusing the credit, a submit that threw after landing)
          // or a balance the chain just contradicted (AmountExceedsBalanceError, D-304). Shown
          // stale, "Available to add" invites a second signature over the same funds (D-298).
          // Every failure refetches — a cancelled signature costs one no-op read. Not awaited:
          // the modal's copy must not wait on the RPC.
          void queryClient.invalidateQueries({ queryKey: realPortfoliosQueryKey(intentsAccountId) });
          void queryClient.invalidateQueries({ queryKey: ["intents-balances", intentsAccountId] });
          // And the notice that tells the user where those funds are (D-293).
          void queryClient.invalidateQueries({ queryKey: pendingAllocatesQueryKey(intentsAccountId) });
          throw e;
        } finally {
          // The terminal stage is surfaced by the caller's own error handling; clearing
          // here keeps a cancelled/failed attempt from freezing the indicator.
          setRealAllocateStage(null);
        }
      }

      // The cap notice before the text signature, as the real pre-flight does (D-380 c).
      const held = mockContract.getIntentsAccount(intentsAccountId)?.portfolios.length ?? 0;
      if (held >= appPortfolioCap()) {
        throw new RealChangeSetInvalidError("too-many-portfolios", `${held} >= ${appPortfolioCap()}`);
      }
      const signature = await signMessage(signatureText, intentsAccountId);
      // The mock is QA scaffolding: it deducts the Storage Cost like the vault path, so the
      // portfolio shows the net amount, and sends it nowhere.
      const { portfolioId } = await mockContract.createPortfolio(
        intentsAccountId,
        name.trim(),
        {
          ...changeset,
          allocations: (changeset.allocations ?? []).map((a) =>
            a.tokenId === storage.tokenId ? { ...a, qty: a.qty - storage.qty } : a
          ),
        },
        signature
      );
      setActivePortfolioId(portfolioId);
    },
    [
      intentsAccountId,
      signMessage,
      setActivePortfolioId,
      liveVault,
      assertWalletMatchesAccount,
      keyVerification,
      verifyKey,
      lang,
      realAllocateSigner,
      loginChainKind,
      queryClient,
    ]
  );

  const allocateIntoPortfolio = useCallback(
    async (params: {
      allocations: Array<{ tokenId: string; qty: number }>;
      tokenAdditions: Array<{ tokenId: string; tolerancePct: number }>;
    }): Promise<RealAllocateIntoResult> => {
      const current = portfolios.find((p) => p.id === activePortfolioId);
      // Same gate as the commit path; there is no mock fallback here — the modal only calls
      // this for a portfolio the router sends to the vault, so reaching it otherwise is a bug.
      if (
        !intentsAccountId ||
        !current ||
        !liveVault ||
        !isLiveVaultRoute({
          hasSigner: true,
          loginChain: loginChainKind,
          isRealPortfolio: current.isReal,
        })
      ) {
        throw new Error("Adding funds needs a live-vault portfolio and a signer");
      }

      // D-280 B4, and the wallet guard — the same door as creating a portfolio.
      await ensureCanOperate(keyVerification, verifyKey, lang);
      assertWalletMatchesAccount();

      setRealAllocateStage("preparing");
      try {
        const result = await runRealAllocateInto({
          accountId: intentsAccountId,
          portfolioId: current.id,
          portfolioName: current.name,
          allocations: params.allocations,
          tokenAdditions: params.tokenAdditions,
          signer: liveVault.signer,
          loginChain: liveVault.chain,
          nearWallet: realAllocateSigner,
          onStage: setRealAllocateStage,
        });
        void announceOperation(queryClient, intentsAccountId, result.txHash);
        // Awaited, like the create path: the modal closes onto the new balance, not the old.
        await queryClient.invalidateQueries({
          queryKey: realPortfoliosQueryKey(intentsAccountId),
        });
        void queryClient.invalidateQueries({ queryKey: ["intents-balances", intentsAccountId] });
        void queryClient.invalidateQueries({ queryKey: pendingAllocatesQueryKey(intentsAccountId) });
        return result;
      } catch (e) {
        // Every failure refetches, for the reasons given in `createPortfolioWithChangeSet`
        // (D-298, D-304, D-293): the screen may be wrong in either direction.
        void queryClient.invalidateQueries({ queryKey: realPortfoliosQueryKey(intentsAccountId) });
        void queryClient.invalidateQueries({ queryKey: ["intents-balances", intentsAccountId] });
        void queryClient.invalidateQueries({ queryKey: pendingAllocatesQueryKey(intentsAccountId) });
        throw e;
      } finally {
        setRealAllocateStage(null);
      }
    },
    [
      intentsAccountId,
      activePortfolioId,
      portfolios,
      liveVault,
      loginChainKind,
      keyVerification,
      verifyKey,
      lang,
      assertWalletMatchesAccount,
      realAllocateSigner,
      queryClient,
    ]
  );

  // Rename and signed delete (017-9c). A real portfolio goes to the vault — v2 only: the
  // staging contract has neither field, and `run-real-portfolio-meta` refuses before signing
  // there. Every outcome re-reads the list: a deleted portfolio must leave the tabs, a renamed
  // one must show its new name, and an unconfirmed or replayed commit may have applied anyway.
  const runPortfolioMeta = useCallback(
    async (
      id: string,
      real: (base: Parameters<typeof runRealDeletePortfolio>[0]) => Promise<{ txHash: string | null }>,
      mock: (signature: Signature) => Promise<unknown> | unknown,
      signatureText: string
    ): Promise<void> => {
      // Throws rather than returns: the callers read a resolved promise as "done" (the modal
      // closes, the offer discards the draft).
      if (!intentsAccountId) throw new Error("Renaming or deleting a portfolio needs a signed-in account");
      const current = portfolios.find((p) => p.id === id);
      // An id the list no longer has (deleted elsewhere, dropped by a re-read) must not fall
      // through to the mock: that would ask the wallet to sign and then do nothing.
      if (!current) throw new Error(`Portfolio ${id} is no longer in the list`);
      if (
        current.isReal &&
        liveVault &&
        isLiveVaultRoute({ hasSigner: true, loginChain: loginChainKind, isRealPortfolio: true })
      ) {
        // Same doors as every other signed vault gesture (D-280 B4, then the wallet guard).
        await ensureCanOperate(keyVerification, verifyKey, lang);
        assertWalletMatchesAccount();
        // Sent, the history is told (028-7 (d)); a commit not confirmed in time may have applied.
        let sent: { txHash: string | null } | null = null;
        try {
          sent = await real({
            accountId: intentsAccountId,
            portfolioId: id,
            signer: liveVault.signer,
            loginChain: liveVault.chain,
            nearWallet: realAllocateSigner,
          });
        } catch (e) {
          if (e instanceof RealPortfolioMetaUnconfirmedError) sent = { txHash: e.txHash };
          throw e;
        } finally {
          if (sent) void announceOperation(queryClient, intentsAccountId, sent.txHash);
          else void queryClient.invalidateQueries({ queryKey: realPortfolioHistoryQueryKey(intentsAccountId) });
          await queryClient.invalidateQueries({ queryKey: realPortfoliosQueryKey(intentsAccountId) });
        }
        return;
      }
      if (current.isReal) {
        // A real portfolio with no route to the vault (no live signer): never fall through to
        // the mock, which would rename or drop a copy the chain does not have.
        throw new Error("This portfolio can only be changed with a live wallet session");
      }
      const signature = await signMessage(signatureText, intentsAccountId);
      await mock(signature);
    },
    [
      intentsAccountId,
      portfolios,
      liveVault,
      loginChainKind,
      keyVerification,
      verifyKey,
      lang,
      assertWalletMatchesAccount,
      realAllocateSigner,
      queryClient,
      signMessage,
    ]
  );

  const renamePortfolio = useCallback(
    async (id: string, name: string): Promise<void> => {
      const trimmed = name.trim();
      const t = shellTranslations[lang];
      await runPortfolioMeta(
        id,
        (base) => runRealRenamePortfolio({ ...base, name: trimmed }),
        (signature) => mockContract.renamePortfolio(intentsAccountId!, id, trimmed, signature),
        t.portfolioRenameSignatureText.replace("{name}", trimmed)
      );
    },
    [runPortfolioMeta, intentsAccountId, lang]
  );

  const deletePortfolio = useCallback(
    async (id: string): Promise<void> => {
      const name = portfolios.find((p) => p.id === id)?.name ?? "";
      const t = shellTranslations[lang];
      // Active-selection validity is repaired by the effect after re-derivation.
      await runPortfolioMeta(
        id,
        (base) => runRealDeletePortfolio(base),
        (signature) => mockContract.deletePortfolio(intentsAccountId!, id, signature),
        t.portfolioDeleteSignatureText.replace("{name}", name)
      );
    },
    [runPortfolioMeta, intentsAccountId, portfolios, lang]
  );

  const value: PortfolioContextValue = {
    portfolios,
    // `isLoading` and not `isFetching`: a background revalidation of a list we already
    // have must not blank the dashboard. Always false while the query is disabled.
    portfoliosLoading: realQuery.isLoading,
    portfoliosError: realQuery.data === undefined ? realQuery.error : null,
    portfoliosRefreshFailed: realQuery.data !== undefined && realQuery.error !== null,
    refetchPortfolios: () => void realQuery.refetch(),
    activePortfolio,
    activePortfolioId,
    setActivePortfolioId,
    commitChangeSet,
    createPortfolio,
    createPortfolioWithChangeSet,
    allocateIntoPortfolio,
    renamePortfolio,
    deletePortfolio,
    draftState,
    setDraftState,
    draftWasRestored,
    dismissRestoredDraft,
    realAllocateStage,
    realUnallocateStage,
    relaySends,
    vaultLive,
    setupSigner: intentsAccountId
      ? { accountId: intentsAccountId, loginAddress: vaultLive && liveVault ? liveVault.address : intentsAccountId }
      : null,
  };

  return <PortfolioContext.Provider value={value}>{children}</PortfolioContext.Provider>;
}

export function usePortfolio() {
  const ctx = useContext(PortfolioContext);
  if (!ctx) throw new Error("usePortfolio must be used within a PortfolioProvider");
  return ctx;
}
