"use client";

// Where a wallet deposit stands, per (account, token) — OUTSIDE the panel (016 §5.3, block 2a).
//
// It used to be the panel's own state, and the panel unmounts on anything that leaves it: the QR
// tab, Back, closing the modal. Coming back mounted a fresh form while the wallet popup of the
// first deposit was still open, with "Deposit" enabled — a second deposit one click away. Kept in
// a module-level store, the phase outlives the component: a remounted panel shows what the deposit
// is actually doing, and a late verdict lands where the next panel will read it.
//
// Page memory only, on purpose. After a reload the wallet's own promise is gone too, and the
// General Balance is the source of truth to look at. Finished verdicts do not even outlive the
// modal (`clearFinishedWalletDeposits`); only a deposit still waiting on the wallet does.

import { useSyncExternalStore } from "react";
import type { EvmDepositResult } from "../lib/evm-wallet-deposit";
import type { WalletDepositResult } from "../lib/near-wallet-deposit";

// D-376: `runId` names the deposit a phase belongs to. A verdict that lands after a newer deposit
// of the same token started (past the 120 s wait) must not replace that deposit's phase.
export type WalletDepositPhase =
  | { kind: "form" }
  /** The wallet's approval screen is open. */
  | { kind: "waiting"; runId: number }
  /** The wallet answered; the outcome is being read. */
  | { kind: "confirming"; runId: number }
  | { kind: "done"; result: WalletDepositResult; runId: number };

/**
 * D-445 part 2: where an EVM wallet deposit stands. Same store, one more step: after the chain
 * confirms it (`confirming`), the bridge still has to credit it (`arriving`).
 */
export type EvmWalletDepositPhase =
  | { kind: "form" }
  | { kind: "waiting"; runId: number }
  | { kind: "confirming"; runId: number }
  | { kind: "arriving"; runId: number }
  | { kind: "done"; result: EvmDepositResult; runId: number };

/** Any phase the store holds. The two families' keys never meet: their token ids differ. */
type StoredPhase = WalletDepositPhase | EvmWalletDepositPhase;

const FORM: WalletDepositPhase = { kind: "form" };
const phases = new Map<string, StoredPhase>();
const listeners = new Set<() => void>();

export function walletDepositPhaseKey(accountId: string, tokenId: string): string {
  return `${accountId}|${tokenId}`;
}

/**
 * Synchronous read — what a click handler checks before it may send. The type parameter names the
 * family's phase; NEAR's is the default.
 */
export function getWalletDepositPhase<P extends StoredPhase = WalletDepositPhase>(key: string): P {
  return (phases.get(key) ?? FORM) as P;
}

export function setWalletDepositPhase<P extends StoredPhase = WalletDepositPhase>(key: string, phase: P): void {
  if (phase.kind === "form") phases.delete(key);
  else phases.set(key, phase);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useWalletDepositPhase<P extends StoredPhase = WalletDepositPhase>(key: string): P {
  return useSyncExternalStore(
    subscribe,
    () => getWalletDepositPhase<P>(key),
    () => FORM as P,
  );
}

// D-377: when the last verdict that may have moved funds (`credited` / `partial` / `unconfirmed`)
// landed, per ACCOUNT — any deposit spends the account's NEAR on gas, and the re-reads after it are
// account-wide. The next deposit waits until the balance it is judged against was read after the
// last scheduled re-read. Survives the panel's unmount and `clearFinishedWalletDeposits` on purpose:
// "Done" and reopening is as fast a way to a second deposit as "Make another deposit".
const verdictAts = new Map<string, number>();

export function recordWalletDepositVerdict(accountId: string, at: number): void {
  verdictAts.set(accountId, at);
  for (const listener of listeners) listener();
}

/** Synchronous read — what a deposit compares at its verdict against its click (D-377). */
export function getWalletDepositVerdictAt(accountId: string): number | undefined {
  return verdictAts.get(accountId);
}

export function useWalletDepositVerdictAt(accountId: string): number | undefined {
  return useSyncExternalStore(
    subscribe,
    () => verdictAts.get(accountId),
    () => undefined,
  );
}

/**
 * Drops every FINISHED deposit, keeping the ones still waiting on the wallet. Called when the
 * Receive modal opens (operator s181): a closed modal must not bring back an old verdict, while a
 * deposit whose wallet popup is still open must stay a deposit in flight — that one is what stops
 * a second send.
 */
export function clearFinishedWalletDeposits(): void {
  let changed = false;
  for (const [key, phase] of phases) {
    if (phase.kind === "done") {
      phases.delete(key);
      changed = true;
    }
  }
  if (changed) for (const listener of listeners) listener();
}

/** Tests only: the store is module state and would otherwise leak between cases. */
export function resetWalletDepositPhases(): void {
  phases.clear();
  verdictAts.clear();
  for (const listener of listeners) listener();
}
