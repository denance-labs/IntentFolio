// Builds the envelope a user signs to withdraw from the General Balance (005.plan §8, Phase 5).
//
// This is the ONLY money path that leaves the system: a wrong field here does not throw, it
// settles and delivers to nobody. So every shape below is mirrored from the SDK that the
// NEAR Intents team ships, read from its published source — never inferred from the field
// names, which are actively misleading (see the `receiver_id` note below).
//
// Attribution: see ATTRIBUTIONS.md #9 (@defuse-protocol/intents-sdk withdrawal builders).
//
// WHY THIS FILE DOES NOT REUSE `vault-envelope.ts`
// The vault hand-rolls its NEP-413/ERC-191 twins because `makeSwapMessage` hardcodes
// `config.env.contractID` as `verifying_contract`, and a commit must address the VAULT. A
// withdrawal has no vault in the loop — its verifying contract IS `intents.near` — so the
// SDK's own factory applies, and using it removes a hand-rolled copy of a money-critical
// serialisation. `makeSwapMessage` additionally emits all seven signing schemes, which is
// what lets a non-EVM login withdraw without a builder per family.
//
// WHY ONE BUILDER PER ROUTE, AND NOT ONE SHARED
// `omft` and `near-native` emit the SAME intent name (`ft_withdraw`) but give `receiver_id`
// OPPOSITE meanings — the token contract vs. the user. A shared builder would misroute one
// of the two silently. This is not a hypothetical: it is the first thing reading the SDK
// revealed. `hot-omni` is a third shape entirely (`mt_withdraw`, sometimes preceded by a
// `token_diff`) and lives in `hot-envelope.ts`; `omni` is `ft_withdraw` a third time, with the
// BRIDGE as `receiver_id` and the user inside a JSON `msg` (omni-bridge.ts). This file owns the
// guards and the signing.

import { messageFactory, config } from "@defuse-protocol/internal-utils";
import type { Intent } from "@defuse-protocol/contract-types";
import { INTENTS_CONTRACT_ID } from "@/features/wallet/config/network";
import { getTokenById } from "@/features/market/lib/token-registry";
import { capToHeld, toBaseUnits } from "@/features/vault/lib/base-units";
import { buildHotWithdrawIntents, hotTokenFeeRaw } from "./hot-envelope";
import type { HotFeeDetail } from "./hot-fee";
import {
  buildOmniWithdrawIntent,
  omniFeeTotalRaw,
  omniRecipient,
  type OmniFeeDetail,
} from "./omni-bridge";
import {
  getWithdrawalEntry,
  unreceivableNearDestination,
  type BridgeRoute,
} from "./withdrawal-registry";
import { validateAddress } from "./address-validation";

/**
 * Minimum NEAR gas attached to the transfer the withdrawal creates. Both the PoA and the
 * direct route use the same figure upstream (poa-constants.ts / direct-bridge-constants.ts).
 */
export const WITHDRAW_MIN_GAS = "17050000000000";

/** Default envelope lifetime, matching the vault paths (008.plan Phase 0). */
export const WITHDRAW_DEADLINE_SECS = 600;

/** Every route the registry declares. All are buildable (`omni` since D-580). */
export type SupportedWithdrawRoute = BridgeRoute;

export type BuildWithdrawParams = {
  /** The INTENTS account id: `alice.near`, or the lowercase `0x…` derived from a non-NEAR login. */
  signerId: string;
  /** Full defuse asset id — the `withdrawalRegistry` key, e.g. `nep141:arb-0x…omft.near`. */
  tokenId: string;
  /**
   * The destination chain. It picks the route only among the ones the registry offers for
   * this token (`getWithdrawalEntry`): an `omft` row's own chain, or `near:mainnet` (D-384).
   * Any other value throws. The intent itself carries no chain, so a wrong one here would
   * misroute silently — see `assertChainMatches`.
   */
  chainId: string;
  /** Human units, as the modal collects them. */
  qty: number;
  /**
   * The signer's exact balance of this token on the Verifier, read just before signing
   * (D-303). Required, not optional: the amount is capped against it (`capToHeld`), and a
   * caller that could skip it would reopen the hole it closes — Max on a float balance asks
   * for a few units MORE than the account holds about half the time on 18/24-decimal tokens.
   */
  heldRaw: bigint;
  destinationAddress: string;
  /**
   * Destination tag / memo, for chains that route on it (XRP, Stellar). Dropping it sends
   * funds to a shared custodial address with no way to attribute them.
   */
  destinationMemo?: string;
  /** Injectable so tests are deterministic; defaults to now + WITHDRAW_DEADLINE_SECS. */
  deadlineSecs?: number;
  /** Injectable so tests are deterministic; defaults to the SDK's random 32-byte nonce. */
  nonce?: Uint8Array;
  /**
   * REQUIRED on `hot-omni`, meaningless elsewhere: the live quote from `hot-fee.ts`, exactly
   * as the screen displayed it.
   *
   * It is a parameter rather than a lookup because it is SIGNED — `blockNumber` and the
   * fee-paying swap go inside the intent. Fetching it here would pin the envelope to a block
   * the user never saw, and the registry snapshot cannot stand in (it carries neither).
   * Absent on `hot-omni` is therefore a throw, not a fallback.
   */
  hotFee?: HotFeeDetail;
  /**
   * REQUIRED on `omni`, meaningless elsewhere: the live quote from `omni-bridge.ts`, exactly as
   * the screen displayed it. A parameter for the same reason as `hotFee` — its `gasFeeRaw` is
   * SIGNED (`MaxGasFee`), so it must be the figure the user saw, not one fetched again here.
   */
  omniFee?: OmniFeeDetail;
  /** Injectable so tests are deterministic; `omni` only. Defaults to a random UUID, as upstream. */
  omniExternalId?: string;
};

export type WithdrawSignRequest = {
  /** Consumed by `VaultSigner` unchanged — the shapes are identical. */
  nep413: { message: string; recipient: string; nonce: Uint8Array };
  erc191Message: string;
  /** The raw intents, for offline per-intent validation against contract-types. */
  intents: Intent[];
  route: SupportedWithdrawRoute;
  /** Unix seconds when the signed intent expires. Kept on the rescue record (D-463). */
  deadlineSecs: number;
  /**
   * Base units LEAVING the General Balance — the figure the settlement assertion compares
   * against. Gross on every route: what the user typed, or exactly the balance when that was
   * within float noise of it (`capToHeld`, D-303). On `hot-omni` that is
   * deliberately NOT `mt_withdraw.amounts[0]`, which is this minus the fee swap's input.
   */
  amount: string;
  /**
   * Solver quotes the relay must honour when it publishes these intents (block 4.3.3).
   *
   * EMPTY on `omft` and `near-native`, and that stays correct: those withdrawals are not
   * swaps, so there is no quote to honour (D-147, step 3). It is also empty on the `hot-omni`
   * tokens that ARE their chain's gas, or whose relayer charges nothing — neither needs a
   * swap either. It is non-empty for exactly the `hot-omni` withdrawals that carry a
   * `token_diff`: that intent IS a solver swap, and publishing it without its hash asks the
   * relay to settle it at whatever price it likes.
   *
   * It rides HERE rather than being passed to `submitWithdraw` separately so it cannot
   * disagree with the intents it authorises — both come out of the one `HotFeeDetail` the
   * screen showed. A hash handed over on the side is a hash that can belong to another quote,
   * which is the same class of pairing bug `assertEnvelopePaysDestination` exists to catch.
   */
  quoteHashes: string[];
};

/**
 * A `hot-omni` envelope without a live quote cannot be built at all — not "built with a
 * stale fee". The intent carries a destination-chain `blockNumber` and, for the nine
 * non-native tokens, a solver swap that pays for the relayer's gas; the registry snapshot has
 * neither, so an envelope assembled from it is REFUSED by the contract rather than merely
 * mispriced. Failing here beats emitting something plausible.
 */
function requireHotFee(fee: HotFeeDetail | undefined, tokenId: string): HotFeeDetail {
  if (!fee) {
    throw new Error(
      `Withdrawal of ${tokenId} needs a live HOT fee quote (hot-fee.ts): the signed intent ` +
        `carries a block number and a fee swap that the registry snapshot cannot supply`
    );
  }
  return fee;
}

/**
 * An `omni` envelope without a live quote cannot be built: `MaxGasFee` is signed, and whether
 * the bridge has the coins to pay out (`insufficient_utxo`) is only known live. Same reasoning as
 * `requireHotFee`.
 */
function requireOmniFee(fee: OmniFeeDetail | undefined, tokenId: string): OmniFeeDetail {
  if (!fee) {
    throw new Error(
      `Withdrawal of ${tokenId} needs a live Omni Bridge fee quote (omni-bridge.ts): the signed ` +
        `intent carries the network fee ceiling, which the registry snapshot cannot supply`
    );
  }
  return fee;
}

/**
 * The chain is encoded in WHICH TOKEN is withdrawn (`arb-0x…omft.near` IS "USDC on
 * Arbitrum"), so the intent carries no chain field. That makes a mismatched `chainId` a
 * SILENT misroute: the funds would leave on the token's own chain, to the address given.
 * The UI derives `chainId` from this same registry today, so this can only fire on a
 * regression — which is exactly when it is worth having.
 */
function assertChainMatches(tokenId: string, expected: string, actual: string): void {
  if (expected !== actual) {
    throw new Error(
      `Withdrawal chain mismatch for ${tokenId}: the registry says "${expected}" but the caller ` +
        `passed "${actual}". The intent cannot carry a chain, so this would misroute silently.`
    );
  }
}

/**
 * The destination as the PoA bridge reads it: a `memo` string, not a `receiver_id`.
 * Mirrors `createWithdrawMemo` (poa-bridge-utils.ts) including the Bitcoin Cash prefix
 * strip — kept even though no BCH asset is curated today, so curating one later cannot
 * silently diverge from upstream.
 */
export function buildWithdrawMemo(destinationAddress: string, destinationMemo?: string): string {
  const address = destinationAddress.toLowerCase().startsWith("bitcoincash:")
    ? destinationAddress.slice(12)
    : destinationAddress;
  const parts = ["WITHDRAW_TO", address];
  if (destinationMemo != null && destinationMemo !== "") parts.push(destinationMemo);
  return parts.join(":");
}

/**
 * ① PoA bridge (`omft`): the token leaves NEAR for an external chain.
 *
 * ⚠️ `receiver_id` is THE TOKEN CONTRACT, repeated — not the user. The user's address
 * travels inside `memo`. Mirrors `createWithdrawIntentPrimitive` (poa-bridge-utils.ts).
 */
function buildOmftIntent(p: {
  tokenAccountId: string;
  amount: string;
  destinationAddress: string;
  destinationMemo?: string;
}): Intent {
  return {
    intent: "ft_withdraw",
    token: p.tokenAccountId,
    receiver_id: p.tokenAccountId,
    amount: p.amount,
    memo: buildWithdrawMemo(p.destinationAddress, p.destinationMemo),
    min_gas: WITHDRAW_MIN_GAS,
  } as Intent;
}

/**
 * ② Direct (`near-native`): a NEP-141 that lives on NEAR moves to a NEAR account.
 *
 * ⚠️ Same intent name as ①, and here `receiver_id` IS the user — with no memo at all.
 * Mirrors `createWithdrawIntentPrimitive` (direct-bridge-utils.ts).
 *
 * `storage_deposit` is deliberately NOT set: covering an unregistered destination would
 * spend the user's wNEAR with no refund on failure. Registration is checked before signing
 * instead (5.2), so the user is told rather than silently charged.
 */
function buildNearNativeIntent(p: {
  tokenAccountId: string;
  amount: string;
  destinationAddress: string;
}): Intent {
  return {
    intent: "ft_withdraw",
    token: p.tokenAccountId,
    receiver_id: p.destinationAddress,
    amount: p.amount,
    min_gas: WITHDRAW_MIN_GAS,
  } as Intent;
}

/**
 * ③ Unwrap (`near-unwrap`): NEAR leaves as NATIVE NEAR, to a NEAR account.
 *
 * ⚠️ It names NO token. Inside intents.near the balance is `nep141:wrap.near`, and
 * `native_withdraw` is the contract's own affordance for unwrapping it on the way out —
 * which is exactly why the `near-native` route is not reusable here: `ft_withdraw` of
 * `wrap.near` would deliver wNEAR, a token most wallets show as something other than NEAR.
 *
 * No `min_gas` either: the schema (contract-types `IntentNativeWithdraw`) has three fields
 * and this emits all three.
 */
function buildNativeWithdrawIntent(p: { amount: string; destinationAddress: string }): Intent {
  return {
    intent: "native_withdraw",
    receiver_id: p.destinationAddress,
    amount: p.amount,
  } as Intent;
}

/**
 * The three non-HOT routes, chosen by name. A `switch` and not a ternary chain: adding a
 * fourth route must fail to compile here rather than silently fall through to whichever
 * branch the last `else` happened to be — the difference between them is where the money
 * goes.
 */
function buildDirectIntent(
  route: BridgeRoute,
  p: {
    tokenAccountId: string;
    amount: string;
    destinationAddress: string;
    destinationMemo?: string;
  }
): Intent {
  switch (route) {
    case "omft":
      return buildOmftIntent(p);
    case "near-native":
      return buildNearNativeIntent(p);
    case "near-unwrap":
      return buildNativeWithdrawIntent(p);
    case "hot-omni":
      throw new Error("hot-omni withdrawals are built by buildHotWithdrawIntents");
    case "omni":
      throw new Error("omni withdrawals are built by buildOmniWithdrawIntent");
  }
}

export function buildWithdrawSignRequest(p: BuildWithdrawParams): WithdrawSignRequest {
  const ownEntry = getWithdrawalEntry(p.tokenId);
  if (!ownEntry) throw new Error(`Token ${p.tokenId} has no withdrawal route`);
  // A chain this token does not offer is the mismatch `assertChainMatches` names; the entry it
  // does resolve to still goes through the assertion, so the two can never disagree.
  const entry = getWithdrawalEntry(p.tokenId, p.chainId) ?? ownEntry;
  assertChainMatches(p.tokenId, entry.chainId, p.chainId);


  const token = getTokenById(p.tokenId);
  if (!token) throw new Error(`Unknown token ${p.tokenId}`);

  // GROSS is what leaves the balance (below), so GROSS is what the cap applies to.
  const amount = capToHeld(BigInt(toBaseUnits(p.qty, token.decimals)), p.heldRaw).toString();
  if (amount === "0") {
    throw new Error(`Withdrawal amount for ${token.symbol} rounds to zero base units`);
  }

  // ── The amount is GROSS on every route: what the user receives is `amount - fee`. Where
  // the deduction HAPPENS differs (the PoA bridge takes it on the far side; HOT takes it here,
  // by subtracting inside the intent — see hot-envelope.ts), but the arithmetic the user sees
  // is the same one, which is the point of the session-103 decision. Both floors below are
  // therefore about the NET, and both mirror guards the upstream SDK applies before it will
  // build a withdrawal at all (intents-sdk 0.76.0 `sdk.ts` `_estimateWithdrawalFee`,
  // `poa-bridge.ts` `validateWithdrawal`).
  //
  // On `omft`/`near-native` the figure used here is the REGISTRY's snapshot, deliberately,
  // not a live quote: that is the offline money-path backstop and it must not depend on a
  // network call that could be slow or absent. The UI gates on the live quote when it has
  // one, which is the tighter check; this one catches everything that never went through
  // that screen.
  //
  // `hot-omni` inverts that: the fee is SIGNED, so there is no offline figure to fall back
  // to and the live quote IS the number the guards below must use (008.plan §4.3.1).
  const hotFee =
    entry.bridgeRoute === "hot-omni" ? requireHotFee(p.hotFee, p.tokenId) : null;
  // `omni` is like `hot-omni` here: the fee is signed, so the live quote is the figure the
  // guards below use, and the gross must clear the CEILING (the most the bridge may take).
  const omniFee = entry.bridgeRoute === "omni" ? requireOmniFee(p.omniFee, p.tokenId) : null;
  const feeRaw = hotFee
    ? BigInt(hotTokenFeeRaw(hotFee))
    : omniFee
    ? BigInt(omniFeeTotalRaw(omniFee))
    : BigInt(entry.withdrawalFeeRaw);
  const amountRaw = BigInt(amount);

  if (omniFee) {
    // The ceiling grows with the amount (omni-bridge.ts header), so a quote asked for less than
    // what is signed may be too low a `MaxGasFee` for the transaction the bridge has to build.
    // Signing LESS than quoted is fine — the ceiling for a smaller amount is never higher. It
    // can be MORE only when `capToHeld` snaps up to the balance (within 1e-12 of it), which on
    // 8 decimals needs ≥ 10,000 ZEC — and then this refuses before anything is signed.
    if (amountRaw > BigInt(omniFee.quotedForRaw)) {
      throw new Error(
        `Withdrawal of ${amount} base units exceeds the ${omniFee.quotedForRaw} the Omni Bridge ` +
          `fee was quoted for: the signed network fee ceiling may not cover it`
      );
    }
    // `validateWithdrawal` upstream: net + ceiling + protocol fee ≥ `min_amount`, which on our
    // gross convention is the gross itself.
    if (amountRaw < BigInt(omniFee.minAmountRaw)) {
      throw new Error(
        `Withdrawal of ${amount} base units is below the Omni Bridge minimum ` +
          `${omniFee.minAmountRaw} for ${token.symbol}`
      );
    }
  }

  // Upstream: `if (amount <= fee) throw new FeeExceedsAmountError(...)`. Without this the
  // withdrawal settles perfectly and delivers NOTHING — the bridge keeps the whole amount as
  // its fee. 24 of the 29 `omft` routes have a fee larger than their stated minimum, so the
  // minimum below is not a substitute for this check.
  //
  // On `hot-omni` this is also the guard that upstream's wrapper spells as
  // `GaslessNotAvailableError` (`amount <= gasPrice` / `amount_in >= amount`) — said HERE,
  // before a wallet prompt, because under the subtract convention it is an ordinary
  // "amount below the fee" and the screen already knows how to say that.
  if (amountRaw <= feeRaw) {
    throw new Error(
      `Withdrawal of ${amount} base units does not cover the ${feeRaw} base-unit ` +
        `bridge fee for ${token.symbol}: nothing would be delivered`
    );
  }

  // The bridge silently keeps anything under its floor, so this is a throw and not a warning.
  // Compared against the NET, as upstream does — checking the gross is strictly weaker and
  // lets a withdrawal through that lands under the bridge's own minimum.
  const netRaw = amountRaw - feeRaw;
  if (netRaw < BigInt(entry.minWithdrawalRaw)) {
    throw new Error(
      `Withdrawal of ${amount} base units nets ${netRaw} after the bridge fee, below the ` +
        `bridge minimum ${entry.minWithdrawalRaw} for ${token.symbol}`
    );
  }

  // `makeSwapMessage` stamps `config.env.contractID` as both recipient and verifying_contract.
  // If an SDK upgrade ever flipped the default environment, every envelope would be signed
  // against the wrong contract — so the assumption is checked, not trusted.
  if (config.env.contractID !== INTENTS_CONTRACT_ID) {
    throw new Error(
      `SDK is configured for "${config.env.contractID}" but withdrawals must address ${INTENTS_CONTRACT_ID}`
    );
  }

  // ⚠️ HOT REJECTS a destination memo on withdrawal (`UnsupportedDestinationMemoError`).
  // Silently dropping it would send funds to a shared address with nothing to attribute them
  // by, so it throws.
  //
  // The memo a caller could plausibly still be carrying is Stellar's, and it belongs to the
  // DEPOSIT direction only — which is what D-240 fixed in the modal. TON is NOT a second case
  // of this despite what this comment used to claim: probed against the live PoA bridge in
  // block 4.5, `deposit_address` for `ton:mainnet` returns a per-account `UQ…` address with no
  // memo field, and returns the identical answer when asked for `deposit_mode: "MEMO"`. So
  // `chainRegistry["ton:mainnet"].memoRequired: false` is right in both directions.
  if (hotFee && p.destinationMemo != null && p.destinationMemo !== "") {
    throw new Error(
      `The HOT bridge does not carry a destination memo on withdrawal (token ${p.tokenId}); ` +
        `sending one would be dropped, not delivered`
    );
  }
  // Nor does the Omni Bridge: its payload has a recipient and nothing to attach a tag to.
  if (omniFee && p.destinationMemo != null && p.destinationMemo !== "") {
    throw new Error(
      `The Omni Bridge does not carry a destination memo on withdrawal (token ${p.tokenId}); ` +
        `sending one would be dropped, not delivered`
    );
  }

  // The screen validates the address for the chain it shows, but the chain can change after
  // that check (D-384 made it a toggle), and a NEAR name signed into a bridge memo burns the
  // tokens toward nobody. So the envelope asks the same validator, for the chain it signs.
  // `hot-omni` is left to its own encoder, which refuses what it cannot serialise with a
  // sharper message (hot-envelope.ts).
  if (!hotFee && !validateAddress(p.destinationAddress, entry.chainId).valid) {
    throw new Error(
      `Withdrawal destination ${JSON.stringify(p.destinationAddress)} is not a valid address ` +
        `on ${entry.chainId}`
    );
  }
  const unreceivable = unreceivableNearDestination(entry, p.destinationAddress);
  if (unreceivable) {
    throw new Error(
      `Withdrawal destination ${p.destinationAddress} is a contract, not an account ` +
        `(${unreceivable === "token-contract" ? "the token contract itself" : "a system contract"})`
    );
  }

  const recipient = omniFee ? omniRecipient(entry.chainId, p.destinationAddress) : null;
  if (omniFee && !recipient) {
    throw new Error(`The Omni Bridge has no destination prefix for ${entry.chainId}`);
  }

  const intents: Intent[] = hotFee
    ? buildHotWithdrawIntents({
        tokenId: p.tokenId,
        chainId: entry.chainId,
        amountRaw: amount,
        destinationAddress: p.destinationAddress,
        fee: hotFee,
      }).intents
    : omniFee && recipient
    ? [
        buildOmniWithdrawIntent({
          tokenAccountId: entry.nearTokenId,
          amount,
          recipient,
          fee: omniFee,
          externalId: p.omniExternalId ?? crypto.randomUUID(),
        }),
      ]
    : [
        buildDirectIntent(entry.bridgeRoute, {
          tokenAccountId: entry.nearTokenId,
          amount,
          destinationAddress: p.destinationAddress,
          destinationMemo: p.destinationMemo,
        }),
      ];

  const deadlineSecs = p.deadlineSecs ?? Math.floor(Date.now() / 1000) + WITHDRAW_DEADLINE_SECS;

  const message = messageFactory.makeSwapMessage({
    innerMessage: {
      signer_id: p.signerId,
      deadline: new Date(deadlineSecs * 1000).toISOString(),
      intents,
    },
    nonce: p.nonce,
  });

  return {
    nep413: {
      message: message.NEP413.message,
      recipient: message.NEP413.recipient,
      nonce: message.NEP413.nonce,
    },
    erc191Message: message.ERC191.message,
    intents,
    route: entry.bridgeRoute,
    deadlineSecs,
    amount,
    // Read off the same quote that built the `token_diff`, so the two cannot drift apart.
    quoteHashes: hotFee?.swap ? [hotFee.swap.quoteHash] : [],
  };
}
