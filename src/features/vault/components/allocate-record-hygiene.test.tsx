// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { StrictMode } from "react";

// The component has no logic of its own; what is under test is the wiring — the flag gate,
// that it reads the real store, and that it runs ONCE per load. The flag is read at module
// load (Next inlines NEXT_PUBLIC_ values at build time), so each test stubs the environment
// and re-imports, as `allocate-record-sink.test.ts` does.
async function load(roundtrip: boolean) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_VAULT_ROUNDTRIP", roundtrip ? "true" : "false");
  vi.stubEnv("NEXT_PUBLIC_OPS_RECORDS", "true");
  const { AllocateRecordHygiene } = await import("./allocate-record-hygiene");
  const store = await import("../lib/allocate-rescue-store");
  return { AllocateRecordHygiene, ...store };
}

const STORE_KEY = "vault.allocate-rescue.v1";

const VERDICTS_URL = "/api/ops/allocate-verdicts";

/** Answers every RPC as "no seal", every PATCH as ok and the verdict read as "none yet". */
function quietFetch() {
  return vi.fn(async (url: string, init: RequestInit) =>
    new Response(
      JSON.stringify(
        init.method === "PATCH"
          ? { ok: true, id: "x", updated: true }
          : url === VERDICTS_URL
            ? { ok: true, verdicts: {} }
            : // `get_allocate_seal` answering `null`: no credit route applied this msg.
              { result: { result: Array.from(new TextEncoder().encode("null")), logs: [] } }
      ),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
  );
}

const flush = () => act(() => new Promise<void>((r) => setTimeout(r, 0)));

beforeEach(() => {
  window.localStorage.clear();
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("<AllocateRecordHygiene />", () => {
  // Mutation 8 (dropping the flag gate) dies here.
  it("with the flag off, neither reads the store nor touches the network", async () => {
    const fetchImpl = quietFetch();
    vi.stubGlobal("fetch", fetchImpl);
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const { AllocateRecordHygiene } = await load(false);

    render(<AllocateRecordHygiene />);
    await flush();

    expect(getItem.mock.calls.map(([k]) => k)).not.toContain(STORE_KEY);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("with the flag on and an empty store, reads the store and makes zero requests", async () => {
    const fetchImpl = quietFetch();
    vi.stubGlobal("fetch", fetchImpl);
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const { AllocateRecordHygiene } = await load(true);

    render(<AllocateRecordHygiene />);
    await flush();

    expect(getItem.mock.calls.map(([k]) => k)).toContain(STORE_KEY);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("runs ONE pass per load, even under StrictMode's double mount", async () => {
    const fetchImpl = quietFetch();
    vi.stubGlobal("fetch", fetchImpl);
    const { AllocateRecordHygiene, recordPendingAllocate, updateAllocateRecord } = await load(true);
    recordPendingAllocate({
      id: "6f1b3c2a-9d4e-4f7a-8b1c-2e5d7a9c0f31",
      signerId: "alice.near",
      msg: '{"deadline":1}',
      vaultId: "intentfolio-staging.near",
      portfolioName: "Balanced",
      legs: [{ tokenId: "nep141:wrap.near", amount: "1" }],
      createdAt: 1,
    });
    updateAllocateRecord("6f1b3c2a-9d4e-4f7a-8b1c-2e5d7a9c0f31", { status: "suspected_orphan" });

    render(
      <StrictMode>
        <AllocateRecordHygiene />
      </StrictMode>
    );
    // And a second mount on top, in case the test renderer is not in a dev build.
    render(<AllocateRecordHygiene />);
    await flush();

    // One candidate: one verdict read (D-448) and one seal read — not two, not four.
    const verdictCalls = fetchImpl.mock.calls.filter(([url]) => url === VERDICTS_URL);
    expect(verdictCalls).toHaveLength(1);
    const rpcCalls = fetchImpl.mock.calls.filter(([url, init]) => init.method !== "PATCH" && url !== VERDICTS_URL);
    expect(rpcCalls).toHaveLength(1);
    expect(JSON.parse(rpcCalls[0][1].body as string).params.method_name).toBe("get_allocate_seal");
  });
});

describe("AllocateRecordHygiene — the old relayer token (017-2, D-365)", () => {
  it("deletes it on load, whatever the flags", async () => {
    for (const roundtrip of [false, true]) {
      vi.stubGlobal("fetch", quietFetch());
      window.localStorage.setItem("vault.relayer-token.v1", "old-secret");
      const { AllocateRecordHygiene } = await load(roundtrip);
      render(<AllocateRecordHygiene />);
      await flush();
      expect(window.localStorage.getItem("vault.relayer-token.v1")).toBeNull();
      cleanup();
    }
  });
});

describe("AllocateRecordHygiene — the old history cache (D-420, 028-7)", () => {
  it("deletes every v1 and v2 entry on load and keeps unrelated keys", async () => {
    vi.stubGlobal("fetch", quietFetch());
    window.localStorage.setItem("vault-history:v1:vault.near:alice.near", "{}");
    window.localStorage.setItem("vault-history:v1:vault.near:bob.near", "{}");
    // The browser's FastNEAR read, retired in 028-7.
    window.localStorage.setItem("vault-history:v2:vault.near:alice.near", "{}");
    window.localStorage.setItem("nav-snapshots:v2", "{}");
    const { AllocateRecordHygiene } = await load(false);
    render(<AllocateRecordHygiene />);
    await flush();
    expect(Object.keys(window.localStorage)).toEqual(["nav-snapshots:v2"]);
  });

  it("deletes D-493's retired rebalance cache too (028-3)", async () => {
    vi.stubGlobal("fetch", quietFetch());
    window.localStorage.setItem("vault-rebalances:v1:intentfolio-vault.near", "{}");
    window.localStorage.setItem("nav-snapshots:v2", "{}");
    const { AllocateRecordHygiene } = await load(false);
    render(<AllocateRecordHygiene />);
    await flush();
    expect(Object.keys(window.localStorage)).toEqual(["nav-snapshots:v2"]);
  });

  it("does not throw when storage is blocked", async () => {
    window.localStorage.setItem("vault-history:v1:vault.near:alice.near", "{}");
    vi.spyOn(Storage.prototype, "key").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    const { clearLegacyHistoryCache } = await import("../lib/vault-history-legacy");
    expect(() => clearLegacyHistoryCache()).not.toThrow();
  });
});
