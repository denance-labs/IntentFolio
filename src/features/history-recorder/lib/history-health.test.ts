// @vitest-environment node
import { describe, it, expect } from "vitest";
import type { Queryable } from "@/features/vault/lib/ops-records-service";
import {
  createHistoryHealthChecker,
  HISTORY_BEHIND_MS,
  HISTORY_HEALTH_CACHE_MS,
  HISTORY_HEALTH_SQL,
} from "./history-health";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const VAULT = "intentfolio-vault.near";

/** A reader that answers the cursor query with `lastOkAt`, recording every statement. */
function stubDb(answer: () => Promise<Array<{ last_ok_at: Date | null }>>) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const db: Queryable = {
    async query<R>(text: string, values?: unknown[]) {
      calls.push({ text, values: values ?? [] });
      const rows = await answer();
      return { rows: rows as R[], rowCount: rows.length };
    },
  };
  return { db, calls };
}

const recordedAgo = (ms: number) => async () => [{ last_ok_at: new Date(NOW - ms) }];

function checkerFor(db: Queryable, over: { vaultId?: string; now?: () => number; lines?: string[] } = {}) {
  return createHistoryHealthChecker({
    resolve: () => ({ ok: true, db }),
    vaultId: over.vaultId ?? VAULT,
    now: over.now ?? (() => NOW),
    log: (m) => over.lines?.push(m),
  });
}

describe("createHistoryHealthChecker", () => {
  it("is healthy while 'recorded until' is recent, and reads the configured vault's cursor", async () => {
    const { db, calls } = stubDb(recordedAgo(60 * 60 * 1000));

    const verdict = await checkerFor(db).check();

    expect(verdict).toEqual({ ok: true, recordedUntil: NOW - 60 * 60 * 1000, checkedAt: NOW, cached: false });
    expect(calls).toEqual([{ text: HISTORY_HEALTH_SQL, values: [VAULT] }]);
  });

  it("draws the line at 3 hours: at it still healthy, past it behind", async () => {
    // An hourly cron keeps a working recorder about an hour behind with nobody reading.
    expect(HISTORY_BEHIND_MS).toBe(3 * 60 * 60 * 1000);
    await expect(checkerFor(stubDb(recordedAgo(HISTORY_BEHIND_MS)).db).check()).resolves.toMatchObject({ ok: true });

    const lines: string[] = [];
    const verdict = await checkerFor(stubDb(recordedAgo(HISTORY_BEHIND_MS + 1)).db, { lines }).check();

    expect(verdict).toMatchObject({ ok: false, reason: "behind", recordedUntil: NOW - HISTORY_BEHIND_MS - 1 });
    expect(lines[0]).toMatch(/^\[history-health\] behind: recorded until 2026-10-17T08:59:59\.999Z \(3\.0 h ago\)$/);
  });

  it("fails when nothing was ever recorded: no cursor row, or a row with no position yet", async () => {
    await expect(checkerFor(stubDb(async () => []).db).check()).resolves.toMatchObject({
      ok: false,
      reason: "never-recorded",
      recordedUntil: null,
    });
    await expect(checkerFor(stubDb(async () => [{ last_ok_at: null }]).db).check()).resolves.toMatchObject({
      ok: false,
      reason: "never-recorded",
    });
  });

  it("reports not-configured without dialling anything: no reader credential, or no vault", async () => {
    const lines: string[] = [];
    const unconfigured = createHistoryHealthChecker({
      resolve: () => ({ ok: false, issues: ["missing INTENTFOLIO_HISTORY_READER_DB_URL"] }),
      vaultId: VAULT,
      log: (m) => lines.push(m),
    });
    await expect(unconfigured.check()).resolves.toMatchObject({
      ok: false,
      reason: "not-configured",
      detail: "missing INTENTFOLIO_HISTORY_READER_DB_URL",
    });
    expect(lines[0]).toContain("not-configured");

    const { db, calls } = stubDb(recordedAgo(0));
    await expect(checkerFor(db, { vaultId: "" }).check()).resolves.toMatchObject({ ok: false, reason: "not-configured" });
    expect(calls).toHaveLength(0);
  });

  it("reports query-failed and keeps the database error in `detail` only", async () => {
    const { db } = stubDb(() => Promise.reject(new Error("permission denied for table history_cursor")));

    const verdict = await checkerFor(db).check();

    expect(verdict).toMatchObject({ ok: false, reason: "query-failed", recordedUntil: null });
    expect(verdict.detail).toBe("permission denied for table history_cursor");
  });

  it("bounds database load by TIME: one probe per cache window, shared by concurrent callers", async () => {
    let now = NOW;
    const { db, calls } = stubDb(recordedAgo(0));
    const checker = checkerFor(db, { now: () => now });

    const burst = await Promise.all(Array.from({ length: 10 }, () => checker.check()));
    expect(calls).toHaveLength(1);
    expect(burst.every((v) => v.ok)).toBe(true);

    now += HISTORY_HEALTH_CACHE_MS - 1;
    await expect(checker.check()).resolves.toMatchObject({ ok: true, cached: true });
    expect(calls).toHaveLength(1);

    now += 1;
    await expect(checker.check()).resolves.toMatchObject({ cached: false });
    expect(calls).toHaveLength(2);
  });
});
