import { describe, it, expect, vi } from "vitest";
import {
  fetchHotFeeAndRequirement,
  fetchHotGasRequirement,
  fetchHotWithdrawalFee,
  hotFeeSupported,
  hotNativeAssetId,
  type HotFeeDeps,
} from "./hot-fee";
import { getWithdrawalEntry, withdrawalRegistry } from "./withdrawal-registry";

// USDC on Polygon — non-native: the fee is bought with a solver swap.
const USDC_POLYGON = "nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L";
const POL_NATIVE = "nep245:v2_1.omni.hot.tg:137_11111111111111111111";
// USDT on Optimism — the case that proves the native table is not the token registry:
// Optimism's native has no IntentFolio entry, only its stablecoins do.
const USDT_OPTIMISM = "nep245:v2_1.omni.hot.tg:10_359RPSJVdTxwTJT9TyGssr2rFoWo";
// TON native — flat constant, zero I/O.
const TON_NATIVE = "nep245:v2_1.omni.hot.tg:1117_";
const XLM = "nep245:v2_1.omni.hot.tg:1100_111bzQBB5v7AhLyPMDwS8uJgQV24KaAPXtwyVWu2KXbbfQU6NXRCz";
// USDT on TON — non-native on the one non-EVM chain in the set.
const USDT_TON = "nep245:v2_1.omni.hot.tg:1117_3tsdfyziyc7EJbP2aULWSKU4toBaAcN4FdTgfm5W1mC4ouR";
// Not HOT: an `omft` route, whose fee is the PoA bridge's business.
const USDT_ARB = "nep141:arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near";

// Takes numbers because tsconfig targets ES2017, where `10n` is a compile error.
function gasReturning(gasPriceWei: number, blockNumber: number) {
  return vi.fn(async () => ({
    gasPriceWei: BigInt(gasPriceWei),
    blockNumber: BigInt(blockNumber),
  }));
}

function quoteReturning(q: Record<string, unknown>) {
  return vi.fn(async () => q) as unknown as NonNullable<HotFeeDeps["quote"]>;
}

function okQuote(over: Record<string, unknown> = {}) {
  return {
    quote_hash: "qh-1",
    defuse_asset_identifier_in: USDC_POLYGON,
    defuse_asset_identifier_out: POL_NATIVE,
    amount_in: "4321",
    amount_out: "2600000000000000",
    expiration_time: "2026-08-05T12:00:00.000Z",
    ...over,
  };
}

describe("hotNativeAssetId", () => {
  // The table is mirrored from upstream rather than derived, so the thing worth asserting is
  // that the three ENCODINGS survive: EVM zero-address base58, TON's empty key, and the fact
  // that a chain we do not cover answers null instead of a plausible invention.
  it("mirrors upstream's three distinct native encodings", () => {
    // The three forms the table exists for: EVM's zero address, TON's EMPTY key, and
    // Stellar's opaque id — none derivable from another. Stellar filled in at block 4.4.
    expect(hotNativeAssetId("eth:137")).toBe(POL_NATIVE);
    expect(hotNativeAssetId("ton:mainnet")).toBe(TON_NATIVE);
    expect(hotNativeAssetId("stellar:mainnet")).toBe(XLM);
    expect(hotNativeAssetId("sol:mainnet")).toBeNull();
  });

  // Wherever our own registry curates a chain's native, the table has to agree with it —
  // otherwise the swap would buy gas denominated in an asset the withdrawal never mentions.
  it("agrees with every native the withdrawal registry already carries", () => {
    const curated = Object.keys(withdrawalRegistry).filter(
      (id) => id.endsWith("_11111111111111111111") || id === TON_NATIVE || id === XLM
    );
    expect(curated.length).toBe(5); // BNB, AVAX, POL, TON, XLM
    for (const id of curated) {
      expect(hotNativeAssetId(getWithdrawalEntry(id)!.chainId)).toBe(id);
    }
  });
});

describe("hotFeeSupported", () => {
  it("covers the HOT chains we curate and refuses the ones we do not", () => {
    expect(hotFeeSupported(USDC_POLYGON)).toBe(true);
    expect(hotFeeSupported(TON_NATIVE)).toBe(true);
    expect(hotFeeSupported(USDT_ARB)).toBe(false);
    expect(hotFeeSupported("nep141:not-a-real-token")).toBe(false);
  });

  it("covers every hot-omni token in the registry — no gaps left on this route", () => {
    const hotTokens = Object.entries(withdrawalRegistry)
      .filter(([, e]) => e.bridgeRoute === "hot-omni")
      .map(([id]) => id);
    expect(hotTokens.length).toBe(15); // 13 + XLM and USDC-Stellar (4.4)
    expect(hotTokens.filter((id) => !hotFeeSupported(id))).toEqual([]);
  });
});

describe("fetchHotWithdrawalFee — relayer fee", () => {
  // The exact arithmetic of omni-sdk `getGaslessWithdrawFee`, including the order of
  // operations: 1.3x on the gas price, TRUNCATED, and only then the 200_000 gas limit.
  it("applies the 1.3x headroom to the gas price before the gas limit", async () => {
    const deps: HotFeeDeps = {
      evmGas: gasReturning(11, 777),
      quote: quoteReturning(okQuote()),
    };
    const fee = await fetchHotWithdrawalFee({ tokenId: USDC_POLYGON, deps });
    // (11 * 130) / 100 = 14 (not 14.3), then 14 * 200_000.
    expect(fee?.hot.relayerFeeRaw).toBe(String(14 * 200_000));
    expect(fee?.hot.blockNumber).toBe("777");
  });

  it("uses TON's flat constant and never touches an RPC", async () => {
    const evmGas = gasReturning(1, 1);
    const fee = await fetchHotWithdrawalFee({ tokenId: TON_NATIVE, deps: { evmGas } });
    expect(evmGas).not.toHaveBeenCalled();
    expect(fee).toEqual({
      feeRaw: "40000000",
      hot: {
        relayerFeeRaw: "40000000",
        blockNumber: "0",
        nativeAssetId: TON_NATIVE,
        payment: "in-kind",
        swap: null,
      },
    });
  });

  // The whole point of the module: there is no registry snapshot to fall back to, because a
  // snapshot has no blockNumber and the blockNumber is signed.
  it("returns null when the gas lookup fails, rather than a static fee", async () => {
    const deps: HotFeeDeps = {
      evmGas: vi.fn(async () => {
        throw new Error("rpc unreachable");
      }),
    };
    expect(await fetchHotWithdrawalFee({ tokenId: USDC_POLYGON, deps })).toBeNull();
  });

  it("returns null for a token that is not hot-omni", async () => {
    const evmGas = gasReturning(1, 1);
    expect(await fetchHotWithdrawalFee({ tokenId: USDT_ARB, deps: { evmGas } })).toBeNull();
    expect(await fetchHotWithdrawalFee({ tokenId: "nep141:nope", deps: { evmGas } })).toBeNull();
    expect(evmGas).not.toHaveBeenCalled();
  });
});

// Block 4.4. Stellar's fee is the only one that depends on the DESTINATION rather than the
// chain, and the two answers differ by 1 XLM. Every test here is really asking the same
// question: when we are not sure, do we charge the expensive one?
describe("fetchHotWithdrawalFee — Stellar picks its constant by destination", () => {
  const NEW_ACCOUNT = "11000000";
  const EXISTING = "1000000";
  const ADDRESS = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

  it("charges the cheap constant only for an account Horizon confirms", async () => {
    const stellarAccountExists = vi.fn(async () => true);
    const fee = await fetchHotWithdrawalFee({
      tokenId: XLM,
      destinationAddress: ADDRESS,
      deps: { stellarAccountExists },
    });
    expect(stellarAccountExists).toHaveBeenCalledWith(ADDRESS, undefined);
    expect(fee?.hot.relayerFeeRaw).toBe(EXISTING);
    expect(fee?.hot.blockNumber).toBe("0");
  });

  it("charges the account-creation constant when the account is absent", async () => {
    const fee = await fetchHotWithdrawalFee({
      tokenId: XLM,
      destinationAddress: ADDRESS,
      deps: { stellarAccountExists: async () => false },
    });
    expect(fee?.hot.relayerFeeRaw).toBe(NEW_ACCOUNT);
  });

  // The three ways of not knowing. All three must land on the expensive answer — never on
  // the cheap one, and never on `null`, which would block a withdrawal that is fine.
  it("charges the expensive constant when Horizon throws", async () => {
    const fee = await fetchHotWithdrawalFee({
      tokenId: XLM,
      destinationAddress: ADDRESS,
      deps: {
        stellarAccountExists: async () => {
          throw new Error("horizon unreachable");
        },
      },
    });
    expect(fee?.hot.relayerFeeRaw).toBe(NEW_ACCOUNT);
  });

  it("charges the expensive constant when Horizon hangs past the timeout", async () => {
    const fee = await fetchHotWithdrawalFee({
      tokenId: XLM,
      destinationAddress: ADDRESS,
      deps: { stellarAccountExists: () => new Promise<boolean>(() => {}) },
    });
    expect(fee?.hot.relayerFeeRaw).toBe(NEW_ACCOUNT);
  }, 15_000);

  it("charges the expensive constant with no address, and never asks Horizon", async () => {
    const stellarAccountExists = vi.fn(async () => true);
    const fee = await fetchHotWithdrawalFee({ tokenId: XLM, deps: { stellarAccountExists } });
    expect(stellarAccountExists).not.toHaveBeenCalled();
    expect(fee?.hot.relayerFeeRaw).toBe(NEW_ACCOUNT);
  });

  it("never reaches an EVM RPC for a Stellar withdrawal", async () => {
    const evmGas = gasReturning(1, 1);
    await fetchHotWithdrawalFee({
      tokenId: XLM,
      destinationAddress: ADDRESS,
      deps: { evmGas, stellarAccountExists: async () => true },
    });
    expect(evmGas).not.toHaveBeenCalled();
  });
});

// D-274. The failure this guards is not "the fee is wrong" — each individual answer here is
// correct. It is that the SAME cycle can produce two of them, and the screen then sizes a gas
// purchase against one while judging sufficiency against the other.
describe("fetchHotFeeAndRequirement — one Horizon resolution per call", () => {
  const NEW_ACCOUNT = "11000000";
  const EXISTING = "1000000";
  const ADDRESS = "GCLROWV43E4RIHPWUFOLFWGS2VJTRW46KXOPBQPGFKYJXQL47P6RTQDA";
  /** USDC on Stellar: non-native, so it reaches the swap and — with no solver — comes back blocked. */
  const USDC_STELLAR =
    "nep245:v2_1.omni.hot.tg:1100_111bzQBB65GxAPAVoxqmMcgYo5oS3txhqs1Uh1cgahKQUeTUq1TJu";

  /** No solver quotes a `hot.tg` native (D-251), which is what makes the screen blocked. */
  const noSolver = vi.fn(async () => {
    throw new Error("no solver filled it");
  }) as unknown as NonNullable<HotFeeDeps["quote"]>;

  it("asks Horizon exactly once, even though two answers are produced", async () => {
    // `Once` twice, and they DISAGREE on purpose: this is an unstable Horizon, which is the
    // only condition under which D-274 fires. A second lookup anywhere in this call would
    // consume the second value, and the assertions below would part company.
    const stellarAccountExists = vi
      .fn<(address: string, signal?: AbortSignal) => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const { requirement, fee } = await fetchHotFeeAndRequirement({
      tokenId: USDC_STELLAR,
      destinationAddress: ADDRESS,
      deps: { stellarAccountExists, quote: noSolver },
    });

    expect(stellarAccountExists).toHaveBeenCalledTimes(1);
    // The blocked screen: cost known, nothing can pay it.
    expect(fee).toBeNull();
    // 🔴 The point of the block. The figure survives the `fee: null` instead of being
    // discarded and re-fetched — and it is the FIRST answer, not a second opinion.
    expect(requirement?.relayerFeeRaw).toBe(EXISTING);
  });

  it("hands out the same requirement it priced the swap against", async () => {
    // The other direction, so the assertion above cannot be passing on the default. Here the
    // first answer is the expensive one; a second lookup would report the cheap one.
    const stellarAccountExists = vi
      .fn<(address: string, signal?: AbortSignal) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const { requirement, fee } = await fetchHotFeeAndRequirement({
      tokenId: USDC_STELLAR,
      destinationAddress: ADDRESS,
      deps: { stellarAccountExists, quote: noSolver },
    });

    expect(stellarAccountExists).toHaveBeenCalledTimes(1);
    expect(fee).toBeNull();
    expect(requirement?.relayerFeeRaw).toBe(NEW_ACCOUNT);
  });

  it("reports a requirement on the paths that are NOT blocked, too", async () => {
    // `native-balance`: the signer already holds the XLM. `fee.feeRaw` is legitimately "0"
    // (nothing leaves the withdrawn token) and the requirement is what actually gets paid, so
    // a caller reading only the fee would understate this screen by 0.1 XLM.
    const { requirement, fee } = await fetchHotFeeAndRequirement({
      tokenId: USDC_STELLAR,
      destinationAddress: ADDRESS,
      nativeBalanceRaw: EXISTING,
      deps: { stellarAccountExists: async () => true, quote: noSolver },
    });

    expect(fee?.hot.payment).toBe("native-balance");
    expect(fee?.feeRaw).toBe("0");
    expect(requirement?.relayerFeeRaw).toBe(EXISTING);
  });

  it("reports no requirement when the cost itself is unknown, so nothing is offered", async () => {
    // An EVM chain whose RPC is down. Distinct from the blocked case above: there is no figure
    // to buy against, and a caller must not offer a purchase it cannot size.
    const { requirement, fee } = await fetchHotFeeAndRequirement({
      tokenId: USDC_POLYGON,
      destinationAddress: "0x1111111111111111111111111111111111111111",
      deps: {
        evmGas: async () => {
          throw new Error("rpc down");
        },
        quote: noSolver,
      },
    });

    expect(fee).toBeNull();
    expect(requirement).toBeNull();
  });

  it("is the same computation `fetchHotWithdrawalFee` performs", async () => {
    // The wrapper is what 46 existing assertions in this repo still go through, so it has to
    // stay faithful rather than merely compile.
    const deps = { stellarAccountExists: async () => true, quote: noSolver };
    const both = await fetchHotFeeAndRequirement({
      tokenId: XLM,
      destinationAddress: ADDRESS,
      deps,
    });
    const narrow = await fetchHotWithdrawalFee({
      tokenId: XLM,
      destinationAddress: ADDRESS,
      deps,
    });
    expect(narrow).toEqual(both.fee);
  });
});

describe("fetchHotWithdrawalFee — when no swap is needed", () => {
  it("skips the solver when the withdrawn token IS the chain's gas", async () => {
    const quote = quoteReturning(okQuote());
    const fee = await fetchHotWithdrawalFee({
      tokenId: POL_NATIVE,
      deps: { evmGas: gasReturning(10, 5), quote },
    });
    expect(quote).not.toHaveBeenCalled();
    expect(fee?.hot.swap).toBeNull();
    // Native: the fee IS the relayer fee, in the same token being withdrawn.
    expect(fee?.feeRaw).toBe(fee?.hot.relayerFeeRaw);
  });

  it("skips the solver when the relayer charges nothing", async () => {
    const quote = quoteReturning(okQuote());
    const fee = await fetchHotWithdrawalFee({
      tokenId: USDC_POLYGON,
      deps: { evmGas: gasReturning(0, 9), quote },
    });
    expect(quote).not.toHaveBeenCalled();
    expect(fee).toEqual({
      feeRaw: "0",
      hot: {
        relayerFeeRaw: "0",
        blockNumber: "9",
        nativeAssetId: POL_NATIVE,
        payment: "in-kind",
        swap: null,
      },
    });
  });
});

// D-251. The `token_diff` path assumes a solver will sell the destination chain's native gas.
// Measured on 2026-08-09 against `solver-relay-v2`: NONE of the 11 `hot.tg` native assets is
// quoted, in either direction, at any size — while non-native ones on the same bridge are.
// So for every non-native `hot-omni` token the only fee that can actually be paid is one the
// signer already holds. These tests pin that path; the wire measurement lives in history.md.
describe("fetchHotWithdrawalFee — gas paid from the signer's own balance", () => {
  // The money assertion. `feeRaw` is denominated in the WITHDRAWN token, and on this path
  // nothing is taken from it — so `"0"` here and the gas leaves as a second `mt_withdraw`
  // entry instead. Reporting `relayerFeeRaw` would state 0.04 GRAM as 40 USDT.
  it("charges nothing in the withdrawn token and never asks the relay", async () => {
    const quote = quoteReturning(okQuote());
    const fee = await fetchHotWithdrawalFee({
      tokenId: USDT_TON,
      nativeBalanceRaw: "40000000", // exactly TON's flat relayer fee
      deps: { quote },
    });
    expect(quote).not.toHaveBeenCalled();
    expect(fee).toEqual({
      feeRaw: "0",
      hot: {
        relayerFeeRaw: "40000000",
        blockNumber: "0",
        nativeAssetId: TON_NATIVE,
        payment: "native-balance",
        swap: null,
      },
    });
  });

  // Holding the gas beats buying it: selling part of the withdrawal to acquire something the
  // signer already has costs them a spread for nothing. Asserted on a chain whose fee comes
  // from an RPC, so the preference cannot be a TON-only accident.
  it("prefers the balance over a solver quote that would also have worked", async () => {
    const quote = quoteReturning(okQuote());
    const fee = await fetchHotWithdrawalFee({
      tokenId: USDC_POLYGON,
      nativeBalanceRaw: "26000000000000000",
      deps: { evmGas: gasReturning(10_000_000_000, 42), quote },
    });
    expect(quote).not.toHaveBeenCalled();
    expect(fee?.hot.payment).toBe("native-balance");
    expect(fee?.feeRaw).toBe("0");
  });

  it("falls back to the swap when the balance is one base unit short", async () => {
    const quote = quoteReturning(okQuote());
    const fee = await fetchHotWithdrawalFee({
      tokenId: USDT_TON,
      nativeBalanceRaw: "39999999",
      deps: { quote },
    });
    expect(quote).toHaveBeenCalled();
    expect(fee?.hot.payment).not.toBe("native-balance");
  });

  // A balance we cannot read as an integer is not a balance. Anything else — a float, a
  // decimal string, `undefined` — has to leave the path alone rather than be coerced, since
  // `BigInt("0.04")` throws and `Number` would silently round.
  it.each([undefined, "", "0.04", "4e7", "abc", "-40000000"])(
    "ignores an unusable balance (%s) instead of coercing it",
    async (balance) => {
      const quote = quoteReturning(okQuote());
      const fee = await fetchHotWithdrawalFee({
        tokenId: USDT_TON,
        nativeBalanceRaw: balance,
        deps: { quote },
      });
      expect(quote).toHaveBeenCalled();
      expect(fee?.hot.payment).not.toBe("native-balance");
    }
  );

  // The path must not leak into the case it was never meant for: withdrawing the gas token
  // ITSELF still deducts on the far side, and a balance covering the fee cannot turn that
  // into a two-entry withdrawal of the same token.
  it("leaves the native token's own withdrawal in-kind", async () => {
    const fee = await fetchHotWithdrawalFee({
      tokenId: TON_NATIVE,
      nativeBalanceRaw: "999999999999",
    });
    expect(fee?.hot.payment).toBe("in-kind");
    expect(fee?.feeRaw).toBe("40000000");
  });
});

describe("fetchHotWithdrawalFee — the solver swap", () => {
  it("asks exact-OUT for precisely the gas the relayer needs", async () => {
    const quote = quoteReturning(okQuote());
    const fee = await fetchHotWithdrawalFee({
      tokenId: USDC_POLYGON,
      deps: { evmGas: gasReturning(10_000_000_000, 42), quote },
    });
    const relayerFeeRaw = (
      ((BigInt(10_000_000_000) * BigInt(130)) / BigInt(100)) *
      BigInt(200_000)
    ).toString();
    expect(quote).toHaveBeenCalledTimes(1);
    expect(quote).toHaveBeenCalledWith(
      expect.objectContaining({
        quoteParams: expect.objectContaining({
          defuse_asset_identifier_in: USDC_POLYGON,
          defuse_asset_identifier_out: POL_NATIVE,
          exact_amount_out: relayerFeeRaw,
        }),
      })
    );
    // The reported fee is what the USER pays, in the withdrawn token — not the gas figure.
    expect(fee?.feeRaw).toBe("4321");
    expect(fee?.hot.swap).toEqual({
      quoteHash: "qh-1",
      assetIn: USDC_POLYGON,
      assetOut: POL_NATIVE,
      amountIn: "4321",
      amountOut: "2600000000000000",
      expiresAt: "2026-08-05T12:00:00.000Z",
    });
  });

  it("quotes Optimism against a native the token registry does not carry", async () => {
    const opNative = "nep245:v2_1.omni.hot.tg:10_11111111111111111111";
    const quote = quoteReturning(
      okQuote({ defuse_asset_identifier_in: USDT_OPTIMISM, defuse_asset_identifier_out: opNative })
    );
    const fee = await fetchHotWithdrawalFee({
      tokenId: USDT_OPTIMISM,
      deps: { evmGas: gasReturning(1_000_000, 3), quote },
    });
    expect(fee?.hot.nativeAssetId).toBe(opNative);
    expect(fee?.hot.swap?.assetOut).toBe(opNative);
  });

  it("quotes a non-native TON token against TON's empty-key native", async () => {
    const quote = quoteReturning(
      okQuote({
        defuse_asset_identifier_in: USDT_TON,
        defuse_asset_identifier_out: TON_NATIVE,
        amount_out: "40000000",
      })
    );
    const fee = await fetchHotWithdrawalFee({ tokenId: USDT_TON, deps: { quote } });
    expect(quote).toHaveBeenCalledWith(
      expect.objectContaining({
        quoteParams: expect.objectContaining({
          defuse_asset_identifier_out: TON_NATIVE,
          exact_amount_out: "40000000",
        }),
      })
    );
    expect(fee?.hot.swap?.assetOut).toBe(TON_NATIVE);
  });

  it("returns null when the solver cannot fill and no prices were supplied", async () => {
    const quote = vi.fn(async () => {
      throw new Error("no solvers");
    }) as unknown as NonNullable<HotFeeDeps["quote"]>;
    const fee = await fetchHotWithdrawalFee({
      tokenId: USDC_POLYGON,
      deps: { evmGas: gasReturning(10, 1), quote },
    });
    expect(quote).toHaveBeenCalledTimes(1); // exact-out only; no fallback without prices
    expect(fee).toBeNull();
  });
});

describe("fetchHotWithdrawalFee — the relay's answer is not trusted blindly", () => {
  // These numbers go inside a signed intent, so a malformed or mismatched quote has to be
  // refused rather than normalised.
  const bad: Array<[string, Record<string, unknown>]> = [
    ["a non-integer amount_in", { amount_in: "43.21" }],
    ["a non-integer amount_out", { amount_out: "2.6e15" }],
    ["a missing quote hash", { quote_hash: "" }],
    ["a different asset sold", { defuse_asset_identifier_in: USDT_OPTIMISM }],
    ["a different asset bought", { defuse_asset_identifier_out: TON_NATIVE }],
  ];

  for (const [label, over] of bad) {
    it(`refuses ${label}`, async () => {
      const fee = await fetchHotWithdrawalFee({
        tokenId: USDC_POLYGON,
        deps: { evmGas: gasReturning(10, 1), quote: quoteReturning(okQuote(over)) },
      });
      expect(fee).toBeNull();
    });
  }

  it("accepts the same quote once the defects are removed", async () => {
    const fee = await fetchHotWithdrawalFee({
      tokenId: USDC_POLYGON,
      deps: { evmGas: gasReturning(10, 1), quote: quoteReturning(okQuote()) },
    });
    expect(fee?.hot.swap?.quoteHash).toBe("qh-1");
  });
});

describe("fetchHotWithdrawalFee — the exact-in fallback", () => {
  // USDC has 6 decimals, POL 18. Fee is 2_600_000_000_000_000 wei of POL at $0.10;
  // that is $0.00026, so ~0.00026 USDC = 260 base units, times the 1.2 cushion = 312.
  const prices = (assetId: string) =>
    assetId === POL_NATIVE
      ? { price: 0.1, decimals: 18 }
      : assetId === USDC_POLYGON
        ? { price: 1, decimals: 6 }
        : null;

  function failingThen(second: Record<string, unknown>) {
    let call = 0;
    return vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error("no solvers for exact out");
      return second;
    }) as unknown as NonNullable<HotFeeDeps["quote"]>;
  }

  const gas = gasReturning(10_000_000_000, 7); // => relayer fee 2_600_000_000_000_000

  it("sizes the exact-in leg from USD prices with the 1.2x cushion", async () => {
    const quote = failingThen(okQuote({ amount_in: "312", amount_out: "2600000000000000" }));
    const fee = await fetchHotWithdrawalFee({
      tokenId: USDC_POLYGON,
      deps: { evmGas: gas, quote, usdPrices: prices },
    });
    expect(quote).toHaveBeenCalledTimes(2);
    expect(quote).toHaveBeenLastCalledWith(
      expect.objectContaining({
        quoteParams: expect.objectContaining({ exact_amount_in: "312" }),
      })
    );
    expect(fee?.feeRaw).toBe("312");
  });

  // The fallback is a guess made from prices, so upstream checks what came back. Under-buying
  // gas strands the delivery; over-buying by a lot means the user silently overpaid.
  it("discards a fallback quote that buys less gas than the relayer needs", async () => {
    const quote = failingThen(okQuote({ amount_in: "312", amount_out: "2599999999999999" }));
    expect(
      await fetchHotWithdrawalFee({
        tokenId: USDC_POLYGON,
        deps: { evmGas: gas, quote, usdPrices: prices },
      })
    ).toBeNull();
  });

  it("discards a fallback quote that buys more than 1.5x the gas needed", async () => {
    // 1.501x. The ratio is computed in integer thousandths and TRUNCATED, so the guard only
    // trips once the excess is a full thousandth — a quote at 1.5009x is let through. That
    // slack is upstream's, mirrored deliberately; it is ~0.07% of a gas fee, not of the
    // withdrawal.
    const quote = failingThen(okQuote({ amount_in: "312", amount_out: "3902600000000000" }));
    expect(
      await fetchHotWithdrawalFee({
        tokenId: USDC_POLYGON,
        deps: { evmGas: gas, quote, usdPrices: prices },
      })
    ).toBeNull();
  });

  it("accepts a fallback quote sitting exactly on the 1.5x boundary", async () => {
    const quote = failingThen(okQuote({ amount_in: "312", amount_out: "3900000000000000" }));
    const fee = await fetchHotWithdrawalFee({
      tokenId: USDC_POLYGON,
      deps: { evmGas: gas, quote, usdPrices: prices },
    });
    expect(fee?.feeRaw).toBe("312");
  });

  // Upstream divides by the token price unguarded; a source reporting 0 would throw a
  // RangeError in the middle of a quote instead of simply declining to quote.
  it("declines instead of dividing by a zero price", async () => {
    const quote = failingThen(okQuote());
    const fee = await fetchHotWithdrawalFee({
      tokenId: USDC_POLYGON,
      deps: {
        evmGas: gas,
        quote,
        usdPrices: (id) => (id === POL_NATIVE ? { price: 0.1, decimals: 18 } : { price: 0, decimals: 6 }),
      },
    });
    expect(quote).toHaveBeenCalledTimes(1);
    expect(fee).toBeNull();
  });

  it("declines when a price for either side is missing", async () => {
    const quote = failingThen(okQuote());
    const fee = await fetchHotWithdrawalFee({
      tokenId: USDC_POLYGON,
      deps: { evmGas: gas, quote, usdPrices: (id) => (id === POL_NATIVE ? { price: 0.1, decimals: 18 } : null) },
    });
    expect(quote).toHaveBeenCalledTimes(1);
    expect(fee).toBeNull();
  });
});

// D-251. The screen is already blocked when it asks these questions, so what is under test is
// not a price — it is whether the ONE number needed to unblock it survives the failure that
// blocked it.
describe("fetchHotGasRequirement", () => {
  it("still reports the gas when no solver will quote it — the D-251 case", async () => {
    // Exactly the state measured on 2026-08-10: the jetton quotes, the chain's native does
    // not, so `fetchHotWithdrawalFee` has nothing signable and answers null. The requirement
    // has to come back anyway; it is what the purchase is sized from.
    const quote = vi.fn(async () => null) as unknown as NonNullable<HotFeeDeps["quote"]>;
    const deps: HotFeeDeps = { quote };

    expect(await fetchHotWithdrawalFee({ tokenId: USDT_TON, deps })).toBeNull();
    expect(await fetchHotGasRequirement({ tokenId: USDT_TON, deps })).toEqual({
      relayerFeeRaw: "40000000",
      blockNumber: "0",
      nativeAssetId: TON_NATIVE,
    });
  });

  it("costs no network call on TON — it is asked for from a blocked screen", async () => {
    const evmGas = gasReturning(1, 1);
    const quote = quoteReturning(okQuote());
    await fetchHotGasRequirement({ tokenId: USDT_TON, deps: { evmGas, quote } });
    expect(evmGas).not.toHaveBeenCalled();
    // Nothing is being bought yet, so nothing is quoted: this answers "how much gas", and the
    // relay is not the one who knows that.
    expect(quote).not.toHaveBeenCalled();
  });

  it("reports the same figures the signable quote does, so the two cannot drift", async () => {
    const deps: HotFeeDeps = { evmGas: gasReturning(11, 777), quote: quoteReturning(okQuote()) };
    const fee = await fetchHotWithdrawalFee({ tokenId: USDC_POLYGON, deps });
    const need = await fetchHotGasRequirement({ tokenId: USDC_POLYGON, deps });
    expect(need).toEqual({
      relayerFeeRaw: fee?.hot.relayerFeeRaw,
      blockNumber: fee?.hot.blockNumber,
      nativeAssetId: fee?.hot.nativeAssetId,
    });
  });

  // 🔴 The distinction the whole type exists to draw. An unreachable chain is NOT a case
  // buying gas can fix — the cost itself is unknown — so the caller must get null here and
  // keep the screen plainly blocked instead of offering a purchase it cannot size.
  it("returns null when the chain's gas price cannot be read at all", async () => {
    const deps: HotFeeDeps = {
      evmGas: vi.fn(async () => {
        throw new Error("rpc unreachable");
      }),
    };
    expect(await fetchHotGasRequirement({ tokenId: USDC_POLYGON, deps })).toBeNull();
  });

  it("inherits Stellar's expensive-when-unsure branch rather than repeating it", async () => {
    const need = await fetchHotGasRequirement({ tokenId: XLM });
    expect(need?.relayerFeeRaw).toBe("11000000");
  });

  it("returns null off the hot-omni route", async () => {
    expect(await fetchHotGasRequirement({ tokenId: USDT_ARB })).toBeNull();
    expect(await fetchHotGasRequirement({ tokenId: "nep141:nope" })).toBeNull();
  });
});
