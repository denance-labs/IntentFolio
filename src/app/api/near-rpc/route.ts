// POST /api/near-rpc — the browser's NEAR read path (D-173, 014.plan).
//
// Attaches the primary RPC's API key server-side and falls back to FastNEAR. Validation,
// allowlist and failover live in near-rpc-proxy.ts and are unit-tested there; this file is
// only the transport.

import {
  MAX_BODY_BYTES,
  RPC_UPSTREAM_HEADER,
  createPrimaryHeadWatch,
  handleNearRpcRequest,
  nearRpcRefusal,
  readNearRpcConfig,
  refuseByHeaders,
} from "@/features/wallet/lib/near-rpc-proxy";

// Reads a server-only secret: Node runtime, never cached.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One per server instance: whether the primary's head is frozen (D-331).
const headWatch = createPrimaryHeadWatch();

export async function POST(request: Request) {
  // Cheap early refusals before reading a body. The handler re-checks the real size:
  // Content-Length is the client's claim, not a fact.
  const declared = Number(request.headers.get("content-length"));
  const result =
    refuseByHeaders(request.headers) ??
    (Number.isFinite(declared) && declared > MAX_BODY_BYTES
      ? nearRpcRefusal(413, null, "body too large")
      : await handleNearRpcRequest(await request.text(), { config: readNearRpcConfig(), headWatch }));

  return new Response(result.body, {
    status: result.status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      [RPC_UPSTREAM_HEADER]: result.upstream ?? "none",
    },
  });
}
