// Whether the vault would refuse a gesture before the user signs it (017-9b, D-302 a; `011` §3).
//
// Read when a confirmation modal opens, never inside the click: the wallet popup has to open in
// the click's activation window, with no network read in front of it. Advisory by construction —
// the state can change between this read and the chain executing — and it errs OPEN: an
// unreadable answer lets the user sign, because the contract refuses on its own. What it buys is
// the common case: no signature for something the vault would bounce, and for an Allocate no
// orphan, since the vault refuses a credit only AFTER the Transfer settled.
//
// Which reads apply follows the contract's own order (Appendix D.2):
//   - Allocate: the deposit cut, the `Allocations` pause, a frozen credited token.
//   - Commit with legs: the withdrawal cut, the `Unallocations` pause, a frozen withdrawn token.
//   - Commit without legs: the deposit cut only — the contract checks no pause there.
//
// Attribution: see ATTRIBUTIONS.md #8 (vault contract check order and views, Appendix D.1 / D.2).

import type { PauseState, ReservoirStatus } from "./vault-read-client";

export type PrecheckOp =
  /** `tokenIds`: the registry ids the Allocate credits. */
  | { kind: "allocate"; tokenIds: string[] }
  /** `legTokenIds`: the registry ids the commit withdraws; empty for a composition-only commit. */
  | { kind: "commit"; legTokenIds: string[] };

export type PrecheckBlock =
  /** Paused, or the vault's cut is closed. The user cannot tell the two apart, nor act on either. */
  | { reason: "unavailable" }
  | { reason: "token-frozen"; tokenId: string };

export type PrecheckReads = {
  pauseState: () => Promise<PauseState>;
  reservoir: () => Promise<ReservoirStatus>;
  tokenFreeze: (tokenId: string) => Promise<{ reason: string } | null>;
};

const ALLOCATIONS = 0;
const UNALLOCATIONS = 1;

/** A pause whose `until` has passed is dead: the contract expires it lazily, at the next call. */
function areaPaused(state: PauseState, area: number, nowSecs: number): boolean {
  const pause = state.areas?.[area];
  if (!pause) return false;
  return pause.until === null || pause.until === undefined || pause.until > nowSecs;
}

/** Resolves to what the settled promise holds, or null when the read failed (erring open). */
async function settle<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

/** The first reason the vault would refuse `op`, or null. Never throws. */
export async function runVaultPrecheck(
  op: PrecheckOp,
  reads: PrecheckReads,
  nowSecs: number = Math.floor(Date.now() / 1000)
): Promise<PrecheckBlock | null> {
  const isAllocate = op.kind === "allocate";
  const hasLegs = op.kind === "commit" && op.legTokenIds.length > 0;
  const pauseArea = isAllocate ? ALLOCATIONS : hasLegs ? UNALLOCATIONS : null;
  const frozenCandidates = op.kind === "allocate" ? op.tokenIds : op.legTokenIds;

  const [pause, reservoir, freezes] = await Promise.all([
    pauseArea === null ? null : settle(reads.pauseState),
    settle(reads.reservoir),
    Promise.all(frozenCandidates.map(async (tokenId) => ({ tokenId, record: await settle(() => reads.tokenFreeze(tokenId)) }))),
  ]);

  if (pause && pauseArea !== null && areaPaused(pause, pauseArea, nowSecs)) return { reason: "unavailable" };
  if (reservoir) {
    const open = hasLegs ? reservoir.withdrawals_open : reservoir.deposits_open;
    if (open === false) return { reason: "unavailable" };
  }
  const frozen = freezes.find((f) => f.record);
  if (frozen) return { reason: "token-frozen", tokenId: frozen.tokenId };
  return null;
}
