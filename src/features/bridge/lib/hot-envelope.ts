// The `mt_withdraw` intent a `hot-omni` withdrawal is made of (008.plan §Fase 4, block 4.3.2).
//
// Attribution: see ATTRIBUTIONS.md #11 (mirrors @hot-labs/omni-sdk 2.25.5
// `buildGaslessWithdrawIntent`, its `encodeReceiver` / `createAddressRlp`, and
// @defuse-protocol/intents-sdk 0.78.0 `HotBridge.createWithdrawalIntents` — re-review on
// version bump).
//
// The mirror is proved, not asserted: `hot-envelope.differential.test.ts` builds the same
// withdrawal through the real SDK (a devDependency, never shipped) and compares field by
// field. It goes red only if the shape we depend on moves.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// 🔴 WE SUBTRACT THE FEE. UPSTREAM'S WRAPPER ADDS IT. THIS IS DELIBERATE.
//
// Do not "fix" this by reading `hot-bridge.js:96` (`amount + (isNative ? feeAmount : 0n)`)
// and concluding a `+ fee` is missing. There are TWO upstream conventions over the SAME
// primitive, and the primitive is neutral:
//
//   @defuse-protocol/intents-sdk `createWithdrawalIntents`  →  amount + fee   (`amount` = what
//                                                                the user RECEIVES)
//   @hot-labs/omni-sdk         `buildGaslessWithdrawToken`  →  amount − amount_in (`amount` =
//                                                                what LEAVES the balance)
//
// Both call `buildGaslessWithdrawIntent`. So which one applies is OUR policy, not the
// contract's, and the operator closed it in session 103: the typed amount is what LEAVES the
// balance. Reasons, in the order they weighed: the other 40 of our 53 withdrawable tokens
// already work that way (`withdraw-envelope.ts` `netRaw = amountRaw - feeRaw`); HOT Wallet's
// own wrapper works that way; and near-intents.org never asks a user to reserve the fee out
// of their Max. Two mental models in one modal, chosen by destination chain, was the worst
// available outcome.
//
// What that buys: `Max` stays the full balance, the modal's `qty - fee` stays correct, and
// `minimumWithdrawalRaw` (`fee + min`) stays correct. What it costs: the subtraction is ours
// to get right, so it must use the EXACT figures the screen showed — hence `HotFeeDetail`
// travels in, and is never re-fetched here (a fresh `blockNumber` would invalidate the
// envelope the user is looking at).
// ─────────────────────────────────────────────────────────────────────────────────────────

import { hexToBytes } from "viem";
import bs58 from "bs58";
import { Address as StellarAddress, StrKey } from "@stellar/stellar-base";
import { Address as TonAddress, beginCell } from "@ton/core";
import type { Intent } from "@defuse-protocol/contract-types";
import { hotNativeAssetId, type HotFeeDetail } from "./hot-fee";

/** `MIN_GAS_AMOUNT` (intents-sdk `hot-bridge-constants.ts`). */
export const HOT_MIN_GAS = "91300000000000";

/** HOT's refuel contract. It is the `receiver_id` for every chain — never the user. */
export const HOT_BRIDGE_RECEIVER_ID = "bridge-refuel.hot.tg";

/** The NEP-245 contract every `hot-omni` token lives in. */
export const HOT_OMNI_CONTRACT_ID = "v2_1.omni.hot.tg";

/** `GlobalSettings.hotIntentPrefix` (omni-sdk `env.ts`). */
const HOT_INTENT_PREFIX = `nep245:${HOT_OMNI_CONTRACT_ID}:`;

const ZERO = BigInt(0);

/**
 * The NEP-245 token id as `mt_withdraw` names it: our registry key with the contract prefix
 * removed (`nep245:v2_1.omni.hot.tg:137_qiSt…` → `137_qiSt…`).
 *
 * ⚠️ This is where we are SIMPLER than upstream, not different from it. `toOmni` takes a
 * plain chain address (`0x3c499c…`), base58-encodes its bytes and prefixes the chain id. We
 * already store the encoded form, so we strip a prefix where upstream does a round trip —
 * and the differential test proves the two land on the same string.
 */
export function hotOmniTokenId(defuseAssetId: string): string {
  if (!defuseAssetId.startsWith(HOT_INTENT_PREFIX)) {
    throw new Error(`${defuseAssetId} is not a ${HOT_OMNI_CONTRACT_ID} asset id`);
  }
  return defuseAssetId.slice(HOT_INTENT_PREFIX.length);
}

/**
 * Whether `encodeHotReceiver` can address a destination on this chain at all.
 *
 * Exported so the feature gate (`withdraw-flag.ts`, block 4.3.6) opens on exactly what this
 * module can build, instead of restating "EVM only" somewhere the next chain's serialisation
 * would not think to update.
 */
export function hotReceiverEncodable(chainId: string): boolean {
  return (
    chainId.startsWith("eth:") || chainId === "stellar:mainnet" || chainId === "ton:mainnet"
  );
}

/**
 * The friendly (base64) form of a TON address: 48 chars of base64, url-safe or not.
 *
 * The RAW form (`0:abcd…`) that `Address.parse` also accepts is deliberately NOT matched —
 * same reasoning as Tron's hex form in `address-validation.ts`. Tonkeeper's "Copy address"
 * hands out `UQ…`, so widening the field to a shape no wallet produces would only widen what
 * a paste error can look like. Worse here than on Tron: `Address.parseRaw` runs NO checksum,
 * so the raw form would be the one TON shape where a typo is undetectable.
 */
const TON_FRIENDLY_ADDRESS = /^[A-Za-z0-9+/_-]{48}$/;

/** `storeAddress` writes 267 bits, `storeUint(0, 5)` aligns to 272 — exactly 34 bytes. */
const TON_RECEIVER_BYTES = 34;

/**
 * The 34 bytes HOT addresses a TON destination by. Mirrors `createAddressRlp`
 * (omni-sdk `bridge-ton/constants.ts:79`), reached from `encodeReceiver` (`utils.ts:187`).
 *
 * ⚠️ The upstream name says RLP and there is no RLP here — it is a TON cell. `storeAddress`
 * lays down `addr_std` (2 bits tag + 1 anycast + 8 workchain + 256 hash = 267 bits), and the
 * 5 trailing zero bits exist only so the total divides into whole bytes. Upstream writes them
 * as `storeBits(new BitString(Buffer.alloc(5), 0, 5))`; `storeUint(0, 5)` is the same five
 * zero bits without dragging `Buffer` in, and the differential test proves the two land on the
 * same base58 string rather than taking my word for it.
 *
 * Two rejections are OURS, not upstream's, and both are cases where `Address.parse` would
 * happily produce a well-formed receiver pointing somewhere the money cannot come back from:
 *   - the raw form (see `TON_FRIENDLY_ADDRESS`), which carries no checksum;
 *   - a TESTNET address (`kQ…`/`0Q…`, the `0x80` tag flag). The cell keeps only workchain and
 *     hash, so the test flag silently disappears and a testnet address becomes a perfectly
 *     valid mainnet receiver for an account nobody controls.
 */
function encodeTonReceiver(destinationAddress: string): string {
  if (!TON_FRIENDLY_ADDRESS.test(destinationAddress)) {
    throw new Error(`"${destinationAddress}" is not a TON address in the EQ…/UQ… form`);
  }
  let parsed: ReturnType<typeof TonAddress.parseFriendly>;
  try {
    // Verifies the CRC16 over the 34 payload bytes (`Address.js:33`), so a one-character
    // typo cannot reach the cell.
    parsed = TonAddress.parseFriendly(destinationAddress);
  } catch (cause) {
    throw new Error(`"${destinationAddress}" is not a valid TON address`, { cause });
  }
  if (parsed.isTestOnly) {
    throw new Error(`"${destinationAddress}" is a TON TESTNET address, not a mainnet one`);
  }

  const bits = beginCell().storeAddress(parsed.address).storeUint(0, 5).endCell().bits;
  const bytes = hexToBytes(`0x${bits.toString()}`);
  // The cell is fixed-width by construction, so a different length means the serialisation
  // moved under us — and a short receiver still base58-encodes into something signable.
  if (bytes.length !== TON_RECEIVER_BYTES) {
    throw new Error(
      `TON receiver serialised to ${bytes.length} bytes, expected ${TON_RECEIVER_BYTES}`
    );
  }
  return bs58.encode(bytes);
}

/**
 * The destination as HOT reads it: base58 of the address's RAW BYTES, not the address.
 * Mirrors `encodeReceiver` (omni-sdk `utils.ts`).
 *
 * `encodeReceiver` is a per-family switch, not a rule. EVM base58-encodes the 20 raw bytes;
 * Stellar wraps the account in an XDR ScVal; TON wraps it in a cell. Getting one subtly
 * wrong produces a well-formed base58 string addressed to nobody, which is the one failure
 * this module exists to avoid — so each branch is proved by ROUND-TRIPPING through upstream's
 * own `decodeReceiver` in the tests, never by asserting a shape we invented.
 *
 * All three families are covered as of block 4.5.
 */
export function encodeHotReceiver(chainId: string, destinationAddress: string): string {
  if (!hotReceiverEncodable(chainId)) {
    throw new Error(
      `HOT receiver encoding for ${chainId} is not implemented: EVM, Stellar and TON are covered`
    );
  }

  if (chainId === "ton:mainnet") {
    return encodeTonReceiver(destinationAddress);
  }

  if (chainId === "stellar:mainnet") {
    // `Address.fromString` rejects anything that is not a valid StrKey, checksum included,
    // so a typo cannot reach the XDR. Mirrors omni-sdk `utils.ts`:
    //   baseEncode(StellarAddress.fromString(address).toScVal().toXDR())
    if (!StrKey.isValidEd25519PublicKey(destinationAddress)) {
      throw new Error(`"${destinationAddress}" is not a Stellar account address for ${chainId}`);
    }
    return bs58.encode(
      new Uint8Array(StellarAddress.fromString(destinationAddress).toScVal().toXDR())
    );
  }

  if (!/^0x[0-9a-fA-F]{40}$/.test(destinationAddress)) {
    throw new Error(`"${destinationAddress}" is not a 20-byte EVM address for ${chainId}`);
  }
  return bs58.encode(hexToBytes(destinationAddress as `0x${string}`));
}

/**
 * The fee in the WITHDRAWN token's own base units — the number subtracted from what the user
 * typed, and the one the screen shows.
 *
 * FOUR cases now, and the fourth is why this reads `payment` instead of testing `swap`:
 *   - `swap`           → its `amount_in` IS the cost in the withdrawn token;
 *   - `in-kind`        → the token IS the chain's gas (or the fee is `"0"`), so
 *                        `relayerFeeRaw` is already in the right units;
 *   - `native-balance` → the signer paid the gas out of a DIFFERENT token they already held,
 *                        so nothing at all comes out of the withdrawn one.
 *
 * The old expression was `fee.swap ? fee.swap.amountIn : fee.relayerFeeRaw`. On a
 * `native-balance` quote that returns the gas figure denominated in the wrong token — TON's
 * `40000000` read as 40 USDT instead of 0.04 GRAM. It would have been shown as the fee, used
 * as the withdrawal floor, and subtracted from what the screen promised.
 *
 * Must agree with what `fetchHotWithdrawalFee` reported as `feeRaw`; the test asserts it,
 * because a disagreement means the modal showed one fee and the envelope charged another.
 */
export function hotTokenFeeRaw(fee: HotFeeDetail): string {
  switch (fee.payment) {
    case "swap":
      // A quote that says "swap" without one is not a fee we can restate in token units, and
      // guessing either way here would be inventing money. `buildHotWithdrawIntents` would
      // also silently stop subtracting the swap's input, over-withdrawing by that amount.
      if (!fee.swap) {
        throw new Error("HOT fee quote claims a fee swap but carries no swap");
      }
      return fee.swap.amountIn;
    case "native-balance":
      return "0";
    case "in-kind":
      return fee.relayerFeeRaw;
  }
}

export type BuildHotWithdrawParams = {
  /** Full defuse asset id — the `withdrawalRegistry` key. */
  tokenId: string;
  /** Destination chain, already checked against the registry by the caller. */
  chainId: string;
  /** Base units LEAVING the balance. Not what lands — see the header. */
  amountRaw: string;
  destinationAddress: string;
  /** The very quote the screen displayed. Never re-fetched here. */
  fee: HotFeeDetail;
};

export type HotWithdrawIntents = {
  /** `token_diff` first when there is one, then `mt_withdraw` — the upstream order. */
  intents: Intent[];
  /** What `mt_withdraw` moves of the withdrawn token: `amountRaw` minus the swap's input. */
  withdrawnRaw: string;
  /** The fee in the withdrawn token's units, as `hotTokenFeeRaw` computes it. */
  tokenFeeRaw: string;
};

/**
 * The swap that buys the relayer's gas, as an intent.
 *
 * Mirrors `createWithdrawalIntents`' `token_diff`. `referral` is omitted rather than sent
 * empty: upstream passes its caller's `args.referral`, which is `undefined` for anyone who
 * does not set one, and `JSON.stringify` drops an undefined key — so omitting produces the
 * identical payload rather than a subtly different one.
 */
function buildFeeSwapIntent(fee: HotFeeDetail): Intent | null {
  if (!fee.swap) return null;
  return {
    intent: "token_diff",
    diff: {
      [fee.swap.assetIn]: `-${fee.swap.amountIn}`,
      [fee.swap.assetOut]: fee.swap.amountOut,
    },
  } as Intent;
}

/**
 * Guards on the quote itself, before any of its numbers reach a signed intent — and the
 * reason `chainId` is a parameter at all.
 *
 * The quote arrives from the screen, which got it from `hot-fee.ts`, but it travels through
 * React state across an address edit and a token switch. A quote left over from a DIFFERENT
 * withdrawal is still a perfectly well-formed quote; it just buys gas the destination relayer
 * cannot spend, or sells an asset the user never chose to sell. So the chain's native is
 * re-derived from the SAME table `hot-fee.ts` quoted against and compared, rather than taken
 * on the quote's word.
 */
function nativeAssetFor(chainId: string, tokenId: string, fee: HotFeeDetail): string {
  const nativeAssetId = hotNativeAssetId(chainId);
  if (!nativeAssetId) {
    throw new Error(`No HOT native asset is curated for ${chainId} (token ${tokenId})`);
  }
  if (fee.nativeAssetId !== nativeAssetId) {
    throw new Error(
      `HOT fee quote is for native asset ${fee.nativeAssetId} but ${tokenId} settles gas in ` +
        `${nativeAssetId}: the quote belongs to another chain`
    );
  }
  if (fee.swap && (fee.swap.assetIn !== tokenId || fee.swap.assetOut !== nativeAssetId)) {
    throw new Error(
      `HOT fee quote swaps ${fee.swap.assetIn} → ${fee.swap.assetOut}, but this withdrawal is ` +
        `${tokenId} → ${nativeAssetId}: it would sell the wrong asset`
    );
  }
  return nativeAssetId;
}

/**
 * The intents a `hot-omni` withdrawal is made of.
 *
 * ⚠️ `withFee` decides the ARITY of `amounts`/`token_ids`, and it is upstream's condition
 * verbatim (`tokenAddress !== feeTokenAddress && feeAmount > 0n`): withdrawing the chain's
 * own gas token, or withdrawing when the relayer charges nothing, produces a ONE-entry
 * `mt_withdraw`. `msg.amount_native` still carries the fee in both shapes — that is how the
 * bridge knows to deliver `amount − fee` on the native path, and it is what makes our
 * subtraction come out right there without a second entry.
 */
export function buildHotWithdrawIntents(p: BuildHotWithdrawParams): HotWithdrawIntents {
  const nativeAssetId = nativeAssetFor(p.chainId, p.tokenId, p.fee);

  const amountRaw = BigInt(p.amountRaw);
  const relayerFee = BigInt(p.fee.relayerFeeRaw);
  const tokenFeeRaw = hotTokenFeeRaw(p.fee);

  // What is left for the user after the swap took its cut. On the native and zero-fee paths
  // nothing was sold, so this IS `amountRaw` and the bridge deducts on the far side instead.
  const withdrawnRaw = amountRaw - BigInt(p.fee.swap?.amountIn ?? "0");
  if (withdrawnRaw <= ZERO) {
    throw new Error(
      `Withdrawal of ${p.amountRaw} base units leaves nothing after the ${tokenFeeRaw} base-unit ` +
        `HOT fee for ${p.tokenId}`
    );
  }

  // `blockNumber` is serialised as a JSON NUMBER upstream (`Number(args.blockNumber)`), not a
  // string, and the msg is a string inside the signed payload — so the distinction is part of
  // the signed bytes. Guarded because a chain past 2^53 blocks would silently round.
  const blockNumber = Number(p.fee.blockNumber);
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
    throw new Error(`HOT fee quote carries an unusable block number "${p.fee.blockNumber}"`);
  }

  const tokenIds = [hotOmniTokenId(p.tokenId)];
  const amounts = [withdrawnRaw.toString()];
  const withFee = p.tokenId !== nativeAssetId && relayerFee > ZERO;
  if (withFee) {
    tokenIds.push(hotOmniTokenId(nativeAssetId));
    amounts.push(p.fee.relayerFeeRaw);
  }

  const mtWithdraw = {
    intent: "mt_withdraw",
    receiver_id: HOT_BRIDGE_RECEIVER_ID,
    amounts,
    token_ids: tokenIds,
    token: HOT_OMNI_CONTRACT_ID,
    msg: JSON.stringify({
      receiver_id: encodeHotReceiver(p.chainId, p.destinationAddress),
      amount_native: p.fee.relayerFeeRaw,
      block_number: blockNumber,
    }),
    // Set by intents-sdk's WRAPPER, not by the primitive we mirror (`hot-bridge.js:109`), so
    // the differential test cannot see it. It is ours to remember — exactly as on the `omft`
    // route, which sets its own `min_gas` for the same reason.
    min_gas: HOT_MIN_GAS,
  } as Intent;

  const swapIntent = buildFeeSwapIntent(p.fee);
  return {
    intents: swapIntent ? [swapIntent, mtWithdraw] : [mtWithdraw],
    withdrawnRaw: withdrawnRaw.toString(),
    tokenFeeRaw,
  };
}
