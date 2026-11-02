// The account extractor over real mainnet transactions (account-history.fixtures.ts), plus the
// lines anyone can make `intents.near` log about an account (U+0000, 009 header).

import { describe, expect, it } from "vitest";
import type { FastNearTx } from "@/features/vault/lib/vault-history-client";
import { extractAccountTx, type AccountTx } from "./account-extract";
import {
  DEPOSIT,
  EVM_ALLOCATE,
  EVM_HOT_DEPOSIT,
  EVM_HOT_WITHDRAWAL,
  FAILED_TRANSFER,
  RECEIVED_WITHDRAWAL,
  TRANSFER_HEX,
  UNALLOCATE,
  WITHDRAWAL,
} from "./account-history.fixtures";

const NEAR = "pablofork.near";
const EVM = "0xc8b1e10d011aceed84f4cdba66ca175bd6552a36";
const VAULT = "intentfolio-vault.near";

const copy = (tx: FastNearTx): FastNearTx => JSON.parse(JSON.stringify(tx)) as FastNearTx;
const finished = (x: AccountTx) => {
  if (!x.complete) throw new Error("expected a finished transaction");
  return x;
};
const intentsReceiptOf = (tx: FastNearTx, withLog: string) =>
  tx.receipts.find(
    (r) => r.execution_outcome.outcome.executor_id === "intents.near" && r.execution_outcome.outcome.logs.some((l) => l.includes(withLog))
  )!;

describe("extractAccountTx — real transactions", () => {
  it("a deposit: one line, one `deposit` with its memo; nothing of the vault", () => {
    const x = finished(extractAccountTx(DEPOSIT, NEAR, VAULT));
    expect(x.lines.map((l) => [l.standard, l.event])).toEqual([["nep245", "mt_mint"]]);
    expect(x.movements).toEqual([
      expect.objectContaining({ kind: "deposit", tokenId: "nep141:nbtc.bridge.near", memo: "deposit", counterparty: null, intentHash: null }),
    ]);
    expect(x.vault).toBeNull();
    expect(x.tx.txHash).toBe(DEPOSIT.transaction.hash);
  });

  it("a withdrawal: the `ft_withdraw` line is kept raw, the `mt_burn` is the movement", () => {
    const x = finished(extractAccountTx(WITHDRAWAL, NEAR, VAULT));
    expect(x.lines.map((l) => l.event).sort()).toEqual(["ft_withdraw", "intents_executed", "mt_burn"]);
    expect(x.movements).toEqual([expect.objectContaining({ kind: "withdrawal", memo: "withdraw" })]);
  });

  it("a signed transfer to a 64-hex account: `transfer_out` with receiver and intent hash; the `mt_transfer` leg is not a movement", () => {
    const x = finished(extractAccountTx(TRANSFER_HEX, NEAR, VAULT));
    expect(x.lines.map((l) => l.event)).toEqual(["transfer", "intents_executed", "mt_transfer"]);
    expect(x.movements).toEqual([
      {
        receiptId: "5MtGSzUsNvxwBVH8zMvV97DgTvKcBjig8MbKwGm3Hznv",
        logIndex: 0,
        entryIndex: 0,
        tokenIndex: 0,
        kind: "transfer_out",
        tokenId: "nep141:nbtc.bridge.near",
        amount: "14170",
        counterparty: "b3d8e1c1307a4cc180501e170a7bef826380917cd0c4453d937b2ba3085428aa",
        memo: null,
        intentHash: "9kHf3MDWot2MymZeyDreKU15naGiz5gLPK74PtN6yyMw",
        blockHeight: 219728675,
        blockTsMs: Math.floor(intentsReceiptOf(TRANSFER_HEX, '"transfer"').execution_outcome.block_timestamp / 1e6),
      },
    ]);
  });

  it("the vault paying a portfolio's withdrawal back: the incoming `mt_transfer` is kept raw, not a movement", () => {
    const x = finished(extractAccountTx(UNALLOCATE, NEAR, VAULT));
    expect(x.lines).toEqual([expect.objectContaining({ standard: "nep245", event: "mt_transfer" })]);
    expect(x.movements).toEqual([]);
    expect(x.vault?.events.map((e) => [e.event, e.accountId])).toEqual([
      ["pending_unallocation_opened", null],
      ["unallocate", NEAR],
    ]);
  });

  it("someone else's swap that pays out to the account: only the line that names it, no movement", () => {
    const x = finished(extractAccountTx(RECEIVED_WITHDRAWAL, NEAR, VAULT));
    expect(x.lines).toEqual([expect.objectContaining({ standard: "dip4", event: "ft_withdraw", logIndex: 4 })]);
    expect(x.movements).toEqual([]);
  });

  it("a failed `intents.near` receipt keeps nothing, though its log names the account", () => {
    const x = finished(extractAccountTx(FAILED_TRANSFER, NEAR, VAULT));
    expect(x.lines).toEqual([]);
    expect(x.movements).toEqual([]);
  });

  it("an EVM account's first allocation: the transfer to the vault, and the vault's own rows", () => {
    const x = finished(extractAccountTx(EVM_ALLOCATE, EVM, VAULT));
    expect(x.movements).toEqual([
      expect.objectContaining({ kind: "transfer_out", counterparty: VAULT, amount: "1000000", intentHash: "26Kvj97v1Mqxiz3d5SzBwdvdmd9KWB6Wf2ma7ut5qPm3" }),
    ]);
    expect(x.vault?.events.map((e) => e.event)).toEqual(["register_user", "link_wallet", "portfolio_created", "allocate"]);
    // Another vault's transaction has no vault rows here.
    expect(finished(extractAccountTx(EVM_ALLOCATE, EVM, "intentfolio-staging.near")).vault).toBeNull();
  });

  it("a HOT withdrawal that buys gas: one `mt_burn` entry with two tokens is two movements; the swap stays raw", () => {
    const x = finished(extractAccountTx(EVM_HOT_WITHDRAWAL, EVM, VAULT));
    expect(x.lines.map((l) => l.event)).toEqual(["token_diff", "mt_withdraw", "intents_executed", "mt_transfer", "mt_burn"]);
    expect(x.movements.map((m) => [m.kind, m.entryIndex, m.tokenIndex, m.tokenId, m.amount])).toEqual([
      ["withdrawal", 0, 0, "nep245:v2_1.omni.hot.tg:137_3hpYoaLtt8MP1Z2GH1U473DMRKgr", "494431"],
      ["withdrawal", 0, 1, "nep245:v2_1.omni.hot.tg:137_11111111111111111111", "72238484999800000"],
    ]);
    // HOT's own NEP-245 lines are not `intents.near`'s.
    expect(x.lines.every((l) => l.receiptId === "3g2rBUbsmfXDHWMiKWnRZ8qumm7tVhjhNYjMNgFzCNHA")).toBe(true);
  });

  it("a HOT deposit: HOT's own `mt_mint` is ignored, `intents.near`'s is the deposit", () => {
    const x = finished(extractAccountTx(EVM_HOT_DEPOSIT, EVM, VAULT));
    expect(x.movements).toEqual([expect.objectContaining({ kind: "deposit", amount: "1350000", memo: "deposit" })]);
    expect(x.lines).toHaveLength(1);
  });

  it("lines are stored byte for byte, prefix included", () => {
    const x = finished(extractAccountTx(TRANSFER_HEX, NEAR, VAULT));
    expect(x.lines[0].line).toBe(intentsReceiptOf(TRANSFER_HEX, '"transfer"').execution_outcome.outcome.logs[0]);
  });

  it("an unfinished transaction is reported as such", () => {
    const partial = copy(WITHDRAWAL);
    partial.receipts = partial.receipts.slice(0, 1);
    expect(extractAccountTx(partial, NEAR, VAULT)).toMatchObject({ complete: false });
  });
});

describe("extractAccountTx — what anyone can make intents.near log (009 header)", () => {
  const forgedMint = `EVENT_JSON:${JSON.stringify({
    standard: "nep245",
    version: "1.0.0",
    event: "mt_mint",
    data: [{ owner_id: NEAR, token_ids: ["nep141:x"], amounts: ["999"], memo: "deposit" }],
  })}`;

  it("an `intents.near` envelope logged by ANOTHER contract is not believed", () => {
    // Appended to the bridge's own receipt in a real deposit: the real deposit stays the only one.
    const tx = copy(DEPOSIT);
    const bridge = tx.receipts.find((r) => r.execution_outcome.outcome.executor_id === "nbtc.bridge.near")!;
    bridge.execution_outcome.outcome.logs.push(forgedMint);
    const x = finished(extractAccountTx(tx, NEAR, VAULT));
    expect(x.lines).toHaveLength(1);
    expect(x.movements).toEqual([expect.objectContaining({ kind: "deposit", amount: "14170" })]);

    // A transaction whose only mention of the account is forged names nothing of it.
    const alone = copy(DEPOSIT);
    for (const r of alone.receipts) {
      r.execution_outcome.outcome.logs = r.execution_outcome.outcome.executor_id === "intents.near" ? [] : [forgedMint];
    }
    const y = finished(extractAccountTx(alone, NEAR, VAULT));
    expect([y.lines, y.movements]).toEqual([[], []]);
  });

  it("an incoming `transfer` (the account is the receiver) is kept raw, never a `transfer_out`", () => {
    const line = `EVENT_JSON:${JSON.stringify({
      standard: "dip4",
      version: "0.4.3",
      event: "transfer",
      data: [{ intent_hash: "h", account_id: "someone.near", receiver_id: NEAR, tokens: { "nep141:x": "5" } }],
    })}`;
    const x = finished(extractAccountTx(withLog(TRANSFER_HEX, '"transfer"', line), NEAR, VAULT));
    expect(x.lines.map((l) => l.event)).toContain("transfer");
    expect(x.movements).toEqual([]);
  });

  it("a transfer of several tokens: one movement each, `token_index` in the order logged; no intent hash is null", () => {
    const line = `EVENT_JSON:{"standard":"dip4","version":"0.4.3","event":"transfer","data":[{"account_id":"${NEAR}","receiver_id":"b.near","tokens":{"nep141:z":"1","imt:a":"2","nep141:b":"3"}}]}`;
    const x = finished(extractAccountTx(withLog(TRANSFER_HEX, '"transfer"', line), NEAR, VAULT));
    expect(x.movements.map((m) => [m.tokenIndex, m.tokenId, m.amount, m.intentHash])).toEqual([
      [0, "nep141:z", "1", null],
      [1, "imt:a", "2", null],
      [2, "nep141:b", "3", null],
    ]);
  });

  it("an intent hash or a token key with U+0000 skips the transfer's movement", () => {
    for (const entry of [
      { intent_hash: "h\u0000", account_id: NEAR, receiver_id: "b.near", tokens: { "nep141:x": "1" } },
      { intent_hash: "h", account_id: NEAR, receiver_id: "b.near", tokens: { "imt:a\u0000": "1" } },
    ]) {
      // JSON.stringify writes U+0000 as its escape, as intents.near's serializer does.
      const line = `EVENT_JSON:${JSON.stringify({ standard: "dip4", version: "0.4.3", event: "transfer", data: [entry] })}`;
      const x = finished(extractAccountTx(withLog(TRANSFER_HEX, '"transfer"', line), NEAR, VAULT));
      expect(x.movements).toEqual([]);
      expect(x.skipped).toHaveLength(1);
    }
  });

  it("a line over the 16 KiB a receipt may log is left out and named, the transaction kept", () => {
    const line = mintLine({ owner_id: NEAR, token_ids: ["nep141:x"], amounts: ["1"], memo: "m".repeat(17_000) });
    const x = finished(extractAccountTx(withLog(DEPOSIT, "mt_mint", line), NEAR, VAULT));
    expect([x.lines, x.movements]).toEqual([[], []]);
    expect(x.skipped).toEqual([expect.stringMatching(/line not storable/)]);
  });

  it("a raw (unescaped) U+0000 is not JSON: not an event, nothing stored", () => {
    const line = mintLine({ owner_id: NEAR, token_ids: ["nep141:x"], amounts: ["1"] }).replace("nep141:x", "nep141:\u0000x");
    expect(line).toContain("\u0000");
    const x = finished(extractAccountTx(withLog(DEPOSIT, "mt_mint", line), NEAR, VAULT));
    expect([x.lines, x.movements, x.skipped]).toEqual([[], [], []]);
  });

  function mintLine(entry: Record<string, unknown>) {
    return `EVENT_JSON:${JSON.stringify({ standard: "nep245", version: "1.0.0", event: "mt_mint", data: [entry] })}`;
  }
  const withLog = (base: FastNearTx, marker: string, line: string) => {
    const tx = copy(base);
    const receipt = intentsReceiptOf(tx, marker);
    const at = receipt.execution_outcome.outcome.logs.findIndex((l) => l.includes(marker));
    receipt.execution_outcome.outcome.logs[at] = line;
    return tx;
  };
  const mint = (entry: Record<string, unknown>) =>
    `EVENT_JSON:${JSON.stringify({ standard: "nep245", version: "1.0.0", event: "mt_mint", data: [entry] })}`;

  it("an NFT whose id carries U+0000: that movement is skipped and named, the line and the rest stay", () => {
    const tx = withLog(
      DEPOSIT,
      "mt_mint",
      mint({ owner_id: NEAR, token_ids: ["imt:evil.near:a\u0000b", "nep141:nbtc.bridge.near"], amounts: ["1", "5"], memo: "deposit" })
    );
    const x = finished(extractAccountTx(tx, NEAR, VAULT));
    expect(x.lines).toHaveLength(1);
    expect(x.lines[0].line).toContain("\\u0000"); // the escape, six ASCII characters
    expect(x.lines[0].line).not.toContain("\u0000");
    expect(x.movements.map((m) => [m.tokenIndex, m.tokenId])).toEqual([[1, "nep141:nbtc.bridge.near"]]);
    expect(x.skipped).toEqual([expect.stringMatching(/token 0: token id not storable/)]);
  });

  it("a memo with U+0000 is kept with the character replaced", () => {
    const tx = withLog(DEPOSIT, "mt_mint", mint({ owner_id: NEAR, token_ids: ["imt:x"], amounts: ["1"], memo: "hi\u0000there" }));
    expect(finished(extractAccountTx(tx, NEAR, VAULT)).movements[0].memo).toBe("hi�there");
  });

  it("a transfer whose receiver carries U+0000 is skipped, not stored with a different receiver", () => {
    const line = `EVENT_JSON:${JSON.stringify({
      standard: "dip4",
      version: "0.4.3",
      event: "transfer",
      data: [{ intent_hash: "h", account_id: NEAR, receiver_id: "a\u0000b", tokens: { "nep141:x": "1" } }],
    })}`;
    const x = finished(extractAccountTx(withLog(TRANSFER_HEX, '"transfer"', line), NEAR, VAULT));
    expect(x.movements).toEqual([]);
    expect(x.skipped).toHaveLength(1);
    expect(x.lines.map((l) => l.event)).toContain("transfer");
  });

  it("only the account's own entries are movements, whoever else the line names", () => {
    const tx = withLog(
      DEPOSIT,
      "mt_mint",
      mint({ owner_id: "someone.near", token_ids: ["nep141:x"], amounts: ["9"] }).replace(
        '"data":[',
        `"data":[{"owner_id":"${NEAR}","token_ids":["nep141:y"],"amounts":["3"]},`
      )
    );
    const x = finished(extractAccountTx(tx, NEAR, VAULT));
    expect(x.movements.map((m) => [m.entryIndex, m.tokenId])).toEqual([[0, "nep141:y"]]);
  });

  it("a shape of intents.near's own this code does not know holds the transaction back", () => {
    const tx = withLog(DEPOSIT, "mt_mint", mint({ owner_id: NEAR, token_ids: ["nep141:x"], amounts: [] }));
    expect(() => extractAccountTx(tx, NEAR, VAULT)).toThrow(/without matching tokens and amounts/);
  });
});
