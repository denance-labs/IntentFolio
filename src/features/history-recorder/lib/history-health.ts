// The probe behind `GET /api/ops/history-health` (D-496): is the history recorder keeping up?
//
// WHO CALLS IT: the solver's ops watchdog, with a probe of its own beside the one for
// `/api/ops/health`, under the same contract (ATTRIBUTIONS.md #19): it reads 2xx / non-2xx and
// nothing else, so the JSON is for humans with a terminal. A route of its own rather than one more
// condition in `/api/ops/health`: that one's alert says Allocates are blocked, and a recorder
// that falls behind blocks nothing but fresh Performance numbers.
//
// The signal is the AGE OF THE DATA ("recorded until", `history_cursor.last_ok_at`), not whether
// the last pass failed (operator, D-496):
//   - it catches every failure that lasts, whatever its cause: a transaction the recorder cannot
//     record pins it, FastNEAR being down stops it, and a cron that no longer runs (a Vercel
//     Instant Rollback drops it) lets it age;
//   - `last_error` alone never fails the probe: a pass that found the lock taken, ran out of
//     time or dropped call arguments is a one-pass error, cleared by the next clean pass.
//
// Public and unauthenticated like its sibling, for the same reason (a watchdog must not carry a
// credential): the database cost is bounded by time (`cacheProbe`), the role can only SELECT,
// and the database's error stays in `detail`, out of the body.
//
// Attribution: see ATTRIBUTIONS.md #19.

import type { Queryable } from "@/features/vault/lib/ops-records-service";
import { cacheProbe } from "@/features/vault/lib/ops-health";

/**
 * Data recorded longer ago than this means the recorder is behind. The cron passes every hour
 * (`vercel.json`), so a working recorder is about an hour behind at worst even with nobody
 * reading; 3 h tolerates a run or two that Vercel skips. The watchdog adds up to ~1 h on top
 * (30-minute interval, 2 failed probes before it alerts).
 */
export const HISTORY_BEHIND_MS = 3 * 60 * 60 * 1000;

/** How long a verdict is reused: invisible next to the watchdog's interval, see `OPS_HEALTH_CACHE_MS`. */
export const HISTORY_HEALTH_CACHE_MS = 15_000;

export const HISTORY_HEALTH_SQL = "SELECT last_ok_at FROM history_cursor WHERE vault_id = $1";

export type HistoryHealthReason = "not-configured" | "query-failed" | "never-recorded" | "behind";

export type HistoryHealthVerdict = {
  ok: boolean;
  /** Absent when healthy. Public: it names the CLASS of failure, never the detail. */
  reason?: HistoryHealthReason;
  /** "Recorded until", epoch ms; null when nothing was ever recorded. Public on purpose: the read routes already serve it. */
  recordedUntil: number | null;
  /** When the underlying probe actually ran, epoch ms. */
  checkedAt: number;
  /** True when this answer came from the cache rather than a fresh probe. */
  cached: boolean;
  /** Server-side only: the database error or the missing variables. Must NOT reach the body. */
  detail?: string;
};

export type HistoryHealthCheckerOptions = {
  /** Yields the reader's pool, or the reason there is none. Mirrors `resolveHistoryReaderDb`. */
  resolve: () => { ok: true; db: Queryable } | { ok: false; issues: string[] };
  /** The configured vault; empty when this deployment has none. */
  vaultId: string;
  now?: () => number;
  cacheMs?: number;
  log?: (message: string) => void;
};

export function createHistoryHealthChecker(options: HistoryHealthCheckerOptions): {
  check: () => Promise<HistoryHealthVerdict>;
} {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((m: string) => console.log(m));

  async function probe(): Promise<HistoryHealthVerdict> {
    const checkedAt = now();
    const fail = (reason: HistoryHealthReason, recordedUntil: number | null, detail: string): HistoryHealthVerdict => {
      // Not `[history]`: that prefix is the recorder's own pass log, which is grepped on its own.
      log(`[history-health] ${reason}: ${detail}`);
      return { ok: false, reason, recordedUntil, checkedAt, cached: false, detail };
    };

    const handle = options.resolve();
    if (!handle.ok) return fail("not-configured", null, handle.issues.join(", "));
    if (options.vaultId === "") return fail("not-configured", null, "no vault is configured on this deployment");

    let lastOkAt: Date | null;
    try {
      const { rows } = await handle.db.query<{ last_ok_at: Date | null }>(HISTORY_HEALTH_SQL, [options.vaultId]);
      lastOkAt = rows[0]?.last_ok_at ?? null;
    } catch (e) {
      return fail("query-failed", null, e instanceof Error ? e.message : String(e));
    }

    if (lastOkAt === null) return fail("never-recorded", null, `no recorded position for ${options.vaultId}`);
    const recordedUntil = lastOkAt.getTime();
    const behindMs = checkedAt - recordedUntil;
    if (behindMs > HISTORY_BEHIND_MS) {
      return fail("behind", recordedUntil, `recorded until ${lastOkAt.toISOString()} (${(behindMs / 3_600_000).toFixed(1)} h ago)`);
    }
    return { ok: true, recordedUntil, checkedAt, cached: false };
  }

  return { check: cacheProbe(probe, { now, cacheMs: options.cacheMs ?? HISTORY_HEALTH_CACHE_MS }) };
}
