"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useLoginWallet } from "@/features/login-wallet";
import {
  ANONYMOUS_DRAFT_SLOT,
  discardNewPortfolioDraft,
  discardNewPortfolioDraftIfUnchanged,
  draftFromSnapshot,
  draftsReplacedOnConnect,
  getNewPortfolioDraftsSnapshot,
  saveNewPortfolioDraft,
  saveNewPortfolioDraftSimulationUsd,
  subscribeNewPortfolioDrafts,
  type NewPortfolioDraft,
  type NewPortfolioDraftInput,
  type NewPortfolioDraftValidation,
  type ReplacedOnConnect,
} from "../lib/new-portfolio-draft";

// No drafts on the server render; the client snapshot takes over after hydration.
const getServerSnapshot = () => "";

/** D-397: the accounts' drafts the anonymous one would replace on connecting, live like the rest. */
export function useDraftsReplacedOnConnect(): ReplacedOnConnect[] {
  const raw = useSyncExternalStore(
    subscribeNewPortfolioDrafts,
    getNewPortfolioDraftsSnapshot,
    getServerSnapshot
  );
  return useMemo(() => draftsReplacedOnConnect(raw), [raw]);
}

export type UseNewPortfolioDraftResult = {
  draft: NewPortfolioDraft | null;
  /** Validates (duplicate names included) and saves; an invalid draft is not written. */
  save: (input: NewPortfolioDraftInput, existingNames: string[]) => NewPortfolioDraftValidation;
  discard: () => void;
  /** Discards it only if it is still the draft saved at `updatedAt` (the one just signed). */
  discardIfUnchanged: (updatedAt: number) => void;
  /** D-457 — the simulation's amount alone; the draft's `updatedAt` does not move. */
  saveSimulationUsd: (simulationUsd: number) => void;
};

/**
 * The signed-in account's New Portfolio Draft, live: saving or discarding it here, in
 * another component or in another tab re-renders every reader.
 *
 * D-359: with no identity at all the draft is the anonymous one. Only then: `connection`
 * falls back to the PERSISTED identity while a session restores, so someone coming back
 * signed in reads their own draft from the first render and never sees or overwrites the
 * anonymous one. An identity whose id could not be derived (`""`) keeps no draft, as before.
 */
export function useNewPortfolioDraft(): UseNewPortfolioDraftResult {
  const { connection, intentsAccountId } = useLoginWallet();
  const slot = connection === null ? ANONYMOUS_DRAFT_SLOT : intentsAccountId;
  const raw = useSyncExternalStore(
    subscribeNewPortfolioDrafts,
    getNewPortfolioDraftsSnapshot,
    getServerSnapshot
  );
  const draft = useMemo(() => draftFromSnapshot(raw, slot), [raw, slot]);

  const save = useCallback(
    (input: NewPortfolioDraftInput, existingNames: string[]) =>
      saveNewPortfolioDraft(slot, input, existingNames),
    [slot]
  );
  const discard = useCallback(() => discardNewPortfolioDraft(slot), [slot]);
  const discardIfUnchanged = useCallback(
    (updatedAt: number) => discardNewPortfolioDraftIfUnchanged(slot, updatedAt),
    [slot]
  );

  const saveSimulationUsd = useCallback(
    (simulationUsd: number) => saveNewPortfolioDraftSimulationUsd(slot, simulationUsd),
    [slot]
  );

  return { draft, save, discard, discardIfUnchanged, saveSimulationUsd };
}
