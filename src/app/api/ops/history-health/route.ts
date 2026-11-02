// GET /api/ops/history-health — is the history recorder keeping up? (D-496)
//
// Polled by the solver's ops watchdog, like `/api/ops/health` next door, and under the same
// contract: 2xx when "recorded until" is recent, non-2xx otherwise; the body is for a human
// running `curl`. Transport only: the probe, the threshold and the cache live in
// `history-health.ts` and are tested there.
//
// NOT authenticated, for the reason its sibling gives: a watchdog must not carry a credential.
//
// Attribution: see ATTRIBUTIONS.md #19.

import { NextResponse } from "next/server";
import { resolveHistoryReaderDb } from "@/features/vault/lib/ops-db-pool";
import { VAULT_CONTRACT_ID } from "@/features/wallet/config/network";
import { createHistoryHealthChecker } from "@/features/history-recorder/lib/history-health";

// `pg` opens TCP sockets: Node runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Module scope on purpose: the cached verdict only bounds database load if it outlives the request.
const checker = createHistoryHealthChecker({
  resolve: () => resolveHistoryReaderDb(process.env),
  vaultId: VAULT_CONTRACT_ID,
});

export async function GET() {
  const verdict = await checker.check();

  // `detail` names hosts, roles and schema objects. It is logged by the checker and stops here.
  const body = verdict.ok
    ? { ok: true as const, recordedUntil: verdict.recordedUntil, checkedAt: verdict.checkedAt, cached: verdict.cached }
    : {
        ok: false as const,
        reason: verdict.reason,
        recordedUntil: verdict.recordedUntil,
        checkedAt: verdict.checkedAt,
        cached: verdict.cached,
      };

  return NextResponse.json(body, {
    // 503 for every failure, the database's included: whatever the cause, the history cannot be
    // vouched for, and the watchdog's alert says so in its own words.
    status: verdict.ok ? 200 : 503,
    // The watchdog observes NOW; a verdict cached by an intermediary would answer for a window
    // this endpoint does not control.
    headers: { "cache-control": "no-store" },
  });
}
