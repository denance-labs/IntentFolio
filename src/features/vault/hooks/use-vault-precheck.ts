"use client";

// Whether the vault would refuse this gesture, asked when a confirmation modal opens (017-9b,
// D-302 a). Same shape as `useRelayPaused`: read on open, never in the click, starts and errs
// open. The reads live in `vault-precheck.ts`.

import { useEffect, useState } from "react";
import { VAULT_CONTRACT_ID } from "@/features/wallet/config/network";
import { runVaultPrecheck, type PrecheckBlock, type PrecheckOp } from "../lib/vault-precheck";
import { getPauseState, getReservoir, getTokenFreeze } from "../lib/vault-read-client";

const READS = { pauseState: getPauseState, reservoir: getReservoir, tokenFreeze: getTokenFreeze };

/** How often a refusal is asked again while the modal stays open (D-385 c). */
export const PRECHECK_RECHECK_MS = 15_000;

/** `op`: the gesture this modal would sign, or null when it signs nothing on the live vault. */
export function useVaultPrecheck(op: PrecheckOp | null): PrecheckBlock | null {
  const [block, setBlock] = useState<{ key: string; value: PrecheckBlock | null } | null>(null);
  // Keyed by content, not identity: callers build `op` inline on every render.
  const key = op ? `${op.kind}:${(op.kind === "allocate" ? op.tokenIds : op.legTokenIds).slice().sort().join(",")}` : null;

  useEffect(() => {
    // A new question starts open: an answer kept from before (the op went null and came back
    // with the same key) must not stand while the vault is asked again.
    setBlock(null);
    // No vault configured (local and mock builds): nothing to ask, and it errs open anyway.
    if (!op || key === null || VAULT_CONTRACT_ID === "") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = () => {
      void runVaultPrecheck(op, READS).then((value) => {
        if (cancelled) return;
        setBlock({ key, value });
        // D-385 (c): a refusal is asked again while the modal stays open, so a pause lifted
        // meanwhile clears without closing and reopening it. An open answer is not re-asked:
        // a pause that lands later is the contract's to refuse.
        if (value !== null) timer = setTimeout(ask, PRECHECK_RECHECK_MS);
      });
    };
    ask();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `op` is read through `key`, which is its whole content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // An answer for another token set is stale: the new one is still being read, and that errs open.
  return block && block.key === key ? block.value : null;
}
