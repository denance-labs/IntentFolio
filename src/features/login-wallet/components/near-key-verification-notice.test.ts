import { describe, it, expect } from "vitest";
import { deriveNotice } from "./near-key-verification-notice";
import type { NearKeyVerification } from "../lib/near-key-verification";

// D-280 B2 + B3. What this file defends is the SENTENCE and WHAT THE BUTTON DOES, not the
// styling. The finding behind D-280 was a tester who could not operate and got no
// explanation, so the failure mode worth a test is two different situations rendering the
// same words — which is exactly what a careless edit to a copy table produces, and exactly
// what typechecking cannot catch.
//
// B3 adds a second thing typechecking cannot catch: two states can share the label "Try
// again" and mean different things, because one resends a transaction and the other only
// re-reads the chain. `action.run` is what the tests pin.

const ACCOUNT = "pablofork.near";
const KEY = "ed25519:2EVgyHyRbaLZjSDPzR8bnLTiPWtTYQ9GLNvtDoHZ4qGB";
const PAIR = { accountId: ACCOUNT, publicKey: KEY };

const ALL_STATES: NearKeyVerification[] = [
  { kind: "not-required" },
  { kind: "unchecked" },
  { kind: "checking" },
  { kind: "declined" },
  { kind: "sign-failed", message: "Wallet does not support signMessage" },
  { kind: "signer-mismatch", sessionAccountId: ACCOUNT, signerAccountId: "intentfolio-admin.near" },
  { kind: "registered", ...PAIR },
  { kind: "not-registered", ...PAIR },
  { kind: "unknown", ...PAIR },
  { kind: "registering", ...PAIR },
  { kind: "register-declined", ...PAIR },
  { kind: "register-failed", ...PAIR, message: "Not enough balance for gas" },
  {
    kind: "register-failed",
    ...PAIR,
    message: '{"InvalidTxError":{"InvalidAccessKeyError":"RequiresFullAccess"}}',
    cause: "requires-full-access",
  },
  { kind: "register-unconfirmed", ...PAIR },
  { kind: "register-not-applied", ...PAIR },
];

const LANGS = ["en", "es"] as const;

describe("deriveNotice — a healthy account says nothing", () => {
  it.each(["not-required", "registered"] as const)("renders no banner for %s", (kind) => {
    const state = ALL_STATES.find((s) => s.kind === kind)!;
    // A permanent green strip for the healthy case trains testers to ignore the strip that
    // matters. The banner appearing at all IS the signal.
    expect(deriveNotice(state, "en")).toBeNull();
    expect(deriveNotice(state, "es")).toBeNull();
  });
});

describe("deriveNotice — every other state gets its own words", () => {
  const noticeStates = ALL_STATES.filter(
    (s) => s.kind !== "not-required" && s.kind !== "registered",
  );

  it.each(LANGS)("no two states share a title+body in %s", (lang) => {
    const rendered = noticeStates.map((s) => {
      const n = deriveNotice(s, lang)!;
      return `${n.title}\n${n.body}`;
    });
    expect(new Set(rendered).size).toBe(noticeStates.length);
  });

  it.each(LANGS)("returns a non-empty title and body for each, in %s", (lang) => {
    for (const s of noticeStates) {
      const n = deriveNotice(s, lang)!;
      expect(n.title.length, s.kind).toBeGreaterThan(0);
      expect(n.body.length, s.kind).toBeGreaterThan(0);
    }
  });

  it.each(LANGS)("leaves no unsubstituted placeholder in %s", (lang) => {
    for (const s of noticeStates) {
      const n = deriveNotice(s, lang)!;
      // `{account}` is resolved by the component from the live session; every other
      // placeholder must be gone by the time the copy leaves this function.
      expect(`${n.title}${n.body}`.replace(/\{account\}/g, ""), s.kind).not.toMatch(/\{\w+\}/);
    }
  });
});

describe("deriveNotice — the two pairs that must never collapse", () => {
  it.each(LANGS)("`unknown` and `not-registered` differ in TITLE and BODY in %s", (lang) => {
    const unknown = deriveNotice({ kind: "unknown", accountId: ACCOUNT, publicKey: KEY }, lang)!;
    const notReg = deriveNotice({ kind: "not-registered", accountId: ACCOUNT, publicKey: KEY }, lang)!;
    // A colour difference alone is not enough: the two have opposite fixes. "Your account
    // needs a transaction" sends a user to spend gas when the real problem is an RPC that
    // did not answer.
    expect(unknown.title).not.toBe(notReg.title);
    expect(unknown.body).not.toBe(notReg.body);
  });

  it.each(LANGS)("`unchecked` and `unknown` differ in %s", (lang) => {
    const unchecked = deriveNotice({ kind: "unchecked" }, lang)!;
    const unknown = deriveNotice({ kind: "unknown", accountId: ACCOUNT, publicKey: KEY }, lang)!;
    // "We have not asked yet" is fixed by one click; "we asked and got no answer" is not.
    expect(unchecked.title).not.toBe(unknown.title);
  });
});

describe("deriveNotice — the mismatch is the loudest one", () => {
  it.each(LANGS)("names BOTH accounts in %s", (lang) => {
    const n = deriveNotice(
      { kind: "signer-mismatch", sessionAccountId: ACCOUNT, signerAccountId: "intentfolio-admin.near" },
      lang,
    )!;
    // The measured mainnet failure (D-227/D-232) is one account's key authorised for
    // another account. "Something is wrong" leaves the user nothing to do; the two names
    // are the entire actionable content.
    expect(n.body).toContain(ACCOUNT);
    expect(n.body).toContain("intentfolio-admin.near");
    expect(n.tone).toBe("danger");
  });

  it("shares danger with exactly one other state — the one that means the same thing", () => {
    // `register-not-applied` earns the same tone because it is the same failure seen from
    // the other side: a transaction that succeeded while the account it was for stayed
    // blocked is what signing as a different account looks like after the fact. Nothing
    // else may be red, or red stops meaning anything.
    const danger = ALL_STATES.filter((s) => deriveNotice(s, "en")?.tone === "danger");
    expect(danger.map((s) => s.kind).sort()).toEqual(["register-not-applied", "signer-mismatch"]);
  });
});

describe("deriveNotice — what the user can do about it", () => {
  it.each(["unchecked", "declined", "sign-failed", "signer-mismatch", "unknown"] as const)(
    "offers a retry action for %s",
    (kind) => {
      const state = ALL_STATES.find((s) => s.kind === kind)!;
      expect(deriveNotice(state, "en")!.action).toBeTruthy();
    },
  );

  it("offers no action while a signature is pending", () => {
    // The wallet already has the prompt open; a second button that reopens it is how you
    // get two prompts stacked on top of each other.
    expect(deriveNotice({ kind: "checking" }, "en")!.action).toBeNull();
  });

  it("leaves no state without a way out except the two transient ones", () => {
    // A banner a tester cannot act on is the original D-280 finding restated. `checking` and
    // the healthy pair are the only ones allowed to have no button.
    const stuck = ALL_STATES.filter((s) => {
      const n = deriveNotice(s, "en");
      return n !== null && n.action === null;
    });
    expect(stuck.map((s) => s.kind)).toEqual(["checking"]);
  });
});

describe("🔴 deriveNotice — which states may SEND A TRANSACTION", () => {
  function runOf(state: NearKeyVerification) {
    return deriveNotice(state, "en")?.action?.run ?? null;
  }

  it.each(["not-registered", "register-declined", "register-failed"] as const)(
    "offers `register` from %s — the three states that carry the key we saw sign",
    (kind) => {
      expect(runOf(ALL_STATES.find((s) => s.kind === kind)!)).toBe("register");
    },
  );

  it("offers `register` from NOWHERE else", () => {
    // 🔴 The list this pins is the whole safety property of B3. Adding a state here means a
    // transaction can be sent from it, and three of the exclusions are measured failures:
    // `signer-mismatch` (registering the crossed pair IS the mainnet contamination),
    // `unknown` (the key may be the empty string that produced the state), and
    // `register-not-applied` (the resend lands in the same wrong account).
    const registering = ALL_STATES.filter((s) => runOf(s) === "register").map((s) => s.kind);
    expect(registering).toEqual(["not-registered", "register-declined", "register-failed"]);
  });

  it.each(["signer-mismatch", "unknown", "register-unconfirmed", "register-not-applied"] as const)(
    "offers only a re-check from %s, never a resend",
    (kind) => {
      expect(runOf(ALL_STATES.find((s) => s.kind === kind)!)).toBe("verify");
    },
  );

  it("offers only `cancel` while a transaction is out", () => {
    // A second button that reopened the wallet would be a second transaction for the same
    // key — the user pays gas twice to reach a state the first one is already reaching.
    expect(runOf({ kind: "registering", ...PAIR })).toBe("cancel");
  });

  it("is the only state whose action is `cancel`", () => {
    const cancels = ALL_STATES.filter((s) => runOf(s) === "cancel").map((s) => s.kind);
    expect(cancels).toEqual(["registering"]);
  });
});

describe("🔴 deriveNotice — D-280 B5: the resend that can never work", () => {
  const requiresFullAccess: NearKeyVerification = {
    kind: "register-failed",
    ...PAIR,
    message: '{"InvalidTxError":{"InvalidAccessKeyError":"RequiresFullAccess"}}',
    cause: "requires-full-access",
  };

  it.each(LANGS)("offers `near-com`, never `register`, in %s", (lang) => {
    // A `FunctionCall` key can never attach the 1-yocto deposit `add_public_key` needs — the
    // "Try again" this cause would otherwise offer fails identically every time.
    const n = deriveNotice(requiresFullAccess, lang)!;
    expect(n.action?.run).toBe("near-com");
  });

  it.each(LANGS)("reads differently from the ordinary register-failed sentence in %s", (lang) => {
    const ordinary = deriveNotice({ kind: "register-failed", ...PAIR, message: "x" }, lang)!;
    const noFullAccess = deriveNotice(requiresFullAccess, lang)!;
    expect(noFullAccess.title).not.toBe(ordinary.title);
    expect(noFullAccess.body).not.toBe(ordinary.body);
  });

  it.each(LANGS)("names the account in %s", (lang) => {
    const n = deriveNotice(requiresFullAccess, lang)!;
    expect(`${n.title} ${n.body}`).toContain(ACCOUNT);
  });

  it("leaves an ordinary register-failed (no cause) offering `register` — unaffected by B5", () => {
    const n = deriveNotice({ kind: "register-failed", ...PAIR, message: "no gas" }, "en")!;
    expect(n.action?.run).toBe("register");
  });
});

describe("deriveNotice — the pair B3 must not collapse", () => {
  it.each(LANGS)(
    "`register-unconfirmed` and `register-not-applied` differ in TITLE, BODY and tone in %s",
    (lang) => {
      // "We stopped waiting, it may still be landing" and "it landed and your account is
      // still blocked" have opposite next steps. Told the first as the second, a tester
      // stops trusting a registration that worked; told the second as the first, they wait
      // forever for a transaction that already did the wrong thing.
      const unconfirmed = deriveNotice({ kind: "register-unconfirmed", ...PAIR }, lang)!;
      const notApplied = deriveNotice({ kind: "register-not-applied", ...PAIR }, lang)!;
      expect(unconfirmed.title).not.toBe(notApplied.title);
      expect(unconfirmed.body).not.toBe(notApplied.body);
      expect(unconfirmed.tone).not.toBe(notApplied.tone);
    },
  );

  it.each(LANGS)("`register-unconfirmed` tells the user NOT to send another one in %s", (lang) => {
    const n = deriveNotice({ kind: "register-unconfirmed", ...PAIR }, lang)!;
    expect(n.body.toLowerCase()).toMatch(/do not send another|no envíes otra/);
  });

  it.each(LANGS)("every registration state names the account in %s", (lang) => {
    // The banner sits above a dashboard that may be showing a different account's data if
    // the wallet switched underneath. The name is what lets a tester notice.
    for (const kind of ["registering", "register-declined", "register-failed", "register-not-applied"] as const) {
      const n = deriveNotice(ALL_STATES.find((s) => s.kind === kind)!, lang)!;
      expect(`${n.title} ${n.body}`, `${kind}/${lang}`).toContain(ACCOUNT);
    }
  });
});
