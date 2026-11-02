import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PollTimeoutError } from "@defuse-protocol/internal-utils";
import {
  hotDeliveryStats,
  parseHotWithdrawalNonces,
  waitForHotDelivery,
  type HotDeliveryDeps,
} from "./hot-delivery";
import { WithdrawDeliveryCancelledError } from "./withdraw-errors";
import { withdrawalRegistry } from "./withdrawal-registry";

// The `hot-omni` delivery wait (block 4.3.4). Everything here happens AFTER the funds left
// the General Balance, so the property under test is never "did it succeed" — it is whether
// each of the three sources is believed exactly as far as it deserves:
//
//   the receipt logs   — the only place the nonce exists; absent for a tick means "not yet".
//   the refuel contract — authoritative on CANCELED and on "finished", lags on the EVM hash,
//                         and on the two non-EVM chains never produces one at all (D-262).
//   the bridge indexer  — the destination hash on EVERY chain, and on EVM its SILENCE is
//                         meaningful too (still in flight). On non-EVM silence is not
//                         believed that far: the contract is still read after it.
//
// No network: `fetch` throws, and all three sources are injected.

const TX_HASH = "8xTxHashOfTheSettlement";
const NONCE = "1234567890";
const POLY = "eth:137";
const TON = "ton:mainnet";
const STELLAR = "stellar:mainnet";

// The two real destination hashes the bridge indexer returned for the session-120 and
// session-121 runs, kept verbatim so the shape under test is the one production answers with.
const STELLAR_HASH = "75e5cad69252d880b6178f08c2a2858f6956a91cd63a5902c27910708b978b07";
const TON_HASH = "3584b924eb045514876ac59fdc04d74112f740a264d2e40212aa03bdaf83e6c7";

/**
 * Poll options tuned for tests: no sleeping between ticks, and a deadline in milliseconds
 * rather than the real chain's minutes. `p99` is the only knob a test ever varies — short
 * when the point IS the deadline, generous when the point is what the sources say.
 */
const fast = (p99 = 50) => ({ stats: { p50: 1, p90: 2, p99 }, minInterval: 0, maxInterval: 0 });
const PATIENT = fast(5_000);

const receiptWith = (...nonces: string[]) => ({
  receipts_outcome: nonces.map((n) => ({
    outcome: { logs: [`EVENT_JSON:{"standard":"nep245","data":[{"memo":"${n}"}]}`] },
  })),
});

const deps = (over: Partial<HotDeliveryDeps> = {}): HotDeliveryDeps => ({
  fetchTxOutcome: async () => receiptWith(NONCE),
  getWithdrawalStatus: async () => null,
  indexerWithdrawals: async () => [],
  ...over,
});

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("no test may touch the network");
    })
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseHotWithdrawalNonces", () => {
  it("reads the nonce out of a memo, in receipt order", () => {
    expect(parseHotWithdrawalNonces(receiptWith("11", "22"))).toEqual(["11", "22"]);
  });

  it("hands the FIRST nonce to the delivery wait", async () => {
    // Our envelope carries exactly one `mt_withdraw`, so index 0 is that withdrawal — the
    // same index upstream uses for a single-withdrawal intent. Pinned because a refactor to
    // "the last one" would follow somebody else's withdrawal and report on it.
    const result = await waitForHotDelivery({
      txHash: TX_HASH,
      chainId: TON,
      poll: PATIENT,
      deps: deps({
        fetchTxOutcome: async () => receiptWith("11", "22"),
        getWithdrawalStatus: async () => "COMPLETED",
      }),
    });
    expect(result.nonce).toBe("11");
  });

  it("ignores the transaction outcome, so positions never shift", () => {
    // Callers index this array. A log line from a different outcome sneaking in at the front
    // would silently reassign a nonce to another withdrawal.
    const outcome = {
      transaction_outcome: { outcome: { logs: [`{"memo":"999"}`] } },
      ...receiptWith("11"),
    };
    expect(parseHotWithdrawalNonces(outcome)).toEqual(["11"]);
  });

  it("returns nothing for logs with no memo, and survives junk shapes", () => {
    expect(parseHotWithdrawalNonces({ receipts_outcome: [{ outcome: { logs: ["hello"] } }] })).toEqual([]);
    // A non-numeric memo is somebody else's memo, not a nonce.
    expect(parseHotWithdrawalNonces({ receipts_outcome: [{ outcome: { logs: [`{"memo":"WITHDRAW_TO:0x1"}`] } }] })).toEqual([]);
    expect(parseHotWithdrawalNonces({ receipts_outcome: [{ outcome: { logs: "not-an-array" } }] })).toEqual([]);
    expect(parseHotWithdrawalNonces({ receipts_outcome: [{}] })).toEqual([]);
    expect(parseHotWithdrawalNonces({})).toEqual([]);
    expect(parseHotWithdrawalNonces(null)).toEqual([]);
  });
});

describe("hotDeliveryStats", () => {
  it("derives a chain's budget from its measured p99, plus HOT's allowance", () => {
    // Optimism p99 = 23s upstream; the deadline is 3x that plus 12 minutes.
    expect(hotDeliveryStats("eth:10").p99).toBe(23_000 * 3 + 720_000);
    // Floors, so a fast chain is still not polled at sub-second cadence forever.
    expect(hotDeliveryStats("eth:10").p50).toBe(5_000);
    expect(hotDeliveryStats("eth:137").p50).toBe(410_000 * 0.15);
  });

  it("falls back to six hours for a chain with no measurement", () => {
    expect(hotDeliveryStats("eth:999999").p99).toBe(21_600_000 + 720_000);
  });

  it("has a measured budget for every hot-omni chain the registry actually carries", () => {
    const unmeasured = hotDeliveryStats("chain-that-does-not-exist").p99;
    const chains = new Set(
      Object.values(withdrawalRegistry)
        .filter((e) => e.bridgeRoute === "hot-omni")
        .map((e) => e.chainId)
    );
    expect(chains.size).toBeGreaterThan(0);
    for (const chainId of chains) {
      // The 6-hour default is the right answer for an UNKNOWN chain and the wrong one for a
      // curated route: it would quietly keep a tab polling all afternoon. This goes red the
      // moment block 4.4 curates Stellar, which is exactly when someone should look up its
      // p99 instead of inheriting the fallback.
      expect(hotDeliveryStats(chainId).p99, chainId).not.toBe(unmeasured);
    }
  });
});

describe("waitForHotDelivery — EVM prefers the indexer", () => {
  it("returns the indexer's hash for the matching nonce, 0x-prefixed for an explorer", async () => {
    const result = await waitForHotDelivery({
      txHash: TX_HASH,
      chainId: POLY,
      poll: PATIENT,
      deps: deps({
        indexerWithdrawals: async () => [
          { nonce: "999", hash: "deadbeef" },
          { nonce: NONCE, hash: "aabbccdd" },
        ],
      }),
    });
    // Matched on the nonce, not on position: the same tx can carry other withdrawals.
    expect(result).toEqual({ nonce: NONCE, destinationTxHash: "0xaabbccdd" });
  });

  it("keeps waiting while the indexer answers without the withdrawal", async () => {
    let calls = 0;
    const result = await waitForHotDelivery({
      txHash: TX_HASH,
      chainId: POLY,
      poll: PATIENT,
      deps: deps({
        indexerWithdrawals: async () => (++calls < 3 ? [] : [{ nonce: NONCE, hash: "0xfeed" }]),
      }),
    });
    expect(result.destinationTxHash).toBe("0xfeed");
    expect(calls).toBe(3);
  });

  it("does not read the contract's lagging hash while the indexer is answering", async () => {
    // The contract already has a hash; the indexer says nothing yet. Believing the contract
    // here would report a delivery the primary source has not seen.
    const promise = waitForHotDelivery({
      txHash: TX_HASH,
      chainId: POLY,
      poll: fast(),
      deps: deps({
        getWithdrawalStatus: async () => "aabbccdd",
        indexerWithdrawals: async () => [],
      }),
    });
    await expect(promise).rejects.toThrow(PollTimeoutError);
  });

  it("treats an empty-string hash as not delivered yet", async () => {
    const promise = waitForHotDelivery({
      txHash: TX_HASH,
      chainId: POLY,
      poll: fast(),
      deps: deps({ indexerWithdrawals: async () => [{ nonce: NONCE, hash: "" }] }),
    });
    await expect(promise).rejects.toThrow(PollTimeoutError);
  });

  it("falls back to the contract when the indexer's ANSWER is malformed, not just when the call is", async () => {
    // Found by cross-review. An indexer that resolves with a body this code cannot read is a
    // failed source, and must reach the contract exactly like a 503 does — the flag that
    // suppresses the contract on EVM may only be set once the answer has been read.
    for (const badAnswer of [
      undefined as unknown as ReadonlyArray<{ nonce: string; hash: string | null }>,
      [{ nonce: NONCE, hash: 12345 as unknown as string }],
    ]) {
      const result = await waitForHotDelivery({
        txHash: TX_HASH,
        chainId: POLY,
        poll: PATIENT,
        deps: deps({
          indexerWithdrawals: async () => badAnswer,
          getWithdrawalStatus: async () => "aabbccdd",
        }),
      });
      expect(result).toEqual({ nonce: NONCE, destinationTxHash: "0xaabbccdd" });
    }
  });

  it("falls back to the contract when the indexer FAILS, not when it is merely silent", async () => {
    const result = await waitForHotDelivery({
      txHash: TX_HASH,
      chainId: POLY,
      poll: PATIENT,
      deps: deps({
        indexerWithdrawals: async () => {
          throw new Error("indexer 503");
        },
        getWithdrawalStatus: async () => "aabbccdd",
      }),
    });
    // Our divergence from upstream: the contract, not HOT's private REST API.
    expect(result).toEqual({ nonce: NONCE, destinationTxHash: "0xaabbccdd" });
  });
});

// D-262: a delivered non-EVM withdrawal could not close, because the only source it was
// allowed to ask returns `null` forever. Measured with real money on Stellar (session 121),
// and reproduced here as the two chains' worth of behaviour that must not regress.
describe("waitForHotDelivery — non-EVM closes on the indexer (D-262)", () => {
  it("closes on the indexer's hash when the contract answers null forever", async () => {
    let statusCalls = 0;
    const result = await waitForHotDelivery({
      txHash: TX_HASH,
      chainId: STELLAR,
      poll: PATIENT,
      deps: deps({
        // Exactly what `get_withdrawal_hash` was measured doing 15 minutes after Horizon had
        // confirmed the credit: nothing at all, which this module reads as "still pending".
        getWithdrawalStatus: async () => {
          statusCalls++;
          return null;
        },
        indexerWithdrawals: async () => [{ nonce: NONCE, hash: STELLAR_HASH }],
      }),
    });
    // Unprefixed: `stellar.expert/explorer/public/tx/<hex>` wants it bare, and only `eth:`
    // chains get the 0x.
    expect(result).toEqual({ nonce: NONCE, destinationTxHash: STELLAR_HASH });
    // The contract is still consulted first — that is where CANCELED comes from.
    expect(statusCalls).toBeGreaterThan(0);
  });

  it("closes a TON delivery the same way", async () => {
    const result = await waitForHotDelivery({
      txHash: TX_HASH,
      chainId: TON,
      poll: PATIENT,
      deps: deps({
        getWithdrawalStatus: async () => null,
        indexerWithdrawals: async () => [
          { nonce: "999", hash: "deadbeef" },
          { nonce: NONCE, hash: TON_HASH },
        ],
      }),
    });
    expect(result).toEqual({ nonce: NONCE, destinationTxHash: TON_HASH });
  });

  it("keeps reading the contract when the indexer is silent, unlike EVM", async () => {
    // The additive half of D-262. On EVM an answering indexer with no row SUPPRESSES the
    // contract; doing that on non-EVM would trade one dead source for another, so here the
    // contract's own answer still closes the withdrawal.
    const result = await waitForHotDelivery({
      txHash: TX_HASH,
      chainId: STELLAR,
      poll: PATIENT,
      deps: deps({
        indexerWithdrawals: async () => [],
        getWithdrawalStatus: async () => "COMPLETED",
      }),
    });
    expect(result).toEqual({ nonce: NONCE, destinationTxHash: null });
  });

  it("keeps reading the contract when the indexer FAILS", async () => {
    const result = await waitForHotDelivery({
      txHash: TX_HASH,
      chainId: TON,
      poll: PATIENT,
      deps: deps({
        indexerWithdrawals: async () => {
          throw new Error("indexer 503");
        },
        getWithdrawalStatus: async () => "aabbccdd",
      }),
    });
    expect(result.destinationTxHash).toBe("aabbccdd");
  });

  it("never reports a cancellation as a delivery, whatever the indexer says", async () => {
    // The one contract answer that outranks everything. Checked before the indexer is asked,
    // so a stale indexer row cannot turn a cancelled withdrawal into a delivered one.
    const promise = waitForHotDelivery({
      txHash: TX_HASH,
      chainId: STELLAR,
      poll: PATIENT,
      deps: deps({
        getWithdrawalStatus: async () => "CANCELED",
        indexerWithdrawals: async () => [{ nonce: NONCE, hash: STELLAR_HASH }],
      }),
    });
    await expect(promise).rejects.toThrow(WithdrawDeliveryCancelledError);
  });
});

describe("waitForHotDelivery — the contract's own answers", () => {
  it("reads COMPLETED as delivered without a link, when no source has a hash", async () => {
    const result = await waitForHotDelivery({
      txHash: TX_HASH,
      chainId: TON,
      poll: PATIENT,
      deps: deps({ getWithdrawalStatus: async () => "COMPLETED" }),
    });
    // Delivered is delivered: a missing hash is a missing link, never a missing delivery.
    expect(result).toEqual({ nonce: NONCE, destinationTxHash: null });
  });

  it("returns a non-EVM hash unprefixed", async () => {
    const result = await waitForHotDelivery({
      txHash: TX_HASH,
      chainId: TON,
      poll: PATIENT,
      deps: deps({ getWithdrawalStatus: async () => "aabbccdd" }),
    });
    expect(result.destinationTxHash).toBe("aabbccdd");
  });

  it("still calls an unreadable status delivered, because null is the only pending answer", async () => {
    const result = await waitForHotDelivery({
      txHash: TX_HASH,
      chainId: TON,
      poll: PATIENT,
      deps: deps({ getWithdrawalStatus: async () => "not-hex-at-all" }),
    });
    expect(result).toEqual({ nonce: NONCE, destinationTxHash: null });
  });

  it("throws the cancellation immediately, past the retry counter", async () => {
    let statusCalls = 0;
    const promise = waitForHotDelivery({
      txHash: TX_HASH,
      chainId: POLY,
      poll: PATIENT,
      deps: deps({
        getWithdrawalStatus: async () => {
          statusCalls++;
          return "CANCELED";
        },
      }),
    });
    await expect(promise).rejects.toThrow(WithdrawDeliveryCancelledError);
    // Retrying a definite answer four more times only delays telling the user.
    expect(statusCalls).toBe(1);
    await promise.catch((e: WithdrawDeliveryCancelledError) => {
      expect(e.fundsState).toBe("left-balance");
      expect(e.nonce).toBe(NONCE);
      expect(e.txHash).toBe(TX_HASH);
    });
  });
});

describe("waitForHotDelivery — the nonce", () => {
  it("reads the settlement receipts once and reuses the nonce", async () => {
    const fetchTxOutcome = vi.fn<NonNullable<HotDeliveryDeps["fetchTxOutcome"]>>(async () =>
      receiptWith(NONCE)
    );
    let calls = 0;
    await waitForHotDelivery({
      txHash: TX_HASH,
      chainId: TON,
      poll: PATIENT,
      deps: deps({
        fetchTxOutcome,
        getWithdrawalStatus: async () => (++calls < 3 ? null : "COMPLETED"),
      }),
    });
    // The logs of a finished transaction do not change; re-reading them every tick would
    // spend the whole budget on the one call that cannot say anything new.
    expect(fetchTxOutcome).toHaveBeenCalledTimes(1);
    expect(fetchTxOutcome.mock.calls[0][1]).toBe("intents.near");
  });

  it("tolerates a nonce that is not visible yet, then picks it up", async () => {
    let calls = 0;
    const result = await waitForHotDelivery({
      txHash: TX_HASH,
      chainId: TON,
      poll: PATIENT,
      deps: deps({
        // EXECUTED_OPTIMISTIC can answer before every receipt is visible.
        fetchTxOutcome: async () => (++calls < 3 ? {} : receiptWith(NONCE)),
        getWithdrawalStatus: async () => "COMPLETED",
      }),
    });
    expect(result.nonce).toBe(NONCE);
  });

  it("gives up after five consecutive failures, like the SDK's watcher", async () => {
    let calls = 0;
    const promise = waitForHotDelivery({
      txHash: TX_HASH,
      chainId: TON,
      poll: PATIENT,
      deps: deps({
        fetchTxOutcome: async () => {
          calls++;
          return {};
        },
      }),
    });
    await expect(promise).rejects.toThrow(/no HOT withdrawal nonce/);
    expect(calls).toBe(5);
  });

  it("resets the failure count after any tick that answers", async () => {
    let calls = 0;
    const result = await waitForHotDelivery({
      txHash: TX_HASH,
      chainId: TON,
      poll: PATIENT,
      deps: deps({
        // Four throws, one plain "still pending", then four more throws. Nine failures, but
        // never five in a row: a flaky RPC must not accumulate its way to a false
        // "unconfirmed" across an hour of otherwise healthy polling.
        getWithdrawalStatus: async () => {
          calls++;
          if (calls === 5) return null;
          if (calls > 9) return "COMPLETED";
          throw new Error("RPC 502");
        },
      }),
    });
    expect(result.nonce).toBe(NONCE);
    expect(calls).toBe(10);
  });

  it("stops when the caller aborts", async () => {
    const controller = new AbortController();
    const promise = waitForHotDelivery({
      txHash: TX_HASH,
      chainId: POLY,
      poll: PATIENT,
      signal: controller.signal,
      deps: deps(),
    });
    controller.abort(new Error("user left the page"));
    await expect(promise).rejects.toThrow(/user left the page/);
  });
});
