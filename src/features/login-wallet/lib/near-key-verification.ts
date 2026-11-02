// Turns "which key is this wallet actually signing with, and is it registered?" into a
// single answer the UI can render (008.plan D-280, block B2). B1 supplied the read; this
// supplies the step that has to happen BEFORE the read is even possible.
//
// 🔴 The whole reason this file exists is that the key is not knowable for free. B0 measured
// four wallets against `pablofork.near` in mainnet: HOT and Nightly report a public key up
// front, Meteor and Intear report `null`. So there is no universal pre-signature source, and
// using the reported one where it exists FAILS OPEN in both directions — as a check it waves
// a user through to a Verifier rejection, and as a registration it writes an on-chain
// authorisation for a key that does not sign. The rule that came out of that measurement is
// the one this module implements: NEVER trust a key we did not see sign. One path, no
// per-wallet branches.
//
// The signature is D-252's empty-intents envelope. For a fresh NEAR login the supported
// `signInAndSignMessage` path obtains it in the same wallet interaction; a restored session
// can request the same safe payload explicitly from the verification banner.
//
// Attribution: see ATTRIBUTIONS.md #15 (intents.near key-registration surface + near.com's
// verification prompt) and #8 (the NEP-413 envelope shape this reuses).

import { checkKeyRegistration, requiresKeyRegistration } from "./near-key-registration";
import { INTENTS_CONTRACT_ID } from "@/features/wallet/config/network";
import { normalizeWalletError } from "@/features/wallet/adapter/normalize-error";
import type { ChainKind } from "../types";

/**
 * What a COMPLETED verification attempt concluded.
 *
 * 🔴 Seven outcomes and not three, because collapsing any pair of them is how this gate
 * fails open. In particular `unknown` (the chain read did not complete) is not
 * `not-registered` (the chain said no), and neither is `declined` (the user refused to
 * sign) or `sign-failed` (the wallet could not sign at all). B4 lets only `registered` and
 * `not-required` through to the money path; every other outcome needs its own sentence,
 * because each one has a different thing the user must do next.
 */
export type NearKeyVerificationOutcome =
  /** Not a NEAR named account — the contract authenticates this identity on its own. */
  | { kind: "not-required" }
  /** The user cancelled the signature. A deliberate choice, so B4 leaves them in read-only. */
  | { kind: "declined" }
  /** The wallet could not sign (locked, missing, no NEP-413 support). Not a user choice. */
  | { kind: "sign-failed"; message: string }
  /**
   * 🔴 The wallet signed with a DIFFERENT account than the one the session is connected as.
   * Measured in mainnet on 2026-08-13 (D-227/D-232): Meteor offered `admin`'s key for a
   * payload naming `budget`, with no warning, and the resulting cross-authorisation is on
   * chain. We stop here on purpose — neither the check nor (in B3) the registration runs,
   * because registering the pair (wrong account, this key) is exactly that contamination.
   */
  | { kind: "signer-mismatch"; sessionAccountId: string; signerAccountId: string }
  | { kind: "registered"; accountId: string; publicKey: string }
  | { kind: "not-registered"; accountId: string; publicKey: string }
  | { kind: "unknown"; accountId: string; publicKey: string };

/**
 * What a registration ATTEMPT left behind (008.plan D-280, block B3).
 *
 * These live in the same union as the detection states, and not in a parallel one, because
 * they answer the same question the user is asking — "can this account operate?" — and
 * because the successful ending of a registration IS a detection state: `registered`,
 * reached the only way it may be reached, by re-reading the chain. Two overlapping states
 * would mean two banners able to contradict each other on the same screen.
 *
 * 🔴 Every one of these carries `accountId` and `publicKey`, and they are the pair that came
 * out of `not-registered`. A retry must resend the SAME key, never re-derive one: the key
 * B2 saw sign is the only key this app is allowed to authorise.
 */
export type NearKeyRegistrationPhase =
  /** The transaction is in flight, or the wallet is showing its approval screen. */
  | { kind: "registering"; accountId: string; publicKey: string }
  /** The user rejected the transaction. A choice, so the offer stays on the table. */
  | { kind: "register-declined"; accountId: string; publicKey: string }
  /**
   * The wallet could not send it, or the contract reverted it. Nothing was registered.
   *
   * `cause: "requires-full-access"` (008.plan D-280, block B5) marks the one sub-case with a
   * different next step: the signing key is a `FunctionCall` key, which the protocol never
   * lets attach the 1-yocto deposit `add_public_key` requires, so resending is guaranteed to
   * fail the same way every time. Undefined for every other reason — those retry in place.
   */
  | {
      kind: "register-failed";
      accountId: string;
      publicKey: string;
      message: string;
      cause?: "requires-full-access";
    }
  /**
   * We stopped waiting and the chain does not show the key yet. 🔴 NOT a failure — the
   * transaction may still be in flight, so the next step is to LOOK AGAIN, never to send a
   * second one.
   */
  | { kind: "register-unconfirmed"; accountId: string; publicKey: string }
  /**
   * 🔴 The transaction succeeded and the chain still does not show the key. The measured
   * cause is a wallet that signed with a different account, which registers the key under
   * THAT account. Never offers to send the same transaction again: it would land in the same
   * wrong place.
   */
  | { kind: "register-not-applied"; accountId: string; publicKey: string };

/**
 * The full UI-facing state, adding the phases that are not conclusions.
 *
 * 🔴 `unchecked` is NOT `unknown`. "We have not asked yet" and "we asked and the read
 * failed" look identical to a careless reducer and mean opposite things to a user: the
 * first is fixed by one click, the second by retrying against a chain that is not
 * answering. A restored session without an exact persisted `(account, wallet, key)` proof
 * starts `unchecked`; one with that proof silently re-reads the chain before opening the
 * gate. The stored tuple proves only a previous signature, never current registration.
 */
export type NearKeyVerification =
  | { kind: "unchecked" }
  | { kind: "checking" }
  | NearKeyVerificationOutcome
  | NearKeyRegistrationPhase;

/**
 * The only two states that may reach a path which moves real funds (D-280, block B4).
 *
 * 🔴 An ALLOWLIST of two, mirroring `REGISTERABLE` in `near-key-register.ts` and for the same
 * reason: a state added to this union later is DENIED until somebody decides otherwise. A
 * denylist would admit it by omission, and the omission would first surface in production as
 * a Verifier rejection with no explanation — the exact failure D-280 exists to remove.
 *
 * The other twelve are not degrees of confidence, and none of them is a "probably yes":
 *   · `unknown` is a read that never completed. It is evidence about the RPC, not the key.
 *   · `register-not-applied` is the dangerous one: a SUCCESSFUL receipt whose key the chain
 *     does not show (B3). It looks the most like a yes and means the key was registered
 *     under somebody else's account.
 *   · `unchecked` is a restored session with no matching proof, or one whose wallet/key
 *     changed — see `ensureCanOperate`, the one place allowed to prompt from that state.
 */
const MAY_OPERATE: ReadonlySet<NearKeyVerification["kind"]> = new Set([
  "registered",
  "not-required",
]);

/**
 * Whether this wallet may sign something that moves funds.
 *
 * Exported separately from the assertion so a screen can ask the question without catching
 * an exception — the money paths assert, and anything that only wants to explain itself
 * reads this.
 *
 * Deliberately does NOT re-check that `registered` carries a non-empty key, unlike
 * `registrationTarget`. That guard earns its place there because a blank key would be
 * written on chain; here there is nothing to write, and `registered` is unconstructible with
 * a blank key anyway (B1 answers `unknown` for one, so it never reaches this state).
 */
export function canOperate(verification: NearKeyVerification): boolean {
  return MAY_OPERATE.has(verification.kind);
}

/**
 * Thrown at the door instead of letting an unregistered key reach a wallet prompt.
 *
 * 🔴 The message is deliberately state-NEUTRAL and points at the banner, which is where the
 * twelve state-specific sentences and their actions already live (B2/B3). Copying them here
 * would be a second place for them to drift, and the banner is on screen at the same time.
 *
 * 🔴 The wording also has to survive `normalizeWalletError`, which classifies by keyword:
 * a message containing "cancel", "reject", "denied", "not available", "locked" (and friends)
 * would be re-reported by the portfolio editor as a cancelled or unusable wallet. Echoing
 * the banner's own `declined` copy ("Verification cancelled") would do exactly that.
 */
export class NearKeyNotVerifiedError extends Error {
  constructor(
    readonly verificationKind: NearKeyVerification["kind"],
    lang: "en" | "es" = "en",
  ) {
    super(
      lang === "es"
        ? "Esta wallet todavía no puede mover fondos. Cierra esto y sigue los pasos del " +
            "aviso de arriba del panel, después reintenta."
        : "This wallet cannot move funds yet. Close this and follow the steps in the notice " +
            "at the top of the dashboard, then try again.",
    );
    this.name = "NearKeyNotVerifiedError";
  }
}

/**
 * Raised after an inline verification succeeds so the operational signature is requested
 * from a fresh user gesture.
 *
 * The first live Meteor run that tried chaining both prompts confirmed the browser/wallet
 * limitation: Connect reopened, but the second request never reached Meteor. A fresh login
 * still verifies immediately after connecting; this fallback is for a restored session
 * without a matching persisted proof, or one whose silent on-chain recheck could not open
 * the gate.
 */
export class NearKeyJustVerifiedError extends Error {
  constructor(lang: "en" | "es" = "en") {
    super(
      lang === "es"
        ? "Tu wallet quedó verificada. Vuelve a presionar el botón para continuar."
        : "Your wallet is verified. Press the button again to continue.",
    );
    this.name = "NearKeyJustVerifiedError";
  }
}

/**
 * The guard every money path runs BEFORE building an envelope or raising a wallet prompt.
 *
 * 🔴 It throws rather than returning false, and that is the whole design of B4. The
 * alternative — teaching a route predicate to answer "not a live route" — was measured to be
 * worse than doing nothing: `isRealWithdrawalRoute` returning false falls through to
 * `mockContract.withdraw` (`dashboard-shell.tsx`), so a blocked account would be shown a
 * SUCCESSFUL withdrawal that never happened. Refusing loudly is the only safe direction.
 *
 * 🔴 `unchecked` is the one state it does not refuse outright, and that is a friction
 * decision the operator locked, not a softening of the gate. It is reached when a restored
 * session has no exact persisted proof or the current wallet/key differs. Refusing it flatly
 * would charge that tester the full round trip — refused, close the modal, find the banner,
 * sign, reopen, refill — so verifying inline spends the signature where one is already
 * expected and keeps the form.
 *
 * When that inline verification succeeds, it stops once so the operational signature gets a
 * fresh user gesture. This is not theoretical: chaining the prompts left Meteor Connect
 * waiting forever without opening the second request in the wallet. The form remains filled,
 * and the retry no longer repeats verification because the bridge already published
 * `registered`.
 *
 * The other eleven refuse without a prompt: each has already put its own sentence and its own
 * next step on screen, and three of them (`not-registered`, `register-declined`,
 * `register-failed`) need a transaction that costs gas — never something to fire off the back
 * of a withdrawal click.
 */
export async function ensureCanOperate(
  verification: NearKeyVerification,
  verify: () => Promise<NearKeyVerification>,
  lang: "en" | "es" = "en",
): Promise<void> {
  // The overwhelmingly common path, and it must cost nothing: no prompt, no await that
  // matters, no chance of a second wallet popup for someone already verified this session.
  // This is also what the retry after an inline verification lands on.
  if (canOperate(verification)) return;
  if (verification.kind !== "unchecked") {
    throw new NearKeyNotVerifiedError(verification.kind, lang);
  }
  // 🔴 The result is READ, never assumed. `verify` resolving is not the same as the gate
  // opening — it resolves just as truthfully with `not-registered`, `signer-mismatch` or a
  // failed chain read, and each of those must stop the money here.
  const outcome = await verify();
  if (!canOperate(outcome)) {
    throw new NearKeyNotVerifiedError(outcome.kind, lang);
  }
  // The live Meteor run proved that Connect can reopen without delivering this second prompt
  // to the wallet. Stop after verification; a fresh click takes the fast branch above.
  throw new NearKeyJustVerifiedError(lang);
}

/** How long the probe envelope stays valid. It is never broadcast; short is free. */
export const KEY_PROBE_DEADLINE_SECS = 120;

/**
 * How long to wait on the wallet before concluding `sign-failed` (008.plan D-283).
 *
 * 🔴 Without this the promise from a wallet window the user CLOSED never settles, so
 * `near-bridge` stays on `checking` forever and `ensureCanOperate` — which denies hard on
 * `checking` — locks all four money doors on an account that is perfectly fine, with a page
 * reload as the only way out. Falling to `sign-failed` is fail-closed and reuses a state that
 * already has its sentence and its "Try again" button.
 *
 * Generous for the same reason `REGISTER_SEND_TIMEOUT_MS` is: the human is reading an approval
 * screen. Matched to {@link KEY_PROBE_DEADLINE_SECS} because a signature that arrives later is
 * one over an envelope that has already expired.
 */
export const SIGN_PROMPT_TIMEOUT_MS = KEY_PROBE_DEADLINE_SECS * 1000;

export type Nep413Request = {
  message: string;
  recipient: string;
  nonce: Uint8Array;
};

/**
 * The message the wallet is asked to sign: near.com's "verify ownership" envelope, whose
 * `intents` array is EMPTY.
 *
 * That empty array is the safety property, not a formality — an intents envelope that
 * authorises zero intents cannot move anything, so this prompt costs the user nothing even
 * though it is shaped like the real thing. It is deliberately NOT given a versioned V1
 * nonce like `vault-envelope.ts` builds: that nonce needs `current_salt` read from the
 * chain, and this envelope is never submitted, so requiring an RPC round-trip would add a
 * failure mode to a probe that has no on-chain destiny.
 *
 * Key order is pinned here because the signed bytes are what the wallet displays and what
 * the signature commits to, exactly as `buildErc191Payload` pins its own.
 */
export function buildKeyProbeRequest(p: {
  accountId: string;
  nonce: Uint8Array;
  deadlineSecs: number;
}): Nep413Request {
  const message = JSON.stringify({
    signer_id: p.accountId,
    deadline: new Date(p.deadlineSecs * 1000).toISOString(),
    intents: [],
  });
  return { message, recipient: INTENTS_CONTRACT_ID, nonce: p.nonce };
}

/** The subset of HOT Connect's `SignedMessage` this module needs. */
export type ProbeSignature = {
  accountId: string;
  publicKey: string;
  signature: string;
};

export type RunVerificationInput = {
  chainKind: ChainKind;
  /** The account the session believes it is connected as (`signedAccountId`). */
  sessionAccountId: string;
  /** Injected so this stays testable without a wallet: `lib.signNEP413Message`. */
  signNep413: (request: Nep413Request) => Promise<ProbeSignature>;
  /** Injected for deterministic tests; defaults to a fresh 32 random bytes. */
  makeNonce?: () => Uint8Array;
  /** Injected for deterministic tests; defaults to {@link SIGN_PROMPT_TIMEOUT_MS}. */
  signTimeoutMs?: number;
  /** Injected for deterministic tests; defaults to `Date.now`. */
  now?: () => number;
};

export type CompleteVerificationInput = {
  chainKind: ChainKind;
  sessionAccountId: string;
  signed: ProbeSignature;
};

function randomNonce(): Uint8Array {
  const nonce = new Uint8Array(32);
  crypto.getRandomValues(nonce);
  return nonce;
}

/**
 * Runs the whole gate: decide → sign → read.
 *
 * 🔴 The order is forced and cannot be rearranged. `requiresKeyRegistration` is synchronous
 * and touches no network precisely so it can run BEFORE the prompt: the five non-NEAR
 * families and NEAR implicit accounts must never be charged a signature for a gate that
 * does not apply to them. Only once a signature exists is there a key to ask the chain
 * about.
 */
export async function runNearKeyVerification(
  input: RunVerificationInput,
): Promise<NearKeyVerificationOutcome> {
  const { chainKind, sessionAccountId, signNep413 } = input;

  if (!requiresKeyRegistration(chainKind, sessionAccountId)) return { kind: "not-required" };

  const deadlineSecs = Math.floor((input.now?.() ?? Date.now()) / 1000) + KEY_PROBE_DEADLINE_SECS;
  const request = buildKeyProbeRequest({
    accountId: sessionAccountId,
    nonce: (input.makeNonce ?? randomNonce)(),
    deadlineSecs,
  });

  let signTimer: ReturnType<typeof setTimeout> | undefined;
  let signing: Promise<ProbeSignature> | undefined;
  let signed: ProbeSignature | "timed-out";
  try {
    // Called INSIDE the try, exactly where the bare `await` used to be: an adapter that
    // throws synchronously instead of returning a rejected promise must still be classified
    // here, never escape the gate as a raw exception.
    signing = signNep413(request);
    signed = await Promise.race([
      signing,
      new Promise<"timed-out">((resolve) => {
        signTimer = setTimeout(() => resolve("timed-out"), input.signTimeoutMs ?? SIGN_PROMPT_TIMEOUT_MS);
      }),
    ]);
  } catch (e) {
    // A refusal and a broken wallet are different problems with different fixes, and
    // `normalizeWalletError` is already the project's classifier for exactly this split.
    const n = normalizeWalletError(e);
    return n.kind === "cancel" ? { kind: "declined" } : { kind: "sign-failed", message: n.message };
  } finally {
    clearTimeout(signTimer);
  }

  if (signed === "timed-out") {
    // The prompt is still open and settles on its own long after this returned, so its
    // eventual rejection is ours to swallow — never rethrown into an unhandled rejection on
    // a path where we already told the user we stopped waiting. Measured redundant TODAY
    // (`Promise.race` above already registered a handler on `signing`, so the mutation that
    // deletes this line stays green); it is here so the invariant survives the race being
    // restructured, exactly as `near-key-register.ts` keeps it.
    void signing?.catch(() => undefined);
    // 🔴 A signature that lands after this is DROPPED, not rescued. Re-entering it would
    // overwrite a state the user may already have moved on from, and `verifyKey` in
    // `near-bridge` has its own staleness rule for the account changing mid-prompt.
    return { kind: "sign-failed", message: "The wallet did not answer the signature request" };
  }

  return completeNearKeyVerification({ chainKind, sessionAccountId, signed });
}

/**
 * Completes the gate from a signature already produced during `signInAndSignMessage`.
 *
 * The combined login and the restored-session probe differ only in how the signature is
 * obtained. Attribution and the on-chain registration read must stay identical, so both
 * paths meet here instead of growing two subtly different security checks.
 */
export async function completeNearKeyVerification({
  chainKind,
  sessionAccountId,
  signed,
}: CompleteVerificationInput): Promise<NearKeyVerificationOutcome> {
  if (!requiresKeyRegistration(chainKind, sessionAccountId)) return { kind: "not-required" };

  // Exact comparison, only whitespace-trimmed. NEAR account ids are lowercase by protocol,
  // so case folding would buy nothing real while making a genuine mismatch harder to trip.
  // The asymmetry decides it: a false mismatch costs one confused user with a message that
  // names both accounts, while a missed one costs an on-chain authorisation for the wrong
  // account — the failure that is already sitting in mainnet.
  const signerAccountId = signed.accountId.trim();
  if (signerAccountId !== sessionAccountId.trim()) {
    return { kind: "signer-mismatch", sessionAccountId, signerAccountId };
  }

  return recheckNearKeyVerification({
    chainKind,
    accountId: signerAccountId,
    publicKey: signed.publicKey,
  });
}

/** Re-reads registration for an exact pair that was already observed signing. */
export async function recheckNearKeyVerification(input: {
  chainKind: ChainKind;
  accountId: string;
  publicKey: string;
}): Promise<NearKeyVerificationOutcome> {
  const { chainKind, accountId, publicKey } = input;
  const status = await checkKeyRegistration({ chainKind, accountId, publicKey });

  switch (status) {
    case "registered":
      return { kind: "registered", accountId, publicKey };
    case "not-registered":
      return { kind: "not-registered", accountId, publicKey };
    case "not-required":
      // Unreachable in practice — `requiresKeyRegistration` already returned true above and
      // `checkKeyRegistration` re-runs the same predicate. Mapped rather than merged into
      // the default so a future change to either predicate surfaces as this branch instead
      // of silently reporting a failed read.
      return { kind: "not-required" };
    default:
      // 🔴 An empty `publicKey` lands here too (B1 answers `unknown` for it). B3 must not
      // offer to register a key it cannot name, so it reads the key off this state rather
      // than assuming one exists.
      return { kind: "unknown", accountId, publicKey };
  }
}
