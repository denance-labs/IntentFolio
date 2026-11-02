import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { IntentSettlementError, PollTimeoutError } from "@defuse-protocol/internal-utils";
import type { MultiPayload, VaultSigner } from "@/features/vault/lib/vault-signer";
import { buildWithdrawSignRequest } from "./withdraw-envelope";
import { submitWithdraw, type NearDestinationProbe, type WithdrawPublisher } from "./withdraw-submit";
import {
  waitForWithdrawDelivery,
  waitForWithdrawSettlement,
  type DeliveryWaiter,
  type SettlementWaiter,
} from "./withdraw-poll";
import {
  WithdrawDeliveryCancelledError,
  WithdrawDeliveryUnconfirmedError,
  WithdrawSettlementFailedError,
  WithdrawSettlementUnconfirmedError,
} from "./withdraw-errors";
import type { HotDeliveryDeps } from "./hot-delivery";
import { withdrawalDestinations } from "./withdrawal-registry";

// The token's own chain: every call here predates D-384 and means the native route.
const ownChain = (tokenId: string): string =>
  withdrawalDestinations(tokenId)[0] ?? "near:mainnet";

// Settlement and delivery, with both SDK waiters injected. The line these tests defend is
// the one between them: before settlement the balance is intact, after it the funds are
// out. Every timeout assertion below is really an assertion about which side of that line
// the user is told they are on.
//
// No network: `fetch` throws, and every waiter is a fake.

const SIGNER_ID = "alice.near";
const DEADLINE_SECS = 1_800_000_000;
const NONCE = new Uint8Array(32).fill(7);

const USDC_ARB = "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";
const USDC_ARB_CONTRACT = "arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";
const USDT_NEAR = "nep141:usdt.tether-token.near";
const USDT_TON = "nep245:v2_1.omni.hot.tg:1117_3tsdfyziyc7EJbP2aULWSKU4toBaAcN4FdTgfm5W1mC4ouR";
const USDC_POLYGON = "nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L";

/** A settlement receipt carrying one HOT withdrawal nonce, as the refuel burn writes it. */
const hotReceipt = (nonce: string) => ({
  receipts_outcome: [{ outcome: { logs: [`EVENT_JSON:{"memo":"${nonce}"}`] } }],
});

/** Every HOT seam stubbed. Anything a test does not name must not reach the network. */
const hotDeps = (over: Partial<HotDeliveryDeps> = {}): HotDeliveryDeps => ({
  fetchTxOutcome: async () => hotReceipt(HOT_NONCE),
  getWithdrawalStatus: async () => null,
  indexerWithdrawals: async () => [],
  ...over,
});

const HOT_NONCE = "77";

const EVM_ADDRESS = "0xc8b1e10d011aceed84f4cdba66ca175bd6552a36";
const NEAR_ADDRESS = "pablofork.near";
const INTENT_HASH = "0xIntentHash";
const TX_HASH = "TxHash123";

/** A waiter that never resolves on its own, so only the deadline can end it. */
const hangs =
  <T,>(): ((p: { signal?: AbortSignal }) => Promise<T>) =>
  ({ signal }) =>
    new Promise<T>((_resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener("abort", () => reject(signal.reason));
    });

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
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

describe("waitForWithdrawSettlement", () => {
  it("returns the NEAR tx and reports the hash as soon as it is known", async () => {
    const onTxHash = vi.fn();
    const waiter: SettlementWaiter = async ({ intentHash, onTxHashKnown }) => {
      onTxHashKnown?.(TX_HASH);
      return { txHash: TX_HASH, intentHash };
    };

    const settlement = await waitForWithdrawSettlement({
      intentHash: INTENT_HASH,
      waitForSettlement: waiter,
      onTxHash,
    });

    expect(settlement).toEqual({ txHash: TX_HASH, intentHash: INTENT_HASH });
    // Emitted early on purpose: the runs where this hash matters most never finish.
    expect(onTxHash).toHaveBeenCalledWith(TX_HASH);
  });

  it("reports a relay-declared failure as definitive, with the balance untouched", async () => {
    const cause = new IntentSettlementError({
      status: "NOT_FOUND_OR_NOT_VALID",
      intent_hash: INTENT_HASH,
      status_details: "FAILED",
    });
    const promise = waitForWithdrawSettlement({
      intentHash: INTENT_HASH,
      waitForSettlement: async () => {
        throw cause;
      },
    });

    await expect(promise).rejects.toThrow(WithdrawSettlementFailedError);
    await promise.catch((e: WithdrawSettlementFailedError) => {
      // The Verifier refused it, so nothing executed and the funds never moved.
      expect(e.fundsState).toBe("untouched");
      expect(e.cause).toBe(cause);
    });
  });

  it("reports our own deadline as UNCONFIRMED, not as a failure", async () => {
    const promise = waitForWithdrawSettlement({
      intentHash: INTENT_HASH,
      timeoutMs: 5,
      waitForSettlement: hangs<{ txHash: string; intentHash: string }>(),
    });

    await expect(promise).rejects.toThrow(WithdrawSettlementUnconfirmedError);
    await promise.catch((e: WithdrawSettlementUnconfirmedError) => {
      // A published intent we stopped watching is not a published intent that failed.
      expect(e.fundsState).toBe("unknown");
      expect(e.intentHash).toBe(INTENT_HASH);
      expect(e.message).toMatch(/no settlement within 5ms/);
    });
  });

  it("reports the SDK's own poll timeout the same way", async () => {
    const promise = waitForWithdrawSettlement({
      intentHash: INTENT_HASH,
      waitForSettlement: async () => {
        throw new PollTimeoutError(356_000, 356_000);
      },
    });
    await expect(promise).rejects.toThrow(WithdrawSettlementUnconfirmedError);
  });

  it("reports a transport error as unknown rather than swallowing it", async () => {
    const promise = waitForWithdrawSettlement({
      intentHash: INTENT_HASH,
      waitForSettlement: async () => {
        throw new Error("ECONNRESET");
      },
    });
    await promise.catch((e: WithdrawSettlementUnconfirmedError) => {
      expect(e.fundsState).toBe("unknown");
      expect(e.message).toContain("ECONNRESET");
    });
    await expect(promise).rejects.toThrow(WithdrawSettlementUnconfirmedError);
  });

  it("stops when the caller aborts, and still calls it unconfirmed", async () => {
    const controller = new AbortController();
    const promise = waitForWithdrawSettlement({
      intentHash: INTENT_HASH,
      signal: controller.signal,
      waitForSettlement: hangs<{ txHash: string; intentHash: string }>(),
    });
    controller.abort(new Error("user left the page"));
    await expect(promise).rejects.toThrow(WithdrawSettlementUnconfirmedError);
  });
});

describe("waitForWithdrawDelivery — omft crosses the bridge", () => {
  it("returns the destination tx, keyed on the registry's own contract id", async () => {
    const waiter = vi.fn<DeliveryWaiter>(async () => ({
      destinationTxHash: "0xArbTx",
      chain: "eth:42161",
    }));

    const delivery = await waitForWithdrawDelivery({
      tokenId: USDC_ARB,
      chainId: ownChain(USDC_ARB),
      route: "omft",
      txHash: TX_HASH,
      waitForDelivery: waiter,
    });

    expect(delivery).toEqual({ kind: "bridge", destinationTxHash: "0xArbTx", chain: "eth:42161" });
    // The bridge matches on `nep141:${near_token_id}`; anything else silently never matches
    // and the withdrawal would look stuck forever.
    expect(waiter.mock.calls[0][0].withdrawalCriteria).toEqual({
      assetId: `nep141:${USDC_ARB_CONTRACT}`,
    });
    expect(waiter.mock.calls[0][0].txHash).toBe(TX_HASH);
  });

  it("calls every post-settlement failure LEFT-BALANCE, because the money is already out", async () => {
    const promise = waitForWithdrawDelivery({
      tokenId: USDC_ARB,
      chainId: ownChain(USDC_ARB),
      route: "omft",
      txHash: TX_HASH,
      timeoutMs: 5,
      waitForDelivery: hangs<{ destinationTxHash: string; chain: string }>(),
    });

    await expect(promise).rejects.toThrow(WithdrawDeliveryUnconfirmedError);
    await promise.catch((e: WithdrawDeliveryUnconfirmedError) => {
      expect(e.fundsState).toBe("left-balance");
      expect(e.txHash).toBe(TX_HASH);
      expect(e.message).toMatch(/no delivery within 5ms/);
      // Never a loss claim: the bridge may still deliver.
      expect(e.message).toMatch(/may still arrive/i);
    });
  });

  it("treats a bridge error the same way — there is no safe failure after settlement", async () => {
    const promise = waitForWithdrawDelivery({
      tokenId: USDC_ARB,
      chainId: ownChain(USDC_ARB),
      route: "omft",
      txHash: TX_HASH,
      waitForDelivery: async () => {
        throw new Error("POA bridge didn't return withdrawal matching criteria");
      },
    });
    await promise.catch((e: WithdrawDeliveryUnconfirmedError) => {
      expect(e.fundsState).toBe("left-balance");
    });
    await expect(promise).rejects.toThrow(WithdrawDeliveryUnconfirmedError);
  });
});

describe("waitForWithdrawDelivery — near-native has no second wait", () => {
  it("treats an omft token sent to NEAR as near-native too (D-384)", async () => {
    const waiter = vi.fn<DeliveryWaiter>();
    const delivery = await waitForWithdrawDelivery({
      tokenId: "nep141:sol.omft.near",
      chainId: "near:mainnet",
      route: "near-native",
      txHash: TX_HASH,
      waitForDelivery: waiter,
    });
    expect(delivery).toEqual({ kind: "near-settlement" });
    expect(waiter).not.toHaveBeenCalled();
  });

  it("returns immediately without touching the bridge", async () => {
    const waiter = vi.fn<DeliveryWaiter>();
    const delivery = await waitForWithdrawDelivery({
      tokenId: USDT_NEAR,
      chainId: ownChain(USDT_NEAR),
      route: "near-native",
      txHash: TX_HASH,
      waitForDelivery: waiter,
    });

    // The settlement IS the delivery: the funds never leave NEAR, so there is no bridge to
    // ask and a pending-delivery state would be a lie.
    expect(delivery).toEqual({ kind: "near-settlement" });
    expect(waiter).not.toHaveBeenCalled();
  });
});

describe("waitForWithdrawDelivery — hot-omni crosses HOT's own bridge", () => {
  it("returns the third variant, never the PoA one, and never touches the PoA waiter", async () => {
    const poa = vi.fn<DeliveryWaiter>();
    const delivery = await waitForWithdrawDelivery({
      tokenId: USDC_POLYGON,
      chainId: ownChain(USDC_POLYGON),
      route: "hot-omni",
      txHash: TX_HASH,
      waitForDelivery: poa,
      hotDelivery: hotDeps({
        indexerWithdrawals: async () => [{ nonce: HOT_NONCE, hash: "aabbcc" }],
      }),
    });

    // `hot-bridge` and not `bridge`: only this variant may carry a null hash, and callers
    // branch on the kind to know whether the explorer link is guaranteed.
    expect(delivery).toEqual({
      kind: "hot-bridge",
      destinationTxHash: "0xaabbcc",
      chain: "eth:137",
      nonce: HOT_NONCE,
    });
    expect(poa).not.toHaveBeenCalled();
  });

  it("reports a delivery HOT confirms but cannot name, rather than calling it undelivered", async () => {
    const delivery = await waitForWithdrawDelivery({
      tokenId: USDT_TON,
      chainId: ownChain(USDT_TON),
      route: "hot-omni",
      txHash: TX_HASH,
      hotDelivery: hotDeps({ getWithdrawalStatus: async () => "COMPLETED" }),
    });
    expect(delivery).toEqual({
      kind: "hot-bridge",
      destinationTxHash: null,
      chain: "ton:mainnet",
      nonce: HOT_NONCE,
    });
  });

  it("passes a cancellation through instead of downgrading it to 'not confirmed'", async () => {
    const promise = waitForWithdrawDelivery({
      tokenId: USDC_POLYGON,
      chainId: ownChain(USDC_POLYGON),
      route: "hot-omni",
      txHash: TX_HASH,
      hotDelivery: hotDeps({ getWithdrawalStatus: async () => "CANCELED" }),
    });

    // A definite answer must not be re-wrapped as a maybe — but it is still `left-balance`,
    // because the funds left the General Balance at settlement either way.
    await expect(promise).rejects.toThrow(WithdrawDeliveryCancelledError);
    await promise.catch((e: WithdrawDeliveryCancelledError) => {
      expect(e.fundsState).toBe("left-balance");
      expect(e.nonce).toBe(HOT_NONCE);
    });
  });

  it("calls a HOT deadline LEFT-BALANCE too, naming the NEP-245 contract", async () => {
    const promise = waitForWithdrawDelivery({
      tokenId: USDC_POLYGON,
      chainId: ownChain(USDC_POLYGON),
      route: "hot-omni",
      txHash: TX_HASH,
      timeoutMs: 5,
      // Never answers: only the deadline can end this.
      hotDelivery: hotDeps({ getWithdrawalStatus: async () => null }),
    });

    await expect(promise).rejects.toThrow(WithdrawDeliveryUnconfirmedError);
    await promise.catch((e: WithdrawDeliveryUnconfirmedError) => {
      expect(e.fundsState).toBe("left-balance");
      expect(e.assetId).toBe("nep141:v2_1.omni.hot.tg");
      expect(e.message).toMatch(/may still arrive/i);
    });
  });
});

describe("waitForWithdrawDelivery — guards", () => {
  it("throws when the caller's route disagrees with the registry", async () => {
    // Left unguarded, a stale "near-native" would report a bridged withdrawal as delivered
    // the moment it settled on NEAR.
    await expect(
      waitForWithdrawDelivery({ tokenId: USDC_ARB, chainId: ownChain(USDC_ARB), route: "near-native", txHash: TX_HASH })
    ).rejects.toThrow(/route mismatch/i);
  });

  it("throws for a token with no withdrawal route", async () => {
    await expect(
      waitForWithdrawDelivery({ tokenId: "nep141:not-a-token.near", chainId: ownChain("nep141:not-a-token.near"), route: "omft", txHash: TX_HASH })
    ).rejects.toThrow(/no withdrawal route/i);
  });
});

describe("the whole 5.2 chain, per route", () => {
  const FAKE_PAYLOAD = { standard: "nep413" } as unknown as MultiPayload;

  const signer: VaultSigner = { scheme: "nep413", signEnvelope: async () => FAKE_PAYLOAD };
  const publish: WithdrawPublisher = async () => ({ status: "OK", intent_hash: INTENT_HASH });
  const probe: NearDestinationProbe = {
    accountExists: async () => true,
    storageBalanceOf: async () => ({ total: "1250000000000000000000" }),
  };
  const settle: SettlementWaiter = async ({ intentHash }) => ({ txHash: TX_HASH, intentHash });

  it("omft: sign → publish → settle → bridge delivery", async () => {
    const request = buildWithdrawSignRequest({
      signerId: SIGNER_ID,
      tokenId: USDC_ARB,
      chainId: "eth:42161",
      qty: 1.5,
      heldRaw: BigInt(10) ** BigInt(30), // ample — the cap has its own tests (D-303)
      destinationAddress: EVM_ADDRESS,
      deadlineSecs: DEADLINE_SECS,
      nonce: NONCE,
    });

    const { intentHash, route } = await submitWithdraw({
      request,
      tokenId: USDC_ARB,
      chainId: ownChain(USDC_ARB),
      destinationAddress: EVM_ADDRESS,
      signer,
      publish,
      probe,
    });
    const settlement = await waitForWithdrawSettlement({
      intentHash,
      waitForSettlement: settle,
    });
    const delivery = await waitForWithdrawDelivery({
      tokenId: USDC_ARB,
      chainId: ownChain(USDC_ARB),
      route,
      txHash: settlement.txHash,
      waitForDelivery: async () => ({ destinationTxHash: "0xArbTx", chain: "eth:42161" }),
    });

    expect(request.amount).toBe("1500000");
    expect(settlement.txHash).toBe(TX_HASH);
    expect(delivery).toEqual({ kind: "bridge", destinationTxHash: "0xArbTx", chain: "eth:42161" });
  });

  it("near-native: sign → publish → settle, and that is the end of it", async () => {
    const request = buildWithdrawSignRequest({
      signerId: SIGNER_ID,
      tokenId: USDT_NEAR,
      chainId: "near:mainnet",
      qty: 1.5,
      heldRaw: BigInt(10) ** BigInt(30), // ample — the cap has its own tests (D-303)
      destinationAddress: NEAR_ADDRESS,
      deadlineSecs: DEADLINE_SECS,
      nonce: NONCE,
    });

    const { intentHash, route } = await submitWithdraw({
      request,
      tokenId: USDT_NEAR,
      chainId: ownChain(USDT_NEAR),
      destinationAddress: NEAR_ADDRESS,
      signer,
      publish,
      probe,
    });
    const settlement = await waitForWithdrawSettlement({
      intentHash,
      waitForSettlement: settle,
    });
    const delivery = await waitForWithdrawDelivery({
      tokenId: USDT_NEAR,
      chainId: ownChain(USDT_NEAR),
      route,
      txHash: settlement.txHash,
      waitForDelivery: vi.fn<DeliveryWaiter>(),
    });

    expect(route).toBe("near-native");
    expect(delivery).toEqual({ kind: "near-settlement" });
  });
});
