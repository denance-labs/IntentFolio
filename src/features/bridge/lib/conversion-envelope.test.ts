import { describe, expect, it } from "vitest";
import { configureSDK, messageFactory } from "@defuse-protocol/internal-utils";
import {
  CONVERSION_MIN_QUOTE_REMAINING_SECS,
  CONVERSION_TRANSFER_DEADLINE_MARGIN_SECS,
  ConversionNotSignableError,
  buildConversionSignRequest,
  conversionQuoteExpiresAtMs,
  type BuildConversionParams,
} from "./conversion-envelope";
import type { ConversionQuote } from "./oneclick-conversion-quote";

const NONCE = new Uint8Array(32).fill(7);
const SIGNER = "pablofork.near";

/**
 * The quote `quoteConversion` returns for journey 1 (ETH from Ethereum → a NEAR wallet), from the
 * response recorded 2026-10-06 (oneclick-conversion-quote.test.ts, `ETH_TO_NEAR`).
 */
const ETH_QUOTE: ConversionQuote = {
  originTokenId: "nep141:eth.omft.near",
  deliveryTokenId: "nep141:eth.bridge.near",
  chainId: "near:mainnet",
  destinationAsset: "nep141:eth.bridge.near",
  recipient: SIGNER,
  refundTo: SIGNER,
  depositAddress: "5863efabda6c40d89b37aa899add569e32cb7a670e6b56a7f2cbb8d62c5333a0",
  amountInRaw: "5000000000000000",
  amountOutRaw: "4998990052004899",
  minAmountOutRaw: "4973995101744874",
  withdrawFeeRaw: "0",
  createsTokenAccount: false,
  refundFeeRaw: "0",
  slippageBps: 50,
  requestedDeadlineMs: Date.parse("2026-10-06T10:27:22.000Z"),
  quoteDeadlineMs: Date.parse("2026-10-09T10:27:22.000Z"),
  timeEstimateSecs: 10,
  signature: "ed25519:3pqqpV5Xz3UboL1wq7TjCeJ9AD6xQUzSSZ2FAawWc7MPLqn4vsW4U3vfZHUeBrVGFM2kbdkvpq69F7gZUHUeybHr",
  quotedAtMs: Date.parse("2026-10-06T10:17:22.000Z"),
};

/** Journey 3: USDT on Polygon — a NEP-245 origin, so the transfer's token key is a `nep245:` id. */
const USDT_POL_QUOTE: ConversionQuote = {
  ...ETH_QUOTE,
  originTokenId: "nep245:v2_1.omni.hot.tg:137_3hpYoaLtt8MP1Z2GH1U473DMRKgr",
  deliveryTokenId: "nep141:usdt.tether-token.near",
  destinationAsset: "nep141:usdt.tether-token.near",
  depositAddress: "78876fc3d0a2e2a7f52a933c229f1a5f3e6c9699dee2be6dc8fc1dd84667d08b",
  amountInRaw: "20000000",
  amountOutRaw: "19996221",
  minAmountOutRaw: "19896239",
};

/** A click 30 s after the quote — what the screen's refresh makes typical. */
const CLICK_MS = ETH_QUOTE.quotedAtMs + 30_000;

function build(over: Partial<BuildConversionParams> = {}, quote: Partial<ConversionQuote> = {}) {
  return buildConversionSignRequest({
    signerId: SIGNER,
    quote: { ...ETH_QUOTE, ...quote },
    heldRaw: BigInt(ETH_QUOTE.amountInRaw),
    nowMs: CLICK_MS,
    nonce: NONCE,
    ...over,
  });
}

function refusal(fn: () => unknown): ConversionNotSignableError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ConversionNotSignableError);
    // Before any signature: the General Balance is intact, whatever the reason.
    expect((e as ConversionNotSignableError).fundsState).toBe("untouched");
    return e as ConversionNotSignableError;
  }
  throw new Error("expected a refusal");
}

describe("buildConversionSignRequest — C3: exactly one transfer, to the deposit address", () => {
  it("signs a single transfer of the whole quoted amount, nothing else", () => {
    const req = build();
    expect(req.intents).toEqual([
      {
        intent: "transfer",
        receiver_id: ETH_QUOTE.depositAddress,
        tokens: { "nep141:eth.omft.near": "5000000000000000" },
      },
    ]);
    expect(req.amount).toBe("5000000000000000");
  });

  it("is byte for byte what makeSwapMessage builds for that transfer against intents.near", () => {
    const req = build();
    const expected = messageFactory.makeSwapMessage({
      innerMessage: {
        signer_id: SIGNER,
        deadline: new Date(req.deadlineSecs * 1000).toISOString(),
        intents: req.intents,
      },
      nonce: NONCE,
    });
    expect(req.nep413.message).toBe(expected.NEP413.message);
    expect(req.nep413.recipient).toBe("intents.near");
    expect(req.nep413.nonce).toEqual(NONCE);
    expect(req.erc191Message).toBe(expected.ERC191.message);
  });

  it("carries the same signer, deadline and intents in NEP-413 and ERC-191", () => {
    const req = build();
    const nep413 = JSON.parse(req.nep413.message);
    const erc191 = JSON.parse(req.erc191Message);
    expect(nep413.signer_id).toBe(SIGNER);
    expect(erc191.signer_id).toBe(SIGNER);
    expect(erc191.deadline).toBe(nep413.deadline);
    expect(erc191.intents).toEqual(nep413.intents);
    expect(erc191.verifying_contract).toBe("intents.near");
  });

  it("keys the transfer by the held token's own id, NEP-245 included", () => {
    const req = build({ heldRaw: BigInt(20_000_000) }, USDT_POL_QUOTE);
    expect(req.intents).toEqual([
      {
        intent: "transfer",
        receiver_id: USDT_POL_QUOTE.depositAddress,
        tokens: { "nep245:v2_1.omni.hot.tg:137_3hpYoaLtt8MP1Z2GH1U473DMRKgr": "20000000" },
      },
    ]);
  });
});

describe("buildConversionSignRequest — C1: the exact balance", () => {
  it("signs when the balance is exactly the quoted amount", () => {
    expect(build({ heldRaw: BigInt(ETH_QUOTE.amountInRaw) }).amount).toBe(ETH_QUOTE.amountInRaw);
  });

  it("transfers the quoted amount, never the balance, when the balance is larger", () => {
    const req = build({ heldRaw: BigInt(ETH_QUOTE.amountInRaw) * BigInt(3) });
    expect(req.amount).toBe(ETH_QUOTE.amountInRaw);
    expect(JSON.parse(req.nep413.message).intents[0].tokens["nep141:eth.omft.near"]).toBe(ETH_QUOTE.amountInRaw);
  });

  it("refuses one base unit short instead of shrinking the transfer", () => {
    const e = refusal(() => build({ heldRaw: BigInt(ETH_QUOTE.amountInRaw) - BigInt(1) }));
    expect(e.reason).toBe("balance-short");
  });
});

describe("buildConversionSignRequest — C2: the quote's life", () => {
  const expiresAt = conversionQuoteExpiresAtMs(ETH_QUOTE);

  it("reads the earlier of the two deadlines — today the one we asked for", () => {
    expect(expiresAt).toBe(ETH_QUOTE.requestedDeadlineMs);
    const earlierResponse = { ...ETH_QUOTE, quoteDeadlineMs: ETH_QUOTE.requestedDeadlineMs - 60_000 };
    expect(conversionQuoteExpiresAtMs(earlierResponse)).toBe(earlierResponse.quoteDeadlineMs);
  });

  it("makes the signed transfer expire a margin before the quote does", () => {
    expect(build().deadlineSecs).toBe(expiresAt / 1000 - CONVERSION_TRANSFER_DEADLINE_MARGIN_SECS);
    expect(JSON.parse(build().nep413.message).deadline).toBe(
      new Date(expiresAt - CONVERSION_TRANSFER_DEADLINE_MARGIN_SECS * 1000).toISOString()
    );
  });

  it("follows the response's deadline when 1Click answers with an earlier one", () => {
    const quoteDeadlineMs = ETH_QUOTE.requestedDeadlineMs - 120_000;
    expect(build({}, { quoteDeadlineMs }).deadlineSecs).toBe(
      quoteDeadlineMs / 1000 - CONVERSION_TRANSFER_DEADLINE_MARGIN_SECS
    );
  });

  it("signs with exactly the minimum time left", () => {
    const nowMs = expiresAt - CONVERSION_MIN_QUOTE_REMAINING_SECS * 1000;
    expect(build({ nowMs }).deadlineSecs * 1000).toBeGreaterThan(nowMs);
  });

  it("refuses with a millisecond less, and on an expired quote", () => {
    for (const nowMs of [expiresAt - CONVERSION_MIN_QUOTE_REMAINING_SECS * 1000 + 1, expiresAt + 1]) {
      expect(refusal(() => build({ nowMs })).reason).toBe("quote-expiring");
    }
  });

  it("refuses a quote whose deadline is not a number", () => {
    expect(refusal(() => build({}, { quoteDeadlineMs: Number.NaN })).reason).toBe("quote-expiring");
  });
});

describe("buildConversionSignRequest — the verifying contract", () => {
  // `makeSwapMessage` signs against whatever environment the SDK holds. An SDK switched to its
  // staging Verifier would produce a valid-looking signature for a contract our balance is not in.
  it("refuses to sign when the SDK is configured for another Verifier", () => {
    configureSDK({ env: "stage" });
    try {
      expect(() => build()).toThrow(/staging-intents\.near/);
    } finally {
      configureSDK({ env: "production" });
    }
    expect(build().nep413.recipient).toBe("intents.near");
  });
});

describe("buildConversionSignRequest — who signs", () => {
  it("refuses a signer other than the account the quote refunds to", () => {
    const e = refusal(() => build({ signerId: "someone-else.near" }));
    expect(e.reason).toBe("signer-mismatch");
  });
});

describe("buildConversionSignRequest — quotes this build would never have asked for", () => {
  it.each([
    ["a Direct Withdrawal pair", { originTokenId: "nep141:eth.bridge.near" }],
    ["a pair outside the table", { chainId: "btc:mainnet" }],
    ["another Delivery Token than the table's", { deliveryTokenId: "nep141:arb.omft.near" }],
    ["another 1Click asset than the table's", { destinationAsset: "1cs_v1:eth:native:coin" }],
    ["a zero amount", { amountInRaw: "0" }],
    ["a non-integer amount", { amountInRaw: "5e15" }],
    ["a named deposit account", { depositAddress: "1click.near" }],
    ["upper-case hex", { depositAddress: ETH_QUOTE.depositAddress.toUpperCase() }],
  ] as const)("refuses %s", (_name, quote) => {
    expect(refusal(() => build({}, quote)).reason).toBe("quote-invalid");
  });

  it("refuses a deposit address that is the signer's own implicit account", () => {
    const signer = ETH_QUOTE.depositAddress;
    const e = refusal(() => build({ signerId: signer }, { refundTo: signer }));
    expect(e.reason).toBe("quote-invalid");
  });
});
