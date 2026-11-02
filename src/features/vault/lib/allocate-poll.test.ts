// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { waitForAllocateCredit } from "./allocate-poll";
import {
  recordPendingAllocate,
  listAllocateRecords,
  listUnresolvedAllocateRecords,
} from "./allocate-rescue-store";

// The credit poll is the ONLY thing allowed to declare an Allocate settled (a successful
// execute_intents receipt does not — on_auth can still orphan). Tests fake the RPC layer.

function viewResponse(value: unknown): Response {
  const bytes = Array.from(new TextEncoder().encode(JSON.stringify(value)));
  return new Response(
    JSON.stringify({ result: { result: bytes, logs: [], block_height: 1, block_hash: "h" } }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

// Queue of responses keyed by view method, so a poll round = list + balance.
function queueRpc(sequence: Array<{ method: string; value: unknown } | { error: string }>) {
  const fn = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
    const step = sequence.shift();
    if (!step) throw new Error("unexpected extra RPC call");
    if ("error" in step) throw new Error(step.error);
    const body = JSON.parse(init.body as string);
    expect(body.params.method_name).toBe(step.method);
    return viewResponse(step.value);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const noSleep = () => Promise.resolve();

beforeEach(() => {
  window.localStorage.clear();
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BASE = {
  accountId: "alice.near",
  legs: [{ tokenId: "nep141:usdc.near", expectedAmount: BigInt(1_000_000) }],
  sleep: noSleep,
};

describe("waitForAllocateCredit", () => {
  it("resolves when a NEW portfolio shows the credit", async () => {
    queueRpc([
      { method: "list_portfolios_for", value: ["pf-old", "pf-new"] },
      { method: "get_portfolio_balance", value: [["nep141:usdc.near", "1000000"]] },
    ]);

    const credit = await waitForAllocateCredit({ ...BASE, knownPortfolioIds: ["pf-old"] });
    expect(credit).toEqual({
      portfolioId: "pf-new",
      legs: [{ tokenId: "nep141:usdc.near", amount: BigInt(1_000_000) }],
    });
  });

  it("ignores pre-existing portfolios even if they hold the token", async () => {
    queueRpc([
      // pf-old is in the snapshot and must never be mistaken for the new credit.
      { method: "list_portfolios_for", value: ["pf-old"] },
      { method: "list_portfolios_for", value: ["pf-old", "pf-new"] },
      { method: "get_portfolio_balance", value: [["nep141:usdc.near", "1000000"]] },
    ]);

    const credit = await waitForAllocateCredit({ ...BASE, knownPortfolioIds: ["pf-old"] });
    expect(credit.portfolioId).toBe("pf-new");
  });

  it("keeps polling while the new portfolio exists but is still empty", async () => {
    queueRpc([
      { method: "list_portfolios_for", value: ["pf-new"] },
      { method: "get_portfolio_balance", value: [] },
      { method: "list_portfolios_for", value: ["pf-new"] },
      { method: "get_portfolio_balance", value: [["nep141:usdc.near", "1000000"]] },
    ]);

    const credit = await waitForAllocateCredit({ ...BASE, knownPortfolioIds: [] });
    expect(credit.legs[0].amount).toBe(BigInt(1_000_000));
  });

  it("does not settle for a partial credit", async () => {
    queueRpc([
      { method: "list_portfolios_for", value: ["pf-new"] },
      { method: "get_portfolio_balance", value: [["nep141:usdc.near", "999999"]] },
      { method: "list_portfolios_for", value: ["pf-new"] },
      { method: "get_portfolio_balance", value: [["nep141:usdc.near", "1000000"]] },
    ]);

    const credit = await waitForAllocateCredit({ ...BASE, knownPortfolioIds: [] });
    expect(credit.legs[0].amount).toBe(BigInt(1_000_000));
  });

  describe("multi-token (008.plan Phase 2)", () => {
    const TWO = {
      accountId: "alice.near",
      legs: [
        { tokenId: "nep141:usdc.near", expectedAmount: BigInt(1_000_000) },
        { tokenId: "nep141:eth.near", expectedAmount: BigInt(130_000_000_000_000) },
      ],
      sleep: noSleep,
    };

    it("resolves only once EVERY leg is credited", async () => {
      queueRpc([
        // First read catches the ledger with just one of the two tokens in.
        { method: "list_portfolios_for", value: ["pf-new"] },
        { method: "get_portfolio_balance", value: [["nep141:usdc.near", "1000000"]] },
        { method: "list_portfolios_for", value: ["pf-new"] },
        {
          method: "get_portfolio_balance",
          value: [
            ["nep141:usdc.near", "1000000"],
            ["nep141:eth.near", "130000000000000"],
          ],
        },
      ]);

      const credit = await waitForAllocateCredit({ ...TWO, knownPortfolioIds: [] });
      expect(credit.legs).toEqual([
        { tokenId: "nep141:usdc.near", amount: BigInt(1_000_000) },
        { tokenId: "nep141:eth.near", amount: BigInt(130_000_000_000_000) },
      ]);
    });

    it("does not settle when one leg is short, even if the other overshoots", async () => {
      queueRpc([
        { method: "list_portfolios_for", value: ["pf-new"] },
        {
          method: "get_portfolio_balance",
          value: [
            ["nep141:usdc.near", "9000000"],
            ["nep141:eth.near", "129999999999999"],
          ],
        },
        { method: "list_portfolios_for", value: ["pf-new"] },
        {
          method: "get_portfolio_balance",
          value: [
            ["nep141:usdc.near", "9000000"],
            ["nep141:eth.near", "130000000000000"],
          ],
        },
      ]);

      const credit = await waitForAllocateCredit({ ...TWO, knownPortfolioIds: [] });
      expect(credit.legs[1].amount).toBe(BigInt(130_000_000_000_000));
    });

    it("refuses a zero expectation, which any empty ledger row would satisfy", async () => {
      // Without this the FIRST unknown portfolio would be reported as credited —
      // including one the user created somewhere else entirely.
      await expect(
        waitForAllocateCredit({
          accountId: "alice.near",
          legs: [{ tokenId: "nep141:usdc.near", expectedAmount: BigInt(0) }],
          knownPortfolioIds: [],
          sleep: noSleep,
        })
      ).rejects.toThrow(/positive amount/);
    });

    it("refuses an empty leg list", async () => {
      await expect(
        waitForAllocateCredit({
          accountId: "alice.near",
          legs: [],
          knownPortfolioIds: [],
          sleep: noSleep,
        })
      ).rejects.toThrow(/at least one leg/);
    });
  });

  it("survives a transient RPC error instead of abandoning an in-flight allocate", async () => {
    queueRpc([
      { error: "RPC flake" },
      { method: "list_portfolios_for", value: ["pf-new"] },
      { method: "get_portfolio_balance", value: [["nep141:usdc.near", "1000000"]] },
    ]);

    const credit = await waitForAllocateCredit({ ...BASE, knownPortfolioIds: [] });
    expect(credit.portfolioId).toBe("pf-new");
  });

  it("marks the rescue record credited ONLY on an observed balance", async () => {
    const recordId = recordPendingAllocate({
      signerId: "alice.near",
      msg: "{}",
      vaultId: "intentfolio-staging.near",
      portfolioName: "P",
      legs: [{ tokenId: "nep141:usdc.near", amount: "1000000" }],
    });
    queueRpc([
      { method: "list_portfolios_for", value: ["pf-new"] },
      { method: "get_portfolio_balance", value: [["nep141:usdc.near", "1000000"]] },
    ]);

    await waitForAllocateCredit({ ...BASE, knownPortfolioIds: [], recordId });
    expect(listAllocateRecords()[0].status).toBe("credited");
  });

  it("throws on timeout and leaves the record UNRESOLVED for manual rescue", async () => {
    const recordId = recordPendingAllocate({
      signerId: "alice.near",
      msg: "{}",
      vaultId: "intentfolio-staging.near",
      portfolioName: "P",
      legs: [{ tokenId: "nep141:usdc.near", amount: "1000000" }],
    });
    queueRpc([
      { method: "list_portfolios_for", value: ["pf-new"] },
      { method: "get_portfolio_balance", value: [] },
    ]);
    // Clock jumps past the timeout on the deadline check after the first round.
    let t = 0;
    const now = () => (t += 200_000);

    await expect(
      waitForAllocateCredit({ ...BASE, knownPortfolioIds: [], recordId, now })
    ).rejects.toThrow(/not credited within/);
    // The safety property, asserted as the VALUE the solver reads rather than as "anything
    // but credited": `listSuspectedOrphans` selects on this exact string, so the weaker
    // assertion stayed green with the record stuck at `submitted` — off the watchdog's
    // worklist, which is the failure this test exists to catch.
    expect(listAllocateRecords()[0].status).toBe("suspected_orphan");
    // And still on the LOCAL worklist, which filters on "not credited".
    expect(listUnresolvedAllocateRecords()[0].id).toBe(recordId);
  });
});

// The credited PATCH is awaited INSIDE the poll's try/catch, so a throw there would be caught
// as a read error and the loop would keep going until it timed out — reporting "the funds may
// be held pending" for funds that demonstrably arrived. That is a failure in the WRONG
// direction, and it is invisible until the ops database has a bad day.
describe("waitForAllocateCredit — an ops-database problem cannot hide an observed credit", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("still reports the credit when the off-client status write fails", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_OPS_RECORDS", "true");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const { waitForAllocateCredit: wait } = await import("./allocate-poll");
    const { recordPendingAllocate: record, listAllocateRecords: list } = await import(
      "./allocate-rescue-store"
    );

    const recordId = record({
      signerId: "alice.near",
      msg: "{}",
      vaultId: "intentfolio-staging.near",
      portfolioName: "P",
      legs: [{ tokenId: "nep141:usdc.near", amount: "1000000" }],
    });

    const rpc = [
      { method: "list_portfolios_for", value: ["pf-new"] },
      { method: "get_portfolio_balance", value: [["nep141:usdc.near", "1000000"]] },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/api/ops/")) throw new Error("ops database is down");
        const step = rpc.shift();
        if (!step) throw new Error("unexpected extra RPC call");
        return viewResponse(step.value);
      })
    );

    const credit = await wait({
      accountId: "alice.near",
      legs: [{ tokenId: "nep141:usdc.near", expectedAmount: BigInt("1000000") }],
      knownPortfolioIds: [],
      recordId,
      timeoutMs: 50,
      intervalMs: 1,
    });

    expect(credit.portfolioId).toBe("pf-new");
    // And the local channel still recorded it, so the user's own worklist is right even
    // though the solver's is not.
    expect(list().find((r) => r.id === recordId)?.status).toBe("credited");
  });
});

// A timeout is the ONLY way a record reaches the solver: `listSuspectedOrphans` reads
// `status = 'suspected_orphan'` and nothing else, so if this write does not leave the browser
// the watchdog sees an empty worklist while funds sit stranded in the vault. That makes the
// off-client leg of this transition, not just the localStorage one, the thing worth testing.
describe("waitForAllocateCredit — the timeout is what hands the record to the solver", () => {
  afterEach(() => vi.unstubAllEnvs());

  const RECORD = {
    signerId: "alice.near",
    msg: "{}",
    vaultId: "intentfolio-staging.near",
    portfolioName: "P",
    legs: [{ tokenId: "nep141:usdc.near", amount: "1000000" }],
  };

  const RUN = {
    accountId: "alice.near",
    legs: [{ tokenId: "nep141:usdc.near", expectedAmount: BigInt("1000000") }],
    knownPortfolioIds: [] as string[],
    timeoutMs: 50,
    intervalMs: 1,
  };

  async function loadWithOpsRecords() {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_OPS_RECORDS", "true");
    const { waitForAllocateCredit: wait } = await import("./allocate-poll");
    const store = await import("./allocate-rescue-store");
    return { wait, record: store.recordPendingAllocate, list: store.listAllocateRecords };
  }

  it("PATCHes suspected_orphan off-client, not only into localStorage", async () => {
    const { wait, record, list } = await loadWithOpsRecords();
    const recordId = record(RECORD);

    const patches: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (String(url).includes("/api/ops/")) {
          patches.push(JSON.parse(init.body as string));
          return new Response(JSON.stringify({ ok: true, id: recordId, updated: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        // The ledger never shows a new portfolio, so the poll can only end on the timeout.
        return viewResponse([]);
      })
    );

    await expect(wait({ ...RUN, recordId })).rejects.toThrow(/not credited within/);

    // Exactly one PATCH, carrying exactly the status the solver's query matches on. An
    // equality assertion and not `toContainEqual`: a second write here would mean some other
    // status also reached the row, and the last one to land is what the worklist sees.
    expect(patches).toEqual([{ id: recordId, status: "suspected_orphan" }]);
    expect(list()[0].status).toBe("suspected_orphan");
  });

  it("reports the timeout, not a storage error, when the off-client write fails", async () => {
    const { wait, record, list } = await loadWithOpsRecords();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const recordId = record(RECORD);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/api/ops/")) throw new Error("ops database is down");
        return viewResponse([]);
      })
    );

    // The user is told the funds may be held pending — the message that keeps a possibly
    // stranded Allocate legible. Replacing it with "the rescue record could not be stored"
    // would describe the wrong problem: by this point the funds have already moved, so
    // nothing here is fail-closed and nothing may abort on a failed write.
    await expect(wait({ ...RUN, recordId })).rejects.toThrow(/not credited within/);
    // The local channel still carries the flag, so the user's own worklist is right even
    // though the solver's never heard about it.
    expect(list()[0].status).toBe("suspected_orphan");
  });

  // The `await` on that write is load-bearing and nothing else pins it: dropping it leaves
  // the PATCH in flight while the throw already reached the UI, and the user's reaction to
  // "not credited" is often to close the tab — which cancels it. The record would then be
  // `suspected_orphan` only in a localStorage the solver cannot read.
  it("does not throw until the off-client write has landed", async () => {
    const { wait, record } = await loadWithOpsRecords();
    const recordId = record(RECORD);

    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/api/ops/")) {
          await gate;
          order.push("patch-landed");
          return new Response(JSON.stringify({ ok: true, id: recordId, updated: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return viewResponse([]);
      })
    );

    const pending = wait({ ...RUN, recordId, timeoutMs: 20 }).catch(() => order.push("threw"));

    // Long enough for the 20ms poll to give up and reach the write, where the gate holds it.
    await new Promise((r) => setTimeout(r, 150));
    expect(order).toEqual([]);

    release();
    await pending;
    expect(order).toEqual(["patch-landed", "threw"]);
  });
});
