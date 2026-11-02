// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { createOpsHealthChecker, OPS_HEALTH_SQL, OPS_HEALTH_CACHE_MS } from "./ops-health";
import type { Queryable } from "./ops-records-service";

/** Records every statement, so "did it touch the database" is an assertion and not a guess. */
function stubDb(impl?: () => Promise<{ rows: unknown[]; rowCount: number | null }>) {
  const statements: string[] = [];
  const db: Queryable = {
    async query<R>(text: string) {
      statements.push(text);
      const result = impl ? await impl() : { rows: [], rowCount: 0 };
      return result as { rows: R[]; rowCount: number | null };
    },
  };
  return { db, statements };
}

describe("createOpsHealthChecker", () => {
  it("reports healthy after touching the table with the writer's credential", async () => {
    const { db, statements } = stubDb();
    const checker = createOpsHealthChecker({ resolve: () => ({ ok: true, db }), log: () => {} });

    const verdict = await checker.check();

    expect(verdict.ok).toBe(true);
    expect(verdict.cached).toBe(false);
    expect(verdict.reason).toBeUndefined();
    // The table is NAMED on purpose: a bare `SELECT 1` stays green when the table or the
    // writer's GRANT is gone, which is exactly the state that fail-closes every Allocate.
    expect(statements).toEqual([OPS_HEALTH_SQL]);
    expect(OPS_HEALTH_SQL).toContain("allocate_rescue_record");
  });

  it("treats an EMPTY table as healthy — the verdict is 'the statement ran', not 'rows exist'", async () => {
    const { db } = stubDb(async () => ({ rows: [], rowCount: 0 }));
    const checker = createOpsHealthChecker({ resolve: () => ({ ok: true, db }), log: () => {} });
    await expect(checker.check()).resolves.toMatchObject({ ok: true });
  });

  it("reports not-configured without dialling anything", async () => {
    const lines: string[] = [];
    const checker = createOpsHealthChecker({
      resolve: () => ({ ok: false, issues: ["missing INTENTFOLIO_OPS_DB_URL"] }),
      log: (m) => lines.push(m),
    });

    const verdict = await checker.check();

    expect(verdict).toMatchObject({ ok: false, reason: "not-configured" });
    expect(verdict.detail).toBe("missing INTENTFOLIO_OPS_DB_URL");
    expect(lines[0]).toContain("not configured");
  });

  it("reports query-failed and keeps the database error in `detail`, never in the verdict's shape", async () => {
    const { db } = stubDb(() => Promise.reject(new Error('permission denied for table allocate_rescue_record')));
    const lines: string[] = [];
    const checker = createOpsHealthChecker({
      resolve: () => ({ ok: true, db }),
      log: (m) => lines.push(m),
    });

    const verdict = await checker.check();

    expect(verdict).toMatchObject({ ok: false, reason: "query-failed" });
    expect(verdict.detail).toContain("permission denied");
    expect(lines[0]).toContain("probe FAILED");
  });

  it("does not throw when the probe rejects with a non-Error", async () => {
    const { db } = stubDb(() => Promise.reject("plain string"));
    const checker = createOpsHealthChecker({ resolve: () => ({ ok: true, db }), log: () => {} });
    await expect(checker.check()).resolves.toMatchObject({ ok: false, reason: "query-failed" });
  });

  describe("the cache — what keeps request volume from becoming database load", () => {
    it("serves a second call from the cache without a second statement", async () => {
      const { db, statements } = stubDb();
      let clock = 1_000;
      const checker = createOpsHealthChecker({
        resolve: () => ({ ok: true, db }),
        now: () => clock,
        log: () => {},
      });

      const first = await checker.check();
      clock += OPS_HEALTH_CACHE_MS - 1;
      const second = await checker.check();

      expect(statements).toHaveLength(1);
      expect(second.cached).toBe(true);
      expect(first.cached).toBe(false);
      // The timestamp is the PROBE's, not the request's: a reader can tell how stale it is.
      expect(second.checkedAt).toBe(first.checkedAt);
    });

    it("probes again once the window has passed", async () => {
      const { db, statements } = stubDb();
      let clock = 1_000;
      const checker = createOpsHealthChecker({
        resolve: () => ({ ok: true, db }),
        now: () => clock,
        log: () => {},
      });

      await checker.check();
      clock += OPS_HEALTH_CACHE_MS;
      const second = await checker.check();

      expect(statements).toHaveLength(2);
      expect(second.cached).toBe(false);
    });

    it("caches an UNHEALTHY verdict too, so an outage cannot be amplified into a stampede", async () => {
      const { db, statements } = stubDb(() => Promise.reject(new Error("connection refused")));
      const checker = createOpsHealthChecker({
        resolve: () => ({ ok: true, db }),
        now: () => 1_000,
        log: () => {},
      });

      await checker.check();
      const second = await checker.check();

      expect(statements).toHaveLength(1);
      expect(second).toMatchObject({ ok: false, reason: "query-failed", cached: true });
    });

    it("collapses CONCURRENT misses onto one probe", async () => {
      // Without in-flight sharing the cache is useless under the very load it exists for:
      // N simultaneous requests all miss, and all N dial the database.
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { db, statements } = stubDb(async () => {
        await gate;
        return { rows: [], rowCount: 0 };
      });
      const checker = createOpsHealthChecker({
        resolve: () => ({ ok: true, db }),
        now: () => 1_000,
        log: () => {},
      });

      const all = Promise.all([checker.check(), checker.check(), checker.check()]);
      release();
      const verdicts = await all;

      expect(statements).toHaveLength(1);
      expect(verdicts.every((v) => v.ok)).toBe(true);
    });

    it("re-resolves the pool on every probe, so a deployment that gains its env recovers", async () => {
      const { db } = stubDb();
      let configured = false;
      const resolve = vi.fn(
        (): { ok: true; db: Queryable } | { ok: false; issues: string[] } =>
          configured ? { ok: true, db } : { ok: false, issues: ["missing INTENTFOLIO_OPS_DB_URL"] }
      );
      let clock = 0;
      const checker = createOpsHealthChecker({ resolve, now: () => clock, log: () => {} });

      expect((await checker.check()).ok).toBe(false);
      configured = true;
      clock += OPS_HEALTH_CACHE_MS;
      expect((await checker.check()).ok).toBe(true);
      expect(resolve).toHaveBeenCalledTimes(2);
    });
  });
});
