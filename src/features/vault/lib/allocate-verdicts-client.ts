// Browser side of the rescue-verdict read (D-448). One POST per batch of ids, a 2 s budget, and
// every failure reads as "no verdict" — which is what the notice and the hygiene sweep did
// before the route existed: they fall back to their own on-chain reads.

import {
  ALLOCATE_VERDICTS,
  ALLOCATE_VERDICT_IDS_MAX,
  OPS_VERDICTS_ENDPOINT,
  type AllocateVerdict,
} from "./ops-records-types";
import { OPS_RECORDS_ENABLED } from "./vault-flag";

export const ALLOCATE_VERDICTS_TIMEOUT_MS = 2_000;

/** Keyed by lower-cased record id; a record with no verdict is absent. */
export type AllocateVerdicts = Record<string, AllocateVerdict>;

export type ReadAllocateVerdicts = (ids: string[]) => Promise<AllocateVerdicts>;

/** The verdict for a record, matching the lower-cased keys the route answers with. */
export function verdictFor(verdicts: AllocateVerdicts, id: string): AllocateVerdict | undefined {
  return verdicts[id.toLowerCase()];
}

/**
 * The verdicts for `ids`. Never throws. Without the ops database on this deployment (the flag
 * that gates the record writes) there is nothing to read, so nothing is sent.
 */
export async function fetchAllocateVerdicts(
  ids: string[],
  options: { fetchImpl?: typeof fetch; enabled?: boolean } = {}
): Promise<AllocateVerdicts> {
  if (!(options.enabled ?? OPS_RECORDS_ENABLED) || ids.length === 0) return {};
  const doFetch = options.fetchImpl ?? fetch;
  const verdicts: AllocateVerdicts = {};
  for (let i = 0; i < ids.length; i += ALLOCATE_VERDICT_IDS_MAX) {
    Object.assign(verdicts, await fetchBatch(ids.slice(i, i + ALLOCATE_VERDICT_IDS_MAX), doFetch));
  }
  return verdicts;
}

async function fetchBatch(ids: string[], doFetch: typeof fetch): Promise<AllocateVerdicts> {
  const asked = new Set(ids.map((id) => id.toLowerCase()));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ALLOCATE_VERDICTS_TIMEOUT_MS);
  try {
    const response = await doFetch(OPS_VERDICTS_ENDPOINT, {
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
    const out: AllocateVerdicts = {};
    for (const [id, verdict] of Object.entries(body.verdicts as Record<string, unknown>)) {
      const key = id.toLowerCase();
      if (asked.has(key) && ALLOCATE_VERDICTS.includes(verdict as AllocateVerdict)) {
        out[key] = verdict as AllocateVerdict;
      }
    }
    return out;
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}
