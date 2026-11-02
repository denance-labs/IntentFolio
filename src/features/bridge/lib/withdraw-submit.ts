// ③ Withdraw, step 1: pre-flight → sign → publish (005.plan §8, Phase 5, block 5.2).
//
// Takes the envelope block 5.1 built and gets it onto the Solver Relay. Nothing here talks
// to the vault contract: a withdrawal of the General Balance is signed directly against
// `intents.near` (ADR-0005, Path D), so the vault is not in the loop at all.
//
// WHY THE LOW-LEVEL httpClient AND NOT `solverRelay.publishIntent`
// The high-level entry point takes a RAW WalletSignatureResult and re-assembles the
// MultiPayload itself. Our `VaultSigner` already assembles one — that is its whole job, and
// keeping assembly inside the signer is what stops a signature from being paired with the
// wrong payload. So we hand the assembled MultiPayload to `httpClient.publishIntent`
// instead, and pay the price the high-level API was covering: parsing the relay's failure
// response ourselves. That parsing is mirrored below, string match for string match.
//
// ⚠️ AND THE TRAP THAT COMES WITH IT: the high-level API returns a MONADIC `Result`
// (@thames/monads) and does NOT throw. An ignored `Err` looks exactly like success — it is
// the shape of bug that reports a withdrawal as sent while the funds never moved. The
// low-level client does throw, but `assertNotMonadicResult` below is a tripwire in case
// anyone ever swaps the injected publisher for the high-level function.
//
// Attribution: see ATTRIBUTIONS.md #10 (relay publish-failure parsing, NEAR destination
// pre-flight) and #11 (that the fee quote's hash is published alongside the intents, and the
// HOT receiver encoding this file re-runs to check the destination). The withdrawal intent
// shapes themselves are #9 (withdraw-envelope.ts) and #11 (hot-envelope.ts).

import { solverRelay } from "@defuse-protocol/internal-utils";
import { accountExists, accountHasContract, viewCall } from "@/features/vault/lib/near-view";
import type { MultiPayload, VaultSigner } from "@/features/vault/lib/vault-signer";
import { getWithdrawalEntry } from "./withdrawal-registry";
import {
  buildWithdrawMemo,
  type SupportedWithdrawRoute,
  type WithdrawSignRequest,
} from "./withdraw-envelope";
import { encodeHotReceiver } from "./hot-envelope";
import {
  assertSolanaDestinationUsable,
  defaultSolanaDestinationProbe,
  type SolanaDestinationProbe,
} from "./solana-destination";
import {
  WithdrawDestinationUnusableError,
  WithdrawPublishUnknownError,
  WithdrawRelayRejectedError,
  type WithdrawPublishErrorCode,
} from "./withdraw-errors";

/**
 * Request tuning copied from the high-level `publishIntents` (internal-utils 0.34.0).
 * Bypassing it would otherwise silently drop the retry budget it applies — and a publish
 * that gives up on the first flake is the "unknown" outcome, the worst one to land in.
 */
export const PUBLISH_REQUEST_CONFIG = {
  timeout: 30_000,
  retryOptions: { delay: 1_000, factor: 1.5, maxAttempts: 7, jitter: true, minDelay: 1_000 },
} as const;

/**
 * Sends one assembled MultiPayload to the relay. Injected so the whole money path is
 * unit-testable with no network and no wallet.
 *
 * The return type is deliberately `unknown`: what a caller might substitute here is exactly
 * what `parsePublishResponse` has to defend against, and typing it as the happy shape would
 * delete the defence at the type level while leaving the runtime risk.
 */
export type WithdrawPublisher = (params: {
  quote_hashes: string[];
  signed_data: MultiPayload;
}) => Promise<unknown>;

/** The NEAR reads the `near-native` pre-flight needs. Injected for the same reason. */
export type NearDestinationProbe = {
  /** `view_account`. False only for a definitely-missing account; throws when unsure. */
  accountExists: (accountId: string) => Promise<boolean>;
  /** NEP-145 `storage_balance_of`; `null` when the account is not registered. */
  storageBalanceOf: (
    tokenAccountId: string,
    accountId: string
  ) => Promise<{ total: string } | null>;
};

export const defaultWithdrawPublisher: WithdrawPublisher = (params) =>
  solverRelay.httpClient.publishIntent(params, PUBLISH_REQUEST_CONFIG);

export const defaultNearDestinationProbe: NearDestinationProbe = {
  accountExists,
  storageBalanceOf: (tokenAccountId, accountId) =>
    viewCall<{ total: string } | null>(tokenAccountId, "storage_balance_of", {
      account_id: accountId,
    }),
};

export type SubmitWithdrawParams = {
  /** The envelope from `buildWithdrawSignRequest` (block 5.1). */
  request: WithdrawSignRequest;
  /** Full defuse asset id — the withdrawal-registry key. */
  tokenId: string;
  /**
   * The destination chain the envelope was built for. Required: with `tokenId` it decides the
   * route (`getWithdrawalEntry`), and an `omft` token has two (D-384).
   */
  chainId: string;
  /** Where the funds are going. Re-checked against the signed intent before signing. */
  destinationAddress: string;
  /**
   * Destination tag, for chains that route on one. Must be the SAME value the envelope was
   * built with — it is part of what `assertEnvelopePaysDestination` compares.
   */
  destinationMemo?: string;
  /** Signs in the login family's own scheme and assembles the MultiPayload. */
  signer: VaultSigner;
  publish?: WithdrawPublisher;
  probe?: NearDestinationProbe;
  /** The Solana equivalent of `probe`, for `omft` withdrawals landing on `sol:mainnet`. */
  solanaProbe?: SolanaDestinationProbe;
  /**
   * Set when the caller already ran the destination pre-flight for this exact destination,
   * OUTSIDE the click that opens the wallet prompt.
   *
   * Why this exists: browsers only open a signing popup inside the user-activation window the
   * click created (~5s in Blink), and the `near-native` pre-flight is two NEAR view calls. On
   * a slow endpoint they alone exceed that window and the prompt never appears — the exact
   * failure D-R16 already cost us once. So the check keeps its teeth but moves earlier, where
   * it can take as long as it needs and gives the user a better error besides.
   *
   * Safe to trust for `near-native`: the pre-flight prevents an undeliverable transfer, it
   * does not protect the funds (a failed `ft_transfer` reverts and the balance stays).
   * Upstream skips it entirely for implicit accounts.
   *
   * ⚠️ It means something stronger for Solana, where the pre-flight is the ONLY thing standing
   * between a pasted token account and an unrecoverable transfer. Set it only after
   * `assertSolanaDestinationUsable` returned for the address actually being signed for.
   */
  destinationAlreadyVerified?: boolean;
};

export type SubmitWithdrawResult = {
  intentHash: string;
  route: SupportedWithdrawRoute;
};

/** Mirrors `parseFailedPublishReason` (internal-utils 0.34.0) exactly, match for match. */
export function parsePublishFailureCode(reason: string): WithdrawPublishErrorCode {
  if (reason === "expired" || reason.includes("deadline has expired")) return "SIGNATURE_EXPIRED";
  if (reason === "internal") return "INTERNAL_ERROR";
  if (reason.includes("invalid signature")) return "SIGNATURE_INVALID";
  if (reason.includes("nonce was already used")) return "NONCE_USED";
  if (reason.includes("insufficient balance or overflow")) return "INSUFFICIENT_BALANCE";
  if (reason.includes("public key doesn't exist")) return "PUBLIC_KEY_NOT_EXIST";
  if (reason.includes("invalid salt")) return "INVALID_SALT";
  return "UNKNOWN_ERROR";
}

/**
 * 🔴 FAILED CODES THAT ARE **NOT** EVIDENCE THE INTENT WAS REFUSED.
 *
 * `WithdrawRelayRejectedError` is `untouched` by construction, and `untouched` is a promise:
 * the funds never moved, the record resolves, the row leaves the worklist. Two codes cannot
 * keep that promise, so they leave as `unknown` instead — the state that keeps the rescue
 * record open.
 *
 *   - `NONCE_USED` — the nonce is unique per signature, so the relay saying it was already
 *     used means an intent carrying it ALREADY EXECUTED. The likeliest author is our own
 *     earlier attempt: `PUBLISH_REQUEST_CONFIG` retries up to 7 times, so a publish that
 *     settled and whose HTTP answer was lost gets resent verbatim and comes back exactly
 *     like this. Calling it a rejection tells someone their money never moved while it did,
 *     and drops the only trace that could recover it. Found by cross-review, 2026-08-10.
 *   - `INTERNAL_ERROR` — `"internal"` is an opaque string that can be raised anywhere in the
 *     relay, including after the intent was accepted. Upstream treats it as a rejection; we
 *     deliberately do not, because the two mistakes do not cost the same. A false "we cannot
 *     confirm" costs a re-check. A false "it never moved" costs the recovery path.
 */
const NOT_PROOF_OF_REFUSAL: readonly WithdrawPublishErrorCode[] = ["NONCE_USED", "INTERNAL_ERROR"];

/**
 * The `Result` tripwire. `@thames/monads` values answer `isOk`/`isErr` and are truthy, so a
 * publisher that returns one would sail through every "did it throw?" check and be reported
 * as a successful withdrawal. Refuse it instead of unwrapping it: unwrapping would quietly
 * accept a call path this module has not been reviewed against.
 */
function assertNotMonadicResult(response: unknown): void {
  if (
    typeof response === "object" &&
    response !== null &&
    typeof (response as { isOk?: unknown }).isOk === "function" &&
    typeof (response as { isErr?: unknown }).isErr === "function"
  ) {
    throw new WithdrawPublishUnknownError(
      "the publisher returned a monadic Result instead of a raw relay response; " +
        "a Result must be destructured explicitly, never treated as success"
    );
  }
}

/**
 * Reads the relay's answer. Only two things count as published:
 *   - `status: "OK"`;
 *   - `status: "FAILED"` with reason `already processed` — an idempotent re-publish of an
 *     intent the relay already holds. Upstream treats this as success too, and calling it a
 *     failure would tell the user a withdrawal already in flight had failed.
 * Everything else throws, and an unrecognised shape throws as UNKNOWN rather than being
 * probed for a hash: a payload we cannot parse is not a payload we can call rejected.
 *
 * ⚠️ STATUS IS READ BEFORE `intent_hash`, AND THE ORDER IS THE WHOLE POINT (D-258).
 * A relay that refuses an intent in simulation answers with NO `intent_hash` at all —
 * measured 2026-08-10 against `insufficient balance or overflow`, on a real withdrawal.
 * Demanding the hash first turned every such rejection into UNKNOWN, which cost two things
 * at once: the failure-code taxonomy below became unreachable for the codes that matter,
 * and — because `unknown` never resolves a rescue record while `untouched` does — the
 * withdrawal stayed on the worklist forever, described as possibly in flight when the funds
 * had never moved. The hash is demanded only by the two branches that RETURN one.
 */
export function parsePublishResponse(response: unknown): string {
  assertNotMonadicResult(response);

  const r = response as { status?: unknown; intent_hash?: unknown; reason?: unknown } | null;
  const unrecognised = () =>
    new WithdrawPublishUnknownError(`unrecognised relay response ${JSON.stringify(response)}`);

  if (r?.status !== "OK" && r?.status !== "FAILED") throw unrecognised();

  const reason = typeof r.reason === "string" ? r.reason : "";
  if (r.status === "FAILED" && reason !== "already processed") {
    const code = parsePublishFailureCode(reason);
    // ⚠️ NOT every FAILED is a refusal, and the difference is the user's money.
    if (NOT_PROOF_OF_REFUSAL.includes(code)) {
      throw new WithdrawPublishUnknownError(`the relay answered ${code}: ${reason}`);
    }
    // The rest never executed, so the balance is intact and the same amount can be re-signed.
    throw new WithdrawRelayRejectedError(code, reason);
  }

  // `OK`, or `already processed`. Both mean "the relay holds this intent", and both are only
  // usable through the handle — an answer that claims either without one is not interpretable.
  const intentHash = typeof r.intent_hash === "string" ? r.intent_hash : null;
  if (intentHash === null) throw unrecognised();
  return intentHash;
}

/**
 * Can this NEAR account actually receive this token?
 *
 * The `near-native` intent leaves `storage_deposit` unset on purpose (see
 * withdraw-envelope.ts): setting it would spend the user's wNEAR and, per the contract-types
 * documentation, that wNEAR is NOT refunded if the transfer still fails. So instead of
 * paying blind we read the two things that decide it, and refuse to ask for a signature
 * unless both are affirmative.
 *
 * Every uncertainty is a refusal. A blocked withdrawal costs a retry; a signed one that
 * cannot be delivered costs the transfer.
 */
export async function assertNearDestinationUsable(p: {
  tokenAccountId: string;
  destinationAddress: string;
  probe: NearDestinationProbe;
  /**
   * Whether the destination must ALSO be registered for NEP-141 storage on the token.
   * True for `near-native` (an unregistered account cannot receive the token at all);
   * false for `near-unwrap`, which delivers native NEAR and needs only the account.
   */
  requireStorageRegistration?: boolean;
}): Promise<void> {
  const requireStorage = p.requireStorageRegistration ?? true;
  // Issued together, not in sequence: they are independent reads, and two round trips back to
  // back is what pushes this past the browser's user-activation window on a slow endpoint even
  // when the caller did not hoist it (see `destinationAlreadyVerified`).
  //
  // The storage probe is not merely ignored when it does not apply — it is never ISSUED.
  // A `near-unwrap` destination that happens to be unregistered on wrap.near must not be
  // able to fail this pre-flight through a rejected read it was never subject to.
  const [existsResult, balanceResult] = await Promise.allSettled([
    p.probe.accountExists(p.destinationAddress),
    ...(requireStorage
      ? [p.probe.storageBalanceOf(p.tokenAccountId, p.destinationAddress)]
      : []),
  ]);

  if (existsResult.status === "rejected") {
    throw new WithdrawDestinationUnusableError(
      "unverified",
      p.destinationAddress,
      p.tokenAccountId,
      existsResult.reason
    );
  }
  if (!existsResult.value) {
    throw new WithdrawDestinationUnusableError(
      "missing-account",
      p.destinationAddress,
      p.tokenAccountId
    );
  }

  if (!requireStorage) return;
  if (balanceResult.status === "rejected") {
    throw new WithdrawDestinationUnusableError(
      "unverified",
      p.destinationAddress,
      p.tokenAccountId,
      balanceResult.reason
    );
  }
  const balance = balanceResult.value;
  if (balance == null) {
    throw new WithdrawDestinationUnusableError(
      "not-registered",
      p.destinationAddress,
      p.tokenAccountId
    );
  }
}

/**
 * Whether a NEAR destination is a contract account, for an advisory warning (D-386 d).
 *
 * A warning, never a refusal: some wallets ARE contracts (a multisig), and only the user knows
 * whether this one is theirs. So unlike the pre-flight above, an uncertain read is NOT a
 * refusal — it is silence. A flaky RPC must not block a withdrawal over a warning.
 */
export async function nearDestinationIsContract(
  accountId: string,
  read: (accountId: string) => Promise<boolean> = accountHasContract
): Promise<boolean> {
  try {
    return await read(accountId);
  } catch (e) {
    console.warn("[withdraw] could not read whether the destination is a contract:", e);
    return false;
  }
}

/** `Intent` is a union with no index signature, so every read below is deliberately untyped. */
function fields(intent: unknown): Record<string, unknown> | undefined {
  return intent as Record<string, unknown> | undefined;
}

/**
 * The `mt_withdraw`, found by NAME and not by position.
 *
 * On the nine non-native `hot-omni` tokens the envelope opens with the `token_diff` that buys
 * the relayer's gas, so `intents[0]` is a SWAP and reading the destination off it would
 * compare `undefined` to an address — a guard that passes by accident on the two shapes it
 * was not written for is worse than no guard.
 */
function findMtWithdraw(intents: readonly unknown[]): Record<string, unknown> | undefined {
  return intents.map(fields).find((i) => i?.intent === "mt_withdraw");
}

/**
 * The destination out of the `mt_withdraw`'s `msg`, which is a JSON STRING inside the signed
 * payload (its key order and value types are part of the signed bytes, hence a string).
 *
 * Anything unreadable becomes `undefined` and therefore a destination mismatch. That is the
 * useful failure: an envelope whose `msg` will not parse is one whose destination we cannot
 * confirm, and the caller needs to hear that and not a `SyntaxError` from a guard.
 */
function readHotReceiver(msg: unknown): unknown {
  if (typeof msg !== "string") return undefined;
  try {
    return fields(JSON.parse(msg) as unknown)?.receiver_id;
  } catch {
    return undefined;
  }
}

/**
 * Confirms the envelope about to be signed pays the destination this call names.
 *
 * The three routes hide the destination in THREE different fields — `receiver_id` for
 * `near-native`, inside the `memo` for `omft`, and base58 of the raw address bytes inside the
 * `mt_withdraw`'s `msg` for `hot-omni` (where `receiver_id` is HOT's refuel contract and never
 * the user). This is the one place that reads them back out and compares. Without it, a caller
 * that paired an envelope with the wrong destination would pre-flight one account and sign
 * away funds to another, and nothing downstream would notice: a withdrawal to the wrong
 * address settles perfectly.
 *
 * The `hot-omni` comparison is done in HOT's OWN encoding rather than by decoding the
 * envelope back to an address: re-encoding runs the caller's address through the very
 * function the builder used, so a mismatch is a genuine disagreement rather than a
 * disagreement about how to spell one.
 */
function assertEnvelopePaysDestination(
  request: WithdrawSignRequest,
  route: SupportedWithdrawRoute,
  chainId: string,
  destinationAddress: string,
  destinationMemo: string | undefined
): void {
  if (route === "hot-omni") {
    // Refused rather than dropped, exactly as the builder does: HOT ignores a destination memo
    // on withdrawal, so honouring one here would send funds to a shared address with nothing
    // to attribute them by.
    if (destinationMemo != null && destinationMemo !== "") {
      throw new Error(
        `The HOT bridge does not carry a destination memo on withdrawal; the caller passed ` +
          `${JSON.stringify(destinationMemo)}, which would be dropped rather than delivered`
      );
    }
    const paid = readHotReceiver(findMtWithdraw(request.intents)?.msg);
    const expected = encodeHotReceiver(chainId, destinationAddress);
    if (paid !== expected) {
      throw new Error(
        `Withdrawal destination mismatch: the envelope pays ${JSON.stringify(paid)} but the ` +
          `caller asked to send to ${JSON.stringify(expected)} (${destinationAddress})`
      );
    }
    return;
  }

  const intent = fields(request.intents[0]);
  // Two of the three remaining routes put the user's address in `receiver_id`; only `omft`
  // hides it inside the memo (see the builders). Read from the field the route actually
  // uses — comparing the wrong one passes by accident on a shape it was not written for.
  const paysByReceiverId = route === "near-native" || route === "near-unwrap";
  const expected = paysByReceiverId
    ? destinationAddress
    : buildWithdrawMemo(destinationAddress, destinationMemo);
  const actual = paysByReceiverId ? intent?.receiver_id : intent?.memo;

  if (actual !== expected) {
    throw new Error(
      `Withdrawal destination mismatch: the envelope pays ${JSON.stringify(actual)} but the ` +
        `caller asked to send to ${JSON.stringify(expected)}`
    );
  }
}

/**
 * Every swap in the envelope must arrive at the relay with a quote to honour.
 *
 * The relay prices a `token_diff` against the quotes named in `quote_hashes`; publish one
 * without its hash and the swap is not refused, it is settled on whatever terms the relay
 * finds — a silent bad price on the leg that pays for the user's gas. `buildWithdrawSignRequest`
 * fills both from the same quote, so this can only fire when a caller assembles a
 * `WithdrawSignRequest` by hand, which is precisely the case worth catching before a signature
 * exists.
 */
function assertSwapsAreQuoted(request: WithdrawSignRequest): void {
  const swaps = request.intents.filter((i) => fields(i)?.intent === "token_diff").length;
  if (swaps > 0 && request.quoteHashes.length === 0) {
    throw new Error(
      `Withdrawal envelope carries ${swaps} token_diff intent(s) but no quote hash: the relay ` +
        `would settle the fee swap at a price nobody quoted`
    );
  }
}

/**
 * Pre-flight, sign, publish. Returns the relay's intent hash; `withdraw-poll.ts` takes it
 * from there.
 *
 * Signing errors are re-thrown untouched: a user cancelling in their wallet is a wallet
 * error and the UI already normalises those. Wrapping it in a withdrawal error would make
 * a cancel read like a protocol failure.
 */
export async function submitWithdraw(p: SubmitWithdrawParams): Promise<SubmitWithdrawResult> {
  const entry = getWithdrawalEntry(p.tokenId, p.chainId);
  if (!entry) throw new Error(`Token ${p.tokenId} has no withdrawal route to "${p.chainId}"`);

  // The envelope was built from the registry too, so a disagreement means the caller mixed
  // an envelope and a token id from different withdrawals. Loud, because signing one and
  // pre-flighting the other is precisely how funds get checked into the wrong account.
  if (entry.bridgeRoute !== p.request.route) {
    throw new Error(
      `Withdrawal route mismatch for ${p.tokenId}: the registry says "${entry.bridgeRoute}" ` +
        `but the envelope was built for "${p.request.route}"`
    );
  }

  // All three routes, before anything is signed: what the envelope pays must be what was asked
  // for — and for near-native, what the pre-flight is about to be run against.
  assertEnvelopePaysDestination(
    p.request,
    entry.bridgeRoute,
    entry.chainId,
    p.destinationAddress,
    p.destinationMemo
  );
  assertSwapsAreQuoted(p.request);

  if (!p.destinationAlreadyVerified) {
    if (entry.bridgeRoute === "near-native" || entry.bridgeRoute === "near-unwrap") {
      await assertNearDestinationUsable({
        tokenAccountId: entry.nearTokenId,
        destinationAddress: p.destinationAddress,
        probe: p.probe ?? defaultNearDestinationProbe,
        // `near-unwrap` delivers NATIVE NEAR, which needs no NEP-141 storage deposit on the
        // destination. Asking for one would refuse a perfectly good account: an ordinary
        // NEAR wallet that never touched wrap.near has no storage balance there, and it
        // does not need one to receive NEAR.
        requireStorageRegistration: entry.bridgeRoute === "near-native",
      });
    } else if (entry.chainId === "sol:mainnet") {
      // Backstop only — the modal runs this outside the click (D-R16) and sets
      // `destinationAlreadyVerified`. Its warning is dropped here on purpose: a warning is a
      // thing to show a user before they decide, and by this point they have decided.
      await assertSolanaDestinationUsable({
        destinationAddress: p.destinationAddress,
        probe: p.solanaProbe ?? defaultSolanaDestinationProbe,
      });
    }
  }

  const signedData = await p.signer.signEnvelope({
    nep413: p.request.nep413,
    erc191Message: p.request.erc191Message,
  });

  const publish = p.publish ?? defaultWithdrawPublisher;
  let response: unknown;
  try {
    // The ROUTE decides whether there is anything here, and the envelope already worked it
    // out: empty on `omft`/`near-native`, where a withdrawal is genuinely not a swap (D-147,
    // step 3), and the fee swap's hash on the `hot-omni` tokens that carry a `token_diff`.
    // Sweeping D-147's comment away would have been wrong — it is still true for 42 of the 53
    // withdrawable tokens.
    response = await publish({
      quote_hashes: p.request.quoteHashes,
      signed_data: signedData,
    });
  } catch (e) {
    // Ambiguous on purpose — the relay may have taken it before the connection died.
    throw new WithdrawPublishUnknownError(describeError(e), e);
  }

  const intentHash = parsePublishResponse(response);
  // Logged at the publish, not at the end of the flow: the paths where this hash matters
  // most are the ones that never reach a final state (D-R17, same reasoning as logTxHash).
  console.log(`[withdraw] published intent ${intentHash} (${entry.bridgeRoute}, ${p.tokenId})`);
  return { intentHash, route: entry.bridgeRoute };
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
