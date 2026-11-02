// GET /api/history/account?account=<id>[&portfolio=<p_…>][&before=<next>][&expect=<hash>|&fresh=1]
// — an account's history, one page of transactions at a time, from the history database (plan
// 028-7, D-492 stage 2). Read by a portfolio's History and by My Account's recent activity.
//
// Transport only: validation, SQL and freshness live in `account-history-service.ts`; the passes
// in `account-recorder.ts`. NOT authenticated, on purpose (028 decision 6): the rows are public
// on chain. Never cached (`no-store`, decision 2): right after an operation the next read must
// see it, and `expect` / `fresh` write before answering.

import { after, NextResponse } from "next/server";
import { resolveHistoryReaderDb, resolveHistoryWriterDb } from "@/features/vault/lib/ops-db-pool";
import { VAULT_CONTRACT_ID } from "@/features/wallet/config/network";
import {
  catchUpAccountAfterRead,
  handleAccountHistory,
  type AccountHistoryBody,
} from "@/features/history-recorder/lib/account-history-service";

// `pg` opens TCP sockets: Node runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The answer goes out first; the pass after it runs in the same invocation, and with its grace
// periods may outlive a short limit (`CATCH_UP_BUDGET_MS` + the recorder's margins).
export const maxDuration = 300;

/** Caller identity for the rate limiter — spoofable, which is fine for an anti-spam brake. */
function callerKeyOf(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first && first.length > 0 ? first : "unknown";
}

function respond(status: number, body: AccountHistoryBody) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: Request) {
  // Its own one-connection pool, as a role that can only SELECT the history tables.
  const reader = resolveHistoryReaderDb(process.env);
  if (!reader.ok) {
    return respond(503, { ok: false, code: "not-configured", error: `History database is not configured: ${reader.issues.join(", ")}` });
  }

  const query = new URL(request.url).searchParams;
  const result = await handleAccountHistory({
    query,
    vaultId: VAULT_CONTRACT_ID,
    callerKey: callerKeyOf(request),
    reader: reader.db,
    writer: () => resolveHistoryWriterDb(process.env),
  });
  const { catchUp } = result;
  if (catchUp !== null) {
    // Validated by the handler: a catch-up is only ever asked for a well-formed account.
    const accountId = query.get("account") ?? "";
    after(() =>
      catchUpAccountAfterRead({
        accountId,
        vaultId: VAULT_CONTRACT_ID,
        catchUp,
        resolveDb: () => resolveHistoryWriterDb(process.env),
      })
    );
  }
  return respond(result.status, result.body);
}
