import { describe, it, expect, vi } from "vitest";
import {
  ADD_PUBLIC_KEY_DEPOSIT,
  ADD_PUBLIC_KEY_GAS,
  buildAddPublicKeyAction,
  registerNearKey,
  registrationTarget,
  toVerificationState,
} from "./near-key-register";
import type { KeyRegistrationStatus } from "./near-key-registration";
import type { NearKeyVerification } from "./near-key-verification";

// D-280 B3. What this file defends is the ONE invariant the whole block rests on: nothing
// but a chain re-read may conclude `registered`. Every other assertion here exists because
// collapsing it turns a blocked tester into a tester who is told they are fine and then hits
// a Verifier rejection they were promised could not happen.
//
// The wallet is injected everywhere, so none of this needs a browser, an extension or mainnet.

const ACCOUNT = "pablofork.near";
const KEY = "ed25519:2EVgyHyRbaLZjSDPzR8bnLTiPWtTYQ9GLNvtDoHZ4qGB";

/** A chain read that answers a fixed script, one entry per call, last entry repeating. */
function chainSaying(...answers: KeyRegistrationStatus[]) {
  let i = 0;
  return vi.fn(async () => answers[Math.min(i++, answers.length - 1)]);
}

/** Collapses the confirm loop's waiting so the tests run in real time. */
const fastClock = {
  sleep: async () => {},
  confirmIntervalMs: 1,
  confirmWindowMs: 5,
};

const never = () => new Promise<unknown>(() => {});

describe("the wire shape of add_public_key", () => {
  // Measured against mainnet (s132/s133), not inferred. Each of these three is something a
  // plausible-looking edit gets wrong with no type error, and each one turns the call into a
  // revert the user pays gas for.
  it("is a FunctionCall to add_public_key with 5 Tgas and 1 yoctoNEAR", () => {
    expect(buildAddPublicKeyAction(KEY)).toEqual({
      type: "FunctionCall",
      params: {
        methodName: "add_public_key",
        args: { public_key: KEY },
        gas: "5000000000000",
        deposit: "1",
      },
    });
  });

  it("attaches a deposit of exactly 1 yocto — a zero deposit is rejected by the contract", () => {
    // 🔴 And a FunctionCall access key cannot attach any deposit at all, which is what forces
    // this transaction onto a FullAccess key. Dropping the yocto silently changes who can
    // sign it, not just whether it succeeds.
    expect(ADD_PUBLIC_KEY_DEPOSIT).toBe("1");
    expect(ADD_PUBLIC_KEY_GAS).toBe("5000000000000");
  });

  it("sends it to intents.near", async () => {
    const signAndSend = vi.fn(async () => ({}));
    await registerNearKey({
      accountId: ACCOUNT,
      publicKey: KEY,
      signAndSend,
      checkRegistration: chainSaying("registered"),
      ...fastClock,
    });
    expect(signAndSend).toHaveBeenCalledWith({
      receiverId: "intents.near",
      actions: [buildAddPublicKeyAction(KEY)],
    });
  });
});

describe("a key we cannot name never becomes a transaction", () => {
  // B1 answers `unknown` for an empty key precisely so it arrives here as a refusal. Without
  // this guard the empty string reaches `add_public_key` as a revert the user pays for.
  it.each([
    ["an empty public key", ACCOUNT, ""],
    ["an empty account", "", KEY],
  ])("refuses %s and sends nothing", async (_label, accountId, publicKey) => {
    const signAndSend = vi.fn(async () => ({}));
    const result = await registerNearKey({ accountId, publicKey, signAndSend, ...fastClock });
    expect(result.kind).toBe("failed");
    expect(signAndSend).not.toHaveBeenCalled();
  });
});

describe("🔴 only the chain re-read may conclude `registered`", () => {
  it("concludes registered when the chain reports the key after the send", async () => {
    const check = chainSaying("registered");
    const result = await registerNearKey({
      accountId: ACCOUNT,
      publicKey: KEY,
      signAndSend: async () => ({ status: { SuccessValue: "" } }),
      checkRegistration: check,
      ...fastClock,
    });
    expect(result).toEqual({ kind: "registered" });
    expect(check).toHaveBeenCalled();
  });

  it("does NOT conclude registered on a successful receipt the chain contradicts", async () => {
    // The mutation this kills: `if (!reverted) return { kind: "registered" }`. The receipt is
    // genuinely successful here — `add_public_key` ran — it just registered the key under a
    // DIFFERENT account, which is what a wallet signing as someone else produces. Measured in
    // mainnet on 2026-08-13 (admin's key authorised under budget).
    const result = await registerNearKey({
      accountId: ACCOUNT,
      publicKey: KEY,
      signAndSend: async () => ({ status: { SuccessValue: "" } }),
      checkRegistration: chainSaying("not-registered"),
      ...fastClock,
    });
    expect(result).toEqual({ kind: "not-applied" });
  });

  it("asks the chain about the EXACT pair it was given, never a re-derived one", async () => {
    const check = chainSaying("registered");
    await registerNearKey({
      accountId: ACCOUNT,
      publicKey: KEY,
      signAndSend: async () => ({}),
      checkRegistration: check,
      ...fastClock,
    });
    expect(check).toHaveBeenCalledWith({ accountId: ACCOUNT, publicKey: KEY });
  });

  it("reports `unconfirmed`, not `not-applied`, when the read never answered", async () => {
    // 🔴 A network outage must never become an accusation. `not-applied` tells a user their
    // wallet signed as somebody else; `unknown` is the RPC saying nothing at all.
    const result = await registerNearKey({
      accountId: ACCOUNT,
      publicKey: KEY,
      signAndSend: async () => ({}),
      checkRegistration: chainSaying("unknown"),
      ...fastClock,
    });
    expect(result).toEqual({ kind: "unconfirmed" });
  });

  it("keeps re-reading past a first negative — final finality trails the block", async () => {
    // 🔴 `viewCall` asks at `finality: "final"`, a couple of seconds behind the block that
    // executed the transaction. A single immediate read would call a perfectly good
    // registration `not-applied`, which is the loudest thing this gate can say.
    const check = chainSaying("not-registered", "not-registered", "registered");
    const result = await registerNearKey({
      accountId: ACCOUNT,
      publicKey: KEY,
      signAndSend: async () => ({}),
      checkRegistration: check,
      sleep: async () => {},
      confirmIntervalMs: 1,
      confirmWindowMs: 1000,
    });
    expect(result).toEqual({ kind: "registered" });
    expect(check).toHaveBeenCalledTimes(3);
  });

  it("still reads once when the confirmation window is zero", async () => {
    const check = chainSaying("registered");
    const result = await registerNearKey({
      accountId: ACCOUNT,
      publicKey: KEY,
      signAndSend: async () => ({}),
      checkRegistration: check,
      sleep: async () => {},
      confirmWindowMs: 0,
    });
    expect(result).toEqual({ kind: "registered" });
    expect(check).toHaveBeenCalledTimes(1);
  });
});

describe("what went wrong, told apart", () => {
  it("reads a user rejection as `declined`", async () => {
    const result = await registerNearKey({
      accountId: ACCOUNT,
      publicKey: KEY,
      signAndSend: async () => {
        throw new Error("User rejected the request");
      },
      checkRegistration: chainSaying("not-registered"),
      ...fastClock,
    });
    // A choice, not a fault: B4 leaves them in read-only and the offer stays on the table.
    expect(result).toEqual({ kind: "declined" });
  });

  it("reads anything else as `failed`, keeping the wallet's own words", async () => {
    const result = await registerNearKey({
      accountId: ACCOUNT,
      publicKey: KEY,
      signAndSend: async () => {
        throw new Error("Not enough balance for gas");
      },
      checkRegistration: chainSaying("not-registered"),
      ...fastClock,
    });
    expect(result).toEqual({ kind: "failed", message: "Not enough balance for gas" });
  });

  it("reads a reverted transaction as `failed` and stops before the poll", async () => {
    // Without this an explicit revert falls through to the confirmation window and comes out
    // as `not-applied` — which blames the user's wallet for a contract that said no.
    const check = chainSaying("not-registered");
    const result = await registerNearKey({
      accountId: ACCOUNT,
      publicKey: KEY,
      signAndSend: async () => ({
        status: { Failure: { ActionError: { kind: { FunctionCallError: "Smart contract panicked: deposit required" } } } },
      }),
      checkRegistration: check,
      ...fastClock,
    });
    expect(result.kind).toBe("failed");
    expect(check).not.toHaveBeenCalled();
  });
});

describe("🔴 D-280 B5 — telling a doomed resend apart from an ordinary one", () => {
  // A FunctionCall key can never attach the 1-yocto deposit `add_public_key` needs (protocol
  // level — see `near-key-register.ts`), so this exact transaction fails identically every
  // time. `cause` is what lets the banner stop offering "Try again" into that wall.
  it("marks a thrown RequiresFullAccess error with the full-access cause", async () => {
    const result = await registerNearKey({
      accountId: ACCOUNT,
      publicKey: KEY,
      signAndSend: async () => {
        throw new Error('{"InvalidTxError":{"InvalidAccessKeyError":"RequiresFullAccess"}}');
      },
      checkRegistration: chainSaying("not-registered"),
      ...fastClock,
    });
    expect(result).toEqual({
      kind: "failed",
      message: '{"InvalidTxError":{"InvalidAccessKeyError":"RequiresFullAccess"}}',
      cause: "requires-full-access",
    });
  });

  it("marks a reverted RequiresFullAccess outcome with the same cause", async () => {
    const check = chainSaying("not-registered");
    const result = await registerNearKey({
      accountId: ACCOUNT,
      publicKey: KEY,
      signAndSend: async () => ({
        status: { Failure: { InvalidTxError: { InvalidAccessKeyError: "RequiresFullAccess" } } },
      }),
      checkRegistration: check,
      ...fastClock,
    });
    expect(result.kind).toBe("failed");
    expect((result as { cause?: string }).cause).toBe("requires-full-access");
  });

  it("leaves an ordinary failure's cause undefined — it still offers a resend", async () => {
    const result = await registerNearKey({
      accountId: ACCOUNT,
      publicKey: KEY,
      signAndSend: async () => {
        throw new Error("Not enough balance for gas");
      },
      checkRegistration: chainSaying("not-registered"),
      ...fastClock,
    });
    expect(result).toEqual({ kind: "failed", message: "Not enough balance for gas" });
    expect((result as { cause?: string }).cause).toBeUndefined();
  });
});

describe("stopping the WAIT never claims to have stopped the transaction", () => {
  it("cancelling checks the chain once and reports `unconfirmed` if the key is not there", async () => {
    // 🔴 Not `failed` and not `declined`. The transaction may be landing at this very moment,
    // and telling the user it did not work is what makes them send a second one.
    const controller = new AbortController();
    controller.abort();
    const check = chainSaying("not-registered");
    const result = await registerNearKey({
      accountId: ACCOUNT,
      publicKey: KEY,
      signAndSend: never,
      signal: controller.signal,
      checkRegistration: check,
      ...fastClock,
    });
    expect(result).toEqual({ kind: "unconfirmed" });
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("cancelling still reports `registered` if the transaction already landed", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await registerNearKey({
      accountId: ACCOUNT,
      publicKey: KEY,
      signAndSend: never,
      signal: controller.signal,
      checkRegistration: chainSaying("registered"),
      ...fastClock,
    });
    expect(result).toEqual({ kind: "registered" });
  });

  it("gives up waiting on a wallet that never answers, without calling it a failure", async () => {
    const result = await registerNearKey({
      accountId: ACCOUNT,
      publicKey: KEY,
      signAndSend: never,
      sendTimeoutMs: 1,
      checkRegistration: chainSaying("unknown"),
      ...fastClock,
    });
    expect(result).toEqual({ kind: "unconfirmed" });
  });

  it("does not leave the abandoned send as an unhandled rejection", async () => {
    // The send outlives this call by design. If its eventual rejection is not swallowed it
    // surfaces as an unhandled rejection in the user's console, on a path where we already
    // told them we stopped waiting.
    const onUnhandled = vi.fn();
    process.on("unhandledRejection", onUnhandled);
    let reject: (e: unknown) => void = () => {};
    const result = await registerNearKey({
      accountId: ACCOUNT,
      publicKey: KEY,
      signAndSend: () => new Promise<unknown>((_, r) => { reject = r; }),
      sendTimeoutMs: 1,
      checkRegistration: chainSaying("unknown"),
      ...fastClock,
    });
    reject(new Error("wallet closed"));
    await new Promise((r) => setTimeout(r, 10));
    process.off("unhandledRejection", onUnhandled);
    expect(result.kind).toBe("unconfirmed");
    expect(onUnhandled).not.toHaveBeenCalled();
  });
});

describe("registrationTarget — which states may send a transaction at all", () => {
  const pair = { accountId: ACCOUNT, publicKey: KEY };

  it.each(["not-registered", "register-declined", "register-failed"] as const)(
    "allows %s, carrying the key B2 saw sign",
    (kind) => {
      const state = { kind, ...pair, message: "x" } as NearKeyVerification;
      expect(registrationTarget(state)).toEqual(pair);
    },
  );

  const refused: NearKeyVerification[] = [
    { kind: "unchecked" },
    { kind: "checking" },
    { kind: "not-required" },
    { kind: "declined" },
    { kind: "sign-failed", message: "locked" },
    { kind: "signer-mismatch", sessionAccountId: ACCOUNT, signerAccountId: "intentfolio-admin.near" },
    { kind: "registered", ...pair },
    { kind: "unknown", ...pair },
    { kind: "registering", ...pair },
    { kind: "register-unconfirmed", ...pair },
    { kind: "register-not-applied", ...pair },
  ];

  it.each(refused.map((s) => [s.kind, s] as const))("refuses %s", (_kind, state) => {
    expect(registrationTarget(state)).toBeNull();
  });

  it("refuses `signer-mismatch` — registering that pair IS the mainnet contamination", () => {
    // The measured failure: a wallet offered one account's key for another account's payload
    // and the cross-authorisation went through. Sending from here would do it deliberately.
    expect(
      registrationTarget({
        kind: "signer-mismatch",
        sessionAccountId: ACCOUNT,
        signerAccountId: "intentfolio-admin.near",
      }),
    ).toBeNull();
  });

  it("refuses `register-not-applied` — the resend lands in the same wrong account", () => {
    expect(registrationTarget({ kind: "register-not-applied", ...pair })).toBeNull();
  });

  it("refuses `unknown` — B1 answers it for an empty key too", () => {
    expect(registrationTarget({ kind: "unknown", accountId: ACCOUNT, publicKey: "" })).toBeNull();
  });

  it("refuses an allowed kind that carries a blank key", () => {
    expect(registrationTarget({ kind: "not-registered", accountId: ACCOUNT, publicKey: "" })).toBeNull();
  });
});

describe("toVerificationState — every result gets its own state", () => {
  it("maps `registered` and nothing else onto the registered state", () => {
    // 🔴 The invariant, restated at the boundary: `registered` is reachable here only from a
    // result that `registerNearKey` produced by re-reading the chain.
    const kinds = (
      [
        { kind: "registered" },
        { kind: "declined" },
        { kind: "failed", message: "x" },
        { kind: "unconfirmed" },
        { kind: "not-applied" },
      ] as const
    ).map((r) => toVerificationState(r, ACCOUNT, KEY).kind);
    expect(kinds).toEqual([
      "registered",
      "register-declined",
      "register-failed",
      "register-unconfirmed",
      "register-not-applied",
    ]);
  });

  it("carries the same pair through, so a retry resends the same key", () => {
    const state = toVerificationState({ kind: "declined" }, ACCOUNT, KEY);
    expect(state).toEqual({ kind: "register-declined", accountId: ACCOUNT, publicKey: KEY });
    expect(registrationTarget(state)).toEqual({ accountId: ACCOUNT, publicKey: KEY });
  });

  it("keeps the wallet's message on a failure, so the banner can say why", () => {
    expect(toVerificationState({ kind: "failed", message: "no gas" }, ACCOUNT, KEY)).toEqual({
      kind: "register-failed",
      accountId: ACCOUNT,
      publicKey: KEY,
      message: "no gas",
    });
  });

  it("carries the requires-full-access cause through to the state (D-280 B5)", () => {
    expect(
      toVerificationState(
        { kind: "failed", message: "x", cause: "requires-full-access" },
        ACCOUNT,
        KEY,
      ),
    ).toEqual({
      kind: "register-failed",
      accountId: ACCOUNT,
      publicKey: KEY,
      message: "x",
      cause: "requires-full-access",
    });
  });
});
