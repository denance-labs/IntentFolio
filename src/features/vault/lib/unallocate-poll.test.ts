// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { waitForUnallocateSettlement } from "./unallocate-poll";

// `commit_portfolio_changes` only OPENS the withdrawal — the debit lands in a later
// callback, so the ledger is the only settlement signal. A timeout must never be phrased
// as a loss: the funds stay in the portfolio when a batch reverts.

function viewResponse(value: unknown): Response {
  const bytes = Array.from(new TextEncoder().encode(JSON.stringify(value)));
  return new Response(
    JSON.stringify({ result: { result: bytes, logs: [], block_height: 1, block_hash: "h" } }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function queueBalances(sequence: Array<Array<[string, string]> | { error: string }>) {
  const fn = vi.fn().mockImplementation(async () => {
    const step = sequence.shift();
    if (!step) throw new Error("unexpected extra RPC call");
    if ("error" in step) throw new Error(step.error);
    return viewResponse(step);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const noSleep = () => Promise.resolve();
const PID = "p_000000000000";
const USDT = "nep141:usdt.tether-token.near";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("waitForUnallocateSettlement", () => {
  it("waits while the position still shows the locked funds, then resolves on the debit", async () => {
    queueBalances([
      [[USDT, "1000000"]], // committed, not settled yet — qty_held drops only at settle
      [], // drained
    ]);

    const remaining = await waitForUnallocateSettlement({
      portfolioId: PID,
      legs: [{ tokenId: USDT, expectedRemaining: BigInt(0) }],
      sleep: noSleep,
    });

    expect(remaining).toEqual([]);
  });

  it("settles a PARTIAL withdrawal against the expected remainder", async () => {
    queueBalances([[[USDT, "1000000"]], [[USDT, "400000"]]]);

    const remaining = await waitForUnallocateSettlement({
      portfolioId: PID,
      legs: [{ tokenId: USDT, expectedRemaining: BigInt(400_000) }],
      sleep: noSleep,
    });

    expect(remaining).toEqual([[USDT, BigInt(400_000)]]);
  });

  // Doubles as the regression for the id translation: the RPC replies in the CONTRACT's
  // space (`nep141:wrap.near`) while the leg is named in OURS (`near`). They have to meet.
  it("requires EVERY leg to settle, not just the first", async () => {
    const WNEAR_ON_CHAIN = "nep141:wrap.near";
    queueBalances([
      [
        [USDT, "0"],
        [WNEAR_ON_CHAIN, "5000000"],
      ],
      [],
    ]);

    const remaining = await waitForUnallocateSettlement({
      portfolioId: PID,
      legs: [
        { tokenId: USDT, expectedRemaining: BigInt(0) },
        { tokenId: "near", expectedRemaining: BigInt(0) },
      ],
      sleep: noSleep,
    });

    expect(remaining).toEqual([]);
  });

  it("keeps polling through a transient read error", async () => {
    queueBalances([{ error: "RPC 502" }, []]);

    const remaining = await waitForUnallocateSettlement({
      portfolioId: PID,
      legs: [{ tokenId: USDT, expectedRemaining: BigInt(0) }],
      sleep: noSleep,
    });

    expect(remaining).toEqual([]);
  });

  it("times out saying the funds are still held — never that they were lost", async () => {
    let clock = 0;
    queueBalances([[[USDT, "1000000"]], [[USDT, "1000000"]]]);

    await expect(
      waitForUnallocateSettlement({
        portfolioId: PID,
        legs: [{ tokenId: USDT, expectedRemaining: BigInt(0) }],
        timeoutMs: 1,
        sleep: noSleep,
        now: () => (clock += 1),
      })
    ).rejects.toThrow(/still held by the portfolio — nothing was lost/);
  });
});

// D-379: in v2 the poll only judges balances once OUR batch is no longer pending.
describe("waitForUnallocateSettlement — batchResolved (D-379)", () => {
  it("does not read balances while the batch is pending, even if they already look settled", async () => {
    const fetchMock = queueBalances([[[USDT, "0"]]]);
    const batchResolved = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);

    await waitForUnallocateSettlement({
      portfolioId: PID,
      legs: [{ tokenId: USDT, expectedRemaining: BigInt(0) }],
      batchResolved,
      sleep: noSleep,
    });

    expect(batchResolved).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenCalledTimes(1); // one balance read, after the batch resolved
  });

  it("a batch view that keeps failing ends in the timeout, never in 'settled'", async () => {
    const fetchMock = queueBalances([]);
    let t = 0;
    await expect(
      waitForUnallocateSettlement({
        portfolioId: PID,
        legs: [{ tokenId: USDT, expectedRemaining: BigInt(0) }],
        batchResolved: vi.fn().mockRejectedValue(new Error("rpc down")),
        sleep: noSleep,
        timeoutMs: 10,
        now: () => (t += 5),
      })
    ).rejects.toThrow(/not settled/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
