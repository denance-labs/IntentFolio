import { describe, expect, it } from "vitest";
import { getTokenById } from "@/features/market/lib/token-registry";
import type { TokenPriceMap } from "@/features/market/types";
import {
  MAX_STORAGE_COST_YOCTO,
  livePriceOf,
  quoteStorageCost,
  storageCostBytes,
  type StorageQuoteInput,
} from "./storage-cost";

const tok = (len: number, i: number) => {
  const prefix = len <= 20 ? "nep141:t" : "nep245:v2_1.omni.hot.tg:";
  return prefix + String(i).padStart(len - prefix.length, "0");
};
const IMPLICIT = "b".repeat(64);
const NAME25 = "n".repeat(25);

describe("storageCostBytes — the sandbox measurements (031.plan, 031-0)", () => {
  const setup = (opts: { account?: string; address?: string; name?: string; comp: string[]; funded?: string[] }) =>
    storageCostBytes({
      accountId: opts.account ?? IMPLICIT,
      loginAddress: opts.address ?? opts.account ?? IMPLICIT,
      portfolioName: opts.name ?? NAME25,
      compositionTokenIds: opts.comp,
      fundedTokenIds: opts.funded ?? opts.comp,
    });
  const ids = (len: number, n: number) => Array.from({ length: n }, (_, i) => tok(len, i + len));

  it("reproduces the token-count and id-length runs", () => {
    for (const [len, d1, d5, d10, fundsOnly] of [
      [16, 937, 1841, 2971, 1139],
      [82, 1201, 3161, 5611, 1601],
    ]) {
      const t = ids(len, 10);
      expect(t.every((id) => id.length === len)).toBe(true);
      expect(setup({ comp: t.slice(0, 1) })).toBe(d1);
      expect(setup({ comp: t.slice(0, 5) })).toBe(d5);
      expect(setup({ comp: t })).toBe(d10);
      expect(setup({ comp: t.slice(0, 1), funded: t.slice(0, 2) })).toBe(fundsOnly);
    }
  });

  it("reproduces the account, address and name runs", () => {
    const comp = [tok(17, 16)];
    expect(setup({ comp })).toBe(941);
    expect(setup({ comp, account: "pabl.near" })).toBe(611);
    expect(setup({ comp, account: "pablofork1234567890abcdef.near" })).toBe(737);
    expect(setup({ comp, name: "語".repeat(25) })).toBe(991);
    expect(setup({ comp, name: "n" })).toBe(917);
    expect(setup({ comp, address: "S".repeat(44) })).toBe(901);
    expect(setup({ comp, address: "S".repeat(64) })).toBe(941);
    const evm = `0x${"1".repeat(40)}`;
    expect(setup({ comp, account: evm })).toBe(809);
  });

  it("measures NEAR by the id the contract stores (nep141:wrap.near), and counts a token once", () => {
    const asNear = setup({ comp: ["near"], funded: ["near", "near"] });
    expect(asNear).toBe(setup({ comp: ["nep141:wrap.near"] }));
  });
});

const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const BTC = "nep141:2260fac5e5542a773aa44fbcfedf7c193bc2c599.factory.bridge.near";

describe("quoteStorageCost", () => {
  const live: Record<string, number> = { near: 2.5, [USDC]: 1, [BTC]: 100_000 };
  const base = (over: Partial<StorageQuoteInput> = {}): StorageQuoteInput => ({
    accountId: IMPLICIT,
    loginAddress: IMPLICIT,
    portfolioName: "Conservative",
    compositionTokenIds: ["near", USDC],
    grossAllocations: { [USDC]: 100, near: 0.5 },
    priceOf: (id) => live[id] ?? null,
    ...over,
  });

  it("charges the highest-value leg, rounded up, and covers the cost in USD", () => {
    const q = quoteStorageCost(base());
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    expect(q.tokenId).toBe(USDC);
    const costNear = Number(q.costYocto) / 1e24;
    expect(costNear).toBeCloseTo(q.bytes * 1e-5, 12);
    // 6 decimals: the amount covers the cost and one micro-USDC less would not.
    expect(q.qty * 1).toBeGreaterThanOrEqual(costNear * 2.5);
    expect(q.qty - 1e-6).toBeLessThan(costNear * 2.5);
    expect(q.amount).toBe(BigInt(Math.round(q.qty * 1e6)));
  });

  it("is the same in NEAR (24 decimals) and BTC (8), never under the cost", () => {
    const inNear = quoteStorageCost(base({ grossAllocations: { near: 40, [USDC]: 1 } }));
    expect(inNear).toMatchObject({ ok: true, tokenId: "near" });
    if (inNear.ok) expect(inNear.amount).toBe(inNear.costYocto); // NEAR pays NEAR: exactly the cost

    const inBtc = quoteStorageCost(base({ grossAllocations: { [BTC]: 0.01, [USDC]: 1 } }));
    expect(inBtc).toMatchObject({ ok: true, tokenId: BTC });
    if (!inBtc.ok) return;
    const costUsd = (Number(inBtc.costYocto) / 1e24) * 2.5;
    expect(inBtc.qty * 100_000).toBeGreaterThanOrEqual(costUsd);
    expect((inBtc.qty - 1e-8) * 100_000).toBeLessThan(costUsd);
    expect(inBtc.qty).toBeLessThan(0.000001); // cents, not coins
  });

  it("breaks a tie by id, whatever order the allocations come in", () => {
    const a = quoteStorageCost(base({ grossAllocations: { near: 40, [USDC]: 100 } }));
    const b = quoteStorageCost(base({ grossAllocations: { [USDC]: 100, near: 40 } }));
    expect(a.ok && b.ok && a.tokenId === b.tokenId && a.tokenId === "near").toBe(true);
  });

  it("can charge a funds-only token (outside the composition)", () => {
    const q = quoteStorageCost(base({ compositionTokenIds: ["near"], grossAllocations: { [USDC]: 100 } }));
    expect(q).toMatchObject({ ok: true, tokenId: USDC });
  });

  it("refuses without a live NEAR price, or with no live funding price", () => {
    expect(quoteStorageCost(base({ priceOf: (id) => (id === "near" ? null : live[id]) }))).toEqual({
      ok: false,
      reason: "prices-not-live",
    });
    expect(quoteStorageCost(base({ priceOf: (id) => (id === "near" ? 2.5 : null), grossAllocations: { [USDC]: 100 } }))).toEqual({
      ok: false,
      reason: "prices-not-live",
    });
  });

  it("skips a funding token without a live price instead of pricing it", () => {
    const q = quoteStorageCost(base({ priceOf: (id) => (id === BTC ? null : live[id]), grossAllocations: { [BTC]: 1, [USDC]: 5 } }));
    expect(q).toMatchObject({ ok: true, tokenId: USDC });
  });

  it("says no-funds with nothing funded", () => {
    expect(quoteStorageCost(base({ grossAllocations: { [USDC]: 0 } }))).toEqual({ ok: false, reason: "no-funds" });
  });

  it("refuses when what stays of the charged token would be under a cent, or nothing", () => {
    // The cost here is 0.03425 USDC: 0.035 leaves 0.00075, 0.03 leaves less than nothing.
    for (const qty of [0.035, 0.03]) {
      expect(quoteStorageCost(base({ grossAllocations: { [USDC]: qty } }))).toEqual({
        ok: false,
        reason: "exceeds-amount",
        tokenId: USDC,
        qty: 0.03425,
      });
    }
    expect(quoteStorageCost(base({ grossAllocations: { [USDC]: 0.05 } }))).toMatchObject({ ok: true });
  });

  it("refuses an implausible cost (inputs no Setup can have) instead of signing it", () => {
    const huge = Array.from({ length: 400 }, (_, i) => tok(82, i));
    const q = quoteStorageCost(base({ compositionTokenIds: huge, grossAllocations: { [USDC]: 100 } }));
    expect(q).toEqual({ ok: false, reason: "implausible" });
    expect(MAX_STORAGE_COST_YOCTO).toBe(BigInt(10) ** BigInt(24) / BigInt(4));
  });

  it("a registry token's decimals drive the amount (sanity on the fixtures)", () => {
    expect(getTokenById(USDC)?.decimals).toBe(6);
    expect(getTokenById(BTC)?.decimals).toBe(8);
    expect(getTokenById("near")?.decimals).toBe(24);
  });
});

describe("livePriceOf", () => {
  const map = (source: string, usdPrice: number): TokenPriceMap => ({ near: { symbol: "NEAR", usdPrice, updatedAt: "", source } });

  it("takes the feed and its last answer within the hour, not a hand-written fallback", () => {
    expect(livePriceOf(map("chaindefuser", 2.5), "near")).toBe(2.5);
    expect(livePriceOf(map("cached", 2.5), "near")).toBe(2.5);
    expect(livePriceOf(map("coingecko", 2.5), "near")).toBe(2.5);
    expect(livePriceOf(map("fallback", 2.5), "near")).toBeNull();
    expect(livePriceOf({}, "near")).toBeNull();
  });

  it("refuses a price of 0, NaN or Infinity", () => {
    for (const p of [0, Number.NaN, Number.POSITIVE_INFINITY, 1e-20]) expect(livePriceOf(map("chaindefuser", p), "near")).toBeNull();
  });
});
