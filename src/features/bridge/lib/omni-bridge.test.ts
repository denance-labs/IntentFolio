import { describe, it, expect, vi } from "vitest";
import type { Intent } from "@defuse-protocol/contract-types";
import {
  IntentFtWithdrawValidator,
  Nep413DefuseMessageFor_DefuseIntentsValidator,
} from "@defuse-protocol/contract-types/validate";
import {
  buildOmniWithdrawIntent,
  fetchOmniWithdrawalFee,
  omniFeeTotalRaw,
  omniRecipient,
  readOmniRecipient,
  waitForOmniDelivery,
  OMNI_BRIDGE_CONTRACT_ID,
  OMNI_WITHDRAW_MIN_GAS,
  type OmniFeeDetail,
} from "./omni-bridge";
import { buildWithdrawSignRequest } from "./withdraw-envelope";
import { fetchWithdrawalFee, supportsLiveWithdrawalFee } from "./withdrawal-fee";
import { waitForWithdrawDelivery } from "./withdraw-poll";
import { getWithdrawalEntry } from "./withdrawal-registry";

// D-580: ZEC leaves straight through the Omni Bridge. Offline only — every fetch is injected.

const ZEC = "nep141:zec.omft.near";
const ZEC_CONTRACT = "zec.omft.near";
const T1 = "t1TinQZKCGaNk6ujaaaqjJUkgKKRqE8Bj8K"; // a real recipient, from the block-0 fixture
const SIGNER = "alice.near";
const DEADLINE_SECS = 1_800_000_000;
const NONCE = new Uint8Array(32).fill(7);
const EXTERNAL_ID = "5d0f1c2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f";

/** `/api/v2/transfer-fee` as measured on 2026-11-12 for amounts up to 50 ZEC. */
const LIVE_FEE_BODY = {
  native_token_fee: "0",
  transferred_token_fee: "0",
  gas_fee: "22000",
  protocol_fee: "10000",
  min_amount: "100000",
  usd_fee: 0.3,
  insufficient_utxo: false,
};

function fee(over: Partial<OmniFeeDetail> = {}): OmniFeeDetail {
  return {
    gasFeeRaw: "22000",
    protocolFeeRaw: "10000",
    minAmountRaw: "100000",
    quotedForRaw: "500000", // 0.005 ZEC — the planned real-money amount
    ...over,
  };
}

function fields(intent: Intent): Record<string, unknown> {
  return intent as unknown as Record<string, unknown>;
}

function fakeFetch(body: unknown, init: { ok?: boolean } = {}) {
  return vi.fn(async () =>
    ({ ok: init.ok ?? true, json: async () => body }) as Response
  ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

function zec(over: Partial<Parameters<typeof buildWithdrawSignRequest>[0]> = {}) {
  return buildWithdrawSignRequest({
    signerId: SIGNER,
    tokenId: ZEC,
    chainId: "zec:mainnet",
    qty: 0.005,
    heldRaw: BigInt(10) ** BigInt(12),
    destinationAddress: T1,
    deadlineSecs: DEADLINE_SECS,
    nonce: NONCE,
    omniFee: fee(),
    omniExternalId: EXTERNAL_ID,
    ...over,
  });
}

describe("the registry routes ZEC through omni", () => {
  it("has the zec row on the omni route, to zec:mainnet", () => {
    expect(getWithdrawalEntry(ZEC)).toMatchObject({
      chainId: "zec:mainnet",
      nearTokenId: ZEC_CONTRACT,
      bridgeRoute: "omni",
    });
  });

  it("asks for a live fee on it", () => {
    expect(supportsLiveWithdrawalFee(ZEC)).toBe(true);
  });
});

describe("fetchOmniWithdrawalFee", () => {
  it("asks for intents.near → zcash:<addr>, the token and the gross amount", async () => {
    const f = fakeFetch(LIVE_FEE_BODY);
    await fetchOmniWithdrawalFee({
      tokenAccountId: ZEC_CONTRACT,
      chainId: "zec:mainnet",
      destinationAddress: T1,
      amountRaw: "500000",
      fetchImpl: f,
    });
    const url = new URL(String(f.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe("https://mainnet.api.bridge.nearone.org/api/v2/transfer-fee");
    expect(url.searchParams.get("sender")).toBe("near:intents.near");
    expect(url.searchParams.get("recipient")).toBe(`zcash:${T1}`);
    expect(url.searchParams.get("token")).toBe("near:zec.omft.near");
    expect(url.searchParams.get("amount")).toBe("500000");
  });

  it("returns the ceiling, protocol fee and minimum, stamped with the amount quoted", async () => {
    const out = await fetchOmniWithdrawalFee({
      tokenAccountId: ZEC_CONTRACT,
      chainId: "zec:mainnet",
      destinationAddress: T1,
      amountRaw: "500000",
      fetchImpl: fakeFetch(LIVE_FEE_BODY),
    });
    expect(out).toEqual({ kind: "ok", fee: fee() });
    if (out.kind === "ok") expect(omniFeeTotalRaw(out.fee)).toBe("32000");
  });

  it("reports insufficient_utxo as its own answer, not as a failure", async () => {
    const out = await fetchOmniWithdrawalFee({
      tokenAccountId: ZEC_CONTRACT,
      chainId: "zec:mainnet",
      destinationAddress: T1,
      amountRaw: "500000",
      fetchImpl: fakeFetch({ ...LIVE_FEE_BODY, insufficient_utxo: true }),
    });
    expect(out).toEqual({ kind: "insufficient-utxo" });
  });

  it.each([
    ["a NEAR fee it cannot pay on this route", { native_token_fee: "1000" }],
    ["a fee in the token, which we sign as 0", { transferred_token_fee: "500" }],
    ["a zero gas ceiling", { gas_fee: "0" }],
    ["a missing protocol fee", { protocol_fee: undefined }],
    ["a numeric (not string) minimum", { min_amount: 100000 }],
    ["a negative-looking fee", { gas_fee: "-1" }],
  ])("is unavailable on %s", async (_name, patch) => {
    const out = await fetchOmniWithdrawalFee({
      tokenAccountId: ZEC_CONTRACT,
      chainId: "zec:mainnet",
      destinationAddress: T1,
      amountRaw: "500000",
      fetchImpl: fakeFetch({ ...LIVE_FEE_BODY, ...patch }),
    });
    expect(out).toEqual({ kind: "unavailable" });
  });

  it("is unavailable on an HTTP error, a throw, or a chain it has no prefix for", async () => {
    const base = { tokenAccountId: ZEC_CONTRACT, destinationAddress: T1, amountRaw: "500000" };
    expect(
      await fetchOmniWithdrawalFee({ ...base, chainId: "zec:mainnet", fetchImpl: fakeFetch({}, { ok: false }) })
    ).toEqual({ kind: "unavailable" });
    const throwing = vi.fn(async () => {
      throw new Error("504");
    }) as unknown as typeof fetch;
    expect(await fetchOmniWithdrawalFee({ ...base, chainId: "zec:mainnet", fetchImpl: throwing })).toEqual({
      kind: "unavailable",
    });
    const f = fakeFetch(LIVE_FEE_BODY);
    expect(await fetchOmniWithdrawalFee({ ...base, chainId: "btc:mainnet", fetchImpl: f })).toEqual({
      kind: "unavailable",
    });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("fetchWithdrawalFee on omni has no registry fallback", () => {
  it("quotes the total and carries the detail the envelope signs", async () => {
    const r = await fetchWithdrawalFee({
      tokenId: ZEC,
      destinationAddress: T1,
      amountRaw: "500000",
      omniFetch: fakeFetch(LIVE_FEE_BODY),
    });
    expect(r.quote).toEqual({ feeRaw: "32000", source: "live", omni: fee() });
  });

  it("returns no quote when the lookup fails, and flags insufficient_utxo apart", async () => {
    const failed = await fetchWithdrawalFee({
      tokenId: ZEC,
      destinationAddress: T1,
      amountRaw: "500000",
      omniFetch: fakeFetch({}, { ok: false }),
    });
    expect(failed).toEqual({ quote: null, omniInsufficientUtxo: false });
    const short = await fetchWithdrawalFee({
      tokenId: ZEC,
      destinationAddress: T1,
      amountRaw: "500000",
      omniFetch: fakeFetch({ ...LIVE_FEE_BODY, insufficient_utxo: true }),
    });
    expect(short).toEqual({ quote: null, omniInsufficientUtxo: true });
  });

  it("does not ask without the amount, since the ceiling depends on it", async () => {
    const f = fakeFetch(LIVE_FEE_BODY);
    expect(await fetchWithdrawalFee({ tokenId: ZEC, destinationAddress: T1, omniFetch: f })).toEqual({
      quote: null,
    });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("buildOmniWithdrawIntent mirrors the SDK's createWithdrawIntentsPrimitive", () => {
  it("pays the BRIDGE, with the user inside msg, and nothing else", () => {
    const intent = fields(
      buildOmniWithdrawIntent({
        tokenAccountId: ZEC_CONTRACT,
        amount: "500000",
        recipient: `zcash:${T1}`,
        fee: fee(),
        externalId: EXTERNAL_ID,
      })
    );
    expect(intent).toEqual({
      intent: "ft_withdraw",
      token: ZEC_CONTRACT,
      receiver_id: OMNI_BRIDGE_CONTRACT_ID,
      amount: "500000",
      // Byte for byte what the SDK serialises for the same values, key order included.
      msg:
        `{"recipient":"zcash:${T1}","fee":"0","native_token_fee":"0",` +
        `"external_id":"${EXTERNAL_ID}","msg":"{\\"MaxGasFee\\":\\"22000\\"}"}`,
      min_gas: OMNI_WITHDRAW_MIN_GAS,
    });
    expect("memo" in intent).toBe(false);
    expect("storage_deposit" in intent).toBe(false);
  });

  it("passes the canonical ft_withdraw validator", () => {
    const result = IntentFtWithdrawValidator.validate(
      buildOmniWithdrawIntent({
        tokenAccountId: ZEC_CONTRACT,
        amount: "500000",
        recipient: `zcash:${T1}`,
        fee: fee(),
        externalId: EXTERNAL_ID,
      })
    );
    expect("issues" in result ? result.issues : undefined).toBeUndefined();
  });

  it("reads its own recipient back, and nothing from other shapes", () => {
    const intent = buildOmniWithdrawIntent({
      tokenAccountId: ZEC_CONTRACT,
      amount: "1",
      recipient: `zcash:${T1}`,
      fee: fee(),
      externalId: EXTERNAL_ID,
    });
    expect(readOmniRecipient(intent)).toBe(`zcash:${T1}`);
    expect(readOmniRecipient({ ...intent, receiver_id: ZEC_CONTRACT })).toBeNull();
    expect(readOmniRecipient({ ...intent, msg: "not json" })).toBeNull();
    expect(omniRecipient("zec:mainnet", T1)).toBe(`zcash:${T1}`);
    expect(omniRecipient("btc:mainnet", "bc1q")).toBeNull();
  });
});

describe("buildWithdrawSignRequest on the omni route", () => {
  it("signs one ft_withdraw of the GROSS amount to omni.bridge.near", () => {
    const req = zec();
    expect(req.route).toBe("omni");
    expect(req.amount).toBe("500000");
    expect(req.intents).toHaveLength(1);
    expect(fields(req.intents[0])).toMatchObject({
      intent: "ft_withdraw",
      token: ZEC_CONTRACT,
      receiver_id: OMNI_BRIDGE_CONTRACT_ID,
      amount: "500000",
    });
    expect(readOmniRecipient(req.intents[0])).toBe(`zcash:${T1}`);
    expect(req.quoteHashes).toEqual([]);
    const inner = JSON.parse(req.nep413.message);
    const check = Nep413DefuseMessageFor_DefuseIntentsValidator.validate(inner);
    expect("issues" in check ? check.issues : undefined).toBeUndefined();
    expect(JSON.parse(req.erc191Message).intents).toEqual(inner.intents);
  });

  it("signs the quoted ceiling as MaxGasFee", () => {
    const msg = JSON.parse(String(fields(zec({ omniFee: fee({ gasFeeRaw: "33000" }) }).intents[0]).msg));
    expect(JSON.parse(msg.msg)).toEqual({ MaxGasFee: "33000" });
  });

  it("refuses without a live quote — there is no registry figure to sign", () => {
    expect(() => zec({ omniFee: undefined })).toThrow(/live Omni Bridge fee quote/);
  });

  it("refuses an amount larger than the one the quote was asked for", () => {
    expect(() => zec({ qty: 0.006 })).toThrow(/quoted for/);
    // Less than quoted is fine: the ceiling for a smaller amount is never higher.
    expect(zec({ qty: 0.004 }).amount).toBe("400000");
  });

  it("refuses below the bridge minimum, and below fee + minimum net", () => {
    // 0.0009 ZEC = 90000 < min_amount 100000.
    expect(() => zec({ qty: 0.0009, omniFee: fee({ quotedForRaw: "90000" }) })).toThrow(
      /below the Omni Bridge minimum|below the bridge minimum/
    );
    // An amount the whole ceiling would swallow.
    expect(() =>
      zec({ qty: 0.0003, omniFee: fee({ quotedForRaw: "30000", minAmountRaw: "1" }) })
    ).toThrow(/does not cover/);
  });

  it("refuses an address the bridge cannot pay (shielded/unified)", () => {
    expect(() => zec({ destinationAddress: "u1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq" })).toThrow(
      /not a valid address/
    );
  });

  it("refuses a destination memo, which the bridge has nowhere to carry", () => {
    expect(() => zec({ destinationMemo: "123" })).toThrow(/does not carry a destination memo/);
  });

  it("draws a fresh external_id per envelope when none is injected", () => {
    const a = JSON.parse(String(fields(zec({ omniExternalId: undefined }).intents[0]).msg));
    const b = JSON.parse(String(fields(zec({ omniExternalId: undefined }).intents[0]).msg));
    expect(a.external_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.external_id).not.toBe(b.external_id);
  });
});

/** The block-0 fixture: Omni's answer for a real withdrawal to Zcash (tx J8PwufFu…, 2026-11-12). */
const TRANSFER_FIXTURE = [
  {
    id: { origin_chain: "Near", origin_nonce: 824460 },
    initialized: {
      NearReceipt: {
        block_height: 224264998,
        block_timestamp_seconds: 1794516545,
        transaction_hash: "J8PwufFuTus7QCaUMac1daMdJxULD4QwUdXJfPd66ecw",
      },
    },
    signed: {
      NearReceipt: {
        block_height: 224265229,
        block_timestamp_seconds: 1794516678,
        transaction_hash: "CUwrQHRsemD8WG5okAPmvN9r1JtkGNRv62v6xvTHfw13",
      },
    },
    updated_fee: [],
    fast_finalised_on_near: null,
    finalised_on_near: null,
    fast_finalised: null,
    finalised: {
      UtxoLog: {
        block_height: null,
        block_time: null,
        transaction_hash: "b4a3d0c2c8de1e114bebcd1a5e28b427d36fee114cf194a0a29ce7ced546e6c7",
      },
    },
    claimed: null,
    transfer_message: {
      token: "near:zec.omft.near",
      amount: "1659953000",
      sender: "near:2d41f68af1207ee6b96d5002bf60671686facefb5a50e69e7a8aff2431dedc56",
      recipient: `zcash:${T1}`,
      fee: { fee: "0", native_fee: "0" },
      msg: '{"MaxGasFee":"22000"}',
    },
    utxo_transfer: {
      chain: "Zcash",
      btc_pending_id: "b4a3d0c2c8de1e114bebcd1a5e28b427d36fee114cf194a0a29ce7ced546e6c7",
      amount: "1659953000",
      sender: "omni.bridge.near",
      recipient: T1,
      relayer_fee: "10000",
      protocol_fee: "0",
      relayer_account_id: "omni-relayer.bridge.near",
    },
  },
];

const FAST = { p50: 1, p90: 2, p99: 200 };
const NO_WAIT = 1;

describe("waitForOmniDelivery", () => {
  it("returns the Zcash txid from finalised.UtxoLog of OUR transfer", async () => {
    const f = fakeFetch(TRANSFER_FIXTURE);
    const out = await waitForOmniDelivery({
      txHash: "J8PwufFuTus7QCaUMac1daMdJxULD4QwUdXJfPd66ecw",
      tokenAccountId: ZEC_CONTRACT,
      chainId: "zec:mainnet",
      destinationAddress: T1,
      deps: { fetchImpl: f, stats: FAST, minIntervalMs: NO_WAIT },
    });
    expect(out).toEqual({
      destinationTxHash: "b4a3d0c2c8de1e114bebcd1a5e28b427d36fee114cf194a0a29ce7ced546e6c7",
    });
    expect(String(f.mock.calls[0][0])).toBe(
      "https://mainnet.api.bridge.nearone.org/api/v2/transfers/transfer?transaction_hash=J8PwufFuTus7QCaUMac1daMdJxULD4QwUdXJfPd66ecw"
    );
  });

  it("ignores another recipient's transfer in the same transaction", async () => {
    const other = [{ ...TRANSFER_FIXTURE[0], transfer_message: { ...TRANSFER_FIXTURE[0].transfer_message, recipient: "zcash:t1Other" } }];
    await expect(
      waitForOmniDelivery({
        txHash: "tx",
        tokenAccountId: ZEC_CONTRACT,
        chainId: "zec:mainnet",
        destinationAddress: T1,
        deps: { fetchImpl: fakeFetch(other), stats: FAST, minIntervalMs: NO_WAIT },
      })
    ).rejects.toThrow();
  });

  it("tells two same-address transfers in one transaction apart by the signed amount", async () => {
    const first = {
      ...TRANSFER_FIXTURE[0],
      transfer_message: { ...TRANSFER_FIXTURE[0].transfer_message, amount: "111" },
      finalised: { UtxoLog: { block_height: null, block_time: null, transaction_hash: "aaaa" } },
    };
    const out = await waitForOmniDelivery({
      txHash: "tx",
      tokenAccountId: ZEC_CONTRACT,
      chainId: "zec:mainnet",
      destinationAddress: T1,
      amountRaw: "1659953000",
      deps: { fetchImpl: fakeFetch([first, TRANSFER_FIXTURE[0]]), stats: FAST, minIntervalMs: NO_WAIT },
    });
    expect(out.destinationTxHash).toMatch(/^b4a3d0c2/);
  });

  it("keeps waiting through 504s and an unfinalised transfer, then closes", async () => {
    const pending = [{ ...TRANSFER_FIXTURE[0], finalised: null }];
    let n = 0;
    const f = vi.fn(async () => {
      n++;
      if (n === 1) return { ok: false, json: async () => ({}) } as Response;
      if (n === 2) throw new Error("timeout");
      if (n === 3) return { ok: true, json: async () => pending } as Response;
      return { ok: true, json: async () => TRANSFER_FIXTURE } as Response;
    }) as unknown as typeof fetch;
    const out = await waitForOmniDelivery({
      txHash: "tx",
      tokenAccountId: ZEC_CONTRACT,
      chainId: "zec:mainnet",
      destinationAddress: T1,
      deps: { fetchImpl: f, stats: { p50: 5_000, p90: 5_000, p99: 5_000 }, minIntervalMs: NO_WAIT },
    });
    expect(out.destinationTxHash).toMatch(/^b4a3d0c2/);
    expect(n).toBe(4);
  });
});

describe("waitForWithdrawDelivery dispatches omni to the bridge's API", () => {
  it("reports a bridge delivery on zec:mainnet", async () => {
    const out = await waitForWithdrawDelivery({
      tokenId: ZEC,
      route: "omni",
      chainId: "zec:mainnet",
      txHash: "J8PwufFuTus7QCaUMac1daMdJxULD4QwUdXJfPd66ecw",
      destinationAddress: T1,
      omniDelivery: { fetchImpl: fakeFetch(TRANSFER_FIXTURE), stats: FAST, minIntervalMs: NO_WAIT },
    });
    expect(out).toEqual({
      kind: "bridge",
      destinationTxHash: "b4a3d0c2c8de1e114bebcd1a5e28b427d36fee114cf194a0a29ce7ced546e6c7",
      chain: "zec:mainnet",
    });
  });

  it("cannot wait without the destination, and says so as not-confirmed", async () => {
    await expect(
      waitForWithdrawDelivery({ tokenId: ZEC, route: "omni", chainId: "zec:mainnet", txHash: "tx" })
    ).rejects.toThrow();
  });
});
