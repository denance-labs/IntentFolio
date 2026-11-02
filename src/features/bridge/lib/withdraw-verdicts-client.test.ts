import { describe, expect, it, vi } from "vitest";
import { fetchWithdrawVerdicts } from "./withdraw-verdicts-client";

const A = "6f1c2a0e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
const B = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const DEST_TX = "0x5a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9";

function answering(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

describe("fetchWithdrawVerdicts", () => {
  it("posts the ids and returns the verdicts", async () => {
    const fetchImpl = answering({ ok: true, verdicts: { [A]: { verdict: "delivered", destinationTxHash: DEST_TX } } });
    expect(await fetchWithdrawVerdicts([A, B], { fetchImpl, enabled: true })).toEqual({
      [A]: { verdict: "delivered", destinationTxHash: DEST_TX },
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/ops/withdraw-verdicts");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ ids: [A, B] });
  });

  it("sends nothing when the withdrawal records are off, or there is nothing to ask", async () => {
    const fetchImpl = answering({ ok: true, verdicts: {} });
    expect(await fetchWithdrawVerdicts([A], { fetchImpl, enabled: false })).toEqual({});
    expect(await fetchWithdrawVerdicts([], { fetchImpl, enabled: true })).toEqual({});
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("splits more than 20 ids into batches", async () => {
    const ids = Array.from({ length: 21 }, (_, i) => `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`);
    const fetchImpl = answering({ ok: true, verdicts: {} });
    await fetchWithdrawVerdicts(ids, { fetchImpl, enabled: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["an error status", answering({ ok: false, code: "read-failed", error: "x" }, 502)],
    ["a body that is not ok", answering({ ok: false })],
    ["an unreadable body", vi.fn(async () => new Response("<html>", { status: 200 }))],
    ["a network failure", vi.fn(async () => Promise.reject(new TypeError("offline")))],
  ])("reads %s as no verdict", async (_why, fetchImpl) => {
    expect(await fetchWithdrawVerdicts([A], { fetchImpl, enabled: true })).toEqual({});
  });

  it("keeps only asked ids, final verdicts and hash-shaped hashes", async () => {
    const fetchImpl = answering({
      ok: true,
      verdicts: {
        [A]: { verdict: "delivered", txHash: "not a hash", destinationTxHash: DEST_TX },
        [B]: { verdict: "delivered" },
        "11111111-0000-4000-8000-000000000000": { verdict: "escalated_e1" },
      },
    });
    expect(await fetchWithdrawVerdicts([A, "11111111-0000-4000-8000-000000000000"], { fetchImpl, enabled: true })).toEqual({
      [A]: { verdict: "delivered", destinationTxHash: DEST_TX },
    });
  });
});
