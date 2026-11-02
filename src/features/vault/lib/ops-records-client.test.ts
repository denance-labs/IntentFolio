// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  OPS_ENVELOPE_ATTEMPTS,
  OPS_PATCH_BUDGET_MS,
  OPS_WRITE_BUDGET_MS,
  OpsRecordError,
  patchAllocateRecord,
  patchAllocateRecordResult,
  patchSignedEnvelope,
  postAllocateRecord,
} from "./ops-records-client";
import { OPS_RECORDS_ENDPOINT } from "./ops-records-types";

const ID = "6f1b3c2a-9d4e-4f7a-8b1c-2e5d7a9c0f31";

const body = {
  id: ID,
  signerId: "alice.near",
  msg: '{"deadline":1}',
  vaultId: "intentfolio-staging.near",
  portfolioName: "Balanced",
  legs: [{ tokenId: "nep141:wrap.near", amount: "1" }],
  createdAt: 1_760_000_000_000,
};

function jsonFetch(status: number, payload: unknown) {
  return vi.fn(async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  ) as unknown as typeof fetch;
}

/** Never resolves on its own; rejects the way `fetch` does when its signal aborts. */
function hangingFetch() {
  return vi.fn(
    (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const e = new Error("The operation was aborted");
          e.name = "AbortError";
          reject(e);
        });
      })
  ) as unknown as typeof fetch;
}

afterEach(() => vi.restoreAllMocks());

describe("postAllocateRecord", () => {
  it("posts the record to the ingest route and reports it was created", async () => {
    const fetchImpl = jsonFetch(200, { ok: true, id: ID, created: true });
    await expect(postAllocateRecord(body, { fetchImpl })).resolves.toEqual({ created: true });

    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(OPS_RECORDS_ENDPOINT);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  it("treats an already-stored id as success — it is a retry, not a duplicate", async () => {
    const fetchImpl = jsonFetch(200, { ok: true, id: ID, created: false });
    await expect(postAllocateRecord(body, { fetchImpl })).resolves.toEqual({ created: false });
  });

  // Fail-closed: everything below has to reach the caller as a throw, because the caller's
  // only correct response is to abort before asking the wallet to sign.
  it("throws when the deployment has no database configured", async () => {
    const fetchImpl = jsonFetch(503, {
      ok: false,
      code: "not-configured",
      error: "Rescue-record storage is not configured: missing INTENTFOLIO_OPS_DB_URL",
    });
    await expect(postAllocateRecord(body, { fetchImpl })).rejects.toMatchObject({
      name: "OpsRecordError",
      code: "not-configured",
      status: 503,
    });
  });

  it("throws when the write itself failed", async () => {
    const fetchImpl = jsonFetch(502, { ok: false, code: "write-failed", error: "connection refused" });
    await expect(postAllocateRecord(body, { fetchImpl })).rejects.toBeInstanceOf(OpsRecordError);
  });

  it("throws on an unreadable body rather than assuming the write landed", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>502</html>", { status: 502 })) as unknown as typeof fetch;
    await expect(postAllocateRecord(body, { fetchImpl })).rejects.toMatchObject({ code: "write-failed" });
  });

  it("aborts the request when it runs past its budget, and says so", async () => {
    const fetchImpl = hangingFetch();
    await expect(postAllocateRecord(body, { fetchImpl, timeoutMs: 10 })).rejects.toMatchObject({
      code: "network",
      message: expect.stringContaining("timed out"),
    });
  });

  // AbortController rather than Promise.race: a race would leave the request in flight, and
  // an abandoned write that lands anyway makes the user's next attempt look like a duplicate.
  it("actually aborts the in-flight request instead of walking away from it", async () => {
    const fetchImpl = hangingFetch();
    const signals: AbortSignal[] = [];
    const spy = vi.fn((url: string, init: RequestInit) => {
      signals.push(init.signal as AbortSignal);
      return (fetchImpl as unknown as (u: string, i: RequestInit) => Promise<Response>)(url, init);
    }) as unknown as typeof fetch;

    await expect(postAllocateRecord(body, { fetchImpl: spy, timeoutMs: 10 })).rejects.toThrow();
    expect(signals[0].aborted).toBe(true);
  });

  // THE constraint the ADR's "~5s timeout" cannot satisfy: this call sits on the click that
  // has to reach a wallet prompt, and browsers only open one inside the ~5s user-activation
  // window the click created. Raising this constant does not make the write more reliable —
  // it eats the signing popup, a bug this repo has already shipped once.
  it("keeps the in-click write budget under the user-activation window", () => {
    expect(OPS_WRITE_BUDGET_MS).toBeLessThanOrEqual(1_200);
    // The PATCHes run after the prompt, so they are free to take longer.
    expect(OPS_PATCH_BUDGET_MS).toBeGreaterThan(OPS_WRITE_BUDGET_MS);
  });

  it("defaults to that budget when the caller does not pass one", async () => {
    const fetchImpl = hangingFetch();
    const started = Date.now();
    await expect(postAllocateRecord(body, { fetchImpl })).rejects.toMatchObject({ code: "network" });
    expect(Date.now() - started).toBeLessThan(OPS_WRITE_BUDGET_MS + 500);
  });
});

describe("patchAllocateRecord", () => {
  it("sends only the fields it was given", async () => {
    const fetchImpl = jsonFetch(200, { ok: true, id: ID, updated: true });
    await expect(patchAllocateRecord({ id: ID, status: "submitted", txHash: "Tx1" }, { fetchImpl })).resolves.toBe(true);

    const [, init] = vi.mocked(fetchImpl).mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ id: ID, status: "submitted", txHash: "Tx1" });
  });

  // A lost status update is recoverable; the paths that call this are already reporting
  // something else (a rejected signature, a revert, an observed credit) and an exception here
  // would replace a real message with a storage one.
  it.each([
    ["a 404", () => jsonFetch(404, { ok: false, code: "not-found", error: "no such record" })],
    ["a 502", () => jsonFetch(502, { ok: false, code: "write-failed", error: "down" })],
    ["an unreadable body", () => vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch],
    ["a timeout", () => hangingFetch()],
  ])("never throws on %s", async (_label, make) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      patchAllocateRecord({ id: ID, status: "credited" }, { fetchImpl: make(), timeoutMs: 10 })
    ).resolves.toBe(false);
  });

  it("leaves a console trace when the database did not get the update", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await patchAllocateRecord({ id: ID, status: "credited" }, { fetchImpl: hangingFetch(), timeoutMs: 10 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(ID), expect.anything());
  });
});

// Same call as `patchAllocateRecord`, but the caller gets the CODE. The `suspected_orphan →
// credited` flip on app load (FE #4) has to tell "no such row" (a pre-database record, nothing
// to fix off-client) from "the database did not take it" (leave it for the next load).
describe("patchAllocateRecordResult", () => {
  it("reports ok on a 200", async () => {
    const fetchImpl = jsonFetch(200, { ok: true, id: ID, updated: true });
    await expect(patchAllocateRecordResult({ id: ID, status: "credited" }, { fetchImpl })).resolves.toEqual({
      ok: true,
    });
  });

  it.each([
    ["a 404", "not-found", () => jsonFetch(404, { ok: false, code: "not-found", error: "no such record" })],
    ["a 502", "write-failed", () => jsonFetch(502, { ok: false, code: "write-failed", error: "down" })],
    ["a timeout", "network", () => hangingFetch()],
  ])("keeps the code on %s instead of swallowing it, and never throws", async (_label, code, make) => {
    await expect(
      patchAllocateRecordResult({ id: ID, status: "credited" }, { fetchImpl: make(), timeoutMs: 10 })
    ).resolves.toMatchObject({ ok: false, code, message: expect.any(String) });
  });
});

// The third failure rule (ADR-0017 §5 as amended 2026-08-18, D-289). Everything here is
// about the difference from `patchAllocateRecord` directly above: this one THROWS, and it
// retries first, because what it costs to give up is a signature the user already approved.
describe("patchSignedEnvelope", () => {
  const envelope = { standard: "nep413", payload: { message: "{}" }, signature: "ed25519:x" };

  it("sends the envelope as a patch on that record and nothing else", async () => {
    const fetchImpl = jsonFetch(200, { ok: true, id: ID, updated: true });
    await patchSignedEnvelope(ID, envelope, { fetchImpl });

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(OPS_RECORDS_ENDPOINT);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ id: ID, signedEnvelope: envelope });
  });

  // The whole point of the function. `patchAllocateRecord` swallows this exact response.
  it("THROWS when the write fails — the caller must not submit", async () => {
    const fetchImpl = jsonFetch(502, { ok: false, code: "write-failed", error: "refused" });
    await expect(patchSignedEnvelope(ID, envelope, { fetchImpl, attempts: 1 })).rejects.toThrow(
      OpsRecordError
    );
  });

  it("retries a transient failure and succeeds on a later attempt", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      return calls < 3
        ? new Response(JSON.stringify({ ok: false, code: "write-failed", error: "refused" }), {
            status: 502,
            headers: { "Content-Type": "application/json" },
          })
        : new Response(JSON.stringify({ ok: true, id: ID, updated: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
    }) as unknown as typeof fetch;

    await expect(patchSignedEnvelope(ID, envelope, { fetchImpl })).resolves.toBeUndefined();
    expect(calls).toBe(3);
  });

  it("gives up after OPS_ENVELOPE_ATTEMPTS and reports the last failure", async () => {
    const fetchImpl = jsonFetch(502, { ok: false, code: "write-failed", error: "still refused" });
    await expect(patchSignedEnvelope(ID, envelope, { fetchImpl })).rejects.toThrow("still refused");
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(
      OPS_ENVELOPE_ATTEMPTS
    );
  });

  // Retrying a verdict that cannot change only makes the user wait ~16s for an abort that was
  // already decided on the first response.
  it("does NOT retry a failure a retry cannot fix", async () => {
    for (const [status, code] of [
      [400, "bad-request"],
      [404, "not-found"],
      // D-449: a DIFFERENT envelope is already stored. A resend of the same one succeeds on the
      // server, so a conflict is never the lost-response case a retry exists for.
      [409, "conflict"],
      [503, "not-configured"],
    ] as const) {
      const fetchImpl = jsonFetch(status, { ok: false, code, error: code });
      await expect(patchSignedEnvelope(ID, envelope, { fetchImpl })).rejects.toThrow(code);
      expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    }
  });

  it("retries a timeout, which is the failure most likely to be transient", async () => {
    const fetchImpl = hangingFetch();
    await expect(
      patchSignedEnvelope(ID, envelope, { fetchImpl, timeoutMs: 5 })
    ).rejects.toThrow(/timed out/i);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(
      OPS_ENVELOPE_ATTEMPTS
    );
  });

  // The route accepts a resend only when it is the same envelope (D-449), so a retry that
  // rebuilt or reshaped the body would turn a lost response into an aborted Allocate.
  it("sends the identical body on every retry", async () => {
    const fetchImpl = hangingFetch();
    await expect(
      patchSignedEnvelope(ID, envelope, { fetchImpl, timeoutMs: 5 })
    ).rejects.toThrow(/timed out/i);
    const bodies = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
      ([, init]) => (init as RequestInit).body
    );
    expect(bodies).toHaveLength(OPS_ENVELOPE_ATTEMPTS);
    expect(new Set(bodies).size).toBe(1);
  });

  // It runs after the wallet prompt has resolved, so it is not competing with the activation
  // window the POST has to fit inside — that is exactly why it may spend the ADR's retries.
  it("uses the post-prompt budget, not the in-click one", async () => {
    const fetchImpl = hangingFetch();
    const started = Date.now();
    await expect(
      patchSignedEnvelope(ID, envelope, { fetchImpl, attempts: 1, timeoutMs: 30 })
    ).rejects.toThrow(/timed out after 30ms/);
    expect(Date.now() - started).toBeLessThan(OPS_PATCH_BUDGET_MS);
    expect(OPS_PATCH_BUDGET_MS).toBeGreaterThan(OPS_WRITE_BUDGET_MS);
  });
});
