import { describe, it, expect, vi } from "vitest";
import type { Intent } from "@defuse-protocol/contract-types";
import {
  IntentMtWithdrawValidator,
  IntentTokenDiffValidator,
  Nep413DefuseMessageFor_DefuseIntentsValidator,
  MultiPayloadNep413Validator,
  MultiPayloadErc191Validator,
  type Validator,
} from "@defuse-protocol/contract-types/validate";
import { prepareBroadcastRequest } from "@defuse-protocol/internal-utils";
import {
  buildHotWithdrawIntents,
  encodeHotReceiver,
  hotOmniTokenId,
  hotTokenFeeRaw,
  HOT_BRIDGE_RECEIVER_ID,
  HOT_MIN_GAS,
  HOT_OMNI_CONTRACT_ID,
} from "./hot-envelope";
import { fetchHotWithdrawalFee, hotNativeAssetId, type HotFeeDeps, type HotFeeDetail } from "./hot-fee";
import { buildWithdrawSignRequest } from "./withdraw-envelope";
import { withdrawalRegistry } from "./withdrawal-registry";

// Offline proof for the `hot-omni` money path (008.plan §Fase 4, block 4.3.2).
//
// The mirror ITSELF is proved in `hot-envelope.differential.test.ts`, against the real SDK.
// This file proves the two things the SDK cannot: that our SUBTRACT convention debits
// exactly what the user typed (the session-103 decision), and that the guards refuse a quote
// that does not belong to this withdrawal.

const USDC_POLYGON = "nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L";
const POL_NATIVE = "nep245:v2_1.omni.hot.tg:137_11111111111111111111";
const BNB_NATIVE = "nep245:v2_1.omni.hot.tg:56_11111111111111111111";
const USDT_TON = "nep245:v2_1.omni.hot.tg:1117_3tsdfyziyc7EJbP2aULWSKU4toBaAcN4FdTgfm5W1mC4ouR";
const TON_NATIVE = "nep245:v2_1.omni.hot.tg:1117_";
const STELLAR_ADDRESS = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const TON_ADDRESS = "UQCv4mTYxbLOKZBDL_b_jckLV3ev0SLA-demExEBdbkivm0W";

/** The destination each chain's own wallets hand out — see the coverage test below. */
function addressFor(chainId: string): string {
  if (chainId === "stellar:mainnet") return STELLAR_ADDRESS;
  if (chainId === "ton:mainnet") return TON_ADDRESS;
  return EVM_ADDRESS;
}

const EVM_ADDRESS = "0xc8b1e10d011aceed84f4cdba66ca175bd6552a36";
/** base58 of the 20 raw bytes of EVM_ADDRESS — NOT of the "0x…" text. */
const EVM_RECEIVER_B58 = "3oAoMx97131Ye4GEhUAzRkruSGMB";

const SIGNER = "alice.near";
const DEADLINE_SECS = 1_800_000_000;
const NONCE = new Uint8Array(32).fill(7);

const RELAYER_FEE = "26000000000000000"; // 0.026 POL of destination-chain gas
const BLOCK_NUMBER = "78123456";

/** A quote as `hot-fee.ts` produces it for a NON-native token: fee paid by a solver swap. */
function nonNativeFee(over: Partial<HotFeeDetail> = {}): HotFeeDetail {
  return {
    relayerFeeRaw: RELAYER_FEE,
    blockNumber: BLOCK_NUMBER,
    nativeAssetId: POL_NATIVE,
    payment: "swap",
    swap: {
      quoteHash: "qh-1",
      assetIn: USDC_POLYGON,
      assetOut: POL_NATIVE,
      amountIn: "4321",
      amountOut: "26000000000000000",
      expiresAt: "2026-08-05T12:00:00.000Z",
    },
    ...over,
  };
}

/** A quote for the chain's OWN gas token: no swap, the bridge deducts on the far side. */
function nativeFee(over: Partial<HotFeeDetail> = {}): HotFeeDetail {
  return {
    relayerFeeRaw: RELAYER_FEE,
    blockNumber: BLOCK_NUMBER,
    nativeAssetId: POL_NATIVE,
    payment: "in-kind",
    swap: null,
    ...over,
  };
}

function fields(intent: Intent): Record<string, unknown> {
  return intent as unknown as Record<string, unknown>;
}

function assertValid<I, O>(name: string, validator: Validator<I, O>, value: unknown): void {
  const result = validator.validate(value);
  const issues = "issues" in result ? result.issues : undefined;
  expect(issues, `${name}: ${JSON.stringify(issues)}`).toBeUndefined();
}

function assertInvalid<I, O>(name: string, validator: Validator<I, O>, value: unknown): void {
  const result = validator.validate(value);
  const issues = "issues" in result ? result.issues : undefined;
  expect(issues, `${name} was expected to REJECT this payload`).toBeDefined();
}

describe("hotOmniTokenId", () => {
  it("strips the contract prefix the registry key carries", () => {
    expect(hotOmniTokenId(USDC_POLYGON)).toBe("137_qiStmoQJDQPTebaPjgx5VBxZv6L");
    // TON's native carries an EMPTY address after the chain prefix — a real entry, not a
    // truncated one. Anything that "cleans it up" to a bare chain id would misroute.
    expect(hotOmniTokenId(TON_NATIVE)).toBe("1117_");
  });

  it("refuses an asset id from another contract instead of slicing blindly", () => {
    expect(() => hotOmniTokenId("nep141:usdt.tether-token.near")).toThrow(/not a .* asset id/);
  });
});

describe("encodeHotReceiver", () => {
  it("base58-encodes the address BYTES, not its text", () => {
    expect(encodeHotReceiver("eth:137", EVM_ADDRESS)).toBe(EVM_RECEIVER_B58);
    // The bytes are what is encoded, so a checksummed address is the same destination.
    expect(encodeHotReceiver("eth:137", "0xC8b1e10D011aCeed84f4CDbA66cA175Bd6552a36")).toBe(
      EVM_RECEIVER_B58
    );
  });

  it("refuses anything that is not a 20-byte EVM address", () => {
    expect(() => encodeHotReceiver("eth:137", "0xdeadbeef")).toThrow(/20-byte EVM address/);
    expect(() => encodeHotReceiver("eth:137", "pablofork.near")).toThrow(/20-byte EVM address/);
  });

  // TON was the last chain this function refused outright; 4.5 built its cell. Like Stellar,
  // it now refuses for a STRICTER reason — an address it cannot vouch for — instead of
  // refusing the chain. The round trip against the SDK lives in the differential test.
  it("encodes TON, and rejects a malformed address instead of the chain", () => {
    const address = "UQCv4mTYxbLOKZBDL_b_jckLV3ev0SLA-demExEBdbkivm0W";
    expect(encodeHotReceiver("ton:mainnet", address)).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    expect(() => encodeHotReceiver("ton:mainnet", "UQAbc")).toThrow(/EQ…\/UQ… form/);
  });

  it("refuses a chain with no branch at all, rather than guessing at its bytes", () => {
    // The generic refusal still has to exist: `hotReceiverEncodable` is what `withdraw-flag`
    // asks before opening the real path, and a chain added to the registry without a branch
    // here must land on this throw and not on the EVM one.
    expect(() => encodeHotReceiver("sol:mainnet", "pablofork.near")).toThrow(/not implemented/);
  });

  // Stellar was in the line above until 4.4 built its XDR ScVal branch. It now refuses for a
  // STRICTER reason — a bad address, caught by the StrKey checksum — instead of refusing the
  // whole chain. The round-trip against the SDK lives in the differential test.
  it("encodes Stellar, and rejects a malformed account instead of the chain", () => {
    const account = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
    expect(encodeHotReceiver("stellar:mainnet", account)).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    expect(() => encodeHotReceiver("stellar:mainnet", "GABC")).toThrow(
      /not a Stellar account address/
    );
  });
});

describe("hotTokenFeeRaw", () => {
  it("reads the swap's input when there is a swap, and the relayer fee when there is not", () => {
    expect(hotTokenFeeRaw(nonNativeFee())).toBe("4321");
    expect(hotTokenFeeRaw(nativeFee())).toBe(RELAYER_FEE);
    expect(hotTokenFeeRaw(nativeFee({ relayerFeeRaw: "0" }))).toBe("0");
  });

  // The number the modal shows and the number the envelope charges must be the SAME number.
  // They are computed in two places (hot-fee.ts reports it, hot-envelope.ts spends it), so
  // this pins them together rather than trusting that they were written to agree.
  it("agrees with what fetchHotWithdrawalFee reported for the same quote", async () => {
    const deps: HotFeeDeps = {
      evmGas: vi.fn(async () => ({
        gasPriceWei: BigInt(100_000_000),
        blockNumber: BigInt(78_123_456),
      })),
      quote: vi.fn(async () => ({
        quote_hash: "qh-1",
        defuse_asset_identifier_in: USDC_POLYGON,
        defuse_asset_identifier_out: POL_NATIVE,
        amount_in: "4321",
        amount_out: "26000000000000000",
        expiration_time: "2026-08-05T12:00:00.000Z",
      })) as unknown as HotFeeDeps["quote"],
    };

    const nonNative = await fetchHotWithdrawalFee({ tokenId: USDC_POLYGON, deps });
    expect(nonNative).not.toBeNull();
    expect(hotTokenFeeRaw(nonNative!.hot)).toBe(nonNative!.feeRaw);

    const native = await fetchHotWithdrawalFee({ tokenId: POL_NATIVE, deps });
    expect(native).not.toBeNull();
    expect(hotTokenFeeRaw(native!.hot)).toBe(native!.feeRaw);

    // D-251's path, held to the same standard as the other two.
    const fromBalance = await fetchHotWithdrawalFee({
      tokenId: USDC_POLYGON,
      nativeBalanceRaw: "26000000000000000",
      deps,
    });
    expect(fromBalance!.hot.payment).toBe("native-balance");
    expect(hotTokenFeeRaw(fromBalance!.hot)).toBe(fromBalance!.feeRaw);
  });

  // 🔴 D-251's landmine, and the reason `payment` exists at all. Before it, `swap === null`
  // meant "the token IS the gas" and this returned `relayerFeeRaw` — a figure denominated in
  // the DESTINATION CHAIN's native. For USDT(TON) that is 40000000 base units of GRAM read as
  // 40 USDT: eight times a 5 USDT withdrawal, shown as the fee and used as the floor.
  it("charges the withdrawn token NOTHING when the gas came from the signer's balance", () => {
    const fee = nativeFee({ payment: "native-balance", relayerFeeRaw: "40000000" });
    expect(hotTokenFeeRaw(fee)).toBe("0");
    expect(hotTokenFeeRaw(fee)).not.toBe("40000000");
  });

  // A quote that names a payment it does not carry is not one to guess about: returning
  // `relayerFeeRaw` would restate another token's units, and returning "0" would hand the
  // user a free withdrawal the contract then refuses.
  it("refuses a quote that claims a swap it does not carry", () => {
    expect(() => hotTokenFeeRaw(nativeFee({ payment: "swap" }))).toThrow(/claims a fee swap/);
  });
});

describe("non-native withdrawal (the 9 tokens that buy their gas with a swap)", () => {
  const built = buildHotWithdrawIntents({
    tokenId: USDC_POLYGON,
    chainId: "eth:137",
    amountRaw: "1000000",
    destinationAddress: EVM_ADDRESS,
    fee: nonNativeFee(),
  });

  it("emits token_diff FIRST, then mt_withdraw, as upstream orders them", () => {
    expect(built.intents).toHaveLength(2);
    expect(fields(built.intents[0]).intent).toBe("token_diff");
    expect(fields(built.intents[1]).intent).toBe("mt_withdraw");
  });

  it("sells exactly the swap's input and buys exactly its output", () => {
    expect(fields(built.intents[0]).diff).toEqual({
      [USDC_POLYGON]: "-4321",
      [POL_NATIVE]: "26000000000000000",
    });
  });

  // 🔴 THE ASSERTION THE SESSION-103 DECISION EXISTS FOR. If someone later "fixes" the
  // builder to mirror `createWithdrawalIntents` (`amount + fee`), this is what goes red.
  it("SUBTRACTS the fee: the balance is debited exactly what the user typed", () => {
    const mt = fields(built.intents[1]);
    // The user typed 1.000000 USDC. The swap eats 4321 base units of it…
    expect((mt.amounts as string[])[0]).toBe(String(1_000_000 - 4321));
    // …and the two legs together add back up to the typed amount, with nothing on top.
    const soldByTheSwap = BigInt(4321);
    const movedByTheWithdraw = BigInt((mt.amounts as string[])[0]);
    expect(soldByTheSwap + movedByTheWithdraw).toBe(BigInt(1_000_000));
    expect(built.withdrawnRaw).toBe(String(1_000_000 - 4321));
    expect(built.tokenFeeRaw).toBe("4321");
  });

  it("carries the relayer's gas as a second entry, in the CHAIN's native units", () => {
    const mt = fields(built.intents[1]);
    expect(mt.token_ids).toEqual([
      "137_qiStmoQJDQPTebaPjgx5VBxZv6L",
      "137_11111111111111111111",
    ]);
    expect((mt.amounts as string[])[1]).toBe(RELAYER_FEE);
  });

  it("addresses the refuel contract and hides the user inside msg", () => {
    const mt = fields(built.intents[1]);
    expect(mt.receiver_id).toBe(HOT_BRIDGE_RECEIVER_ID);
    expect(mt.receiver_id).not.toBe(EVM_ADDRESS);
    expect(mt.token).toBe(HOT_OMNI_CONTRACT_ID);
    // `msg` is a STRING inside the signed payload, so its key order and the JSON types of
    // its values are part of the signed bytes — `block_number` is a number, not a string.
    expect(mt.msg).toBe(
      `{"receiver_id":"${EVM_RECEIVER_B58}","amount_native":"${RELAYER_FEE}","block_number":${BLOCK_NUMBER}}`
    );
  });

  it("sets min_gas, which the mirrored primitive does NOT set", () => {
    // It comes from intents-sdk's wrapper (`hot-bridge.js:109`), so the differential test is
    // blind to it. Ours to remember, exactly as on the `omft` route.
    expect(fields(built.intents[1]).min_gas).toBe(HOT_MIN_GAS);
    expect(HOT_MIN_GAS).toBe("91300000000000");
  });

  it("validates against the canonical validators", () => {
    assertValid("IntentTokenDiff", IntentTokenDiffValidator, built.intents[0]);
    assertValid("IntentMtWithdraw", IntentMtWithdrawValidator, built.intents[1]);
  });

  // A validator that accepts everything proves nothing, so it is shown rejecting.
  it("uses validators that actually reject malformed payloads", () => {
    assertInvalid("IntentMtWithdraw", IntentMtWithdrawValidator, {
      ...fields(built.intents[1]),
      amounts: "1000000", // must be an array
    });
    assertInvalid("IntentMtWithdraw", IntentMtWithdrawValidator, {
      ...fields(built.intents[1]),
      intent: "ft_withdraw",
    });
    assertInvalid("IntentTokenDiff", IntentTokenDiffValidator, {
      ...fields(built.intents[0]),
      diff: { [USDC_POLYGON]: -4321 }, // deltas are strings on the wire
    });
  });
});

// D-251. Same two-entry `mt_withdraw` as the swap path, minus the swap — the bridge cannot
// tell where the native came from, only that the balance covers both entries.
describe("non-native withdrawal paid from the signer's own gas balance", () => {
  const built = buildHotWithdrawIntents({
    tokenId: USDT_TON,
    chainId: "ton:mainnet",
    amountRaw: "5000000", // 5 USDT
    destinationAddress: TON_ADDRESS,
    fee: {
      relayerFeeRaw: "40000000", // 0.04 GRAM
      blockNumber: "0",
      nativeAssetId: TON_NATIVE,
      payment: "native-balance",
      swap: null,
    },
  });

  it("emits mt_withdraw ALONE — there is no swap to publish", () => {
    expect(built.intents).toHaveLength(1);
    expect(fields(built.intents[0]).intent).toBe("mt_withdraw");
  });

  // 🔴 The money assertion. Nothing was sold, so every base unit the user typed leaves as the
  // withdrawal; the gas rides as a SECOND entry in a different token. Subtracting the fee
  // here — the swap path's arithmetic — would silently short the user by 40 USDT.
  it("withdraws the full typed amount and debits the gas separately", () => {
    const mt = fields(built.intents[0]);
    expect(built.withdrawnRaw).toBe("5000000");
    expect(built.tokenFeeRaw).toBe("0");
    expect(mt.token_ids).toEqual([
      "1117_3tsdfyziyc7EJbP2aULWSKU4toBaAcN4FdTgfm5W1mC4ouR",
      "1117_",
    ]);
    expect(mt.amounts).toEqual(["5000000", "40000000"]);
  });

  // The bridge learns the fee from `msg.amount_native` regardless of provenance, so this
  // stays byte-identical to what the swap path would have signed.
  it("still declares the fee to the bridge in amount_native", () => {
    expect(fields(built.intents[0]).msg).toContain('"amount_native":"40000000"');
  });
});

describe("native withdrawal (BNB / AVAX / POL: no swap, no second entry)", () => {
  const built = buildHotWithdrawIntents({
    tokenId: POL_NATIVE,
    chainId: "eth:137",
    amountRaw: "5000000000000000000",
    destinationAddress: EVM_ADDRESS,
    fee: nativeFee(),
  });

  it("emits a SINGLE intent with a single token id", () => {
    expect(built.intents).toHaveLength(1);
    const mt = fields(built.intents[0]);
    expect(mt.token_ids).toEqual(["137_11111111111111111111"]);
    expect(mt.amounts).toEqual(["5000000000000000000"]);
  });

  // Same money rule as the non-native case, reached a different way: nothing is subtracted
  // in the intent because the bridge deducts `amount_native` on the far side. The debit is
  // still exactly what was typed, and delivery is still `qty - fee`.
  it("debits the typed amount and lets the bridge deduct the fee on delivery", () => {
    expect(built.withdrawnRaw).toBe("5000000000000000000");
    expect(built.tokenFeeRaw).toBe(RELAYER_FEE);
    expect(fields(built.intents[0]).msg).toContain(`"amount_native":"${RELAYER_FEE}"`);
  });

  it("validates against the canonical mt_withdraw validator", () => {
    assertValid("IntentMtWithdraw", IntentMtWithdrawValidator, built.intents[0]);
  });
});

describe("zero relayer fee (Avalanche and Optimism, when gas is free enough)", () => {
  it("emits one entry and no swap, mirroring upstream's `feeAmount > 0` condition", () => {
    const built = buildHotWithdrawIntents({
      tokenId: USDC_POLYGON,
      chainId: "eth:137",
      amountRaw: "1000000",
      destinationAddress: EVM_ADDRESS,
      fee: nativeFee({ relayerFeeRaw: "0", swap: null }),
    });
    expect(built.intents).toHaveLength(1);
    expect(fields(built.intents[0]).token_ids).toEqual(["137_qiStmoQJDQPTebaPjgx5VBxZv6L"]);
    expect(fields(built.intents[0]).amounts).toEqual(["1000000"]);
    expect(fields(built.intents[0]).msg).toContain('"amount_native":"0"');
    expect(built.tokenFeeRaw).toBe("0");
  });
});

describe("guards on the quote itself", () => {
  it("refuses a quote whose native belongs to a different chain", () => {
    // A quote left over from a BNB withdrawal would be a perfectly valid quote — for gas
    // the Polygon relayer cannot spend.
    expect(() =>
      buildHotWithdrawIntents({
        tokenId: USDC_POLYGON,
        chainId: "eth:137",
        amountRaw: "1000000",
        destinationAddress: EVM_ADDRESS,
        fee: nonNativeFee({ nativeAssetId: BNB_NATIVE }),
      })
    ).toThrow(/belongs to another chain/);
  });

  it("refuses a swap that would sell an asset other than the one being withdrawn", () => {
    expect(() =>
      buildHotWithdrawIntents({
        tokenId: USDC_POLYGON,
        chainId: "eth:137",
        amountRaw: "1000000",
        destinationAddress: EVM_ADDRESS,
        fee: nonNativeFee({
          swap: { ...nonNativeFee().swap!, assetIn: "nep141:usdt.tether-token.near" },
        }),
      })
    ).toThrow(/sell the wrong asset/);
  });

  it("refuses an amount the swap would consume entirely", () => {
    expect(() =>
      buildHotWithdrawIntents({
        tokenId: USDC_POLYGON,
        chainId: "eth:137",
        amountRaw: "4321",
        destinationAddress: EVM_ADDRESS,
        fee: nonNativeFee(),
      })
    ).toThrow(/leaves nothing/);
  });

  it("refuses a block number that would not survive JSON's number type", () => {
    expect(() =>
      buildHotWithdrawIntents({
        tokenId: POL_NATIVE,
        chainId: "eth:137",
        amountRaw: "5000000000000000000",
        destinationAddress: EVM_ADDRESS,
        fee: nativeFee({ blockNumber: "99007199254740993" }),
      })
    ).toThrow(/unusable block number/);
  });
});

describe("the full envelope through buildWithdrawSignRequest", () => {
  function hotEnvelope(over: Partial<Parameters<typeof buildWithdrawSignRequest>[0]> = {}) {
    return buildWithdrawSignRequest({
      signerId: SIGNER,
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

  // D-303: the cap applies to the GROSS, and the signed `mt_withdraw` is built from the
  // capped figure — not from what was typed. 6 decimals reach the noise band at 10^12 units.
  it("builds the signed intents from the capped amount, not the typed one", () => {
    const held = BigInt(10) ** BigInt(12) - BigInt(1);
    const req = hotEnvelope({ qty: 1_000_000, heldRaw: held });
    expect(req.amount).toBe(held.toString());
    const signed = JSON.parse(req.nep413.message).intents;
    const mtWithdraw = signed.find((i: { intent: string }) => i.intent === "mt_withdraw");
    expect(mtWithdraw.amounts[0]).toBe((held - BigInt(4321)).toString());
  });

  it("is now a buildable route, and reports the GROSS debit as `amount`", () => {
    const req = hotEnvelope();
    expect(req.route).toBe("hot-omni");
    expect(req.intents).toHaveLength(2);
    // `amount` is what LEAVES the balance — deliberately not `mt_withdraw.amounts[0]`.
    expect(req.amount).toBe("1000000");
    expect(fields(req.intents[1]).amounts).toEqual([String(1_000_000 - 4321), RELAYER_FEE]);
  });

  // Block 4.3.3: the `token_diff` is a solver swap, so its quote has to travel with the
  // publish or the relay settles the fee leg at a price nobody quoted.
  it("carries the fee swap's quote hash, taken from the very quote that built the swap", () => {
    const fee = nonNativeFee({ swap: { ...nonNativeFee().swap!, quoteHash: "qh-live-77" } });
    const req = hotEnvelope({ hotFee: fee });
    expect(req.quoteHashes).toEqual(["qh-live-77"]);
    // Same object, so the hash and the intent it authorises cannot disagree.
    expect(fields(req.intents[0]).intent).toBe("token_diff");
  });

  it("carries NO quote hash when the withdrawn token is the chain's own gas", () => {
    // Nothing was swapped: the bridge deducts on the far side via `msg.amount_native`.
    const req = hotEnvelope({ tokenId: POL_NATIVE, hotFee: nativeFee(), qty: 1 });
    expect(req.quoteHashes).toEqual([]);
    expect(req.intents).toHaveLength(1);
  });

  it("refuses to build without a live quote instead of falling back to the registry", () => {
    // The registry snapshot has no `blockNumber` and no swap, so an envelope built on it is
    // REFUSED by the contract, not merely mispriced. There is no safe fallback here.
    expect(() => hotEnvelope({ hotFee: undefined })).toThrow(/needs a live HOT fee quote/);
  });

  it("refuses a destination memo, which HOT drops on withdrawal", () => {
    // The opposite of Stellar's deposit path, which requires one (D-240).
    expect(() => hotEnvelope({ destinationMemo: "12345" })).toThrow(/does not carry a destination memo/);
  });

  it("applies the live fee, not the registry snapshot, to the floor checks", () => {
    // USDC(POL) has `withdrawalFeeRaw: "1000"` in the registry and a live 4321 here. An
    // amount between the two must be refused by the LIVE figure.
    expect(() => hotEnvelope({ qty: 0.002 })).toThrow(/does not cover/);
    expect(hotEnvelope({ qty: 0.005 }).amount).toBe("5000");
  });

  it("carries identical intents in both signing schemes and addresses intents.near", () => {
    const req = hotEnvelope();
    const nep413Inner = JSON.parse(req.nep413.message);
    const erc191 = JSON.parse(req.erc191Message);
    expect(erc191.intents).toEqual(nep413Inner.intents);
    expect(erc191.intents).toHaveLength(2);
    expect(req.nep413.recipient).toBe("intents.near");
    expect(erc191.verifying_contract).toBe("intents.near");
  });

  it("assembles into MultiPayloads the canonical validators accept", () => {
    const req = hotEnvelope();
    assertValid(
      "Nep413DefuseMessage",
      Nep413DefuseMessageFor_DefuseIntentsValidator,
      JSON.parse(req.nep413.message)
    );
    assertValid(
      "MultiPayloadNep413",
      MultiPayloadNep413Validator,
      JSON.parse(
        JSON.stringify(
          prepareBroadcastRequest.prepareSwapSignedData(
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
          )
        )
      )
    );
    assertValid(
      "MultiPayloadErc191",
      MultiPayloadErc191Validator,
      JSON.parse(
        JSON.stringify(
          prepareBroadcastRequest.prepareSwapSignedData(
            {
              type: "ERC191",
              signatureData: `0x${"11".repeat(64)}1b`,
              signedData: { message: req.erc191Message },
            },
            { userAddress: EVM_ADDRESS, userChainType: "evm" }
          )
        )
      )
    );
  });
});

describe("coverage: which hot-omni tokens the builder unblocks", () => {
  // The plan's Done for 4.3 counts the Deposit-only SET, which only moves when the feature
  // flag opens (block 4.3.6). What this asserts is the builder-level version of it.
  it("builds an envelope for every hot-omni token in the registry, with none refused", () => {
    const hotTokens = Object.entries(withdrawalRegistry).filter(
      ([, e]) => e.bridgeRoute === "hot-omni"
    );
    expect(hotTokens).toHaveLength(15);

    const refused: string[] = [];
    for (const [tokenId, entry] of hotTokens) {
      const nativeAssetId = hotNativeAssetId(entry.chainId)!;
      const isNative = tokenId === nativeAssetId;
      const fee: HotFeeDetail = {
        relayerFeeRaw: RELAYER_FEE,
        blockNumber: BLOCK_NUMBER,
        nativeAssetId,
        payment: isNative ? "in-kind" : "swap",
        swap: isNative
          ? null
          : {
              quoteHash: "qh",
              assetIn: tokenId,
              assetOut: nativeAssetId,
              amountIn: "1",
              amountOut: RELAYER_FEE,
              expiresAt: "",
            },
      };
      try {
        const built = buildHotWithdrawIntents({
          tokenId,
          chainId: entry.chainId,
          amountRaw: "1000000000000",
          // Each chain gets an address of its OWN family. Handing Stellar an EVM address
          // would put it in `refused` for the wrong reason and read as a green test.
          destinationAddress: addressFor(entry.chainId),
          fee,
        });
        assertValid(`IntentMtWithdraw ${tokenId}`, IntentMtWithdrawValidator, built.intents.at(-1));
      } catch {
        refused.push(tokenId);
      }
    }

    // 11 EVM tokens gained a builder in 4.3.2, Stellar's two in 4.4, and TON's two in 4.5.
    // The empty list is the point: `hot-omni` no longer has a chain we take deposits for and
    // cannot build a withdrawal from. A future registry entry without a branch in
    // `encodeHotReceiver` is what would put a name back in here.
    expect(refused).toEqual([]);
    expect(USDT_TON in withdrawalRegistry && TON_NATIVE in withdrawalRegistry).toBe(true);
  });
});
