// GET /api/cron/history — one pass of the history recorder (plan 028-2, D-492). Called hourly by
// Vercel Cron (`vercel.json`), and by the operator with the same secret for the initial load.
// `?account=<id>` runs that account's pass instead (028-6).
//
// Transport only: the gate lives in `history-cron.ts`, the pass in `history-recorder.ts`.

import { NextResponse } from "next/server";
import { resolveHistoryWriterDb } from "@/features/vault/lib/ops-db-pool";
import { VAULT_CONTRACT_ID } from "@/features/wallet/config/network";
import { handleHistoryCron } from "@/features/history-recorder/lib/history-cron";
import { runHistoryPass } from "@/features/history-recorder/lib/history-recorder";
import {
  followAccount,
  isFollowableAccountId,
  runAccountPass,
} from "@/features/history-recorder/lib/account-recorder";

// `pg` opens TCP sockets: Node runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The initial load may use most of it; the pass stops starting pages at `DEFAULT_BUDGET_MS`.
export const maxDuration = 300;

export async function GET(request: Request) {
  const { status, body } = await handleHistoryCron({
    authorization: request.headers.get("authorization"),
    env: process.env,
    vaultId: VAULT_CONTRACT_ID,
    resolveDb: () => resolveHistoryWriterDb(process.env),
    run: runHistoryPass,
    account: new URL(request.url).searchParams.get("account"),
    isAccountId: isFollowableAccountId,
    follow: followAccount,
    runAccount: runAccountPass,
  });
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
