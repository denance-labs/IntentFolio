// GET /api/deposit-address?account=<id>&chain=<chain id> — Receive's fixed deposit address for an
// account on one network (D-584). Transport only: everything else is in `deposit-address-service.ts`.
// NOT authenticated: a set only ever credits the account it names. Never cached.

import { NextResponse } from "next/server";
import { resolveDepositAddressDb } from "@/features/vault/lib/ops-db-pool";
import { handleDepositAddress, type DepositAddressBody } from "@/features/bridge/lib/deposit-address-service";

// `pg` opens TCP sockets: Node runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A sleeping database (~5 s to wake) plus the 10 s create: above a 15 s default, below this.
export const maxDuration = 30;

/** The 1Click partner key, server only (never `NEXT_PUBLIC_`). */
const PARTNER_KEY_VAR = "ONECLICK_PARTNER_KEY";

/** Caller identity for the rate limiter — spoofable, which is fine for an anti-spam brake. */
function callerKeyOf(request: Request): string {
  const first = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return first && first.length > 0 ? first : "unknown";
}

function respond(status: number, body: DepositAddressBody) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: Request) {
  const db = resolveDepositAddressDb(process.env);
  if (!db.ok) return respond(503, { ok: false, code: "not-configured", error: "Deposit address database is not configured" });
  try {
    const result = await handleDepositAddress({
      query: new URL(request.url).searchParams,
      callerKey: callerKeyOf(request),
      db: db.db,
      partnerKey: process.env[PARTNER_KEY_VAR],
    });
    return respond(result.status, result.body);
  } catch (e) {
    console.error(`[deposit-address] ${e instanceof Error ? e.message : String(e)}`);
    return respond(503, { ok: false, code: "unavailable", error: "Deposit addresses are unavailable right now" });
  }
}
