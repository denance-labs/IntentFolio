import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleHistoryCron, type HistoryCronInput } from "./history-cron";
import type { PassResult } from "./history-recorder";
import type { AccountPassResult } from "./account-recorder";
import type { TransactionalQueryable } from "@/features/vault/lib/ops-records-service";

const DB = {} as TransactionalQueryable;
const DONE: PassResult = {
  ran: true,
  ok: true,
  recordedTxs: 3,
  recordedEvents: 5,
  stuck: [],
  droppedCalls: [],
  accounts: [],
  liveComplete: true,
  backfillDone: true,
  stoppedBy: null,
  pages: 1,
  ms: 120,
};

const ACCOUNT_DONE: AccountPassResult = {
  ran: true,
  ok: true,
  recordedTxs: 2,
  recordedMovements: 1,
  stuck: [],
  skipped: [],
  droppedCalls: [],
  liveComplete: true,
  backfillDone: true,
  stoppedBy: null,
  pages: 1,
  calls: 2,
  ms: 80,
};

function input(over: Partial<HistoryCronInput> = {}): HistoryCronInput {
  return {
    authorization: "Bearer s3cret",
    env: { CRON_SECRET: "s3cret" },
    vaultId: "intentfolio-vault.near",
    resolveDb: () => ({ ok: true, db: DB }),
    run: vi.fn(async () => DONE),
    account: null,
    isAccountId: (id) => id.endsWith(".near"),
    follow: vi.fn(async () => "already" as const),
    runAccount: vi.fn(async () => ACCOUNT_DONE),
    ...over,
  };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("handleHistoryCron — the gate in front of a pass", () => {
  it("runs one pass for the configured vault with the cron's secret", async () => {
    const run = vi.fn(async () => DONE);
    const out = await handleHistoryCron(input({ run }));
    expect(out).toEqual({ status: 200, body: DONE });
    expect(run).toHaveBeenCalledWith({ db: DB, vaultId: "intentfolio-vault.near", budgetMs: undefined });
  });

  it("refuses everything while CRON_SECRET is not set — even a request with no header", async () => {
    for (const authorization of [null, "Bearer ", "Bearer undefined"]) {
      const run = vi.fn(async () => DONE);
      const out = await handleHistoryCron(input({ env: {}, authorization, run }));
      expect(out.status).toBe(503);
      expect(run).not.toHaveBeenCalled();
    }
  });

  it("refuses a wrong, missing or differently spelled secret", async () => {
    for (const authorization of [null, "", "Bearer wrong", "bearer s3cret", "s3cret", "Bearer s3cret "]) {
      const run = vi.fn(async () => DONE);
      expect((await handleHistoryCron(input({ authorization, run }))).status).toBe(401);
      expect(run).not.toHaveBeenCalled();
    }
  });

  it("answers 503 without a vault or a database, before any pass", async () => {
    const run = vi.fn(async () => DONE);
    expect((await handleHistoryCron(input({ vaultId: "", run }))).status).toBe(503);
    expect((await handleHistoryCron(input({ resolveDb: () => ({ ok: false, issues: ["missing X"] }), run }))).status).toBe(
      503
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("a pass that throws despite its contract is a 500 with its message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await handleHistoryCron(input({ run: async () => Promise.reject(new Error("bug")) }));
    expect(out).toEqual({ status: 500, body: { ok: false, code: "pass-failed", error: "bug" } });
  });

  it("a failed pass is a 500, so the cron run shows as failed; a paced one is a 200", async () => {
    const failed = { ...DONE, ok: false, error: "FastNEAR down" } as PassResult;
    expect((await handleHistoryCron(input({ run: async () => failed }))).status).toBe(500);
    expect((await handleHistoryCron(input({ run: async () => ({ ran: false, reason: "paced" }) }))).status).toBe(200);
  });
});

describe("handleHistoryCron — the accounts after the vault (028-6)", () => {
  it("brings up to date the accounts the vault pass saw move, uncapped, at most ten", async () => {
    const accounts = Array.from({ length: 12 }, (_, i) => `u${i}.near`);
    const follow = vi.fn(async () => "followed" as const);
    const runAccount = vi.fn(async () => ACCOUNT_DONE);
    const out = await handleHistoryCron(input({ run: async () => ({ ...DONE, accounts: ["0xNOT", ...accounts] }), follow, runAccount }));
    expect(out.status).toBe(200);
    expect(runAccount).toHaveBeenCalledTimes(10);
    expect(runAccount).not.toHaveBeenCalledWith(expect.objectContaining({ accountId: "0xNOT" }));
    expect(follow).toHaveBeenCalledWith(DB, "u0.near", { capped: false });
    expect(runAccount).toHaveBeenCalledWith({
      db: DB,
      accountId: "u0.near",
      vaultId: "intentfolio-vault.near",
      budgetMs: 15_000,
      maxCalls: 25,
    });
    expect((out.body as { accountRuns: unknown[] }).accountRuns).toHaveLength(10);
  });

  it("one budget of FastNEAR calls for the run's account passes; none after a 429", async () => {
    const accounts = ["a.near", "b.near", "c.near", "d.near"];
    const spent: number[] = [];
    const runAccount = vi.fn(async (deps: { maxCalls?: number }) => {
      spent.push(deps.maxCalls!);
      return { ...ACCOUNT_DONE, calls: deps.maxCalls! };
    });
    await handleHistoryCron(input({ run: async () => ({ ...DONE, accounts }), runAccount }));
    expect(spent).toEqual([25, 5]); // 30 in all; fewer than 2 left stops the loop

    const limited = vi.fn(async () => ({ ...ACCOUNT_DONE, calls: 1, stoppedBy: "rate-limited" as const }));
    await handleHistoryCron(input({ run: async () => ({ ...DONE, accounts }), runAccount: limited }));
    expect(limited).toHaveBeenCalledTimes(1);

    const never = vi.fn(async () => ACCOUNT_DONE);
    await handleHistoryCron(input({ run: async () => ({ ...DONE, accounts, stoppedBy: "rate-limited" }), runAccount: never }));
    expect(never).not.toHaveBeenCalled();
  });

  it("an account's failure is logged, not the run's: the status is the vault pass's", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = vi.fn(async () => ({ ...ACCOUNT_DONE, ok: false, error: "stuck" }));
    const throwing = vi.fn(async () => Promise.reject(new Error("bug")));
    for (const runAccount of [failing, throwing]) {
      const out = await handleHistoryCron(input({ run: async () => ({ ...DONE, accounts: ["a.near"] }), runAccount }));
      expect(out.status).toBe(200);
    }
  });

  it("starts no account pass once the run is past its window", async () => {
    let t = 0;
    const runAccount = vi.fn(async () => {
      t += 100_000;
      return ACCOUNT_DONE;
    });
    await handleHistoryCron(input({ run: async () => ({ ...DONE, accounts: ["a.near", "b.near", "c.near"] }), runAccount, now: () => t }));
    expect(runAccount).toHaveBeenCalledTimes(2);
  });

  it("?account= runs that account only, and refuses an id intents.near cannot have", async () => {
    const run = vi.fn(async () => DONE);
    const runAccount = vi.fn(async () => ACCOUNT_DONE);
    const out = await handleHistoryCron(input({ account: "pablofork.near", run, runAccount }));
    expect(out).toMatchObject({ status: 200, body: { accountId: "pablofork.near", followed: "already" } });
    expect(run).not.toHaveBeenCalled();

    const bad = await handleHistoryCron(input({ account: "Robert'); DROP", run, runAccount }));
    expect(bad.status).toBe(400);
    expect(runAccount).toHaveBeenCalledTimes(1);

    // Run by hand, a failed account pass is the run's failure.
    const failed = await handleHistoryCron(
      input({ account: "pablofork.near", runAccount: async () => ({ ...ACCOUNT_DONE, ok: false, error: "stuck" }) })
    );
    expect(failed.status).toBe(500);
  });
});
