import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildKeyProbeRequest,
  canOperate,
  ensureCanOperate,
  NearKeyJustVerifiedError,
  NearKeyNotVerifiedError,
  runNearKeyVerification,
  SIGN_PROMPT_TIMEOUT_MS,
  type NearKeyVerification,
  type ProbeSignature,
} from "./near-key-verification";
import { INTENTS_CONTRACT_ID } from "@/features/wallet/config/network";
import { normalizeWalletError } from "@/features/wallet/adapter/normalize-error";

// D-280 B2. The gate these tests defend is not "does it read the chain" — B1 covers that.
// It is the ORDER and the ATTRIBUTION: no family pays a signature prompt for a gate that
// does not apply to it, no answer is ever given about a key we did not see sign, and a
// wallet that signs as somebody else is stopped BEFORE anything is read or written.
//
// Fixtures are the account and key measured in mainnet during B0 (s133), so a failure here
// is comparable against the probe's own output.

const ACCOUNT = "pablofork.near";
const SIGNING_KEY = "ed25519:2EVgyHyRbaLZjSDPzR8bnLTiPWtTYQ9GLNvtDoHZ4qGB";
/** A second FullAccess on the same account — B0 found three, only one registered. */
const OTHER_KEY = "ed25519:8bYe95FVqXk3Qk3xkP9tQpTqXk3Qk3xkP9tQpTqXk3Qk";
const IMPLICIT_ACCOUNT = "8b58bb68e6ba82b2ba0f9dc4e5f9f4e0f2c4de5c0a0a1c2b3d4e5f60718293a4";

const FIXED_NONCE = new Uint8Array(32).fill(7);
const FIXED_NOW = () => 1_700_000_000_000;

function mockViewResult(value: unknown): Response {
  const bytes = Array.from(new TextEncoder().encode(JSON.stringify(value)));
  return new Response(
    JSON.stringify({ result: { result: bytes, logs: [], block_height: 1, block_hash: "h" } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function signsAs(overrides: Partial<ProbeSignature> = {}) {
  const signed: ProbeSignature = {
    accountId: ACCOUNT,
    publicKey: SIGNING_KEY,
    signature: "sig",
    ...overrides,
  };
  return vi.fn(async () => signed);
}

/** The `has_public_key` args the RPC actually received, decoded from base64. */
function lastViewArgs(): Record<string, unknown> {
  const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
  const body = JSON.parse(fetchMock.mock.calls.at(-1)![1].body as string);
  return JSON.parse(atob(body.params.args_base64));
}

function run(input: Partial<Parameters<typeof runNearKeyVerification>[0]> = {}) {
  return runNearKeyVerification({
    chainKind: "near",
    sessionAccountId: ACCOUNT,
    signNep413: signsAs(),
    makeNonce: () => FIXED_NONCE,
    now: FIXED_NOW,
    ...input,
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("buildKeyProbeRequest — the envelope the wallet is asked to sign", () => {
  it("authorises nothing: `intents` is an empty array", () => {
    const { message } = buildKeyProbeRequest({
      accountId: ACCOUNT,
      nonce: FIXED_NONCE,
      deadlineSecs: 1_700_000_120,
    });
    // The safety property of the whole prompt. If this array is ever non-empty, a
    // "verification" the user was told is free becomes a signed authorisation.
    expect(JSON.parse(message).intents).toEqual([]);
  });

  it("names the session account as signer and addresses the intents contract", () => {
    const req = buildKeyProbeRequest({
      accountId: ACCOUNT,
      nonce: FIXED_NONCE,
      deadlineSecs: 1_700_000_120,
    });
    expect(JSON.parse(req.message).signer_id).toBe(ACCOUNT);
    expect(req.recipient).toBe(INTENTS_CONTRACT_ID);
    expect(req.nonce).toBe(FIXED_NONCE);
  });

  it("emits the deadline as an ISO-8601 string, the form the schema accepts", () => {
    const { message } = buildKeyProbeRequest({
      accountId: ACCOUNT,
      nonce: FIXED_NONCE,
      deadlineSecs: 1_700_000_120,
    });
    expect(JSON.parse(message).deadline).toBe("2023-11-14T22:15:20.000Z");
  });
});

describe("runNearKeyVerification — who pays a signature prompt", () => {
  it("does NOT prompt the five non-NEAR families", async () => {
    const signNep413 = signsAs();
    const result = await run({ chainKind: "evm", sessionAccountId: "0xabc", signNep413 });
    expect(result).toEqual({ kind: "not-required" });
    // The point of `requiresKeyRegistration` being synchronous and network-free is that it
    // runs BEFORE the prompt. A wallet popup here would be a bug the user feels.
    expect(signNep413).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("does NOT prompt a NEAR implicit account", async () => {
    const signNep413 = signsAs();
    const result = await run({ sessionAccountId: IMPLICIT_ACCOUNT, signNep413 });
    expect(result).toEqual({ kind: "not-required" });
    expect(signNep413).not.toHaveBeenCalled();
  });

  it("prompts a NEAR named account", async () => {
    const signNep413 = signsAs();
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockViewResult(true));
    await run({ signNep413 });
    expect(signNep413).toHaveBeenCalledTimes(1);
  });
});

describe("runNearKeyVerification — the key it asks about", () => {
  it("asks about the key it SAW SIGN, not the session account alone", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockViewResult(true));
    await run({ signNep413: signsAs({ publicKey: OTHER_KEY }) });
    // B0 killed "is the list empty?" and "does it have any FullAccess registered?":
    // `pablofork.near` holds three FullAccess keys and exactly one is registered, so only
    // the exact key that will sign answers the question.
    expect(lastViewArgs()).toEqual({ account_id: ACCOUNT, public_key: OTHER_KEY });
  });

  it("reports registered with the account and key, so B3 can act on them", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockViewResult(true));
    expect(await run()).toEqual({
      kind: "registered",
      accountId: ACCOUNT,
      publicKey: SIGNING_KEY,
    });
  });

  it("reports not-registered when the chain says no", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockViewResult(false));
    expect(await run()).toEqual({
      kind: "not-registered",
      accountId: ACCOUNT,
      publicKey: SIGNING_KEY,
    });
  });

  it("reports unknown — NOT not-registered — when the read fails", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network down"));
    const result = await run();
    // The whole reason B1 has four outcomes. Calling this `not-registered` would send the
    // user to sign (and pay for) a transaction they may not need; calling it `registered`
    // would wave them into the money path on an assumption.
    expect(result).toEqual({ kind: "unknown", accountId: ACCOUNT, publicKey: SIGNING_KEY });
  });
});

describe("runNearKeyVerification — a wallet that will not or cannot sign", () => {
  it("classifies a user cancel as `declined`, which B4 turns into read-only", async () => {
    const signNep413 = vi.fn(async () => {
      throw new Error("User rejected the request");
    });
    expect(await run({ signNep413 })).toEqual({ kind: "declined" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("classifies a broken wallet as `sign-failed`, keeping its message", async () => {
    const signNep413 = vi.fn(async () => {
      throw new Error("Wallet does not support signMessage");
    });
    // Not a `declined`: nobody chose this, and telling a user with a locked wallet that
    // they cancelled sends them looking for a decision they never made.
    expect(await run({ signNep413 })).toEqual({
      kind: "sign-failed",
      message: "Wallet does not support signMessage",
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

// D-283. A wallet window the user CLOSED answers neither yes nor no, so without a timeout the
// promise never settles: `near-bridge` stays on `checking`, and `ensureCanOperate` denies hard
// on `checking` — all four money doors locked forever on a healthy account, page reload the
// only way out. These pin the bounded ending and that it stays distinguishable from the two
// endings that already existed.
describe("runNearKeyVerification — a wallet that never answers at all", () => {
  const never = () => new Promise<ProbeSignature>(() => {});

  it("waits at least as long as a human takes to read an approval screen", () => {
    // The default is the only value a real wallet ever meets. Tightening it to something
    // impatient would turn "the user thought about it" into "your wallet could not sign".
    expect(SIGN_PROMPT_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });

  it("stops waiting and concludes `sign-failed`, which has a retry button", async () => {
    const result = await run({ signNep413: never, signTimeoutMs: 1 });
    expect(result.kind).toBe("sign-failed");
    // Diagnostic, but it still has to name what happened rather than be an empty string.
    expect((result as { message: string }).message).toMatch(/did not answer/);
    // Nothing was read: there is no key to ask the chain about.
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("does not spend the timeout on a wallet that answers in time", async () => {
    globalThis.fetch = vi.fn(async () => mockViewResult(true)) as never;
    const signNep413 = vi.fn(
      () => new Promise<ProbeSignature>((resolve) =>
        setTimeout(() => resolve({ accountId: ACCOUNT, publicKey: SIGNING_KEY, signature: "sig" }), 1),
      ),
    );
    // A generous window, and the normal path must be untouched by it — including not making
    // the caller wait for it.
    expect(await run({ signNep413, signTimeoutMs: 5_000 })).toEqual({
      kind: "registered",
      accountId: ACCOUNT,
      publicKey: SIGNING_KEY,
    });
  });

  it("does not leave the two-minute timer running once the wallet has answered", async () => {
    // Every verification would otherwise hold a pending timer and its closure for two
    // minutes, on a callback whose answer nobody is waiting for any more.
    globalThis.fetch = vi.fn(async () => mockViewResult(true)) as never;
    vi.useFakeTimers();
    try {
      await run();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps `declined` and a broken wallet distinct from the silence", async () => {
    const declined = await run({
      signNep413: vi.fn(async () => { throw new Error("User rejected the request"); }),
      signTimeoutMs: 1,
    });
    const broken = await run({
      signNep413: vi.fn(async () => { throw new Error("Wallet does not support signMessage"); }),
      signTimeoutMs: 1,
    });
    const silent = await run({ signNep413: never, signTimeoutMs: 1 });
    // Three endings, three different things the user has to do. A rejection that lost the
    // race to the timer would report the silent copy for a wallet that answered.
    expect(declined).toEqual({ kind: "declined" });
    expect(broken).toEqual({ kind: "sign-failed", message: "Wallet does not support signMessage" });
    expect(silent).not.toEqual(broken);
  });

  it("still classifies a wallet that throws synchronously rather than rejecting", async () => {
    // The timeout needs a handle on the promise, which puts the CALL next to the race. If it
    // drifts outside the try, an adapter that throws before returning a promise escapes the
    // gate as a raw exception and the four money doors see something they cannot classify.
    const signNep413 = vi.fn(() => {
      throw new Error("Wallet does not support signMessage");
    });
    expect(await run({ signNep413, signTimeoutMs: 1 })).toEqual({
      kind: "sign-failed",
      message: "Wallet does not support signMessage",
    });
  });

  it("does not leave the abandoned signature as an unhandled rejection", async () => {
    // The prompt outlives this call by design. If its eventual rejection is not swallowed it
    // surfaces in the user's console on a path where we already told them we stopped waiting.
    const onUnhandled = vi.fn();
    process.on("unhandledRejection", onUnhandled);
    let reject: (e: unknown) => void = () => {};
    const result = await run({
      signNep413: () => new Promise<ProbeSignature>((_, r) => { reject = r; }),
      signTimeoutMs: 1,
    });
    reject(new Error("wallet window closed"));
    await new Promise((r) => setTimeout(r, 10));
    process.off("unhandledRejection", onUnhandled);
    expect(result.kind).toBe("sign-failed");
    expect(onUnhandled).not.toHaveBeenCalled();
  });

  it("drops a signature that arrives after we stopped waiting", async () => {
    let resolveLate: (s: ProbeSignature) => void = () => {};
    const result = await run({
      signNep413: () => new Promise<ProbeSignature>((r) => { resolveLate = r; }),
      signTimeoutMs: 1,
    });
    resolveLate({ accountId: ACCOUNT, publicKey: SIGNING_KEY, signature: "sig" });
    await new Promise((r) => setTimeout(r, 10));
    // 🔴 The late answer must not be rescued: it would read the chain and overwrite a state
    // the user may already have moved on from.
    expect(result.kind).toBe("sign-failed");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("runNearKeyVerification — the wallet signed as somebody else", () => {
  it("stops at `signer-mismatch` and reads NOTHING", async () => {
    const result = await run({ signNep413: signsAs({ accountId: "intentfolio-admin.near" }) });
    expect(result).toEqual({
      kind: "signer-mismatch",
      sessionAccountId: ACCOUNT,
      signerAccountId: "intentfolio-admin.near",
    });
    // Measured in mainnet on 2026-08-13 (D-227/D-232): this exact shape — one account's key
    // offered for another account's payload — put a cross-authorisation on chain. Not
    // reading is what keeps B3 from ever registering the wrong pair.
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("names BOTH accounts, because that is the only actionable part", async () => {
    const result = await run({ signNep413: signsAs({ accountId: "other.near" }) });
    expect(result).toMatchObject({ sessionAccountId: ACCOUNT, signerAccountId: "other.near" });
  });

  it("ignores surrounding whitespace rather than reporting a false mismatch", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockViewResult(true));
    const result = await run({ signNep413: signsAs({ accountId: ` ${ACCOUNT} ` }) });
    expect(result).toMatchObject({ kind: "registered", accountId: ACCOUNT });
  });

  it("treats a case difference as a mismatch — the safe direction", async () => {
    // NEAR account ids are lowercase by protocol, so this is not a legitimate spelling of
    // the same account. A false mismatch costs one confused user with a message naming both
    // accounts; a missed one costs an on-chain authorisation for the wrong account.
    const result = await run({ signNep413: signsAs({ accountId: "PabloFork.near" }) });
    expect(result).toMatchObject({ kind: "signer-mismatch" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// D-280 B4 — the money door.
//
// What these defend is not "does it say no" but the shape of the no: an ALLOWLIST, so a
// state nobody thought about is denied rather than admitted by omission; a refusal that
// THROWS, because the one alternative was measured to be worse than doing nothing (a route
// predicate answering false falls through to the mock and reports a withdrawal that never
// happened); and exactly one state — `unchecked`, used when no matching proof exists — allowed to
// spend a prompt instead of sending the user back to the banner.
// ─────────────────────────────────────────────────────────────────────────────────────────

const PAIR = { accountId: ACCOUNT, publicKey: SIGNING_KEY } as const;

/**
 * The verdict this gate owes EVERY state in the union, as a `Record` keyed by the union
 * itself.
 *
 * 🔴 The `Record<NearKeyVerification["kind"], …>` is the whole point and replaces a count
 * that only ever counted itself: adding a state to `NearKeyVerification` without giving it a
 * verdict here is a COMPILE error, so a new state cannot slip into production without
 * somebody writing down whether it may move money. An `expect(list.length).toBe(n)` proved
 * nothing — the list and the number both lived in this file.
 */
const VERDICT: Record<NearKeyVerification["kind"], "pass" | "deny"> = {
  "not-required": "pass",
  registered: "pass",
  unchecked: "deny",
  checking: "deny",
  declined: "deny",
  "sign-failed": "deny",
  "signer-mismatch": "deny",
  "not-registered": "deny",
  unknown: "deny",
  registering: "deny",
  "register-declined": "deny",
  "register-failed": "deny",
  "register-unconfirmed": "deny",
  "register-not-applied": "deny",
};

/** One real value per state, carrying the fields each one actually has. */
const SAMPLES: NearKeyVerification[] = [
  { kind: "not-required" },
  { kind: "registered", ...PAIR },
  { kind: "unchecked" },
  { kind: "checking" },
  { kind: "declined" },
  { kind: "sign-failed", message: "wallet is locked" },
  { kind: "signer-mismatch", sessionAccountId: ACCOUNT, signerAccountId: "other.near" },
  { kind: "not-registered", ...PAIR },
  { kind: "unknown", ...PAIR },
  { kind: "registering", ...PAIR },
  { kind: "register-declined", ...PAIR },
  { kind: "register-failed", ...PAIR, message: "boom" },
  { kind: "register-unconfirmed", ...PAIR },
  { kind: "register-not-applied", ...PAIR },
];

const DENIED = SAMPLES.filter((v) => VERDICT[v.kind] === "deny");

describe("canOperate — the allowlist of two", () => {
  it("lets `registered` through", () => {
    expect(canOperate({ kind: "registered", ...PAIR })).toBe(true);
  });

  it("lets `not-required` through", () => {
    // The five non-NEAR families and NEAR implicit accounts. Also what the context reports
    // for a family that publishes no gate at all — reading THAT as "not verified yet" would
    // block every EVM, Solana, TON, Stellar and Tron user.
    expect(canOperate({ kind: "not-required" })).toBe(true);
  });

  it.each(DENIED.map((v) => [v.kind, v] as const))("denies `%s`", (_kind, verification) => {
    expect(canOperate(verification)).toBe(false);
  });

  it.each(SAMPLES.map((v) => [v.kind, v] as const))(
    "gives `%s` the verdict the union demands one for",
    (kind, verification) => {
      expect(canOperate(verification)).toBe(VERDICT[kind] === "pass");
    },
  );

  it("has a sample for every state in the union, so the table above is not partly unused", () => {
    // Guards the other half of `VERDICT`: the compiler forces a verdict per state, but not a
    // VALUE per state, so a new state could get "deny" written here and still never be run
    // through `canOperate`.
    expect(SAMPLES.map((v) => v.kind).sort()).toEqual(Object.keys(VERDICT).sort());
  });

  it("counts fourteen states, of which twelve deny", () => {
    // 🔴 FOURTEEN, not twelve. The B3 handoff and the banner both say "twelve states"; that
    // is the count of states that PAINT something (`registered` and `not-required` render
    // nothing on purpose — a healthy account shows no strip). The union itself is 14, so the
    // gate has 12 denials to cover, not the "ten" the handoff claimed. Derived from the
    // keyed table rather than from a literal, so it cannot drift away from the union.
    expect(Object.keys(VERDICT)).toHaveLength(14);
    expect(DENIED).toHaveLength(12);
  });

  it("denies a state this file has never heard of", () => {
    // 🔴 The allowlist-vs-denylist test. A denylist would admit a future state by omission,
    // and the omission would first surface in production as a Verifier rejection with no
    // explanation — which is the entire failure D-280 exists to remove.
    expect(canOperate({ kind: "some-future-state" } as unknown as NearKeyVerification)).toBe(false);
  });
});

describe("ensureCanOperate — what the four money doors run", () => {
  it("passes a registered account without spending a prompt", async () => {
    const verify = vi.fn();
    await expect(
      ensureCanOperate({ kind: "registered", ...PAIR }, verify),
    ).resolves.toBeUndefined();
    // The common path has to cost nothing. Re-verifying here would put a second wallet
    // popup in front of someone who already verified this session.
    expect(verify).not.toHaveBeenCalled();
  });

  it("passes `not-required` without spending a prompt", async () => {
    const verify = vi.fn();
    await expect(ensureCanOperate({ kind: "not-required" }, verify)).resolves.toBeUndefined();
    expect(verify).not.toHaveBeenCalled();
  });

  it.each(DENIED.filter((v) => v.kind !== "unchecked").map((v) => [v.kind, v] as const))(
    "refuses `%s` WITHOUT running a verification",
    async (_kind, verification) => {
      const verify = vi.fn();
      await expect(ensureCanOperate(verification, verify)).rejects.toBeInstanceOf(
        NearKeyNotVerifiedError,
      );
      // Each of these has already put its own sentence and its own next step on screen, and
      // three of them need a transaction that costs gas — never something to fire off the
      // back of a withdrawal click.
      expect(verify).not.toHaveBeenCalled();
    },
  );

  it("carries the blocking state on the error", async () => {
    const err = await ensureCanOperate({ kind: "unknown", ...PAIR }, vi.fn()).catch((e) => e);
    expect(err).toBeInstanceOf(NearKeyNotVerifiedError);
    expect(err.verificationKind).toBe("unknown");
  });

  // ── the friction decision: `unchecked` verifies instead of refusing ──────────────────
  it("verifies on the spot from `unchecked`, then stops before Meteor's second prompt", async () => {
    // Every page reload lands on `unchecked` (`near-bridge.tsx` resets on each account change
    // and only `connect()` arms the auto-check), so a tester who registered yesterday would
    // otherwise pay the full round trip — refused, close the modal, find the banner, sign,
    // reopen, refill the form — on every single refresh. Verifying here keeps the form.
    //
    // The first live Meteor run proved that chaining does not reach the wallet: Connect
    // reopens and waits forever. A fresh click is required for the operational signature.
    const verify = vi.fn(async (): Promise<NearKeyVerification> => ({
      kind: "registered",
      ...PAIR,
    }));
    await expect(ensureCanOperate({ kind: "unchecked" }, verify)).rejects.toBeInstanceOf(
      NearKeyJustVerifiedError,
    );
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("distinguishes a successful inline verification from a refusal", async () => {
    const ok = await ensureCanOperate(
      { kind: "unchecked" },
      async () => ({ kind: "registered", ...PAIR }),
    ).catch((e) => e);
    const bad = await ensureCanOperate(
      { kind: "unchecked" },
      async () => ({ kind: "not-registered", ...PAIR }),
    ).catch((e) => e);
    expect(ok).toBeInstanceOf(NearKeyJustVerifiedError);
    expect(ok).not.toBeInstanceOf(NearKeyNotVerifiedError);
    expect(bad).toBeInstanceOf(NearKeyNotVerifiedError);
    expect(bad).not.toBeInstanceOf(NearKeyJustVerifiedError);
  });

  it("the retry goes through with no verification prompt", async () => {
    // The bridge has published `registered` by the time the user presses again.
    const verify = vi.fn();
    await expect(
      ensureCanOperate({ kind: "registered", ...PAIR }, verify),
    ).resolves.toBeUndefined();
    expect(verify).not.toHaveBeenCalled();
  });

  it.each([
    ["not-registered", { kind: "not-registered", ...PAIR }],
    ["signer-mismatch", { kind: "signer-mismatch", sessionAccountId: ACCOUNT, signerAccountId: "x.near" }],
    ["unknown", { kind: "unknown", ...PAIR }],
    ["declined", { kind: "declined" }],
    ["sign-failed", { kind: "sign-failed", message: "no" }],
  ] as [string, NearKeyVerification][])(
    "READS the verification result and still refuses on `%s`",
    async (_kind, outcome) => {
      // 🔴 `verify` RESOLVING is not the gate opening. It resolves just as truthfully with a
      // rejection, a mismatch or a failed chain read, and treating "it did not throw" as a
      // yes is how this whole block would fail open in its one friction concession.
      const verify = vi.fn(async () => outcome);
      const err = await ensureCanOperate({ kind: "unchecked" }, verify).catch((e) => e);
      expect(err).toBeInstanceOf(NearKeyNotVerifiedError);
      // The reported state is what the verification concluded, not the `unchecked` it began
      // from — otherwise every refusal here would blame "we have not asked yet".
      expect(err.verificationKind).toBe(outcome.kind);
    },
  );

  it("does not loop when the verification comes back `unchecked` again", async () => {
    // The account went away mid-flight, or no wallet was connected. One attempt, then no.
    const verify = vi.fn(async (): Promise<NearKeyVerification> => ({ kind: "unchecked" }));
    await expect(ensureCanOperate({ kind: "unchecked" }, verify)).rejects.toBeInstanceOf(
      NearKeyNotVerifiedError,
    );
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("lets a verification failure propagate rather than swallowing it into a pass", async () => {
    const verify = vi.fn(async () => {
      throw new Error("wallet exploded");
    });
    await expect(ensureCanOperate({ kind: "unchecked" }, verify)).rejects.toThrow(
      "wallet exploded",
    );
  });
});

describe("NearKeyNotVerifiedError — copy that has to survive the wallet-error classifier", () => {
  it.each(["en", "es"] as const)(
    "is classified as a plain error in %s, never as a cancel or an unusable wallet",
    (lang) => {
      // 🔴 The portfolio editor pipes anything it does not recognise through
      // `normalizeWalletError`, which classifies BY KEYWORD. Echoing the banner's own
      // `declined` copy ("Verification cancelled" / "Verificación cancelada") would make the
      // editor re-report a blocked account as a signature the user cancelled — telling them
      // to retry the one thing that cannot work.
      const err = new NearKeyNotVerifiedError("not-registered", lang);
      expect(normalizeWalletError(err).kind).toBe("error");
    },
  );

  it("says something different in each language, and neither is a placeholder", () => {
    const en = new NearKeyNotVerifiedError("unchecked", "en").message;
    const es = new NearKeyNotVerifiedError("unchecked", "es").message;
    expect(en).not.toBe(es);
    expect(es).toMatch(/fondos/);
    expect(en).toMatch(/funds/);
  });

  it("defaults to English rather than to an empty message", () => {
    // The two vault doors reach this through a context that has a language; anything that
    // ever calls it without one must still get a sentence.
    expect(new NearKeyNotVerifiedError("unchecked").message).toMatch(/funds/);
  });
});
