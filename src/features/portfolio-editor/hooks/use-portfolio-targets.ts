"use client";

import { useCallback, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { usePortfolio } from "@/features/dashboard-shell/context/portfolio-context";
import { useAvailableGeneralBalance } from "@/features/dashboard-shell/hooks/use-available-general-balance";
import { symbolForTokenId, tokenRegistry } from "@/features/market/lib/token-registry";
import {
  currentUsdWeightPct,
  demotePromotedAtZero,
  distributeUnlockedTargetPct,
  makeTarget,
  promoteHeldToTarget,
  removeTargetFromDraft,
  restoreRemovedTarget,
  setAllLockState
} from "../lib/allocation";
import {
  buildChangeSet,
  buildPendingMarks,
  changeSummaryToSignatureText,
  isEmptyChangeSet,
  summarizeChangeSet,
  type BalanceDeltas,
  type ChangeSummary,
} from "../lib/changeset";
import type { PortfolioChangeSet } from "@/features/intents-account/mock-contract/types";
import { normalizeWalletError, type WalletErrorKind } from "@/features/wallet/adapter/normalize-error";
import {
  RealChangeSetInvalidError,
  RealUnallocateDeferredError,
  RealUnallocateTransferFailedError,
  VaultCommitRevertedError,
} from "@/features/vault/lib/vault-errors";
import { classifyCommitFailure, type CommitRefusal } from "@/features/vault/lib/vault-error-code";
import { RealUnallocateUnconfirmedError } from "@/features/vault/lib/run-real-unallocate";
import type { TokenPriceMap } from "@/features/market/types";
import { translations } from "../lib/translations";
import { markUnconfirmedWithdrawal } from "../lib/unconfirmed-withdrawal-mark";
import type { CurrentPortfolioQty, Language, TargetAllocation, ToastState } from "../types";

// One definition of "how a token id is shown" across every surface — this used to be a
// private copy whose fallback emitted the raw NEP-245 token segment (D-235).
const symbolFor = symbolForTokenId;

// Stable empty-delta identity so memo/dep arrays don't churn when no draft exists.
const EMPTY_DELTAS: BalanceDeltas = {};
// Below this (token units) a balance delta is treated as no move (float-noise guard).
const QTY_EPSILON = 1e-9;

// Classified signing failure (5.5): kind drives the modal copy + the Retry affordance,
// message keeps the raw wallet text for the technical-detail line on unexpected errors.
// `refusal` is set when the vault reverted the commit with a code the user can be told about
// (017-9b, D-302 f): nothing moved, and the modal says why instead of the generic line.
export type SignError = { kind: WalletErrorKind; message: string; refusal?: CommitRefusal };

// A live-vault outcome that is NOT a failure and must not read like one (007.plan Phase
// 2): the chain accepted the transaction and deliberately did nothing, or the pre-flight
// refused the change before signing. Kept apart from SignError so the modal never offers
// "Retry" for a countdown the user can only wait out.
export type VaultNotice =
  | { kind: "deferred"; nextReleaseAt: number }
  // The offline pre-flight refused the change set: it would have been rejected on-chain.
  // `reason` is a `PreflightReason`; the modal maps the ones a user can act on and falls
  // back to a generic line for the structural ones they cannot cause.
  | { kind: "change-set-invalid"; reason: string }
  // Sent, but the chain was not seen to apply it (a relay answer that proved nothing, or a
  // settlement the poll missed; D-329). It may have landed, so the modal offers no Retry — a
  // second signature could withdraw twice. Closing drops the draft; the chain is re-read.
  | { kind: "unconfirmed" }
  // The commit applied but its withdrawal could not be sent (D-385 a): the funds are still in the
  // portfolio. Like `unconfirmed`, only Close: the draft's edits are already on-chain.
  | { kind: "transfer-failed" };

export function usePortfolioTargets({
  lang,
  setToast,
  priceMap,
}: {
  lang: Language;
  setToast: (t: ToastState) => void;
  priceMap: TokenPriceMap;
}) {
  const { activePortfolio, commitChangeSet, draftState, setDraftState } = usePortfolio();
  const activeId = activePortfolio?.id ?? null;
  const defaultTolerancePct = activePortfolio?.defaultTolerancePct ?? 10;
  // Stable identity so requestCommit's dep array doesn't change every render.
  const committed = useMemo(() => activePortfolio?.targets ?? [], [activePortfolio?.targets]);
  // Committed portfolio balances (read-model from the mock); the draft moves funds in
  // and out of these via balanceDeltas (5.3.2) instead of writing through.
  const committedBalances = useMemo<CurrentPortfolioQty>(
    () => activePortfolio?.deposits ?? {},
    [activePortfolio?.deposits]
  );
  // Available General Balance per token (on-chain − committed allocations across all
  // portfolios), the source the draft allocates from.
  const generalBalanceBase = useAvailableGeneralBalance();

  // Draft state (5.0 snapshot→draft, 5.3.1 confirm flow, 5.3.2 balances): while editing,
  // composition AND balance moves live in an ephemeral draft and are NOT persisted
  // per-keystroke. balanceDeltas is a signed per-token quantity (+ = allocate from
  // General Balance, − = unallocate back). The draft is tagged with the portfolio id it
  // belongs to, so switching portfolios mid-edit drops it cleanly. Save (requestCommit)
  // diffs the draft into one signed changeset; Cancel discards it.
  //
  // 5.4-A: the storage was hoisted to the PortfolioProvider (persistent layout) so the
  // draft survives route navigation; this hook still owns all the mutation logic and
  // just reads/writes draftState through the context.
  const draftRecord = draftState && draftState.id === activeId ? draftState : null;
  const draft = draftRecord?.targets ?? null;
  const balanceDeltas = draftRecord?.balanceDeltas ?? EMPTY_DELTAS;
  const isEditing = draft !== null;
  const targets = draft ?? committed;
  // Whether Save would sign anything. An open draft with no diff is just edit mode. Read by
  // the Add tokens modal on a real portfolio (013.plan P6): funding changes the portfolio
  // under the draft, and the next Save would remove a token the funding just added.
  const draftChangeSet = useMemo(
    () => (draft === null ? null : buildChangeSet(committed, draft, balanceDeltas)),
    [draft, committed, balanceDeltas]
  );
  const hasDraftChanges = draftChangeSet !== null && !isEmptyChangeSet(draftChangeSet);
  // 021 R2: the same diff, as row marks for the table, so the user sees in place what Save
  // would sign instead of having to remember it.
  // D-536: funds-only tokens, in registry order like the table's held rows, so one the draft
  // empties is struck in place instead of vanishing.
  const heldOutside = useMemo(() => {
    const inComposition = new Set(committed.map((t) => t.tokenId));
    const out: Record<string, number> = {};
    for (const token of tokenRegistry) {
      const qty = committedBalances[token.id] ?? 0;
      if (qty > 0 && !inComposition.has(token.id)) out[token.id] = qty;
    }
    return out;
  }, [committed, committedBalances]);
  const pendingMarks = useMemo(
    () =>
      draftChangeSet === null
        ? null
        : buildPendingMarks(summarizeChangeSet(draftChangeSet, committed, symbolFor), committed, heldOutside),
    [draftChangeSet, committed, heldOutside]
  );

  // Read at call time by the draft mutators so their identity stays stable across
  // keystrokes. committedRef seeds a fresh draft (allocate/unallocate can start one).
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const committedRef = useRef(committed);
  committedRef.current = committed;
  // Read at allocate time (prices tick every 15s, default tolerance is portfolio-scoped)
  // so allocateToPortfolio can stay a stable, dep-free callback.
  const committedBalancesRef = useRef(committedBalances);
  committedBalancesRef.current = committedBalances;
  const pricesRef = useRef(priceMap);
  pricesRef.current = priceMap;
  const defaultToleranceRef = useRef(defaultTolerancePct);
  defaultToleranceRef.current = defaultTolerancePct;

  // Effective portfolio balances = committed + draft deltas (clamped ≥ 0). Feeds the
  // donut, current %, and the validation gate — so a drafted allocation/unallocation is
  // reflected live and the gate matches what the contract validates after the commit.
  const effectiveCurrentPortfolioQty = useMemo<CurrentPortfolioQty>(() => {
    const out: CurrentPortfolioQty = {};
    const ids = new Set([...Object.keys(committedBalances), ...Object.keys(balanceDeltas)]);
    for (const id of ids) {
      const qty = (committedBalances[id] ?? 0) + (balanceDeltas[id] ?? 0);
      if (qty > QTY_EPSILON) out[id] = qty;
    }
    return out;
  }, [committedBalances, balanceDeltas]);

  // Live available to allocate = base available − draft delta (a drafted allocation
  // reduces it; a drafted unallocation frees that qty back for re-allocation). The
  // allocate source list + the over-allocation guard (D-071) both read this.
  const generalBalanceAvailable = useMemo<Map<string, number>>(() => {
    const out = new Map<string, number>();
    const ids = new Set([...generalBalanceBase.keys(), ...Object.keys(balanceDeltas)]);
    for (const id of ids) {
      const free = (generalBalanceBase.get(id) ?? 0) - (balanceDeltas[id] ?? 0);
      if (free > QTY_EPSILON) out.set(id, free);
    }
    return out;
  }, [generalBalanceBase, balanceDeltas]);

  // Seed a fresh draft from the committed portfolio when a mutation starts one outside
  // edit mode (allocate/unallocate can begin editing). Returns the draft to mutate.
  const ensureDraft = (current: typeof draftState): NonNullable<typeof draftState> => {
    if (current && current.id === activeIdRef.current) return current;
    return {
      id: activeIdRef.current as string,
      targets: committedRef.current.map((t) => ({ ...t })),
      balanceDeltas: {},
    };
  };

  const setTargets: Dispatch<SetStateAction<TargetAllocation[]>> = useCallback(
    (action) => {
      // Composition edits only mutate the active draft (5.3.1). There is no
      // write-through outside edit mode: composition reaches the contract solely
      // through requestCommit → signature → commitPortfolioChanges. "+ Add token"
      // enters edit mode first, so additions always land in a draft.
      setDraftState((current) =>
        current && current.id === activeIdRef.current
          ? { ...current, targets: typeof action === "function" ? action(current.targets) : action }
          : current
      );
    },
    [setDraftState]
  );

  const beginEdit = useCallback(() => {
    if (activeId === null) return;
    setDraftState({
      id: activeId,
      targets: (activePortfolio?.targets ?? []).map((t) => ({ ...t })),
      balanceDeltas: {},
    });
  }, [activeId, activePortfolio?.targets, setDraftState]);

  const discardDraft = useCallback(() => setDraftState(null), [setDraftState]);

  // Confirm flow (5.3.1): Save no longer writes through. It diffs the draft against the
  // committed composition; a no-op diff just exits edit mode, otherwise it opens a
  // preview the user signs once. The pending changeset + its display summary are held
  // here so the modal renders exactly what gets signed.
  const [preview, setPreview] = useState<{ changeset: PortfolioChangeSet; summary: ChangeSummary } | null>(null);
  const [isSigning, setIsSigning] = useState(false);
  // 5.5: classified so the modal can tell the user apart a rejection (retry), a locked/
  // unavailable wallet (unlock + retry) and an unexpected failure. The draft is kept in
  // every case (the catch never nulls draftState) so Retry re-signs the same changeset.
  const [signError, setSignError] = useState<SignError | null>(null);
  // Live-vault outcome of the last attempt (deferred / unsupported). Mutually exclusive
  // with signError: whichever the attempt produced, it replaces the other.
  const [vaultNotice, setVaultNotice] = useState<VaultNotice | null>(null);

  const requestCommit = useCallback(() => {
    if (!draft) return;
    const changeset = buildChangeSet(committed, draft, balanceDeltas);
    if (isEmptyChangeSet(changeset)) {
      setDraftState(null); // nothing changed → leave edit mode without a signature
      return;
    }
    setSignError(null);
    setVaultNotice(null);
    setPreview({ changeset, summary: summarizeChangeSet(changeset, committed, symbolFor) });
  }, [draft, committed, balanceDeltas, setDraftState]);

  // Resolves `true` once the commit went through, so the caller can confirm what moved (D-314).
  const confirmCommit = useCallback(async (): Promise<boolean> => {
    if (!preview) return false;
    setIsSigning(true);
    setSignError(null);
    setVaultNotice(null);
    // D-369: a withdrawal that may have landed keeps warning in the editor after Close.
    const setUnconfirmed = () => {
      if (activeId !== null && (preview.changeset.unallocations?.length ?? 0) > 0) {
        markUnconfirmedWithdrawal(activeId);
      }
      setVaultNotice({ kind: "unconfirmed" });
    };
    try {
      const text = changeSummaryToSignatureText(preview.summary, activePortfolio?.name ?? "");
      await commitChangeSet(preview.changeset, text);
      setPreview(null);
      setDraftState(null); // back to read-mode; the read-model re-derives from the mock
      return true;
    } catch (e) {
      // Draft is intentionally left intact here so Retry re-signs without rebuilding.
      // A vault notice is classified first: nothing failed, so the wallet-error copy
      // ("cancelled", "unavailable") would misdescribe what happened.
      if (e instanceof RealUnallocateDeferredError) {
        setVaultNotice({ kind: "deferred", nextReleaseAt: e.nextReleaseAt });
      } else if (e instanceof RealChangeSetInvalidError) {
        setVaultNotice({ kind: "change-set-invalid", reason: e.reason });
      } else if (e instanceof RealUnallocateUnconfirmedError) {
        setUnconfirmed();
      } else if (e instanceof RealUnallocateTransferFailedError) {
        setVaultNotice({ kind: "transfer-failed" });
      } else if (e instanceof VaultCommitRevertedError) {
        // The replay codes are what a commit that ALREADY applied answers (D-302 j): not
        // confirmed, never "nothing moved". Every other code reverted cleanly.
        const verdict = classifyCommitFailure(e.reason);
        // Any code without its own copy means the app and the contract disagree: ops needs it.
        if (verdict === null) console.warn("[vault] commit reverted with an unmapped reason:", e.reason);
        if (verdict === "unconfirmed") {
          setUnconfirmed();
        } else {
          setSignError({ ...normalizeWalletError(e), ...(verdict ? { refusal: verdict } : {}) });
        }
      } else {
        setSignError(normalizeWalletError(e));
      }
      return false;
    } finally {
      setIsSigning(false);
    }
  }, [preview, activeId, activePortfolio?.name, commitChangeSet, setDraftState]);

  // D-094: cancelling the preview keeps the draft (back to edit), unlike discardDraft — except
  // after an unconfirmed commit: that draft may already be on-chain, and re-editing it would
  // invite signing it twice. The portfolio shown next is the one re-read from the chain.
  const cancelPreview = useCallback(() => {
    if (vaultNotice?.kind === "unconfirmed" || vaultNotice?.kind === "transfer-failed") setDraftState(null);
    setPreview(null);
    setSignError(null);
    setVaultNotice(null);
  }, [vaultNotice, setDraftState]);

  // Add a brand-new token to the composition at target 0% (7.5b-09: the unified
  // "Add tokens" modal uses this for tokens the user has no General Balance to fund
  // yet — they enter as a target-only row, editable in the table afterwards). Uses
  // ensureDraft so it can start a draft on its own (no prior beginEdit needed) and
  // no-ops if the token already has a target.
  const addTargetToken = useCallback((tokenId: string) => {
    if (!tokenId) return;
    setDraftState((current) => {
      const base = ensureDraft(current);
      if (base.targets.some((t) => t.tokenId === tokenId)) return base;
      return {
        ...base,
        targets: [...base.targets, makeTarget(tokenId, 0, defaultToleranceRef.current, false)],
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ensureDraft reads refs only
  }, []);

  // Unallocate qty of a token back to General Balance (− delta). Cumulative across
  // repeated calls; the caller (withdraw dialog) caps qty at the effective balance.
  const unallocate = useCallback((tokenId: string, qty: number) => {
    if (qty <= 0) return;
    setDraftState((current) => {
      const base = ensureDraft(current);
      const committedQty = committedBalancesRef.current[tokenId] ?? 0;
      let delta = (base.balanceDeltas[tokenId] ?? 0) - qty;
      // A withdrawal that empties the position must sign exactly what it holds (D-343). After
      // a partial one, Max is `committed − partial`, and adding the two back is off by a float
      // ulp — below the committed figure in ~1.6% of 6-decimal cases, which truncates one base
      // unit short and leaves it behind. Same noise bound as `capToHeld` (10⁻¹² relative).
      const leftover = committedQty + delta;
      if (committedQty > 0 && Math.abs(leftover) <= Math.max(committedQty, -delta) * 1e-12) {
        delta = -committedQty;
      }
      return {
        ...base,
        balanceDeltas: { ...base.balanceDeltas, [tokenId]: delta },
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ensureDraft reads refs only
  }, []);

  const updateTarget = useCallback(
    (id: string, patch: Partial<TargetAllocation>) => {
      // D-008: tolerance lives in the hard band [2%, 30%]. An out-of-band value is no
      // longer silently snapped to the floor/ceiling — it's kept as typed so the rules
      // engine surfaces a `tolerance-below-min` / `-above-max` error and the Save gate
      // (validation.hasErrors) blocks the commit. The "never committed out of band"
      // invariant is preserved by the gate instead of by a clamp.
      setTargets((current) => current.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    },
    [setTargets]
  );

  const updateTargetPct = useCallback(
    (id: string, nextPct: number | string) => {
      setTargets((current) => demotePromotedAtZero(distributeUnlockedTargetPct(current, id, nextPct).targets));
    },
    [setTargets]
  );

  // D-143 (5.2): typing a target % or moving the bar on a held-no-target row promotes it to
  // a real target and redistributes so the unlocked rows still sum to 100. Only reachable in
  // edit mode, so it routes to the draft like any other composition edit. D-513: per input,
  // not on commit — the row keeps its place (usePortfolioComputed), and a 0 promotes nothing.
  const promoteHeldTarget = useCallback(
    (tokenId: string, nextPct: number | string) => {
      if (!((Number(nextPct) || 0) > 0)) return;
      setTargets((current) => promoteHeldToTarget(current, tokenId, nextPct, defaultTolerancePct));
    },
    [setTargets, defaultTolerancePct]
  );

  const toggleLock = useCallback(
    (id: string) => {
      setTargets((current) => {
        const target = current.find((row) => row.id === id);
        if (!target) return current;
        if (!target.locked) {
          const unlockedCount = current.filter((row) => !row.locked).length;
          if (unlockedCount === 2) {
            setToast({ kind: "warn", text: translations[lang].minTwoUnlocked });
            return current;
          }
        }
        return current.map((row) => (row.id === id ? { ...row, locked: !row.locked } : row));
      });
    },
    [lang, setToast, setTargets]
  );

  const removeTarget = useCallback(
    (id: string) => {
      setDraftState((current) => {
        if (!current || current.id !== activeIdRef.current) return current;
        const removed = current.targets.find((row) => row.id === id);
        const { targets: next, autoLocked } = removeTargetFromDraft(current.targets, id);
        if (autoLocked) setToast({ kind: "warn", text: translations[lang].autoLockedAfterRemove });
        // Only a token the portfolio holds stays on screen as a removed row with "Undo"; one
        // added in this same draft just goes.
        const undoable = removed && committedRef.current.some((row) => row.tokenId === removed.tokenId);
        return {
          ...current,
          targets: next,
          ...(undoable
            ? { undoRemoval: { ...current.undoRemoval, [removed.tokenId]: current.targets } }
            : {}),
        };
      });
    },
    [lang, setToast, setDraftState]
  );

  // 021 R2: "Undo" on a removed row. The token comes back as the portfolio holds it —
  // target, band and balance: any move of its funds staged in this draft is dropped too,
  // since the removal is what emptied it (see restoreRemovedTarget for the %).
  const undoRemoveTarget = useCallback(
    (tokenId: string) => {
      setDraftState((current) => {
        if (!current || current.id !== activeIdRef.current) return current;
        const { [tokenId]: before, ...undoRemoval } = current.undoRemoval ?? {};
        const balanceDeltas = { ...current.balanceDeltas };
        delete balanceDeltas[tokenId];
        return {
          ...current,
          targets: restoreRemovedTarget(current.targets, committedRef.current, tokenId, before),
          balanceDeltas,
          undoRemoval,
        };
      });
    },
    [setDraftState]
  );

  const lockAllTargets = useCallback(
    () => setTargets((current) => setAllLockState(current, true)),
    [setTargets]
  );
  const unlockAllTargets = useCallback(
    () => setTargets((current) => setAllLockState(current, false)),
    [setTargets]
  );

  // Allocate qty of a token from General Balance into the portfolio (+ delta). The
  // caller (allocate modal) caps qty at the live available balance (D-071 over-allocation
  // guard).
  //
  // D-143(3) (5.3.x): funding a BLANK portfolio seeds each token's target at its
  // post-allocate USD weight, so targets track weights by induction as the portfolio is
  // built (1 token → 100/100; a second equal-value token → 50/50). If the token ALREADY
  // has a target (topping it up), only funds move — its deliberate target is untouched,
  // and the resulting current≠target is the normal rebalance state.
  //
  // D-174 (008.plan Phase 1) narrows that seeding to the case it was written for. A
  // deposit must NEVER rewrite a composition the user already declared. The old rule did,
  // catastrophically: on a portfolio that had been emptied, the newly funded token's weight
  // is 100% by construction, so `promoteHeldToTarget` scaled every declared target to 0.
  // That is the local write behind the "5 targets at 0.0%" the operator reported while
  // `get_portfolio` still returned 3000/2500/1500/2000/1000 — the UI contradicting the
  // chain about the user's own stated intent. Reproduced exactly: a=0 b=0 c=0 d=0 e=0,
  // z=100. It was never limited to real portfolios or to withdrawals; ANY portfolio at
  // zero value lost its strategy to the next deposit of a new token.
  //
  // So: a declared composition (targets summing above zero) is left alone and the funded
  // token enters as a 0% row, exactly like `addTargetToken`. It is not out of the
  // portfolio — it is held, out of band, and converges into the declared mix, which is
  // what depositing into a strategy is supposed to mean.
  const allocateToPortfolio = useCallback((tokenId: string, qty: number) => {
    if (qty <= 0) return;
    setDraftState((current) => {
      const base = ensureDraft(current);
      const nextDeltas = {
        ...base.balanceDeltas,
        [tokenId]: (base.balanceDeltas[tokenId] ?? 0) + qty,
      };
      if (base.targets.some((t) => t.tokenId === tokenId)) {
        return { ...base, balanceDeltas: nextDeltas };
      }
      const declaredPct = base.targets.reduce((sum, t) => sum + (Number(t.targetPct) || 0), 0);
      if (declaredPct > 0) {
        return {
          ...base,
          balanceDeltas: nextDeltas,
          targets: [...base.targets, makeTarget(tokenId, 0, defaultToleranceRef.current, false)],
        };
      }
      const weightPct = currentUsdWeightPct(
        tokenId,
        committedBalancesRef.current,
        nextDeltas,
        pricesRef.current
      );
      const nextTargets = promoteHeldToTarget(base.targets, tokenId, weightPct, defaultToleranceRef.current);
      return { ...base, balanceDeltas: nextDeltas, targets: nextTargets };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads refs only
  }, []);

  return {
    targets,
    setTargets,
    isEditing,
    hasDraftChanges,
    pendingMarks,
    beginEdit,
    discardDraft,
    requestCommit,
    confirmCommit,
    cancelPreview,
    preview,
    isSigning,
    signError,
    vaultNotice,
    deposits: committedBalances,
    effectiveCurrentPortfolioQty,
    generalBalanceAvailable,
    updateTarget,
    updateTargetPct,
    promoteHeldTarget,
    toggleLock,
    removeTarget,
    undoRemoveTarget,
    lockAllTargets,
    unlockAllTargets,
    allocateToPortfolio,
    addTargetToken,
    unallocate,
  };
}
