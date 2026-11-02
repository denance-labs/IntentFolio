import { describe, it, expect } from "vitest";
import { HotBridge, utils as hotUtils } from "@hot-labs/omni-sdk";
import { Address as TonAddress } from "@ton/core";
import type { Intent } from "@defuse-protocol/contract-types";
import { buildHotWithdrawIntents, encodeHotReceiver, HOT_MIN_GAS } from "./hot-envelope";
import type { HotFeeDetail } from "./hot-fee";

// The proof that `hot-envelope.ts` is a MIRROR and not an interpretation (D-205, block 4.3.2).
//
// `@hot-labs/omni-sdk` is a devDependency and only appears in this file: a devDependency is
// never bundled, so the supply-chain argument that rules out ADOPTING the SDK (229 transitive
// packages reaching the user's browser, `ethers` beside `viem`, the whole Stellar and TON
// stacks) simply does not apply to a test. What we get for that is a build that goes red the
// day HOT changes the shape we depend on — and stays green through the many releases that
// touch Stellar, TON or logging, which is the whole point of pinning the comparison to the
// PRIMITIVE rather than to a wrapper.
//
// ⚠️ WHY THE PRIMITIVE, AND NOT `getGaslessWithdrawIntents` / `createWithdrawalIntents`.
// The two published wrappers disagree with each other about what `amount` means — one adds
// the fee, the other subtracts it — while both call this same primitive. Comparing against
// either wrapper would test somebody's product decision, not the payload shape. Comparing
// against the primitive tests exactly what we mirror. The convention we chose on top of it
// (subtract; session 103) is asserted in `hot-envelope.test.ts` and, from the other side,
// at the bottom of this file.
//
// Constructed with `new HotBridge({})`: no network, no providers, no keys. Verified — if a
// future version demands any of those, this file failing IS the notification.

const bridge = new HotBridge({});

const EVM_ADDRESS = "0xc8b1e10d011aceed84f4cdba66ca175bd6552a36";

/**
 * The two representatives the plan names, each with the plain chain address the SDK takes.
 *
 * The addresses are written out rather than derived with the SDK's own `fromOmni`, which
 * would make the `token_ids` comparison circular: these are the real Polygon contracts, so
 * the SDK independently re-encodes them and has to land on the registry key we already store.
 */
const USDC_POLYGON = {
  defuseAssetId: "nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L",
  chainAddress: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
};
const POL_NATIVE = {
  defuseAssetId: "nep245:v2_1.omni.hot.tg:137_11111111111111111111",
  chainAddress: "native",
};
const HOT_CHAIN_ID = 137;
const CHAIN_ID = "eth:137";

const RELAYER_FEE = "26000000000000000";
const BLOCK_NUMBER = "78123456";
const SWAP_AMOUNT_IN = "4321";

function fields(intent: Intent): Record<string, unknown> {
  return intent as unknown as Record<string, unknown>;
}

/** Ours, minus the field the mirrored primitive does not set (see `min_gas` below). */
function ourMtWithdraw(intents: Intent[]): Record<string, unknown> {
  const mt = { ...fields(intents[intents.length - 1]) };
  delete mt.min_gas;
  return mt;
}

describe("mt_withdraw matches @hot-labs/omni-sdk field for field", () => {
  it("non-native: USDC on Polygon, fee paid by a solver swap", async () => {
    const withdrawnRaw = String(1_000_000 - Number(SWAP_AMOUNT_IN));

    const fee: HotFeeDetail = {
      relayerFeeRaw: RELAYER_FEE,
      blockNumber: BLOCK_NUMBER,
      nativeAssetId: POL_NATIVE.defuseAssetId,
      payment: "swap",
      swap: {
        quoteHash: "qh-1",
        assetIn: USDC_POLYGON.defuseAssetId,
        assetOut: POL_NATIVE.defuseAssetId,
        amountIn: SWAP_AMOUNT_IN,
        amountOut: RELAYER_FEE,
        expiresAt: "2026-08-05T12:00:00.000Z",
      },
    };

    const ours = buildHotWithdrawIntents({
      tokenId: USDC_POLYGON.defuseAssetId,
      chainId: CHAIN_ID,
      amountRaw: "1000000",
      destinationAddress: EVM_ADDRESS,
      fee,
    });

    // The primitive is neutral about the convention, so it is handed the amount that OUR
    // convention puts in the intent. Everything else must then be identical.
    const theirs = await bridge.buildGaslessWithdrawIntent({
      feeToken: "native",
      feeAmount: BigInt(RELAYER_FEE),
      blockNumber: BigInt(BLOCK_NUMBER),
      chain: HOT_CHAIN_ID,
      token: USDC_POLYGON.chainAddress,
      amount: BigInt(withdrawnRaw),
      receiver: EVM_ADDRESS,
    });

    expect(ourMtWithdraw(ours.intents)).toEqual(theirs);
    // `msg` is a JSON string inside a signed payload, so key order and value types are part
    // of the signed bytes. `toEqual` on the parent would compare it as an opaque string, but
    // asserting it explicitly is what makes the failure readable when it moves.
    expect(ourMtWithdraw(ours.intents).msg).toBe(theirs.msg);
  });

  it("native: POL, where the SDK emits a single-entry withdrawal", async () => {
    const fee: HotFeeDetail = {
      relayerFeeRaw: RELAYER_FEE,
      blockNumber: BLOCK_NUMBER,
      nativeAssetId: POL_NATIVE.defuseAssetId,
      payment: "in-kind",
      swap: null,
    };

    const ours = buildHotWithdrawIntents({
      tokenId: POL_NATIVE.defuseAssetId,
      chainId: CHAIN_ID,
      amountRaw: "5000000000000000000",
      destinationAddress: EVM_ADDRESS,
      fee,
    });

    const theirs = await bridge.buildGaslessWithdrawIntent({
      feeToken: "native",
      feeAmount: BigInt(RELAYER_FEE),
      blockNumber: BigInt(BLOCK_NUMBER),
      chain: HOT_CHAIN_ID,
      token: POL_NATIVE.chainAddress,
      amount: BigInt("5000000000000000000"),
      receiver: EVM_ADDRESS,
    });

    expect(ourMtWithdraw(ours.intents)).toEqual(theirs);
    // The arity is the assertion: withdrawing the chain's own gas collapses to ONE entry,
    // and `amount_native` in the msg is what tells the bridge to deliver `amount - fee`.
    expect(theirs.token_ids).toHaveLength(1);
    expect(theirs.amounts).toHaveLength(1);
  });

  it("zero relayer fee: the second entry disappears on a non-native token too", async () => {
    // Upstream's condition is `token !== feeToken && feeAmount > 0n`, not "is it native" —
    // and Avalanche and Optimism really do quote 0 sometimes.
    const ours = buildHotWithdrawIntents({
      tokenId: USDC_POLYGON.defuseAssetId,
      chainId: CHAIN_ID,
      amountRaw: "1000000",
      destinationAddress: EVM_ADDRESS,
      fee: {
        relayerFeeRaw: "0",
        blockNumber: BLOCK_NUMBER,
        nativeAssetId: POL_NATIVE.defuseAssetId,
        payment: "in-kind",
        swap: null,
      },
    });

    const theirs = await bridge.buildGaslessWithdrawIntent({
      feeToken: "native",
      feeAmount: BigInt(0),
      blockNumber: BigInt(BLOCK_NUMBER),
      chain: HOT_CHAIN_ID,
      token: USDC_POLYGON.chainAddress,
      amount: BigInt("1000000"),
      receiver: EVM_ADDRESS,
    });

    expect(ourMtWithdraw(ours.intents)).toEqual(theirs);
    expect(theirs.token_ids).toHaveLength(1);
  });
});

describe("what the differential cannot see", () => {
  it("min_gas: set by intents-sdk's WRAPPER, so ours must carry it and theirs must not", async () => {
    // `hot-bridge.js:109` (`mtWithdrawIntent.min_gas = MIN_GAS_AMOUNT`). Mirroring only the
    // primitive would silently drop it, which is why this is asserted in both directions.
    const theirs = await bridge.buildGaslessWithdrawIntent({
      feeToken: "native",
      feeAmount: BigInt(RELAYER_FEE),
      blockNumber: BigInt(BLOCK_NUMBER),
      chain: HOT_CHAIN_ID,
      token: POL_NATIVE.chainAddress,
      amount: BigInt("5000000000000000000"),
      receiver: EVM_ADDRESS,
    });
    expect("min_gas" in theirs).toBe(false);

    const ours = buildHotWithdrawIntents({
      tokenId: POL_NATIVE.defuseAssetId,
      chainId: CHAIN_ID,
      amountRaw: "5000000000000000000",
      destinationAddress: EVM_ADDRESS,
      fee: {
        relayerFeeRaw: RELAYER_FEE,
        blockNumber: BLOCK_NUMBER,
        nativeAssetId: POL_NATIVE.defuseAssetId,
        payment: "in-kind",
        swap: null,
      },
    });
    expect(fields(ours.intents[0]).min_gas).toBe(HOT_MIN_GAS);
  });

  it("the convention: we hand the primitive a DIFFERENT amount than intents-sdk would", async () => {
    // 🔴 The anti-regression assertion for the session-103 decision, stated against upstream
    // rather than against ourselves. `createWithdrawalIntents` computes
    // `amount + (isNative ? feeAmount : 0n)` where `amount` is what the user RECEIVES; ours
    // is what LEAVES the balance. On a native withdrawal the two produce different intents
    // from the same user input, and that difference is deliberate — see hot-envelope.ts.
    const typed = BigInt("5000000000000000000");

    const upstreamConvention = await bridge.buildGaslessWithdrawIntent({
      feeToken: "native",
      feeAmount: BigInt(RELAYER_FEE),
      blockNumber: BigInt(BLOCK_NUMBER),
      chain: HOT_CHAIN_ID,
      token: POL_NATIVE.chainAddress,
      amount: typed + BigInt(RELAYER_FEE),
      receiver: EVM_ADDRESS,
    });

    const ours = buildHotWithdrawIntents({
      tokenId: POL_NATIVE.defuseAssetId,
      chainId: CHAIN_ID,
      amountRaw: typed.toString(),
      destinationAddress: EVM_ADDRESS,
      fee: {
        relayerFeeRaw: RELAYER_FEE,
        blockNumber: BLOCK_NUMBER,
        nativeAssetId: POL_NATIVE.defuseAssetId,
        payment: "in-kind",
        swap: null,
      },
    });

    expect(upstreamConvention.amounts[0]).toBe((typed + BigInt(RELAYER_FEE)).toString());
    expect((fields(ours.intents[0]).amounts as string[])[0]).toBe(typed.toString());
    // Everything ELSE about the two is identical: the divergence is one number, on purpose.
    expect(ourMtWithdraw(ours.intents)).toEqual({
      ...upstreamConvention,
      amounts: [typed.toString()],
    });
  });
});

// Block 4.4. The Stellar receiver is the one piece of this module that is NOT a shape we can
// eyeball: it is base58 over an XDR ScVal, so a wrong-but-well-formed string is the expected
// failure. Both directions are pinned here — upstream's encoder must agree with ours, and
// upstream's DECODER must give the address back. A mistake that fooled the first check would
// have to fool the inverse too.
describe("Stellar receiver encoding round-trips through the SDK", () => {
  const STELLAR_HOT_CHAIN_ID = 1100;
  const STELLAR_CHAIN_ID = "stellar:mainnet";
  // Real mainnet accounts: the curated USDC issuer, and a second unrelated one so a fluke
  // that happened to work for one key is not mistaken for a correct encoder.
  const ACCOUNTS = [
    "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7",
  ];

  it("produces the byte-identical receiver the SDK's own primitive produces", async () => {
    for (const account of ACCOUNTS) {
      const theirs = await bridge.buildGaslessWithdrawIntent({
        feeToken: "native",
        feeAmount: BigInt(0),
        blockNumber: BigInt(0),
        chain: STELLAR_HOT_CHAIN_ID,
        token: "native",
        amount: BigInt(1_000_000),
        receiver: account,
      });
      // The primitive carries the encoded receiver as `receiver_id` inside the `msg` JSON —
      // which is signed, so this is the exact string that decides where the money lands.
      const theirReceiver = JSON.parse(theirs.msg).receiver_id;
      expect(theirReceiver, account).toBe(encodeHotReceiver(STELLAR_CHAIN_ID, account));
    }
  });

  it("survives the SDK's decoder, so the bytes address the account we were given", () => {
    for (const account of ACCOUNTS) {
      const encoded = encodeHotReceiver(STELLAR_CHAIN_ID, account);
      expect(hotUtils.decodeReceiver(STELLAR_HOT_CHAIN_ID, encoded), account).toBe(account);
    }
  });

  it("refuses a StrKey whose checksum is wrong instead of encoding it", () => {
    // Last character altered: still 56 chars of valid base32, still starts with G.
    const corrupted = ACCOUNTS[0].slice(0, -1) + (ACCOUNTS[0].endsWith("N") ? "M" : "N");
    expect(() => encodeHotReceiver(STELLAR_CHAIN_ID, corrupted)).toThrow(
      /not a Stellar account address/
    );
  });
});

// Block 4.5, and the same argument as Stellar's: the TON receiver is a CELL — 267 bits of
// `addr_std` plus 5 bits of alignment — so nothing about the resulting base58 string can be
// eyeballed, and a wrong-but-well-formed one is the expected failure mode. Both directions
// are pinned again: upstream's encoder must agree with ours, and upstream's DECODER must give
// the account back.
//
// This is also where the one liberty we take with upstream is proved harmless. Upstream pads
// with `storeBits(new BitString(Buffer.alloc(5), 0, 5))`; we write `storeUint(0, 5)` to keep
// `Buffer` out of the client bundle. If those five bits ever stopped being identical, the
// first assertion here is what says so.
describe("TON receiver encoding round-trips through the SDK", () => {
  const TON_HOT_CHAIN_ID = 1117; // Network.OmniTon — the `1117_` in our asset ids
  const TON_CHAIN_ID = "ton:mainnet";
  // Real mainnet addresses: the PoA bridge's own deposit address for a probe account (in the
  // non-bounceable `UQ…` form every wallet copies), and an unrelated second one so a fluke
  // that happened to work for one hash is not mistaken for a correct encoder.
  const ADDRESSES = [
    "UQCv4mTYxbLOKZBDL_b_jckLV3ev0SLA-demExEBdbkivm0W",
    "UQBYnafjv-idE8sjy0qMl1A_ca-eduw7dV1M5FHR45NALFUv",
  ];

  it("produces the byte-identical receiver the SDK's own encoder produces", () => {
    for (const address of ADDRESSES) {
      expect(hotUtils.encodeReceiver(TON_HOT_CHAIN_ID, address), address).toBe(
        encodeHotReceiver(TON_CHAIN_ID, address)
      );
    }
  });

  it("survives the SDK's decoder, so the bytes address the account we were given", () => {
    for (const address of ADDRESSES) {
      const encoded = encodeHotReceiver(TON_CHAIN_ID, address);
      // The cell keeps workchain + hash and nothing else, so upstream's decoder rebuilds the
      // address in its BOUNCEABLE form regardless of which tag we were handed. Comparing the
      // raw `workchain:hash` is therefore the comparison that means "the same account" — and
      // the tag being dropped is exactly why a testnet address must never get this far.
      expect(TonAddress.parse(hotUtils.decodeReceiver(TON_HOT_CHAIN_ID, encoded)).toRawString(), address).toBe(
        TonAddress.parse(address).toRawString()
      );
    }
  });

  it("is the same 34 bytes whether the address arrives bounceable or not", () => {
    // `UQ…` and `EQ…` are the same account with a different tag and therefore a different
    // CRC. HOT addresses the account, so both must encode identically — if they did not, a
    // user copying from a wallet that prefers one form would be paying to a different string
    // than the plan was validated against.
    const nonBounceable = ADDRESSES[0];
    const bounceable = TonAddress.parse(nonBounceable).toString({ bounceable: true });
    expect(bounceable).not.toBe(nonBounceable);
    expect(encodeHotReceiver(TON_CHAIN_ID, bounceable)).toBe(
      encodeHotReceiver(TON_CHAIN_ID, nonBounceable)
    );
  });

  it("refuses an address whose CRC16 is wrong instead of encoding it", () => {
    // Last character altered: still 48 chars of valid base64, still starts with UQ.
    const corrupted = ADDRESSES[0].slice(0, -1) + (ADDRESSES[0].endsWith("W") ? "X" : "W");
    expect(() => encodeHotReceiver(TON_CHAIN_ID, corrupted)).toThrow(/not a valid TON address/);
  });

  it("refuses a TESTNET address, which upstream would happily encode", () => {
    // 🔴 The rejection upstream does NOT make. `Address.parse` accepts the `0x80` test flag,
    // and the cell drops it — so this exact string would become a valid MAINNET receiver.
    const testnet = TonAddress.parse(ADDRESSES[0]).toString({ testOnly: true });
    expect(() => encodeHotReceiver(TON_CHAIN_ID, testnet)).toThrow(/TESTNET/);
    // Stated against upstream so the divergence is visible: theirs encodes it without complaint,
    // onto the very receiver a mainnet withdrawal would use.
    expect(hotUtils.encodeReceiver(TON_HOT_CHAIN_ID, testnet)).toBe(
      encodeHotReceiver(TON_CHAIN_ID, ADDRESSES[0])
    );
  });

  it("refuses the RAW form, which carries no checksum at all", () => {
    const raw = TonAddress.parse(ADDRESSES[0]).toRawString();
    expect(() => encodeHotReceiver(TON_CHAIN_ID, raw)).toThrow(/EQ…\/UQ… form/);
  });
});
