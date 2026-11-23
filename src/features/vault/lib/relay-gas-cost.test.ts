import { describe, expect, it } from "vitest";
import {
  quoteRelayGas,
  relayGasTokenOf,
  RELAY_GAS_COST_YOCTO,
  RELAY_GAS_MEMO,
  RELAY_GAS_RECEIVER,
  relayGasIntent,
} from "./relay-gas-cost";

const USDT = "nep141:usdt.tether-token.near";
const BTC = "nep141:btc.omft.near";
const XLM = "nep245:v2_1.omni.hot.tg:1100_111bzQBB65GxAPAVoxqmMcgYo5oS3txhqs1Uh1cgahKQUeTUq1TJu";

const prices = (map: Record<string, number | null>) => (id: string) => (id in map ? map[id] : null);

describe("quoteRelayGas — 0.002 NEAR in the token the operation moves (048 §10)", () => {
  it("is 0.002 NEAR", () => {
    expect(RELAY_GAS_COST_YOCTO).toBe(BigInt("2000000000000000000000"));
  });

  it("prices the operator's journey: NEAR 3.03, USDT 0.999041 ⇒ 0.006066 USDT, rounded up", () => {
    const quote = quoteRelayGas({ tokenId: USDT, priceOf: prices({ near: 3.03, [USDT]: 0.999041 }) });
    // 0.002 × 3.03 / 0.999041 = 0.0060658… ⇒ 6066 base units (6 decimals), never 6065.
    expect(quote).toEqual({ ok: true, charge: { tokenId: USDT, amount: "6066", qty: 0.006066 } });
  });

  it("charges NEAR as wNEAR, the id the Verifier holds, exactly 0.002 at equal prices", () => {
    const quote = quoteRelayGas({ tokenId: "near", priceOf: prices({ near: 3.03 }) });
    expect(quote).toEqual({
      ok: true,
      charge: { tokenId: "nep141:wrap.near", amount: "2000000000000000000000", qty: 0.002 },
    });
  });

  it("rounds up to a whole base unit on few decimals (BTC 8, XLM 7)", () => {
    const btc = quoteRelayGas({ tokenId: BTC, priceOf: prices({ near: 3.03, [BTC]: 81144 }) });
    // 0.00606 USD / 81144 = 7.47e-8 BTC ⇒ 8 sats.
    expect(btc.ok && btc.charge?.amount).toBe("8");
    const xlm = quoteRelayGas({ tokenId: XLM, priceOf: prices({ near: 3.03, [XLM]: 0.25 }) });
    // 0.00606 / 0.25 = 0.02424 XLM ⇒ 242400 stroops.
    expect(xlm.ok && xlm.charge?.amount).toBe("242400");
  });

  it("goes uncharged when the token or NEAR has no live price (operator, 2026-11-20)", () => {
    expect(quoteRelayGas({ tokenId: USDT, priceOf: prices({ near: 3.03 }) })).toEqual({ ok: true, charge: null });
    expect(quoteRelayGas({ tokenId: USDT, priceOf: prices({ [USDT]: 1 }) })).toEqual({ ok: true, charge: null });
  });

  it("refuses a token the app does not know", () => {
    expect(quoteRelayGas({ tokenId: "nep141:nobody.near", priceOf: prices({ near: 3 }) })).toEqual({
      ok: false,
      reason: "implausible",
    });
  });
});

describe("relayGasIntent", () => {
  it("is a plain transfer to the gas account with the fixed memo and no msg", () => {
    expect(relayGasIntent({ tokenId: USDT, amount: "6066" })).toEqual({
      intent: "transfer",
      receiver_id: RELAY_GAS_RECEIVER,
      tokens: { [USDT]: "6066" },
      memo: RELAY_GAS_MEMO,
    });
    expect(RELAY_GAS_RECEIVER).toBe("intentfolio-budget.near");
    expect(RELAY_GAS_MEMO).toBe("gas");
  });

  it("refuses an amount that is not a positive integer", () => {
    for (const amount of ["0", "-1", "1.5", "", "01"]) {
      expect(() => relayGasIntent({ tokenId: USDT, amount })).toThrow();
    }
  });
});

describe("relayGasTokenOf — the leg an operation that funds several pays in", () => {
  const priceOf = prices({ near: 3, [USDT]: 1, [BTC]: 80000 });

  it("is the highest-value leg with a live price, like the Storage Cost", () => {
    expect(relayGasTokenOf({ [USDT]: 5, [BTC]: 0.001 }, priceOf)).toBe(BTC); // $80 > $5
    expect(relayGasTokenOf({ [USDT]: 500, [BTC]: 0.001 }, priceOf)).toBe(USDT);
  });

  it("skips legs without a live price or without an amount, and is null when none is left", () => {
    expect(relayGasTokenOf({ [XLM]: 1000, [USDT]: 1 }, priceOf)).toBe(USDT);
    expect(relayGasTokenOf({ [USDT]: 0, [XLM]: 1 }, priceOf)).toBeNull();
  });

  it("breaks a tie by the smaller id, so the order of the legs does not matter", () => {
    const even = prices({ [USDT]: 1, [BTC]: 1 });
    expect(relayGasTokenOf({ [USDT]: 2, [BTC]: 2 }, even)).toBe(BTC);
    expect(relayGasTokenOf({ [BTC]: 2, [USDT]: 2 }, even)).toBe(BTC);
  });
});
