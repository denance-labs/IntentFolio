// What an edit row says (D-489) comes from the signed call, read here: both calls that carry a
// change set, the signature schemes that wrap it, and the refusals — an edit read in half would
// show a composition that never was.

import { describe, expect, it } from "vitest";
import { applyCompositionEdit, compositionEditOf, readSignedMessage, setupCompositionOf } from "./signed-change-set";
import { EDIT, EDIT_ALLOCATE_INTO } from "./account-history.fixtures";
import type { FastNearTx } from "@/features/vault/lib/vault-history-client";

const P1 = "p_000000000001";

/** The decoded arguments of the vault's kept call in a fixture, as `vault_call.args` returns them. */
function argsOf(tx: FastNearTx, method: string): unknown {
  for (const r of tx.receipts) {
    for (const a of r.receipt?.receipt?.Action?.actions ?? []) {
      const fc = a.FunctionCall as { method_name?: string; args?: string } | undefined;
      if (fc?.method_name === method) return JSON.parse(Buffer.from(fc.args ?? "", "base64").toString("utf8"));
    }
  }
  throw new Error(`no ${method} in ${tx.transaction.hash}`);
}

const changeSet = { portfolio_id: P1, target_changes: [["nep141:a", 6000, 500]], token_additions: [], token_removals: ["nep141:b"] };

describe("compositionEditOf — real calls", () => {
  it("`commit_portfolio_changes` (NEP-413): the new targets and the token added", () => {
    expect(compositionEditOf("commit_portfolio_changes", argsOf(EDIT, "commit_portfolio_changes"), P1)).toEqual({
      targets: [
        { token: "nep141:meta-pool.near", bps: 3950, toleranceBps: 2000 },
        { token: "nep141:usdt.tether-token.near", bps: 2350, toleranceBps: 2000 },
      ],
      added: [{ token: "nep141:wrap.near", bps: 3700, toleranceBps: 1000 }],
      removed: [],
    });
  });

  it("`on_auth` with `allocate_into`: the tokens added in the same signature", () => {
    const edit = compositionEditOf("on_auth", argsOf(EDIT_ALLOCATE_INTO, "on_auth"), P1);
    expect(edit?.targets).toEqual([]);
    expect(edit?.removed).toEqual([]);
    expect(edit?.added.map((a) => a.token)).toContain("nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near");
  });

  it("another portfolio's change set says nothing about this one", () => {
    expect(compositionEditOf("commit_portfolio_changes", argsOf(EDIT, "commit_portfolio_changes"), "p_000000000002")).toBeNull();
  });
});

describe("compositionEditOf — what it refuses", () => {
  const commit = (message: unknown) => ({ payload: { standard: "erc191", payload: JSON.stringify(message) } });

  it("reads a scheme that signs the JSON text itself", () => {
    expect(compositionEditOf("commit_portfolio_changes", commit(changeSet), P1)).toEqual({
      targets: [{ token: "nep141:a", bps: 6000, toleranceBps: 500 }],
      added: [],
      removed: ["nep141:b"],
    });
  });

  it("nothing to show: a pure withdrawal, a rename, a delete", () => {
    expect(
      compositionEditOf(
        "commit_portfolio_changes",
        commit({ portfolio_id: P1, target_changes: [], token_additions: [], token_removals: [], unallocations: [["nep141:a", "1"]] }),
        P1
      )
    ).toBeNull();
    expect(compositionEditOf("on_auth", { msg: JSON.stringify({ op: { setup: { composition: [] } } }) }, P1)).toBeNull();
  });

  it("a tuple it cannot read whole: the whole edit is null, never half of it", () => {
    for (const bad of [
      { ...changeSet, target_changes: [["nep141:a", "6000", 500]] },
      { ...changeSet, target_changes: [["nep141:a", 10_001, 500]] },
      { ...changeSet, target_changes: [["nep141:a", 6000]] },
      { ...changeSet, token_additions: [[7, 100, 500]] },
      { ...changeSet, token_removals: [1] },
      { ...changeSet, target_changes: {} },
    ]) {
      expect(compositionEditOf("commit_portfolio_changes", commit(bad), P1)).toBeNull();
    }
  });

  it("arguments it cannot parse, or a method that carries no change set", () => {
    expect(compositionEditOf("commit_portfolio_changes", { payload: { standard: "erc191", payload: "{not json" } }, P1)).toBeNull();
    expect(compositionEditOf("on_auth", { msg: "{not json" }, P1)).toBeNull();
    expect(compositionEditOf("on_auth", null, P1)).toBeNull();
    expect(compositionEditOf("reconcile_balances", commit(changeSet), P1)).toBeNull();
  });
});

describe("readSignedMessage — the schemes seen in 028-4 (d)", () => {
  it("NEP-413 signs a message inside the payload; erc191 and its kind the text; sep53 / ton_connect nest it", () => {
    const text = JSON.stringify(changeSet);
    expect(readSignedMessage({ standard: "nep413", payload: { message: text } }).message).toEqual(changeSet);
    expect(readSignedMessage({ standard: "tip191", payload: text }).message).toEqual(changeSet);
    expect(readSignedMessage({ standard: "ton_connect", payload: { text } }).message).toEqual(changeSet);
    expect(readSignedMessage({ standard: "sep53", payload: { payload: text } }).message).toEqual(changeSet);
    expect(readSignedMessage({ standard: "x", payload: 7 })).toMatchObject({ message: null, error: "unknown payload shape" });
  });
});

// D-530: the "before" of an edit is the Setup's composition with every earlier edit applied.
describe("setupCompositionOf / applyCompositionEdit", () => {
  const setup = (composition: unknown) => ({ signer_id: "a.near", msg: JSON.stringify({ op: { setup: { composition } } }) });

  it("reads a Setup's whole composition, and nothing else", () => {
    const composition = [
      { token_id: "nep141:a", target_bps: 6000, tolerance_bps: 1200 },
      { token_id: "nep141:b", target_bps: 4000, tolerance_bps: 1200 },
    ];
    expect(setupCompositionOf("on_auth", setup(composition))).toEqual([
      { token: "nep141:a", bps: 6000, toleranceBps: 1200 },
      { token: "nep141:b", bps: 4000, toleranceBps: 1200 },
    ]);
    // Half-readable, another op, another method: nothing.
    expect(setupCompositionOf("on_auth", setup([...composition, { token_id: "nep141:c", target_bps: "x" }]))).toBeNull();
    expect(setupCompositionOf("on_auth", { msg: JSON.stringify({ op: { allocate_into: {} } }) })).toBeNull();
    expect(setupCompositionOf("commit_portfolio_changes", setup(composition))).toBeNull();
    expect(setupCompositionOf("on_auth", { msg: "not json" })).toBeNull();
  });

  it("applies an edit: absolute targets, additions appended, removals dropped", () => {
    const before = [
      { token: "nep141:a", bps: 6000, toleranceBps: 1200 },
      { token: "nep141:b", bps: 4000, toleranceBps: 1200 },
    ];
    const edit = { targets: [{ token: "nep141:a", bps: 7000, toleranceBps: 3000 }], added: [{ token: "nep141:c", bps: 3000, toleranceBps: 1000 }], removed: ["nep141:b"] };
    expect(applyCompositionEdit(before, edit)).toEqual([
      { token: "nep141:a", bps: 7000, toleranceBps: 3000 },
      { token: "nep141:c", bps: 3000, toleranceBps: 1000 },
    ]);
  });
});
