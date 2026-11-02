// The health probe behind `GET /api/ops/health` (ADR-0017 §7, second of the three failures).
//
// WHO CALLS IT: the solver's `OpsWatchdogService.probeFrontend`, from a host that is neither
// this platform nor the database — a watchdog hosted by the thing it watches goes down with
// it. The contract is measured, not assumed (`intentfolio-solver`,
// `src/intentfolio/ops-watchdog/ops-watchdog.service.ts`): it GETs the URL with a 5s abort,
// DRAINS the body without parsing it, and decides on `response.ok` alone. So the whole
// contract is 2xx / non-2xx. The JSON below is for humans with a terminal, and may change
// shape without touching the solver.
//
// THIS IS A READER. It must never be able to stop an Allocate by itself, which is a real risk
// and not a slogan: the endpoint is public and unauthenticated, the pool holds 3 connections
// by default, and the write path is FAIL-CLOSED — anyone who could make this endpoint consume
// those connections could stop every Allocate on the platform by hammering a URL. That is what
// the cached verdict below is for, and it is the load-bearing part of this file: the database
// cost is bounded by TIME, not by request volume.
//
// Attribution: see ATTRIBUTIONS.md #19.

import type { Queryable } from "./ops-records-service";

export type OpsHealthReason = "not-configured" | "query-failed";

export type OpsHealthVerdict = {
  ok: boolean;
  /** Absent when healthy. Public: it names the CLASS of failure, never the detail. */
  reason?: OpsHealthReason;
  /** When the underlying probe actually ran, epoch ms. */
  checkedAt: number;
  /** True when this answer came from the cache rather than a fresh probe. */
  cached: boolean;
  /**
   * Server-side only. Carries the database error and must NOT reach the response body: this
   * endpoint is unauthenticated, and a `pg` failure names hosts, users and schema objects.
   */
  detail?: string;
};

/**
 * How long a verdict is reused.
 *
 * Sized against the only consumer that matters: the watchdog probes every 5 minutes and alerts
 * after 2 consecutive failures, so it cannot notice staleness at this scale — 15s of a stale
 * verdict is invisible against a 10-minute detection floor. What it buys is the property
 * above: at most 4 database round-trips per minute per instance no matter how many requests
 * arrive.
 */
export const OPS_HEALTH_CACHE_MS = 15_000;

/**
 * The query.
 *
 * `SELECT 1 FROM allocate_rescue_record LIMIT 1`, not a bare `SELECT 1`. ADR-0017 §7 says "a
 * health endpoint that touches the database" and a bare `SELECT 1` technically does, but it
 * stays GREEN in the exact state this endpoint exists to catch: server up, connection fine,
 * and the table or the writer's grants missing — under which every Allocate fails fail-closed
 * while the watchdog sees nothing. Naming the table proves connectivity, schema and GRANT in
 * one round-trip.
 *
 * It reads no user data: the projection is the constant `1`, and `LIMIT 1` bounds the work
 * whether the table is empty or holds a million rows. An empty table is HEALTHY — the verdict
 * is "the statement did not throw", never "rows came back".
 */
export const OPS_HEALTH_SQL = "SELECT 1 FROM allocate_rescue_record LIMIT 1";

export type OpsHealthCheckerOptions = {
  /** Yields the pool, or the reason there is none. Mirrors `resolveOpsDb`. */
  resolve: () => { ok: true; db: Queryable } | { ok: false; issues: string[] };
  now?: () => number;
  cacheMs?: number;
  log?: (message: string) => void;
};

export type OpsHealthChecker = { check: () => Promise<OpsHealthVerdict> };

export function createOpsHealthChecker(options: OpsHealthCheckerOptions): OpsHealthChecker {
  const now = options.now ?? Date.now;
  const cacheMs = options.cacheMs ?? OPS_HEALTH_CACHE_MS;
  const log = options.log ?? ((m: string) => console.log(m));

  async function probe(): Promise<OpsHealthVerdict> {
    const checkedAt = now();
    const handle = options.resolve();
    if (!handle.ok) {
      // The issue list names environment VARIABLES, not their values, so it is safe to log —
      // but it still does not go in the response, which is public.
      const detail = handle.issues.join(", ");
      log(`[ops] health: database not configured (${detail})`);
      return { ok: false, reason: "not-configured", checkedAt, cached: false, detail };
    }

    try {
      await handle.db.query(OPS_HEALTH_SQL);
      return { ok: true, checkedAt, cached: false };
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      log(`[ops] health: probe FAILED: ${detail}`);
      return { ok: false, reason: "query-failed", checkedAt, cached: false, detail };
    }
  }

  return { check: cacheProbe(probe, { now, cacheMs }) };
}

/**
 * Reuses a probe's verdict for `cacheMs` and makes concurrent callers share one run. Also used by
 * `GET /api/ops/history-health` (D-496), which is public for the same reason this one is.
 */
export function cacheProbe<V extends { checkedAt: number; cached: boolean }>(
  probe: () => Promise<V>,
  options: { now: () => number; cacheMs: number }
): () => Promise<V> {
  let cached: V | null = null;
  // Concurrent requests share one probe. Without this the cache is useless under exactly the
  // load it exists to survive: N simultaneous requests all miss and all dial the database.
  let inFlight: Promise<V> | null = null;

  return async () => {
    const fresh = cached && options.now() - cached.checkedAt < options.cacheMs;
    if (fresh && cached) return { ...cached, cached: true };
    if (inFlight) return inFlight;

    inFlight = probe()
      .then((verdict) => {
        cached = verdict;
        return verdict;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}
