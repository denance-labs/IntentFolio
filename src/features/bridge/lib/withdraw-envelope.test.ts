import { describe, it, expect } from "vitest";
import { AmountExceedsBalanceError } from "@/features/vault/lib/base-units";
import { prepareBroadcastRequest } from "@defuse-protocol/internal-utils";
import type { Intent } from "@defuse-protocol/contract-types";
import {
  IntentFtWithdrawValidator,
  IntentNativeWithdrawValidator,
  Nep413DefuseMessageFor_DefuseIntentsValidator,
  MultiPayloadNep413Validator,
  MultiPayloadErc191Validator,
  type Validator,
} from "@defuse-protocol/contract-types/validate";
import {
  buildWithdrawSignRequest,
  buildWithdrawMemo,
  WITHDRAW_MIN_GAS,
  type WithdrawSignRequest,
} from "./withdraw-envelope";

// Offline proof (no network, no wallet): the withdrawal envelope validates against the
// CANONICAL contract-types validators once assembled by the CANONICAL SDK assembler, and the
// two signing schemes describe the SAME withdrawal.
//
// This is the anti-misroute guarantee. A withdrawal that names the wrong receiver does not
// fail — it settles and delivers to nobody — so the assertions below are about WHERE the
// money is addressed, not merely that the payload parses.

const SIGNER = "alice.near";
const DEADLINE_SECS = 1_800_000_000; // fixed, comfortably future
const NONCE = new Uint8Array(32).fill(7);

// Real registry entries, so a registry edit that breaks an assumption breaks these tests.
const USDC_ARB = "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";
const USDC_ARB_CONTRACT = "arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";
const USDT_NEAR = "nep141:usdt.tether-token.near";
const BTC = "nep141:btc.omft.near"; // minWithdrawalRaw 700, decimals 8
const USDT_TON = "nep245:v2_1.omni.hot.tg:1117_3tsdfyziyc7EJbP2aULWSKU4toBaAcN4FdTgfm5W1mC4ouR";
const TON_ADDRESS = "UQCv4mTYxbLOKZBDL_b_jckLV3ev0SLA-demExEBdbkivm0W";

const EVM_ADDRESS = "0xc8b1e10d011aceed84f4cdba66ca175bd6552a36";
const NEAR_ADDRESS = "pablofork.near";

function assertValid<I, O>(name: string, validator: Validator<I, O>, value: unknown): void {
  const result = validator.validate(value);
  const issues = "issues" in result ? result.issues : undefined;
  expect(issues, `${name}: ${JSON.stringify(issues)}`).toBeUndefined();
}

/**
 * Read an intent as a plain bag of fields. `Intent` is a union whose members have no index
 * signature, and these tests deliberately assert on fields the union does not narrow to —
 * including asserting that a field is ABSENT, which is the point for `memo`/`storage_deposit`.
 */
function fields(intent: Intent): Record<string, unknown> {
  return intent as unknown as Record<string, unknown>;
}

function omft(over: Partial<Parameters<typeof buildWithdrawSignRequest>[0]> = {}) {
  return buildWithdrawSignRequest({
    signerId: SIGNER,
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

function nearNative(over: Partial<Parameters<typeof buildWithdrawSignRequest>[0]> = {}) {
  return buildWithdrawSignRequest({
    signerId: SIGNER,
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

function nearUnwrap(over: Partial<Parameters<typeof buildWithdrawSignRequest>[0]> = {}) {
  return buildWithdrawSignRequest({
    signerId: SIGNER,
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

/** Assemble a submit-ready MultiPayload through the SDK, with a placeholder signature. */
function assembleNep413(req: WithdrawSignRequest): unknown {
  const mp = prepareBroadcastRequest.prepareSwapSignedData(
    {
      type: "NEP413",
      signatureData: {
        accountId: SIGNER,
        publicKey: "ed25519:8rVvtHWFr8hasdQGGD5WiQBTyr4iH2ruEPPVfj491RPN",
        signature: Buffer.from(new Uint8Array(64)).toString("base64"),
      },
      signedData: req.nep413,
    },
    { userAddress: SIGNER, userChainType: "near" }
  );
  return JSON.parse(JSON.stringify(mp));
}

function assembleErc191(req: WithdrawSignRequest): unknown {
  const mp = prepareBroadcastRequest.prepareSwapSignedData(
    {
      type: "ERC191",
      signatureData: `0x${"11".repeat(64)}1b`,
      signedData: { message: req.erc191Message },
    },
    { userAddress: EVM_ADDRESS, userChainType: "evm" }
  );
  return JSON.parse(JSON.stringify(mp));
}

describe("omft route (PoA bridge → external chain)", () => {
  it("addresses the TOKEN CONTRACT, not the user, and carries the destination in the memo", () => {
    const req = omft();
    expect(req.route).toBe("omft");
    expect(req.intents).toHaveLength(1);

    const intent = fields(req.intents[0]);
    expect(intent.intent).toBe("ft_withdraw");
    expect(intent.token).toBe(USDC_ARB_CONTRACT);
    // THE assertion this file exists for: receiver_id is the token, repeated.
    expect(intent.receiver_id).toBe(USDC_ARB_CONTRACT);
    expect(intent.receiver_id).not.toBe(EVM_ADDRESS);
    expect(intent.memo).toBe(`WITHDRAW_TO:${EVM_ADDRESS}`);
    expect(intent.min_gas).toBe(WITHDRAW_MIN_GAS);
  });

  it("converts to base units by truncation, never float multiplication", () => {
    // 1.1 * 1e6 is 1100000.0000000002 in IEEE-754; the string path must not see that.
    expect(omft({ qty: 1.1 }).amount).toBe("1100000");
    // Truncates, does not round up. Asserted on the zero-fee route because a single base unit
    // can never clear a bridge fee — see "refuses an amount the fee would swallow whole".
    expect(nearNative({ qty: 0.0000015 }).amount).toBe("1");
  });

  it("validates against the canonical ft_withdraw validator", () => {
    assertValid("IntentFtWithdraw", IntentFtWithdrawValidator, omft().intents[0]);
  });
});

describe("near-native route (NEP-141 → NEAR account)", () => {
  it("addresses the USER in the very field omft uses for the token, and sends no memo", () => {
    const req = nearNative();
    expect(req.route).toBe("near-native");

    const intent = fields(req.intents[0]);
    expect(intent.intent).toBe("ft_withdraw");
    expect(intent.token).toBe("usdt.tether-token.near");
    // The mirror image of the omft assertion above. Same intent, same field, opposite meaning.
    expect(intent.receiver_id).toBe(NEAR_ADDRESS);
    expect(intent.memo).toBeUndefined();
    // Never set: covering an unregistered destination spends the user's wNEAR with no refund.
    expect(intent.storage_deposit).toBeUndefined();
  });

  it("validates against the canonical ft_withdraw validator", () => {
    assertValid("IntentFtWithdraw", IntentFtWithdrawValidator, nearNative().intents[0]);
  });
});

// D-384. The same omft token, sent to a NEAR account instead of across the bridge: it must be
// the `near-native` shape, because the omft shape to a NEAR account would hand the funds to the
// bridge with a memo naming an address on the wrong chain.
describe("omft token to NEAR (D-384)", () => {
  // USDC on Solana: a PoA build a NEAR account can register with (NEAR_REGISTRABLE_OMFT).
  const USDC_SOL = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";
  const USDC_SOL_CONTRACT = "sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";
  const toNear = (over: Partial<Parameters<typeof buildWithdrawSignRequest>[0]> = {}) =>
    omft({ tokenId: USDC_SOL, chainId: "near:mainnet", destinationAddress: NEAR_ADDRESS, ...over });

  it("builds the near-native shape for the omft contract: the user as receiver, no memo", () => {
    const req = toNear();
    expect(req.route).toBe("near-native");

    const intent = fields(req.intents[0]);
    expect(intent.intent).toBe("ft_withdraw");
    expect(intent.token).toBe(USDC_SOL_CONTRACT);
    expect(intent.receiver_id).toBe(NEAR_ADDRESS);
    expect(intent.memo).toBeUndefined();
    expect(intent.storage_deposit).toBeUndefined();
    assertValid("IntentFtWithdraw", IntentFtWithdrawValidator, req.intents[0]);
  });

  it("has no bridge fee to clear: an amount the bridge route refuses goes through", () => {
    // One base unit: below Solana's 30000 bridge fee, so the native route refuses it.
    expect(() =>
      omft({
        tokenId: USDC_SOL,
        chainId: "sol:mainnet",
        destinationAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
        qty: 0.000001,
      })
    ).toThrow(/bridge fee/);
    expect(toNear({ qty: 0.000001 }).amount).toBe("1");
  });

  it("refuses the token contract itself as the receiver", () => {
    // That is the bridge's own withdrawal shape, minus the memo saying where to.
    expect(() => toNear({ destinationAddress: USDC_SOL_CONTRACT })).toThrow(/token contract itself/);
  });

  it("refuses a NEAR account signed into the bridge route (the late-check race)", () => {
    // What the envelope would sign if a NEAR-cleared address reached the bridge route: a memo
    // the bridge burns toward nobody. The screen checks per chain; this is the backstop.
    expect(() => omft({ destinationAddress: NEAR_ADDRESS })).toThrow(/not a valid address on eth:42161/);
  });

  it.each(["intents.near", "intentfolio-staging.near"])(
    "refuses %s as a NEAR receiver, on every NEAR route",
    (receiver) => {
      expect(() => toNear({ destinationAddress: receiver })).toThrow(/system contract/);
      expect(() => nearNative({ destinationAddress: receiver })).toThrow(/system contract/);
      expect(() => nearUnwrap({ destinationAddress: receiver })).toThrow(/system contract/);
    }
  );

  it("does not open NEAR to a token a NEAR account cannot register with", () => {
    expect(() => omft({ chainId: "near:mainnet", destinationAddress: NEAR_ADDRESS })).toThrow(
      /chain mismatch/i
    );
  });

  it("does not open NEAR to a hot-omni token", () => {
    expect(() =>
      buildWithdrawSignRequest({
        signerId: SIGNER,
        tokenId: USDT_TON,
        chainId: "near:mainnet",
        qty: 1.5,
        heldRaw: BigInt(10) ** BigInt(30),
        destinationAddress: NEAR_ADDRESS,
      })
    ).toThrow(/chain mismatch/i);
  });
});

// D-176. NEAR is the only asset that leaves through intents.near's own unwrap rather than
// through a bridge or a token contract, and the reason it needs its own route is delivery:
// `ft_withdraw` of wrap.near would hand the user wNEAR, which most wallets do not show as
// NEAR at all. Getting this wrong is not a misroute, it is a silent downgrade of the asset.
describe("near-unwrap route (wNEAR → native NEAR, D-176)", () => {
  it("names no token and pays the user directly", () => {
    const req = nearUnwrap();
    expect(req.route).toBe("near-unwrap");

    const intent = fields(req.intents[0]);
    expect(intent.intent).toBe("native_withdraw");
    expect(intent.receiver_id).toBe(NEAR_ADDRESS);
    expect(intent.amount).toBe("1500000000000000000000000"); // 1.5 NEAR, 24 decimals
    // Unlike BOTH ft_withdraw routes: the token is implicit (it can only be wNEAR).
    expect(intent.token).toBeUndefined();
    expect(intent.memo).toBeUndefined();
    expect(intent.min_gas).toBeUndefined();
  });

  it("validates against the canonical native_withdraw validator", () => {
    assertValid("IntentNativeWithdraw", IntentNativeWithdrawValidator, nearUnwrap().intents[0]);
  });

  it("is a single intent — no swap, no fee leg", () => {
    expect(nearUnwrap().intents).toHaveLength(1);
  });
});

// Block 4.3.3 gave `hot-omni` real quote hashes. D-147's reasoning did NOT stop being true
// for the other two routes, and this is what stops a later sweep from generalising it: these
// withdrawals are not swaps, so there is no quote for the relay to honour.
describe("the routes that are genuinely not swaps publish no quote (D-147)", () => {
  it("leaves quoteHashes empty on all three", () => {
    expect(omft().quoteHashes).toEqual([]);
    expect(nearNative().quoteHashes).toEqual([]);
    expect(nearUnwrap().quoteHashes).toEqual([]);
  });
});

describe("the two schemes describe the SAME withdrawal", () => {
  it.each([
    ["omft", omft],
    ["near-native", nearNative],
    ["near-unwrap", nearUnwrap],
  ])("%s: NEP-413 and ERC-191 carry identical intents, deadline and signer", (_name, build) => {
    const req = build();
    const nep413Inner = JSON.parse(req.nep413.message);
    const erc191 = JSON.parse(req.erc191Message);

    expect(erc191.intents).toEqual(nep413Inner.intents);
    expect(erc191.signer_id).toBe(nep413Inner.signer_id);
    expect(erc191.deadline).toBe(nep413Inner.deadline);
    // ERC-191 has no sibling fields on the wire, so these MUST live inside the signed JSON.
    expect(erc191.verifying_contract).toBe(req.nep413.recipient);
    expect(erc191.nonce).toBe(Buffer.from(NONCE).toString("base64"));
  });

  it("both address intents.near, which is where the General Balance lives", () => {
    expect(omft().nep413.recipient).toBe("intents.near");
    expect(JSON.parse(omft().erc191Message).verifying_contract).toBe("intents.near");
  });
});

describe("assembled MultiPayloads pass the canonical validators", () => {
  it.each([
    ["omft", omft],
    ["near-native", nearNative],
    ["near-unwrap", nearUnwrap],
  ])("%s", (_name, build) => {
    const req = build();
    assertValid(
      "Nep413DefuseMessage",
      Nep413DefuseMessageFor_DefuseIntentsValidator,
      JSON.parse(req.nep413.message)
    );
    assertValid("MultiPayloadNep413", MultiPayloadNep413Validator, assembleNep413(req));
    assertValid("MultiPayloadErc191", MultiPayloadErc191Validator, assembleErc191(req));
  });
});

describe("guards that turn a silent misroute into a loud failure", () => {
  it("throws when the chain does not match the token's own chain", () => {
    // The intent has nowhere to put a chain, so a mismatch would leave on eth:42161 anyway.
    expect(() => omft({ chainId: "eth:1" })).toThrow(/chain mismatch/i);
  });

  it("throws on hot-omni without a live quote instead of emitting a plausible intent", () => {
    // Buildable since block 4.3.2 (`hot-envelope.ts`), but ONLY from a live quote: the
    // signed intent carries a destination-chain block number and the swap that pays for the
    // relayer's gas, neither of which the registry snapshot has. So there is no fallback —
    // an envelope built without one is refused by the contract, not merely mispriced.
    expect(() =>
      buildWithdrawSignRequest({
        signerId: SIGNER,
        tokenId: USDT_TON,
        chainId: "ton:mainnet",
        qty: 1,
        heldRaw: BigInt(10) ** BigInt(30), // ample — the cap has its own tests (D-303)
        destinationAddress: "UQxxx",
        deadlineSecs: DEADLINE_SECS,
        nonce: NONCE,
      })
    ).toThrow(/needs a live HOT fee quote/);
  });

  it("builds a TON destination now that 4.5 wraps the address in its cell", () => {
    // TON wraps the address in a cell rather than base58-ing raw bytes; treating it as EVM
    // would have produced a well-formed string addressed to nobody, which is why this used to
    // throw. What it must NOT do is accept a malformed address — asserted right below.
    const req = buildTon({ destinationAddress: TON_ADDRESS });
    expect(req.route).toBe("hot-omni");
    expect(JSON.parse((req.intents.at(-1) as unknown as { msg: string }).msg).receiver_id).toMatch(
      /^[1-9A-HJ-NP-Za-km-z]+$/
    );
  });

  it("still throws on a TON address it cannot vouch for, before anything is signed", () => {
    expect(() => buildTon({ destinationAddress: "UQxxx" })).toThrow(/EQ…\/UQ… form/);
  });

  function buildTon(overrides: { destinationAddress: string }) {
    return buildWithdrawSignRequest({
      signerId: SIGNER,
      tokenId: USDT_TON,
      chainId: "ton:mainnet",
      qty: 5, // clears USDT(TON)'s 1.000000 minimum, so the address is what decides
      heldRaw: BigInt(10) ** BigInt(30), // ample — the cap has its own tests (D-303)
      ...overrides,
      deadlineSecs: DEADLINE_SECS,
      nonce: NONCE,
      hotFee: {
        relayerFeeRaw: "40000000",
        blockNumber: "0",
        nativeAssetId: "nep245:v2_1.omni.hot.tg:1117_",
        payment: "swap",
        swap: {
          quoteHash: "qh",
          assetIn: USDT_TON,
          assetOut: "nep245:v2_1.omni.hot.tg:1117_",
          amountIn: "1000",
          amountOut: "40000000",
          expiresAt: "",
        },
      },
    });
  }

  it("throws below the bridge minimum, measured on the NET as upstream measures it", () => {
    // BTC: fee 1500, minWithdrawalRaw 700, decimals 8. 2000 base units clears the fee but
    // nets 500 — under the minimum. Checking the GROSS (as we did before) would have let this
    // through, which is exactly the gap upstream's `validateWithdrawal` closes by validating
    // `amount - fee` (intents-sdk 0.76.0 sdk.ts).
    expect(() =>
      buildWithdrawSignRequest({
        signerId: SIGNER,
        tokenId: BTC,
        chainId: "btc:mainnet",
        qty: 0.00002,
        heldRaw: BigInt(10) ** BigInt(30), // ample — the cap has its own tests (D-303)
        destinationAddress: "bc1qxxx",
        deadlineSecs: DEADLINE_SECS,
        nonce: NONCE,
      })
    ).toThrow(/below the bridge minimum/i);
  });

  it("refuses an amount the fee would swallow whole, which settles and delivers nothing", () => {
    // The failure this exists for: 0.001 USDC on Arbitrum against a 0.0053 fee. It clears
    // `minWithdrawalRaw` (1 base unit) comfortably, settles perfectly, and delivers NOTHING —
    // the bridge keeps all of it. Mirrors upstream's `FeeExceedsAmountError`.
    expect(() => omft({ qty: 0.001 })).toThrow(/does not cover/i);
    // The boundary is exclusive: exactly the fee still delivers zero.
    expect(() => omft({ qty: 0.0053 })).toThrow(/does not cover/i);
    // One base unit above the fee clears it, and then the minimum applies to what is left.
    expect(omft({ qty: 0.005301 }).amount).toBe("5301");
  });

  it("throws when the amount rounds away to nothing", () => {
    expect(() => omft({ qty: 0.0000001 })).toThrow(/rounds to zero/i);
  });

  it("throws for a token with no withdrawal route", () => {
    expect(() => omft({ tokenId: "nep141:not-a-token.near" })).toThrow(/no withdrawal route/i);
  });
});

describe("the amount is capped at the balance read before signing (D-303)", () => {
  // Asserted on the SIGNED message, not on `req.amount`: the summary field agreeing proves
  // nothing if the intent was built from a different figure.
  function signedIntent(req: WithdrawSignRequest): Record<string, unknown> {
    return JSON.parse(req.nep413.message).intents[0];
  }

  it("signs 0.3 NEAR as exactly 3 × 10^23 yocto, not the double's expansion", () => {
    const req = nearUnwrap({ qty: 0.3 });
    expect(signedIntent(req).amount).toBe("300000000000000000000000");
    expect(req.amount).toBe("300000000000000000000000");
  });

  it("Max on a float balance signs the exact balance, not the float (near-unwrap)", () => {
    // `Number(raw) / 1e24` is how the app holds this balance; its shortest spelling is
    // 1098766 yocto ABOVE the real figure, which the Verifier would refuse outright.
    const raw = BigInt("123456789012345678901234");
    const req = nearUnwrap({ qty: Number(raw) / 1e24, heldRaw: raw });
    expect(signedIntent(req).amount).toBe(raw.toString());
    expect(req.amount).toBe(raw.toString());
  });

  it("the capped figure is what the omft intent signs", () => {
    // 6 decimals only reach the noise band at 10^12 base units; one unit over snaps down.
    const held = BigInt(10) ** BigInt(12) - BigInt(1);
    const req = omft({ qty: 1_000_000, heldRaw: held });
    expect(signedIntent(req).amount).toBe(held.toString());
  });

  it("refuses an amount really above the balance instead of signing a smaller one", () => {
    expect(() => omft({ qty: 1.5, heldRaw: BigInt(1_000_000) })).toThrow(
      AmountExceedsBalanceError
    );
  });
});

describe("destination memo (mirrors the SDK's createWithdrawMemo)", () => {
  it("appends a destination tag as a third segment", () => {
    expect(buildWithdrawMemo(EVM_ADDRESS, "12345")).toBe(`WITHDRAW_TO:${EVM_ADDRESS}:12345`);
  });

  it("omits the segment when there is no tag", () => {
    expect(buildWithdrawMemo(EVM_ADDRESS)).toBe(`WITHDRAW_TO:${EVM_ADDRESS}`);
    expect(buildWithdrawMemo(EVM_ADDRESS, "")).toBe(`WITHDRAW_TO:${EVM_ADDRESS}`);
  });

  it("strips the bitcoincash: prefix, as upstream does", () => {
    expect(buildWithdrawMemo("bitcoincash:qzm47qz5ue99y9yl4aca7jnz7dwgdenl85jkfx3znl")).toBe(
      "WITHDRAW_TO:qzm47qz5ue99y9yl4aca7jnz7dwgdenl85jkfx3znl"
    );
  });

  it("threads the tag through the built intent", () => {
    const intent = fields(omft({ destinationMemo: "98765" }).intents[0]);
    expect(intent.memo).toBe(`WITHDRAW_TO:${EVM_ADDRESS}:98765`);
  });
});
