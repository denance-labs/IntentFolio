// Browser side of the withdrawal-verdict read (024-D). One POST per batch of ids, a 2 s budget,
// and every failure reads as "no verdict" — the pending-withdrawals hook then falls back to its
// own relay, nonce and bridge re-checks, as before the route existed.

import { ALLOCATE_VERDICT_IDS_MAX } from "@/features/vault/lib/ops-records-types";
import { WITHDRAW_RECORDS_ENABLED } from "./withdraw-records-flag";
import {
  WITHDRAW_FINAL_VERDICTS,
  WITHDRAW_VERDICTS_ENDPOINT,
  type WithdrawFinalVerdict,
  type WithdrawVerdictAnswer,
} from "./withdraw-records-types";

export const WITHDRAW_VERDICTS_TIMEOUT_MS = 2_000;

/** Keyed by lower-cased record id; a record with no final verdict is absent. */
export type WithdrawVerdicts = Record<string, WithdrawVerdictAnswer>;

export type ReadWithdrawVerdicts = (ids: string[]) => Promise<WithdrawVerdicts>;

const HASH_RE = /^[0-9A-Za-z+/=_-]{16,128}$/;

/**
 * The final verdicts for `ids`. Never throws. Without the withdrawal records on this deployment
 * (the flag that gates their writes) the solver has nothing to judge, so nothing is sent.
 */
export async function fetchWithdrawVerdicts(
  ids: string[],
  options: { fetchImpl?: typeof fetch; enabled?: boolean } = {}
): Promise<WithdrawVerdicts> {
  if (!(options.enabled ?? WITHDRAW_RECORDS_ENABLED) || ids.length === 0) return {};
  const doFetch = options.fetchImpl ?? fetch;
  const verdicts: WithdrawVerdicts = {};
  // The route takes the same batch ceiling as the Allocate read (it reuses its validation).
  for (let i = 0; i < ids.length; i += ALLOCATE_VERDICT_IDS_MAX) {
    Object.assign(verdicts, await fetchBatch(ids.slice(i, i + ALLOCATE_VERDICT_IDS_MAX), doFetch));
  }
  return verdicts;
}

async function fetchBatch(ids: string[], doFetch: typeof fetch): Promise<WithdrawVerdicts> {
  const asked = new Set(ids.map((id) => id.toLowerCase()));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WITHDRAW_VERDICTS_TIMEOUT_MS);
  try {
    const response = await doFetch(WITHDRAW_VERDICTS_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) return {};
    const body = (await response.json()) as { ok?: unknown; verdicts?: unknown };
    if (body.ok !== true || !body.verdicts || typeof body.verdicts !== "object") return {};
    // Only what was asked, and only verdicts this build knows: anything else is "not decided".
    const out: WithdrawVerdicts = {};
    for (const [id, raw] of Object.entries(body.verdicts as Record<string, unknown>)) {
      const key = id.toLowerCase();
      const answer = raw as { verdict?: unknown; txHash?: unknown; destinationTxHash?: unknown } | null;
      if (!asked.has(key) || !answer) continue;
      if (!WITHDRAW_FINAL_VERDICTS.includes(answer.verdict as WithdrawFinalVerdict)) continue;
      out[key] = {
        verdict: answer.verdict as WithdrawFinalVerdict,
        ...(isHash(answer.txHash) && { txHash: answer.txHash }),
        ...(isHash(answer.destinationTxHash) && { destinationTxHash: answer.destinationTxHash }),
      };
    }
    return out;
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}

function isHash(v: unknown): v is string {
  return typeof v === "string" && HASH_RE.test(v);
}
