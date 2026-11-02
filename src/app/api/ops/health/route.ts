// GET /api/ops/health — the seam's liveness probe (ADR-0017 §7).
//
// Polled by the solver's ops watchdog from OUTSIDE this platform. It answers 2xx when the ops
// database is reachable with the writer's credential and non-2xx otherwise, which is the whole
// contract the watchdog reads (`ops-watchdog.service.ts` inspects `response.ok` and nothing
// else). The body is for a human running `curl`.
//
// Transport only, like the ingest route next door: the probe, the cache and the SQL live in
// `ops-health.ts` and are tested there.
//
// NOT authenticated, deliberately and for a different reason than the ingest route: a watchdog
// that needed a shared secret would put a credential in the one process whose job is to keep
// working when everything else is broken. What it leaks is a boolean about the platform's own
// health — so the FAILURE DETAIL is deliberately kept out of the body and only logged.
//
// Attribution: see ATTRIBUTIONS.md #19.

import { NextResponse } from "next/server";
import { resolveOpsDb } from "@/features/vault/lib/ops-db-pool";
import { createOpsHealthChecker } from "@/features/vault/lib/ops-health";

// `pg` opens TCP sockets: Node runtime, never the edge one.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Module scope on purpose: the cached verdict — the thing that keeps request volume from
// turning into database load — only works if the checker outlives the request.
const checker = createOpsHealthChecker({ resolve: () => resolveOpsDb() });

export async function GET() {
  const verdict = await checker.check();

  // `detail` names hosts, roles and schema objects. It is logged by the checker and stops here.
  const body = verdict.ok
    ? { ok: true as const, checkedAt: verdict.checkedAt, cached: verdict.cached }
    : {
        ok: false as const,
        reason: verdict.reason,
        checkedAt: verdict.checkedAt,
        cached: verdict.cached,
      };

  return NextResponse.json(body, {
    // 503, matching the ingest route's answer to the same condition: the dependency is down,
    // the deployment is not broken.
    status: verdict.ok ? 200 : 503,
    // A cached health verdict is worse than useless to an intermediary: it would answer for a
    // window this endpoint does not control, and the watchdog's whole job is to observe NOW.
    headers: { "cache-control": "no-store" },
  });
}
