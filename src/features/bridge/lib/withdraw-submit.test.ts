import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { MultiPayload, VaultSigner } from "@/features/vault/lib/vault-signer";
import { buildWithdrawSignRequest, type WithdrawSignRequest } from "./withdraw-envelope";
import type { HotFeeDetail } from "./hot-fee";
import {
  parsePublishFailureCode,
  parsePublishResponse,
  nearDestinationIsContract,
  submitWithdraw,
  type NearDestinationProbe,
  type WithdrawPublisher,
} from "./withdraw-submit";
import {
  WithdrawDestinationUnusableError,
  WithdrawPublishUnknownError,
  WithdrawRelayRejectedError,
} from "./withdraw-errors";
import {
  SolanaDestinationUnusableError,
  type SolanaDestinationProbe,
} from "./solana-destination";
import { withdrawalDestinations } from "./withdrawal-registry";

// The token's own chain: every call here predates D-384 and means the native route.
const ownChain = (tokenId: string): string =>
  withdrawalDestinations(tokenId)[0] ?? "near:mainnet";

// Sign + publish, with the wallet and the relay faked. Nothing here may reach the network:
// `fetch` is stubbed to throw so an un-injected dependency fails the test instead of
// quietly hitting mainnet and costing a real withdrawal.

const SIGNER_ID = "alice.near";
const DEADLINE_SECS = 1_800_000_000;
const NONCE = new Uint8Array(32).fill(7);

const USDC_ARB = "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";
const USDT_NEAR = "nep141:usdt.tether-token.near";
const USDT_NEAR_CONTRACT = "usdt.tether-token.near";
const USDT_TON = "nep245:v2_1.omni.hot.tg:1117_3tsdfyziyc7EJbP2aULWSKU4toBaAcN4FdTgfm5W1mC4ouR";
const USDC_POLYGON = "nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L";
const POL_NATIVE = "nep245:v2_1.omni.hot.tg:137_11111111111111111111";

const USDC_SOL = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";

const EVM_ADDRESS = "0xc8b1e10d011aceed84f4cdba66ca175bd6552a36";
const NEAR_ADDRESS = "pablofork.near";
const SOL_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

const FAKE_PAYLOAD = { standard: "nep413", payload: {}, signature: "ed25519:sig" } as unknown as MultiPayload;

function omftRequest(over: Partial<Parameters<typeof buildWithdrawSignRequest>[0]> = {}) {
  return buildWithdrawSignRequest({
    signerId: SIGNER_ID,
    tokenId: USDC_ARB,
    chainId: "eth:42161",
    qty: 1.5,
    heldRaw: BigInt(10) ** BigInt(30), // ample — the cap has its own tests (D-303)
    destinationAddress: EVM_ADDRESS,
    deadlineSecs: DEADLINE_SECS,
    nonce: NONCE,
    ...over,
  });
}

function solanaRequest(over: Partial<Parameters<typeof buildWithdrawSignRequest>[0]> = {}) {
  return buildWithdrawSignRequest({
    signerId: SIGNER_ID,
    tokenId: USDC_SOL,
    chainId: "sol:mainnet",
    qty: 1.5,
    heldRaw: BigInt(10) ** BigInt(30), // ample — the cap has its own tests (D-303)
    destinationAddress: SOL_ADDRESS,
    deadlineSecs: DEADLINE_SECS,
    nonce: NONCE,
    ...over,
  });
}

function nearNativeRequest(over: Partial<Parameters<typeof buildWithdrawSignRequest>[0]> = {}) {
  return buildWithdrawSignRequest({
    signerId: SIGNER_ID,
    tokenId: USDT_NEAR,
    chainId: "near:mainnet",
    qty: 1.5,
    heldRaw: BigInt(10) ** BigInt(30), // ample — the cap has its own tests (D-303)
    destinationAddress: NEAR_ADDRESS,
    deadlineSecs: DEADLINE_SECS,
    nonce: NONCE,
    ...over,
  });
}

function nearUnwrapRequest(over: Partial<Parameters<typeof buildWithdrawSignRequest>[0]> = {}) {
  return buildWithdrawSignRequest({
    signerId: SIGNER_ID,
    tokenId: "near",
    chainId: "near:mainnet",
    qty: 1.5,
    heldRaw: BigInt(10) ** BigInt(30), // ample — the cap has its own tests (D-303)
    destinationAddress: NEAR_ADDRESS,
    deadlineSecs: DEADLINE_SECS,
    nonce: NONCE,
    ...over,
  });
}

/** A live HOT quote for a NON-native token: the relayer's gas is bought with a solver swap. */
function nonNativeFee(over: Partial<HotFeeDetail> = {}): HotFeeDetail {
  return {
    relayerFeeRaw: "26000000000000000",
    blockNumber: "78123456",
    nativeAssetId: POL_NATIVE,
    payment: "swap",
    swap: {
      quoteHash: "qh-live-77",
      assetIn: USDC_POLYGON,
      assetOut: POL_NATIVE,
      amountIn: "4321",
      amountOut: "26000000000000000",
      expiresAt: "2026-08-05T12:00:00.000Z",
    },
    ...over,
  };
}

function hotRequest(over: Partial<Parameters<typeof buildWithdrawSignRequest>[0]> = {}) {
  return buildWithdrawSignRequest({
    signerId: SIGNER_ID,
    tokenId: USDC_POLYGON,
    chainId: "eth:137",
    qty: 1,
    heldRaw: BigInt(10) ** BigInt(30), // ample — the cap has its own tests (D-303)
    destinationAddress: EVM_ADDRESS,
    deadlineSecs: DEADLINE_SECS,
    nonce: NONCE,
    hotFee: nonNativeFee(),
    ...over,
  });
}

/** Records the order of side effects, which is where the pre-flight guarantee lives. */
function harness(over: { publish?: WithdrawPublisher; probe?: Partial<NearDestinationProbe> } = {}) {
  const calls: string[] = [];
  const signer: VaultSigner = {
    scheme: "nep413",
    signEnvelope: vi.fn(async () => {
      calls.push("sign");
      return FAKE_PAYLOAD;
    }),
  };
  const publish: WithdrawPublisher = vi.fn(async (params) => {
    calls.push("publish");
    return over.publish ? over.publish(params) : { status: "OK", intent_hash: "0xIntentHash" };
  });
  const probe: NearDestinationProbe = {
    accountExists: vi.fn(async () => {
      calls.push("accountExists");
      return true;
    }),
    storageBalanceOf: vi.fn(async () => {
      calls.push("storageBalanceOf");
      return { total: "1250000000000000000000" };
    }),
    ...over.probe,
  };
  return { calls, signer, publish, probe };
}

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

describe("submitWithdraw — omft happy path", () => {
  it("publishes the signer's assembled MultiPayload with NO quote hashes", async () => {
    const h = harness();
    const result = await submitWithdraw({
      request: omftRequest(),
      tokenId: USDC_ARB,
      chainId: ownChain(USDC_ARB),
      destinationAddress: EVM_ADDRESS,
      signer: h.signer,
      publish: h.publish,
      probe: h.probe,
    });

    expect(result).toEqual({ intentHash: "0xIntentHash", route: "omft" });
    // A withdrawal is not a swap, so there is no solver quote to honour (D-147 step 3).
    expect(vi.mocked(h.publish).mock.calls[0][0]).toEqual({
      quote_hashes: [],
      signed_data: FAKE_PAYLOAD,
    });
  });

  it("hands the signer both envelope forms, so the wrong one cannot be paired", async () => {
    const h = harness();
    const request = omftRequest();
    await submitWithdraw({
      request,
      tokenId: USDC_ARB,
      chainId: ownChain(USDC_ARB),
      destinationAddress: EVM_ADDRESS,
      signer: h.signer,
      publish: h.publish,
      probe: h.probe,
    });

    expect(vi.mocked(h.signer.signEnvelope).mock.calls[0][0]).toEqual({
      nep413: request.nep413,
      erc191Message: request.erc191Message,
    });
  });

  it("does not pre-flight a NEAR account for a route that does not pay one", async () => {
    const h = harness();
    await submitWithdraw({
      request: omftRequest(),
      tokenId: USDC_ARB,
      chainId: ownChain(USDC_ARB),
      destinationAddress: EVM_ADDRESS,
      signer: h.signer,
      publish: h.publish,
      probe: h.probe,
    });
    expect(h.calls).toEqual(["sign", "publish"]);
  });
});

// D-176. `near-unwrap` shares the destination pre-flight with `near-native` but only half
// of it: native NEAR needs no NEP-141 storage on the destination, so demanding one would
// refuse an ordinary NEAR wallet that has simply never touched wrap.near.
describe("submitWithdraw — near-unwrap happy path", () => {
  it("checks the account exists and does NOT ask about token storage", async () => {
    const h = harness();
    const result = await submitWithdraw({
      request: nearUnwrapRequest(),
      tokenId: "near",
      chainId: ownChain("near"),
      destinationAddress: NEAR_ADDRESS,
      signer: h.signer,
      publish: h.publish,
      probe: h.probe,
    });

    expect(result.route).toBe("near-unwrap");
    expect(h.calls).toEqual(["accountExists", "sign", "publish"]);
    expect(h.probe.storageBalanceOf).not.toHaveBeenCalled();
  });

  it("still refuses a destination account that does not exist", async () => {
    const h = harness({ probe: { accountExists: vi.fn(async () => false) } });
    await expect(
      submitWithdraw({
        request: nearUnwrapRequest(),
        tokenId: "near",
        chainId: ownChain("near"),
        destinationAddress: NEAR_ADDRESS,
        signer: h.signer,
        publish: h.publish,
        probe: h.probe,
      })
    ).rejects.toThrow();
    expect(h.signer.signEnvelope).not.toHaveBeenCalled();
  });

  // The unregistered-on-wrap.near case: `near-native` refuses it, `near-unwrap` must not.
  it("goes through even when the destination has no wrap.near storage balance", async () => {
    const h = harness({ probe: { storageBalanceOf: vi.fn(async () => null) } });
    const result = await submitWithdraw({
      request: nearUnwrapRequest(),
      tokenId: "near",
      chainId: ownChain("near"),
      destinationAddress: NEAR_ADDRESS,
      signer: h.signer,
      publish: h.publish,
      probe: h.probe,
    });
    expect(result.route).toBe("near-unwrap");
  });
});

describe("submitWithdraw — near-native happy path", () => {
  it("checks the destination BEFORE asking the wallet to sign", async () => {
    const h = harness();
    const result = await submitWithdraw({
      request: nearNativeRequest(),
      tokenId: USDT_NEAR,
      chainId: ownChain(USDT_NEAR),
      destinationAddress: NEAR_ADDRESS,
      signer: h.signer,
      publish: h.publish,
      probe: h.probe,
    });

    expect(result.route).toBe("near-native");
    // The whole point of the pre-flight: it is worthless after a signature exists.
    expect(h.calls).toEqual(["accountExists", "storageBalanceOf", "sign", "publish"]);
  });

  it("asks about registration on the TOKEN contract, for the destination account", async () => {
    const h = harness();
    await submitWithdraw({
      request: nearNativeRequest(),
      tokenId: USDT_NEAR,
      chainId: ownChain(USDT_NEAR),
      destinationAddress: NEAR_ADDRESS,
      signer: h.signer,
      publish: h.publish,
      probe: h.probe,
    });
    expect(vi.mocked(h.probe.storageBalanceOf).mock.calls[0]).toEqual([
      USDT_NEAR_CONTRACT,
      NEAR_ADDRESS,
    ]);
  });

  // The two reads are independent, and issuing them back to back is what pushed this past the
  // browser's user-activation window on a slow endpoint. Concurrent, so the cost is one round
  // trip rather than two.
  it("issues both destination reads concurrently, not one after the other", async () => {
    const h = harness();
    await submitWithdraw({
      request: nearNativeRequest(),
      tokenId: USDT_NEAR,
      chainId: ownChain(USDT_NEAR),
      destinationAddress: NEAR_ADDRESS,
      signer: h.signer,
      publish: h.publish,
      probe: h.probe,
    });
    // Both recorded before either could have resolved into the signature.
    expect(h.calls.slice(0, 2)).toEqual(["accountExists", "storageBalanceOf"]);
  });

  // The click that confirms a withdrawal has to reach a wallet popup inside the user-activation
  // window. When the UI already ran this check on step 3, repeating it here would spend that
  // window on two view calls for an answer we have.
  it("skips the pre-flight entirely when the caller already ran it", async () => {
    const h = harness();
    const result = await submitWithdraw({
      request: nearNativeRequest(),
      tokenId: USDT_NEAR,
      chainId: ownChain(USDT_NEAR),
      destinationAddress: NEAR_ADDRESS,
      destinationAlreadyVerified: true,
      signer: h.signer,
      publish: h.publish,
      probe: h.probe,
    });

    expect(result.route).toBe("near-native");
    expect(h.calls).toEqual(["sign", "publish"]);
    expect(h.probe.accountExists).not.toHaveBeenCalled();
    expect(h.probe.storageBalanceOf).not.toHaveBeenCalled();
  });
});

/**
 * Block 4.2. The modal runs this outside the click (D-R16) and sets
 * `destinationAlreadyVerified`; what is tested here is the backstop that catches a caller
 * which does not — because on Solana the pre-flight is the only thing between a pasted SPL
 * token account and an unrecoverable transfer.
 */
describe("submitWithdraw — the Solana destination backstop", () => {
  function solanaHarness(getAccountInfo: SolanaDestinationProbe["getAccountInfo"]) {
    const h = harness();
    return {
      ...h,
      solanaProbe: { getAccountInfo: vi.fn(getAccountInfo) } satisfies SolanaDestinationProbe,
    };
  }

  function attempt(h: ReturnType<typeof solanaHarness>, over: { verified?: boolean } = {}) {
    return submitWithdraw({
      request: solanaRequest(),
      tokenId: USDC_SOL,
      chainId: ownChain(USDC_SOL),
      destinationAddress: SOL_ADDRESS,
      signer: h.signer,
      publish: h.publish,
      solanaProbe: h.solanaProbe,
      ...(over.verified ? { destinationAlreadyVerified: true } : {}),
    });
  }

  it("signs and publishes when the destination is an ordinary wallet", async () => {
    const h = solanaHarness(async () => ({
      owner: "11111111111111111111111111111111",
      executable: false,
      lamports: 5_000_000,
    }));
    const result = await attempt(h);
    expect(result.route).toBe("omft");
    expect(h.calls).toEqual(["sign", "publish"]);
  });

  it("refuses to sign when the destination is an SPL token account", async () => {
    const h = solanaHarness(async () => ({
      owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      executable: false,
      lamports: 2_039_280,
    }));
    await expect(attempt(h)).rejects.toThrow(SolanaDestinationUnusableError);
    expect(h.signer.signEnvelope).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
  });

  // The warning case: absent accounts are the user's call, and by this point they made it.
  it("signs when the destination account does not exist", async () => {
    const h = solanaHarness(async () => null);
    const result = await attempt(h);
    expect(result.route).toBe("omft");
    expect(h.calls).toEqual(["sign", "publish"]);
  });

  it("skips the probe when the caller already ran it", async () => {
    const h = solanaHarness(async () => null);
    await attempt(h, { verified: true });
    expect(h.solanaProbe.getAccountInfo).not.toHaveBeenCalled();
  });

  // `fetch` throws in this suite, so an un-injected probe exercises the real default one.
  // It must fail CLOSED rather than let an unchecked Solana address through.
  it("refuses to sign when no probe is injected and the network is unreachable", async () => {
    const h = harness();
    await expect(
      submitWithdraw({
        request: solanaRequest(),
        tokenId: USDC_SOL,
        chainId: ownChain(USDC_SOL),
        destinationAddress: SOL_ADDRESS,
        signer: h.signer,
        publish: h.publish,
      })
    ).rejects.toThrow(SolanaDestinationUnusableError);
    expect(h.signer.signEnvelope).not.toHaveBeenCalled();
  });

  // The EVM `omft` route must be untouched by all of this.
  it("does not probe for a non-Solana omft withdrawal", async () => {
    const h = solanaHarness(async () => null);
    const result = await submitWithdraw({
      request: omftRequest(),
      tokenId: USDC_ARB,
      chainId: ownChain(USDC_ARB),
      destinationAddress: EVM_ADDRESS,
      signer: h.signer,
      publish: h.publish,
      solanaProbe: h.solanaProbe,
    });
    expect(result.route).toBe("omft");
    expect(h.solanaProbe.getAccountInfo).not.toHaveBeenCalled();
  });
});

describe("the near-native destination pre-flight refuses to sign", () => {
  async function attempt(probe: Partial<NearDestinationProbe>) {
    const h = harness({ probe });
    const promise = submitWithdraw({
      request: nearNativeRequest(),
      tokenId: USDT_NEAR,
      chainId: ownChain(USDT_NEAR),
      destinationAddress: NEAR_ADDRESS,
      signer: h.signer,
      publish: h.publish,
      probe: h.probe,
    });
    return { h, promise };
  }

  it("when the account does not exist", async () => {
    const { h, promise } = await attempt({ accountExists: async () => false });
    await expect(promise).rejects.toThrow(WithdrawDestinationUnusableError);
    await promise.catch((e: WithdrawDestinationUnusableError) => {
      expect(e.problem).toBe("missing-account");
      expect(e.fundsState).toBe("untouched");
    });
    expect(h.signer.signEnvelope).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("when the account exists but is not registered with the token", async () => {
    // storage_deposit is deliberately unset on this intent, so an unregistered receiver
    // means the transfer fails with NO refund. This is the guard that replaces paying it.
    const { h, promise } = await attempt({ storageBalanceOf: async () => null });
    await promise.catch((e: WithdrawDestinationUnusableError) => {
      expect(e.problem).toBe("not-registered");
    });
    await expect(promise).rejects.toThrow(WithdrawDestinationUnusableError);
    expect(h.signer.signEnvelope).not.toHaveBeenCalled();
  });

  it("when the read itself failed — an unverifiable destination is not a usable one", async () => {
    const { h, promise } = await attempt({
      accountExists: async () => {
        throw new Error("RPC 502");
      },
    });
    await promise.catch((e: WithdrawDestinationUnusableError) => {
      expect(e.problem).toBe("unverified");
      expect((e.cause as Error).message).toBe("RPC 502");
    });
    await expect(promise).rejects.toThrow(/Could not verify/i);
    expect(h.signer.signEnvelope).not.toHaveBeenCalled();
  });

  it("when the registration read fails, not only the existence read", async () => {
    const { promise } = await attempt({
      storageBalanceOf: async () => {
        throw new Error("RPC 502");
      },
    });
    await promise.catch((e: WithdrawDestinationUnusableError) => {
      expect(e.problem).toBe("unverified");
    });
    await expect(promise).rejects.toThrow(WithdrawDestinationUnusableError);
  });
});

describe("guards against pre-flighting one withdrawal and signing another", () => {
  it("throws when an omft envelope's memo names a different destination", async () => {
    const h = harness();
    await expect(
      submitWithdraw({
        // The envelope's memo says WITHDRAW_TO:0xc8b1…; the caller claims another address.
        request: omftRequest(),
        tokenId: USDC_ARB,
        chainId: ownChain(USDC_ARB),
        destinationAddress: "0x000000000000000000000000000000000000dead",
        signer: h.signer,
        publish: h.publish,
        probe: h.probe,
      })
    ).rejects.toThrow(/destination mismatch/i);
    expect(h.signer.signEnvelope).not.toHaveBeenCalled();
  });

  it("throws when the envelope carries a destination tag the caller did not pass on", async () => {
    // The known modal gap (5.1): the memo is collected but never forwarded. If it reaches
    // the builder and not the submit, that is a caller bug and must not be signed.
    const h = harness();
    await expect(
      submitWithdraw({
        request: omftRequest({ destinationMemo: "98765" }),
        tokenId: USDC_ARB,
        chainId: ownChain(USDC_ARB),
        destinationAddress: EVM_ADDRESS,
        signer: h.signer,
        publish: h.publish,
        probe: h.probe,
      })
    ).rejects.toThrow(/destination mismatch/i);
  });

  it("accepts a destination tag when both sides agree on it", async () => {
    const h = harness();
    await expect(
      submitWithdraw({
        request: omftRequest({ destinationMemo: "98765" }),
        tokenId: USDC_ARB,
        chainId: ownChain(USDC_ARB),
        destinationAddress: EVM_ADDRESS,
        destinationMemo: "98765",
        signer: h.signer,
        publish: h.publish,
        probe: h.probe,
      })
    ).resolves.toMatchObject({ intentHash: "0xIntentHash" });
  });

  it("throws when the envelope pays an account other than the one checked", async () => {
    const h = harness();
    await expect(
      submitWithdraw({
        // The envelope pays pablofork.near; the caller claims it is checking someone else.
        request: nearNativeRequest(),
        tokenId: USDT_NEAR,
        chainId: ownChain(USDT_NEAR),
        destinationAddress: "attacker.near",
        signer: h.signer,
        publish: h.publish,
        probe: h.probe,
      })
    ).rejects.toThrow(/destination mismatch/i);
    expect(h.probe.accountExists).not.toHaveBeenCalled();
    expect(h.signer.signEnvelope).not.toHaveBeenCalled();
  });

  it("throws when the envelope's route disagrees with the registry", async () => {
    const h = harness();
    const request = { ...nearNativeRequest(), route: "omft" as const };
    await expect(
      submitWithdraw({
        request,
        tokenId: USDT_NEAR,
        chainId: ownChain(USDT_NEAR),
        destinationAddress: NEAR_ADDRESS,
        signer: h.signer,
        publish: h.publish,
        probe: h.probe,
      })
    ).rejects.toThrow(/route mismatch/i);
    expect(h.signer.signEnvelope).not.toHaveBeenCalled();
  });

  it("throws for a token with no withdrawal route", async () => {
    const h = harness();
    await expect(
      submitWithdraw({
        request: omftRequest(),
        tokenId: "nep141:not-a-token.near",
        chainId: ownChain("nep141:not-a-token.near"),
        destinationAddress: EVM_ADDRESS,
        signer: h.signer,
        publish: h.publish,
        probe: h.probe,
      })
    ).rejects.toThrow(/no withdrawal route/i);
  });
});

// Block 4.3.3. The route no longer stops here — blocks 4.3.1–4.3.2 gave it a quote and a
// builder, and this block gives it a publish. What changes at THIS layer is that the fee swap
// is a solver swap, so its quote hash has to reach the relay with it.
describe("submitWithdraw — hot-omni", () => {
  it("publishes the fee swap's quote hash, not an empty list", async () => {
    const h = harness();
    const result = await submitWithdraw({
      request: hotRequest(),
      tokenId: USDC_POLYGON,
      chainId: ownChain(USDC_POLYGON),
      destinationAddress: EVM_ADDRESS,
      signer: h.signer,
      publish: h.publish,
      probe: h.probe,
    });

    expect(result).toEqual({ intentHash: "0xIntentHash", route: "hot-omni" });
    expect(vi.mocked(h.publish).mock.calls[0][0]).toEqual({
      quote_hashes: ["qh-live-77"],
      signed_data: FAKE_PAYLOAD,
    });
  });

  it("publishes NO hash when the withdrawn token is the chain's own gas", async () => {
    // No swap was quoted, so there is nothing for the relay to honour — the same empty list
    // as omft, arrived at for the same reason rather than by route.
    const h = harness();
    await submitWithdraw({
      request: hotRequest({
        tokenId: POL_NATIVE,
        hotFee: nonNativeFee({ payment: "in-kind", swap: null }),
      }),
      tokenId: POL_NATIVE,
      chainId: ownChain(POL_NATIVE),
      destinationAddress: EVM_ADDRESS,
      signer: h.signer,
      publish: h.publish,
      probe: h.probe,
    });
    expect(vi.mocked(h.publish).mock.calls[0][0]).toMatchObject({ quote_hashes: [] });
  });

  it("does not pre-flight a NEAR account for a route that does not pay one", async () => {
    const h = harness();
    await submitWithdraw({
      request: hotRequest(),
      tokenId: USDC_POLYGON,
      chainId: ownChain(USDC_POLYGON),
      destinationAddress: EVM_ADDRESS,
      signer: h.signer,
      publish: h.publish,
      probe: h.probe,
    });
    expect(h.calls).toEqual(["sign", "publish"]);
  });

  it("refuses a TON destination it cannot vouch for, before the wallet is asked", async () => {
    // 4.3.2's finding: `encodeReceiver` is a per-family switch, so TON and Stellar waited for
    // blocks 4.4/4.5. Both have their branch now, and what this guard still catches is the
    // narrower and more dangerous case — a TON address that is not one. `UQxxx` is 5 chars,
    // so it never reaches the CRC16; the point is that the wallet is never asked either way.
    const h = harness();
    await expect(
      submitWithdraw({
        request: { route: "hot-omni", intents: [], amount: "1", quoteHashes: [] } as unknown as WithdrawSignRequest,
        tokenId: USDT_TON,
        chainId: ownChain(USDT_TON),
        destinationAddress: "UQxxx",
        signer: h.signer,
        publish: h.publish,
        probe: h.probe,
      })
    ).rejects.toThrow(/EQ…\/UQ… form/);
    expect(h.signer.signEnvelope).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
  });
});

describe("hot-omni destination guards read the mt_withdraw, not the first intent", () => {
  it("catches a mismatch even though a token_diff sits in front of it", async () => {
    // The trap this test exists for: on the nine non-native tokens `intents[0]` is the fee
    // SWAP. A guard that read index 0 would compare `undefined` and pass everything.
    const h = harness();
    await expect(
      submitWithdraw({
        request: hotRequest(),
        tokenId: USDC_POLYGON,
        chainId: ownChain(USDC_POLYGON),
        destinationAddress: "0x000000000000000000000000000000000000dead",
        signer: h.signer,
        publish: h.publish,
        probe: h.probe,
      })
    ).rejects.toThrow(/destination mismatch/i);
    expect(h.signer.signEnvelope).not.toHaveBeenCalled();
  });

  it("compares in HOT's own base58 encoding, so a matching address passes", async () => {
    const h = harness();
    await expect(
      submitWithdraw({
        request: hotRequest(),
        tokenId: USDC_POLYGON,
        chainId: ownChain(USDC_POLYGON),
        destinationAddress: EVM_ADDRESS,
        signer: h.signer,
        publish: h.publish,
        probe: h.probe,
      })
    ).resolves.toMatchObject({ route: "hot-omni" });
  });

  it("reports an unreadable msg as a mismatch, not as a SyntaxError out of a guard", async () => {
    const h = harness();
    const req = hotRequest();
    const broken = {
      ...req,
      intents: [req.intents[0], { ...(req.intents[1] as object), msg: "not json" }],
    } as unknown as WithdrawSignRequest;
    await expect(
      submitWithdraw({
        request: broken,
        tokenId: USDC_POLYGON,
        chainId: ownChain(USDC_POLYGON),
        destinationAddress: EVM_ADDRESS,
        signer: h.signer,
        publish: h.publish,
        probe: h.probe,
      })
    ).rejects.toThrow(/destination mismatch/i);
    expect(h.signer.signEnvelope).not.toHaveBeenCalled();
  });

  it("refuses a destination tag the caller passes to a bridge that drops them", async () => {
    // The builder refuses a memo too; this covers the pairing case, where the envelope was
    // built without one and the submit was handed one.
    const h = harness();
    await expect(
      submitWithdraw({
        request: hotRequest(),
        tokenId: USDC_POLYGON,
        chainId: ownChain(USDC_POLYGON),
        destinationAddress: EVM_ADDRESS,
        destinationMemo: "98765",
        signer: h.signer,
        publish: h.publish,
        probe: h.probe,
      })
    ).rejects.toThrow(/does not carry a destination memo/i);
    expect(h.signer.signEnvelope).not.toHaveBeenCalled();
  });
});

describe("a swap in the envelope must arrive with a quote to honour", () => {
  it("refuses to sign a token_diff whose hash was dropped on the way", async () => {
    // Only reachable by hand-assembling a request, which is exactly the case worth catching:
    // published unquoted, the fee leg settles at whatever price the relay finds.
    const h = harness();
    await expect(
      submitWithdraw({
        request: { ...hotRequest(), quoteHashes: [] },
        tokenId: USDC_POLYGON,
        chainId: ownChain(USDC_POLYGON),
        destinationAddress: EVM_ADDRESS,
        signer: h.signer,
        publish: h.publish,
        probe: h.probe,
      })
    ).rejects.toThrow(/no quote hash/i);
    expect(h.signer.signEnvelope).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
  });
});

describe("the relay's answer, parsed by hand because we bypass the high-level API", () => {
  it.each([
    ["expired", "SIGNATURE_EXPIRED"],
    ["deadline has expired for intent", "SIGNATURE_EXPIRED"],
    ["internal", "INTERNAL_ERROR"],
    ["invalid signature", "SIGNATURE_INVALID"],
    ["nonce was already used", "NONCE_USED"],
    ["insufficient balance or overflow", "INSUFFICIENT_BALANCE"],
    ["public key doesn't exist", "PUBLIC_KEY_NOT_EXIST"],
    ["invalid salt", "INVALID_SALT"],
    ["something nobody has seen", "UNKNOWN_ERROR"],
  ])("maps %o to %s, matching internal-utils", (reason, code) => {
    expect(parsePublishFailureCode(reason)).toBe(code);
  });

  it("surfaces a rejection as a typed error with the balance untouched", async () => {
    const h = harness({
      publish: async () => ({
        status: "FAILED",
        intent_hash: "0xIntentHash",
        reason: "insufficient balance or overflow",
      }),
    });
    const promise = submitWithdraw({
      request: omftRequest(),
      tokenId: USDC_ARB,
      chainId: ownChain(USDC_ARB),
      destinationAddress: EVM_ADDRESS,
      signer: h.signer,
      publish: h.publish,
      probe: h.probe,
    });

    await expect(promise).rejects.toThrow(WithdrawRelayRejectedError);
    await promise.catch((e: WithdrawRelayRejectedError) => {
      expect(e.code).toBe("INSUFFICIENT_BALANCE");
      expect(e.fundsState).toBe("untouched");
    });
  });

  it('treats "already processed" as published, as upstream does', () => {
    // A re-publish of an intent the relay already holds. Calling it a failure would tell
    // the user a withdrawal that is in flight had failed.
    expect(
      parsePublishResponse({
        status: "FAILED",
        intent_hash: "0xIntentHash",
        reason: "already processed",
      })
    ).toBe("0xIntentHash");
  });

  // ── D-258: a rejection carries no hash, and used to be read as UNKNOWN ────────────────
  //
  // The literal answer the relay gave on 2026-08-10, on a real withdrawal: `FAILED`, a reason,
  // and no `intent_hash` field at all. Reading the hash first classified this as UNKNOWN, which
  // made the taxonomy above unreachable AND left the rescue record unresolved forever, because
  // only `fundsState: "untouched"` resolves one.
  it("classifies a FAILED that carries no intent_hash — the measured shape", () => {
    try {
      parsePublishResponse({ status: "FAILED", reason: "insufficient balance or overflow" });
      expect.unreachable("a rejection must throw");
    } catch (e) {
      expect(e).toBeInstanceOf(WithdrawRelayRejectedError);
      const rejected = e as WithdrawRelayRejectedError;
      expect(rejected.code).toBe("INSUFFICIENT_BALANCE");
      expect(rejected.fundsState).toBe("untouched");
    }
  });

  it.each([
    ["expired", "SIGNATURE_EXPIRED"],
    ["invalid signature", "SIGNATURE_INVALID"],
    ["insufficient balance or overflow", "INSUFFICIENT_BALANCE"],
    ["public key doesn't exist", "PUBLIC_KEY_NOT_EXIST"],
    ["invalid salt", "INVALID_SALT"],
    ["something nobody has seen", "UNKNOWN_ERROR"],
  ])("reaches code %s from a hash-less rejection (%o)", (reason, code) => {
    try {
      parsePublishResponse({ status: "FAILED", reason });
      expect.unreachable("a rejection must throw");
    } catch (e) {
      expect(e).toBeInstanceOf(WithdrawRelayRejectedError);
      expect((e as WithdrawRelayRejectedError).code).toBe(code);
      expect((e as WithdrawRelayRejectedError).fundsState).toBe("untouched");
    }
  });

  // ── The two FAILED codes that are NOT proof of a refusal ──────────────────────────────
  //
  // Found by cross-review on the first version of this fix, which swept every FAILED into a
  // rejection. `untouched` is a PROMISE — the funds never moved, the record resolves, the row
  // leaves the worklist — and these two cannot keep it.
  it.each([
    // The nonce is unique per signature, so "already used" means an intent carrying it
    // EXECUTED. The likeliest author is our own retry: PUBLISH_REQUEST_CONFIG allows 7
    // attempts, so a publish that settled and lost its HTTP answer comes back exactly here.
    // Calling this a rejection tells someone their money never moved while it did.
    ["nonce was already used", "NONCE_USED"],
    // An opaque string the relay can raise anywhere, including after accepting the intent.
    ["internal", "INTERNAL_ERROR"],
  ])("refuses to call %o a rejection — it may have executed", (reason) => {
    try {
      parsePublishResponse({ status: "FAILED", reason });
      expect.unreachable("must throw");
    } catch (e) {
      expect(e).toBeInstanceOf(WithdrawPublishUnknownError);
      // `unknown` is what keeps the rescue record OPEN. `untouched` would resolve it and drop
      // the only recovery mechanism a withdrawal has (there is no Solver backstop — D-160).
      expect((e as WithdrawPublishUnknownError).fundsState).toBe("unknown");
      expect(e).not.toBeInstanceOf(WithdrawRelayRejectedError);
    }
  });

  it('still demands the hash for "already processed" — the one FAILED that returns one', () => {
    // This branch reports the withdrawal as IN FLIGHT. Without the handle there is nothing to
    // re-check with, so UNKNOWN is the honest answer and a rejection would be a lie.
    expect(() =>
      parsePublishResponse({ status: "FAILED", reason: "already processed" })
    ).toThrow(WithdrawPublishUnknownError);
  });

  it("refuses a response shape it does not recognise instead of guessing", () => {
    expect(() => parsePublishResponse({ ok: true })).toThrow(WithdrawPublishUnknownError);
    expect(() => parsePublishResponse({ status: "OK" })).toThrow(WithdrawPublishUnknownError);
    expect(() => parsePublishResponse(null)).toThrow(WithdrawPublishUnknownError);
  });

  it("refuses a monadic Result — an ignored Err looks exactly like success", () => {
    // The high-level solverRelay.publishIntent returns Result<...> and does NOT throw. If
    // anyone ever swaps it in here, this is the tripwire that stops a withdrawal that never
    // happened from being reported as sent.
    const okResult = { isOk: () => true, isErr: () => false, unwrap: () => "0xIntentHash" };
    expect(() => parsePublishResponse(okResult)).toThrow(/monadic Result/i);
    const errResult = { isOk: () => false, isErr: () => true, unwrapErr: () => new Error("nope") };
    expect(() => parsePublishResponse(errResult)).toThrow(WithdrawPublishUnknownError);
  });

  it("reports a thrown publish as UNKNOWN, never as a failure", async () => {
    const h = harness({
      publish: async () => {
        throw new Error("socket hang up");
      },
    });
    const promise = submitWithdraw({
      request: omftRequest(),
      tokenId: USDC_ARB,
      chainId: ownChain(USDC_ARB),
      destinationAddress: EVM_ADDRESS,
      signer: h.signer,
      publish: h.publish,
      probe: h.probe,
    });

    await expect(promise).rejects.toThrow(WithdrawPublishUnknownError);
    await promise.catch((e: WithdrawPublishUnknownError) => {
      // The relay may have taken it before the connection died.
      expect(e.fundsState).toBe("unknown");
      expect(e.message).toContain("socket hang up");
    });
  });
});

// D-384: an omft token sent to a NEAR account takes the near-native checks, on its own contract.
describe("omft token to NEAR (D-384)", () => {
  const SOL = "nep141:sol.omft.near";
  const solToNear = () =>
    buildWithdrawSignRequest({
      signerId: SIGNER_ID,
      tokenId: SOL,
      chainId: "near:mainnet",
      qty: 0.01,
      heldRaw: BigInt(10) ** BigInt(30),
      destinationAddress: NEAR_ADDRESS,
      deadlineSecs: DEADLINE_SECS,
      nonce: NONCE,
    });

  it("checks the NEAR account and its registration on the omft contract before signing", async () => {
    const h = harness();
    const result = await submitWithdraw({
      request: solToNear(),
      tokenId: SOL,
      chainId: "near:mainnet",
      destinationAddress: NEAR_ADDRESS,
      signer: h.signer,
      publish: h.publish,
      probe: h.probe,
    });
    expect(result.route).toBe("near-native");
    expect(h.calls).toEqual(["accountExists", "storageBalanceOf", "sign", "publish"]);
    expect(vi.mocked(h.probe.storageBalanceOf).mock.calls[0]).toEqual([
      "sol.omft.near",
      NEAR_ADDRESS,
    ]);
  });

  it("refuses an unregistered NEAR account without signing", async () => {
    const h = harness({ probe: { storageBalanceOf: vi.fn(async () => null) } });
    await expect(
      submitWithdraw({
        request: solToNear(),
        tokenId: SOL,
        chainId: "near:mainnet",
        destinationAddress: NEAR_ADDRESS,
        signer: h.signer,
        publish: h.publish,
        probe: h.probe,
      })
    ).rejects.toBeInstanceOf(WithdrawDestinationUnusableError);
    expect(h.signer.signEnvelope).not.toHaveBeenCalled();
  });

  it("refuses a NEAR envelope paired with the token's native chain", async () => {
    // The native chain resolves to the omft route, the envelope says near-native: a caller
    // that lost track of the destination is stopped before a signature exists.
    const h = harness();
    await expect(
      submitWithdraw({
        request: solToNear(),
        tokenId: SOL,
        chainId: "sol:mainnet",
        destinationAddress: NEAR_ADDRESS,
        signer: h.signer,
        publish: h.publish,
        probe: h.probe,
      })
    ).rejects.toThrow(/route mismatch/);
    expect(h.signer.signEnvelope).not.toHaveBeenCalled();
  });

  it("refuses a bridge envelope paired with NEAR as the destination chain", async () => {
    const h = harness();
    await expect(
      submitWithdraw({
        request: solanaRequest(),
        tokenId: USDC_SOL,
        chainId: "near:mainnet",
        destinationAddress: SOL_ADDRESS,
        signer: h.signer,
        publish: h.publish,
        probe: h.probe,
      })
    ).rejects.toThrow(/route mismatch/);
    expect(h.signer.signEnvelope).not.toHaveBeenCalled();
  });
});

// D-386 (d): the contract read only ever warns, so a failed read must be silence, not a block.
describe("nearDestinationIsContract", () => {
  it("passes a definite answer through", async () => {
    await expect(nearDestinationIsContract("dex.near", async () => true)).resolves.toBe(true);
    await expect(nearDestinationIsContract("alice.near", async () => false)).resolves.toBe(false);
  });

  it("reads a failed lookup as no warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      nearDestinationIsContract("alice.near", async () => {
        throw new Error("RPC HTTP 503");
      }),
    ).resolves.toBe(false);
    warn.mockRestore();
  });
});
