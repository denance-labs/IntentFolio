// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { IntentSettlementError } from "@defuse-protocol/internal-utils";
import type { MultiPayload, VaultSigner } from "@/features/vault/lib/vault-signer";
import {
  runGasPurchase,
  GasPurchaseError,
  type GasPurchaseStage,
  type RunGasPurchaseParams,
} from "./gas-purchase-run";
import type { GasPurchaseQuote } from "./gas-purchase";
import type { SettlementWaiter } from "./withdraw-poll";
import type { WithdrawPublisher } from "./withdraw-submit";

// The one path in the app that sends money to a third party, so what these tests defend is
// not the happy path:
//
//   - every refusal happens BEFORE a signature exists, while the balance is still intact;
//   - the price ceiling is real — a quote over it is not signed, whatever it claims to buy;
//   - after the publish nothing may be reported as a plain failure unless the relay itself
//     said the intent never executed. "It didn't work" is a claim about someone's money.
//
// No network: `fetch` throws, so an un-injected call fails the test instead of reaching
// mainnet with a real transfer.

const SIGNER_ID = "alice.near";
const DEADLINE_SECS = 1_800_000_000;
const NONCE = new Uint8Array(32).fill(7);

const USDT_TON = "nep245:v2_1.omni.hot.tg:1117_3tsdfyziyc7EJbP2aULWSKU4toBaAcN4FdTgfm5W1mC4ouR";
const GRAM = "nep245:v2_1.omni.hot.tg:1117_";
const ONECLICK_DEPOSIT = "e9f4c3a2b1d0.omni.1click.near";
const INTENT_HASH = "0xGasIntentHash";
const TX_HASH = "GasTxHash123";

const FAKE_PAYLOAD = { standard: "nep413" } as unknown as MultiPayload;

/** The figures measured against the real 1Click API on 2026-08-10. */
function quote(over: Partial<GasPurchaseQuote> = {}): GasPurchaseQuote {
  return {
    depositAddress: ONECLICK_DEPOSIT,
    amountInRaw: "53907", // 0.053907 USDT
    amountOutRaw: "40000000", // 0.04 GRAM — TON's flat relayer fee
    tokenId: USDT_TON,
    nativeAssetId: GRAM,
    ...over,
  };
}

let signer: VaultSigner & { signEnvelope: ReturnType<typeof vi.fn> };
let publish: ReturnType<typeof vi.fn>;
let settle: ReturnType<typeof vi.fn>;
let stages: GasPurchaseStage[];

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("no test may touch the network");
    })
  );

  signer = { scheme: "nep413", signEnvelope: vi.fn(async () => FAKE_PAYLOAD) };
  publish = vi.fn(async () => ({ status: "OK", intent_hash: INTENT_HASH }));
  settle = vi.fn(async ({ intentHash }: { intentHash: string }) => ({
    txHash: TX_HASH,
    intentHash,
  }));
  stages = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function run(over: Partial<RunGasPurchaseParams> = {}) {
  return runGasPurchase({
    signerId: SIGNER_ID,
    quote: quote(),
    // 5 USDT — the withdrawal the purchase exists to unblock.
    withdrawalAmountRaw: "5000000",
    // ~3x the measured price, in the withdrawn token's base units.
    maxAmountInRaw: "161721",
    signer,
    publish: publish as unknown as WithdrawPublisher,
    waitForSettlement: settle as unknown as SettlementWaiter,
    envelope: { deadlineSecs: DEADLINE_SECS, nonce: NONCE },
    onStage: (s) => stages.push(s),
    ...over,
  });
}

describe("runGasPurchase — the happy path", () => {
  it("signs one transfer, publishes it, and reports what was traded", async () => {
    const result = await run();

    expect(result).toEqual({
      intentHash: INTENT_HASH,
      txHash: TX_HASH,
      amountInRaw: "53907",
      amountOutRaw: "40000000",
    });
    expect(stages).toEqual(["signing", "publishing", "awaiting-settlement", "bought"]);
  });

  it("publishes no quote hash, because 1Click's quote is not the relay's", async () => {
    await run();

    // The relay never prices this intent: it is a plain `transfer`, not a swap. Naming a hash
    // here would ask it to honour a quote it never made.
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0]).toEqual({
      quote_hashes: [],
      signed_data: FAKE_PAYLOAD,
    });
  });

  it("stops at the settlement and never claims the gas arrived", async () => {
    const result = await run();

    // "bought" is the last stage there is, and `amountOutRaw` is what 1Click PROMISED — not
    // anything this module observed arriving. Delivery is watched off the signer's balance,
    // by the screen; a second source of truth here could only ever disagree with it.
    expect(stages[stages.length - 1]).toBe("bought");
    expect(result.amountOutRaw).toBe(quote().amountOutRaw);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle.mock.calls[0][0].intentHash).toBe(INTENT_HASH);
  });
});

// 🔴 Every test here asserts the same thing twice: it threw, AND the wallet was never asked.
// A guard that fires after the signature is not a guard, it is a report.
describe("runGasPurchase — what it refuses before a signature exists", () => {
  it("refuses a quote over the price ceiling", async () => {
    // 4.99 USDT to buy four cents of gas: under the withdrawal, so the builder's own guard
    // lets it through, and absurd, so this one does not.
    const e = await run({ quote: quote({ amountInRaw: "4990000" }) }).catch((err) => err);

    expect(e).toBeInstanceOf(GasPurchaseError);
    expect((e as GasPurchaseError).fundsState).toBe("untouched");
    expect((e as Error).message).toMatch(/ceiling/);
    expect(signer.signEnvelope).not.toHaveBeenCalled();
  });

  it("accepts a quote sitting exactly on the ceiling", async () => {
    await expect(
      run({ quote: quote({ amountInRaw: "161721" }) })
    ).resolves.toMatchObject({ amountInRaw: "161721" });
  });

  it("refuses to buy without a ceiling to check against", async () => {
    for (const bad of ["", "0", "abc", "-1"]) {
      const e = await run({ maxAmountInRaw: bad }).catch((err) => err);
      expect(e).toBeInstanceOf(GasPurchaseError);
      expect((e as GasPurchaseError).fundsState).toBe("untouched");
    }
    expect(signer.signEnvelope).not.toHaveBeenCalled();
  });

  it("refuses a purchase that would consume the withdrawal it is meant to enable", async () => {
    // The builder's guard, surfaced through this module's error type rather than raw.
    const e = await run({
      quote: quote({ amountInRaw: "5000000" }),
      maxAmountInRaw: "9000000",
    }).catch((err) => err);

    expect(e).toBeInstanceOf(GasPurchaseError);
    expect((e as GasPurchaseError).fundsState).toBe("untouched");
    expect((e as Error).message).toMatch(/consume the whole amount/);
    expect(signer.signEnvelope).not.toHaveBeenCalled();
  });

  it("refuses a quote with no deposit address rather than transferring to nowhere", async () => {
    const e = await run({ quote: quote({ depositAddress: "" }) }).catch((err) => err);

    expect(e).toBeInstanceOf(GasPurchaseError);
    expect((e as GasPurchaseError).fundsState).toBe("untouched");
    expect(signer.signEnvelope).not.toHaveBeenCalled();
  });

  it("refuses an amount that is not an amount", async () => {
    for (const bad of ["0", "", "1.5", "-3"]) {
      const e = await run({ quote: quote({ amountInRaw: bad }) }).catch((err) => err);
      expect(e).toBeInstanceOf(GasPurchaseError);
      expect((e as GasPurchaseError).fundsState).toBe("untouched");
    }
    expect(signer.signEnvelope).not.toHaveBeenCalled();
  });

  it("transfers to the address the quote named, and nothing else", async () => {
    await run();
    // The signed intents are the contract with 1Click: one transfer, to their deposit
    // account, for the quoted amount. A second intent here would be something nobody priced.
    // Parsed, not substring-matched: `toContain("53907")` is satisfied by "539070" too, so a
    // bug that signed ten times the quoted amount would have passed this file.
    const signed = signer.signEnvelope.mock.calls[0][0];
    expect(signed.nep413.recipient).toBe("intents.near");
    const intents = JSON.parse(signed.nep413.message).intents;
    expect(intents).toHaveLength(1);
    expect(intents[0]).toEqual({
      intent: "transfer",
      receiver_id: ONECLICK_DEPOSIT,
      tokens: { [USDT_TON]: "53907" },
    });
  });
});

// After the publish the money may already be gone. Nothing below may be worded, or typed, as
// a plain failure unless the relay itself said the intent never executed.
describe("runGasPurchase — after the publish, honesty about the money", () => {
  it("reports a wallet rejection untouched, in the wallet's own words", async () => {
    signer.signEnvelope.mockRejectedValueOnce(new Error("User rejected the request"));
    const e = await run().catch((err) => err);

    // Deliberately NOT wrapped: a cancel is a wallet error, and the screen shows it verbatim.
    expect(e).not.toBeInstanceOf(GasPurchaseError);
    expect((e as Error).message).toBe("User rejected the request");
    expect(publish).not.toHaveBeenCalled();
  });

  it("calls a relay rejection untouched and says the balance is intact", async () => {
    publish.mockResolvedValueOnce({
      status: "FAILED",
      intent_hash: INTENT_HASH,
      reason: "insufficient balance or overflow",
    });
    const e = await run().catch((err) => err);

    expect((e as GasPurchaseError).fundsState).toBe("untouched");
    expect((e as Error).message).toMatch(/Nothing left your balance/);
    expect(stages).not.toContain("published-unconfirmed");
  });

  it("calls a failed publish UNKNOWN, never a failure", async () => {
    publish.mockRejectedValueOnce(new Error("connection reset"));
    const e = await run().catch((err) => err);

    // 🔴 The relay may have taken it before the connection died. Saying "it didn't go
    // through" here is how someone buys the same gas twice.
    expect((e as GasPurchaseError).fundsState).toBe("unknown");
    expect((e as Error).message).toMatch(/Check your balance before trying again/);
    expect(stages).toContain("published-unconfirmed");
  });

  it("calls an unreadable relay answer UNKNOWN rather than probing it for a hash", async () => {
    publish.mockResolvedValueOnce({ ok: true });
    const e = await run().catch((err) => err);

    expect((e as GasPurchaseError).fundsState).toBe("unknown");
    expect(stages).toContain("published-unconfirmed");
  });

  it("treats a re-published intent the relay already holds as published", async () => {
    publish.mockResolvedValueOnce({
      status: "FAILED",
      intent_hash: INTENT_HASH,
      reason: "already processed",
    });
    await expect(run()).resolves.toMatchObject({ intentHash: INTENT_HASH });
  });

  it("reports a Verifier-rejected intent untouched: it never executed", async () => {
    settle.mockRejectedValueOnce(
      new IntentSettlementError({ status: "NOT_FOUND_OR_NOT_VALID", intent_hash: INTENT_HASH })
    );
    const e = await run().catch((err) => err);

    expect((e as GasPurchaseError).fundsState).toBe("untouched");
    expect((e as Error).message).toMatch(/Nothing left your balance/);
  });

  it("reports an unobserved settlement as unconfirmed, not as a loss", async () => {
    settle.mockRejectedValueOnce(new Error("timed out"));
    const e = await run().catch((err) => err);

    expect((e as GasPurchaseError).fundsState).toBe("unknown");
    expect((e as Error).message).toMatch(/may still complete/);
    expect(stages).toContain("published-unconfirmed");
    expect(stages).not.toContain("bought");
  });
});
