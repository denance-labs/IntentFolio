// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AmountExceedsBalanceError } from "@/features/vault/lib/base-units";
import { IntentSettlementError } from "@defuse-protocol/internal-utils";
import type { MultiPayload, VaultSigner } from "@/features/vault/lib/vault-signer";
import {
  HELD_READ_BUDGET_MS,
  HeldReadFailedError,
  HeldReadTimeoutError,
  runRealWithdraw,
  RealWithdrawUnconfirmedError,
  type RealWithdrawStage,
  type RunRealWithdrawParams,
} from "./run-real-withdraw";
import {
  listWithdrawRecords,
  listUnresolvedWithdrawRecords,
  type WithdrawRescueRecord,
} from "./withdraw-rescue-store";
import { nonceToBase64 } from "./withdraw-publication-check";
import {
  WithdrawDestinationUnusableError,
  WithdrawRelayRejectedError,
  WithdrawSettlementFailedError,
} from "./withdraw-errors";
import type { DeliveryWaiter, SettlementWaiter } from "./withdraw-poll";
import type { NearDestinationProbe, WithdrawPublisher } from "./withdraw-submit";
import type { HotFeeDetail } from "./hot-fee";

// End to end with the wallet, the relay and the bridge faked. What these tests defend is not
// the happy path — it is the honesty of everything else:
//
//   - `published-unconfirmed` is NOT a failure, and every non-`untouched` outcome must reach
//     it (settlement timed out, delivery timed out, publish outcome unknown);
//   - only `fundsState: "untouched"` — the field 5.2 fixed, consumed here, never re-derived —
//     may resolve a rescue record as failed;
//   - the rescue record is written BEFORE the publish, so the window between "sent the
//     request" and "got an answer" leaves a trace.
//
// No network: `fetch` throws, so an un-injected call fails the test instead of hitting
// mainnet.

const SIGNER_ID = "alice.near";
const DEADLINE_SECS = 1_800_000_000;
const NONCE = new Uint8Array(32).fill(7);

const USDC_ARB = "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near"; // omft
const USDT_NEAR = "nep141:usdt.tether-token.near"; // near-native
const USDT_TON = "nep245:v2_1.omni.hot.tg:1117_3tsdfyziyc7EJbP2aULWSKU4toBaAcN4FdTgfm5W1mC4ouR"; // hot-omni

const EVM_ADDRESS = "0xc8b1e10d011aceed84f4cdba66ca175bd6552a36";
const NEAR_ADDRESS = "pablofork.near";
const INTENT_HASH = "0xIntentHash";
const TX_HASH = "TxHash123";

const FAKE_PAYLOAD = { standard: "nep413" } as unknown as MultiPayload;

/** A waiter that never resolves on its own, so only a deadline can end it. */
const hangs =
  <T,>(): ((p: { signal?: AbortSignal }) => Promise<T>) =>
  ({ signal }) =>
    new Promise<T>((_resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener("abort", () => reject(signal.reason));
    });

let signer: VaultSigner & { signEnvelope: ReturnType<typeof vi.fn> };
let publish: ReturnType<typeof vi.fn>;
let probe: NearDestinationProbe;
let settle: ReturnType<typeof vi.fn>;
let deliver: ReturnType<typeof vi.fn>;
let stages: RealWithdrawStage[];

beforeEach(() => {
  window.localStorage.clear();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("no test may touch the network");
    })
  );

  signer = { scheme: "nep413", signEnvelope: vi.fn(async () => FAKE_PAYLOAD) };
  publish = vi.fn(async () => ({ status: "OK", intent_hash: INTENT_HASH }));
  probe = {
    accountExists: async () => true,
    storageBalanceOf: async () => ({ total: "1250000000000000000000" }),
  };
  settle = vi.fn(async ({ intentHash }: { intentHash: string }) => ({
    txHash: TX_HASH,
    intentHash,
  }));
  deliver = vi.fn(async () => ({ destinationTxHash: "0xArbTx", chain: "eth:42161" }));
  stages = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function run(over: Partial<RunRealWithdrawParams> = {}) {
  return runRealWithdraw({
    accountId: SIGNER_ID,
    tokenId: USDC_ARB,
    chainId: "eth:42161",
    qty: 1.5,
    destinationAddress: EVM_ADDRESS,
    signer,
    publish: publish as unknown as WithdrawPublisher,
    probe,
    waitForSettlement: settle as unknown as SettlementWaiter,
    waitForDelivery: deliver as unknown as DeliveryWaiter,
    envelope: { deadlineSecs: DEADLINE_SECS, nonce: NONCE },
    onStage: (s) => stages.push(s),
    // Ample: the cap has its own tests (D-303); nothing here may reach the network.
    readHeld: async () => BigInt(10) ** BigInt(30),
    ...over,
  });
}

const nearNative = {
  tokenId: USDT_NEAR,
  chainId: "near:mainnet",
  destinationAddress: NEAR_ADDRESS,
} as const;

function onlyRecord(): WithdrawRescueRecord {
  const records = listWithdrawRecords();
  expect(records).toHaveLength(1);
  return records[0];
}

describe("runRealWithdraw — omft, the route that crosses the bridge", () => {
  it("walks every stage in order and reports what was delivered", async () => {
    const result = await run();

    expect(stages).toEqual([
      "preparing",
      "signing",
      "publishing",
      "awaiting-settlement",
      "awaiting-delivery",
      "delivered",
    ]);
    expect(result).toMatchObject({
      intentHash: INTENT_HASH,
      txHash: TX_HASH,
      route: "omft",
      amount: "1500000", // 1.5 USDC at 6 decimals, no float drift
      delivery: { kind: "bridge", destinationTxHash: "0xArbTx", chain: "eth:42161" },
    });
    expect(signer.signEnvelope).toHaveBeenCalledTimes(1);
  });

  // 028-7: My Account hides the chain's burn behind the tracked row by this hash; known only at
  // delivery, the burn showed as a second withdrawal while the bridge delivered.
  it("hands the settlement hash over at settlement, before the bridge delivers", async () => {
    const seen: Array<{ txHash: string; stagesSoFar: string[] }> = [];
    await run({ onSettled: (txHash) => seen.push({ txHash, stagesSoFar: [...stages] }) });
    expect(seen).toEqual([{ txHash: TX_HASH, stagesSoFar: ["preparing", "signing", "publishing", "awaiting-settlement"] }]);
  });

  it("resolves the rescue record only once delivery is observed", async () => {
    const result = await run();
    const record = onlyRecord();

    expect(record).toMatchObject({
      id: result.recordId,
      status: "delivered",
      intentHash: INTENT_HASH,
      txHash: TX_HASH,
      destinationTxHash: "0xArbTx",
      tokenId: USDC_ARB,
      amount: "1500000",
      destinationAddress: EVM_ADDRESS,
    });
    expect(listUnresolvedWithdrawRecords()).toEqual([]);
  });

  // D-463: what lets a reload ask intents.near whether the publish ever ran.
  it("keeps the signed nonce and the intent deadline on the record", async () => {
    await run();
    expect(onlyRecord()).toMatchObject({
      nonce: nonceToBase64(NONCE),
      deadline: DEADLINE_SECS * 1000,
    });
    // The nonce kept is the one inside what was signed, not a copy of the injected value.
    const [request] = signer.signEnvelope.mock.calls[0];
    expect(JSON.parse(request.erc191Message).nonce).toBe(onlyRecord().nonce);
  });
});

describe("runRealWithdraw — near-native has no bridge to wait for", () => {
  it("skips awaiting-delivery instead of showing a spinner for an event that never fires", async () => {
    const result = await run({ ...nearNative, qty: 1.5 });

    expect(stages).toEqual([
      "preparing",
      "signing",
      "publishing",
      "awaiting-settlement",
      "delivered",
    ]);
    expect(result.delivery).toEqual({ kind: "near-settlement" });
    expect(result.route).toBe("near-native");
    expect(deliver).not.toHaveBeenCalled();
    expect(onlyRecord()).toMatchObject({ status: "delivered", route: "near-native" });
  });
});

// D-384: the same omft token sent to a NEAR account. The chain has to reach the submit AND the
// poll: without it the poll resolves the bridge route, calls it a mismatch after the settlement,
// and a withdrawal that arrived is reported as unconfirmed.
describe("runRealWithdraw — an omft token to NEAR (D-384)", () => {
  const SOL = "nep141:sol.omft.near";
  it("runs the near-native route end to end, with no bridge wait", async () => {
    const result = await run({
      tokenId: SOL,
      chainId: "near:mainnet",
      destinationAddress: NEAR_ADDRESS,
    });

    expect(stages).toEqual([
      "preparing",
      "signing",
      "publishing",
      "awaiting-settlement",
      "delivered",
    ]);
    expect(result.route).toBe("near-native");
    expect(result.delivery).toEqual({ kind: "near-settlement" });
    expect(deliver).not.toHaveBeenCalled();
    expect(onlyRecord()).toMatchObject({
      status: "delivered",
      route: "near-native",
      chainId: "near:mainnet",
      tokenId: SOL,
    });
  });
});

describe("the D-190 moment — when the record is written", () => {
  it("exists at the publish and did NOT exist at the signature", async () => {
    const atSignature: WithdrawRescueRecord[] = [];
    const atPublish: WithdrawRescueRecord[] = [];
    signer = {
      scheme: "nep413",
      signEnvelope: vi.fn(async () => {
        atSignature.push(...listWithdrawRecords());
        return FAKE_PAYLOAD;
      }),
    };
    publish = vi.fn(async () => {
      atPublish.push(...listWithdrawRecords());
      return { status: "OK", intent_hash: INTENT_HASH };
    });

    await run();

    // Not before signing (the Allocate moment): a cancelled wallet prompt would otherwise
    // file a record for a withdrawal that never existed.
    expect(atSignature).toEqual([]);
    // But before publishing: the request can go out and the answer never come back.
    expect(atPublish).toHaveLength(1);
    expect(atPublish[0]).toMatchObject({ status: "publishing", amount: "1500000" });
    expect(atPublish[0].intentHash).toBeUndefined();
  });

  // Block 5.4 needs the id BEFORE the end: the in-flight row the user is watching is keyed
  // on it, so that a reload mid-flight re-hydrates the same row from the worklist instead of
  // adding a second one for the same withdrawal.
  it("hands the record id to the caller the instant it exists, before the publish", async () => {
    const seen: Array<{ recordId: string; publishedYet: boolean }> = [];
    let publishedYet = false;
    publish = vi.fn(async () => {
      publishedYet = true;
      return { status: "OK", intent_hash: INTENT_HASH };
    });

    const result = await run({
      onRecordId: (recordId) => seen.push({ recordId, publishedYet }),
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].publishedYet).toBe(false);
    // The same id the run reports at the end, and the same one the store holds.
    expect(seen[0].recordId).toBe(result.recordId);
    expect(onlyRecord().id).toBe(result.recordId);
  });

  it("does not publish at all when the record cannot be persisted", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });

    await expect(run()).rejects.toThrow(/QuotaExceededError/);

    // The signature is burnt — free, nothing moved — and that is the deliberate trade: a
    // withdrawal we could not record is worse than one signature thrown away.
    expect(signer.signEnvelope).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
  });
});

describe("published-unconfirmed — the state that must never read as a failure", () => {
  it("settled, delivery not observed: LEFT-BALANCE, and the copy says it may still arrive", async () => {
    deliver = vi.fn(hangs<{ destinationTxHash: string; chain: string }>());

    const error = await run({ timeouts: { deliveryMs: 5 } }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RealWithdrawUnconfirmedError);
    const unconfirmed = error as RealWithdrawUnconfirmedError;
    // The funds already left the balance: the copy may not promise arrival and may not
    // report a loss either.
    expect(unconfirmed.fundsState).toBe("left-balance");
    expect(unconfirmed.message).toMatch(/may still arrive/i);
    expect(unconfirmed.message).not.toMatch(/\bfailed\b|\blost\b|did not (leave|go out|arrive)/i);
    expect(unconfirmed.intentHash).toBe(INTENT_HASH);
    expect(unconfirmed.txHash).toBe(TX_HASH);

    expect(stages).toEqual([
      "preparing",
      "signing",
      "publishing",
      "awaiting-settlement",
      "awaiting-delivery",
      "published-unconfirmed",
    ]);
    expect(stages).not.toContain("delivered");

    // Unresolved, with the settlement tx to follow: this is the recoverable worklist.
    const record = onlyRecord();
    expect(record.status).toBe("settled");
    expect(record.txHash).toBe(TX_HASH);
    expect(listUnresolvedWithdrawRecords().map((r) => r.id)).toEqual([record.id]);
    expect(unconfirmed.recordId).toBe(record.id);
  });

  it("published, settlement not observed: UNKNOWN, and the intent hash survives", async () => {
    settle = vi.fn(hangs<{ txHash: string; intentHash: string }>());

    const error = await run({ timeouts: { settlementMs: 5 } }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RealWithdrawUnconfirmedError);
    const unconfirmed = error as RealWithdrawUnconfirmedError;
    expect(unconfirmed.fundsState).toBe("unknown");
    expect(unconfirmed.intentHash).toBe(INTENT_HASH);
    expect(unconfirmed.txHash).toBeNull();
    // Our deadline bounds what we REPORT. It cancels nothing on the relay's side, so the
    // wording may not suggest the withdrawal did not go out.
    expect(unconfirmed.message).toMatch(/published but not confirmed settled/i);
    expect(unconfirmed.message).not.toMatch(/\bfailed\b|\brejected\b/i);

    expect(stages.at(-1)).toBe("published-unconfirmed");
    expect(stages).not.toContain("awaiting-delivery");

    const record = onlyRecord();
    expect(record.status).toBe("published");
    expect(record.intentHash).toBe(INTENT_HASH);
    expect(listUnresolvedWithdrawRecords()).toHaveLength(1);
  });

  it("keeps a tx hash learned mid-wait, without upgrading the record to settled", async () => {
    // `onTxHashKnown` fires before the settlement is confirmed. The hash is worth keeping —
    // it is what the operator follows — but it is not evidence the funds left the balance.
    settle = vi.fn(
      ({ onTxHashKnown, signal }: { onTxHashKnown?: (h: string) => void; signal?: AbortSignal }) => {
        onTxHashKnown?.(TX_HASH);
        return hangs<{ txHash: string; intentHash: string }>()({ signal });
      }
    );

    const error = await run({ timeouts: { settlementMs: 5 } }).catch((e: unknown) => e);

    const record = onlyRecord();
    expect(record.txHash).toBe(TX_HASH);
    expect(record.status).toBe("published"); // NOT "settled"
    expect((error as RealWithdrawUnconfirmedError).txHash).toBe(TX_HASH);
    expect((error as RealWithdrawUnconfirmedError).fundsState).toBe("unknown");
    expect(listUnresolvedWithdrawRecords()).toHaveLength(1);
  });

  it("publish outcome never learned: UNKNOWN, and the record still exists to prove it", async () => {
    // The exact window D-190 exists for — the request went out, the answer never came back.
    publish = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });

    const error = await run().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RealWithdrawUnconfirmedError);
    const unconfirmed = error as RealWithdrawUnconfirmedError;
    expect(unconfirmed.fundsState).toBe("unknown");
    expect(unconfirmed.intentHash).toBeNull();
    expect(unconfirmed.message).toMatch(/could not confirm whether the withdrawal was published/i);

    expect(stages.at(-1)).toBe("published-unconfirmed");

    const record = onlyRecord();
    expect(record.status).toBe("publishing"); // never resolved: it may be in flight
    expect(record.error).toMatch(/ECONNRESET/);
    expect(listUnresolvedWithdrawRecords()).toHaveLength(1);
  });

  it("an unrecognisable relay answer is unknown, never a rejection", async () => {
    // A payload we cannot parse is not a payload we may call rejected — telling the user
    // their balance is intact is a claim, and this path has no evidence for it.
    publish = vi.fn(async () => ({ ok: true }));

    const error = await run().catch((e: unknown) => e);

    expect((error as RealWithdrawUnconfirmedError).fundsState).toBe("unknown");
    expect(stages.at(-1)).toBe("published-unconfirmed");
    expect(listUnresolvedWithdrawRecords()).toHaveLength(1);
  });
});

describe("the only outcomes that may be reported as a plain failure", () => {
  it("a relay rejection: untouched, resolved, and NOT published-unconfirmed", async () => {
    publish = vi.fn(async () => ({
      status: "FAILED",
      intent_hash: INTENT_HASH,
      reason: "insufficient balance or overflow",
    }));

    const error = await run().catch((e: unknown) => e);

    // The original error, unwrapped: a rejection is definitive, so there is nothing for the
    // unconfirmed wrapper to add.
    expect(error).toBeInstanceOf(WithdrawRelayRejectedError);
    expect(error).not.toBeInstanceOf(RealWithdrawUnconfirmedError);
    expect((error as WithdrawRelayRejectedError).fundsState).toBe("untouched");
    expect(stages).not.toContain("published-unconfirmed");

    // Resolved, so a withdrawal that never moved does not clutter the rescue worklist.
    expect(onlyRecord().status).toBe("failed");
    expect(listUnresolvedWithdrawRecords()).toEqual([]);
  });

  it("a Verifier-declared settlement failure: untouched, resolved, retryable", async () => {
    const cause = new IntentSettlementError({
      status: "NOT_FOUND_OR_NOT_VALID",
      intent_hash: INTENT_HASH,
      status_details: "FAILED",
    });
    settle = vi.fn(async () => {
      throw cause;
    });

    const error = await run().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WithdrawSettlementFailedError);
    expect((error as WithdrawSettlementFailedError).fundsState).toBe("untouched");
    expect(stages).not.toContain("published-unconfirmed");
    expect(onlyRecord().status).toBe("failed");
    expect(listUnresolvedWithdrawRecords()).toEqual([]);
  });
});

describe("hot-omni with `hotFee` threaded (4.3.5 wiring)", () => {
  // POL native on Polygon: a `hot-omni` route the whole path can make end to end. Every
  // `hot-omni` chain has a receiver encoder as of 4.5, so this is a representative now rather
  // than the only option it used to be.
  const POL_NATIVE_HOT = "nep245:v2_1.omni.hot.tg:137_11111111111111111111";
  const hotFee: HotFeeDetail = {
    relayerFeeRaw: "1000000000000000",
    blockNumber: "123",
    nativeAssetId: POL_NATIVE_HOT,
    payment: "in-kind",
    swap: null,
  };

  it("no longer dies in requireHotFee, and delivers end to end", async () => {
    const result = await run({
      tokenId: POL_NATIVE_HOT,
      chainId: "eth:137",
      hotFee,
      hotDelivery: {
        fetchTxOutcome: async () => ({
          receipts_outcome: [
            { outcome: { logs: ['EVENT_JSON:{"standard":"nep245","data":[{"memo":"42"}]}'] } },
          ],
        }),
        getWithdrawalStatus: async () => null,
        indexerWithdrawals: async () => [{ nonce: "42", hash: "abc123" }],
      },
    });

    expect(signer.signEnvelope).toHaveBeenCalledTimes(1);
    expect(result.route).toBe("hot-omni");
    expect(result.delivery).toEqual({
      kind: "hot-bridge",
      destinationTxHash: "0xabc123",
      chain: "eth:137",
      nonce: "42",
    });
    expect(stages).toContain("awaiting-delivery");
  });
});

// D-305: on `native-balance` the relayer's gas leaves as a SECOND `mt_withdraw` entry, out
// of the chain's native token. The quote only knew that balance from the screen, so the click
// reads it again and refuses before signing when it no longer covers the fee.
describe("hot-omni native-balance: the gas balance is read again at the click (D-305)", () => {
  const TON_NATIVE = "nep245:v2_1.omni.hot.tg:1117_";
  const TON_ADDRESS = "UQCv4mTYxbLOKZBDL_b_jckLV3ev0SLA-demExEBdbkivm0W";
  const FEE = "40000000"; // 0.04 GRAM
  const nativeBalanceFee: HotFeeDetail = {
    relayerFeeRaw: FEE,
    blockNumber: "0",
    nativeAssetId: TON_NATIVE,
    payment: "native-balance",
    swap: null,
  };
  const balances =
    (native: bigint) =>
    async (_account: string, tokenId: string): Promise<bigint> =>
      tokenId === TON_NATIVE ? native : BigInt(10) ** BigInt(30);
  const runTon = (readHeld: RunRealWithdrawParams["readHeld"]) =>
    run({
      tokenId: USDT_TON,
      chainId: "ton:mainnet",
      qty: 5,
      destinationAddress: TON_ADDRESS,
      hotFee: nativeBalanceFee,
      readHeld,
    });

  it("refuses before signing when the native dropped below the fee since the quote", async () => {
    const error = await runTon(balances(BigInt(FEE) - BigInt(1))).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AmountExceedsBalanceError);
    expect(signer.signEnvelope).not.toHaveBeenCalled();
    expect(listWithdrawRecords()).toEqual([]);
    expect(stages).toEqual(["preparing"]);
  });

  it("reads both balances, and signs the unchanged two-entry envelope when the native covers the fee", async () => {
    const readHeld = vi.fn(balances(BigInt(FEE)));
    // The wallet declines, so the run stops at the signature with the request in hand.
    signer.signEnvelope.mockRejectedValueOnce(new Error("declined"));
    await runTon(readHeld).catch(() => {});
    expect(readHeld).toHaveBeenCalledWith(SIGNER_ID, USDT_TON);
    expect(readHeld).toHaveBeenCalledWith(SIGNER_ID, TON_NATIVE);
    expect(signer.signEnvelope).toHaveBeenCalledTimes(1);
    const [mt] = JSON.parse(signer.signEnvelope.mock.calls[0][0].nep413.message).intents;
    expect(mt.token_ids).toEqual(["1117_3tsdfyziyc7EJbP2aULWSKU4toBaAcN4FdTgfm5W1mC4ouR", "1117_"]);
    expect(mt.amounts).toEqual(["5000000", FEE]);
  });

  // Withdrawing the native itself: one `mt_withdraw` entry, the bridge takes the fee out of it
  // on the far side. So there is ONE balance and ONE cap — no second read to double count.
  it("withdrawing the native token reads one balance and caps against it alone", async () => {
    const POL_NATIVE_HOT = "nep245:v2_1.omni.hot.tg:137_11111111111111111111";
    const held = BigInt("2000000000000000000"); // 2 POL
    const readHeld = vi.fn(async () => held);
    signer.signEnvelope.mockRejectedValueOnce(new Error("declined"));
    await run({
      tokenId: POL_NATIVE_HOT,
      chainId: "eth:137",
      qty: 2,
      hotFee: {
        relayerFeeRaw: "1000000000000000",
        blockNumber: "123",
        nativeAssetId: POL_NATIVE_HOT,
        // Not what the quote picks for the native itself (`in-kind`), but it is what exercises
        // the `tokenId !== nativeAssetId` half of the rule: there is no second balance to read.
        payment: "native-balance",
        swap: null,
      },
      readHeld,
    }).catch(() => {});
    expect(readHeld).toHaveBeenCalledTimes(1);
    const [mt] = JSON.parse(signer.signEnvelope.mock.calls[0][0].nep413.message).intents;
    expect(mt.amounts).toEqual([held.toString()]);
  });
});

describe("guards that fire before anything is signed", () => {
  it("refuses hot-omni with no live quote, before a signature or a record", async () => {
    // `runRealWithdraw` has no HOT quote to pass yet — that is block 4.3.3's wiring. Until
    // then the builder's own refusal is what keeps the path shut, and it must happen before
    // the wallet is asked for anything.
    await expect(run({ tokenId: USDT_TON, chainId: "ton:mainnet" })).rejects.toThrow(
      /needs a live HOT fee quote/i
    );
    expect(signer.signEnvelope).not.toHaveBeenCalled();
    expect(listWithdrawRecords()).toEqual([]);
    expect(stages).toEqual(["preparing"]);
  });

  it("refuses a chain that disagrees with the registry — the intent cannot carry one", async () => {
    await expect(run({ chainId: "eth:1" })).rejects.toThrow(/chain mismatch/i);
    expect(signer.signEnvelope).not.toHaveBeenCalled();
    expect(listWithdrawRecords()).toEqual([]);
  });

  // D-303: the amount is capped against a balance read inside the click. The read is the
  // gate, so it has to fail CLOSED — no balance, no signature — and it has to ask about the
  // token being withdrawn, for the account that signs.
  it("reads the signer's balance of the withdrawn token before building anything", async () => {
    const readHeld = vi.fn(async () => BigInt(10) ** BigInt(30));
    await run({ readHeld });
    expect(readHeld).toHaveBeenCalledWith(SIGNER_ID, USDC_ARB);
  });

  // The DEFAULT reader, not an injected one: it is what production runs, and NEAR is the one
  // token whose registry id ("near") is not the id the Verifier holds ("nep141:wrap.near").
  // Asking with the registry id reads 0 and refuses every NEAR withdrawal.
  it("the default reader asks the Verifier for the signer's balance in the Verifier's id", async () => {
    const raw = "123456789012345678901234";
    const rpcArgs: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const params = JSON.parse(init.body as string).params;
        rpcArgs.push({ contract: params.account_id, ...JSON.parse(atob(params.args_base64)) });
        const bytes = Array.from(new TextEncoder().encode(JSON.stringify([raw])));
        return new Response(JSON.stringify({ result: { result: bytes, logs: [] } }), {
          status: 200,
        });
      })
    );
    await run({
      tokenId: "near",
      chainId: "near:mainnet",
      destinationAddress: NEAR_ADDRESS,
      destinationAlreadyVerified: true,
      qty: Number(BigInt(raw)) / 1e24, // Max, as the app holds it
      readHeld: undefined,
    });
    expect(rpcArgs).toEqual([
      { contract: "intents.near", account_id: SIGNER_ID, token_ids: ["nep141:wrap.near"] },
    ]);
    // And the capped figure is what was signed, recorded and settled against.
    const signed = JSON.parse(signer.signEnvelope.mock.calls[0][0].nep413.message).intents[0];
    expect(signed.amount).toBe(raw);
    expect(onlyRecord().amount).toBe(raw);
  });

  it("gives up on a slow balance read before the wallet popup would be lost", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
      const outcome = run({ readHeld: undefined }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(HELD_READ_BUDGET_MS);
      expect(await outcome).toBeInstanceOf(HeldReadTimeoutError);
      expect(signer.signEnvelope).not.toHaveBeenCalled();
      expect(listWithdrawRecords()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("signs nothing when the balance cannot be read", async () => {
    const outcome = await run({
      readHeld: async () => Promise.reject(new Error("RPC HTTP 401")),
    }).catch((e: unknown) => e);
    // Typed, so the modal can word it (D-304 a), with the cause kept for the console.
    expect(outcome).toBeInstanceOf(HeldReadFailedError);
    expect((outcome as Error).message).toMatch(/401/);
    expect(signer.signEnvelope).not.toHaveBeenCalled();
    expect(listWithdrawRecords()).toEqual([]);
    expect(stages).toEqual(["preparing"]);
  });

  it("signs nothing when the amount is really above the balance", async () => {
    await expect(run({ qty: 1.5, readHeld: async () => BigInt(1_000_000) })).rejects.toThrow(
      AmountExceedsBalanceError
    );
    expect(signer.signEnvelope).not.toHaveBeenCalled();
    expect(listWithdrawRecords()).toEqual([]);
  });

  it("refuses an amount that rounds to zero base units", async () => {
    await expect(run({ qty: 0.0000001 })).rejects.toThrow(/rounds to zero/i);
    expect(signer.signEnvelope).not.toHaveBeenCalled();
  });

  it("refuses a NEAR destination that cannot receive the token", async () => {
    probe = { accountExists: async () => false, storageBalanceOf: async () => null };

    const error = await run({ ...nearNative }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WithdrawDestinationUnusableError);
    expect((error as WithdrawDestinationUnusableError).fundsState).toBe("untouched");
    expect(signer.signEnvelope).not.toHaveBeenCalled();
    expect(listWithdrawRecords()).toEqual([]);
  });
});
