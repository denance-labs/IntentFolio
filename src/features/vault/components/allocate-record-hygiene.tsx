"use client";

// Runs the rescue-record hygiene sweep once per app load (009.plan FE #4). Renders nothing.
//
// No logic lives here: `reconcileSuspectedOrphans` decides what a candidate is and what to
// do with it; this only hands it the real store, the real seal read and the real sink, from
// a `useEffect` — after the first render, never on the path of a click.
// Since D-295 it also writes `failed` for sent records whose envelope provably never ran, and
// since 026 it reads the solver's final verdicts first (D-448).
// Since 017-2 (D-365) it also deletes the relayer token testers used to paste, on every load and
// whatever the flags: the relay no longer reads it, so it is only a stale secret. The same goes for
// the v1 chain-history cache (D-420).
//
// Inert unless NEXT_PUBLIC_VAULT_ROUNDTRIP is on: the records only exist when the live path
// ran. It is mounted in the root layout, so it also mounts on `/mock-dashboard`, where it
// reads the (empty) real store and touches nothing of the mock ledger.

import { useEffect } from "react";
import { VAULT_ROUNDTRIP_ENABLED } from "../lib/vault-flag";
import { listAllocateRecords } from "../lib/allocate-rescue-store";
import { readAllocateSeal } from "../lib/allocate-seal";
import { confirmAllocateRecordCredited, markAllocateRecordNeverExecuted } from "../lib/allocate-record-sink";
import { readNonceWitness } from "../lib/intents-read-client";
import { fetchAllocateVerdicts } from "../lib/allocate-verdicts-client";
import { reconcileSuspectedOrphans } from "../lib/allocate-record-hygiene";
import { clearLegacyRelayToken } from "../lib/relay-client";
import { clearLegacyHistoryCache } from "../lib/vault-history-legacy";

// One pass per load. StrictMode mounts twice in development and the flip is idempotent, but
// two concurrent passes would still send two PATCHes for every candidate.
let started = false;

export function AllocateRecordHygiene() {
  useEffect(() => {
    clearLegacyRelayToken();
    clearLegacyHistoryCache();
    if (!VAULT_ROUNDTRIP_ENABLED || started) return;
    started = true;
    void reconcileSuspectedOrphans({
      records: listAllocateRecords,
      readSeal: readAllocateSeal,
      confirm: confirmAllocateRecordCredited,
      readNonceWitness,
      markNeverExecuted: markAllocateRecordNeverExecuted,
      readVerdicts: (ids) => fetchAllocateVerdicts(ids),
      log: (message) => console.log(message),
    });
  }, []);
  return null;
}
