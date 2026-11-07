// POST /api/relay — submits an already-signed envelope and pays the gas (008.plan, Phase 0).
// GET  /api/relay — whether the relay is paused, asked by the app before it asks for a signature.
//
// This is the whole reason a MetaMask user can operate IntentFolio at all: their identity is a
// row in `intents.near`'s ledger, not a NEAR account, so they can sign but cannot send. The
// relayer sends. It never signs on anyone's behalf — the authorisation is inside the envelope,
// and since 017-2 (D-365) so is the permission to spend the relayer's gas: no access token.
//
// All the logic lives in unit-tested modules: the pause, destination guard, spend cap and log in
// relay-service.ts; whether the envelope is worth the gas in relay-gate.ts; the sender in
// relay-sender.ts; the allowance warning in relay-allowance.ts. This file is only
// the transport and the wiring.

import { NextResponse } from "next/server";
import { KeyPair, type KeyPairString } from "near-api-js";
import { readNearRpcConfig } from "@/features/wallet/lib/near-rpc-proxy";
import { getOpsAlerter } from "@/features/vault/lib/ops-alerts";
import { allowanceOf, createAllowanceWatcher } from "@/features/vault/lib/relay-allowance";
import { createRelayGate } from "@/features/vault/lib/relay-gate";
import { createRelayRpc, relayUpstreamsFromConfig } from "@/features/vault/lib/relay-rpc-provider";
import { createRelaySender } from "@/features/vault/lib/relay-sender";
import { handleRelayRequest, readRelayConfig, readRelayPaused } from "@/features/vault/lib/relay-service";

// The relayer signs with server-only FunctionCall keys: Node runtime, never the edge one.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Must outlast the send's own cut-off (RELAY_SEND_TIMEOUT_MS, 30 s) plus what comes before it —
// the envelope checks (RELAY_CHECK_BUDGET_MS, 10 s) and the nonce/block reads — and the allowance
// read after it (≤ 2 s), so the relay always gets to answer `unknown-outcome` with the hash: a
// function killed by the platform first returns an unreadable 504 and loses both (D-330).
export const maxDuration = 60;

/**
 * `{ paused }` and nothing else — no configuration, no key, no balance. Read when a confirmation
 * modal opens (not in the click: the wallet popup has a 5 s activation window). An unconfigured
 * relay is not "paused": the POST answers `not-configured` with its own reason.
 */
export async function GET() {
  return NextResponse.json({ paused: readRelayPaused() }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * The largest body the relay reads. The app's envelopes are a few KB (an Allocate carries its
 * composition twice); anything past this is not one of them, and parsing it is work for nothing.
 */
const RELAY_MAX_BODY_BYTES = 32 * 1024;

export async function POST(request: Request) {
  const config = readRelayConfig();
  if (!config.ok) {
    return NextResponse.json(
      {
        ok: false,
        code: "not-configured",
        error: `Relayer is not configured: ${config.issues.join(", ")}`,
      },
      { status: 503 }
    );
  }

  const text = await request.text();
  if (Buffer.byteLength(text) > RELAY_MAX_BODY_BYTES) {
    return NextResponse.json(
      { ok: false, code: "bad-request", error: `Body is larger than ${RELAY_MAX_BODY_BYTES} bytes` },
      { status: 413 }
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json(
      { ok: false, code: "bad-request", error: "Body is not valid JSON" },
      { status: 400 }
    );
  }

  const { accountId, privateKeys } = config.config;
  // A malformed key must answer with a code, not a 500 — an uncoded failure is what the client
  // has to read as "maybe sent" (017-1). Nothing has been checked or signed at this point.
  const publicKeysOf = (pool: string[]) =>
    pool.map((key) => KeyPair.fromString(key as KeyPairString).getPublicKey().toString());
  let publicKeys: Record<"verifier" | "vault", string[]>;
  try {
    publicKeys = { verifier: publicKeysOf(privateKeys.verifier), vault: publicKeysOf(privateKeys.vault) };
  } catch {
    return NextResponse.json(
      { ok: false, code: "not-configured", error: "A relayer private key is malformed" },
      { status: 503 }
    );
  }
  // Meta Pool's keyed RPC first, FastNEAR if it fails. A read moves on any error; the signed
  // bytes move once, only when the answer proves nothing (relay-rpc-provider.ts, D-173, D-329,
  // D-557). Built per request.
  const rpc = createRelayRpc(relayUpstreamsFromConfig(readNearRpcConfig()));

  const { status, body: responseBody } = await handleRelayRequest({
    body,
    config: config.config,
    sender: createRelaySender({ accountId, privateKeys, rpc }),
    gate: createRelayGate({ view: rpc.view }),
    watchAllowance: createAllowanceWatcher({
      accountId,
      publicKeys,
      readAllowance: async (publicKey) => allowanceOf(await rpc.provider.viewAccessKey({ accountId, publicKey })),
      alerter: getOpsAlerter(),
    }),
  });

  return NextResponse.json(responseBody, { status });
}
