// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The flag is read at module load (Next inlines NEXT_PUBLIC_ values at build time), so each
// block stubs the environment and re-imports rather than mocking `vault-flag` — that way the
// wiring from the variable to the behaviour is under test too, not just the behaviour.
async function loadSink(enabled: boolean) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_OPS_RECORDS", enabled ? "true" : "false");
  const sink = await import("./allocate-record-sink");
  const store = await import("./allocate-rescue-store");
  return { ...sink, ...store };
}

const params = {
  signerId: "alice.near",
  msg: '{"deadline":1790000000,"nonce":[1,2,3]}',
  vaultId: "intentfolio-staging.near",
  portfolioName: "Balanced",
  legs: [{ tokenId: "nep141:wrap.near", amount: "1000000" }],
};

function okFetch() {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const sent = JSON.parse(init.body as string) as { id: string };
    return new Response(JSON.stringify({ ok: true, id: sent.id, created: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

beforeEach(() => {
  window.localStorage.clear();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("persistAllocateRecord — flag off", () => {
  it("behaves exactly as before: localStorage only, no network", async () => {
    const fetchImpl = okFetch();
    vi.stubGlobal("fetch", fetchImpl);
    const { persistAllocateRecord, listAllocateRecords } = await loadSink(false);

    const id = await persistAllocateRecord(params);
    expect(fetchImpl).not.toHaveBeenCalled();
    const stored = listAllocateRecords();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id, msg: params.msg, status: "signing" });
  });
});

describe("persistAllocateRecord — flag on", () => {
  it("writes localStorage FIRST, then the database", async () => {
    const order: string[] = [];
    const realSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key: string,
      value: string
    ) {
      if (key === "vault.allocate-rescue.v1") order.push("localStorage");
      realSetItem.call(this, key, value);
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        order.push("database");
        const sent = JSON.parse(init.body as string) as { id: string };
        return new Response(JSON.stringify({ ok: true, id: sent.id, created: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );

    const { persistAllocateRecord } = await loadSink(true);
    await persistAllocateRecord(params);

    // A stray localStorage record is local noise on the user's own worklist; a stray database
    // row sits on the SOLVER's rescue worklist and puts a human on the trail of an Allocate
    // that never happened. So the one that can leave a stray goes second.
    expect(order).toEqual(["localStorage", "database"]);
  });

  it("gives both channels ONE id — the database primary key that makes a retry a no-op", async () => {
    const fetchImpl = okFetch();
    vi.stubGlobal("fetch", fetchImpl);
    const { persistAllocateRecord, listAllocateRecords } = await loadSink(true);

    const id = await persistAllocateRecord(params);
    const posted = JSON.parse(fetchImpl.mock.calls[0][1].body as string);
    expect(posted.id).toBe(id);
    expect(listAllocateRecords()[0].id).toBe(id);
    // And one clock: the row's `created_at` is the same instant the local record carries.
    expect(posted.createdAt).toBe(listAllocateRecords()[0].createdAt);
  });

  it("sends the raw msg verbatim, never a re-serialised object", async () => {
    const fetchImpl = okFetch();
    vi.stubGlobal("fetch", fetchImpl);
    const { persistAllocateRecord } = await loadSink(true);
    await persistAllocateRecord(params);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body as string).msg).toBe(params.msg);
  });

  // ── Fail-closed. This is the whole point of the module. ──────────────────────────────
  it("THROWS when the database write fails, so the caller never reaches the wallet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: false, code: "write-failed", error: "connection refused" }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        })
      )
    );
    const { persistAllocateRecord } = await loadSink(true);
    await expect(persistAllocateRecord(params)).rejects.toThrow(/nothing was signed/i);
  });

  it("names the cause, so the user is not told to retry a database that is not configured", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ ok: false, code: "not-configured", error: "missing INTENTFOLIO_OPS_DB_URL" }),
          { status: 503, headers: { "Content-Type": "application/json" } }
        )
      )
    );
    const { persistAllocateRecord } = await loadSink(true);
    await expect(persistAllocateRecord(params)).rejects.toThrow(/INTENTFOLIO_OPS_DB_URL/);
  });

  // The local record would otherwise sit at `signing` forever and show up on the user's own
  // unresolved worklist — an orphan that cannot exist, because nothing was ever signed.
  it("marks the local record failed when the remote write aborts the Allocate", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: false, code: "write-failed", error: "down" }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        })
      )
    );
    const { persistAllocateRecord, listAllocateRecords, listUnresolvedAllocateRecords } =
      await loadSink(true);

    await expect(persistAllocateRecord(params)).rejects.toThrow();
    expect(listAllocateRecords()[0].status).toBe("failed");
    // `listUnresolvedAllocateRecords` keeps everything that is not credited, so a failed
    // record is still listed — what matters is that it no longer claims to be mid-signature.
    expect(listUnresolvedAllocateRecords()[0].status).toBe("failed");
  });

  // localStorage is fail-closed too and it runs first, so a blocked storage must abort
  // BEFORE a row reaches the solver's worklist for an Allocate that will never happen.
  it("does not write the database when localStorage refuses", async () => {
    const fetchImpl = okFetch();
    vi.stubGlobal("fetch", fetchImpl);
    const { persistAllocateRecord } = await loadSink(true);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    await expect(persistAllocateRecord(params)).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// The SECOND fail-closed gate (ADR-0017 §5 as amended 2026-08-18, D-289). Same shape as
// `persistAllocateRecord` above, one instant later: it throws, and the caller aborts before
// submitting rather than before signing.
describe("persistSignedEnvelope", () => {
  const ENVELOPE = { standard: "nep413", payload: { message: "{}" }, signature: "ed25519:x" };

  it("writes localStorage FIRST, then the database", async () => {
    const order: string[] = [];
    const realSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      k: string,
      v: string
    ) {
      if (k === "vault.allocate-rescue.v1" && v.includes("signedEnvelope")) order.push("local");
      realSetItem.call(this, k, v);
    });
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      if (JSON.parse(init.body as string).signedEnvelope) order.push("database");
      return new Response(JSON.stringify({ ok: true, id: "x", updated: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchImpl);

    const { persistAllocateRecord, persistSignedEnvelope } = await loadSink(true);
    const id = await persistAllocateRecord(params);
    await persistSignedEnvelope(id, ENVELOPE);

    expect(order).toEqual(["local", "database"]);
  });

  it("sends the envelope verbatim, never a reshaped copy", async () => {
    const sent: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        if (body.signedEnvelope) sent.push(body.signedEnvelope);
        return new Response(JSON.stringify({ ok: true, id: body.id, updated: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );
    const { persistAllocateRecord, persistSignedEnvelope } = await loadSink(true);
    const id = await persistAllocateRecord(params);
    await persistSignedEnvelope(id, ENVELOPE);

    expect(sent).toEqual([ENVELOPE]);
  });

  it("THROWS when the database write fails, and says nothing was submitted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        if (body.signedEnvelope) {
          return new Response(
            JSON.stringify({ ok: false, code: "write-failed", error: "connection refused" }),
            { status: 502, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response(JSON.stringify({ ok: true, id: body.id, created: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );
    const { persistAllocateRecord, persistSignedEnvelope } = await loadSink(true);
    const id = await persistAllocateRecord(params);

    // The user just approved a wallet prompt. The message has to say the funds did not move,
    // or an abort right after a signature reads like the worst possible outcome.
    await expect(persistSignedEnvelope(id, ENVELOPE)).rejects.toThrow(
      /nothing was submitted and no funds moved/i
    );
    await expect(persistSignedEnvelope(id, ENVELOPE)).rejects.toThrow(/connection refused/);
  });

  it("THROWS when localStorage refuses, without reaching the database", async () => {
    const fetchImpl = okFetch();
    vi.stubGlobal("fetch", fetchImpl);
    const { persistAllocateRecord, persistSignedEnvelope } = await loadSink(true);
    const id = await persistAllocateRecord(params);
    const before = fetchImpl.mock.calls.length;

    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    await expect(persistSignedEnvelope(id, ENVELOPE)).rejects.toThrow(/nothing was submitted/i);
    expect(fetchImpl.mock.calls).toHaveLength(before);
  });

  // The flag gates the DATABASE channel, not the envelope. It defaults off, so if it gated
  // both, the default deployment would store no envelope anywhere — every record it produced
  // would be un-rescuable with the Solver key, which is the failure D-289 is about.
  it("still writes localStorage while the flag is off, and no network", async () => {
    const fetchImpl = okFetch();
    vi.stubGlobal("fetch", fetchImpl);
    const { persistAllocateRecord, persistSignedEnvelope, listAllocateRecords } =
      await loadSink(false);
    const id = await persistAllocateRecord(params);
    await persistSignedEnvelope(id, ENVELOPE);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(listAllocateRecords()[0]).toMatchObject({ id, signedEnvelope: ENVELOPE });
  });
});

describe("updateAllocateRecordEverywhere", () => {
  it("updates both channels", async () => {
    const fetchImpl = okFetch();
    vi.stubGlobal("fetch", fetchImpl);
    const { persistAllocateRecord, updateAllocateRecordEverywhere, listAllocateRecords } =
      await loadSink(true);

    const id = await persistAllocateRecord(params);
    await updateAllocateRecordEverywhere(id, { status: "submitted", txHash: "TxAbc" });

    expect(listAllocateRecords()[0]).toMatchObject({ status: "submitted", txHash: "TxAbc" });
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body as string)).toEqual({
      id,
      status: "submitted",
      txHash: "TxAbc",
    });
  });

  // A lost status update is recoverable; the callers are already reporting something else and
  // an exception here would replace a real message with a storage one. Verified as a total
  // function because `allocate-poll.ts` awaits it INSIDE its try/catch — a throw there would
  // swallow an observed credit and report a possible orphan for funds that arrived.
  it("never throws, even when the database is unreachable", async () => {
    const fetchImpl = okFetch();
    vi.stubGlobal("fetch", fetchImpl);
    const { persistAllocateRecord, updateAllocateRecordEverywhere, listAllocateRecords } =
      await loadSink(true);
    const id = await persistAllocateRecord(params);

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    await expect(updateAllocateRecordEverywhere(id, { status: "credited" })).resolves.toBeUndefined();
    // The local channel still recorded it.
    expect(listAllocateRecords()[0].status).toBe("credited");
  });

  it("stays local when the flag is off", async () => {
    const fetchImpl = okFetch();
    vi.stubGlobal("fetch", fetchImpl);
    const { persistAllocateRecord, updateAllocateRecordEverywhere } = await loadSink(false);
    const id = await persistAllocateRecord(params);
    await updateAllocateRecordEverywhere(id, { status: "credited" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// The FOURTH write, and the only one that runs DATABASE FIRST (009.plan FE #4). Everything
// here is about that order: the row on the solver's worklist is the objective, so the local
// copy may only say `credited` once the database does — otherwise a lost PATCH leaves the row
// `suspected_orphan` forever with nothing left to retry it.
describe("confirmAllocateRecordCredited", () => {
  /** POST succeeds (so a record can be seeded); PATCH is whatever the test decides. */
  function fetchWithPatch(onPatch: (init: RequestInit) => Promise<Response>) {
    return vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === "PATCH") return onPatch(init);
      const sent = JSON.parse(init.body as string) as { id: string };
      return new Response(JSON.stringify({ ok: true, id: sent.id, created: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
  }
  const json = (status: number, payload: unknown) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  async function seedSuspectedOrphan(enabled: boolean) {
    const mod = await loadSink(enabled);
    const id = await mod.persistAllocateRecord(params);
    mod.updateAllocateRecord(id, { status: "suspected_orphan" });
    return { ...mod, id };
  }

  // ── The order. Mutation 1 (local before DB) dies here. ─────────────────────────────
  it("leaves the local record suspected_orphan when the database did not take the flip", async () => {
    vi.stubGlobal("fetch", fetchWithPatch(async () => { throw new Error("network down"); }));
    const { confirmAllocateRecordCredited, listAllocateRecords, id } = await seedSuspectedOrphan(true);

    await expect(confirmAllocateRecordCredited(id)).resolves.toBe(false);
    // Still on the local worklist, which is what makes the next load retry the PATCH.
    expect(listAllocateRecords()[0].status).toBe("suspected_orphan");
  });

  // Mutation 2 (`await` → `void` on the PATCH) dies here: with the PATCH in flight the local
  // record must not have moved yet.
  it("flips the local record only AFTER the PATCH has resolved", async () => {
    let resolvePatch!: (r: Response) => void;
    vi.stubGlobal(
      "fetch",
      fetchWithPatch(() => new Promise<Response>((resolve) => { resolvePatch = resolve; }))
    );
    const { confirmAllocateRecordCredited, listAllocateRecords, id } = await seedSuspectedOrphan(true);

    const pending = confirmAllocateRecordCredited(id);
    await new Promise((r) => setTimeout(r, 0));
    expect(listAllocateRecords()[0].status).toBe("suspected_orphan");

    resolvePatch(json(200, { ok: true, id, updated: true }));
    await expect(pending).resolves.toBe(true);
    expect(listAllocateRecords()[0].status).toBe("credited");
  });

  it("sends exactly {id, status: 'credited'} — no txHash, no error, nothing else", async () => {
    const fetchImpl = fetchWithPatch(async (init) => {
      const sent = JSON.parse(init.body as string) as { id: string };
      return json(200, { ok: true, id: sent.id, updated: true });
    });
    vi.stubGlobal("fetch", fetchImpl);
    const { confirmAllocateRecordCredited, id } = await seedSuspectedOrphan(true);

    await confirmAllocateRecordCredited(id);
    const patches = fetchImpl.mock.calls.filter(([, init]) => init.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(JSON.parse(patches[0][1].body as string)).toEqual({ id, status: "credited" });
  });

  // Mutation 9 (404 treated as failure) dies here. A record from before the database existed
  // has no row to fix; left unflipped it would be re-checked on every load, forever.
  it("treats not-found as 'nothing to fix off-client' and flips the local record", async () => {
    vi.stubGlobal(
      "fetch",
      fetchWithPatch(async () => json(404, { ok: false, code: "not-found", error: "no such record" }))
    );
    const { confirmAllocateRecordCredited, listAllocateRecords, id } = await seedSuspectedOrphan(true);

    await expect(confirmAllocateRecordCredited(id)).resolves.toBe(true);
    expect(listAllocateRecords()[0].status).toBe("credited");
  });

  it("stays local when the flag is off: no fetch, local flips", async () => {
    const fetchImpl = fetchWithPatch(async () => json(200, { ok: true, id: "x", updated: true }));
    vi.stubGlobal("fetch", fetchImpl);
    const { confirmAllocateRecordCredited, listAllocateRecords, id } = await seedSuspectedOrphan(false);

    await expect(confirmAllocateRecordCredited(id)).resolves.toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(listAllocateRecords()[0].status).toBe("credited");
  });

  // Fail-open: it runs on app load, where nothing may throw.
  it.each([
    ["a fetch that throws", () => { throw new Error("boom"); }],
    ["an unreadable body", async () => new Response("<html>", { status: 500 })],
    ["a 503", async () => json(503, { ok: false, code: "not-configured", error: "no db" })],
  ])("never throws on %s, and leaves the local record for the next load", async (_label, onPatch) => {
    vi.stubGlobal("fetch", fetchWithPatch(onPatch as (init: RequestInit) => Promise<Response>));
    const { confirmAllocateRecordCredited, listAllocateRecords, id } = await seedSuspectedOrphan(true);

    await expect(confirmAllocateRecordCredited(id)).resolves.toBe(false);
    expect(listAllocateRecords()[0].status).toBe("suspected_orphan");
  });
});

// D-295: `submitted` → `failed` for an envelope that provably never executed. Same order as the
// credited flip, database first — the row a human reads must not keep saying "sent".
describe("markAllocateRecordNeverExecuted", () => {
  function fetchWithPatch(onPatch: (init: RequestInit) => Promise<Response>) {
    return vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === "PATCH") return onPatch(init);
      const sent = JSON.parse(init.body as string) as { id: string };
      return new Response(JSON.stringify({ ok: true, id: sent.id, created: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
  }
  const json = (status: number, payload: unknown) =>
    new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });

  async function seedSubmitted(enabled: boolean) {
    const mod = await loadSink(enabled);
    const id = await mod.persistAllocateRecord(params);
    mod.updateAllocateRecord(id, { status: "submitted" });
    return { ...mod, id };
  }

  it("patches the database with failed and the reason, then flips the local copy", async () => {
    const fetchImpl = fetchWithPatch(async () => json(200, { ok: true, id: "x", updated: true }));
    vi.stubGlobal("fetch", fetchImpl);
    const { markAllocateRecordNeverExecuted, listAllocateRecords, NEVER_EXECUTED_ERROR, id } =
      await seedSubmitted(true);

    await expect(markAllocateRecordNeverExecuted(id)).resolves.toBe(true);
    const patches = fetchImpl.mock.calls.filter(([, init]) => init.method === "PATCH");
    expect(JSON.parse(patches[0][1].body as string)).toEqual({
      id,
      status: "failed",
      error: NEVER_EXECUTED_ERROR,
    });
    expect(listAllocateRecords()[0]).toMatchObject({ status: "failed", error: NEVER_EXECUTED_ERROR });
  });

  it("leaves the local record submitted when the database did not take the flip", async () => {
    vi.stubGlobal("fetch", fetchWithPatch(async () => { throw new Error("network down"); }));
    const { markAllocateRecordNeverExecuted, listAllocateRecords, id } = await seedSubmitted(true);

    await expect(markAllocateRecordNeverExecuted(id)).resolves.toBe(false);
    expect(listAllocateRecords()[0].status).toBe("submitted");
  });

  it("treats not-found as done — a record from before the database existed", async () => {
    vi.stubGlobal(
      "fetch",
      fetchWithPatch(async () => json(404, { ok: false, code: "not-found", error: "no such record" }))
    );
    const { markAllocateRecordNeverExecuted, listAllocateRecords, id } = await seedSubmitted(true);

    await expect(markAllocateRecordNeverExecuted(id)).resolves.toBe(true);
    expect(listAllocateRecords()[0].status).toBe("failed");
  });

  it("flips only the local copy when ops records are off", async () => {
    const fetchImpl = fetchWithPatch(async () => json(200, { ok: true, id: "x", updated: true }));
    vi.stubGlobal("fetch", fetchImpl);
    const { markAllocateRecordNeverExecuted, listAllocateRecords, id } = await seedSubmitted(false);

    await expect(markAllocateRecordNeverExecuted(id)).resolves.toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(listAllocateRecords()[0].status).toBe("failed");
  });
});
