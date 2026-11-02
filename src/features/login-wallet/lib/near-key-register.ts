// Sends the one transaction that authorises a NEAR named account's key on `intents.near`
// (008.plan D-280, block B3). B1 read the answer, B2 learned WHICH key to ask about; this is
// the first block of D-280 that writes.
//
// 🔴 THE CHAIN RE-READ IS THE ONLY THING THAT MAY CONCLUDE `registered`. A successful receipt
// is not evidence: the wallet signs the transaction with whatever account it has active, and
// the measured mainnet failure behind D-227/D-232 is exactly a wallet signing one account's
// payload with another account's key, with no warning. In that case `add_public_key` succeeds
// — it just registers the key under the OTHER account, leaving this one still blocked. A flow
// that trusted the receipt would report success and send the user straight into a Verifier
// rejection it had just told them could not happen.
//
// 🔴 REGISTER ONLY THE KEY THAT CAME OUT OF THE `not-registered` STATE. That key is the one
// B2 saw sign. Never one the wallet merely reported (`null` on two of the four wallets B0
// measured) and never one off `getAccessKeyList` (`pablofork.near` holds three FullAccess keys
// and only one of them is registered — the list cannot say which one signs).
//
// Call shape measured against mainnet, not inferred (s132/s133): `add_public_key` takes
// `{"public_key": "ed25519:…"}`, needs 5 Tgas, and REQUIRES a 1 yoctoNEAR deposit. The yocto
// is why this can only be signed by a FullAccess key — a FunctionCall key cannot attach a
// deposit at all. B0's collateral finding is what makes that affordable: all four wallets
// signed with a FullAccess key, so the key that signs and the key being registered are the
// same one, and no second key has to be chosen or explained.
//
// Attribution: see ATTRIBUTIONS.md #15 (the `intents.near` key-registration surface).

import { checkKeyRegistration, type KeyRegistrationStatus } from "./near-key-registration";
import type { NearKeyVerification } from "./near-key-verification";
import { INTENTS_CONTRACT_ID } from "@/features/wallet/config/network";
import { normalizeWalletError } from "@/features/wallet/adapter/normalize-error";
import { findExecutionFailure } from "@/features/vault/lib/vault-events";

/** 5 Tgas. Measured against mainnet; `add_public_key` is a list insert, not a fan-out. */
export const ADD_PUBLIC_KEY_GAS = "5000000000000";

/**
 * 1 yoctoNEAR. NOT optional and NOT a rounding artefact — the contract demands it, and it is
 * the standard NEP-141-style guard that forces the call to come from a full-access signature.
 */
export const ADD_PUBLIC_KEY_DEPOSIT = "1";

/**
 * How long to wait on the wallet before giving up on the WAIT (never on the transaction).
 * Generous because the user is reading an approval screen: extension wallets take as long as
 * the human does. Hitting it does not mean the transaction failed — see `unconfirmed`.
 */
export const REGISTER_SEND_TIMEOUT_MS = 120_000;

/**
 * How long to keep re-reading the chain after a successful send before concluding the key is
 * absent.
 *
 * 🔴 This window is not padding, it is what keeps `not-applied` from being a false accusation.
 * `viewCall` asks at `finality: "final"`, which trails the block that executed the transaction
 * by a couple of seconds. A single immediate read would routinely answer `not-registered` for
 * a registration that worked perfectly, and `not-applied` is the loudest thing this gate can
 * say — it tells a user their wallet signed as someone else.
 */
export const CONFIRM_WINDOW_MS = 20_000;
export const CONFIRM_INTERVAL_MS = 1_500;

/**
 * What a completed registration ATTEMPT concluded.
 *
 * Five outcomes, following B1 and B2's rule that a pair which collapses is a pair that fails
 * open. The three unhappy endings are not interchangeable and do not share a next step:
 * `declined` is a choice, `failed` is a wallet or a contract saying no, `unconfirmed` is us
 * not knowing yet, and `not-applied` is the chain contradicting a receipt.
 */
export type RegisterNearKeyResult =
  /** The chain was re-read and now reports the key. The only success. */
  | { kind: "registered" }
  /** The user rejected the transaction in their wallet. Nothing was sent. */
  | { kind: "declined" }
  /** The wallet could not send it, or the contract reverted it. Nothing was registered. */
  | { kind: "failed"; message: string; cause?: "requires-full-access" }
  /**
   * We stopped waiting — local timeout, or the user cancelled — and the chain does not show
   * the key yet. 🔴 NOT a failure: the transaction may well be in flight. Anything that
   * presents this as "it did not work" invites a second transaction for a key that is about
   * to be registered by the first.
   */
  | { kind: "unconfirmed" }
  /**
   * 🔴 The wallet reported the transaction SUCCEEDED and the chain still does not show the
   * key after the confirmation window. The likely cause is the measured one: the wallet
   * signed with a different account, so the authorisation landed under that account instead.
   * Retrying the same transaction would just do it again.
   */
  | { kind: "not-applied" };

/**
 * Whether a failure message names the one cause B5 has a different next step for: the
 * signing key is a `FunctionCall` key, which the NEAR protocol never lets attach a deposit —
 * so this exact transaction cannot succeed no matter how many times it is resent (008.plan
 * D-280, block B5).
 *
 * 🔴 UNVERIFIED against a real FunctionCall-key wallet — none of B0's four measured wallets
 * signed with one (`near-key-register.ts:21-23`). The patterns below are what nearcore's own
 * `InvalidAccessKeyError::RequiresFullAccess` serialises to (a bare string next to
 * `InvalidTxError` in `status.Failure`, which `findExecutionFailure` falls back to
 * `JSON.stringify`-ing) and what near-api-js's parser turns that into on the thrown-exception
 * path. This repo does not use that parser (near-connect relays the wallet's own text), so a
 * wallet that phrases the refusal differently will fall through to the generic `register-failed`
 * banner instead of the near.com redirect — a missed match is a worse "Try again" loop, not a
 * wrong on-chain action, which is why a broad, case-insensitive match is worth the risk of a
 * false positive here.
 */
function isRequiresFullAccessFailure(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("requiresfullaccess") ||
    normalized.includes("requires full access") ||
    normalized.includes("requires a full access key")
  );
}

/** The slice of the wallet this needs. Injected, so the whole path is testable without one. */
export type NearKeySender = (params: {
  receiverId: string;
  actions: unknown[];
}) => Promise<unknown>;

export type RegisterNearKeyInput = {
  /** The account from the `not-registered` state — never re-derived here. */
  accountId: string;
  /** The key from that same state: the one B2 SAW SIGN. */
  publicKey: string;
  signAndSend: NearKeySender;
  /** Lets the user stop waiting. Does not and cannot cancel a transaction already sent. */
  signal?: AbortSignal;
  /** Injected for tests; defaults to the real chain read. */
  checkRegistration?: (input: {
    accountId: string;
    publicKey: string;
  }) => Promise<KeyRegistrationStatus>;
  /** Injected for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected for tests; defaults to `Date.now`. */
  now?: () => number;
  sendTimeoutMs?: number;
  confirmWindowMs?: number;
  confirmIntervalMs?: number;
};

/**
 * The single action, kept separate so a test can assert the exact wire shape — the gas, the
 * deposit and the argument name are all things a plausible-looking edit can get wrong without
 * any type error, and each one turns the call into a revert the user pays for.
 */
export function buildAddPublicKeyAction(publicKey: string) {
  return {
    type: "FunctionCall" as const,
    params: {
      methodName: "add_public_key",
      args: { public_key: publicKey },
      gas: ADD_PUBLIC_KEY_GAS,
      deposit: ADD_PUBLIC_KEY_DEPOSIT,
    },
  };
}

/**
 * The states a registration may be STARTED from.
 *
 * 🔴 The exclusions are the whole point and each one is a measured failure:
 *   · `unknown` — B1 answers it for an empty key too, so there may be no key to register.
 *   · `signer-mismatch` — the pair is already known to be wrong; registering it IS the
 *     admin/budget contamination that is sitting in mainnet.
 *   · `register-not-applied` — the same transaction would land in the same wrong account.
 *   · `register-unconfirmed` — one may already be in flight; the next step is to look again.
 *   · `unchecked`/`checking`/`registering` — there is no verified key in hand at all.
 */
const REGISTERABLE: ReadonlySet<NearKeyVerification["kind"]> = new Set([
  "not-registered",
  "register-declined",
  "register-failed",
]);

/** Whether the register action may be offered/run from this state, and with which pair. */
export function registrationTarget(
  verification: NearKeyVerification,
): { accountId: string; publicKey: string } | null {
  if (!REGISTERABLE.has(verification.kind)) return null;
  const { accountId, publicKey } = verification as { accountId: string; publicKey: string };
  // Belt and braces against a state that carries the fields but not the values: a blank key
  // must never reach `add_public_key`.
  if (!accountId || !publicKey) return null;
  return { accountId, publicKey };
}

/**
 * Folds an attempt's result back into the UI state.
 *
 * 🔴 `registered` is produced here ONLY because `registerNearKey` reached it through a chain
 * re-read. There is no other path in this module that can emit it, which is the invariant the
 * whole block is built on.
 */
export function toVerificationState(
  result: RegisterNearKeyResult,
  accountId: string,
  publicKey: string,
): NearKeyVerification {
  switch (result.kind) {
    case "registered":
      return { kind: "registered", accountId, publicKey };
    case "declined":
      return { kind: "register-declined", accountId, publicKey };
    case "failed":
      return { kind: "register-failed", accountId, publicKey, message: result.message, cause: result.cause };
    case "unconfirmed":
      return { kind: "register-unconfirmed", accountId, publicKey };
    case "not-applied":
      return { kind: "register-not-applied", accountId, publicKey };
  }
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Resolves when the signal aborts. Never rejects — the caller races it as a normal branch. */
function whenAborted(signal: AbortSignal | undefined): Promise<"stopped"> {
  if (!signal) return new Promise<"stopped">(() => {});
  if (signal.aborted) return Promise.resolve("stopped");
  return new Promise<"stopped">((resolve) => {
    signal.addEventListener("abort", () => resolve("stopped"), { once: true });
  });
}

/**
 * Sends the registration and then asks the chain whether it took.
 *
 * The two halves are deliberately not one step: everything before the re-read establishes
 * only that a transaction was accepted somewhere, and this whole module exists because that
 * is not the same question as "can this account operate now?".
 */
export async function registerNearKey(
  input: RegisterNearKeyInput,
): Promise<RegisterNearKeyResult> {
  const { accountId, publicKey } = input;
  const check = input.checkRegistration ?? ((p) => checkKeyRegistration({ chainKind: "near", ...p }));
  const sleep = input.sleep ?? realSleep;
  const now = input.now ?? Date.now;

  // A key we cannot name must never become a transaction. B1 answers `unknown` for an empty
  // key precisely so this case reaches here as a refusal rather than as an `add_public_key`
  // with an empty string in it, which is a revert the user pays gas for.
  if (!accountId || !publicKey) {
    return { kind: "failed", message: "No verified key to register" };
  }

  let sendTimer: ReturnType<typeof setTimeout> | undefined;
  const send = input
    .signAndSend({
      receiverId: INTENTS_CONTRACT_ID,
      actions: [buildAddPublicKeyAction(publicKey)],
    })
    .then((outcome) => ({ outcome }));

  const stoppedWaiting = await Promise.race([
    send.then(() => null),
    // Both of these mean "stop waiting", never "stop the transaction". A wallet popup the
    // user walked away from and a wallet that never answers are the same problem from here.
    whenAborted(input.signal),
    new Promise<"stopped">((resolve) => {
      sendTimer = setTimeout(() => resolve("stopped"), input.sendTimeoutMs ?? REGISTER_SEND_TIMEOUT_MS);
    }),
  ]).catch(() => null);
  clearTimeout(sendTimer);

  if (stoppedWaiting === "stopped") {
    // Never rethrow into an unhandled rejection: the send is still running and will settle
    // on its own long after this function returned.
    void send.catch(() => undefined);
    // One read, not the full window. The user asked to stop, and a registration that already
    // landed should still be reported as what it is.
    const status = await check({ accountId, publicKey });
    return status === "registered" ? { kind: "registered" } : { kind: "unconfirmed" };
  }

  let outcome: unknown;
  try {
    ({ outcome } = await send);
  } catch (e) {
    // Same classifier the signature path uses, for the same reason: a refusal and a broken
    // wallet are different problems with different fixes.
    const n = normalizeWalletError(e);
    if (n.kind === "cancel") return { kind: "declined" };
    return {
      kind: "failed",
      message: n.message,
      cause: isRequiresFullAccessFailure(n.message) ? "requires-full-access" : undefined,
    };
  }

  // An explicit revert, before spending twenty seconds asking a chain that already answered.
  // Reusing the vault's reader rather than adding a fifth copy: it walks `status` and every
  // `receipts_outcome`, which is where a cross-contract failure actually surfaces.
  const reverted = findExecutionFailure(outcome);
  if (reverted) {
    return {
      kind: "failed",
      message: reverted,
      cause: isRequiresFullAccessFailure(reverted) ? "requires-full-access" : undefined,
    };
  }

  return confirmOnChain({
    accountId,
    publicKey,
    check,
    sleep,
    now,
    windowMs: input.confirmWindowMs,
    intervalMs: input.confirmIntervalMs,
  });
}

/**
 * Re-reads until the chain reports the key or the window closes.
 *
 * 🔴 The two ways of running out of time are NOT the same answer. A window that only ever saw
 * `unknown` means the RPC never told us anything, and calling that `not-applied` would accuse
 * a wallet of signing as someone else on the strength of a network outage. Only a definite
 * `not-registered` as the last word earns `not-applied`.
 */
async function confirmOnChain(p: {
  accountId: string;
  publicKey: string;
  check: (input: { accountId: string; publicKey: string }) => Promise<KeyRegistrationStatus>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  windowMs?: number;
  intervalMs?: number;
}): Promise<RegisterNearKeyResult> {
  const windowMs = p.windowMs ?? CONFIRM_WINDOW_MS;
  const intervalMs = p.intervalMs ?? CONFIRM_INTERVAL_MS;
  const deadline = p.now() + windowMs;

  // The window bounds the RETRIES, never the first read: a zero window still asks once.
  let last: KeyRegistrationStatus;
  for (;;) {
    last = await p.check({ accountId: p.accountId, publicKey: p.publicKey });
    if (last === "registered") return { kind: "registered" };
    // `not-required` is unreachable — the caller only reaches B3 from `not-registered`, which
    // only a named NEAR account can produce. Treated as "no answer" rather than folded into
    // the negative, so a future change to the predicate cannot silently become an accusation.
    if (p.now() + intervalMs >= deadline) break;
    await p.sleep(intervalMs);
  }

  return last === "not-registered" ? { kind: "not-applied" } : { kind: "unconfirmed" };
}
