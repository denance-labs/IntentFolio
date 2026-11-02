import { describe, it, expect, vi } from "vitest";
import {
  DECLINE_RECHECK_ATTEMPTS,
  LATE_DEPOSIT_WATCH_ATTEMPTS,
  LATE_DEPOSIT_WATCH_INTERVAL_MS,
  FT_GAS_RESERVE_YOCTO,
  FT_TRANSFER_CALL_DEPOSIT,
  FT_TRANSFER_CALL_GAS,
  NEAR_DEPOSIT_GAS,
  NEAR_GAS_RESERVE_YOCTO,
  STORAGE_YOCTO_PER_BYTE,
  buildWalletDepositTransaction,
  classifyWalletDepositError,
  classifyWalletDepositOutcome,
  formatBaseUnits,
  hasGasForDeposit,
  isWalletDepositToken,
  nativeDepositBalance,
  parseAmountToBaseUnits,
  readWalletDepositBalance,
  readWalletHoldings,
  runWalletDeposit,
  walletDepositCredit,
  walletDepositTarget,
  type RunWalletDepositInput,
  type WalletDepositBalance,
  type WalletDepositReads,
  type WalletDepositTarget,
} from "./near-wallet-deposit";
import { DAY_ONE_TOKEN_IDS, isTokenAvailable } from "./token-availability";
import { getWithdrawalEntry } from "./withdrawal-registry";
import { getTokenById } from "@/features/market/lib/token-registry";
import { AmountExceedsBalanceError } from "@/features/vault/lib/base-units";

// Real implementations by default; individual tests override one answer to reach a row that the
// registry does not hold today (a NEAR token not yet allowlisted, a route on the wrong chain).
vi.mock("./token-availability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./token-availability")>();
  return { ...actual, isTokenAvailable: vi.fn(actual.isTokenAvailable) };
});
vi.mock("./withdrawal-registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./withdrawal-registry")>();
  return { ...actual, getWithdrawalEntry: vi.fn(actual.getWithdrawalEntry) };
});

// 016 §5.3, block 2a, P1. This file is where the money is: the exact transaction, the 24
// decimals, and the verdict that decides whether the app credits a deposit. Everything is pure
// or takes its reads injected, so none of it needs a wallet or mainnet.

const LOGIN = "pablofork.near";
const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const USDC_CONTRACT = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

const big = (s: string) => BigInt(s);
/** `n` NEAR in yocto, from a decimal string — never through a float. */
const near = (s: string) => parseAmountToBaseUnits(s, 24)!;

const NEAR_TARGET = walletDepositTarget("near")!;
const USDC_TARGET = walletDepositTarget(USDC_NEAR)!;

describe("scope: which tokens a wallet deposit serves", () => {
  it("serves exactly NEAR and the 12 near-native day-1 tokens but SWEAT and RHEA (D-491)", () => {
    const served = [...DAY_ONE_TOKEN_IDS].filter(isWalletDepositToken);
    expect(served).toHaveLength(11);
    expect(served).not.toContain("nep141:token.sweat");
    expect(served).not.toContain("nep141:token.rhealab.near");
    expect(served).toContain("near");
    expect(served).toContain(USDC_NEAR);
  });

  it("NEAR goes through wrap.near, with 24 decimals", () => {
    expect(NEAR_TARGET).toEqual({ tokenId: "near", kind: "native", contractId: "wrap.near", decimals: 24 });
  });

  it("a NEP-141 goes to its own contract, as it is", () => {
    expect(USDC_TARGET).toEqual({ tokenId: USDC_NEAR, kind: "ft", contractId: USDC_CONTRACT, decimals: 6 });
  });

  // The contract is derived from the intents id; the registry says the same thing independently.
  // If the two ever disagree, a deposit would land under an id the General Balance never reads.
  it("every ft contract matches the token registry's contractId", () => {
    for (const id of DAY_ONE_TOKEN_IDS) {
      const target = walletDepositTarget(id);
      if (target?.kind !== "ft") continue;
      expect(target.contractId, id).toBe(getTokenById(id)!.contractId);
      expect(`nep141:${target.contractId}`, id).toBe(id);
    }
  });

  // Today every NEAR row is allowlisted and every NEAR route sits on near:mainnet, so the three
  // guards cover for each other on real data. Each is checked alone against the row it exists for.
  it("refuses a NEAR token the day-1 allowlist has not enabled", () => {
    vi.mocked(isTokenAvailable).mockReturnValueOnce(false);
    expect(walletDepositTarget(USDC_NEAR)).toBeNull();
  });

  it("refuses a near-native route on a chain that is not NEAR", () => {
    vi.mocked(getWithdrawalEntry).mockReturnValueOnce({
      chainId: "eth:1", nearTokenId: USDC_CONTRACT, withdrawalFeeRaw: "0", minWithdrawalRaw: "1", bridgeRoute: "near-native",
    });
    expect(walletDepositTarget(USDC_NEAR)).toBeNull();
  });

  it("refuses the wrap path for any token but NEAR itself", () => {
    vi.mocked(getWithdrawalEntry).mockReturnValueOnce({
      chainId: "near:mainnet", nearTokenId: USDC_CONTRACT, withdrawalFeeRaw: "0", minWithdrawalRaw: "1", bridgeRoute: "near-unwrap",
    });
    expect(walletDepositTarget(USDC_NEAR)).toBeNull();
  });

  it("refuses a bridge route even on near:mainnet", () => {
    vi.mocked(getWithdrawalEntry).mockReturnValueOnce({
      chainId: "near:mainnet", nearTokenId: USDC_CONTRACT, withdrawalFeeRaw: "0", minWithdrawalRaw: "1", bridgeRoute: "omft",
    });
    expect(walletDepositTarget(USDC_NEAR)).toBeNull();
  });

  // Measured with `ft_metadata` on mainnet, s181. A registry typo here would sign 10^k times the
  // amount on screen while every other check stays self-consistent.
  it.each([
    ["near", 24],
    [USDC_NEAR, 6],
    ["nep141:usdt.tether-token.near", 6],
    ["nep141:eth.bridge.near", 18],
    ["nep141:2260fac5e5542a773aa44fbcfedf7c193bc2c599.factory.bridge.near", 8],
    ["nep141:meta-pool.near", 24],
    ["nep141:mpdao-token.near", 6],
    ["nep141:aaaaaa20d9e0e2461697782ef11675f668207961.factory.bridge.near", 18],
    ["nep141:token.publicailab.near", 18],
    ["nep141:npro.nearmobile.near", 24],
  ])("%s signs with the decimals its contract reports (%i)", (id, decimals) => {
    expect(walletDepositTarget(id)?.decimals).toBe(decimals);
  });

  it.each([
    ["omft on NEAR's own account space", "nep141:eth.omft.near"],
    ["omft stablecoin", "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near"],
    ["hot-omni native", "nep245:v2_1.omni.hot.tg:137_11111111111111111111"],
    ["wNEAR's intents id (not a registry id)", "nep141:wrap.near"],
    ["unknown id", "nep141:definitely-not-a-token.near"],
    ["empty", ""],
  ])("refuses %s", (_label, id) => {
    expect(walletDepositTarget(id)).toBeNull();
    expect(isWalletDepositToken(id)).toBe(false);
  });
});

describe("amount: decimal text → base units, exactly", () => {
  it.each([
    ["0.3", 24, "300000000000000000000000"],
    ["1", 6, "1000000"],
    ["1.", 6, "1000000"],
    [".5", 6, "500000"],
    ["0.000000000000000000000001", 24, "1"],
    ["123456789.123456789123456789123456", 24, "123456789123456789123456789123456"],
    [" 2.5 ", 6, "2500000"],
    ["007", 0, "7"],
  ])("%s with %i decimals → %s", (text, decimals, expected) => {
    expect(parseAmountToBaseUnits(text, decimals)).toBe(big(expected));
  });

  it("truncates excess decimals, never rounds up", () => {
    expect(parseAmountToBaseUnits("1.1234569", 6)).toBe(big("1123456"));
    expect(parseAmountToBaseUnits("0.9999999", 6)).toBe(big("999999"));
  });

  it.each(["", ".", "0", "0.000", "0.0000001", "abc", "1,5", "-1", "1e3", "1.2.3", "Infinity"])(
    "refuses %j (not a positive amount at 6 decimals)",
    (text) => {
      expect(parseAmountToBaseUnits(text, 6)).toBeNull();
    }
  );

  it("refuses invalid decimals", () => {
    expect(parseAmountToBaseUnits("1", -1)).toBeNull();
    expect(parseAmountToBaseUnits("1", 1.5)).toBeNull();
  });

  it.each([
    ["300000000000000000000000", 24, "0.3"],
    ["1", 24, "0.000000000000000000000001"],
    ["1000000", 6, "1"],
    ["1500000", 6, "1.5"],
    ["0", 6, "0"],
    ["7", 0, "7"],
    ["663873484929335630399995", 24, "0.663873484929335630399995"],
  ])("formats %s with %i decimals as %s", (raw, decimals, expected) => {
    expect(formatBaseUnits(big(raw), decimals)).toBe(expected);
  });

  it("format and parse are inverses, so Max fills the field with exactly the balance", () => {
    for (const raw of ["1", "999999999999999999999999", "663873484929335630399995", "100000000000000000000000"]) {
      expect(parseAmountToBaseUnits(formatBaseUnits(big(raw), 24), 24)).toBe(big(raw));
    }
  });

  it("refuses to format a negative amount", () => {
    expect(() => formatBaseUnits(big("-1"), 6)).toThrow();
  });
});

// pablofork.near on mainnet, measured s181: 0.7638… NEAR, 346 bytes, registered on wrap.near.
const PABLOFORK = { amount: big("763873484929335630399995"), storageUsage: big("346") };
const WRAP_MIN = big("1250000000000000000000"); // wrap.near storage_balance_bounds.min, measured s181

describe("available: the most a deposit may send", () => {
  it("NEAR: amount − storage − 0.1 reserve, plus wNEAR", () => {
    const b = nativeDepositBalance({ account: PABLOFORK, wrapped: big("0"), registrationCost: big("0"), generalBalance: big("0") });
    expect(b.available).toBe(PABLOFORK.amount - big("346") * STORAGE_YOCTO_PER_BYTE - NEAR_GAS_RESERVE_YOCTO);
    expect(formatBaseUnits(b.available, 24)).toBe("0.660413484929335630399995");
  });

  it("NEAR: wNEAR already held adds on top", () => {
    const b = nativeDepositBalance({ account: PABLOFORK, wrapped: near("2"), registrationCost: big("0"), generalBalance: big("0") });
    expect(b.available).toBe(near("0.660413484929335630399995") + near("2"));
    expect(b.wrapped).toBe(near("2"));
  });

  it("NEAR: an unregistered account also sets the registration aside", () => {
    const b = nativeDepositBalance({ account: PABLOFORK, wrapped: big("0"), registrationCost: WRAP_MIN, generalBalance: big("0") });
    expect(b.available).toBe(near("0.660413484929335630399995") - WRAP_MIN);
    expect(b.registrationCost).toBe(WRAP_MIN);
  });

  it("NEAR: floors at zero when the wallet holds less than storage + reserve, keeps the wNEAR", () => {
    const poor = { amount: near("0.05"), storageUsage: big("346") };
    expect(nativeDepositBalance({ account: poor, wrapped: big("0"), registrationCost: big("0"), generalBalance: big("0") }).available).toBe(big("0"));
    expect(nativeDepositBalance({ account: poor, wrapped: near("1"), registrationCost: big("0"), generalBalance: big("0") }).available).toBe(near("1"));
  });

  it("NEAR: a heavy account's storage comes out of what it may send", () => {
    const withContract = { amount: near("5"), storageUsage: big("200000") }; // 2 NEAR of storage
    expect(nativeDepositBalance({ account: withContract, wrapped: big("0"), registrationCost: big("0"), generalBalance: big("0") }).available)
      .toBe(near("2.9"));
  });
});

function readsWith(overrides: Partial<WalletDepositReads> = {}): WalletDepositReads {
  return {
    ftBalance: vi.fn(async () => big("0")),
    nearAccount: vi.fn(async () => PABLOFORK),
    storageBalanceOf: vi.fn(async () => ({ total: WRAP_MIN.toString() })),
    storageBalanceBounds: vi.fn(async () => ({ min: WRAP_MIN.toString() })),
    generalBalance: vi.fn(async () => big("0")),
    ...overrides,
  };
}

describe("readWalletDepositBalance", () => {
  it("ft: the token balance from the token's own contract, the NEAR free for gas, the General Balance", async () => {
    const reads = readsWith({
      ftBalance: vi.fn(async () => big("1500000")),
      generalBalance: vi.fn(async () => big("700000")),
    });
    expect(await readWalletDepositBalance(USDC_TARGET, LOGIN, reads)).toEqual({
      kind: "ft",
      available: big("1500000"),
      // Liquid NEAR minus the 346 bytes of storage: 0.7638… − 0.00346.
      nearFree: near("0.760413484929335630399995"),
      generalBalance: big("700000"),
    });
    expect(reads.ftBalance).toHaveBeenCalledWith(USDC_CONTRACT, LOGIN);
    expect(reads.nearAccount).toHaveBeenCalledWith(LOGIN);
    // The id the deposit lands under: the contract it is sent to, prefixed.
    expect(reads.generalBalance).toHaveBeenCalledWith(USDC_NEAR, LOGIN);
  });

  it("ft: NEAR free for gas floors at zero when storage pins it all", async () => {
    const reads = readsWith({ nearAccount: vi.fn(async () => ({ amount: near("0.001"), storageUsage: big("346") })) });
    expect(await readWalletDepositBalance(USDC_TARGET, LOGIN, reads)).toMatchObject({ nearFree: big("0") });
  });

  it("NEAR, registered: does not ask for the bounds and charges no registration", async () => {
    const reads = readsWith({ ftBalance: vi.fn(async () => near("1")) });
    const b = await readWalletDepositBalance(NEAR_TARGET, LOGIN, reads);
    expect(b).toEqual({
      kind: "native",
      available: near("0.660413484929335630399995") + near("1"),
      wrapped: near("1"),
      registrationCost: big("0"),
      generalBalance: big("0"),
    });
    expect(reads.ftBalance).toHaveBeenCalledWith("wrap.near", LOGIN);
    expect(reads.generalBalance).toHaveBeenCalledWith("nep141:wrap.near", LOGIN);
    expect(reads.storageBalanceOf).toHaveBeenCalledWith("wrap.near", LOGIN);
    expect(reads.storageBalanceBounds).not.toHaveBeenCalled();
  });

  it("NEAR, unregistered: reads wrap.near's minimum and sets it aside", async () => {
    const reads = readsWith({ storageBalanceOf: vi.fn(async () => null) });
    const b = await readWalletDepositBalance(NEAR_TARGET, LOGIN, reads);
    expect(b).toMatchObject({ kind: "native", registrationCost: WRAP_MIN });
    expect(reads.storageBalanceBounds).toHaveBeenCalledWith("wrap.near");
  });

  // Fail closed: a read that fails is no balance at all — never a zero, never a partial Max.
  it.each<[string, Partial<WalletDepositReads>]>([
    ["the account read", { nearAccount: vi.fn(async () => { throw new Error("RPC HTTP 401"); }) }],
    ["the wNEAR read", { ftBalance: vi.fn(async () => { throw new Error("timeout"); }) }],
    ["the registration read", { storageBalanceOf: vi.fn(async () => { throw new Error("timeout"); }) }],
    ["the General Balance read", { generalBalance: vi.fn(async () => { throw new Error("RPC HTTP 503"); }) }],
    [
      "the bounds read",
      {
        storageBalanceOf: vi.fn(async () => null),
        storageBalanceBounds: vi.fn(async () => { throw new Error("timeout"); }),
      },
    ],
    ["an empty minimum", { storageBalanceOf: vi.fn(async () => null), storageBalanceBounds: vi.fn(async () => ({ min: "" })) }],
    [
      "a non-numeric minimum",
      { storageBalanceOf: vi.fn(async () => null), storageBalanceBounds: vi.fn(async () => ({ min: "1.25e21" })) },
    ],
  ])("NEAR: rejects when %s fails", async (_label, overrides) => {
    await expect(readWalletDepositBalance(NEAR_TARGET, LOGIN, readsWith(overrides))).rejects.toThrow();
  });

  it.each<[string, Partial<WalletDepositReads>]>([
    ["the balance read", { ftBalance: vi.fn(async () => { throw new Error("RPC HTTP 500"); }) }],
    ["the account read", { nearAccount: vi.fn(async () => { throw new Error("RPC HTTP 401"); }) }],
    ["the General Balance read", { generalBalance: vi.fn(async () => { throw new Error("RPC HTTP 503"); }) }],
  ])("ft: rejects when %s fails", async (_label, overrides) => {
    await expect(readWalletDepositBalance(USDC_TARGET, LOGIN, readsWith(overrides))).rejects.toThrow();
  });
});

// D-349: a token deposit pays its gas in NEAR; below the reserve no button is offered.
// D-445: the list on Receive's first step. Display only — the amount step re-reads the one token.
describe("readWalletHoldings", () => {
  const USDT_NEAR = "nep141:usdt.tether-token.near";

  it("lists only tokens with something to deposit, NEAR net of storage and the reserve plus wNEAR", async () => {
    const reads = readsWith({
      ftBalance: vi.fn(async (contractId: string) =>
        contractId === "wrap.near" ? near("0.5") : contractId === USDC_CONTRACT ? big("2500000") : big("0"),
      ),
    });
    const holdings = await readWalletHoldings(LOGIN, reads);
    expect(holdings).toEqual([
      // 0.7638… − 0.00346 storage − 0.1 reserve + 0.5 wNEAR.
      { tokenId: "near", available: near("1.160413484929335630399995"), decimals: 24 },
      { tokenId: USDC_NEAR, available: big("2500000"), decimals: 6 },
    ]);
    // One account read for all of them, and no registration bounds: this is not the amount step.
    expect(reads.nearAccount).toHaveBeenCalledTimes(1);
    expect(reads.storageBalanceBounds).not.toHaveBeenCalled();
    expect(reads.generalBalance).not.toHaveBeenCalled();
  });

  it("asks the token contracts themselves, wNEAR for NEAR", async () => {
    const reads = readsWith({ ftBalance: vi.fn(async () => big("0")) });
    await readWalletHoldings(LOGIN, reads);
    const asked = vi.mocked(reads.ftBalance).mock.calls.map(([contractId]) => contractId);
    expect(asked).toContain("wrap.near");
    expect(asked).toContain(USDC_CONTRACT);
    expect(asked).toContain("usdt.tether-token.near");
  });

  it("fails closed per token: an unreadable token is left out, never listed as zero", async () => {
    const reads = readsWith({
      ftBalance: vi.fn(async (contractId: string) => {
        if (contractId === USDC_CONTRACT) throw new Error("rpc down");
        return contractId === "usdt.tether-token.near" ? big("1000000") : big("0");
      }),
    });
    const holdings = await readWalletHoldings(LOGIN, reads);
    // NEAR is listed from the account alone: 0.66 spendable with no wNEAR.
    expect(holdings.map((h) => h.tokenId)).toEqual(["near", USDT_NEAR]);
  });

  it("without the account read nothing is listed", async () => {
    const reads = readsWith({ nearAccount: vi.fn(async () => Promise.reject(new Error("rpc down"))) });
    await expect(readWalletHoldings(LOGIN, reads)).rejects.toThrow("rpc down");
  });
});

describe("hasGasForDeposit", () => {
  const ft = (nearFree: bigint): WalletDepositBalance => ({
    kind: "ft", available: big("1000000"), nearFree, generalBalance: big("0"),
  });

  // The prepayment is bought at `min_gas_purchase_price` (10^9 on mainnet, protocol 86), not at
  // the block's 10^8 burn price.
  it("the reserve is 0.1 NEAR, twice the ≈0.05 a 50 Tgas ft_transfer_call prepays at 10^9 yocto/gas", () => {
    expect(formatBaseUnits(FT_GAS_RESERVE_YOCTO, 24)).toBe("0.1");
    expect(FT_GAS_RESERVE_YOCTO).toBe(BigInt(FT_TRANSFER_CALL_GAS) * BigInt(1_000_000_000) * BigInt(2));
  });

  it("ft: yes from the reserve up, no a yocto below it", () => {
    expect(hasGasForDeposit(ft(FT_GAS_RESERVE_YOCTO))).toBe(true);
    expect(hasGasForDeposit(ft(near("3")))).toBe(true);
    expect(hasGasForDeposit(ft(FT_GAS_RESERVE_YOCTO - big("1")))).toBe(false);
    expect(hasGasForDeposit(ft(big("0")))).toBe(false);
  });

  it("NEAR: always yes — its available figure already leaves 0.1 NEAR in the wallet", () => {
    expect(hasGasForDeposit(nativeBalance({ available: big("0") }))).toBe(true);
  });
});

const transferCall = (amount: string) => ({
  type: "FunctionCall",
  params: {
    methodName: "ft_transfer_call",
    args: { receiver_id: "intents.near", amount, msg: "" },
    gas: "50000000000000",
    deposit: "1",
  },
});

const nearDeposit = (deposit: string) => ({
  type: "FunctionCall",
  params: { methodName: "near_deposit", args: {}, gas: "30000000000000", deposit },
});

function nativeBalance(b: Partial<Extract<WalletDepositBalance, { kind: "native" }>>): WalletDepositBalance {
  return { kind: "native", available: near("10"), wrapped: big("0"), registrationCost: big("0"), generalBalance: big("0"), ...b };
}

/** A token balance with plenty of NEAR for gas. */
function ftBal(available: bigint): WalletDepositBalance {
  return { kind: "ft", available, nearFree: near("1"), generalBalance: big("0") };
}

describe("the wire shape of a wallet deposit", () => {
  // Each constant is something a plausible edit gets wrong with no type error. The literal
  // expectations below restate them on purpose, so a changed constant fails here too.
  it("pins the gas and the yocto", () => {
    expect(NEAR_DEPOSIT_GAS).toBe("30000000000000");
    expect(FT_TRANSFER_CALL_GAS).toBe("50000000000000");
    expect(FT_TRANSFER_CALL_DEPOSIT).toBe("1");
    expect(NEAR_GAS_RESERVE_YOCTO).toBe(big("100000000000000000000000"));
  });

  it("NEP-141: one ft_transfer_call to the token contract", () => {
    const tx = buildWalletDepositTransaction(USDC_TARGET, ftBal(big("5000000")), big("1000000"));
    expect(tx).toEqual({ receiverId: USDC_CONTRACT, actions: [transferCall("1000000")] });
  });

  it("NEAR with no wNEAR: wraps all of it, then transfers, in one transaction to wrap.near", () => {
    const tx = buildWalletDepositTransaction(NEAR_TARGET, nativeBalance({}), near("0.3"));
    expect(tx).toEqual({
      receiverId: "wrap.near",
      actions: [nearDeposit("300000000000000000000000"), transferCall("300000000000000000000000")],
    });
  });

  it("NEAR with some wNEAR: wraps only what the wNEAR does not cover", () => {
    const tx = buildWalletDepositTransaction(NEAR_TARGET, nativeBalance({ wrapped: near("0.1") }), near("0.3"));
    expect(tx.actions).toEqual([
      nearDeposit("200000000000000000000000"),
      transferCall("300000000000000000000000"),
    ]);
  });

  it("NEAR fully covered by wNEAR: no wrap at all", () => {
    const tx = buildWalletDepositTransaction(NEAR_TARGET, nativeBalance({ wrapped: near("0.5") }), near("0.3"));
    expect(tx.actions).toEqual([transferCall("300000000000000000000000")]);
  });

  it("NEAR, unregistered on wrap.near: near_deposit also carries the registration", () => {
    const tx = buildWalletDepositTransaction(NEAR_TARGET, nativeBalance({ registrationCost: WRAP_MIN }), near("0.3"));
    expect(tx.actions).toEqual([
      nearDeposit("301250000000000000000000"),
      transferCall("300000000000000000000000"),
    ]);
  });

  it("keeps every one of the 24 decimals", () => {
    const amount = big("663873484929335630399995");
    const tx = buildWalletDepositTransaction(NEAR_TARGET, nativeBalance({ available: amount }), amount);
    expect(tx.actions.map((a) => a.params.args.amount ?? a.params.deposit)).toEqual([
      "663873484929335630399995",
      "663873484929335630399995",
    ]);
  });

  it("allows exactly the available amount (Max)", () => {
    expect(() =>
      buildWalletDepositTransaction(USDC_TARGET, ftBal(big("1000000")), big("1000000"))
    ).not.toThrow();
  });

  it("refuses one base unit more than available", () => {
    expect(() =>
      buildWalletDepositTransaction(USDC_TARGET, ftBal(big("1000000")), big("1000001"))
    ).toThrow(AmountExceedsBalanceError);
  });

  it("refuses zero and negative amounts", () => {
    const balance: WalletDepositBalance = ftBal(big("1000000"));
    expect(() => buildWalletDepositTransaction(USDC_TARGET, balance, big("0"))).toThrow();
    expect(() => buildWalletDepositTransaction(USDC_TARGET, balance, big("-1"))).toThrow();
  });

  it("refuses a balance of the other kind", () => {
    expect(() => buildWalletDepositTransaction(NEAR_TARGET, ftBal(near("5")), near("1"))).toThrow();
    expect(() => buildWalletDepositTransaction(USDC_TARGET, nativeBalance({}), big("1"))).toThrow();
  });

  it("never names a receiver in msg: the deposit credits whoever signs", () => {
    for (const [target, balance] of [
      [USDC_TARGET, ftBal(big("5"))],
      [NEAR_TARGET, nativeBalance({})],
    ] as Array<[WalletDepositTarget, WalletDepositBalance]>) {
      const transfer = buildWalletDepositTransaction(target, balance, big("5")).actions.at(-1)!;
      expect(transfer.params.args).toEqual({ receiver_id: "intents.near", amount: "5", msg: "" });
    }
  });
});

// Outcome fixtures, shaped like the FinalExecutionOutcome near-connect hands back. P4 replaces or
// joins these with the outcomes of the real deposits.
const HASH = "8oVqGo7aRkTGfC7KzKgmwzLr1jjsQXp1rNSqYbvkBrQy";
const b64 = (json: unknown) => btoa(JSON.stringify(json));

/** The receipt the transaction became. Its failure reverts every action in it (nearcore). */
const FIRST_RECEIPT = "FiRsTrEcEiPt11111111111111111111111111111111";

function outcome(o: { status?: unknown; signer?: string | null; receipts?: unknown[] }) {
  return {
    status: o.status,
    transaction: o.signer === null ? {} : { signer_id: o.signer ?? LOGIN, hash: HASH },
    transaction_outcome: { id: HASH, outcome: { receipt_ids: [FIRST_RECEIPT] } },
    receipts_outcome: o.receipts ?? [],
  };
}

const executionError = (text: string) => ({ ActionError: { kind: { FunctionCallError: { ExecutionError: text } } } });

const AMOUNT = big("300000000000000000000000");

describe("classifyWalletDepositOutcome", () => {
  const classify = (o: unknown, amount = AMOUNT) =>
    classifyWalletDepositOutcome({ outcome: o, amount, loginAccountId: LOGIN });

  it("credited: the login signed and intents.near kept all of it", () => {
    expect(classify(outcome({ status: { SuccessValue: b64(AMOUNT.toString()) } }))).toEqual({
      kind: "credited",
      amount: AMOUNT,
      txHash: HASH,
    });
  });

  // The sub-receipt of ft_on_transfer failed and the transaction still succeeded: a clean refund.
  it("refunded: value 0, even with a failed sub-receipt", () => {
    const refundedOutcome = outcome({
      status: { SuccessValue: b64("0") },
      receipts: [
        { outcome: { executor_id: "intents.near", status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: insufficient balance" } } } } } } },
      ],
    });
    expect(classify(refundedOutcome)).toEqual({ kind: "refunded", txHash: HASH });
  });

  it("partial: intents.near kept less than was sent", () => {
    expect(classify(outcome({ status: { SuccessValue: b64("100000000000000000000000") } }))).toEqual({
      kind: "partial",
      credited: big("100000000000000000000000"),
      txHash: HASH,
    });
  });

  // The first receipt holds `near_deposit` + `ft_transfer_call`: its failure reverts both.
  it("failed: the first receipt reverted, with the execution error as the message", () => {
    const text = "Smart contract panicked: The account doesn't have enough balance";
    const failed = outcome({
      status: { Failure: executionError(text) },
      receipts: [{ id: FIRST_RECEIPT, outcome: { executor_id: "wrap.near", status: { Failure: executionError(text) } } }],
    });
    expect(classify(failed)).toEqual({ kind: "failed", message: text, txHash: HASH });
  });

  // A later receipt failing the whole transaction can only be `ft_resolve_transfer`, which runs
  // AFTER intents.near kept the tokens: "nothing moved" is not proven there.
  it("unconfirmed: a later receipt failed while the first one succeeded", () => {
    const text = "Exceeded the prepaid gas.";
    const late = outcome({
      status: { Failure: executionError(text) },
      receipts: [
        { id: FIRST_RECEIPT, outcome: { executor_id: "wrap.near", status: { SuccessReceiptId: "resolve" } } },
        { id: "resolve", outcome: { executor_id: "wrap.near", status: { Failure: executionError(text) } } },
      ],
    });
    expect(classify(late)).toEqual({ kind: "unconfirmed", message: text });
  });

  it("unconfirmed: a failure we cannot place, because the receipts are missing", () => {
    expect(classify(outcome({ status: { Failure: executionError("boom") } }))).toMatchObject({ kind: "unconfirmed" });
  });

  it("failed: an invalid transaction ran nothing", () => {
    const invalid = outcome({ status: { Failure: { InvalidTxError: { InvalidNonce: { tx_nonce: 1, ak_nonce: 2 } } } } });
    expect(classify(invalid)).toMatchObject({ kind: "failed" });
  });

  it.each([
    ["RequiresFullAccess (the two-action NEAR transaction)", { InvalidTxError: { InvalidAccessKeyError: "RequiresFullAccess" } }],
    ["DepositWithFunctionCall (every one-action transaction)", { InvalidTxError: { InvalidAccessKeyError: "DepositWithFunctionCall" } }],
  ])("failed + requires-full-access: %s", (_label, failure) => {
    expect(classify(outcome({ status: { Failure: failure } }))).toMatchObject({
      kind: "failed",
      cause: "requires-full-access",
    });
  });

  it("failed + not-enough-balance: the account cannot pay the gas", () => {
    const poor = outcome({
      status: { Failure: { InvalidTxError: { NotEnoughBalance: { signer_id: LOGIN, balance: "1", cost: "2" } } } },
    });
    expect(classify(poor)).toMatchObject({ kind: "failed", cause: "not-enough-balance" });
  });

  it("other-account: the network refused a key that is not the signer's", () => {
    const refused = outcome({
      status: {
        Failure: {
          InvalidTxError: {
            InvalidAccessKeyError: { AccessKeyNotFound: { account_id: LOGIN, public_key: "ed25519:abc" } },
          },
        },
      },
    });
    expect(classify(refused)).toMatchObject({ kind: "other-account" });
  });

  it("wrong-signer: it landed, but under another account — and names it", () => {
    expect(classify(outcome({ status: { SuccessValue: b64(AMOUNT.toString()) }, signer: "someone-else.near" }))).toEqual({
      kind: "wrong-signer",
      signerId: "someone-else.near",
      credited: AMOUNT,
      txHash: HASH,
    });
  });

  it("a refund under another signer is still just a refund: nothing entered anywhere", () => {
    expect(classify(outcome({ status: { SuccessValue: b64("0") }, signer: "someone-else.near" }))).toMatchObject({
      kind: "refunded",
    });
  });

  it.each<[string, unknown]>([
    ["no outcome at all", undefined],
    ["an outcome with no status (a trimmed wallet response)", { transaction_outcome: { id: HASH } }],
    ["a status still pointing at a receipt", outcome({ status: { SuccessReceiptId: "abc" } })],
    ["an empty value", outcome({ status: { SuccessValue: "" } })],
    ["a value that is not a U128 string", outcome({ status: { SuccessValue: b64(300) } })],
    ["a value that is not base64 JSON", outcome({ status: { SuccessValue: "%%%" } })],
    ["more kept than was sent", outcome({ status: { SuccessValue: b64((AMOUNT + big("1")).toString()) } })],
    ["no signer to check", outcome({ status: { SuccessValue: b64(AMOUNT.toString()) }, signer: null })],
  ])("unreadable: %s", (_label, o) => {
    expect(classify(o).kind).toBe("unreadable");
  });

  it("unreadable keeps the hash, so the caller can re-read the transaction", () => {
    expect(classify({ transaction_outcome: { id: HASH } })).toEqual({ kind: "unreadable", txHash: HASH });
  });
});

describe("classifyWalletDepositError", () => {
  it("declined: the user rejected it in the wallet", () => {
    expect(classifyWalletDepositError(new Error("User rejected the request"))).toEqual({ kind: "declined" });
  });

  // "rejected" is a cancel keyword, and a network refusal can carry it. The key cause wins.
  it("other-account beats the cancel keywords", () => {
    const e = new Error(
      'Transaction rejected: {"InvalidTxError":{"InvalidAccessKeyError":{"AccessKeyNotFound":{"account_id":"pablofork.near","public_key":"ed25519:abc"}}}}'
    );
    expect(classifyWalletDepositError(e)).toMatchObject({ kind: "other-account" });
  });

  it.each([
    ["nearcore / old near-api-js", 'Signer "pablofork.near" doesn\'t have access key with public key ed25519:abc'],
    ["near-api-js 7, tx-level", "Access key ed25519:abc does not exist on account pablofork.near"],
    ["near-api-js 7, nonce lookup", "Access key ed25519:abc does not exist at block height 123"],
    ["older near-api-js, nonce lookup", "access key ed25519:abc does not exist while viewing"],
  ])("other-account in %s wording", (_label, text) => {
    expect(classifyWalletDepositError(new Error(text))).toMatchObject({ kind: "other-account" });
  });

  it.each([
    "Transaction rejected: requires a full access key",
    "Access key requires full access",
    "Invalid access key type. Full-access keys are required for transactions that have multiple or non-function-call actions",
    "Deposit is not allowed with function call access keys",
    "Having a deposit with a function call action is not allowed with a function call access key.",
  ])("requires-full-access is a failure with its own cause, not a cancel: %s", (text) => {
    expect(classifyWalletDepositError(new Error(text))).toEqual({
      kind: "failed",
      message: text,
      cause: "requires-full-access",
      txHash: null,
    });
  });

  it("not enough balance for gas is a failure with its own cause", () => {
    expect(classifyWalletDepositError(new Error("Sender pablofork.near does not have enough balance: NotEnoughBalance"))).toMatchObject({
      kind: "failed",
      cause: "not-enough-balance",
    });
  });

  // near-connect's "No accounts found" comes from `connector.wallet()`, before anything is sent.
  it("no connected wallet is a failure that proves nothing was sent", () => {
    const e = Object.assign(new Error("No accounts found"), { name: "WalletNotConnectedError" });
    expect(classifyWalletDepositError(e)).toEqual({
      kind: "failed",
      message: "No accounts found",
      cause: "wallet-not-connected",
      txHash: null,
    });
  });

  // A wallet can broadcast and THEN throw (a timeout waiting for the result). "Failed" there
  // invites a second deposit; the honest answer is that we do not know.
  it("anything else is unconfirmed, not failed", () => {
    expect(classifyWalletDepositError(new Error("Transaction timed out"))).toEqual({
      kind: "unconfirmed",
      message: "Transaction timed out",
    });
  });
});

describe("runWalletDeposit", () => {
  const credited = outcome({ status: { SuccessValue: b64(AMOUNT.toString()) } });
  const trimmed = { transaction_outcome: { id: HASH } };

  function run(overrides: Partial<RunWalletDepositInput> = {}) {
    const send = overrides.send ?? vi.fn(async () => credited);
    const input: RunWalletDepositInput = {
      target: NEAR_TARGET,
      balance: nativeBalance({}),
      amount: AMOUNT,
      loginAccountId: LOGIN,
      send,
      readTx: vi.fn(async () => credited),
      // After a cancel the chain is re-read (D-348); by default it shows nothing moved.
      readBalance: vi.fn(async () => nativeBalance({})),
      sleep: async () => {},
      rereadIntervalMs: 1,
      ...overrides,
    };
    return { promise: runWalletDeposit(input), input, send };
  }

  // 🔴 Blink's 5 s activation window: the wallet must be asked before the first await, so a
  // click handler that calls this opens the popup inside the gesture.
  it("asks the wallet synchronously, before any await", () => {
    const { send } = run();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("signs as the login, with the builder's exact transaction", async () => {
    const { promise, send } = run();
    await promise;
    expect(send).toHaveBeenCalledWith({
      signerId: LOGIN,
      receiverId: "wrap.near",
      actions: [nearDeposit(AMOUNT.toString()), transferCall(AMOUNT.toString())],
    });
  });

  it("credited: returns the verdict without re-reading the chain", async () => {
    const { promise, input } = run();
    expect(await promise).toEqual({ kind: "credited", amount: AMOUNT, txHash: HASH });
    expect(input.readTx).not.toHaveBeenCalled();
  });

  it("tells the UI when the wallet answered, before the verdict", async () => {
    const onWalletAnswered = vi.fn();
    const { promise } = run({ onWalletAnswered });
    await promise;
    expect(onWalletAnswered).toHaveBeenCalledTimes(1);
  });

  it("does not claim the wallet answered when it threw a failure that proves nothing moved", async () => {
    const onWalletAnswered = vi.fn();
    const send = vi.fn(async () => { throw new Error("Sender pablofork.near does not have enough balance: NotEnoughBalance"); });
    await run({ onWalletAnswered, send }).promise;
    expect(onWalletAnswered).not.toHaveBeenCalled();
  });

  it("declined: the user rejected it, and the re-reads show nothing left the wallet", async () => {
    const { promise, input } = run({ send: vi.fn(async () => { throw new Error("User rejected the transaction"); }) });
    expect(await promise).toEqual({ kind: "declined" });
    expect(input.readBalance).toHaveBeenCalledTimes(DECLINE_RECHECK_ATTEMPTS);
  });

  // D-348, measured s191 with Meteor: "approve, close the popup at once" throws a cancel whether
  // or not the transaction left. The wallet's word is not the verdict; the chain is.
  describe("after a cancel, the chain decides (D-348)", () => {
    const cancel = () => vi.fn(async () => { throw new Error("User rejected the transaction"); });
    const before = nativeBalance({ available: near("10"), generalBalance: near("2") });
    const landed = nativeBalance({ available: near("10") - AMOUNT - near("0.001"), generalBalance: near("2") + AMOUNT });
    const inFlight = nativeBalance({ available: near("10") - AMOUNT - near("0.001"), generalBalance: near("2") });

    it("tells the UI the wallet answered, so it shows the check instead of 'approve in your wallet'", async () => {
      const onWalletAnswered = vi.fn();
      await run({ onWalletAnswered, send: cancel(), balance: before }).promise;
      expect(onWalletAnswered).toHaveBeenCalledTimes(1);
    });

    it("credited, with no hash, when the wallet dropped and the General Balance rose by the amount", async () => {
      const readBalance = vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(landed);
      const { promise } = run({ send: cancel(), balance: before, readBalance });
      expect(await promise).toEqual({ kind: "credited", amount: AMOUNT, txHash: null });
      expect(readBalance).toHaveBeenCalledTimes(2);
    });

    it("the credit it earns is the amount, like any credited verdict", async () => {
      const { promise } = run({ send: cancel(), balance: before, readBalance: vi.fn(async () => landed) });
      expect(walletDepositCredit(await promise, "near")).toEqual({ tokenId: "near", amount: AMOUNT, txHash: null });
    });

    it("unconfirmed, not declined, when the wallet dropped but the credit never showed", async () => {
      const { promise } = run({ send: cancel(), balance: before, readBalance: vi.fn(async () => inFlight) });
      expect(await promise).toMatchObject({ kind: "unconfirmed" });
    });

    it("declined when a drop seen early is gone by the last read (a refund came back)", async () => {
      const readBalance = vi.fn().mockResolvedValueOnce(inFlight).mockResolvedValue(before);
      const { promise } = run({ send: cancel(), balance: before, readBalance });
      expect(await promise).toEqual({ kind: "declined" });
    });

    it("a General Balance that rose with no wallet drop is not credited — nor 'nothing moved'", async () => {
      const otherCredit = nativeBalance({ available: near("10"), generalBalance: near("2") + AMOUNT });
      const { promise } = run({ send: cancel(), balance: before, readBalance: vi.fn(async () => otherCredit) });
      expect(await promise).toMatchObject({ kind: "unconfirmed" });
    });

    // Cross-review s197: the baseline is read when the tab opens, maybe minutes before the click.
    // Money that reached the wallet since can hide the drop; the General Balance still tells.
    it("money arriving in the wallet cannot hide a deposit that landed behind 'nothing moved'", async () => {
      const inflowAndLanded = nativeBalance({ available: near("10") + near("5") - AMOUNT, generalBalance: near("2") + AMOUNT });
      const { promise } = run({ send: cancel(), balance: before, readBalance: vi.fn(async () => inflowAndLanded) });
      expect(await promise).toMatchObject({ kind: "unconfirmed" });
    });

    it("unconfirmed when the last read failed: never 'nothing moved' without a read that shows it", async () => {
      const readBalance = vi.fn().mockResolvedValueOnce(before).mockRejectedValue(new Error("RPC HTTP 503"));
      const { promise } = run({ send: cancel(), balance: before, readBalance });
      expect(await promise).toMatchObject({ kind: "unconfirmed" });
      expect(readBalance).toHaveBeenCalledTimes(DECLINE_RECHECK_ATTEMPTS);
    });

    it("a token: the wallet drops by exactly the amount", async () => {
      const ftBefore = { ...ftBal(big("5000000")), generalBalance: big("0") };
      const ftLanded = { ...ftBal(big("4000000")), generalBalance: big("1000000") };
      const { promise } = run({
        target: USDC_TARGET,
        balance: ftBefore,
        amount: big("1000000"),
        send: cancel(),
        readBalance: vi.fn(async () => ftLanded),
      });
      expect(await promise).toEqual({ kind: "credited", amount: big("1000000"), txHash: null });
    });

    it("NEAR sent with Max: available falls to zero, which is still a drop of at least the amount", async () => {
      const max = nativeBalance({ available: near("0.66"), generalBalance: big("0") });
      const after = nativeBalance({ available: big("0"), generalBalance: near("0.66") });
      const { promise } = run({ amount: near("0.66"), balance: max, send: cancel(), readBalance: vi.fn(async () => after) });
      expect(await promise).toEqual({ kind: "credited", amount: near("0.66"), txHash: null });
    });

    it("waits between reads, not before the first", async () => {
      const sleep = vi.fn(async () => {});
      await run({ send: cancel(), balance: before, sleep }).promise;
      expect(sleep).toHaveBeenCalledTimes(DECLINE_RECHECK_ATTEMPTS - 1);
    });

    // Cross-review s197: after 120 s the baseline is stale and the user may be on a newer deposit,
    // whose effect a re-read would claim for this one.
    it("a late cancel changes nothing: no re-read, no late verdict, 'unconfirmed' stays", async () => {
      let reject!: (e: unknown) => void;
      const send = vi.fn(() => new Promise<unknown>((_r, rej) => { reject = rej; }));
      const onLateResult = vi.fn();
      const readBalance = vi.fn(async () => landed);
      const { promise } = run({ send, sendTimeoutMs: 5, onLateResult, balance: before, readBalance });
      expect(await promise).toEqual({ kind: "unconfirmed" });
      reject(new Error("User rejected"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(onLateResult).not.toHaveBeenCalled();
      expect(readBalance).not.toHaveBeenCalled();
    });

    // D-382, measured s199 with Meteor: closing near-connect's intermediate popup before the
    // signing window opens rejects with "Wallet closed" — no cancel keyword, no hash. It proves
    // nothing either way, so the chain decides, exactly as after a cancel.
    describe("a hashless wallet error with no cancel keyword is re-read too (D-382)", () => {
      const closed = () => vi.fn(async () => { throw new Error("Wallet closed"); });

      it("declined when the re-reads show nothing moved", async () => {
        const readBalance = vi.fn(async () => before);
        const { promise } = run({ send: closed(), balance: before, readBalance });
        expect(await promise).toEqual({ kind: "declined" });
        expect(readBalance).toHaveBeenCalledTimes(DECLINE_RECHECK_ATTEMPTS);
      });

      it("unconfirmed when the wallet dropped but the credit never showed", async () => {
        const { promise } = run({ send: closed(), balance: before, readBalance: vi.fn(async () => inFlight) });
        expect(await promise).toMatchObject({ kind: "unconfirmed" });
      });

      it("credited when the deposit landed anyway", async () => {
        const { promise } = run({ send: closed(), balance: before, readBalance: vi.fn(async () => landed) });
        expect(await promise).toEqual({ kind: "credited", amount: AMOUNT, txHash: null });
      });

      it("tells the UI the wallet answered while the chain is read", async () => {
        const onWalletAnswered = vi.fn();
        await run({ onWalletAnswered, send: closed(), balance: before }).promise;
        expect(onWalletAnswered).toHaveBeenCalledTimes(1);
      });

      it("a late one changes nothing: no re-read, and the late verdict stays unconfirmed", async () => {
        let reject!: (e: unknown) => void;
        const send = vi.fn(() => new Promise<unknown>((_r, rej) => { reject = rej; }));
        const onLateResult = vi.fn();
        const readBalance = vi.fn(async () => before);
        const { promise } = run({ send, sendTimeoutMs: 5, onLateResult, balance: before, readBalance });
        expect(await promise).toEqual({ kind: "unconfirmed" });
        reject(new Error("Wallet closed"));
        await vi.waitFor(() => expect(onLateResult).toHaveBeenCalledWith(expect.objectContaining({ kind: "unconfirmed" })));
        expect(readBalance).not.toHaveBeenCalled();
      });
    });

    // D-378 (a wallet that broadcasts after the window) and D-381 (receipts that run minutes late):
    // the recheck's verdict is shown, and a deposit that lands afterwards still turns it into a credit.
    describe("the background watch after the recheck (D-378 / D-381)", () => {
      /** Reads `first` for the recheck, then `then` for the watch. */
      const reads = (first: WalletDepositBalance, then: WalletDepositBalance) => {
        const fn = vi.fn(async () => first);
        for (let i = 0; i < DECLINE_RECHECK_ATTEMPTS; i++) fn.mockResolvedValueOnce(first);
        fn.mockResolvedValue(then);
        return fn;
      };

      it("declined, then the deposit lands: one late credit", async () => {
        const onLateResult = vi.fn();
        const { promise } = run({ send: cancel(), balance: before, readBalance: reads(before, landed), onLateResult });
        expect(await promise).toEqual({ kind: "declined" });
        await vi.waitFor(() => expect(onLateResult).toHaveBeenCalledWith({ kind: "credited", amount: AMOUNT, txHash: null }));
        expect(onLateResult).toHaveBeenCalledTimes(1);
      });

      it("unconfirmed (the wallet dropped), then the General Balance rises: one late credit", async () => {
        const onLateResult = vi.fn();
        const { promise } = run({ send: cancel(), balance: before, readBalance: reads(inFlight, landed), onLateResult });
        expect(await promise).toMatchObject({ kind: "unconfirmed" });
        await vi.waitFor(() => expect(onLateResult).toHaveBeenCalledWith({ kind: "credited", amount: AMOUNT, txHash: null }));
      });

      it("the same after a hashless wallet error (D-382)", async () => {
        const onLateResult = vi.fn();
        const send = vi.fn(async () => { throw new Error("Wallet closed"); });
        await run({ send, balance: before, readBalance: reads(before, landed), onLateResult }).promise;
        await vi.waitFor(() => expect(onLateResult).toHaveBeenCalledWith(expect.objectContaining({ kind: "credited" })));
      });

      it("nothing lands: no late verdict, and the watch ends after its reads", async () => {
        const onLateResult = vi.fn();
        const readBalance = reads(before, before);
        await run({ send: cancel(), balance: before, readBalance, onLateResult }).promise;
        await vi.waitFor(() =>
          expect(readBalance).toHaveBeenCalledTimes(DECLINE_RECHECK_ATTEMPTS + LATE_DEPOSIT_WATCH_ATTEMPTS)
        );
        expect(onLateResult).not.toHaveBeenCalled();
      });

      it("only one side moving is never a credit", async () => {
        const onLateResult = vi.fn();
        const readBalance = reads(before, inFlight);
        await run({ send: cancel(), balance: before, readBalance, onLateResult }).promise;
        await vi.waitFor(() =>
          expect(readBalance).toHaveBeenCalledTimes(DECLINE_RECHECK_ATTEMPTS + LATE_DEPOSIT_WATCH_ATTEMPTS)
        );
        expect(onLateResult).not.toHaveBeenCalled();
      });

      it("a failed read is no answer: the next one still catches the credit", async () => {
        const onLateResult = vi.fn();
        const readBalance = reads(before, landed);
        readBalance.mockRejectedValueOnce(new Error("RPC HTTP 503"));
        await run({ send: cancel(), balance: before, readBalance, onLateResult }).promise;
        await vi.waitFor(() => expect(onLateResult).toHaveBeenCalledWith(expect.objectContaining({ kind: "credited" })));
      });

      it("stops when a newer deposit starts: its movement is not this one's", async () => {
        const onLateResult = vi.fn();
        let current = true;
        const readBalance = reads(before, landed);
        const sleep = vi.fn(async () => { if (sleep.mock.calls.length > DECLINE_RECHECK_ATTEMPTS - 1) current = false; });
        await run({ send: cancel(), balance: before, readBalance, onLateResult, sleep, isCurrent: () => current }).promise;
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(onLateResult).not.toHaveBeenCalled();
        expect(readBalance).toHaveBeenCalledTimes(DECLINE_RECHECK_ATTEMPTS);
      });

      it("waits before its first read, so the recheck's verdict is shown first", async () => {
        const sleep = vi.fn(async (_ms: number) => {});
        await run({ send: cancel(), balance: before, sleep, onLateResult: vi.fn() }).promise;
        await vi.waitFor(() =>
          expect(sleep.mock.calls.filter(([ms]) => ms === LATE_DEPOSIT_WATCH_INTERVAL_MS)).toHaveLength(
            LATE_DEPOSIT_WATCH_ATTEMPTS
          )
        );
      });

      it("a credit inside the recheck window starts no watch", async () => {
        const onLateResult = vi.fn();
        const readBalance = vi.fn(async () => landed);
        await run({ send: cancel(), balance: before, readBalance, onLateResult }).promise;
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(readBalance).toHaveBeenCalledTimes(1);
        expect(onLateResult).not.toHaveBeenCalled();
      });

      it("no onLateResult, no watch", async () => {
        const readBalance = vi.fn(async () => before);
        await run({ send: cancel(), balance: before, readBalance }).promise;
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(readBalance).toHaveBeenCalledTimes(DECLINE_RECHECK_ATTEMPTS);
      });
    });

    it("a late failure that proves nothing moved still arrives", async () => {
      let reject!: (e: unknown) => void;
      const send = vi.fn(() => new Promise<unknown>((_r, rej) => { reject = rej; }));
      const onLateResult = vi.fn();
      const { promise } = run({ send, sendTimeoutMs: 5, onLateResult });
      await promise;
      reject(new Error('{"InvalidTxError":{"InvalidAccessKeyError":{"AccessKeyNotFound":{}}}}'));
      await vi.waitFor(() => expect(onLateResult).toHaveBeenCalledWith(expect.objectContaining({ kind: "other-account" })));
    });
  });

  it("other-account: the network refused the other account's key", async () => {
    const send = vi.fn(async () => {
      throw new Error('{"InvalidTxError":{"InvalidAccessKeyError":{"AccessKeyNotFound":{"account_id":"pablofork.near","public_key":"ed25519:x"}}}}');
    });
    expect(await run({ send }).promise).toMatchObject({ kind: "other-account" });
  });

  it("a sender that throws synchronously never reached the wallet: failed, not rethrown", async () => {
    const send = vi.fn(() => { throw new Error("Wallet is not connected"); });
    expect(await run({ send }).promise).toEqual({ kind: "failed", message: "Wallet is not connected", txHash: null });
  });

  it("refuses to ask the wallet for more than the balance", async () => {
    const { promise, send } = run({ amount: near("11") });
    expect(await promise).toMatchObject({ kind: "failed", txHash: null });
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses to ask the wallet without an account to sign as", async () => {
    const { promise, send } = run({ loginAccountId: "" });
    expect(await promise).toMatchObject({ kind: "failed" });
    expect(send).not.toHaveBeenCalled();
  });

  it("unreadable outcome: re-reads by hash, as the login, and returns what the chain says", async () => {
    const { promise, input } = run({ send: vi.fn(async () => trimmed) });
    expect(await promise).toEqual({ kind: "credited", amount: AMOUNT, txHash: HASH });
    expect(input.readTx).toHaveBeenCalledWith(HASH, LOGIN);
  });

  it("keeps re-reading through failed reads, then answers", async () => {
    const readTx = vi
      .fn()
      .mockRejectedValueOnce(new Error("RPC HTTP 503"))
      .mockResolvedValueOnce(trimmed)
      .mockResolvedValueOnce(credited);
    const { promise } = run({ send: vi.fn(async () => trimmed), readTx });
    expect(await promise).toMatchObject({ kind: "credited" });
    expect(readTx).toHaveBeenCalledTimes(3);
  });

  it("unconfirmed, never unreadable, when the re-reads run out", async () => {
    const readTx = vi.fn(async () => trimmed);
    const { promise } = run({ send: vi.fn(async () => trimmed), readTx, rereadAttempts: 3 });
    expect(await promise).toMatchObject({ kind: "unconfirmed" });
    expect(readTx).toHaveBeenCalledTimes(3);
  });

  it("unconfirmed without a hash to re-read", async () => {
    const readTx = vi.fn();
    const { promise } = run({ send: vi.fn(async () => ({ status: { SuccessReceiptId: "x" } })), readTx });
    expect(await promise).toMatchObject({ kind: "unconfirmed" });
    expect(readTx).not.toHaveBeenCalled();
  });

  it("stops WAITING at the timeout, and hands a late approval to onLateResult once", async () => {
    let approve!: (o: unknown) => void;
    const send = vi.fn(() => new Promise<unknown>((resolve) => { approve = resolve; }));
    const onLateResult = vi.fn();
    const { promise } = run({ send, sendTimeoutMs: 5, onLateResult });
    expect(await promise).toEqual({ kind: "unconfirmed" });
    expect(onLateResult).not.toHaveBeenCalled();
    approve(credited);
    await vi.waitFor(() => expect(onLateResult).toHaveBeenCalledTimes(1));
    expect(onLateResult).toHaveBeenCalledWith({ kind: "credited", amount: AMOUNT, txHash: HASH });
  });

  it("the user stopping the wait is unconfirmed too, never failed", async () => {
    const controller = new AbortController();
    const { promise } = run({ send: vi.fn(() => new Promise<unknown>(() => {})), signal: controller.signal });
    controller.abort();
    expect(await promise).toEqual({ kind: "unconfirmed" });
  });

});

describe("walletDepositCredit: what the app credits", () => {
  it("credited: the whole amount", () => {
    expect(walletDepositCredit({ kind: "credited", amount: AMOUNT, txHash: HASH }, "near")).toEqual({
      tokenId: "near",
      amount: AMOUNT,
      txHash: HASH,
    });
  });

  it("partial: only what intents.near kept", () => {
    expect(walletDepositCredit({ kind: "partial", credited: big("5"), txHash: HASH }, "near")).toEqual({
      tokenId: "near",
      amount: big("5"),
      txHash: HASH,
    });
  });

  it.each<[string, Parameters<typeof walletDepositCredit>[0]]>([
    ["wrong-signer (it is in someone else's balance)", { kind: "wrong-signer", signerId: "x.near", credited: AMOUNT, txHash: HASH }],
    ["refunded", { kind: "refunded", txHash: HASH }],
    ["failed", { kind: "failed", message: "x", txHash: HASH }],
    ["other-account", { kind: "other-account", message: "x" }],
    ["declined", { kind: "declined" }],
    ["unconfirmed", { kind: "unconfirmed" }],
    ["unreadable", { kind: "unreadable", txHash: HASH }],
  ])("nothing for %s", (_label, result) => {
    expect(walletDepositCredit(result, "near")).toBeNull();
  });
});
