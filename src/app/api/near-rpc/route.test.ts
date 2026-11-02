import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { FALLBACK_RPC_URL, MAX_BODY_BYTES, RPC_UPSTREAM_HEADER } from "@/features/wallet/lib/near-rpc-proxy";

// The transport around near-rpc-proxy.ts: status, headers and the early refusals that happen
// before the handler reads the body. The allowlist and the failover are tested there.

const read = JSON.stringify({
  jsonrpc: "2.0",
  id: "q",
  method: "query",
  params: { request_type: "view_account", account_id: "a.near", finality: "final" },
});

function post(body: string, headers: Record<string, string> = { "content-type": "application/json" }) {
  return POST(new Request("http://localhost/api/near-rpc", { method: "POST", body, headers }));
}

let upstream: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // No key: FastNEAR is the only upstream, as in Preview.
  vi.stubEnv("NEAR_RPC_API_KEY", "");
  upstream = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: "q", result: { amount: "1" } })));
  vi.stubGlobal("fetch", upstream);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("POST /api/near-rpc", () => {
  it("answers a read with the upstream's JSON, names the upstream and is never cached", async () => {
    const res = await post(read);
    expect(res.status).toBe(200);
    expect(res.headers.get(RPC_UPSTREAM_HEADER)).toBe("fallback");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toBe("application/json");
    expect((await res.json()).result).toEqual({ amount: "1" });
    expect(upstream.mock.calls[0][0]).toBe(FALLBACK_RPC_URL);
  });

  it("refuses a disallowed request with 400 and upstream none", async () => {
    const res = await post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "send_tx", params: {} }));
    expect(res.status).toBe(400);
    expect(res.headers.get(RPC_UPSTREAM_HEADER)).toBe("none");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("refuses a declared oversize body with 413 before reading it", async () => {
    const req = new Request("http://localhost/api/near-rpc", {
      method: "POST",
      body: read,
      headers: { "content-type": "application/json", "content-length": String(MAX_BODY_BYTES + 1) },
    });
    const text = vi.spyOn(req, "text");
    const res = await POST(req);
    expect(res.status).toBe(413);
    expect(res.headers.get(RPC_UPSTREAM_HEADER)).toBe("none");
    expect(text).not.toHaveBeenCalled();
  });

  it.each([
    ["text/plain", { "content-type": "text/plain" }, 415],
    ["a cross-site page", { "content-type": "application/json", "sec-fetch-site": "cross-site" }, 403],
  ])("refuses %s before touching an upstream", async (_label, headers, status) => {
    const res = await post(read, headers);
    expect(res.status).toBe(status);
    expect(res.headers.get(RPC_UPSTREAM_HEADER)).toBe("none");
    expect(upstream).not.toHaveBeenCalled();
  });
});
