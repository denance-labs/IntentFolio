// The hourly trigger of the history recorder (plan 028-2; daily until D-496): what
// `/api/cron/history` does, without the transport, so the gate is testable.
//
// Since 028-6 a run has two steps: the vault's pass, then the account pass (`account-recorder`)
// of each account whose vault events that pass inserted — at most `MAX_ACCOUNTS_PER_RUN`, only
// while the run has time left, and within one budget of FastNEAR calls for all of them (under
// the burst that trips its rate limit; none at all once it has answered 429). With `?account=<id>` the run is the account pass of that
// one account instead (the operator: the one-time load of today's portfolio owners, and tests).
// An account pass that fails is that account's (its screen says "out of date"), not the
// system's: it is logged, and the run's status is the vault pass's.
//
// Vercel Cron calls the route with `Authorization: Bearer <CRON_SECRET>` when that variable is
// set on the project. The same header is how the operator runs a pass by hand (the initial
// load right after publishing). Without the secret configured the route refuses everything:
// an open endpoint would let anyone set the pace of FastNEAR calls and database wake-ups.

import { timingSafeEqual } from "node:crypto";
import type { TransactionalQueryable } from "@/features/vault/lib/ops-records-service";
import type { PassResult, RecorderDeps } from "./history-recorder";
import type { AccountPassDeps, AccountPassResult, FollowResult } from "./account-recorder";

/** Account passes after the vault's, per run. */
export const MAX_ACCOUNTS_PER_RUN = 10;
/** No account pass starts after this much of the run (`maxDuration` is 300 s). */
const ACCOUNTS_START_BEFORE_MS = 150_000;
const ACCOUNT_BUDGET_MS = 15_000;
/** FastNEAR calls for all of a run's account passes together. */
export const RUN_ACCOUNT_CALLS = 30;
/** One pass's cap when the run has calls to spare (`account-recorder` `MAX_CALLS_PER_PASS`). */
const ACCOUNT_PASS_CALLS = 25;

export type HistoryCronInput = {
  authorization: string | null;
  env: Record<string, string | undefined>;
  vaultId: string;
  resolveDb: () => { ok: true; db: TransactionalQueryable } | { ok: false; issues: string[] };
  run: (deps: RecorderDeps) => Promise<PassResult>;
  budgetMs?: number;
  /** `?account=<id>`: run that account's pass only. */
  account: string | null;
  isAccountId: (id: string) => boolean;
  follow: (db: TransactionalQueryable, accountId: string, options: { capped: boolean }) => Promise<FollowResult>;
  runAccount: (deps: AccountPassDeps) => Promise<AccountPassResult>;
  now?: () => number;
};

type AccountRun = { accountId: string; followed: FollowResult; result: AccountPassResult };

export type HistoryCronOutput = {
  status: number;
  body:
    | { ok: false; code: string; error: string }
    | (PassResult & { accountRuns?: AccountRun[] })
    | AccountRun;
};

function bearerMatches(header: string | null, secret: string): boolean {
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(header ?? "");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function handleHistoryCron(input: HistoryCronInput): Promise<HistoryCronOutput> {
  const secret = input.env.CRON_SECRET?.trim();
  if (!secret) {
    return { status: 503, body: { ok: false, code: "not-configured", error: "CRON_SECRET is not set" } };
  }
  if (!bearerMatches(input.authorization, secret)) {
    return { status: 401, body: { ok: false, code: "unauthorized", error: "Bad or missing authorization" } };
  }
  if (!input.vaultId) {
    return { status: 503, body: { ok: false, code: "not-configured", error: "No vault is configured" } };
  }
  const db = input.resolveDb();
  if (!db.ok) {
    return {
      status: 503,
      body: { ok: false, code: "not-configured", error: `History database is not configured: ${db.issues.join(", ")}` },
    };
  }

  const now = input.now ?? Date.now;
  const startedAt = now();
  const accountRun = async (accountId: string, budgetMs: number, maxCalls?: number): Promise<AccountRun> => {
    // Accounts the vault or the operator names: not a stranger's request, so not capped.
    const followed = await input.follow(db.db, accountId, { capped: false });
    const result = await input.runAccount({
      db: db.db,
      accountId,
      vaultId: input.vaultId,
      budgetMs,
      ...(maxCalls === undefined ? {} : { maxCalls }),
    });
    console.log(`[history:account] ${accountId} ${JSON.stringify(result)}`);
    return { accountId, followed, result };
  };

  if (input.account !== null) {
    if (!input.isAccountId(input.account)) {
      return { status: 400, body: { ok: false, code: "bad-account", error: "Not an account id intents.near knows" } };
    }
    try {
      const run = await accountRun(input.account, input.budgetMs ?? 200_000);
      return { status: run.result.ran && !run.result.ok ? 500 : 200, body: run };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      console.error(`[history:account] pass threw: ${error}`);
      return { status: 500, body: { ok: false, code: "pass-failed", error } };
    }
  }

  let result: PassResult;
  try {
    result = await input.run({ db: db.db, vaultId: input.vaultId, budgetMs: input.budgetMs });
  } catch (e) {
    // A pass reports its own failures; this is the net under a bug in it.
    const error = e instanceof Error ? e.message : String(e);
    console.error(`[history] pass threw: ${error}`);
    return { status: 500, body: { ok: false, code: "pass-failed", error } };
  }
  // One line per pass in the function logs: what it did and how long it took (the CPU per pass
  // 028-2 measures is next to it, in Vercel's observability for the same invocation).
  console.log(`[history] ${JSON.stringify(result)}`);

  const accountRuns: AccountRun[] = [];
  const accounts =
    result.ran && result.stoppedBy !== "rate-limited"
      ? result.accounts.filter(input.isAccountId).slice(0, MAX_ACCOUNTS_PER_RUN)
      : [];
  let calls = 0;
  for (const accountId of accounts) {
    const left = RUN_ACCOUNT_CALLS - calls;
    if (now() - startedAt > ACCOUNTS_START_BEFORE_MS || left < 2) break;
    try {
      const run = await accountRun(accountId, ACCOUNT_BUDGET_MS, Math.min(ACCOUNT_PASS_CALLS, left));
      accountRuns.push(run);
      if (run.result.ran) {
        calls += run.result.calls;
        if (run.result.stoppedBy === "rate-limited") break;
      }
    } catch (e) {
      console.error(`[history:account] ${accountId}: pass threw: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // A failed pass answers 5xx so the cron run shows as failed in Vercel; a paced one is fine.
  return { status: result.ran && !result.ok ? 500 : 200, body: accountRuns.length > 0 ? { ...result, accountRuns } : result };
}
