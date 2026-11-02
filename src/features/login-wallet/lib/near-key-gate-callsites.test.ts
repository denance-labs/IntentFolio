import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// D-280 B4 — a STRUCTURAL guard over the four money doors, and it is worth being blunt about
// what it is: it reads source text. It proves the call is still written there; it does not
// prove it is on the right side of the branch, nor that it runs before the envelope is built.
// That part is carried by the doc comments at each call site, by cross-review, and — still
// pending — by the field run.
//
// It exists because the realistic regression is DELETION, not subtle misplacement: four one-
// line guards spread across two files, in code that gets refactored for unrelated reasons,
// with no component harness anywhere near them. Nothing else in the suite turns red if one
// disappears, and what disappears with it is the only thing standing between an unregistered
// key and a signature the Verifier will reject.
//
// 🔴 The last case is the inverse and the one the whole block was warned about: the gate must
// NEVER be expressed as `isRealWithdrawalRoute` answering false. That predicate falling to
// false does not block — it falls through to `mockContract.withdraw`, which reports a
// SUCCESSFUL withdrawal that never happened. Measured once already in T0.1, where an
// availability allowlist was put there and had to be taken out again.

const ROOT = resolve(__dirname, "../../..");

function source(relative: string): string {
  return readFileSync(resolve(ROOT, relative), "utf8");
}

/** The paths that make a NEAR named account sign an envelope (against `intents.near` or the vault). */
const MONEY_DOORS: { door: string; file: string; handler: string }[] = [
  {
    door: "real withdrawal",
    file: "features/dashboard-shell/components/dashboard-shell.tsx",
    handler: "handleWithdrawConfirmed",
  },
  {
    door: "destination gas purchase (D-251)",
    file: "features/dashboard-shell/components/dashboard-shell.tsx",
    handler: "handleBuyGas",
  },
  {
    door: "create portfolio / allocate",
    file: "features/dashboard-shell/context/portfolio-context.tsx",
    handler: "createPortfolioWithChangeSet",
  },
  {
    door: "edit composition / unallocate",
    file: "features/dashboard-shell/context/portfolio-context.tsx",
    handler: "commitChangeSet",
  },
  {
    // D-321: new funds into a real portfolio, signed from the Add tokens modal.
    door: "add funds to a portfolio (allocate into)",
    file: "features/dashboard-shell/context/portfolio-context.tsx",
    handler: "allocateIntoPortfolio",
  },
  {
    // 017-9c: rename and signed delete — a legless `commit_portfolio_changes`, one shared door.
    door: "rename / delete a portfolio",
    file: "features/dashboard-shell/context/portfolio-context.tsx",
    handler: "runPortfolioMeta",
  },
];

describe("D-280 B4 — every money door still runs the gate", () => {
  it("covers six doors, because gating only the withdrawal would stop the tester later than they break", () => {
    // A new NEAR account hits `createPortfolioWithChangeSet` long before any withdrawal
    // exists, so a gate on the withdrawal alone would let the FIRST real action fail at the
    // Verifier with no explanation — the exact experience D-280 was opened to remove.
    expect(MONEY_DOORS).toHaveLength(6);
  });

  it.each(MONEY_DOORS.map((d) => [d.door, d] as const))(
    "%s calls ensureCanOperate, and AWAITS it",
    (_name, { file, handler }) => {
      const text = source(file);
      expect(text).toContain(handler);
      // 🔴 `await`, not just the call. `ensureCanOperate` is async, so dropping the `await`
      // — an entirely plausible refactor — leaves a floating promise and lets the money path
      // run straight past a gate that is still written on the line above. It type-checks, it
      // lints, and the guard below would have gone on passing.
      expect(text).toContain("await ensureCanOperate(keyVerification, verifyKey, lang)");
    },
  );

  // 🔴 COUNTED, not searched. `expect(text).toContain("await ensureCanOperate(…)")` is
  // satisfied by ANY one call site in the file, so in a file with two doors it keeps passing
  // while one of them loses its `await` — measured: that exact mutation survived the whole
  // suite. Counting both spellings and requiring them equal is what makes a single dropped
  // `await` fail, and it is why these two live apart from the `it.each` above.
  it.each([
    // Create, add funds, unallocate and rename/delete are separate legs with separate
    // envelopes; one guard covering "the vault" does not exist.
    ["the vault context", "features/dashboard-shell/context/portfolio-context.tsx", 4],
    // The direct withdrawal, the Converting Withdrawal (D-392: its own branch of
    // `handleWithdrawConfirmed`, its own envelope) and the gas purchase.
    ["the dashboard shell", "features/dashboard-shell/components/dashboard-shell.tsx", 3],
  ] as const)("wires and awaits the gate at every call site in %s", (_where, file, expected) => {
    const text = source(file);
    const calls = text.match(/ensureCanOperate\(/g) ?? [];
    const awaited = text.match(/await ensureCanOperate\(/g) ?? [];
    expect(calls).toHaveLength(expected);
    expect(awaited).toHaveLength(expected);
  });

  it("keeps the gate OUT of the withdrawal route predicate", () => {
    // 🔴 The trap. `isRealWithdrawalRoute` returning false is not a block: `dashboard-shell`
    // reads it to choose between the live path and `mockContract.withdraw`, so a gate
    // expressed here would show a blocked account a withdrawal that succeeded on screen and
    // never happened on chain — strictly worse than no gate at all.
    const text = source("features/bridge/lib/withdraw-flag.ts");
    expect(text).not.toContain("ensureCanOperate");
    expect(text).not.toContain("canOperate");
    expect(text).not.toContain("keyVerification");
  });

  it("keeps the gate out of the LOCAL route wrapper too, which is the reachable half of the trap", () => {
    // 🔴 Guarding `withdraw-flag.ts` alone guards the wrong door. What the money branch at
    // `if (liveSigner && isRealWithdrawal(tokenId))` actually calls is the `useCallback`
    // wrapper in this file — putting the gate THERE has the identical effect (false ⇒ fall
    // through to `mockContract.withdraw` ⇒ a withdrawal that succeeds on screen and never
    // happened) while leaving all four `ensureCanOperate` calls untouched, so every other
    // assertion here keeps passing. Found by cross-review, which wrote exactly that mutation
    // and watched the suite stay green.
    const text = source("features/dashboard-shell/components/dashboard-shell.tsx");
    const start = text.indexOf("const isRealWithdrawal = useCallback(");
    expect(start).toBeGreaterThan(-1);
    const wrapper = text.slice(start, text.indexOf("[liveSigner]", start));
    expect(wrapper).not.toContain("ensureCanOperate");
    expect(wrapper).not.toContain("canOperate");
    expect(wrapper).not.toContain("keyVerification");
  });
});
